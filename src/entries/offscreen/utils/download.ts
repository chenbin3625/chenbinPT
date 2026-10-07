import axios, { type AxiosRequestConfig } from "axios";
import PQueue from "p-queue";
import { stringify } from "urlencode";
import { toMerged } from "es-toolkit";
import { isEmpty } from "es-toolkit/compat";

import {
  getDownloader,
  getDownloaderMetaData,
  releaseDownloaderInstance,
  type CAddTorrentOptions,
  type CTorrent,
  type CTorrentFile,
  type CTorrentFileSelection,
  type CTorrentPeer,
  type CTorrentTracker,
  type TorrentClientStatus,
  type TorrentQueueDirection,
  type TorrentSpeedLimit,
} from "@ptd/downloader";
// 直接从子路径导入，避免根入口（被 content script 使用）静态依赖 utils.ts
// （parse-torrent / buffer polyfill 等），见 docs/performance-audit.md P2-1
import { getRemoteTorrentFile } from "@ptd/downloader/utils.ts";
import type { ITorrent } from "@ptd/site";

import { onMessage, sendMessage } from "@/messages.ts";
import type {
  IConfigPiniaStorageSchema,
  ITorrentDownloadMetadata,
  TTorrentDownloadKey,
  IDownloaderMetadata,
  IMetadataPiniaStorageSchema,
  TTorrentDownloadStatus,
  IDownloadTorrentOption,
  IDownloadTorrentResult,
  AugmentedRequired,
} from "@/shared/types.ts";

import { logger } from "./logger.ts";
import { getSiteInstance } from "./site.ts";
import { ptdIndexDb } from "../adapter/indexdb.ts";

type TLocalDownloadOption = AugmentedRequired<IDownloadTorrentOption, "downloadId" | "localDownloadMethod">;
type TRemoteDownloadOption = AugmentedRequired<
  IDownloadTorrentOption,
  "downloadId" | "downloaderId" | "addTorrentOptions"
>;

/**
 * 只取当前下载器的配置（见 docs/performance-audit.md P0-2）。
 * 早期实现每次都整份读取 metadata，而本函数位于所有下载器 API 的入口
 * （含 UI 轮询），是跨上下文全量读放大的主要来源之一。
 */
export async function getDownloaderConfig(downloaderId: string) {
  return ((await sendMessage("getExtStoragePath", {
    key: "metadata",
    path: ["downloaders", downloaderId],
    defaultValue: {},
  })) ?? {}) as IDownloaderMetadata;
}

type DownloaderInstance = Awaited<ReturnType<typeof getDownloader>>;

const downloaderInstanceCache = new Map<string, { configKey: string; instance: DownloaderInstance }>();

/**
 * offscreen 自建实例缓存的 key（见 OFFSCREEN-3）。
 *
 * 早期实现只取连接字段，漏掉 `feature` / `advanceAddTorrentOptions`：
 * 这些字段被实例构造时快照（例如 qBittorrent 的 `this.config.feature?.BypassCSRF`），
 * 用户在设置里只改「绕过 CSRF」时 offscreen 会一直命中旧实例，开关看起来失效。
 * 这里与 `@ptd/downloader` 的 `getDownloaderInstanceCacheKey` 保持同一组字段。
 */
function getDownloaderConfigKey(config: IDownloaderMetadata): string {
  const { id, type, address, username, password, timeout, feature, advanceAddTorrentOptions } = config;
  return JSON.stringify({ id, type, address, username, password, timeout, feature, advanceAddTorrentOptions });
}

export async function getDownloaderInstance(downloaderId: string): Promise<DownloaderInstance | null> {
  const downloaderConfig = await getDownloaderConfig(downloaderId);
  if (!downloaderConfig.id) return null;

  const configKey = getDownloaderConfigKey(downloaderConfig);
  const cached = downloaderInstanceCache.get(downloaderId);
  if (cached && cached.configKey === configKey) {
    return cached.instance;
  }

  const instance = await getDownloader(downloaderConfig);
  // OFFSCREEN-7：配置变化时旧实例会被本缓存丢弃，必须主动释放它持有的长连接（Aria2 的 WebSocket），
  // 否则反复改配置会在 offscreen 生命周期内累积孤儿连接。若库级缓存按稳定 key 返回的是同一个实例，
  // 则不能 dispose（否则会关掉正在用的连接），只需更新 key。
  if (cached && cached.instance !== instance) {
    releaseDownloaderInstance(cached.instance);
  }
  downloaderInstanceCache.set(downloaderId, { configKey, instance });
  return instance;
}

onMessage("getDownloaderConfig", async ({ data: downloaderId }) => await getDownloaderConfig(downloaderId));

onMessage("getDownloaderList", async () => {
  const downloaders =
    ((await sendMessage("getExtStoragePath", {
      key: "metadata",
      path: ["downloaders"],
      defaultValue: {},
    })) as IMetadataPiniaStorageSchema["downloaders"]) ?? {};
  return Object.entries(downloaders).map(([id, config]) => ({
    id,
    name: config.name ?? "",
    type: config.type ?? "",
    enabled: config.enabled ?? false,
    address: config.address ?? "",
  }));
});

onMessage("getDownloaderVersion", async ({ data: downloaderId }) => {
  let downloaderVersion = "unknown";

  const downloaderInstance = await getDownloaderInstance(downloaderId);
  if (downloaderInstance) {
    downloaderVersion = await downloaderInstance.getClientVersion();
  }

  return downloaderVersion;
});

onMessage("getDownloaderStatus", async ({ data: downloaderId }) => {
  let downloaderStatus: TorrentClientStatus = { dlSpeed: 0, upSpeed: 0, dlData: 0, upData: 0 };

  const downloaderInstance = await getDownloaderInstance(downloaderId);
  if (downloaderInstance) {
    downloaderStatus = await downloaderInstance.getClientStatus();
  }

  return downloaderStatus;
});

export async function getTorrentDownloadLink(torrent: ITorrent) {
  const site = await getSiteInstance<"public">(torrent.site);
  if (
    (torrent.link && !site.isTrustedDownloadLink(torrent.link)) ||
    (torrent.url && !site.isTrustedDownloadLink(torrent.url))
  ) {
    throw new Error(`Rejected torrent URL outside site host allowlist for ${torrent.site}`);
  }
  const link = await site.getTorrentDownloadLink(torrent);
  if (!site.isTrustedDownloadLink(link)) {
    throw new Error(`Rejected download link outside site host allowlist for ${torrent.site}`);
  }
  return link;
}

onMessage("getTorrentDownloadLink", async ({ data: torrent }) => await getTorrentDownloadLink(torrent));

export async function getTorrentInfoForVerification(torrent: ITorrent) {
  const siteInstance = await getSiteInstance<"public">(torrent.site);
  const downloadUrl = await getTorrentDownloadLink(torrent);

  const downloadRequestConfig = await siteInstance.getTorrentDownloadRequestConfig(torrent);
  downloadRequestConfig.url = downloadUrl;
  downloadRequestConfig.responseType = "arraybuffer";
  if (!siteInstance.isTrustedDownloadLink(axios.getUri(downloadRequestConfig))) {
    throw new Error(`Rejected download request outside site host allowlist for ${torrent.site}`);
  }

  const parsedTorrent = await getRemoteTorrentFile(downloadRequestConfig);

  // 返回可序列化的种子信息
  return {
    infoHash: (parsedTorrent as unknown as { infoHash: string }).infoHash ?? "",
    name: parsedTorrent.info.name ?? "unknown",
    length: parsedTorrent.info.length ?? 0,
    files: (parsedTorrent.info.files || []).map((f) => ({
      path: f.path,
      length: f.length,
    })),
  };
}

onMessage("getTorrentInfoForVerification", async ({ data: torrent }) => await getTorrentInfoForVerification(torrent));

onMessage("getClientTorrents", async ({ data: downloaderId }) => {
  let downloaderTorrents: CTorrent[] = [];
  const downloaderInstance = await getDownloaderInstance(downloaderId);
  if (downloaderInstance) {
    downloaderTorrents = await downloaderInstance.getAllTorrents();
  }
  return downloaderTorrents;
});

onMessage("getClientTorrentTrackers", async ({ data: { downloaderId, torrent } }) => {
  let downloaderTrackers: string[] = [];
  const downloaderInstance = await getDownloaderInstance(downloaderId);
  if (downloaderInstance) {
    downloaderTrackers = await downloaderInstance.getTorrentTrackers(torrent);
  }
  return downloaderTrackers;
});

// 下载器能力元数据（feature 声明）
onMessage("getDownloaderMetaData", async ({ data: downloaderId }) => {
  const downloaderConfig = await getDownloaderConfig(downloaderId);
  if (!downloaderConfig.type) {
    return undefined;
  }
  return await getDownloaderMetaData(downloaderConfig.type);
});

// 文件列表
onMessage("getClientTorrentFiles", async ({ data: { downloaderId, torrent } }) => {
  let files: CTorrentFile[] = [];
  const downloaderInstance = await getDownloaderInstance(downloaderId);
  if (downloaderInstance) {
    files = await downloaderInstance.getTorrentFiles(torrent);
  }
  return files;
});

// 文件优先级/选择
onMessage("setClientTorrentFilePriority", async ({ data: { downloaderId, torrent, selections } }) => {
  let result = false;
  const downloaderInstance = await getDownloaderInstance(downloaderId);
  if (downloaderInstance) {
    result = await downloaderInstance.setTorrentFilePriority(torrent, selections);
  }
  return result;
});

// peer 列表
onMessage("getClientTorrentPeers", async ({ data: { downloaderId, torrent } }) => {
  let peers: CTorrentPeer[] = [];
  const downloaderInstance = await getDownloaderInstance(downloaderId);
  if (downloaderInstance) {
    peers = await downloaderInstance.getTorrentPeers(torrent);
  }
  return peers;
});

// tracker 列表（带状态）
onMessage("getClientTorrentTrackersDetail", async ({ data: { downloaderId, torrent } }) => {
  let trackers: CTorrentTracker[] = [];
  const downloaderInstance = await getDownloaderInstance(downloaderId);
  if (downloaderInstance) {
    trackers = await downloaderInstance.getTorrentTrackersDetail(torrent);
  }
  return trackers;
});

// 新增 tracker
onMessage("addClientTorrentTracker", async ({ data: { downloaderId, torrent, url } }) => {
  let result = false;
  const downloaderInstance = await getDownloaderInstance(downloaderId);
  if (downloaderInstance) {
    result = await downloaderInstance.addTorrentTracker(torrent, url);
  }
  return result;
});

// 删除 tracker
onMessage("removeClientTorrentTracker", async ({ data: { downloaderId, torrent, url } }) => {
  let result = false;
  const downloaderInstance = await getDownloaderInstance(downloaderId);
  if (downloaderInstance) {
    result = await downloaderInstance.removeTorrentTracker(torrent, url);
  }
  return result;
});

onMessage("deleteClientTorrent", async ({ data: { downloaderId, id, removeData } }) => {
  let deleteStatus: boolean = false;
  const downloaderInstance = await getDownloaderInstance(downloaderId);
  if (downloaderInstance) {
    deleteStatus = await downloaderInstance.removeTorrent(id, removeData ?? false);
  }
  return deleteStatus;
});

onMessage("pauseClientTorrent", async ({ data: { downloaderId, id } }) => {
  let pauseStatus: boolean = false;
  const downloaderInstance = await getDownloaderInstance(downloaderId);
  if (downloaderInstance) {
    pauseStatus = await downloaderInstance.pauseTorrent(id);
  }

  return pauseStatus;
});

onMessage("resumeClientTorrent", async ({ data: { downloaderId, id } }) => {
  let resumeStatus: boolean = false;
  const downloaderInstance = await getDownloaderInstance(downloaderId);
  if (downloaderInstance) {
    resumeStatus = await downloaderInstance.resumeTorrent(id);
  }

  return resumeStatus;
});

onMessage("recheckClientTorrent", async ({ data: { downloaderId, id } }) => {
  let recheckStatus: boolean = false;
  const downloaderInstance = await getDownloaderInstance(downloaderId);
  if (downloaderInstance) {
    recheckStatus = await downloaderInstance.recheckTorrent(id);
  }

  return recheckStatus;
});

onMessage("moveClientTorrentInQueue", async ({ data: { downloaderId, id, direction } }) => {
  let moveStatus: boolean = false;
  const downloaderInstance = await getDownloaderInstance(downloaderId);
  if (downloaderInstance) {
    moveStatus = await downloaderInstance.moveTorrentInQueue(id, direction as TorrentQueueDirection);
  }

  return moveStatus;
});

onMessage("setClientTorrentSpeedLimit", async ({ data: { downloaderId, id, limits } }) => {
  let limitStatus: boolean = false;
  const downloaderInstance = await getDownloaderInstance(downloaderId);
  if (downloaderInstance) {
    limitStatus = await downloaderInstance.setTorrentSpeedLimit(id, limits as TorrentSpeedLimit);
  }

  return limitStatus;
});

onMessage("setClientTorrentLabel", async ({ data: { downloaderId, id, label } }) => {
  let labelStatus: boolean = false;
  const downloaderInstance = await getDownloaderInstance(downloaderId);
  if (downloaderInstance) {
    labelStatus = await downloaderInstance.setTorrentLabel(id, label);
  }

  return labelStatus;
});

function buildDownloadHistory(downloadOption: IDownloadTorrentOption): ITorrentDownloadMetadata {
  const { torrent = {}, downloaderId = "local" } = downloadOption;
  return {
    ...downloadOption,
    siteId: torrent.site ?? "unknown",
    torrentId: torrent.id ?? "unknown",
    downloaderId,
    title: torrent.title ?? "unknown",
    subTitle: torrent.subTitle,
    url: torrent.url,
    link: torrent.link,
    downloadAt: +Date.now(),
    downloadStatus: "pending",
  } as ITorrentDownloadMetadata;
}

/**
 * 站点上次下载时间的持久化（见 L-1）。
 *
 * 早期实现只把时间戳放在 offscreen 的内存 Map 里：offscreen 被回收（MV3 下很常见）后，
 * 每个站点的**首次**下载都会绕过 `downloadInterval` 的防轰炸保护。
 * 这里把这张表写进 `chrome.storage.session`（随浏览器会话存活、不落盘），offscreen 重建后仍能读出。
 * 拿不到 session storage（旧版 Firefox / 单测环境）时退化为纯内存表，行为与修复前一致。
 */
const SITE_DOWNLOAD_INTERVAL_KEY = "ptd_siteDownloadAt";

/** 内存表：本 offscreen 生命周期内的权威值，避免每次下载都读一次 session storage */
const lastSiteDownloadAt = new Map<string, number>();
let siteDownloadAtLoaded = false;

/**
 * 安全访问 chrome API：在非扩展环境（单测）下 `chrome` 可能完全不存在，
 * 而 `chrome.storage.session` 在部分 Firefox 版本上也不存在。
 */
function getChromeApi(): typeof chrome | undefined {
  return (globalThis as { chrome?: typeof chrome }).chrome;
}

/** 安全访问 chrome.storage.session：环境未提供时返回 undefined */
function getSessionStorageArea(): chrome.storage.StorageArea | undefined {
  return getChromeApi()?.storage?.session;
}

async function loadSiteDownloadAt(): Promise<void> {
  if (siteDownloadAtLoaded) {
    return;
  }
  siteDownloadAtLoaded = true;

  try {
    const stored = await getSessionStorageArea()?.get(SITE_DOWNLOAD_INTERVAL_KEY);
    const table = stored?.[SITE_DOWNLOAD_INTERVAL_KEY] as Record<string, unknown> | undefined;
    for (const [site, at] of Object.entries(table ?? {})) {
      if (typeof at === "number" && Number.isFinite(at)) {
        lastSiteDownloadAt.set(site, at);
      }
    }
  } catch (e) {
    logger({
      msg: "Failed to restore site download interval timestamps",
      level: "warn",
      data: getErrorMessage(e),
    });
  }
}

async function getLastSiteDownloadAt(site: string): Promise<number> {
  await loadSiteDownloadAt();
  return lastSiteDownloadAt.get(site) ?? 0;
}

async function persistSiteDownloadAt(): Promise<void> {
  const area = getSessionStorageArea();
  if (!area) {
    return;
  }
  try {
    await area.set({ [SITE_DOWNLOAD_INTERVAL_KEY]: Object.fromEntries(lastSiteDownloadAt) });
  } catch (e) {
    logger({
      msg: "Failed to persist site download interval timestamps",
      level: "warn",
      data: getErrorMessage(e),
    });
  }
}

/** 预留某站点的下载时间戳，返回被覆盖的上一个时间戳（供失败回滚） */
async function reserveSiteDownloadInterval(site: string, at: number): Promise<number> {
  const previous = await getLastSiteDownloadAt(site);
  lastSiteDownloadAt.set(site, at);
  await persistSiteDownloadAt();
  return previous;
}

/**
 * 回滚预留的时间戳（下载未成功时调用，见 L-1 的「成功后记录」）。
 *
 * 采用 CAS 语义：只有当前值仍是我们预留的那个才回滚，
 * 否则说明后续任务已经预留了更新的时间戳，抹掉它会破坏间隔保护。
 */
async function rollbackSiteDownloadInterval(site: string, at: number, previous: number): Promise<void> {
  if ((await getLastSiteDownloadAt(site)) !== at) {
    return;
  }
  if (previous > 0) {
    lastSiteDownloadAt.set(site, previous);
  } else {
    lastSiteDownloadAt.delete(site);
  }
  await persistSiteDownloadAt();
}

/** 只取 config.download 子表，避免整份 config（含表行为、UI 配置）跨上下文往返 */
async function getDownloadConfig(): Promise<IConfigPiniaStorageSchema["download"]> {
  return ((await sendMessage("getExtStoragePath", {
    key: "config",
    path: "download",
    defaultValue: {},
  })) ?? {}) as IConfigPiniaStorageSchema["download"];
}

/**
 * OFFSCREEN-1：关闭「保存下载历史」时仍必须给出唯一且不复用的投递 id。
 *
 * `setDownloadHistory` 在不落库时返回 0，早期实现直接把它当投递标识，
 * 于是多个「未到站点下载间隔」的延迟下载共用 `reDownloadTorrent-0` 互相覆盖，先投递者永不执行。
 * 这里改为给出负数 id：与 IndexedDB 自增的正数主键天然隔离（不会覆盖既有历史记录），
 * 以取负的毫秒时间戳为起点并只减不增，因此 offscreen 重建后的起点更小，不会复用上一实例在途的 id。
 */
let ephemeralDownloadId = 0;

function nextEphemeralDownloadId(): number {
  // Math.min 保证严格递减：同一毫秒内多次调用不会重复，系统时钟回拨也不会回退到已用过的值
  ephemeralDownloadId = Math.min(ephemeralDownloadId - 1, -Date.now());
  return ephemeralDownloadId;
}

async function isAllowedSaveDownloadHistory(): Promise<boolean> {
  const allowed = await sendMessage("getExtStoragePath", {
    key: "config",
    path: "download.saveDownloadHistory",
    defaultValue: true,
  });
  return (allowed as boolean) ?? true;
}

/**
 * 下载任务并发控制（见 docs/performance-audit.md P1-22）：
 * 早期实现没有任何并发限制，列表页「批量下载」会一次性打出上百个任务，
 * 每个任务都会访问站点与下载器，形成并发风暴。
 */
const DOWNLOAD_CONCURRENCY = 3;
const downloadQueue = new PQueue({ concurrency: DOWNLOAD_CONCURRENCY });

interface IPreparedDownload {
  downloadConfig: IConfigPiniaStorageSchema["download"];
  /**
   * 入队前预留的站点下载时间戳（见 L-1）：下载结束时若未成功，需要把它回滚，
   * 否则一次失败也会「消耗」该站点的下载间隔。
   */
  siteDownloadReservation?: { site: string; at: number; previous: number };
}

function isPendingDownloadResult(value: IDownloadTorrentResult | IPreparedDownload): value is IDownloadTorrentResult {
  return "downloadStatus" in value;
}

/**
 * 入队前的准备工作：生成下载历史，并把「站点下载间隔未到」的任务投递到 alarms 等待。
 *
 * 这段逻辑必须在进入 `downloadQueue` 之前完成（见 docs/performance-audit.md P1-22）：
 * 早期实现把它放在队列任务内部，虽然未到间隔时只投递 `reDownloadTorrent` 就立刻 return pending，
 * 但站点实例化/存储读取期间仍然占用并发槽，3 个这样的等待任务就足以堵满 DOWNLOAD_CONCURRENCY，
 * 真正要下载的任务被饿死。这里只做轻量的配置/站点实例读取，
 * 站点请求配置与真正的下载动作仍然留在队列内，避免批量下载时形成并发风暴。
 */
async function prepareDownloadTorrent(
  downloadOption: IDownloadTorrentOption,
): Promise<IDownloadTorrentResult | IPreparedDownload> {
  const downloadConfig = await getDownloadConfig();

  // 0. 解析传来的下载参数
  const { torrent, downloaderId = "local" } = downloadOption;
  const isDownloadToLocalFile: boolean = downloaderId === "local"; // 如果前端没有传入下载器的id，则认为下载为本地文件

  // 1. 生成下载历史（等待重新下载的任务也需要 downloadId 作为投递标识）
  if (typeof downloadOption.downloadId === "undefined") {
    const downloadHistory = buildDownloadHistory(downloadOption);
    const savedDownloadId = await setDownloadHistory(downloadHistory);
    // OFFSCREEN-1：0 只表示「历史未落库」（关闭保存下载历史），不能拿它当投递标识，
    // 否则多个延迟下载会共用 `reDownloadTorrent-0` 而互相覆盖。
    downloadOption.downloadId = savedDownloadId === 0 ? nextEphemeralDownloadId() : savedDownloadId;
  }
  const downloadId = downloadOption.downloadId!;
  logger({ msg: `generate download torrent task #${downloadId}` });

  // 2. 检查站点下载间隔，未到间隔则投递重新下载并返回 pending
  let siteDownloadReservation: IPreparedDownload["siteDownloadReservation"];
  if (torrent.site) {
    const siteInstance = await getSiteInstance<"public">(torrent.site);

    if (
      siteInstance.downloadInterval > 0 &&
      // 允许本地下载时忽略站点设置中的下载间隔
      !(isDownloadToLocalFile && downloadConfig?.ignoreSiteDownloadIntervalWhenLocalDownload)
    ) {
      const now = Date.now();
      const leftInterval = siteInstance.downloadInterval * 1000 - (now - (await getLastSiteDownloadAt(torrent.site)));

      if (leftInterval > 0) {
        logger({ msg: `Site ${torrent.site} download interval not reached, waiting...` });
        // 注意：payload 结构由 background 侧消费，保持 { ...downloadOption, downloadId, leftInterval }
        sendMessage("reDownloadTorrent", { ...downloadOption, downloadId, leftInterval }).catch((e) =>
          // 投递失败不改变控制流（本次仍返回 pending），但保留可诊断日志
          logger({
            msg: `Failed to schedule re-download for downloadId=${downloadId}`,
            level: "error",
            data: getErrorMessage(e),
          }),
        );
        return {
          downloadId,
          downloadStatus: await setDownloadStatus(downloadId, "pending"),
        } as IDownloadTorrentResult;
      }

      /**
       * 这里只**预留**时间戳，不把它当成「已下载」（见 L-1）：
       * 真正的下载在 downloadQueue 里执行，成功才保留这个预留，失败则在 downloadTorrent 的收尾处回滚。
       *
       * 为什么不改成「成功后再写」：`prepareDownloadTorrent` 在入队前执行，批量下载时多个任务的 prepare
       * 会在第一个任务完成前全部跑完（不受 DOWNLOAD_CONCURRENCY 限制），若此时时间戳仍为空，
       * 它们会一起通过间隔检查 —— 防轰炸保护反而失效。
       * 预留 + 失败回滚同时满足「失败不消耗间隔」与「并发任务仍被间隔串开」。
       */
      siteDownloadReservation = {
        site: torrent.site,
        at: now,
        previous: await reserveSiteDownloadInterval(torrent.site, now),
      };
    }
  }

  return { downloadConfig, siteDownloadReservation };
}

async function downloadTorrent(downloadOption: IDownloadTorrentOption, prepared: IPreparedDownload) {
  const downloadConfig = prepared.downloadConfig;

  // 0. 解析传来的下载参数
  const { torrent, downloaderId = "local", addTorrentOptions = {} as CAddTorrentOptions } = downloadOption;
  const isDownloadToLocalFile: boolean = downloaderId === "local"; // 如果前端没有传入下载器的id，则认为下载为本地文件

  // 1. 生成下载历史（已由入队前的 prepareDownloadTorrent 完成）
  const downloadId = downloadOption.downloadId!;
  let downloadStatus = await setDownloadStatus(downloadId, "pending");
  let errorMessage: string | undefined;
  // DOWNLOADER-8：与失败并列的告警（推送成功但部分设置未生效），单独透出以免被 UI 当成失败原因
  let warningMessage: string | undefined;

  // 2. 构建下载链接的请求配置
  let downloadRequestConfig: AxiosRequestConfig = { url: torrent.link, method: "GET", timeout: 30e3 };
  let siteInstance: Awaited<ReturnType<typeof getSiteInstance<"public">>> | null = null;

  try {
    if (!torrent.site && !torrent.link?.startsWith("magnet:")) {
      throw new Error("Rejected download URL without a trusted site");
    }
    if (torrent.site) {
      // 生成站点；站点下载间隔的检查已在入队前的 prepareDownloadTorrent 中完成
      siteInstance = await getSiteInstance<"public">(torrent.site);
      if (
        (torrent.link && !siteInstance.isTrustedDownloadLink(torrent.link)) ||
        (torrent.url && !siteInstance.isTrustedDownloadLink(torrent.url))
      ) {
        throw new Error(`Rejected torrent URL outside site host allowlist for ${torrent.site}`);
      }

      // 添加站点配置的上传速度限制
      if (!isDownloadToLocalFile && (siteInstance.userConfig?.uploadSpeedLimit ?? 0) > 0) {
        addTorrentOptions.uploadSpeedLimit = siteInstance.userConfig.uploadSpeedLimit;
      }

      downloadRequestConfig = toMerged(
        downloadRequestConfig,
        await siteInstance.getTorrentDownloadRequestConfig(torrent as ITorrent),
      );
    }
    if (siteInstance && !siteInstance.isTrustedDownloadLink(axios.getUri(downloadRequestConfig))) {
      throw new Error(`Rejected download request outside site host allowlist for ${torrent.site}`);
    }
    await patchDownloadHistory(downloadId!, { downloadRequestConfig }).catch((e) =>
      // 存储下载请求配置，方便后续调试；失败不影响下载主流程，但不再静默
      logger({ msg: "Failed to store download request config", level: "error", data: getErrorMessage(e) }),
    );

    downloadStatus = await setDownloadStatus(downloadId, "downloading");
    if (isDownloadToLocalFile) {
      // 本地下载
      downloadOption.localDownloadMethod ??= downloadConfig?.localDownloadMethod ?? "web";
      const localResult = await downloadTorrentToLocalFile(
        downloadOption as TLocalDownloadOption,
        downloadRequestConfig,
        prepared.siteDownloadReservation,
      );
      downloadStatus = localResult.downloadStatus;
      errorMessage = localResult.errorMessage;
    } else {
      // 远程推送
      addTorrentOptions.localDownload ??= true; // 默认开启本地中转选项（如果传递进来的没有 localDownload 值的话）
      if (!(downloadConfig?.allowDirectSendToClient ?? false)) {
        addTorrentOptions.localDownload = true; // 如果不允许直接发送到下载器，则将本地中转选项强行设置为 true
      }
      downloadOption.addTorrentOptions = addTorrentOptions;
      const remoteResult = await downloadTorrentToRemote(
        downloadOption as TRemoteDownloadOption,
        downloadRequestConfig,
      );
      downloadStatus = remoteResult.downloadStatus;
      errorMessage = remoteResult.errorMessage;
      warningMessage = remoteResult.warningMessage;
    }
  } catch (e) {
    downloadStatus = "failed";
    errorMessage = getErrorMessage(e);
  }

  if (downloadStatus !== "pending") {
    await setDownloadStatus(downloadId, downloadStatus);
  }
  if (prepared.siteDownloadReservation && downloadStatus === "failed") {
    // 下载未成功：回滚入队前预留的站点下载时间戳（见 L-1），失败不应消耗该站点的下载间隔
    const { site, at, previous } = prepared.siteDownloadReservation;
    await rollbackSiteDownloadInterval(site, at, previous);
  }
  if (errorMessage) {
    // 将失败原因写入下载历史，方便在下载历史页面定位问题（见 issue #1430）
    await patchDownloadHistory(downloadId, { errorMessage }).catch(() => {
      logger({ msg: `Failed to persist errorMessage for download task #${downloadId}` });
    });
  }
  if (warningMessage) {
    // DOWNLOADER-8：告警同样要落库，否则只有本次调用方能看到；写独立字段，UI 才能在列表/弹窗里
    // 以「告警」而不是红色「失败原因」展示（downloadStatus 仍是 completed）
    await patchDownloadHistory(downloadId, { warningMessage }).catch(() => {
      logger({ msg: `Failed to persist warningMessage for download task #${downloadId}` });
    });
  }
  return { downloadId, downloadStatus, errorMessage, warningMessage } as IDownloadTorrentResult;
}

onMessage("downloadTorrent", async ({ data: downloadOption }) => {
  const incomingDownloadId = downloadOption.downloadId;
  // 站点下载间隔判断/调度在入队前完成，等待间隔的任务不会占用下载并发槽
  let prepared: IDownloadTorrentResult | IPreparedDownload;
  try {
    prepared = await prepareDownloadTorrent(downloadOption);
  } catch (e) {
    /**
     * OFFSCREEN-6：prepareDownloadTorrent 会先落一条 `downloadStatus: "pending"` 的历史再去
     * 实例化站点（getSiteInstance 对未收录站点会抛错）。这里不处理的话，异常沿消息 reject 出去，
     * 后面的 downloadTorrent 与 setDownloadStatus(failed) 都不会执行，记录只能等 background 的
     * failStaleDownloadRecords（1h 阈值 + 6h 扫描）纠偏。
     *
     * 只处理「本次调用新建的 id」：调用方显式传入的 id（延迟重下）由 background 的对账逻辑负责，
     * 避免在这里误改一条既有记录。
     */
    if (typeof incomingDownloadId === "undefined" && typeof downloadOption.downloadId !== "undefined") {
      await setDownloadStatus(downloadOption.downloadId, "failed");
      await patchDownloadHistory(downloadOption.downloadId, { errorMessage: getErrorMessage(e) }).catch((err) =>
        logger({ msg: "Failed to store prepare error message", level: "error", data: getErrorMessage(err) }),
      );
    }
    throw e;
  }
  if (isPendingDownloadResult(prepared)) {
    return prepared;
  }

  // 通过队列限制并发，避免批量下载时对站点/下载器形成并发风暴
  return (await downloadQueue.add(() => downloadTorrent(downloadOption, prepared))) as IDownloadTorrentResult;
});

async function downloadTorrentToLocalFile(
  downloadOption: TLocalDownloadOption,
  downloadRequestConfig: AxiosRequestConfig,
  siteDownloadReservation?: IPreparedDownload["siteDownloadReservation"],
): Promise<Pick<IDownloadTorrentResult, "downloadStatus" | "errorMessage">> {
  let { torrent, localDownloadMethod = "web", downloadId } = downloadOption;
  let downloadStatus: TTorrentDownloadStatus = "downloading";
  let errorMessage: string | undefined;

  const downloadUri = axios.getUri(downloadRequestConfig); // 组装 baseURL, url, params
  const {
    method: downloadMethod = "GET",
    data: downloadData = {},
    headers: downloadHeaders = {} as Record<string, string>,
  } = downloadRequestConfig;

  // 如果设置为 web 方法，且没有 headers 的情况，直接使用 window.open 方法
  if (localDownloadMethod === "web") {
    if (downloadMethod.toUpperCase() === "GET" && isEmpty(downloadHeaders)) {
      logger({ msg: `Download torrent file with web method: ${downloadUri}` });
      // offscreen 文档没有用户激活（user activation），弹窗通常会被拦截并返回 null（见 L-6）。
      // 早期实现不检查返回值就直接标记 completed —— 用户既没拿到文件，历史里还写着成功。
      // 这里检查返回值：被拦截时回退到下面的 extension 方法（用 chrome.downloads 真正下载）。
      const openedWindow = window.open(downloadUri, "_blank");
      if (openedWindow) {
        return { downloadStatus: await setDownloadStatus(downloadId, "completed"), errorMessage };
      }
      logger({
        msg: `window.open was blocked (no user activation in offscreen document), falling back to extension method`,
        level: "warn",
      });
      localDownloadMethod = "extension";
    } else {
      localDownloadMethod = "extension"; // 如果是不能直接使用 window.open 方法的情况，直接使用 extension 方法
    }
  }

  // 如果设置为 extension，直接使用 chrome.downloads 方法
  if (localDownloadMethod === "browser" && ["GET", "POST"].includes(downloadMethod.toUpperCase())) {
    try {
      // 将 AxiosRequestConfig 转换为 chrome.downloads.DownloadOptions， 我们在这里只考虑 method, body, headers
      const downloadOptions: chrome.downloads.DownloadOptions = {
        url: downloadUri,
        conflictAction: "uniquify",
        method: downloadMethod.toUpperCase() as "GET" | "POST",
      };

      if (downloadMethod.toUpperCase() === "POST" && !isEmpty(downloadData ?? {})) {
        downloadOptions.body = stringify(downloadData);
      }

      if (!isEmpty(downloadHeaders)) {
        downloadOptions.headers = Object.entries(downloadHeaders).map(([name, value]) => ({ name, value }));
      }

      logger({ msg: `Download torrent file with browser method: ${downloadUri}` });
      const chromeDownloadId = await sendMessage("downloadFile", downloadOptions);
      await setDownloadStatus(downloadId, "pending");
      trackLocalDownload(chromeDownloadId, downloadId, siteDownloadReservation);
      return { downloadStatus: "pending", errorMessage };
    } catch (e) {
      localDownloadMethod = "extension"; // 如果下载失败，直接使用 extension 方法（怎么可能？）
    }
  } else {
    localDownloadMethod = "extension"; // 如果还是不能使用的情况（怎么可能？），则直接使用 extension 方法
  }

  // 如果设置为 extension，其次考虑使用 getRemoteTorrentFile 转为 Blob 再调用 chrome.downloads
  if (localDownloadMethod === "extension") {
    // blob: URL 必须在下载真正读完之后才能释放（见 L-5）：
    // 早期实现只在成功路径 revoke，异常路径（sendMessage 抛错、setDownloadStatus 抛错）下会永久泄漏。
    let blobUrl: string | undefined;
    try {
      logger({ msg: `Download torrent file with extension method: ${downloadUri}` });

      const torrentInstance = await getRemoteTorrentFile(downloadRequestConfig);
      blobUrl = URL.createObjectURL(torrentInstance.metadata.blob());
      let filename = torrentInstance.name;
      if (filename === "1.torrent") {
        // 如果文件名是缺省的 1.torrent，那么使用种子属性中的站点名和标题作为文件名
        filename = `[${torrent.site}] ${torrent.title}.torrent`;
      }

      const chromeDownloadId = await sendMessage("downloadFile", {
        url: blobUrl,
        filename,
        conflictAction: "uniquify",
      });
      // 交给释放器：`downloads.download()` resolve 只是「下载已被接受」，此时 revoke 会让下载读到一半失败；
      // 这里等 chrome.downloads 报告该下载进入终态（complete/interrupted）后再释放，并有宽裕超时兜底。
      await setDownloadStatus(downloadId, "pending");
      trackLocalDownload(chromeDownloadId, downloadId, siteDownloadReservation, blobUrl);
      blobUrl = undefined;
      downloadStatus = "pending";
    } catch (e) {
      downloadStatus = await setDownloadStatus(downloadId, "failed");
      errorMessage = getErrorMessage(e);
    } finally {
      if (blobUrl) {
        // 失败路径：blob 从未交给 chrome.downloads（或下载未被接受），立即释放
        URL.revokeObjectURL(blobUrl);
      }
    }
  }

  return { downloadStatus, errorMessage };
}

async function downloadTorrentToRemote(
  downloadOption: TRemoteDownloadOption,
  downloadRequestConfig: AxiosRequestConfig,
): Promise<Pick<IDownloadTorrentResult, "downloadStatus" | "errorMessage" | "warningMessage">> {
  const { torrent, downloaderId, addTorrentOptions, downloadId } = downloadOption;
  let downloadStatus: TTorrentDownloadStatus = "failed"; // 远程推送默认失败状态
  let errorMessage: string | undefined;
  let warningMessage: string | undefined;

  const downloaderConfig = await getDownloaderConfig(downloaderId);
  if (downloaderConfig.id && downloaderConfig.enabled) {
    const downloaderInstance = await getDownloaderInstance(downloaderId);
    if (!downloaderInstance) {
      return { downloadStatus, errorMessage: `Downloader not found: ${downloaderId}` };
    }
    if (addTorrentOptions.localDownload) {
      addTorrentOptions.localDownloadOption = downloadRequestConfig;
    }

    // 日志只保留可定位问题的摘要字段，避免把整个请求配置写入日志缓冲（见 docs/performance-audit.md P1-2）
    const loggerData = { title: torrent.title, site: torrent.site, downloaderId } as Record<string, any>;
    try {
      logger({ msg: "downloadTorrentToDownloader", data: loggerData });
      const addTorrentResult = await downloaderInstance.addTorrent(downloadRequestConfig.url!, addTorrentOptions);
      loggerData.addTorrentResult = addTorrentResult;
      if (addTorrentResult?.success === true) {
        /**
         * DOWNLOADER-8：下载器可能「成功但降级」——例如 uTorrent 直发 http(s) 链接时拿不到 infoHash，
         * 暂停 / 标签 / 上传限速会被跳过，但 addTorrent 仍返回 success=true 并只在 message 里说明。
         * 这里降级为 warn 日志并把 message 透出到独立的 warningMessage 字段
         * （downloadStatus 仍保持 completed，成功语义不变）。
         * 为什么不用 errorMessage：UI 按字段语义着色/统计，写进 errorMessage 会把成功记录渲染成
         * 红色「失败原因」，并让「发送到下载器」汇总误判为失败。
         */
        const addTorrentWarning = addTorrentResult.message ? getErrorMessage(addTorrentResult.message) : undefined;
        if (addTorrentWarning) {
          warningMessage = addTorrentWarning;
          logger({
            msg: "Successfully added torrent to downloader with warnings",
            level: "warn",
            data: { ...loggerData, message: addTorrentWarning },
          });
        } else {
          logger({ msg: "Successfully added torrent to downloader", data: loggerData });
        }
        downloadStatus = "completed";
      } else {
        logger({ msg: "Failed to add torrent to downloader", data: loggerData });
        errorMessage = getErrorMessage(addTorrentResult?.message || "Downloader rejected the torrent");
      }
      // 存储添加种子结果，方便后续调试；失败不影响下载主流程，但不再静默
      patchDownloadHistory(downloadId, { addTorrentResult }).catch((e) =>
        logger({ msg: "Failed to store addTorrentResult", level: "error", data: getErrorMessage(e) }),
      );
    } catch (e) {
      logger({ msg: "Error adding torrent to downloader", data: loggerData });
      errorMessage = getErrorMessage(e);
    }
  } else {
    errorMessage = `Downloader is missing or disabled: ${downloaderId}`;
  }

  return { downloadStatus, errorMessage, warningMessage };
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/** blob: URL 释放的兜底超时：拿不到下载 id / 环境没有 downloads.onChanged 时，也必须释放（见 L-5） */
const BLOB_URL_RELEASE_TIMEOUT = 10 * 60 * 1000;

type TDownloadTerminalState = "complete" | "interrupted";

function watchDownloadSettled(
  chromeDownloadId: number | undefined,
  blobUrl?: string,
  onSettled?: (state: TDownloadTerminalState) => Promise<void>,
): void {
  let settled = false;
  let blobReleased = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const releaseBlob = () => {
    if (!blobUrl || blobReleased) return;
    blobReleased = true;
    URL.revokeObjectURL(blobUrl);
  };
  const cleanup = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    try {
      getChromeApi()?.downloads?.onChanged?.removeListener(onDownloadChanged);
    } catch (e) {
      logger({ msg: "Failed to remove download state listener", level: "debug", data: getErrorMessage(e) });
    }
    releaseBlob();
  };
  const finish = (state: TDownloadTerminalState) => {
    if (settled) return;
    settled = true;
    cleanup();
    void onSettled?.(state).catch((e) =>
      logger({ msg: "Failed to record browser download state", level: "error", data: getErrorMessage(e) }),
    );
  };

  const onDownloadChanged = (delta: chrome.downloads.DownloadDelta) => {
    if (delta.id !== chromeDownloadId) {
      return;
    }
    const currentState = delta.state?.current;
    if (currentState === "complete" || currentState === "interrupted") {
      finish(currentState);
    }
  };

  const checkCurrentState = (afterTimeout: boolean) => {
    const downloads = getChromeApi()?.downloads;
    if (!downloads?.search || typeof chromeDownloadId !== "number") {
      if (afterTimeout) finish("interrupted");
      return;
    }
    void downloads.search({ id: chromeDownloadId }).then(
      (items) => {
        if (settled) return;
        const state = items?.[0]?.state;
        if (state === "complete" || state === "interrupted") {
          finish(state);
        } else if (afterTimeout) {
          if (state === "in_progress") {
            armTimeout();
          } else {
            finish("interrupted");
          }
        }
      },
      (e) => {
        logger({ msg: "Failed to check browser download state", level: "warn", data: getErrorMessage(e) });
        if (afterTimeout) finish("interrupted");
      },
    );
  };
  const armTimeout = () => {
    timer = setTimeout(() => {
      releaseBlob();
      if (!onSettled || typeof chromeDownloadId !== "number") {
        cleanup();
        return;
      }
      // 终态事件丢失时主动查询；仍在下载则继续等待，不能把慢下载误报为失败。
      checkCurrentState(true);
    }, BLOB_URL_RELEASE_TIMEOUT);
    (timer as unknown as { unref?: () => void })?.unref?.();
  };
  armTimeout();

  if (typeof chromeDownloadId !== "number") {
    return; // 拿不到下载 id，只能靠超时兜底
  }

  try {
    getChromeApi()?.downloads?.onChanged?.addListener(onDownloadChanged);
    if (onSettled) checkCurrentState(false);
  } catch (e) {
    logger({ msg: "Failed to watch browser download state", level: "warn", data: getErrorMessage(e) });
  }
}

function trackLocalDownload(
  chromeDownloadId: number,
  downloadId: TTorrentDownloadKey,
  reservation?: IPreparedDownload["siteDownloadReservation"],
  blobUrl?: string,
): void {
  watchDownloadSettled(chromeDownloadId, blobUrl, async (state) => {
    await setDownloadStatus(downloadId, state === "complete" ? "completed" : "failed");
    if (state === "interrupted") {
      await patchDownloadHistory(downloadId, { errorMessage: "Browser download interrupted" });
      if (reservation) {
        await rollbackSiteDownloadInterval(reservation.site, reservation.at, reservation.previous);
      }
    }
  });
}

/** 本地备份也必须等浏览器读完 Blob 才能释放 URL。 */
export function releaseBlobUrlWhenDownloadSettled(blobUrl: string, chromeDownloadId?: number): void {
  watchDownloadSettled(chromeDownloadId, blobUrl);
}

export async function getDownloadHistory() {
  return await (await ptdIndexDb).getAll("download_history");
}

onMessage("getDownloadHistory", getDownloadHistory);

export async function getDownloadHistoryById(downloadId: TTorrentDownloadKey) {
  return await (await ptdIndexDb).get("download_history", downloadId);
}

onMessage("getDownloadHistoryById", async ({ data: downloadId }) => (await getDownloadHistoryById(downloadId))!);

export async function setDownloadHistory(data: ITorrentDownloadMetadata) {
  const allowedSave = await isAllowedSaveDownloadHistory();
  return allowedSave ? await (await ptdIndexDb).put("download_history", data) : 0;
}

/**
 * B-11：按 `downloadId` 串行化「读 → 改 → 写」。
 *
 * `patchDownloadHistory` 是标准的读改写：读 IndexedDB → 合并 → 写回，而中间隔着跨上下文消息往返，
 * 窗口很宽。调用方之间存在**未 await** 的组合（例如 `:767` 存 `addTorrentResult` 是 fire-and-forget，
 * 紧接 `setDownloadStatus` 写最终状态），两个并发的读改写会互相覆盖 —— 实际后果是历史记录永久停在
 * `downloading`（最终状态丢失）或丢掉 `addTorrentResult`。
 *
 * 这里把同一 key 的调用串成链：后一个等前一个 settle 再重新读取，因此每次合并看到的都是最新值。
 * 链尾在排空后删除，避免 Map 无界增长。
 */
const downloadHistoryPatchChain = new Map<TTorrentDownloadKey, Promise<unknown>>();

export async function patchDownloadHistory(downloadId: TTorrentDownloadKey, data: Partial<ITorrentDownloadMetadata>) {
  const previous = downloadHistoryPatchChain.get(downloadId) ?? Promise.resolve();
  const current = previous
    // 前一次失败不应阻塞后一次（各自的失败由各自的调用方处理）
    .catch(() => undefined)
    .then(async () => {
      const allowedSave = await isAllowedSaveDownloadHistory();
      const downloadHistory = await getDownloadHistoryById(downloadId);
      if (allowedSave && downloadHistory) {
        await setDownloadHistory({ ...downloadHistory, ...data });
      }
    });

  downloadHistoryPatchChain.set(downloadId, current);
  try {
    await current;
  } finally {
    // 只有自己仍是链尾时才清理，否则会把后来者接上的链断掉
    if (downloadHistoryPatchChain.get(downloadId) === current) {
      downloadHistoryPatchChain.delete(downloadId);
    }
  }
}

async function setDownloadStatus(
  downloadId: TTorrentDownloadKey,
  downloadStatus: TTorrentDownloadStatus,
): Promise<TTorrentDownloadStatus> {
  await patchDownloadHistory(downloadId, { downloadStatus }).catch((e) =>
    // 状态落库失败不改变返回值语义，但不再静默
    logger({ msg: `Failed to store download status "${downloadStatus}"`, level: "error", data: getErrorMessage(e) }),
  );
  return downloadStatus;
}

onMessage("setDownloadHistoryStatus", async ({ data: { downloadId, status } }) => {
  await setDownloadStatus(downloadId, status);
});

export async function deleteDownloadHistoryById(downloadId: TTorrentDownloadKey) {
  return await (await ptdIndexDb).delete("download_history", downloadId);
}

onMessage("deleteDownloadHistoryById", async ({ data: downloadId }) => await deleteDownloadHistoryById(downloadId));

export async function clearDownloadHistory() {
  return await (await ptdIndexDb).clear("download_history");
}

onMessage("clearDownloadHistory", clearDownloadHistory);
