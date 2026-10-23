import { computed, shallowRef, ref, toValue } from "vue";
import type { TSupportSocialSite } from "@ptd/social";
import { getSite as createSiteInstance, type ISiteMetadata, type ITorrent } from "@ptd/site";
import { getHostFromUrl, restoreSecureLink } from "@ptd/site/utils/html.ts";
import type BittorrentSite from "@ptd/site/schemas/AbstractBittorrentSite.ts";

import { sendMessage } from "@/messages.ts";
import { i18n } from "@/options/plugins/i18n.ts";
import { useRuntimeStore } from "@/options/stores/runtime.ts";
import { useMetadataStore } from "@/options/stores/metadata.ts";

import { confirmModal, promptModal } from "./modal.ts";
import SocialSitePage from "./pages/SocialSitePage.vue";
import SiteListPage from "./pages/SiteListPage.vue";
import SiteDetailPage from "./pages/SiteDetailPage.vue";
import { useConfigStore } from "@/options/stores/config.ts";

export const siteInstance = shallowRef<BittorrentSite>();
let clipboardFallbackContainer: HTMLElement | undefined;

/**
 * L4：创建 / 复用 `siteInstance` 时对应的站点用户配置快照。
 * options 侧修改站点配置（URL / merge / 搜索入口）后，同一 SPA 页面内的复用实例必须失效重建。
 */
let siteInstanceConfigSnapshot: string | undefined;

function snapshotSiteUserConfig(config: unknown): string {
  try {
    return JSON.stringify(config ?? {});
  } catch {
    // 配置里出现不可序列化值（理论上不会有）：退化为「总是认为变了」，宁可多重建一次
    return String(Math.random());
  }
}

export function setClipboardFallbackContainer(container?: HTMLElement): void {
  clipboardFallbackContainer = container;
}

type TPageType = "unknown" | "social" | "list" | "detail";

export interface IPtdData {
  siteId?: string;
  socialSite?: TSupportSocialSite;
  [key: string]: any;
}

export const pageType = ref<TPageType>("unknown");
let pageTypeRequestId = 0;

/** 尝试解析 URL；失败返回 undefined（不抛错） */
function tryParseUrl(value: string, base?: string): URL | undefined {
  try {
    return base === undefined ? new URL(value) : new URL(value, base);
  } catch {
    return undefined;
  }
}

/**
 * 安全地测试站点定义里的 URL 模式。
 *
 * `TPattern` 允许 string 与 RegExp 两种形态：
 * - 字符串按旧语义 `new RegExp(pattern, "i")` 编译；
 * - RegExp 对象保留自身的 `m`/`s`/`u` 等 flags，但**缺少 `i` 时补上**（K / REVIEW-FINDINGS）。
 *   旧实现是 `new RegExp(regexp, "i")`：`i` 始终存在、其它 flags 被抹掉；本轮 CS-1 一度改成
 *   「完全保留自身 flags」，于是 `myanonamouse` 等定义为小写、实际 URL 大小写混用的站点会漏判。
 *   这里取两者兼容：`i` 一定生效，其它 flags 不再被抹掉。
 * 非法正则一律视为「不匹配」而不是抛错 —— 站点定义或用户自定义地址里一个笔误不应该让整个面板
 * （list/detail 都不识别）失效。
 */
export function testUrlPattern(pattern: unknown, url: string): boolean {
  if (typeof pattern === "string") {
    if (pattern === "") return false;
    try {
      return new RegExp(pattern, "i").test(url);
    } catch {
      return false;
    }
  }
  if (pattern instanceof RegExp) {
    try {
      const flags = pattern.flags.includes("i") ? pattern.flags : `${pattern.flags}i`;
      return new RegExp(pattern.source, flags).test(url);
    } catch {
      return false;
    }
  }
  return false;
}

/** pathname 归一化：去掉末尾多余 `/`，根路径保留 `"/"` */
function normalizePathname(pathname: string): string {
  if (!pathname || pathname === "/") return "/";
  return pathname.replace(/\/+$/, "") || "/";
}

/**
 * CS-1：没有声明 `metadata.list` 的站点，`search.requestConfig.url` / `searchEntry[*].requestConfig.url`
 * 是**路径**（`/`、`/torrents.php`、`/api/torrents`、`/user/$id$`…），不是正则。
 *
 * 旧实现直接 `new RegExp(url, "i").test(location.href)`：`/` 能命中任何页面，URL 里的 `.`、`?`、`$`
 * 也被当成元字符。这里改为：把配置里的 url 解析成（同源的）绝对地址后只比较 **pathname**：
 * - 精确匹配；非根路径同时允许目录前缀匹配（`/browse`、`/browse/` 都能命中 `/browse/2`，L7）；
 * - 根路径 `/` 只匹配首页，不再「匹配一切」；
 * - 跨 host 的 API 地址（如 `https://api.x/api/torrents`）不是页面路径，直接跳过。
 */
function isInferredListPage(patterns: unknown[], pageUrl: string): boolean {
  const page = tryParseUrl(pageUrl);
  if (!page) return false;
  const pagePath = normalizePathname(page.pathname);

  for (const pattern of patterns) {
    if (typeof pattern !== "string" || pattern === "") continue;

    const target = tryParseUrl(pattern, page.origin);
    if (!target || (target.protocol !== "http:" && target.protocol !== "https:")) continue;
    if (!isTrustedHost(target.host, [page.host]) && !isTrustedHost(page.host, [target.host])) continue;

    const targetPath = normalizePathname(target.pathname);
    if (targetPath === pagePath) return true;
    // L7（CS-1 复检）：推断型 url 的非根路径一律视为「目录前缀」——分页形态为路径段的站点
    // （`/browse` → 第 2 页 `/browse/2`）不再从第 2 页起被判成 unknown。
    // 根路径 `/` 仍只匹配首页（否则会命中所有页面）；detail 判定已在 detectPageType 里先执行。
    if (targetPath !== "/" && pagePath.startsWith(`${targetPath}/`)) {
      return true;
    }
  }

  return false;
}

/**
 * 根据站点 metadata 与当前 URL 判定页面类型（纯函数，便于单测与复用）。
 *
 * 判定顺序（CS-1）：
 * 1. 站点**显式声明**的 `metadata.list[].urlPattern` 优先（可用 `excludeUrlPattern` 排除误判）；
 * 2. 再判 `metadata.detail.urlPattern`；
 * 3. 仅当站点完全没有 `list` 声明时，才使用「把 search/searchEntry 的 url 当列表页路径」的推断。
 *    推断型 list 放在 detail 之后：`learnflakes` 这类站点的搜索 url 是 `/`（pathname 为根），
 *    若 list 优先，详情页会被永远判成列表页。
 */
export function detectPageType(metadata: ISiteMetadata | undefined, url: string): TPageType {
  if (!metadata) return "unknown";

  const listItems = metadata.list ?? [];
  const explicitListPatterns = listItems.flatMap((item) => item.urlPattern ?? []).filter(Boolean);
  const excludeListPatterns = listItems.flatMap((item) => item.excludeUrlPattern ?? []).filter(Boolean);
  const detailPatterns = metadata.detail?.urlPattern ?? [];

  if (explicitListPatterns.length > 0) {
    const matchedList = explicitListPatterns.some((pattern) => testUrlPattern(pattern, url));
    const excluded = excludeListPatterns.some((pattern) => testUrlPattern(pattern, url));
    if (matchedList && !excluded) return "list";
  }

  if (detailPatterns.some((pattern) => testUrlPattern(pattern, url))) return "detail";

  // 声明了 list 但没有写 urlPattern 的站点（如 audiobookbay）保持旧语义：不猜测列表页。
  if (listItems.length === 0) {
    const inferredPatterns = [
      metadata.search?.requestConfig?.url,
      ...Object.values(metadata.searchEntry ?? {}).map((entry) => entry.requestConfig?.url),
    ].filter(Boolean) as string[];
    if (isInferredListPage(inferredPatterns, url)) return "list";
  }

  return "unknown";
}

/** 当前站点实例的基址；相对链接的「真实解析结果」依赖它（见 isTrustedTorrentLink 的 B2-6 说明） */
export function getCurrentSiteBaseUrl(): string | undefined {
  try {
    const url = siteInstance.value?.url as unknown;
    return typeof url === "string" && url !== "" ? url : undefined;
  } catch {
    return undefined;
  }
}

export async function updatePageType(ptdData: IPtdData = {}) {
  const requestId = ++pageTypeRequestId;

  if (ptdData.socialSite) {
    siteInstance.value = undefined;
    pageType.value = "social";
    return;
  }

  if (!ptdData.siteId) {
    siteInstance.value = undefined;
    pageType.value = "unknown";
    return;
  }

  // CS-2：URL 变化（SPA 列表↔详情）重新求值时复用已创建的站点实例，避免每次都动态 import
  // 站点定义 + clone metadata；只有站点变了才重建。
  //
  // L4（复检）：只比较 siteId 不够 —— 用户在 options 里改了站点 URL / merge / 搜索入口后回到
  // 同一 SPA 页面，复用旧实例会一直用旧配置（直到整页刷新）。这里把创建实例时的用户配置快照
  // 与当前配置比对，变化即视为「站点配置变了」并重建实例。
  let instance = siteInstance.value;
  const needsNewInstance = !instance || instance.metadata?.id !== ptdData.siteId;
  if (needsNewInstance) {
    const metadataStore = useMetadataStore();
    pageType.value = "unknown"; // 站点实例重建期间先不要按旧类型渲染动作
    siteInstance.value = undefined;

    const siteConfig = await metadataStore.getSiteUserConfig(ptdData.siteId);
    if (requestId !== pageTypeRequestId) return;
    instance = await createSiteInstance(ptdData.siteId, siteConfig);
    // Info 4：先校验再赋值。旧实现先写入再检查，过期请求晚 resolve 时会覆盖新实例。
    if (requestId !== pageTypeRequestId) return;
    siteInstance.value = instance;
    siteInstanceConfigSnapshot = snapshotSiteUserConfig(siteConfig);
  } else {
    // 复用时检查配置是否在 options 侧被改过（getSiteUserConfig 读的是内存 pinia state，开销可忽略）
    const metadataStore = useMetadataStore();
    const siteConfig = await metadataStore.getSiteUserConfig(ptdData.siteId);
    if (requestId !== pageTypeRequestId) return;
    if (snapshotSiteUserConfig(siteConfig) !== siteInstanceConfigSnapshot) {
      pageType.value = "unknown";
      siteInstance.value = undefined;
      instance = await createSiteInstance(ptdData.siteId, siteConfig);
      if (requestId !== pageTypeRequestId) return;
      siteInstance.value = instance;
      siteInstanceConfigSnapshot = snapshotSiteUserConfig(siteConfig);
    }
  }

  if (requestId !== pageTypeRequestId) return;
  if (!instance) {
    pageType.value = "unknown";
    return;
  }

  pageType.value = detectPageType(instance.metadata, location.href);
}

/**
 * 当前订阅了 URL 变化的回调。
 *
 * 多个订阅共享同一套 patch 与监听器：如果每次都自己包一层 `history` 补丁，后取消的那个会把
 * 先前补丁当成"原函数"还原（或被先取消的那个留在链上），卸载后仍会触发已经失效的回调。
 */
const urlChangeHandlers = new Set<() => void>();
/** 不支持 Navigation API 时轮询 location.href 的间隔（见 subscribeUrlChange 的 H-3 说明） */
export const URL_POLL_INTERVAL = 500;
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

    // H-3：上面的 history 补丁只对「与内容脚本同一 JS world 的调用方」生效。真实浏览器里内容脚本跑在
    // 隔离世界（Chrome isolated world / Firefox Xray），页面自己的 pushState 走的是页面 world 的
    // History 对象，根本不经过这层补丁 —— 而 SPA 站点（Unit3D/Livewire）的列表→详情正是页面在调用。
    // 跨 world 能观察到的只有：DOM 事件（popstate/hashchange，已订阅）与 URL 本身。
    // 因此再加跨 world 通路：Navigation API 的 currententrychange（浏览器派发的 DOM 事件，页面 world 的
    // pushState 也会触发，延迟最低）+ 轮询 location.href（只比较字符串，成本可忽略）。
    let lastSeenHref = location.href;
    const checkHrefChanged = () => {
      if (location.href === lastSeenHref) return;
      lastSeenHref = location.href;
      dispatchUrlChange();
    };
    // 轮询始终保留作兜底（Firefox 旧版本无 Navigation API；两条通路共用 lastSeenHref 去重，不会重复派发）。
    const navigationApi = (window as Window & { navigation?: EventTarget }).navigation;
    const hasNavigationApi = !!navigationApi && typeof navigationApi.addEventListener === "function";
    if (hasNavigationApi) navigationApi.addEventListener("currententrychange", checkHrefChanged);
    const pollTimer = setInterval(checkHrefChanged, URL_POLL_INTERVAL);
    const stopCrossWorldWatch = () => {
      clearInterval(pollTimer);
      if (hasNavigationApi) navigationApi.removeEventListener("currententrychange", checkHrefChanged);
    };

    uninstallUrlChangeListener = () => {
      stopCrossWorldWatch();
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
 * 幂等：用「上一次看到过的 URL」比对，`replaceState` 回写同址、同一 URL 的重复事件都不会重复求值；
 * `updatePageType` 内部另有请求序号守卫，处理并发求值的竞态。
 *
 * CS-2：可选 `isActive` 门控 —— 悬浮菜单收起时不求值（仍推进幂等游标），由调用方在展开时
 * 用当前 URL 求值一次。
 */
export interface IInstallPageTypeUrlWatcherOptions {
  /**
   * 是否处于「需要求值」的状态（例如悬浮菜单已展开）。
   * 返回 false 时跳过本次求值；调用方在展开时用当前 URL 求值一次即可（CS-2）。
   */
  isActive?: () => boolean;
}

export function installPageTypeUrlWatcher(
  ptdData: IPtdData = {},
  options: IInstallPageTypeUrlWatcherOptions = {},
): () => void {
  // 「已看到过」的 URL 用于幂等（replaceState 同址回写、多条通路重复派发）。
  // 注意：收起来时也要推进它 —— 否则「A →（收起）B → 收起）A」会让 A 被当成已求值。
  let lastSeenUrl = location.href;

  return subscribeUrlChange(() => {
    const currentUrl = location.href;
    if (currentUrl === lastSeenUrl) return; // 幂等
    lastSeenUrl = currentUrl;

    // CS-2：菜单收起时不求值（避免同一页面行为取决于是否发生过 pushState、也避免每次 SPA
    // 跳转都白建一次站点实例）。展开时由 App.vue 的点击处理用**当前** URL 求值一次。
    if (options.isActive && !options.isActive()) return;

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
export async function wrapperConfirmFn(
  fn: () => unknown,
  message = i18n.t("contentScript.confirmAction"),
): Promise<void> {
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
    keywords = (await promptModal(i18n.t("contentScript.inputSearchKeywords"))) ?? "";
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
    runtimeStore.showSnakebar(i18n.t("contentScript.emptySearchKeyword"), { color: "error" });
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

  if (typeof document === "undefined" || !clipboardFallbackContainer?.isConnected) {
    return false;
  }

  const textarea = document.createElement("textarea");
  try {
    textarea.value = text;
    textarea.setAttribute("readonly", "true");
    textarea.style.position = "fixed";
    textarea.style.top = "-9999px";
    textarea.style.left = "-9999px";
    clipboardFallbackContainer.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const successful = document.execCommand("copy");
    return successful;
  } catch (err) {
    return false;
  } finally {
    textarea.remove();
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
  const canonicalTarget = target.startsWith("www.") ? target.slice(4) : target;

  for (const rawHost of trustedHosts) {
    const trusted = normalizeHost(rawHost);
    if (!trusted) continue;
    const canonicalTrusted = trusted.startsWith("www.") ? trusted.slice(4) : trusted;
    if (canonicalTarget === canonicalTrusted) return true;

    const sameDomain =
      canonicalTarget.includes(".") &&
      canonicalTrusted.includes(".") &&
      canonicalTarget.endsWith(`.${canonicalTrusted}`);
    if (sameDomain) return true;
  }

  return false;
}

/**
 * 单个链接是否可以交给扩展发起特权请求。
 *
 * - 缺失（`undefined`/`null`）或空串：没有可请求的地址。空串是 `fixLink` 拒绝危险 scheme、
 *   或选择器未命中时的标记，后续由站点层明确失败（`getTorrentDownloadLink` 会抛错），不是跨站请求；
 * - 相对链接（`download.php?id=1`、`/dl/1`）：会被站点层用**站点基址**解析成绝对地址，
 *   因此这里也必须按同一语义解析后再校验 host（B2-6）。`URL.parse()` 返回 null **不等于**安全：
 *   `///evil.tld/x`、`/\evil.tld/x`、`\\evil.tld/x` 这类串在 `new URL(value, siteBase)` 下都会
 *   解析到别的 host。没有站点基址（实例未就绪）时无法判断，保守拒绝；
 * - http(s)：host 必须落在站点已知 host 内；
 * - `magnet:` 没有 host，放行（它的来源站点由载荷里的其它字段决定，而我们已经强制改成当前站点）。
 */
export function isTrustedTorrentLink(
  link: unknown,
  trustedHosts: Iterable<string>,
  baseUrl: string | undefined = getCurrentSiteBaseUrl(),
): boolean {
  if (link === undefined || link === null) return true;
  if (typeof link !== "string") return false;

  const value = link.trim();
  if (value === "") return true;
  if (value.startsWith("magnet:")) return true;

  let url = URL.parse(value);
  if (!url) {
    if (!baseUrl) return false; // 没有基址时无法确定相对链接会落到哪个 host
    url = tryParseUrl(value, baseUrl) ?? null;
    if (!url) return false;
  }

  if (url.protocol === "magnet:") return true;
  if (!ALLOWED_TORRENT_LINK_PROTOCOLS.has(url.protocol)) return false;

  return isTrustedHost(url.hostname, trustedHosts);
}

/**
 * 一条种子记录里可能被请求的地址有两个，都要校验：
 * - `link`：下载请求真正会打到的地址（`downloadTorrent` 里的 `downloadRequestConfig.url`）；
 * - `url`：详情页地址；当 `link` 缺失且站点定义了 `detail.selectors.link` 时，
 *   `getTorrentDownloadLink` 会**带着扩展权限去抓这个地址**。
 *
 * `baseUrl` 是相对链接的解析基址（默认取当前站点实例的 url），见 `isTrustedTorrentLink`。
 */
export function isTrustedTorrent(
  torrent: ITorrent | undefined,
  trustedHosts: Iterable<string>,
  baseUrl: string | undefined = getCurrentSiteBaseUrl(),
): boolean {
  if (!torrent) return false;
  return (
    isTrustedTorrentLink(torrent.link, trustedHosts, baseUrl) &&
    isTrustedTorrentLink(torrent.url, trustedHosts, baseUrl)
  );
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
  let metadata = siteInstance.value?.metadata;
  if (!metadata && siteId) {
    // B（REVIEW-FINDINGS P1-12）：菜单从未展开时 siteInstance 尚未创建。这里**带上用户配置**
    // 创建实例（用户自定义 URL / merge 才会出现在 metadata.urls 里，legacy / 兄弟域名链接的
    // host 校验依赖它），并在成功后回填 siteInstance，后续页面类型判定直接复用。
    try {
      const metadataStore = useMetadataStore();
      // 直接读内存里的站点配置：getSiteUserConfig 在 sites 为空时会走后台消息（一次性成本高、
      // 且在消息通道不可用的宿主里会挂起），这里只需要「已水合的用户配置」用于 host 校验。
      const siteConfig = (metadataStore.sites?.[siteId] ?? {}) as Record<string, unknown>;
      const site = await createSiteInstance(siteId, siteConfig);
      metadata = site?.metadata;
      if (site && !siteInstance.value) {
        siteInstance.value = site;
        siteInstanceConfigSnapshot = snapshotSiteUserConfig(siteConfig);
      }
    } catch {
      // 站点定义不可用时退回 siteHostMap + 当前 host 的兜底（不阻塞拖拽投放）
    }
  }

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
    useRuntimeStore().showSnakebar(i18n.t("contentScript.ignoredForeignLinks", { count: rejectedCount }), {
      color: "warning",
    });
  }

  return allowed;
}

/**
 * S-2：详情页等单条解析结果的来源校验；不通过时给出提示并返回 false。
 */
export async function ensureTrustedTorrentLink(torrent: ITorrent | undefined, siteId?: string): Promise<boolean> {
  if (isTrustedTorrent(torrent, await getTrustedLinkHosts(siteId))) return true;

  useRuntimeStore().showSnakebar(i18n.t("contentScript.untrustedTorrentLink"), { color: "error" });
  return false;
}

/**
 * 从 URL 里尽力解析出种子 id（`?id=` / `?tid=` / 路径里的数字等）；
 * 解析不出来时返回空串，由下载器/下载历史自行处理。
 * 供 App.vue 生成拖拽载荷与 utils 内部校验载荷时共用。
 */
export function getIDFromURL(url?: URL | null): string {
  if (!url) return "";
  // 尝试从 searchParams 中提取 id。参数存在但值为空（`?id=&tid=5`）时继续看下一个，
  // 旧实现会直接返回空串、不再尝试 `tid`（Info 7）。
  for (const i of ["id", "tid", "torrent_id", "torrentId", "hash", "hash_id"]) {
    const value = url.searchParams.get(i);
    if (value) return value;
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

function filterDroppedTorrentsByTrustedHosts(
  result: IDropResolution,
  trustedHosts?: Iterable<string>,
): IDropResolution {
  if (!trustedHosts || result.torrents.length === 0) {
    return result;
  }

  const torrents = result.torrents.filter((torrent) => isTrustedTorrent(torrent, trustedHosts));
  return {
    ...result,
    torrents,
    rejectedCount: result.rejectedCount + (result.torrents.length - torrents.length),
  };
}

/**
 * 把 drop 事件的数据解析成可信种子列表；校验失败时给出可诊断的提示
 * （静默丢弃只会让用户以为拖拽失灵）。
 */
export function resolveDroppedTorrents(
  dataTransfer: DataTransfer | null,
  siteId = "",
  trustedHosts?: Iterable<string>,
): IDropResolution {
  if (!dataTransfer) return { torrents: [], rejectedCount: 0, payloadInvalid: false };

  // perfer types: custom > manual
  const parsedResult = Array.from(dataTransfer.types).includes(CUSTOM_DRAG_MIME)
    ? parseCustomDragPayload(dataTransfer.getData(CUSTOM_DRAG_MIME), siteId)
    : parseManualDropPayload(dataTransfer, siteId);
  const result = filterDroppedTorrentsByTrustedHosts(parsedResult, trustedHosts);

  if (result.torrents.length === 0) {
    const runtimeStore = useRuntimeStore();
    if (result.payloadInvalid) {
      runtimeStore.showSnakebar(i18n.t("contentScript.invalidDropData"), { color: "error" });
    } else if (result.rejectedCount > 0) {
      runtimeStore.showSnakebar(i18n.t("contentScript.unsupportedDropLinks"), { color: "error" });
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
