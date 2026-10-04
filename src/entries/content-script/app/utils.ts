import { computed, shallowRef, ref, toValue } from "vue";
import { uniq } from "es-toolkit";
import type { TSupportSocialSite } from "@ptd/social";
import { getSite as createSiteInstance, type ITorrent } from "@ptd/site";
import { getHostFromUrl, restoreSecureLink } from "@ptd/site/utils/html.ts";
import type BittorrentSite from "@ptd/site/schemas/AbstractBittorrentSite.ts";

import { sendMessage } from "@/messages.ts";
import { useRuntimeStore } from "@/options/stores/runtime.ts";
import { useMetadataStore } from "@/options/stores/metadata.ts";

import { confirmModal, promptModal } from "./modal.ts";
import SocialSitePage from "./pages/SocialSitePage.vue";
import SiteListPage from "./pages/SiteListPage.vue";
import SiteDetailPage from "./pages/SiteDetailPage.vue";
import { useConfigStore } from "@/options/stores/config.ts";

export const siteInstance = shallowRef<BittorrentSite>();

type TPageType = "unknown" | "social" | "list" | "detail";

export interface IPtdData {
  siteId?: string;
  socialSite?: TSupportSocialSite;
  [key: string]: any;
}

export const pageType = ref<TPageType>("unknown");
let pageTypeRequestId = 0;

export async function updatePageType(ptdData: IPtdData = {}) {
  const metadataStore = useMetadataStore();
  const requestId = ++pageTypeRequestId;

  pageType.value = "unknown"; // 重置为 unknown
  siteInstance.value = undefined;
  const url = location.href;

  if (ptdData.socialSite) {
    pageType.value = "social";
  } else if (ptdData.siteId) {
    const siteConfig = await metadataStore.getSiteUserConfig(ptdData.siteId);
    if (requestId !== pageTypeRequestId) return;
    siteInstance.value = await createSiteInstance(ptdData.siteId, siteConfig);
    if (requestId !== pageTypeRequestId) return;

    if (siteInstance.value) {
      const metadata = siteInstance.value.metadata;

      // 首先判断是否为 list 页面
      let listUrlPatterns = [];
      if (metadata.list && metadata.list.length > 0) {
        listUrlPatterns = metadata.list.flatMap((item) => item.urlPattern ?? []).filter(Boolean);
      } else {
        listUrlPatterns = uniq([
          ...(metadata.search?.requestConfig?.url ? [metadata.search.requestConfig.url] : []),
          ...(Object.values(metadata.searchEntry ?? {}).map((entry) => entry.requestConfig?.url) ?? []),
        ]).filter(Boolean);
      }

      const excludeListUrlPatterns =
        metadata.list?.flatMap((item) => item.excludeUrlPattern ?? []).filter(Boolean) ?? [];

      if (
        listUrlPatterns.some((pattern) => new RegExp(pattern!, "i").test(url)) &&
        !excludeListUrlPatterns.some((pattern) => new RegExp(pattern!, "i").test(url))
      ) {
        pageType.value = "list";
      } else {
        // 如果不是 list 页面，再判断是否为 detail 页面
        let detailUrlPatterns = metadata.detail?.urlPattern ?? [];

        if (detailUrlPatterns.some((pattern) => new RegExp(pattern, "i").test(url))) {
          pageType.value = "detail";
        }
      }
    }
  }
}

/**
 * 当前订阅了 URL 变化的回调。
 *
 * 多个订阅共享同一套 patch 与监听器：如果每次都自己包一层 `history` 补丁，后取消的那个会把
 * 先前补丁当成"原函数"还原（或被先取消的那个留在链上），卸载后仍会触发已经失效的回调。
 */
const urlChangeHandlers = new Set<() => void>();
let uninstallUrlChangeListener: (() => void) | undefined;

function dispatchUrlChange() {
  // 复制一份再遍历：回调里可能有新的订阅/取消订阅
  for (const handler of [...urlChangeHandlers]) handler();
}

/**
 * A-8：订阅「页面 URL 变化」。
 *
 * SPA 站点（Unit3D / Livewire 等）从列表页导航到详情页用的是 `history.pushState`，
 * 内容脚本不会重新执行，因此必须自己订阅：patch `pushState`/`replaceState`（这两个不会触发任何事件），
 * 外加 `popstate`/`hashchange`（浏览器前进后退、锚点跳转）。
 *
 * 返回取消订阅函数：组件卸载时必须调用，否则 URL 变化会继续触发已失效的回调。
 */
export function subscribeUrlChange(handler: () => void): () => void {
  urlChangeHandlers.add(handler);

  if (!uninstallUrlChangeListener) {
    const rawPushState = history.pushState;
    const rawReplaceState = history.replaceState;

    function patchedPushState(this: History, ...args: Parameters<History["pushState"]>) {
      rawPushState.apply(this, args);
      dispatchUrlChange();
    }

    function patchedReplaceState(this: History, ...args: Parameters<History["replaceState"]>) {
      rawReplaceState.apply(this, args);
      dispatchUrlChange();
    }

    history.pushState = patchedPushState;
    history.replaceState = patchedReplaceState;
    window.addEventListener("popstate", dispatchUrlChange);
    window.addEventListener("hashchange", dispatchUrlChange);

    uninstallUrlChangeListener = () => {
      // 只在补丁仍是自己装上去的时候还原：页面脚本/其它扩展可能在我们之后又包了一层，
      // 直接赋回原函数会把它们的补丁抹掉。
      if (history.pushState === patchedPushState) history.pushState = rawPushState;
      if (history.replaceState === patchedReplaceState) history.replaceState = rawReplaceState;
      window.removeEventListener("popstate", dispatchUrlChange);
      window.removeEventListener("hashchange", dispatchUrlChange);
    };
  }

  return () => {
    urlChangeHandlers.delete(handler);
    if (urlChangeHandlers.size === 0) {
      uninstallUrlChangeListener?.();
      uninstallUrlChangeListener = undefined;
    }
  };
}

/**
 * A-8：URL 变化后重新求值 `pageType` / 站点实例。
 *
 * 不做这一步的后果：列表页 → 详情页（pushState）后 pageType 仍是 "list"，
 * 「复制链接 / 本地下载 / 推送到下载器」会按列表页解析详情页（未解析到种子，或复制到上一页的链接）。
 *
 * 幂等：用「上一次求值的 URL」比对，`replaceState` 回写同址、同一 URL 的重复事件都不会重复求值；
 * `updatePageType` 内部另有请求序号守卫，处理并发求值的竞态。
 */
export function installPageTypeUrlWatcher(ptdData: IPtdData = {}): () => void {
  let lastHandledUrl = location.href;

  return subscribeUrlChange(() => {
    if (location.href === lastHandledUrl) return; // 幂等
    lastHandledUrl = location.href;

    // 求值失败不打断页面导航：URL 再变化时会重新求值，这里没有其它可用的诊断通道
    void updatePageType(ptdData).catch(() => {
      /* 忽略 */
    });
  });
}

/**
 * 需要二次确认时弹 shadow root 内的 antd Modal；`doubleConfirmAction` 关闭时不弹窗、直接放行。
 * （原来用的是浏览器原生对话框，样式与主题都与 overlay 脱节，见 audit §2.3。）
 */
export async function wrapperConfirmFn(fn: () => unknown, message = "确定要执行此操作吗？"): Promise<void> {
  const configStore = useConfigStore();

  if (!configStore.contentScript.doubleConfirmAction) {
    fn();
    return;
  }

  if (await confirmModal(message)) {
    fn();
  }
}

export async function doKeywordSearch(keywords: string, plan = "default"): Promise<void> {
  if (!keywords) {
    // 原来用的是浏览器原生输入框；取消（null）等价于空关键词，走下面的报错分支
    keywords = (await promptModal("未解析到搜索关键词，请输入：")) ?? "";
  }

  if (keywords) {
    // 打开选项页失败不应打断当前页面：显式给出拒绝处理（原来是裸 .catch()，派生 promise 仍会 unhandled）
    void sendMessage("openOptionsPage", {
      path: "/search-entity",
      query: { search: toValue(keywords), plan, flush: 1 },
    }).catch(() => {
      /* 忽略 */
    });
  } else {
    const runtimeStore = useRuntimeStore();
    runtimeStore.showSnakebar("搜索关键词不能为空", { color: "error" });
  }
}

export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (typeof text !== "string" || text.length === 0) {
    return false;
  }

  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (err) {
    // ignore and fallback
  }

  if (typeof document === "undefined") {
    return false;
  }

  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "true");
    textarea.style.position = "fixed";
    textarea.style.top = "-9999px";
    textarea.style.left = "-9999px";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const successful = document.execCommand("copy");
    document.body.removeChild(textarea);
    return successful;
  } catch (err) {
    return false;
  }
}

/**
 * S-2：拖拽与解析两条入口共用的链接可信性判定。
 *
 * 背景：扩展的 `host_permissions` 覆盖所有主机，因此「页面内容 → 扩展发起带凭据的跨站请求（绕过 CORS）」
 * 是一条真实的放大器。页面既可以在 `dragstart` 里伪造 `text/json+ptd` 载荷，也可以往下载列里
 * 塞任意 `<a href>`，所以凡是「拿链接去发请求」的地方都要过这道闸门。
 */

/** 只接受这三种协议；`javascript:` / `data:` / `file:` / `blob:` 等一律拒绝 */
const ALLOWED_TORRENT_LINK_PROTOCOLS = new Set(["http:", "https:", "magnet:"]);

/** 我们自己生成的拖拽载荷的 MIME（自定义类型优先级高于 uri-list/html/text） */
export const CUSTOM_DRAG_MIME = "text/json+ptd";

/** `text/plain` 拖拽内容里提取链接的正则 */
const SIMPLE_URL_REGEX = /https?:\/\/[^\s]+/g;

/**
 * host 归一化成可比较的形式：小写 + 去端口（端口不是安全边界，比较只关心主机名）。
 * IPv6 字面量是 `[::1]` 这种带方括号的形式，冒号在括号内，需要单独截断。
 */
function normalizeHost(host: string): string {
  const value = host.trim().toLowerCase();
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    return end === -1 ? value : value.slice(0, end + 1);
  }

  const colon = value.indexOf(":");
  return colon === -1 ? value : value.slice(0, colon);
}

/**
 * host 是否落在「站点已知 host」集合内。
 *
 * 除逐字相等外，还接受同一个站点域内的父子域关系（`cdn.pt.example.com` ↔ `pt.example.com`）：
 * 站点元数据通常只声明主域，而真实下载链接经常落在 CDN / 下载子域上，逐字相等会误伤真实场景。
 * 该放宽不会放过 `pt.example.com.evil.tld` 或 `evil-pt.example.com`（按 "." 做标签边界比较），
 * 也要求比较双方都至少有两段标签，避免把 `com` 当成任意站点的父域。
 */
export function isTrustedHost(host: string, trustedHosts: Iterable<string>): boolean {
  const target = normalizeHost(host);
  if (!target) return false;

  for (const rawHost of trustedHosts) {
    const trusted = normalizeHost(rawHost);
    if (!trusted) continue;
    if (target === trusted) return true;

    const sameDomain =
      target.includes(".") &&
      trusted.includes(".") &&
      (target.endsWith(`.${trusted}`) || trusted.endsWith(`.${target}`));
    if (sameDomain) return true;
  }

  return false;
}

/**
 * 单个链接是否可以交给扩展发起特权请求。
 *
 * - 缺失（`undefined`/`null`）或空串：没有可请求的地址。空串是 `fixLink` 拒绝危险 scheme、
 *   或选择器未命中时的标记，后续由站点层明确失败（`getTorrentDownloadLink` 会抛错），不是跨站请求；
 * - 纯相对链接（`download.php?id=1`）：只能由站点自身的 base 解析，同样不构成跨站请求；
 * - 协议相对链接（`//host/x`）会指向任意主机，必须拒绝；
 * - http(s) 且能解析出 host：host 必须落在站点已知 host 内；
 * - `magnet:` 没有 host，放行（它的来源站点由载荷里的其它字段决定，而我们已经强制改成当前站点）。
 */
export function isTrustedTorrentLink(link: unknown, trustedHosts: Iterable<string>): boolean {
  if (link === undefined || link === null) return true;
  if (typeof link !== "string") return false;

  const value = link.trim();
  if (value === "") return true;
  if (value.startsWith("//")) return false;

  const url = URL.parse(value);
  if (!url) return true; // 纯相对链接
  if (url.protocol === "magnet:") return true;
  if (!ALLOWED_TORRENT_LINK_PROTOCOLS.has(url.protocol)) return false;

  return isTrustedHost(url.hostname, trustedHosts);
}

/**
 * 一条种子记录里可能被请求的地址有两个，都要校验：
 * - `link`：下载请求真正会打到的地址（`downloadTorrent` 里的 `downloadRequestConfig.url`）；
 * - `url`：详情页地址；当 `link` 缺失且站点定义了 `detail.selectors.link` 时，
 *   `getTorrentDownloadLink` 会**带着扩展权限去抓这个地址**。
 */
export function isTrustedTorrent(torrent: ITorrent | undefined, trustedHosts: Iterable<string>): boolean {
  if (!torrent) return false;
  return isTrustedTorrentLink(torrent.link, trustedHosts) && isTrustedTorrentLink(torrent.url, trustedHosts);
}

/**
 * 收集「该站点已知的 host」。三个来源都是可信输入（站点定义 + 扩展自己维护的索引 + 当前页面），
 * 不含任何页面提供的内容：
 * 1. 站点定义的 `urls` / `legacyUrls`（可能被 rot13 编码，需先还原）；
 * 2. `metadata.siteHostMap` 中映射到本站点的 host（含用户在站点配置里自定义的地址与 `merge.urls`）；
 * 3. 当前页面自身（解析就发生在这一页）。
 *
 * 站点定义层的 host 体检结论（见代码审查报告 §7.9；该报告已移出仓库树，可在提交 3b066d59 中查阅）：341 个定义的 513 个 host 无跨站污染，
 * 因此这里不需要再去收集 `searchEntry` / `detail` 等 requestConfig 的 host。
 */
export async function getTrustedLinkHosts(siteId?: string): Promise<Set<string>> {
  const hosts = new Set<string>();
  const metadata = siteInstance.value?.metadata;

  for (const url of [...(metadata?.urls ?? []), ...(metadata?.legacyUrls ?? [])]) {
    hosts.add(getHostFromUrl(restoreSecureLink(url)));
  }

  if (siteId) {
    const metadataStore = useMetadataStore();
    for (const [host, mappedSiteId] of Object.entries(metadataStore.siteHostMap ?? {})) {
      if (mappedSiteId === siteId) hosts.add(host);
    }
  }

  if (location.host) hosts.add(location.host);

  return hosts;
}

/**
 * S-2：列表页解析结果里剔除不属于该站点的链接（页面可以往下载列塞任意 `<a href>`）。
 * 有剔除时给一条提示，而不是静默缩小列表让用户以为站点解析失败。
 */
export function sanitizeParsedTorrents(torrents: ITorrent[], trustedHosts: Iterable<string>): ITorrent[] {
  const allowed = torrents.filter((torrent) => isTrustedTorrent(torrent, trustedHosts));
  const rejectedCount = torrents.length - allowed.length;

  if (rejectedCount > 0) {
    useRuntimeStore().showSnakebar(`已忽略 ${rejectedCount} 条不属于本站点的下载链接`, { color: "warning" });
  }

  return allowed;
}

/**
 * S-2：详情页等单条解析结果的来源校验；不通过时给出提示并返回 false。
 */
export async function ensureTrustedTorrentLink(torrent: ITorrent | undefined, siteId?: string): Promise<boolean> {
  if (isTrustedTorrent(torrent, await getTrustedLinkHosts(siteId))) return true;

  useRuntimeStore().showSnakebar("解析出的下载链接不属于该站点，已拒绝", { color: "error" });
  return false;
}

/**
 * 从 URL 里尽力解析出种子 id（`?id=` / `?tid=` / 路径里的数字等）；
 * 解析不出来时返回空串，由下载器/下载历史自行处理。
 * 供 App.vue 生成拖拽载荷与 utils 内部校验载荷时共用。
 */
export function getIDFromURL(url?: URL | null): string {
  if (!url) return "";
  // 尝试从 searchParams 中提取 id
  for (const i of ["id", "tid", "torrent_id", "torrentId", "hash", "hash_id"]) {
    if (url.searchParams.has(i)) {
      return url.searchParams.get(i) || "";
    }
  }
  // 如果无法从 searchParams 中解出 id，则尝试从 pathname 中提取 id
  if (url.pathname) {
    for (const pathnameMatcher of [/\/(\d+)(?:\/|$)/]) {
      const match = url.pathname.match(pathnameMatcher);
      if (match) {
        return match[1] || "";
      }
    }
  }
  return "";
}

/**
 * 从非自定义 MIME 的拖拽内容里尽力提取链接（原 App.vue 内的实现，逻辑未变）。
 * 这里已经做过一次协议过滤，`resolveDroppedTorrents` 会再统一校验一次。
 */
function extractLinksManually(dataTransfer: DataTransfer): string[] {
  // prefer types: uri-list > html > text
  // ref: [MDN - Recommended_drag_types](https://developer.mozilla.org/en-US/docs/Web/API/HTML_Drag_and_Drop_API/Recommended_drag_types#dragging_links)
  if (Array.from(dataTransfer.types).includes("text/uri-list")) {
    const uriList = dataTransfer.getData("text/uri-list");
    if (uriList) {
      return uriList
        .split("\r\n")
        .map((line) => line.trim())
        .filter((uri) => !uri.startsWith("#") && uri.startsWith("http"));
    }
  }
  /**
   * 可以很好的适配<p><a href="...">...</a></p>这种情况
   * TODO: 但是面对选了一大片html的时候，可能会解析出来很多不是下载的链接，是否需要给每个站点/框架定义下载链接的正则表达式？
   * 比如简单的过滤 nexusphp => /passkey=[a-zA-Z0-9-]+/
   */
  if (dataTransfer.types.includes("text/html")) {
    const textData = dataTransfer.getData("text/html");
    if (textData) {
      const parser = new DOMParser();
      const doc = parser.parseFromString(textData, "text/html");
      const links = Array.from(doc.querySelectorAll("a[href]")).map((a) => (a as HTMLAnchorElement).href);
      return links.filter((link) => link.startsWith("http") || link.startsWith("magnet:"));
    }
  }
  // fallback to plain text extraction
  if (dataTransfer.types.includes("text/plain")) {
    const textData = dataTransfer.getData("text/plain");
    if (textData) {
      return Array.from(
        textData
          .matchAll(SIMPLE_URL_REGEX)
          .map((matched) => matched[0])
          .filter((url) => URL.canParse(url)),
      );
    }
  }
  return [];
}

export interface IDropResolution {
  /** 通过校验、可以交给下载/推送流程的种子 */
  torrents: ITorrent[];
  /** 被形状或协议校验拒绝的条目数 */
  rejectedCount: number;
  /** 自定义 MIME 载荷整体不可用（不是合法 JSON，或不是数组） */
  payloadInvalid: boolean;
}

/**
 * S-2：校验自定义拖拽载荷里的单个条目。
 *
 * 只接受 `{ link: string }`（`title` 仅用于展示，缺省为空串）。`site` / `id` 一律忽略并由扩展自己决定：
 * - `site` 决定「该站点用哪个下载器配置 / 下载间隔」，由页面决定等于绕过用户对这些设置的约束；
 * - `id` 是扩展级身份（下载历史的 `uniqueId`），由 `link` 反推即可，页面给的不可信。
 */
function toTrustedTorrent(item: unknown, siteId: string): ITorrent | undefined {
  if (typeof item !== "object" || item === null || Array.isArray(item)) return undefined;

  const link = (item as { link?: unknown }).link;
  if (typeof link !== "string") return undefined;

  const url = URL.parse(link);
  if (!url || !ALLOWED_TORRENT_LINK_PROTOCOLS.has(url.protocol)) return undefined;

  const title = (item as { title?: unknown }).title;
  return { link, site: siteId, title: typeof title === "string" ? title : "", id: getIDFromURL(url) };
}

/**
 * S-2：解析 `text/json+ptd` 拖拽载荷。
 * 必须是数组，每个元素必须是对象，且 `link` 必须通过协议白名单——任意一项不满足即拒绝该项。
 */
export function parseCustomDragPayload(rawPayload: string, siteId = ""): IDropResolution {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawPayload);
  } catch {
    return { torrents: [], rejectedCount: 0, payloadInvalid: true };
  }

  if (!Array.isArray(parsed)) return { torrents: [], rejectedCount: 0, payloadInvalid: true };

  const torrents: ITorrent[] = [];
  let rejectedCount = 0;

  for (const item of parsed) {
    const torrent = toTrustedTorrent(item, siteId);
    if (torrent) {
      torrents.push(torrent);
    } else {
      rejectedCount += 1;
    }
  }

  return { torrents, rejectedCount, payloadInvalid: false };
}

/**
 * 非自定义 MIME 的拖拽内容：逐条提取链接 + 协议白名单。
 */
function parseManualDropPayload(dataTransfer: DataTransfer, siteId: string): IDropResolution {
  const torrents: ITorrent[] = [];
  let rejectedCount = 0;

  for (const link of extractLinksManually(dataTransfer)) {
    const url = URL.parse(link);
    if (!url || !ALLOWED_TORRENT_LINK_PROTOCOLS.has(url.protocol)) {
      rejectedCount += 1;
      continue;
    }

    torrents.push({ link, title: "", site: siteId, id: getIDFromURL(url) });
  }

  return { torrents, rejectedCount, payloadInvalid: false };
}

/**
 * 把 drop 事件的数据解析成可信种子列表；校验失败时给出可诊断的提示
 * （静默丢弃只会让用户以为拖拽失灵）。
 */
export function resolveDroppedTorrents(dataTransfer: DataTransfer | null, siteId = ""): IDropResolution {
  if (!dataTransfer) return { torrents: [], rejectedCount: 0, payloadInvalid: false };

  // perfer types: custom > manual
  const result = Array.from(dataTransfer.types).includes(CUSTOM_DRAG_MIME)
    ? parseCustomDragPayload(dataTransfer.getData(CUSTOM_DRAG_MIME), siteId)
    : parseManualDropPayload(dataTransfer, siteId);

  if (result.torrents.length === 0) {
    const runtimeStore = useRuntimeStore();
    if (result.payloadInvalid) {
      runtimeStore.showSnakebar("拖拽内容不是有效的种子数据，已忽略", { color: "error" });
    } else if (result.rejectedCount > 0) {
      runtimeStore.showSnakebar("拖拽内容里的链接不受支持（仅支持 http/https/magnet），已忽略", { color: "error" });
    }
  }

  return result;
}

/**
 * 使用 动态组件 的方式来为 content-script 实现一个简单的路由系统
 *
 * refs: https://cn.vuejs.org/guide/scaling-up/routing.html#simple-routing-from-scratch
 */
const routes: Record<TPageType, any> = {
  unknown: "div",
  social: SocialSitePage,
  list: SiteListPage,
  detail: SiteDetailPage,
};

export const currentView = computed(() => {
  return routes[pageType.value ?? "unknown"];
});
