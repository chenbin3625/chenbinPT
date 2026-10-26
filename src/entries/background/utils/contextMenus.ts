import { nanoid } from "nanoid";
import { format as dateFormat } from "date-fns";

import { type CAddTorrentOptions } from "@ptd/downloader/types.ts";
import { datePathTemplateVars, expandPathTemplate } from "@ptd/downloader/utils/pathTemplate.ts";
import { getHostFromUrl } from "@ptd/site/utils/html.ts"; // 这里不能使用 @ptd/site 的主入口，会导致 sw 无法加载
import { type ITorrent } from "@ptd/site/types/torrent.ts";

import { onMessage, sendMessage } from "@/messages.ts";
import { type IDownloaderMetadata, type IMetadataPiniaStorageSchema } from "@/shared/types/storages/metadata.ts";
import type { IConfigPiniaStorageSchema } from "@/shared/types/storages/config.ts";

import { getExtStorageCached, getExtStoragePathCached, logBackgroundError, openOptionsPage } from "./base.ts";

const contextMenusId = "chenbinPT-Context-Menus";

/**
 * 站点 host/name 索引读取（见 docs/performance-audit.md P2-17）：
 * 优先使用独立的 siteIndex 小 key，缺失时回落到 metadata（兼容旧数据）。
 * metadata 可达数百 KB ~ MB 级且会被用户信息刷新等高频写入反复失效，
 * 只为查一个 host→siteId 映射不应反序列化整份 metadata。
 *
 * 空对象不算有效索引：它可能是上一轮重建留下的空表，若当成有效索引就会永久停在这个空表上
 * （读取方也不会回落到 metadata），此时一律回落读取 metadata。
 */
function isUsableIndexMap(value: unknown): value is Record<string, string> {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 0;
}

async function getSiteHostMap(): Promise<Record<string, string>> {
  const indexed = await getExtStoragePathCached("siteIndex", "siteHostMap", undefined as unknown);
  if (isUsableIndexMap(indexed)) {
    return indexed;
  }
  return ((await getExtStoragePathCached("metadata", "siteHostMap", {})) as Record<string, string>) ?? {};
}

async function getSiteNameMap(): Promise<Record<string, string>> {
  const indexed = await getExtStoragePathCached("siteIndex", "siteNameMap", undefined as unknown);
  if (isUsableIndexMap(indexed)) {
    return indexed;
  }
  return ((await getExtStoragePathCached("metadata", "siteNameMap", {})) as Record<string, string>) ?? {};
}

export interface IContextMenusKeyInput {
  tabHost: string;
  thisTabSiteId?: string | null;
  thisTabSiteName?: string | null;
  config?: IConfigPiniaStorageSchema;
  metadata?: IMetadataPiniaStorageSchema;
  siteNameMap?: Record<string, string>;
}

/**
 * 右键菜单内容的「上下文摘要」（见 docs/performance-audit.md P1-7）。
 *
 * 菜单内容不只取决于当前站点，还取决于 `config.contextMenus.*`、启用的搜索方案、
 * 允许搜索的站点列表与下载器（含建议目录）。早期实现只把 `tabHost|siteId|siteName`
 * 作为 key，于是只改这些配置不会重建菜单。这里把所有会影响菜单内容的输入摘要进去；
 * 摘要顺序与构建菜单时的排序一致，保证相同输入得到相同 key。
 */
export function buildContextMenusContextKey(input: IContextMenusKeyInput): string {
  const { tabHost, thisTabSiteId, thisTabSiteName, config, metadata, siteNameMap = {} } = input;
  const contextMenus = config?.contextMenus;
  const solutionsMeta = metadata?.solutions ?? ({} as IMetadataPiniaStorageSchema["solutions"]);
  const sitesMeta = metadata?.sites ?? ({} as IMetadataPiniaStorageSchema["sites"]);
  const downloadersMeta = metadata?.downloaders ?? ({} as IMetadataPiniaStorageSchema["downloaders"]);

  const solutions = Object.values(solutionsMeta)
    .filter((x) => !!x.enabled) // 过滤掉未启用的搜索方案
    .sort((a, b) => b.sort - a.sort) // 按照 sort 降序排序
    .map((x) => [x.id, x.name, x.sort]);

  const sites = Object.entries(sitesMeta)
    .filter(([, site]) => !site.isOffline && !!site.allowSearch)
    .sort((a, b) => (b[1].sortIndex ?? 0) - (a[1].sortIndex ?? 0))
    .map(([siteId, site]) => [siteId, site.sortIndex ?? 0, siteNameMap[siteId] ?? siteId]);

  const downloaders = Object.values(downloadersMeta)
    .filter((x) => !!x.enabled)
    .sort((a, b) => (b.sortIndex ?? 100) - (a.sortIndex ?? 100))
    .map((x) => [
      x.id,
      x.name,
      x.address,
      x.sortIndex ?? 100,
      x.suggestFolders ?? [],
      // BACKGROUNDSHARED-1：菜单闭包在 downloadLinkPush 里读 feature.DefaultAutoStart（决定 addAtPaused），
      // L-6 取消强制重建后摘要必须覆盖它，否则改了「自动开始」也不会重建菜单；
      // BACKGROUNDSHARED-4：按站点排除下载器（excludedSites）后菜单内容会变，同样必须进摘要。
      x.feature?.DefaultAutoStart ?? null,
      x.excludedSites ?? [],
    ]);

  return JSON.stringify({
    tabHost,
    thisTabSiteId: thisTabSiteId ?? "",
    thisTabSiteName: thisTabSiteName ?? "",
    contextMenus: {
      enabled: contextMenus?.enabled ?? true,
      allowSelectionTextSearch: contextMenus?.allowSelectionTextSearch ?? true,
      allowSocialLinkSearch: contextMenus?.allowSocialLinkSearch ?? true,
      allowLinkDownloadPush: contextMenus?.allowLinkDownloadPush ?? true,
    },
    // BACKGROUNDSHARED-4：站点过滤开关本身也决定菜单是否过滤，必须进摘要
    download: {
      allowDownloaderFilterForSite: config?.download?.allowDownloaderFilterForSite ?? false,
    },
    solutions,
    sites,
    downloaders,
    // Info-3：$date:YYYY$ / $date:MM$ / $date:DD$ 模板在构建菜单时求值；摘要不含日期会让
    // 跨午夜后的菜单继续显示昨天的目录名，直到其它输入变化触发重建。把「当前日期」纳入摘要。
    date: dateFormat(new Date(), "yyyy-MM-dd"),
  });
}

/**
 * 合并式防抖：窗口内的多次变更合并成一次执行，并保证「最后一次变更一定被执行」。
 *
 * 早期实现在 `rebuildTimer !== null` 时直接 return，1s 窗口内的后续变更会被永久丢弃
 * （而 lastBuiltContextKey 已被置 null）——最后一次配置变更可能永远不生效。
 * 这里用 pending 标记记住「执行期间又有新变更」，本轮结束后再跑一轮。
 */
export function createCoalescingDebounce(
  run: () => void | Promise<void>,
  delayMs: number,
  onError?: (err: unknown) => void,
) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending = false;

  async function invoke(): Promise<void> {
    pending = false;
    try {
      await run();
    } catch (err) {
      onError?.(err);
    } finally {
      timer = null;
      if (pending) {
        schedule(); // 执行期间又收到变更：再跑一轮，保证最后一次变更一定生效
      }
    }
  }

  function schedule(): void {
    if (timer !== null) {
      pending = true;
      return;
    }
    timer = setTimeout(invoke, delayMs);
  }

  return { schedule };
}

const contextMenusClickEventBus = new Map<
  string | number,
  (info: chrome.contextMenus.OnClickData, tab: chrome.tabs.Tab) => void
>();

export function createContextMenuClickDispatcher(
  eventBus: Map<string | number, (info: chrome.contextMenus.OnClickData, tab: chrome.tabs.Tab) => void>,
  rebuild: () => void | Promise<void>,
) {
  return async (info: chrome.contextMenus.OnClickData, tab: chrome.tabs.Tab | undefined): Promise<void> => {
    if (!info.menuItemId) {
      return;
    }

    let clickHandler = eventBus.get(info.menuItemId);
    if (!clickHandler) {
      // MV3 service workers can be restarted while Chrome keeps the native menu.
      // Rebuild the in-memory callback table before giving up on the first click.
      await rebuild();
      clickHandler = eventBus.get(info.menuItemId);
    }

    if (clickHandler && tab) {
      clickHandler(info, tab);
    }
  };
}

const dispatchContextMenuClick = createContextMenuClickDispatcher(contextMenusClickEventBus, scheduleContextMenusBuild);

chrome.contextMenus?.onClicked.addListener((info, tab) => {
  void dispatchContextMenuClick(info, tab).catch((error) => {
    logBackgroundError("Failed to dispatch context menu click", error);
  });
});

function addContextMenu(data: chrome.contextMenus.CreateProperties) {
  if (!data.id) {
    data.id = nanoid();
  }

  if (data.onclick) {
    // 如果有 onclick 事件，则将其存入事件总线
    contextMenusClickEventBus.set(data.id, data.onclick);
    delete data.onclick; // 删除 onclick 属性，因为 chrome.contextMenus.create 不支持直接传入 onclick
  }

  const menuId = data.id;
  const contextMenus = chrome.contextMenus;
  if (!contextMenus) {
    return data.id;
  }

  // N3/G2：create 失败（最常见是 id 重复）只会写 chrome.runtime.lastError，不会抛错。
  // **不删除已注册的 handler**：duplicate id 说明浏览器侧旧菜单项仍然存在且可点，删除 handler 会
  // 让「冷启动第一次点击」静默无效（A3 的回归）；其它错误下保留 handler 也无害（该 id 没有被创建）。
  const handleCreated = () => {
    const error = chrome.runtime?.lastError;
    if (!error) {
      return;
    }
    if (activeCreateTracker) {
      activeCreateTracker.failures += 1;
    }
    logBackgroundError(`Failed to create context menu "${String(menuId)}"`, error.message);
  };

  const tracker = activeCreateTracker;
  if (tracker) {
    // 构建批次内：记录 Promise，等待 initContextMenus 汇总失败后再决定是否提交 lastBuiltContextKey
    tracker.pending.push(
      new Promise<void>((resolve) => {
        try {
          contextMenus.create(data, () => {
            handleCreated();
            resolve();
          });
        } catch (e) {
          logBackgroundError(`Failed to create context menu "${String(menuId)}"`, e);
          tracker.failures += 1;
          resolve();
        }
      }),
    );
  } else {
    // 构建批次外（onMessage addContextMenu 等）：只上报，不影响构建状态
    try {
      contextMenus.create(data, handleCreated);
    } catch (e) {
      logBackgroundError(`Failed to create context menu "${String(menuId)}"`, e);
    }
  }

  return data.id;
}

onMessage("addContextMenu", async ({ data }) => addContextMenu(data));

function removeContextMenu(id: string) {
  chrome.contextMenus?.remove(id).catch((e) => logBackgroundError(`Failed to remove context menu ${id}`, e));
  contextMenusClickEventBus.delete(id);
}

onMessage("removeContextMenu", async ({ data }) => removeContextMenu(data));

/**
 * 清除所有右键菜单。
 *
 * G2：必须等 `removeAll` 真正完成后再 create。旧实现不 await，而 `create` 紧跟其后：
 * 浏览器侧旧菜单项尚未删完时，同 id 的 create 会报 duplicate id（菜单项静默缺失/点击丢失的现实来源）。
 */
async function clearContextMenus(): Promise<void> {
  contextMenusClickEventBus.clear();
  const contextMenus = chrome.contextMenus;
  if (!contextMenus) {
    return;
  }

  await new Promise<void>((resolve) => {
    try {
      // 用 callback 形式兼容不支持 Promise 的实现（Firefox 的 chrome.* 命名空间）
      contextMenus.removeAll(() => {
        const error = chrome.runtime?.lastError;
        if (error) {
          logBackgroundError("Failed to clear context menus (removeAll)", error.message);
        }
        resolve();
      });
      // 兜底：极少数环境既不调用 callback 也不返回 Promise 时，不让后续重建永久挂起
      setTimeout(resolve, 0);
    } catch (e) {
      logBackgroundError("Failed to clear context menus", e);
      resolve();
    }
  });
}

onMessage("clearContextMenus", async () => clearContextMenus());

/**
 * 通知发送统一出口（N5）。
 *
 * `chrome.notifications.create` 在 MV3 返回 Promise：图标路径错误、系统禁用通知、参数非法都会 reject。
 * 旧实现直接调用（不 await 也不 catch），失败会变成 unhandled rejection 且用户/开发者都看不到原因
 * （链接推送「成功/失败」通知都可能根本不出现）。这里统一吞掉 rejection 并转进 logger 通道。
 */
export function showNotificationSafely(options: chrome.notifications.NotificationCreateOptions): void {
  try {
    const result = chrome.notifications?.create(options);
    if (result && typeof (result as Promise<string>).catch === "function") {
      void (result as Promise<string>).catch((e) => logBackgroundError("Failed to show notification", e));
    }
  } catch (e) {
    logBackgroundError("Failed to show notification", e);
  }
}

async function downloadLinkPush(
  link: string,
  downloader: IDownloaderMetadata,
  folder?: string,
  title?: string,
  url?: string,
) {
  // 从链接中提取站点信息，与 ContextMenuLinkPush.vue 保持一致
  const torrent: Partial<ITorrent> = {
    link,
    title,
    url,
  };

  // 尝试从 link 中解出site
  if (link.match(/https?:\/\/([^/]+)/)) {
    const host = getHostFromUrl(link);
    try {
      const siteHostMap = await getSiteHostMap();
      // 必须用 Object.hasOwn（见 A-3）：siteHostMap 是来自 storage 的普通对象，而 host 来自链接/标签页 URL，
      // 单标签 host（内网名、DNS 搜索后缀名，如 `http://constructor/`）会沿原型链解析到 Object.prototype 上的成员，
      // 得到一个「真值但不是 siteId」的值并流入站点实例创建路径。
      const matchedSite = Object.hasOwn(siteHostMap, host) ? siteHostMap[host] : undefined;
      if (matchedSite) {
        torrent.site = matchedSite;
      }
    } catch (error) {
      console.warn("[PTD] Failed to get metadata store for site detection:", error);
    }
  }

  // 发送下载请求
  sendMessage("downloadTorrent", {
    torrent, // 组装包含标题、URL和站点信息的种子对象
    downloaderId: downloader.id,
    allowSiteLessLink: true,
    addTorrentOptions: {
      addAtPaused: !(downloader?.feature?.DefaultAutoStart ?? true),
      savePath: folder!,
    } as CAddTorrentOptions,
  })
    .then((result) => {
      const messageName =
        result.downloadStatus === "failed"
          ? "notificationSendLinkToDownloaderFailure"
          : "notificationSendLinkToDownloaderSuccess";

      showNotificationSafely({
        type: "basic",
        iconUrl: chrome.runtime.getURL("icons/logo/128.png"),
        title: chrome.i18n.getMessage("extName"),
        message: chrome.i18n.getMessage(messageName, [downloader.name]),
      });
    })
    .catch(() => {
      showNotificationSafely({
        type: "basic",
        iconUrl: chrome.runtime.getURL("icons/logo/128.png"),
        title: chrome.i18n.getMessage("extName"),
        message: chrome.i18n.getMessage("notificationSendLinkToDownloaderFailure", [downloader.name]),
      });
    });
}

interface ICreateSearchMenuOption {
  thisTabSiteId?: string;
  // 这些属性会被展开合并进**已经带 title** 的菜单项，因此不应要求调用方再传 title
  // （@types/chrome 0.3.4 起 CreateProperties 变成联合类型，normal 变体要求 title 必填）。
  extraCreateMenuProperties?: Partial<chrome.contextMenus.CreateProperties>;
  selectionTextFilterFn?: (value?: chrome.contextMenus.OnClickData) => string;
}

async function createSearchMenu(baseMenuId: string, options: ICreateSearchMenuOption = {}) {
  const metadataStore =
    ((await getExtStorageCached("metadata")) as IMetadataPiniaStorageSchema | undefined) ??
    ({} as IMetadataPiniaStorageSchema);

  const {
    thisTabSiteId = null,
    selectionTextFilterFn = (a) => a?.selectionText ?? "",
    extraCreateMenuProperties = {},
  } = options;

  // 基本关键词搜索
  // A3：必须给**确定性 id**。旧实现对这一项不传 id，`addContextMenu` 每次构建都用 nanoid 生成新 id，
  // 而 SW 被回收后浏览器侧仍保留旧菜单；点击唤醒 SW 后 eventBus 是按新 id 重建的，旧 id 永远查不到，
  // 于是「右键 → 搜索 → 在默认方案中搜索」在 SW 回收后的第一次点击被静默丢弃。
  addContextMenu({
    id: `${baseMenuId}**Search-In-Default`,
    parentId: baseMenuId,
    title: chrome.i18n.getMessage("contextMenuSearchInDefault"),
    contexts: ["selection"],
    ...extraCreateMenuProperties,
    onclick: (info) => {
      openOptionsPage({
        path: "/search-entity",
        query: { search: selectionTextFilterFn(info), flush: 1 },
      });
    },
  });

  // 特定搜索方案搜索
  const solutions = Object.values(metadataStore.solutions ?? {})
    .filter((x) => !!x.enabled) // 过滤掉未启用的搜索方案
    .sort((a, b) => b.sort - a.sort); // 按照 sort 降序排序
  if (solutions.length > 0) {
    const solutionSearchSubMenuId = addContextMenu({
      id: `${baseMenuId}**Search-In-Solutions`,
      parentId: baseMenuId,
      title: chrome.i18n.getMessage("contextMenuSearchInSolution"),
      contexts: ["selection"],
      ...extraCreateMenuProperties,
    });

    for (const solution of solutions) {
      addContextMenu({
        id: `${solutionSearchSubMenuId}**${solution.id}`,
        parentId: solutionSearchSubMenuId,
        title: solution.name,
        contexts: ["selection"],
        ...extraCreateMenuProperties,
        onclick: (info) => {
          openOptionsPage({
            path: "/search-entity",
            query: { search: selectionTextFilterFn(info), plan: solution.id, flush: 1 },
          });
        },
      });
    }
  }

  // 特定站点搜索
  const sites = Object.entries(metadataStore.sites ?? {})
    .map(([siteId, site]) => ({
      id: siteId,
      ...site,
    }))
    .filter((x) => !x.isOffline && !!x.allowSearch)
    .sort((a, b) => (b.sortIndex ?? 0) - (a.sortIndex ?? 0));

  if (sites.length > 0) {
    const siteSearchSubMenuId = addContextMenu({
      id: `${baseMenuId}**Search-In-Site`,
      parentId: baseMenuId,
      title: chrome.i18n.getMessage("contextMenuSearchInSite"),
      contexts: ["selection"],
      ...extraCreateMenuProperties,
    });

    for (const site of sites) {
      if (site.id === thisTabSiteId) {
        continue; // 如果是当前站点，则不再添加到子菜单中
      }

      // 如果用户没有预构建站点名称，则使用站点ID作为标题
      const siteTitle = (await getSiteNameMap())[site.id] || site.id;

      addContextMenu({
        id: `${siteSearchSubMenuId}**${site.id}`,
        parentId: siteSearchSubMenuId,
        title: siteTitle,
        contexts: ["selection"],
        ...extraCreateMenuProperties,
        onclick: (info) => {
          openOptionsPage({
            path: "/search-entity",
            query: { search: selectionTextFilterFn(info), plan: `site:${site.id}`, flush: 1 },
          });
        },
      });
    }
  }

  if (thisTabSiteId) {
    addContextMenu({
      id: `${baseMenuId}**Search-In-This-Site`,
      parentId: baseMenuId,
      title: chrome.i18n.getMessage("contextMenuSearchInThisSite"),
      contexts: ["selection"],
      ...extraCreateMenuProperties,
      onclick: (info) => {
        openOptionsPage({
          path: "/search-entity",
          query: { search: info.selectionText, plan: `site:${thisTabSiteId}`, flush: 1 },
        });
      },
    });
  }
}

/** 上一次成功构建右键菜单时的「上下文摘要」：用于跳过无意义的重建（见 docs/performance-audit.md P1-7） */
let lastBuiltContextKey: string | null = null;
let buildChain: Promise<void> = Promise.resolve();

/**
 * G2：当前构建批次的 `contextMenus.create` 结果追踪。
 *
 * `create` 的失败只写 `chrome.runtime.lastError`（异步回调，不抛错），所以必须在构建结束前
 * 等所有 create 回调到齐，才能判断本次构建是否真的成功（决定是否提交 `lastBuiltContextKey`）。
 * buildChain 保证同一时刻只有一个构建，模块级单例即可。
 */
type TContextMenuCreateTracker = { failures: number; pending: Promise<void>[] };
let activeCreateTracker: TContextMenuCreateTracker | null = null;

/** create 失败后的重建重试（失败不提交 key；下次事件或短期重试会重建并重试失败项） */
const CONTEXT_MENU_BUILD_RETRY_DELAY = 1000;
const MAX_CONTEXT_MENU_BUILD_RETRIES = 3;
let pendingBuildRetry: ReturnType<typeof setTimeout> | null = null;
let consecutiveBuildFailures = 0;

function scheduleContextMenusBuildRetry(): void {
  if (consecutiveBuildFailures >= MAX_CONTEXT_MENU_BUILD_RETRIES) {
    logBackgroundError(
      `Context menu build failed ${consecutiveBuildFailures} times in a row, stop retrying until the next event`,
    );
    return;
  }
  consecutiveBuildFailures += 1;
  if (pendingBuildRetry !== null) {
    return;
  }
  const timer = setTimeout(() => {
    pendingBuildRetry = null;
    scheduleContextMenusBuild().catch((err) => logBackgroundError("Failed to retry context menu build", err));
  }, CONTEXT_MENU_BUILD_RETRY_DELAY);
  (timer as unknown as { unref?: () => void }).unref?.();
  pendingBuildRetry = timer;
}

async function initContextMenus(tab: chrome.tabs.Tab) {
  // 这里不处理 https://github.com/chenbin3625/chenbinPT/pull/470#discussion_r2295102201 提到的情况，因为会导致后面的type错误
  const tabHost = getHostFromUrl(tab.url || "https://example.com");
  const siteHostMap = await getSiteHostMap();
  // Object.hasOwn：单标签 host（如 `http://constructor/`）不得沿原型链取到 Object.prototype 上的成员（见 A-3）
  const thisTabSiteId = Object.hasOwn(siteHostMap, tabHost) ? siteHostMap[tabHost] : undefined;
  const siteNameMap = await getSiteNameMap();
  const thisTabSiteName = thisTabSiteId ? siteNameMap[thisTabSiteId] : undefined;

  const configStore =
    ((await getExtStorageCached("config")) as IConfigPiniaStorageSchema | undefined) ??
    ({} as IConfigPiniaStorageSchema);
  const metadataStore =
    ((await getExtStorageCached("metadata")) as IMetadataPiniaStorageSchema | undefined) ??
    ({} as IMetadataPiniaStorageSchema);

  // 菜单内容还取决于配置/下载器/搜索方案/站点列表，摘要必须包含它们（P1-7）：
  // 只比较「当前站点」会让只改配置的变更永远不重建菜单。
  const contextKey = buildContextMenusContextKey({
    tabHost,
    thisTabSiteId,
    thisTabSiteName,
    config: configStore,
    metadata: metadataStore,
    siteNameMap,
  });
  if (contextKey === lastBuiltContextKey) {
    return;
  }

  // 清除原来的菜单（G2：必须 await removeAll，否则 create 与 removeAll 竞态会 duplicate id）
  await clearContextMenus();

  // 如果配置中禁用右键菜单，则不进行任何操作
  if (configStore?.contextMenus?.enabled === false) {
    lastBuiltContextKey = contextKey;
    console.debug("[PTD] Context menus are disabled, skipping initialization.");
    return;
  }

  // G2：本批次 create 结果追踪；有失败项时不提交 lastBuiltContextKey，下次事件/重试会重建。
  const createTracker: TContextMenuCreateTracker = { failures: 0, pending: [] };
  activeCreateTracker = createTracker;
  try {
    // 创建关键字搜索菜单，所有页面可用
    if (configStore.contextMenus?.allowSelectionTextSearch ?? true) {
      // 创建基础菜单
      const baseSearchMenusId = addContextMenu({
        id: `${contextMenusId}**Search`,
        title: chrome.i18n.getMessage("contextMenuSearch"),
        contexts: ["selection"],
      });
      await createSearchMenu(baseSearchMenusId);
    }

    // 创建社交链接搜索菜，所有页面可用
    if (configStore.contextMenus?.allowSocialLinkSearch ?? true) {
      // 豆瓣链接
      const donbanMenuId = addContextMenu({
        id: `${contextMenusId}**SearchByDoubanLink`,
        title: chrome.i18n.getMessage("contextMenuSearchWithDouban"),
        contexts: ["link"],
        targetUrlPatterns: ["*://movie.douban.com/subject/*"],
      });
      await createSearchMenu(donbanMenuId, {
        extraCreateMenuProperties: {
          contexts: ["link"],
          targetUrlPatterns: ["*://movie.douban.com/subject/*"],
        },
        selectionTextFilterFn: (info) => {
          const failSearchText = info?.selectionText ?? "";
          if (info?.linkUrl) {
            const link = info.linkUrl.match(/subject\/(\d+)/);
            return link ? `douban|${link[1]}` : failSearchText;
          }
          return failSearchText;
        },
      });

      // IMDb 链接
      const imdbMenuId = addContextMenu({
        id: `${contextMenusId}**SearchByIMDbLink`,
        title: chrome.i18n.getMessage("contextMenuSearchWithIMDb"),
        contexts: ["link"],
        targetUrlPatterns: ["*://www.imdb.com/title/tt*"],
      });

      await createSearchMenu(imdbMenuId, {
        extraCreateMenuProperties: {
          contexts: ["link"],
          targetUrlPatterns: ["*://www.imdb.com/title/tt*"],
        },
        selectionTextFilterFn: (info) => {
          const failSearchText = info?.selectionText ?? "";
          if (info?.linkUrl) {
            const link = info.linkUrl.match(/(tt\d+)/);
            return link ? `imdb|${link[1]}` : failSearchText;
          }
          return failSearchText;
        },
      });
    }

    // 创建下载链接菜单，所有页面可用
    if (configStore.contextMenus?.allowLinkDownloadPush ?? true) {
      // 查找是否有可用的下载服务器
      // BACKGROUNDSHARED-4：站点排除（downloader.excludedSites）此前只在 options 聚合搜索页生效，
      // 站点页右键这个最常用入口完全忽略它。这里对齐 metadata store 的 getEnabledDownloadersBySite：
      // 仅在 config.download.allowDownloaderFilterForSite 打开时过滤（该开关默认关闭，关闭时排除列表本就不生效），
      // 且当前标签页不在任何站点时不过滤。
      const allowDownloaderFilterForSite = configStore.download?.allowDownloaderFilterForSite === true;
      const downloaders = Object.values(metadataStore.downloaders ?? {})
        .filter((x) => !!x.enabled)
        .filter(
          (x) => !allowDownloaderFilterForSite || !thisTabSiteId || !(x.excludedSites ?? []).includes(thisTabSiteId),
        )
        .sort((a, b) => (b.sortIndex ?? 100) - (a.sortIndex ?? 100));

      if (downloaders.length > 0) {
        // 创建基础菜单
        const baseLinkDownloadPushMenuId = addContextMenu({
          id: `${contextMenusId}**Link-Download-Push`,
          title: chrome.i18n.getMessage("contextMenuSendToDownloader"),
          contexts: ["link"],
        });

        // 跳转到 options 页面实现高级推送
        addContextMenu({
          id: `${baseLinkDownloadPushMenuId}**Link-Push`,
          parentId: baseLinkDownloadPushMenuId,
          title: chrome.i18n.getMessage("contextMenuSendToDownloaderAdvanced"),
          contexts: ["link"],
          onclick: (info) => {
            openOptionsPage({ path: "/link-push", query: { link: info.linkUrl! } });
          },
        });

        // 在 contextMenus 环境下，很多动态参数无法获取，因此要在生成的菜单栏中滤去
        const EXCLUDE_FOLDER_KEYWORDS = [
          "<...>", // chrome 在 service worker 环境下，无法使用 window.prompt 进行输入的文件夹
          "$search:", // 不存在search相关参数
          // 大概率也不可能存在下面和 torrent 相关的参数
          "$torrent.title$",
          "$torrent.subTitle$",
          "$torrent.category$",
        ];

        // 为每个下载器创建子菜单
        for (const downloader of downloaders) {
          const downloaderPushSubMenuId = addContextMenu({
            id: `${baseLinkDownloadPushMenuId}**${downloader.id}`,
            parentId: baseLinkDownloadPushMenuId,
            title: chrome.i18n.getMessage("contextMenuSendToDownloaderIn", [downloader.name, downloader.address]),
            contexts: ["link"],
            // 此处不用担心子目录问题，因为如果有子目录，此处的 onclick 不会被 chrome 触发
            onclick: (info, tab) => {
              downloadLinkPush(info.linkUrl!, downloader, undefined, tab?.title, tab?.url);
            },
          });

          let suggestFolders = (downloader.suggestFolders ?? []).filter(
            (f) => !EXCLUDE_FOLDER_KEYWORDS.some((keywords) => f.includes(keywords)),
          );

          // 展开建议目录里的 $…$ 变量（$torrent.site$ / $torrent.siteName$ / $date:*$）：当前标签页没有
          // 站点 / 站点名时，对应目录项直接不显示（右键菜单里没有 prompt() 可用，解析不了的变量只能整项丢掉）
          const siteReplaceMap: Record<string, string> = { ...datePathTemplateVars() };
          if (thisTabSiteId) {
            siteReplaceMap["torrent.site"] = thisTabSiteId;
          }
          if (thisTabSiteName) {
            siteReplaceMap["torrent.siteName"] = thisTabSiteName;
          }
          suggestFolders = suggestFolders
            .map((folder) => expandPathTemplate(folder, siteReplaceMap, { dropUnresolved: true }))
            .filter((folder): folder is string => folder !== null);

          // N3：变量替换后多个模板可能收敛成同一个最终目录；菜单 id 由最终目录派生，
          // 重复 id 会让 chrome.contextMenus.create 失败（只写 lastError），对应菜单项静默缺失。
          suggestFolders = [...new Set(suggestFolders)];

          if (suggestFolders.length > 0) {
            // 添加一个空字符串作为默认选项；用户配置里若本身就含空串，先滤掉避免生成重复菜单 id。
            suggestFolders = ["", ...suggestFolders.filter((folder) => folder !== "")];

            for (const suggestFolder of suggestFolders) {
              addContextMenu({
                id: `${downloaderPushSubMenuId}**${suggestFolder}`,
                parentId: downloaderPushSubMenuId,
                title: `-> ${suggestFolder || chrome.i18n.getMessage("contextMenuSendToDownloaderDefaultFolder")}`, // 如果是空字符串，则显示为 "默认文件夹"
                contexts: ["link"],
                onclick: (info, tab) => {
                  downloadLinkPush(info.linkUrl!, downloader, suggestFolder, tab?.title, tab?.url);
                },
              });
            }
          }
        }
      }
    }

    // 等所有 create 回调到齐（失败只写异步 lastError），才能判断本次构建是否真的成功
    await Promise.all(createTracker.pending);
  } finally {
    if (activeCreateTracker === createTracker) {
      activeCreateTracker = null;
    }
  }

  if (createTracker.failures > 0) {
    // G2：构建有失败项 → 不提交 key（否则失败项要等到上下文变化才会恢复），并安排一次短期重建重试。
    logBackgroundError(
      `Context menu build finished with ${createTracker.failures} create failure(s), will rebuild when possible`,
    );
    scheduleContextMenusBuildRetry();
    return;
  }

  // 构建成功后才记录 key：中途抛错（如 contextMenus API 失败）时保持 key 不变，
  // 下一次调度会重新构建，而不会把失败的构建当成成功永久跳过。
  consecutiveBuildFailures = 0;
  lastBuiltContextKey = contextKey;
}
/**
 * 统一入口：串行化构建、跳过重复构建。
 *
 * 另外在 SW 启动时主动按当前活动标签页构建一次：菜单的 onclick 回调保存在模块级 Map 中，
 * SW 被回收后 Map 会清空，而浏览器侧菜单仍然存在——若不重建，用户点击菜单会静默无反应
 * （见 docs/performance-audit.md P1-7）。
 */
function scheduleContextMenusBuild() {
  const task = buildChain.then(
    async () => {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (!tab) {
        return;
      }
      await initContextMenus(tab);
    },
    async () => {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (!tab) {
        return;
      }
      await initContextMenus(tab);
    },
  );
  buildChain = task.catch(() => undefined);
  return task;
}

if (chrome.contextMenus) {
  chrome.tabs.onActivated.addListener(() => {
    // 上下文摘要未变化时 initContextMenus 会直接返回，不产生重建开销
    scheduleContextMenusBuild().catch((err) => console.error("Failed to initialize context menus:", err));
  });

  /**
   * 同标签页内导航也要重建（见 L-2）。
   *
   * 早期实现只监听 `tabs.onActivated`：同一标签页从站点 A 跳到站点 B（含 SPA 的 pushState 导航）不会触发它，
   * 而 `lastBuiltContextKey` 只反映 A 的上下文 —— 摘要不变即直接 return，菜单与其点击回调继续持有 A 的
   * `thisTabSiteId`。于是「发送到下载器」的 `$torrent.site$` 会被替换成 A（文件落到 A 的目录），
   * 「在站点中搜索」也会指向 A。
   *
   * 只在 `changeInfo.url` 存在（URL 真的变了）时重建：onUpdated 在标题/图标/加载状态变化时都会触发，
   * 不加这个判断会让每次页面加载都全量重建一遍菜单。
   */
  chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
    if (!changeInfo.url) {
      return;
    }
    scheduleContextMenusBuild().catch((err) =>
      logBackgroundError("Failed to rebuild context menus on tab update", err),
    );
  });

  /**
   * M-16：切换窗口也要重建。两个窗口各停在站点 X / Y 时，`windows.update({ focused: true })` 只触发
   * `windows.onFocusChanged`，不触发 `tabs.onActivated`，菜单会继续按 X 构建（`$torrent.site$`、「在站点中搜索」都指向 X）。
   * 焦点移出浏览器时回调参数是 WINDOW_ID_NONE，此时不必重建。
   */
  chrome.windows?.onFocusChanged?.addListener((windowId) => {
    if (windowId === chrome.windows.WINDOW_ID_NONE) {
      return;
    }
    scheduleContextMenusBuild().catch((err) =>
      logBackgroundError("Failed to rebuild context menus on window focus change", err),
    );
  });

  // SW 冷启动后立即恢复菜单与点击回调
  scheduleContextMenusBuild().catch((err) => console.error("Failed to initialize context menus:", err));

  // 配置或站点元数据变化后重新生成菜单（做 1s 合并式防抖，避免批量写入时反复重建）
  const rebuildDebounce = createCoalescingDebounce(
    () => scheduleContextMenusBuild(),
    1000,
    (err) => console.error("Failed to initialize context menus:", err),
  );
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !(Object.hasOwn(changes, "config") || Object.hasOwn(changes, "metadata"))) {
      return;
    }
    // L-6：不再把 lastBuiltContextKey 置 null。上下文摘要已覆盖菜单依赖的全部输入（配置开关 / 方案 / 站点 /
    // 下载器 / 站点名），摘要不变就说明菜单不需要变；置 null 会让「每刷新一个站点的 lastUserInfo」
    // （同样写 metadata 这个顶层 key）都触发一次 removeAll + 全量重建。
    // 窗口内的后续变更会被合并；执行期间的新变更会在本轮结束后再跑一轮，保证最后一次变更一定生效
    rebuildDebounce.schedule();
  });
}
