import { stringify } from "urlencode";
import { onMessage, sendMessage } from "@/messages.ts";
import { extStorage } from "@/storage.ts";
import type { IExtensionStorageSchema, TExtensionStorageKey } from "@/storage.ts";
import {
  getValueByPath,
  parsePath,
  removeValueByPath,
  setValueByPath,
  type TStoragePath,
} from "@/shared/storagePath.ts";

export { getValueByPath } from "@/shared/storagePath.ts";

/**
 * 后台统一错误上报（修复 P1-5「静默失败」）。
 *
 * 通道优先级：logger 消息（offscreen 的环形缓冲，可在选项页日志中查看）→ SW 控制台 console.warn。
 * 该函数刻意不抛出、不返回 Promise：调用方保持原有「忽略失败继续执行」的控制流语义，
 * 只是不再无声；若 logger 通道本身失败，再退化为 console.warn，避免形成新的静默点。
 */
export function logBackgroundError(message: string, error?: unknown): void {
  const detail =
    error === undefined ? undefined : error instanceof Error ? `${error.name}: ${error.message}` : String(error);

  console.warn(`[PTD] ${message}`, error);
  sendMessage("logger", { msg: message, data: detail, level: "error" }).catch((e) => {
    console.warn("[PTD] failed to forward background error to logger channel:", e);
  });
}

export function openOptionsPage(url?: string | { path: string; query?: Record<string, any> }) {
  if (url && typeof url !== "string") {
    url = url.path + (url.query ? "?" + stringify(url.query) : "");
  }
  url ??= "/";

  chrome.tabs
    .create({ url: "/src/entries/options/index.html#" + url })
    .catch((e) => logBackgroundError("Failed to open options page", e));
}

onMessage("openOptionsPage", async ({ data: url }) => {
  openOptionsPage(url);
});

onMessage("downloadFile", async ({ data: downloadOptions }) => {
  return await chrome.downloads.download(downloadOptions);
});

type DownloadReservation = { site: string; at: number; previous: number };
type DownloadTrackingState = "complete" | "interrupted";
type DownloadTrackingRecord = {
  downloadId?: number;
  blobUrl?: string;
  reservation?: DownloadReservation;
  state?: DownloadTrackingState;
};

const DOWNLOAD_TRACKING_KEY = "ptd_downloadTracking";
const SITE_DOWNLOAD_INTERVAL_KEY = "ptd_siteDownloadAt";
const downloadTracking = new Map<number, DownloadTrackingRecord>();
const siteDownloadAt = new Map<string, number>();
let downloadTrackingLoaded: Promise<void> | null = null;
let siteDownloadAtLoaded: Promise<void> | null = null;

function getSessionStorageArea(): chrome.storage.StorageArea | undefined {
  return globalThis.chrome?.storage?.session;
}

async function loadDownloadTracking(): Promise<void> {
  if (downloadTrackingLoaded) {
    return downloadTrackingLoaded;
  }
  downloadTrackingLoaded = (async () => {
    try {
      const stored = await getSessionStorageArea()?.get(DOWNLOAD_TRACKING_KEY);
      const records = stored?.[DOWNLOAD_TRACKING_KEY] as Record<string, DownloadTrackingRecord> | undefined;
      for (const [id, record] of Object.entries(records ?? {})) {
        if (record && (typeof record.downloadId === "number" || typeof record.blobUrl === "string")) {
          downloadTracking.set(Number(id), record);
        }
      }
    } catch (error) {
      logBackgroundError("Failed to restore download tracking state", error);
    }
  })();
  return downloadTrackingLoaded;
}

async function persistDownloadTracking(): Promise<void> {
  try {
    await getSessionStorageArea()?.set({
      [DOWNLOAD_TRACKING_KEY]: Object.fromEntries(downloadTracking.entries()),
    });
  } catch (error) {
    logBackgroundError("Failed to persist download tracking state", error);
  }
}

async function settleTrackedDownload(chromeDownloadId: number, state: DownloadTrackingState): Promise<void> {
  await loadDownloadTracking();
  const record = downloadTracking.get(chromeDownloadId);
  if (!record) {
    return;
  }
  record.state = state;
  await persistDownloadTracking();

  try {
    if (typeof record.downloadId === "number") {
      await sendMessage("settleBrowserDownload", {
        downloadId: record.downloadId,
        state,
        reservation: record.reservation,
      });
    } else if (record.blobUrl) {
      await sendMessage("releaseBrowserDownloadBlob", {
        chromeDownloadId,
        state,
        blobUrl: record.blobUrl,
      });
    }
    downloadTracking.delete(chromeDownloadId);
    await persistDownloadTracking();
  } catch (error) {
    // Keep the terminal record in session storage. A later SW startup or a new
    // registration can retry the handoff without losing the final state.
    logBackgroundError("Failed to forward settled browser download", error);
  }
}

async function flushPendingDownloadSettlements(): Promise<void> {
  await loadDownloadTracking();
  for (const [chromeDownloadId, record] of downloadTracking) {
    if (record.state) {
      await settleTrackedDownload(chromeDownloadId, record.state);
      continue;
    }
    try {
      const [item] = (await chrome.downloads?.search?.({ id: chromeDownloadId })) ?? [];
      if (item?.state === "complete" || item?.state === "interrupted") {
        await settleTrackedDownload(chromeDownloadId, item.state);
      }
    } catch (error) {
      logBackgroundError(`Failed to reconcile browser download ${chromeDownloadId}`, error);
    }
  }
}

chrome.downloads?.onChanged?.addListener((delta) => {
  const state = delta.state?.current;
  if (state === "complete" || state === "interrupted") {
    void settleTrackedDownload(delta.id, state);
  }
});

onMessage("registerDownloadTracking", async ({ data }) => {
  await loadDownloadTracking();
  downloadTracking.set(data.chromeDownloadId, {
    downloadId: data.downloadId,
    reservation: data.reservation,
  });
  await persistDownloadTracking();
  await flushPendingDownloadSettlements();
});

onMessage("registerBlobDownloadTracking", async ({ data }) => {
  await loadDownloadTracking();
  downloadTracking.set(data.chromeDownloadId, { blobUrl: data.blobUrl });
  await persistDownloadTracking();
  await flushPendingDownloadSettlements();
});

async function loadSiteDownloadAt(): Promise<void> {
  if (siteDownloadAtLoaded) {
    return siteDownloadAtLoaded;
  }
  siteDownloadAtLoaded = (async () => {
    try {
      const stored = await getSessionStorageArea()?.get(SITE_DOWNLOAD_INTERVAL_KEY);
      const table = stored?.[SITE_DOWNLOAD_INTERVAL_KEY] as Record<string, unknown> | undefined;
      for (const [site, at] of Object.entries(table ?? {})) {
        if (typeof at === "number" && Number.isFinite(at)) {
          siteDownloadAt.set(site, at);
        }
      }
    } catch (error) {
      logBackgroundError("Failed to restore site download interval state", error);
    }
  })();
  return siteDownloadAtLoaded;
}

async function persistSiteDownloadAt(): Promise<void> {
  try {
    await getSessionStorageArea()?.set({
      [SITE_DOWNLOAD_INTERVAL_KEY]: Object.fromEntries(siteDownloadAt.entries()),
    });
  } catch (error) {
    logBackgroundError("Failed to persist site download interval state", error);
  }
}

onMessage("getSiteDownloadAt", async ({ data: site }) => {
  await loadSiteDownloadAt();
  return siteDownloadAt.get(site) ?? 0;
});

onMessage("reserveSiteDownloadAt", async ({ data: { site, at } }) => {
  await loadSiteDownloadAt();
  const previous = siteDownloadAt.get(site) ?? 0;
  siteDownloadAt.set(site, at);
  await persistSiteDownloadAt();
  return previous;
});

onMessage("rollbackSiteDownloadAt", async ({ data: { site, at, previous } }) => {
  await loadSiteDownloadAt();
  if (siteDownloadAt.get(site) !== at) {
    return;
  }
  if (previous > 0) {
    siteDownloadAt.set(site, previous);
  } else {
    siteDownloadAt.delete(site);
  }
  await persistSiteDownloadAt();
});

void flushPendingDownloadSettlements();

/**
 * chrome.storage.local 读缓存。
 *
 * 背景（见 docs/performance-audit.md P0-2）：
 * 跨上下文读取（offscreen / options / content-script）都要经过
 * `sendMessage("getExtStorage", key)` → `chrome.storage.local.get(key)`，
 * 每次都会把整份对象反序列化一遍。metadata 体积可到数百 KB ~ MB 级，
 * 在下载、轮询、自动刷新等高频路径上被反复读取，成为主要开销。
 *
 * 这里在 service worker 内维护一份「读缓存」：
 * - 任何来源的写入都会触发 chrome.storage.onChanged，从而整体失效对应 key（保证正确性）；
 * - 本模块自己的写入在 `setItem` resolve 之后**同步**换入/失效对应 key：onChanged 是异步广播，
 *   若不这样做，在「写入 resolve」到「onChanged 到达」的窗口里，SW 内其它读路径（自动刷新、备份等）
 *   仍会读到旧对象，并可能整表写回覆盖掉刚写入的值。
 *
 * 关于「SW 是唯一写者」：这个断言**不成立**，不要再依赖它（见 B-10）。
 * options 侧 pinia 的持久化（`extends/pinia/webExtPersistence.ts`）会整份写入 `metadata`/`config`，
 * 完全绕过本模块的 writeChain。因此本模块的写路径做了两件事来缩小「读 → 写」窗口：
 * - 按路径局部更新时**重新从 storage 读取**（不信任可能已过期的读缓存）；
 * - 只在副本上改值，`setItem` 成功后才换入缓存（失败则失效缓存），避免缓存里出现从未落盘的值。
 * writeChain 的作用因此收敛为「串行化 SW 内部的读改写」，而不是「跨上下文互斥」。
 */
const storageReadCache = new Map<string, unknown>();

/**
 * 写入成功后同步更新读缓存。
 *
 * 注意不能依赖 `chrome.storage.onChanged`：`extStorage.setItem()` 的 Promise 只是 `chrome.storage.local.set`
 * 的完成信号，早于 onChanged 事件到达；这段窗口内若仍返回缓存中的旧对象，就会复现「写入后仍读到旧值」。
 *
 * 导出给同样在 SW 内直接写 storage 的模块使用（如 `fixer.ts` 的 `fixAllStoredUserInfo`，见 B-18）。
 */
export function invalidateStorageReadCache(key: TExtensionStorageKey): void {
  storageReadCache.delete(key);
}

/**
 * 写入**成功后**把刚写入的值换入读缓存（见 B-10）。
 *
 * 相比「先改缓存再写」，这样做保证缓存里永远是「已经落盘的值」：
 * 若 `setItem` 失败（配额、SW 在写入中途被回收等），缓存不会被污染成从未落盘的内容。
 */
function commitStorageReadCache(key: TExtensionStorageKey, value: unknown): void {
  storageReadCache.set(key, value);
}

chrome.storage?.onChanged?.addListener((changes, areaName) => {
  if (areaName !== "local") {
    return;
  }
  for (const key of Object.keys(changes)) {
    storageReadCache.delete(key);
  }
});

/** 串行化所有对 chrome.storage.local 的写入，避免读改写竞态导致丢失更新 */
let writeChain: Promise<unknown> = Promise.resolve();

/**
 * 为「按路径写入」构造副本（见 B-10 / L-8）。
 *
 * 只浅拷贝路径上的容器，叶子赋值发生在副本上：原始对象（可能正是读缓存里的那个对象）保持不可变。
 * 早期实现在缓存对象上就地 `setValueByPath`，于是 `setItem` 失败或 SW 在写入中途被回收时，
 * 缓存已经被改成「从未落盘的值」，后续所有读路径都会拿到这份假数据。
 */
function cloneAlongPath<T>(source: T, keys: Array<string | number>): T {
  if (source === null || typeof source !== "object") {
    return source;
  }

  const root = (Array.isArray(source) ? [...(source as any[])] : { ...(source as object) }) as any;
  let sourceCursor: any = source;
  let cloneCursor: any = root;

  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i]!;
    const child = sourceCursor?.[key];
    if (child === null || typeof child !== "object") {
      break; // 中间层缺失/不是容器：交给 setValueByPath 自行补建
    }
    const childClone = Array.isArray(child) ? [...child] : { ...child };
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      throw new Error("Prototype pollution attempt detected");
    }
    cloneCursor[key] = childClone;
    sourceCursor = child;
    cloneCursor = childClone;
  }

  return root;
}

export function enqueueWrite<T>(task: () => Promise<T>): Promise<T> {
  const next = writeChain.then(task, task);
  // 保证链不会因为某次失败而中断
  writeChain = next.catch(() => undefined);
  return next;
}

export async function getExtStorageCached<T extends TExtensionStorageKey>(key: T): Promise<IExtensionStorageSchema[T]> {
  if (storageReadCache.has(key)) {
    return storageReadCache.get(key) as IExtensionStorageSchema[T];
  }

  const value = await extStorage.getItem(key);
  storageReadCache.set(key, value);
  return value as IExtensionStorageSchema[T];
}

/**
 * service worker 内部使用：走读缓存按路径取值（不产生任何跨上下文消息）。
 */
export async function getExtStoragePathCached(
  key: TExtensionStorageKey,
  path: TStoragePath,
  defaultValue: unknown = null,
): Promise<any> {
  const value = getValueByPath(await getExtStorageCached(key), path);
  return value === undefined ? defaultValue : value;
}

/**
 * service worker 内部使用：局部更新（串行写队列 + 从 storage 重新读取）。
 * 与 patchExtStoragePath 消息处理逻辑一致，供 background 其它模块直接调用。
 *
 * 读改写**刻意不走读缓存**（见 B-10）：options 侧 pinia 持久化会整份写入同一个 key，
 * 缓存可能已经过期；用过期快照做「读 → 改 → 整份写回」会把对方刚写入的字段整体覆盖掉。
 * 直接从 storage 重新读取把丢更新窗口从「缓存寿命」缩短到「一次读 → 一次写」。
 */
export async function patchExtStoragePathLocal(
  key: TExtensionStorageKey,
  path: TStoragePath,
  value?: unknown,
  options: { remove?: boolean } = {},
): Promise<void> {
  await enqueueWrite(async () => {
    const current = (await extStorage.getItem(key)) ?? {};
    const next = cloneAlongPath(current, parsePath(path));

    if (options.remove) {
      removeValueByPath(next, path);
    } else {
      setValueByPath(next, path, value);
    }

    try {
      await extStorage.setItem(key, next);
      // 写入成功后才换入缓存（L-8）：此前缓存里是旧值，但至少是「确实落过盘」的值
      commitStorageReadCache(key, next);
    } catch (e) {
      // 写入失败：丢弃缓存，避免继续返回可能已过期的对象（下一次读取会重新从 storage 拉取）
      invalidateStorageReadCache(key);
      throw e;
    }
  });
}

// 注：此处原有一个 @ts-ignore，实测当前类型已完全对齐（vue-tsc 报 Unused '@ts-expect-error'），
// 因此直接删除该指令而不是改成 @ts-expect-error —— 保留一个永远不生效的忽略指令只会掩盖未来的真实错误。
onMessage("getExtStorage", async ({ data: key }) => {
  return await getExtStorageCached(key);
});

/**
 * 与 getExtStorage 相同，但只返回指定路径的值，
 * 避免把整份 metadata/userInfo（可能数百 KB）通过消息传回调用方。
 */
onMessage("getExtStoragePath", async ({ data: { key, path, defaultValue = null } }) => {
  return await getExtStoragePathCached(key, path, defaultValue);
});

function sanitizeDownloaderForContentScript(downloader: Record<string, any>): Record<string, any> {
  return {
    id: downloader.id,
    type: downloader.type,
    name: downloader.name,
    address: downloader.address,
    enabled: downloader.enabled,
    sortIndex: downloader.sortIndex,
    suggestFolders: downloader.suggestFolders,
    suggestTags: downloader.suggestTags,
    excludedSites: downloader.excludedSites,
    feature: downloader.feature,
    advanceAddTorrentOptions: downloader.advanceAddTorrentOptions,
  };
}

onMessage("getContentScriptBootstrapData", async () => {
  const [config, metadata] = await Promise.all([getExtStorageCached("config"), getExtStorageCached("metadata")]);
  const downloaders = Object.fromEntries(
    Object.entries((metadata?.downloaders ?? {}) as Record<string, Record<string, any>>)
      .filter(([, downloader]) => downloader?.enabled)
      .map(([id, downloader]) => [id, sanitizeDownloaderForContentScript({ ...downloader, id: downloader.id ?? id })]),
  );

  return {
    config: {
      contentScript: config?.contentScript,
      download: {
        allowDownloaderFilterForSite: config?.download?.allowDownloaderFilterForSite,
        allowDirectSendToClient: config?.download?.allowDirectSendToClient,
        saveLastDownloader: false,
        useQuickSendToClient: config?.download?.useQuickSendToClient,
      },
    },
    metadata: {
      siteHostMap: metadata?.siteHostMap ?? {},
      defaultDownloader: metadata?.defaultDownloader ?? {},
      downloaders,
      defaultSolutionId: metadata?.defaultSolutionId ?? "default",
      solutions: metadata?.solutions ?? {},
    },
  };
});

onMessage("setExtStorage", async ({ data: { key, value } }) => {
  await enqueueWrite(async () => {
    await extStorage.setItem(key, value);
    invalidateStorageReadCache(key);
  });
});

/**
 * 局部更新：只读取一次（走缓存）→ 改指定路径 → 整份写回。
 * 与调用方自行 getExtStorage + setExtStorage 相比：
 * - 数据不需要跨上下文往返（尤其是 metadata 这类大对象）；
 * - 写入与读取都在 service worker 内串行执行，避免并发读改写互相覆盖。
 * `remove: true` 表示删除该路径而不是赋值。
 */
onMessage("patchExtStoragePath", async ({ data: { key, path, value, remove = false } }) => {
  await patchExtStoragePathLocal(key, path, value, { remove });
});
