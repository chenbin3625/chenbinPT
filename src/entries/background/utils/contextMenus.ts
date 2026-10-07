import { nanoid } from "nanoid";
import { format as dateFormat } from "date-fns";

import { type CAddTorrentOptions } from "@ptd/downloader/types.ts";
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

  chrome.contextMenus?.create(data);
  return data.id;
}

onMessage("addContextMenu", async ({ data }) => addContextMenu(data));

function removeContextMenu(id: string) {
  chrome.contextMenus?.remove(id).catch((e) => logBackgroundError(`Failed to remove context menu ${id}`, e));
  contextMenusClickEventBus.delete(id);
}

onMessage("removeContextMenu", async ({ data }) => removeContextMenu(data));

function clearContextMenus() {
  chrome.contextMenus?.removeAll().catch((e) => logBackgroundError("Failed to clear context menus", e));
  contextMenusClickEventBus.clear();
}

onMessage("clearContextMenus", async () => clearContextMenus());

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

      chrome.notifications.create({
        type: "basic",
        iconUrl: chrome.runtime.getURL("icons/logo/128.png"),
        title: chrome.i18n.getMessage("extName"),
        message: chrome.i18n.getMessage(messageName, [downloader.name]),
      });
    })
    .catch(() => {
      chrome.notifications.create({
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
  addContextMenu({
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

  // 清除原来的菜单
  clearContextMenus();

  // 如果配置中禁用右键菜单，则不进行任何操作
  if (configStore?.contextMenus?.enabled === false) {
    lastBuiltContextKey = contextKey;
    console.debug("[PTD] Context menus are disabled, skipping initialization.");
    return;
  }

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

        // 如果没有当前站点，则不显示 $torrent.site$
        if (thisTabSiteId) {
          suggestFolders = suggestFolders.map((f) => f.replace("$torrent.site$", thisTabSiteId));
        } else {
          suggestFolders = suggestFolders.filter((f) => !f.includes("$torrent.site$"));
        }

        // 如果没有当前站点名称，则不显示 $torrent.siteName$
        if (thisTabSiteName) {
          suggestFolders = suggestFolders.map((f) => f.replace("$torrent.siteName$", thisTabSiteName));
        } else {
          suggestFolders = suggestFolders.filter((f) => !f.includes("$torrent.siteName$"));
        }

        // 替换 $date:YYYY$ 等日期变量
        const nowDate = new Date();
        suggestFolders = suggestFolders.map((f) =>
          f
            .replace("$date:YYYY$", dateFormat(nowDate, "yyyy"))
            .replace("$date:MM$", dateFormat(nowDate, "MM"))
            .replace("$date:DD$", dateFormat(nowDate, "dd")),
        );

        if (suggestFolders.length > 0) {
          suggestFolders = ["", ...suggestFolders]; // 添加一个空字符串作为默认选项

          for (let suggestFolder of suggestFolders) {
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

  // 构建成功后才记录 key：中途抛错（如 contextMenus API 失败）时保持 key 不变，
  // 下一次调度会重新构建，而不会把失败的构建当成成功永久跳过。
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
