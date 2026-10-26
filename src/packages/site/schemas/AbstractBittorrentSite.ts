import { matchesSelector, selectElements } from "../utils/selector";
import { get, isEmpty, set } from "es-toolkit/compat";
import { chunk, pascalCase, pick, toMerged, union } from "es-toolkit";
import { type AxiosError, type AxiosRequestConfig, type AxiosResponse } from "axios";
import PQueue from "p-queue";
import { supportSocialSite } from "@ptd/social";
import { buildTrustedHostnames, collectDeclaredRequestHostnames, isHostTrusted } from "../utils/trustedHost";

import { isDebug } from "~/helper.ts";

// noinspection ES6PreferShortImport
import { axios, isCloudflareBlocked, retrieve, sleep, store, logMessage } from "../utils/adapter";
import {
  EResultParseStatus,
  IElementQuery,
  ISearchResult,
  ISiteMetadata,
  ITorrent,
  NeedLoginError,
  CFBlockedError,
  NoTorrentsError,
  IAdvanceKeywordSearchConfig,
  ISearchInput,
  ITorrentTag,
  ISiteUserConfig,
  TSiteUrl,
  ISearchEntryRequestConfig,
  IParsedTorrentListPage,
  TSchemaMetadataListSelectors,
  ETorrentStatus,
  type TSchemaMetadata,
} from "../types";
import {
  definedFilters,
  filterNames,
  TQueryFilter,
  cfDecodeEmail,
  parseSizeString,
  parseTimeWithZone,
  parseValidTimeStringInZone,
  normalizeNumericField,
  tryToNumber,
  hasNonLatinCharacters,
  classifySiteError,
  redactSensitive,
  siteErrorLogData,
  NetworkError,
  ServerError,
} from "../utils";

/** 本引擎一定会提供的键；列出来之后消费方读它们不必再写非空断言 */
type TMetadataKeys = "version" | "search";

export const SchemaMetadata: TSchemaMetadata<TMetadataKeys> = {
  version: -1,
  search: {},
};

const defaultTorrentSelectorKey = [
  "id",
  "title",
  "subTitle",
  "url",
  "link",
  "time",
  "size",
  "author",
  "seeders",
  "leechers",
  "completed",
  "comments",
  "category",
  "tags",
  "progress",
  "status",
];

/**
 * 按 searchEntry.selectors 记忆化的「逐字段解析计划」，
 * 避免每一行都重复 Object.keys/union/pascalCase 及 `in this` 反射
 */
type TorrentRowParsePlanItem = {
  key: keyof Omit<ITorrent, "site">;
  fnKey?: string;
  selector?: IElementQuery;
};

// Sizzle 的位置伪类（:first/:last/:eq/:gt/:lt/:even/:odd）在 matchesSelector 下语义不完整，命中时回落为逐个查询
const positionalSelectorPattern = /:(?:first|last|eq|gt|lt|even|odd)(?![\w-])/;

/**
 * fixLink 允许出现的协议白名单（S-2）。
 *
 * 站点数据全部来自页面解析结果（拖拽载荷甚至可以被页面完全伪造），
 * 而 `new URL(uri, base)` 会原样保留 javascript: / data: / file: 等绝对 scheme，
 * 这些值随后会流向扩展特权请求、chrome.downloads 与 window.open，
 * 因此这里只放行真正可用于下载的三种协议。
 */
const allowedLinkProtocols = ["http:", "https:", "magnet:"];

/** 显式 scheme 的正则：没有 scheme 的输入是相对路径，会由 fixLink 按站点基址解析 */
const explicitSchemePattern = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/**
 * 判断链接的协议是否在白名单内。
 * 没有显式 scheme 的相对路径（`./x`、`x`、`/x`）直接放行——它们最终会落到站点的 http(s) 基址上。
 *
 * 这里只做「文本层面的 scheme 提取」，不再重新 `new URL()` 解析：
 * fixLink 已把所有相对路径与协议相对路径（`//host/path`）解析成合法的 http(s) 绝对地址（TESTS-7），
 * 重新解析没有额外收益，反而要把 `magnet:` 等非 URL 形态塞进 URL 构造的异常路径。
 */
function hasAllowedLinkProtocol(url: string): boolean {
  const scheme = url.match(explicitSchemePattern)?.[0];
  return scheme ? allowedLinkProtocols.includes(scheme.toLowerCase()) : true;
}

/**
 * 「文本/标识」语义的字段：即使解析结果是纯数字字符串也不能转成 number。
 *
 * 背景（E18/E19）：`getFieldData` 历史上把所有纯数字结果 `parseInt`，于是
 * - 用户名 `123456` / 全数字用户名 → `IUserInfo.name` 变成 number → urlJoin 抛错；
 * - 标题《1917》《2012》→ `ITorrent.title` 变成 number，破坏 string 契约；
 * - IMDB/豆瓣等 `ext_*` 标识同理。
 *
 * 只有在调用方显式传入字段名（`getFieldsData` / `parseWholeTorrentFromRow`）时才能判断语义；
 * 两参数调用（站点定义里的历史写法）继续保留「数字字符串 → number」的兼容行为。
 */
const stringTypedFieldKeys = new Set<string>([
  "name",
  "title",
  "subTitle",
  "author",
  "url",
  "link",
  "levelName",
  "status",
]);

/** 带前导零的「数字」更像标识（`"007"` / 邮编 / 赛季号）而不是数量，保留字符串避免丢失前导零（E19） */
const leadingZeroNumberPattern = /^-?0\d/;

/**
 * 列表页「计数类」数值字段（seeders/leechers/…）。
 *
 * selector 零命中时 `getFieldData` 会回落成 `""`（这是引擎既有契约，站点定义有直接探测它的用例，
 * 不要在这里改）。这些字段的 `"" → 0` 归一放 `parseWholeTorrentFromRow` 组装种子对象时做
 * （见该方法内 `torrentCountFieldKeys` 循环），只影响 `ITorrent`，不影响 `getFieldData` 的返回值。
 * 用户信息字段不在此列——它们走 `getFieldsData({dropEmptyMisses})`，零命中保留 undefined（D1-6）。
 */
const torrentCountFieldKeys = new Set<string>([
  "seeders",
  "leechers",
  "completed",
  "comments",
  "size",
  "time",
  "progress",
]);

/**
 * 用**惰性文档**解析一段 HTML 片段（E07）。
 *
 * `DOMParser().parseFromString()` 生成的文档是惰性的：不执行脚本、不加载图片，
 * 因此用它替代「活文档 + `document.createElement("span").innerHTML = s`」
 * （utils/html.ts 的 `extractContent` 以及 NexusPHP 的历史实现）不会把不可信页面内容
 * 变成扩展上下文里的资源请求/事件源。
 */
export function parseInertHtmlFragment(html: string): Document {
  return new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
}

/** 同 `parseInertHtmlFragment`，只取纯文本（等价于旧 `extractContent` 的语义） */
export function extractTextFromHtmlFragment(html: string): string {
  if (!html) return "";
  return parseInertHtmlFragment(html).body?.textContent ?? "";
}

/**
 * 判断一个值是否是 DOM Document（不依赖跨 realm 的 `instanceof`）。
 *
 * happy-dom 的 `DOMParser` 产物不是测试环境全局 `Document` 的实例（H 的 M1 证据），
 * 而浏览器扩展里 schema 也可能收到来自不同 document 的对象；用 `nodeType === 9` 判定既准确又稳定，
 * 也让测试不必再 `vi.stubGlobal("Document", ...)` 才能走 DOM 分支。
 */
export function isDocumentNode(value: unknown): value is Document {
  return !!value && typeof value === "object" && (value as { nodeType?: number }).nodeType === 9;
}

/** 判断一个值是否是 DOM Element（同上，避免跨 realm 的 `instanceof Element` 失配） */
export function isElementNode(value: unknown): value is Element {
  return !!value && typeof value === "object" && (value as { nodeType?: number }).nodeType === 1;
}

/** 判断一个值是否是 DOM 节点（Document/Element/Text/…），用于 getFieldData 区分 DOM 上下文与 JSON 对象 */
export function isDomNode(value: unknown): value is Node {
  return !!value && typeof value === "object" && typeof (value as { nodeType?: number }).nodeType === "number";
}

// 适用于公网BT站点，同时也作为 所有站点方法 的基类
export default class BittorrentSite {
  public readonly metadata: ISiteMetadata; // 实际过程中使用的配置文件
  public readonly userConfig: ISiteUserConfig;

  // 行级选择器结果缓存：同一行内相同的选择器只求值一次（键为行元素，值为 选择器 -> 结果元素）
  private _rowElementQueryCache = new WeakMap<Element, Map<string, Element | null>>();
  // 逐字段解析计划的记忆化缓存（键为 searchEntry.selectors 对象）
  private _torrentRowParsePlanCache = new WeakMap<object, TorrentRowParsePlanItem[]>();

  // E22 复检 L-5：详情页解析出的下载链接短期实例缓存（键为 torrent 对象身份）。
  // `getTorrentInfoForVerification` / `downloadTorrent` 会对**同一个 torrent 对象**先后调用
  // `getTorrentDownloadLink()` 与 `getTorrentDownloadRequestConfig()`（后者内部再调一次前者）；
  // E22 之后不再写回 `torrent.link`，若下载链接只在详情页 selector 里，这串调用会重复抓详情页。
  // - 不写回入参、不跨 torrent 对象泄漏（WeakMap，对象被回收即释放）；
  // - 短 TTL：避免复用已过期的签名下载链接；
  // - 仅缓存「从详情页解析成功」的结果，torrent.link 本身存在时无需缓存。
  private _resolvedDownloadLinkCache = new WeakMap<object, { link: string; expires: number }>();
  private static readonly resolvedDownloadLinkCacheTtl = 60 * 1000;

  constructor(metadata: ISiteMetadata, userConfig: ISiteUserConfig = {}) {
    this.metadata = toMerged(metadata, userConfig.merge ?? {});
    this.userConfig = userConfig;

    // P1-2：metadata / userConfig 中可能包含 token、cookie、passkey 等敏感信息，
    // 因此详细内容只在调试构建下打印，并且必须先经过 redactSensitive 脱敏。
    if (isDebug) {
      console.log(
        `[Site] ${this.name} Initialized with Metadata: `,
        redactSensitive(this.metadata),
        "UserConfig: ",
        redactSensitive(this.userConfig),
      );
    }
  }

  get name(): string {
    return this.userConfig.merge?.name ?? this.metadata.name;
  }

  get url(): TSiteUrl {
    return this.userConfig.url ?? this.metadata.urls[0];
  }

  /**
   * Final defense for every privileged download path.
   * Content-script validation is not enough because options/offscreen can call the same
   * downloader handlers with data that did not originate from the content script.
   */
  public isTrustedDownloadLink(link: string): boolean {
    if (link.startsWith("magnet:")) {
      return true;
    }

    return this.isTrustedSiteUrl(link);
  }

  get isOnline(): boolean {
    return !this.metadata.isDead && !this.userConfig.isOffline;
  }

  get allowSearch(): boolean {
    return this.isOnline && !!this.metadata.search && !(this.userConfig.allowSearch === false);
  }

  private _trustedHostnames?: string[];

  /**
   * 本站点允许发起特权请求的主机集合：`this.url` + `metadata.urls` + `metadata.legacyUrls`。
   * 与 `isTrustedDownloadLink` 共用同一套比较规则（允许同一注册域的子域，例如 CDN / api 子域）。
   * metadata 在实例构造后不可变，因此结果可以按实例缓存。
   *
   * **最终同源语义（跨范围协调结论，2026-10-23）**：
   * - 放行：与上述主机**完全相同**，或其中任一主机的**子域**（`cdn.example.com` ∈ `example.com`）；
   * - 不放行：**兄弟主机**（`api.m-team.cc` ⊄ `kp.m-team.cc`）。这里刻意不按「父域相同」自动放行：
   *   metadata.urls 里可能存在共享托管域（`foo.github.io`），自动信任父域会把 `*.github.io` 一起放进来；
   * - 站点若确实使用兄弟 API 主机（如 M-Team 的 `api.<domain>`），在站点类里**显式覆写本 getter** 声明，
   *   参考 `definitions/mteam.ts` 的 `trustedHostnames` 覆写（只追加由 `apiBaseUrl` 推导的单个主机）。
   */
  protected get trustedHostnames(): string[] {
    // 复用 D2 的公共实现（utils/trustedHost.ts），保证 schema 请求同源校验、offscreen sender 绑定、
    // 站点定义的 trustedHostnames 覆写三处规则不漂移。
    // 声明主机来源：this.url + metadata.urls/legacyUrls（支持 rot13）+ metadata 中显式写定的
    // 绝对请求地址（search/list/detail/download.requestConfig 的 url/baseURL）。
    this._trustedHostnames ??= buildTrustedHostnames(
      [this.url, ...(this.metadata.urls ?? []), ...(this.metadata.legacyUrls ?? [])],
      collectDeclaredRequestHostnames(this.metadata),
    );
    return this._trustedHostnames;
  }

  /**
   * 判断一个（绝对或相对）链接是否指向本站点：相对路径按 `this.url` 解析，
   * 只有 http(s) 且主机命中 `trustedHostnames`（含子域）才返回 true。
   *
   * 用于两处纵深防御（E3-1 / E12）：
   * 1. `request()` 拒绝把请求（及其携带的 passkey/token 等凭据）发往站点之外的绝对 URL；
   * 2. 定义层（hdbits/huno）在注入凭据前复用同一判据。
   */
  public isTrustedSiteUrl(url?: string | null): boolean {
    if (typeof url !== "string" || url.trim() === "") {
      return false;
    }

    let parsed: URL;
    try {
      parsed = new URL(url.trim(), this.url);
    } catch {
      return false;
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }

    return isHostTrusted(parsed.hostname, this.trustedHostnames);
  }

  /**
   * 解析一个请求配置最终会打到的绝对 URL（只用于同源校验，不参与实际请求拼接）。
   * 解析失败返回 undefined，由调用方按「不可信」处理。
   */
  public resolveRequestTarget(config: { baseURL?: string; url?: string } | undefined | null): string | undefined {
    if (!config) return undefined;

    const rawUrl = typeof config.url === "string" ? config.url.trim() : "";
    const rawBase = typeof config.baseURL === "string" ? config.baseURL.trim() : "";

    const absoluteBase = (() => {
      if (!rawBase) return this.url;
      if (explicitSchemePattern.test(rawBase)) return rawBase;
      try {
        return new URL(rawBase, this.url).toString();
      } catch {
        return undefined;
      }
    })();

    try {
      if (rawUrl) {
        if (explicitSchemePattern.test(rawUrl)) return new URL(rawUrl).toString();
        if (rawUrl.startsWith("//")) return new URL(rawUrl, absoluteBase ?? this.url).toString();
        if (!absoluteBase) return undefined;
        return new URL(rawUrl, absoluteBase).toString();
      }
      return absoluteBase;
    } catch {
      return undefined;
    }
  }

  /**
   * 构造并记录一条「请求目标不在站点允许主机内」的错误。
   * 日志只保留 protocol//host/pathname：请求 URL 可能包含 passkey / token 等凭据，不能进日志/UI。
   */
  private untrustedRequestError(targetUrl: string): Error {
    let safeTarget = "[unparseable]";
    try {
      const parsed = new URL(targetUrl);
      safeTarget = `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
    } catch {
      /* 保留占位符 */
    }

    logMessage(
      `[Site] ${this.name} blocked request to untrusted host`,
      { site: this.metadata.id, target: safeTarget },
      "warn",
    );

    return new Error(`[PTD] site '${this.metadata.id}' blocked request to untrusted host: ${safeTarget}`);
  }

  /**
   * 给请求配置补默认值，并做**同源校验**（E3-1 纵深防御）：绝对 URL、协议相对 URL 或绝对 baseURL
   * 的目标主机必须命中 `trustedHostnames`，否则在发请求（以及注入凭据）之前直接失败。
   *
   * 返回的是**浅拷贝**：`request()` 不再原地修改调用方传入的对象（E12 的根因是
   * `statusRequestConfig` 这类模块级共享配置被 `baseURL ??=` 写坏，导致跨站点凭据串用）。
   */
  protected prepareRequestConfig(axiosConfig: AxiosRequestConfig): AxiosRequestConfig {
    const config: AxiosRequestConfig = { ...axiosConfig };
    config.baseURL ??= this.url;
    config.url ??= "/";
    config.timeout ??= this.userConfig.timeout ?? 30e3;

    const rawUrl = String(config.url).trim();
    if (explicitSchemePattern.test(rawUrl) || rawUrl.startsWith("//")) {
      const resolved = this.resolveRequestTarget({ baseURL: config.baseURL, url: rawUrl });
      if (!resolved || !this.isTrustedSiteUrl(resolved)) {
        throw this.untrustedRequestError(resolved ?? rawUrl);
      }
      // 归一化成绝对 URL，且显式允许它覆盖 baseURL（否则 axios 会把它当相对路径拼接）
      config.url = resolved;
      config.allowAbsoluteUrls = true;
    } else {
      // 相对路径：关闭 axios 的「绝对 URL 覆盖 baseURL」能力，作为纵深防御
      config.allowAbsoluteUrls = false;
    }

    if (typeof config.baseURL === "string" && explicitSchemePattern.test(config.baseURL.trim())) {
      if (!this.isTrustedSiteUrl(config.baseURL)) {
        throw this.untrustedRequestError(config.baseURL);
      }
    }

    // 最终拼出的 URL 再过一遍同源校验（防止 baseURL + 畸形 url 组合出别的主机）
    try {
      const finalUrl = axios.getUri({
        baseURL: config.baseURL,
        url: config.url,
        params: config.params,
      });
      if (finalUrl && !this.isTrustedSiteUrl(finalUrl)) {
        throw this.untrustedRequestError(finalUrl);
      }
    } catch (e) {
      // untrustedRequestError 必须原样抛出；getUri 自身失败（畸形 baseURL）时保持原行为由 axios 报错
      if (e instanceof Error && e.message.startsWith("[PTD]")) {
        throw e;
      }
    }

    return config;
  }

  get downloadInterval(): number {
    return this.userConfig.downloadInterval ?? this.metadata.download?.interval ?? 0;
  }

  /**
   * 登录检查方法，对于公开站点，该方法一定直接返回 True
   * @param raw
   */
  protected loggedCheck(raw: AxiosResponse): boolean {
    return true;
  }

  protected async sleepAction(ms: number | undefined): Promise<void> {
    if (ms && ms > 0) {
      await sleep(ms);
    }
  }

  protected async storeRuntimeSettings<T extends any>(key: string, value: T): Promise<T> {
    this.userConfig.runtimeSettings ??= {}; // 确保 runtimeSettings 存在
    this.userConfig.runtimeSettings[key] = value; // 更新当前实例的 runtimeSettings
    await store(this.metadata.id, key, value); // 持久化
    return value;
  }

  protected async retrieveRuntimeSettings<T>(key: string): Promise<T | null> {
    return (this.userConfig.runtimeSettings?.[key] ?? (await retrieve<T>(this.metadata.id, key))) as T | null;
  }

  /**
   * 真正的请求执行层（含重试 / CF 判定 / 网络错误包装），不包含登录断言与最终状态码判定。
   *
   * 拆出来是为了让改写过 `request()` 的 schema（AvistazNetwork 的 JSON API 分支）能复用同一套
   * 重试与错误分类语义，而不是自己维护一份「无重试 + 原始 AxiosError」的旁路（D1-1）。
   */
  protected async performRequestWithRetry<T>(axiosConfig: AxiosRequestConfig): Promise<AxiosResponse<T>> {
    // 对网络错误（没有拿到 response）/ 超时 / 5xx / 429 做 1~2 次指数退避重试
    const maxRetryTimes = 2;
    const retryableStatusCodes = [429, 500, 502, 503, 504];

    let req: AxiosResponse<T> | undefined;
    let lastError: unknown;
    let cloudflareBlocked = false;

    for (let attempt = 0; attempt <= maxRetryTimes; attempt++) {
      // 指数退避：500ms、1000ms
      if (attempt > 0) {
        await this.sleepAction(500 * 2 ** (attempt - 1));
      }

      try {
        req = await axios.request<T>(axiosConfig);

        // 全局性的替换 span.__cf_email__
        if (axiosConfig.responseType === "document") {
          const doc = req.data;

          // 进行简单的检查，防止无意义的替换
          if (isDocumentNode(doc) && doc.documentElement.outerHTML.includes("__cf_email__")) {
            const cfProtectSpan = selectElements(".__cf_email__", doc);

            cfProtectSpan.forEach((element) => {
              // data-cfemail 缺失时 cfDecodeEmail 返回空串，不能让一个畸形 span 把整页判成网络错误
              element.replaceWith(cfDecodeEmail((element as HTMLElement).dataset.cfemail));
            });
          }

          req.data = doc;
        }
      } catch (e) {
        lastError = e;
        // 从 AxiosError 中获取 response（网络错误/超时时为 undefined）
        req = (e as AxiosError).response as AxiosResponse<T> | undefined;
      }

      // Cloudflare 拦截交由后续逻辑抛出 CFBlockedError，不在此处重试
      if (req !== undefined && isCloudflareBlocked(req)) {
        cloudflareBlocked = true;
        break;
      }

      // 网络错误 / 超时：没有拿到任何响应
      if (req === undefined) {
        const isCanceled = (lastError as AxiosError | undefined)?.code === "ERR_CANCELED";
        if (isCanceled || attempt >= maxRetryTimes) {
          break;
        }
        continue;
      }

      // 限流或服务端错误：还有重试次数则重试
      if (retryableStatusCodes.includes(req.status) && attempt < maxRetryTimes) {
        continue;
      }

      break;
    }

    if (cloudflareBlocked) {
      throw new CFBlockedError();
    }

    if (req === undefined) {
      // 显式处理没有拿到响应的情况，避免后续访问 req.status 抛出 TypeError 而被误记为 parseError
      const error = lastError as AxiosError | undefined;
      // 用 NetworkError 标记「网络/超时」来源，便于上层区分「网络问题」与「真正的解析失败」（P1-3）
      throw new NetworkError(`Network Error: ${error?.message || error?.code || "No response received"}`.trim());
    }

    return req;
  }

  public async request<T>(axiosConfig: AxiosRequestConfig, checkLogin: boolean = true): Promise<AxiosResponse<T>> {
    // E12：必须先拷贝再补默认值——`statusRequestConfig`（Rartracker）等模块级共享配置被 `??=` 原地写坏后，
    // 不同站点实例会复用第一个站点的 baseURL，把 A 站的 passkey 写到 B 站名下。
    // 同时 prepareRequestConfig 会拒绝发往站点之外的绝对 URL（E3-1 纵深防御）。
    const config = this.prepareRequestConfig(axiosConfig);

    // 如果站点有请求延迟，则等待一段时间
    await this.sleepAction(this.metadata.requestDelay ?? 0);

    const req = await this.performRequestWithRetry<T>(config);

    // 随后检查是否需要登录
    if (checkLogin && !this.loggedCheck(req)) {
      throw new NeedLoginError();
    }

    // 如果非需要登录的情况，但还是返回了 4xx 或者 5xx ，则抛出错误
    if (req.status >= 400) {
      // 用 ServerError 标记「服务端返回错误状态码」来源（429/5xx 等可重试场景）
      throw new ServerError(`Network Error: ${req.status} ${req.statusText || ""}`.trim());
    }

    return req;
  }

  /**
   * 生成一个用于「有上限并发」请求的节流器：
   * 保证并发发起的请求，起始时间至少间隔 delay 毫秒，从而在并发的同时不放大站点的请求频率。
   * delay <= 0 时不做任何等待。
   *
   * P2-3：实现已收敛为 p-queue 的薄封装（并发 1 + 每个 interval 只放行 1 个任务），
   * 与 backupServer/utils.ts、social/recommendations.ts 使用同一套并发原语；
   * 函数签名、默认并发常量与调用点均保持不变。
   */
  protected createRequestThrottle(delay: number | undefined): () => Promise<void> {
    const interval = delay && delay > 0 ? delay : 0;

    if (interval <= 0) {
      return async () => {};
    }

    const throttleQueue = new PQueue({ concurrency: 1, interval, intervalCap: 1 });

    return async () => {
      await throttleQueue.add(async () => {});
    };
  }

  /**
   * 种子搜索方法入口
   * @param keywords
   * @param searchEntry
   */
  public async getSearchResult(keywords?: string, searchEntry: ISearchEntryRequestConfig = {}): Promise<ISearchResult> {
    // L-2：searchEntry / requestConfig 是活对象，部分定义会把 passkey / x-api-key / Authorization 就地注入其中，
    // 与构造函数一致：只在调试构建下打印，且先脱敏
    if (isDebug) {
      console.log(
        `[Site] ${this.name} start search with keywords:`,
        keywords,
        "input searchEntry:",
        redactSensitive(searchEntry),
      );
    }
    const result: ISearchResult = {
      data: [],
      status: EResultParseStatus.unknownError,
    };

    // 0. 检查该站点是否允许搜索
    if (!this.allowSearch) {
      result.status = EResultParseStatus.passParse;
      result.statusMsg = "i18n.siteNotEnabled";
      return result;
    }

    // 1. 形成搜索入口，默认情况下需要合并 this.config.search

    // 如果传入了 id，说明需要首先与 metadata.searchEntry 中对应id的搜索配置的合并
    if (searchEntry.id) {
      searchEntry = toMerged(this.metadata.searchEntry?.[searchEntry.id] ?? {}, searchEntry)!;
    }

    // 继续检查 searchEntry， 如果为空，或者没有显示设置 merge 为 false，则进一步在 this.metadata.search 的基础上进行合并
    if (isEmpty(searchEntry) || searchEntry.merge !== false) {
      searchEntry = toMerged(this.metadata.search!, searchEntry)!;
    }

    // 检查该搜索入口是否设置为禁用
    if (searchEntry.enabled === false) {
      result.status = EResultParseStatus.passParse;
      result.statusMsg = "i18n.searchEntityNotEnabled";
      return result;
    }

    if (isDebug) {
      console.log(`[Site] ${this.name} start search with merged searchEntry:`, redactSensitive(searchEntry));
    }

    // 2.1 检查 keywords 是否为空
    // L-1：与 types/search.ts 的契约一致 ——「仅含空白字符」同样视为空关键词，不发请求
    if (searchEntry.skipWhiteSpacePlaceholder === true && !keywords?.trim()) {
      console?.log(`[Site] ${this.name} skipped due to empty keywords`);
      result.status = EResultParseStatus.passParse;
      result.statusMsg = "i18n.noEmptyKeywords";
      return result;
    }

    // 2.2 检查字符集兼容性并过滤站点
    if (searchEntry.skipNonLatinCharacters === true && keywords && hasNonLatinCharacters(keywords)) {
      console?.log(`[Site] ${this.name} skipped due to non-Latin characters in query:`, keywords);
      result.status = EResultParseStatus.passParse;
      result.statusMsg = "i18n.noNonLatin";
      return result;
    }

    // 3. 生成对应站点的基础 requestConfig
    let requestConfig: AxiosRequestConfig = toMerged(
      { url: "/", responseType: "document", params: {}, data: {} }, // 最基础的垫片，baseUrl 会在 request 方法中被补全，此处不用额外声明
      searchEntry.requestConfig || {}, // 使用默认配置覆盖垫片配置，如果是站点是 json 返回，应该在此处覆写 responseType，并准备基础参数
    );

    // 4. 预检查 keywords 是否为高级搜索词，如果是，则查找对应的 searchEntry.advanceKeywordParams[*] 并改写 keywords
    let advanceKeywordConfig: IAdvanceKeywordSearchConfig | false = false;
    if (keywords) {
      // 生成支持的高级搜索词前缀
      const advanceKeywordFields = Object.keys(searchEntry.advanceKeywordParams ?? {});

      for (const advanceField of union(advanceKeywordFields, supportSocialSite)) {
        if (keywords.startsWith(`${advanceField}|`)) {
          // 先改写 keywords， 去除掉我们额外添加的 `${advanceField}|` 前缀
          keywords = keywords?.replace(`${advanceField}|`, "");

          // 检查是否有对应的高级搜索词配置
          let advanceConfig = searchEntry?.advanceKeywordParams?.[advanceField];
          if (typeof advanceConfig === "undefined") {
            if (advanceField == "imdb") {
              advanceConfig = { enabled: true }; // imdb 格式fallback到普通关键词搜索
            } else {
              advanceConfig = false; // 其他高级搜索词格式（douban|, bangumi|, anidb|, tmdb|, tvdb|, mal|）直接跳过
            }
          }

          // 检查是否跳过
          if (advanceConfig === false || advanceConfig.enabled === false) {
            result.status = EResultParseStatus.passParse;
            result.statusMsg = "i18n.noAdvanceParams";
            return result;
          }

          advanceKeywordConfig = advanceConfig;
          break;
        }
      }
    }

    // 5. 首先将搜索关键词根据 keywordsParam 放入请求配置中，注意如果是 advanceKeyword 已经被去除了前缀 `${advanceKeywordType}|`
    if (keywords) {
      set(requestConfig, searchEntry.keywordPath || "params.keywords", keywords || "");
    }

    // 6. 如果是高级搜索词搜索，则在对应基础上改写 AxiosRequestConfig
    if (advanceKeywordConfig) {
      if (advanceKeywordConfig.requestConfig) {
        requestConfig = toMerged(requestConfig, advanceKeywordConfig.requestConfig || {});
      }

      if (typeof advanceKeywordConfig.requestConfigTransformer === "function") {
        requestConfig = advanceKeywordConfig.requestConfigTransformer({ keywords, searchEntry, requestConfig });
      }
    }

    // 7. 如果有 requestConfigTransformer，则会在最后一步对请求配置进行处理
    if (typeof searchEntry.requestConfigTransformer === "function") {
      requestConfig = searchEntry.requestConfigTransformer({ keywords, searchEntry, requestConfig });
    }

    // 如果站点有搜索请求延迟，则等待一段时间
    if ((searchEntry.requestDelay ?? 0) > 0) {
      await sleep(searchEntry.requestDelay!);
    }

    if (isDebug) {
      console.log(`[Site] ${this.name} start search with requestConfig:`, redactSensitive(requestConfig));
    }

    // 8. 请求页面并转化为document
    try {
      const req = await this.request(requestConfig);
      result.data = await this.transformSearchPage(req.data, {
        keywords,
        searchEntry,
        // request() 内部会拷贝配置并补全 baseURL/timeout，且不回写传入对象（E12）；
        // 页面解析（fixLink 补全相对 url/link）需要的是「实际请求配置」，因此优先传 req.config，
        // 避免再次出现「解析时 baseURL 缺失 → 每行 new URL 抛 Invalid URL」的整站解析失败。
        requestConfig: req.config ?? requestConfig,
      });
      result.status = EResultParseStatus.success;
    } catch (e) {
      // P1-3：区分「网络/超时/服务端错误（可重试）」与「真正的解析失败（重试无用）」，
      // 并把 e.message 透传到 statusMsg；P1-2：生产环境同样记录日志，而不是只写在 DEV 守卫里。
      const { status, statusMsg, retryable } = classifySiteError(e);
      result.status = status;
      result.statusMsg = statusMsg;

      logMessage(
        `[Site] ${this.name} getSearchResult failed (status=${EResultParseStatus[status]}, retryable=${retryable})`,
        {
          site: this.metadata.id,
          keywords,
          status,
          retryable,
          error: siteErrorLogData(e),
        },
        retryable ? "warn" : "error",
      );
    }
    return result;
  }

  /**
   * @warning 此方法不可以在 getFieldData 的 filters 中使用，
   *          对于约定的 url, link 本方法会自动调用进行补全
   * @param uri
   * @param requestConfig
   */
  protected fixLink(uri: string, requestConfig: AxiosRequestConfig): string {
    let url = uri;

    if (uri.length > 0 && !uri.startsWith("magnet:")) {
      // 相对链接要按「本次解析对应页面的地址」补全，而不是按运行环境的地址补全。
      //
      // 关键：传入的 requestConfig 可能仍是**没有补过 baseURL 的原始搜索配置**
      // （getSearchResult 生成的是 `{ url: "/torrents.php", ... }`；E12 之后 request() 只改自己的
      // 拷贝，不再把 baseURL 原地写回调用方对象）。旧实现直接 `axios.getUri(requestConfig)` 只会得到
      // 相对串 "/torrents.php"，随后 `new URL("download.php?id=..", "/torrents.php")` 抛
      // `TypeError: Invalid URL`，于是**每一行**都解析失败，被上层汇总成
      // `all N rows failed to parse`（真实站点上所有 NexusPHP 搜索都因此整站报解析错误）。
      // 这里统一用 resolveRequestTarget 按 this.url 把请求配置解析成绝对页面地址。
      const requestUrl = this.resolveRequestTarget(requestConfig) ?? this.url;
      if (uri.startsWith("//")) {
        // TESTS-7：原实现 `${urlHelper.protocol}:${uri}` 会拼出 `https:://host/path` 这种 URL 解析器
        // 不接受的畸形串（node 实测 `new URL("https:://host/path")` 抛 Invalid URL），下载必然失败；
        // 协议相对链接的语义就是「沿用基址的协议」，交给 new URL 按基址解析才能得到合法绝对地址。
        url = new URL(uri, requestUrl).toString();
      } else if (uri.slice(0, 4) !== "http") {
        // 基于请求地址，处理 ./xxx, xxxx, /xxxx 等相对路径
        url = new URL(uri, requestUrl).toString();
      }

      // S-2：协议白名单。上面的解析会保留 uri 里的任意绝对 scheme
      // （javascript: / data: / blob: / file: / vbscript: / about: 等），
      // 这些值最终会流向扩展特权请求 / chrome.downloads / window.open，
      // 因此既不静默放行、也不静默丢弃：记一条 warn 日志后返回空串，由调用方明确失败。
      if (!hasAllowedLinkProtocol(url)) {
        logMessage(
          `[Site] ${this.name} fixLink rejected unsafe protocol`,
          // 只记录截断后的原文：站点数据来自页面，日志不应被超长的伪造 URL 撑爆
          { site: this.metadata.id, uri: url.length > 120 ? `${url.slice(0, 120)}…` : url },
          "warn",
        );
        return "";
      }
    }

    return url;
  }

  /**
   * getFieldData 的上层方法，目的是直接获取一批数据，并以字典形式返回
   * @param element
   * @param fields
   * @param selectors
   * @protected
   */
  protected getFieldsData<
    G extends "search" | "detail" | "userInfo",
    S extends Required<Required<ISiteMetadata>[G]>["selectors"],
  >(
    element: Element | object,
    selectors: S,
    fields?: (keyof S)[],
    options: { dropEmptyMisses?: boolean } = {},
  ): { [key in keyof S]?: any } {
    const ret: { [key in keyof S]?: any } = {};

    if (!fields) {
      fields = Object.keys(selectors as Record<string, any>) as (keyof S)[];
    }

    // 说明（P2-4）：selectors 的泛型约束允许 undefined（部分 schema 的 selectors 为可选），
    // 而 ret 是映射类型、没有字符串索引签名，因此这里做一次显式收窄而不是用类型抑制注释掩盖。
    const pickedSelectors = pick((selectors ?? {}) as Record<string, IElementQuery>, fields as string[]) as Record<
      string,
      IElementQuery
    >;
    const retRecord = ret as Record<string, any>;

    for (const [key, selector] of Object.entries(pickedSelectors)) {
      // 传入 key 以启用 getFieldData 的「按字段名推导返回类型」重载（见 P2-4）
      const value = this.getFieldData(element, selector, key as keyof Omit<ITorrent, "site">);

      // D1-6：用户信息路径不允许把「selector 零命中」回落出来的 "" 当成真实值写入
      // （否则页面改版/软错误页会把数字字段覆盖成空串，破坏 IUserInfo 的数字契约）。
      if (options.dropEmptyMisses === true && value === "" && !this.hasFieldMatch(element, selector)) {
        continue;
      }

      retRecord[key] = value;
    }

    return ret;
  }

  /**
   * 重建行级选择器缓存（每次 transformSearchPage 开始时调用，把缓存生命周期限制在一次页面解析内）
   */
  protected resetRowElementQueryCache(): void {
    this._rowElementQueryCache = new WeakMap();
  }

  /**
   * 在指定元素内查询选择器，并按 (element, selector) 做行级缓存，避免同一行内相同选择器被重复求值。
   * 仅缓存 Element 上下文（行元素），Document 等上下文不缓存，以免跨调用读到过期结果。
   */
  private queryRowElement(selector: string, element: Element | Document): Element | undefined {
    if (!isElementNode(element)) {
      return selectElements(selector, element)[0] as Element | undefined;
    }

    let selectorCache = this._rowElementQueryCache.get(element);
    if (!selectorCache) {
      selectorCache = new Map<string, Element | null>();
      this._rowElementQueryCache.set(element, selectorCache);
    }

    if (selectorCache.has(selector)) {
      return selectorCache.get(selector) ?? undefined;
    }

    const found = (selectElements(selector, element)[0] as Element | undefined) ?? null;
    selectorCache.set(selector, found);
    return found ?? undefined;
  }

  /**
   * 按「种子字段名」读取数据：传入 field 后返回类型由 `ITorrent[field]` 推导（P2-4）。
   * 这是 `ITorrent` 全字段的类型检查入口，`getFieldsData` / `parseWholeTorrentFromRow` 均走此重载。
   */
  protected getFieldData<K extends keyof Omit<ITorrent, "site">>(
    element: Element | object,
    elementQuery: IElementQuery,
    field: K,
  ): Omit<ITorrent, "site">[K];
  /**
   * 通用读取（不传 field）：保持 any 返回值，兼容历史调用点与站点定义中的覆写实现。
   * 该重载必须放在最后，否则 definitions/ 中大量两参数调用会失去兼容性。
   */
  protected getFieldData(element: Element | object, elementQuery: IElementQuery): any;
  protected getFieldData(
    element: Element | object,
    elementQuery: IElementQuery,
    _field?: keyof Omit<ITorrent, "site">,
  ): any {
    let query: any = undefined;

    if (elementQuery.selector) {
      let usedSelector: string | undefined;

      const selectors = ([] as string[]).concat(elementQuery.selector);
      for (usedSelector of selectors) {
        // 在每次循环开始前，重置 query 为 undefined
        query = undefined;

        if (isDomNode(element)) {
          // 这里我们预定义一个特殊的 Css Selector，即不进行子元素选择
          const another = (
            usedSelector === ":self" ? element : this.queryRowElement(usedSelector, element as Element | Document)
          ) as HTMLElement;
          if (another) {
            if (elementQuery.elementProcess) {
              query = this.runQueryFilters<string>(another, elementQuery.elementProcess);
            } else if (elementQuery.case) {
              for (const [match, value] of Object.entries(elementQuery.case)) {
                if (matchesSelector(another, match)) {
                  query = value ?? query;
                  break;
                }
              }
            } else if (elementQuery.data) {
              query = another.dataset[elementQuery.data] ?? query;
            } else if (elementQuery.attr) {
              query = another.getAttribute(elementQuery.attr) ?? query;
            } else {
              // 优先使用 innerText，如果没有，则使用 textContent
              query = (another.innerText || another.textContent).replace(/\n/gi, " ") || query;
            }
          }
        } else {
          query = usedSelector === ":self" ? element : get(element, usedSelector)!;
        }

        if (typeof query !== "undefined") {
          break; // 说明该选择器找到了对应元素，跳出循环
        }

        // 在每次循环结束后，重置 usedSelector
        usedSelector = undefined;
      }

      // 根据 usedSelector 来判断是否找到了对应元素，找到了则应用 filters
      if (typeof usedSelector !== "undefined") {
        // 此时 query 一定不为 undefined
        if (typeof query === "string") {
          query = query.trim();
        }

        // 应用 filters
        if (selectors.length > 0 && elementQuery.switchFilters?.[usedSelector]) {
          query = this.runQueryFilters(query, elementQuery.switchFilters[usedSelector]);
        } else if (elementQuery.filters && elementQuery.filters?.length > 0) {
          query = this.runQueryFilters(query, elementQuery.filters);
        }
      }
    }

    // 此时如果 query 仍为 undefined 应该回落到 elementQuery.text ?? ""
    query ??= elementQuery.text ?? ""; // 不强制转为字符串，保持原有类型，方便后续处理

    // noinspection SuspiciousTypeOfGuard
    if (typeof query === "string") {
      query = query.trim(); // 去除空格
      // E18/E19：只有「非文本语义 && 纯数字 && 无前导零」的字段才转 number；
      // 用户名/标题/链接等保持字符串（详见 stringTypedFieldKeys 的说明）。
      const fieldName = typeof _field === "string" ? _field : undefined;
      const isStringTypedField = fieldName !== undefined && stringTypedFieldKeys.has(fieldName);
      if (!isStringTypedField && /^-?\d+$/.test(query) && !leadingZeroNumberPattern.test(query)) {
        // 尽可能的将返回值转成数字类型
        query = isNaN(parseInt(query)) ? 0 : parseInt(query);
      }
    } else if (typeof query === "number") {
      query = isNaN(query) ? 0 : query;
    }

    return query;
  }

  /**
   * 该 elementQuery 是否在 element 上**真正命中**：取到了非空的原始值（过滤器之前）。
   *
   * getFieldData 在零命中时会回落到 `elementQuery.text ?? ""`，调用方无法区分「命中且值为 0」与「根本没命中」；
   * 用户信息刷新需要这个区分来识别改版页 / 软错误页（见 AbstractPrivateSite 的 H-6、AvistazNetwork 的 M-11）。
   * 判据看原始值而不是「选中了元素」：`:self` + elementProcess 的字段永远能选中元素，真正的命中与否在 elementProcess 的返回值里。
   * 没有 selector、只靠 `text` 给常量的字段不算命中。
   */
  protected hasFieldMatch(element: Element | object, elementQuery: IElementQuery): boolean {
    if (!elementQuery.selector) return false;

    const raw = this.getFieldData(element, {
      ...elementQuery,
      filters: undefined,
      switchFilters: undefined,
      text: undefined,
    });
    return raw !== "" && raw !== null && typeof raw !== "undefined";
  }

  protected runQueryFilters<T>(query: any, filters: TQueryFilter[] | TQueryFilter): T {
    const realFilters = ([] as TQueryFilter[]).concat(filters);
    for (const realFilter of realFilters) {
      if (typeof realFilter === "function") {
        query = realFilter(query);
      } else if (realFilter?.name) {
        const { name, args = [] } = realFilter;
        if (filterNames.includes(name)) {
          if (
            this.metadata.timezoneOffset &&
            typeof query === "string" &&
            (name === "parseTime" || name === "parseFuzzyTime")
          ) {
            const parsed = parseValidTimeStringInZone(query, args, this.metadata.timezoneOffset);
            query = name === "parseFuzzyTime" && parsed === query ? definedFilters.parseTTL(query) : parsed;
          } else {
            query = definedFilters[name](query, args);
          }
        }
      }
    }

    return query;
  }

  /**
   * 处理数组选择器，依次尝试每个选择器直到找到匹配的元素
   * @param selectors 选择器或选择器数组
   * @param context 查找上下文 (Document或JSON对象)
   * @param options 可选配置
   * @returns 找到的元素数组
   * @protected
   */
  protected findElementsBySelectors(
    selectors: string | string[] | ":self" | (string | ":self")[],
    context: Document | object | any,
    options: { isJson?: boolean } = {},
  ): any[] {
    const selectorArray = ([] as (string | ":self")[]).concat(selectors);
    let foundElements: any[] = [];

    for (const selector of selectorArray) {
      if (options.isJson || !isDocumentNode(context)) {
        // JSON 数据处理
        if (selector === ":self") {
          foundElements = context;
        } else {
          foundElements = get(context, selector);
        }
      } else {
        // Document 处理
        foundElements = selectElements(selector as string, context);
      }

      if (foundElements && foundElements.length > 0) {
        break;
      }
    }

    return foundElements || [];
  }

  /**
   * 如何解析 JSON 或者 Document，获得种子详情列表
   */
  public async transformSearchPage(doc: Document | object | any, searchConfig: ISearchInput): Promise<ITorrent[]> {
    // 每次页面解析开始时重建行级选择器缓存
    this.resetRowElementQueryCache();

    const { searchEntry, requestConfig } = searchConfig;
    if (!searchEntry!.selectors?.rows) {
      throw Error("列表选择器未定义");
    }

    const rowsSelector = searchEntry!.selectors.rows;
    const torrents: ITorrent[] = [];
    let failedRows = 0; // B-1：解析失败的行数，用于区分「部分坏数据」与「整体解析失败」

    // 使用抽象方法处理数组选择器
    let trs = this.findElementsBySelectors(rowsSelector.selector, doc, { isJson: !isDocumentNode(doc) });

    if (isDocumentNode(doc)) {
      if (rowsSelector.filter) {
        trs = rowsSelector.filter(trs);
      } else {
        /**
         * 应对某些站点连用多个tr表示一个种子的情况，将多个tr使用 <div> 包裹成一个 Element，
         * 这种情况下，子选择器就可以写成 `tr:nth-child(1) xxxx` 来精确
         */
        const rowMergeDeep: number = rowsSelector.merge || 1;
        if (trs.length > 0 && rowMergeDeep > 1) {
          const newTrs: Element[] = [];

          chunk(trs, rowMergeDeep).forEach((chunkTr) => {
            const wrapperDiv = doc.createElement("div");
            chunkTr.forEach((tr) => {
              wrapperDiv.appendChild(tr as Element);
            });
            newTrs.push(wrapperDiv);
          });

          trs = newTrs;
        }
      }
    } else {
      if (rowsSelector.filter) {
        trs = rowsSelector.filter(trs);
      }
    }

    // 如果没有搜索到种子，则抛出 NoTorrentsError
    if (trs.length === 0) {
      throw new NoTorrentsError();
    }

    for (const tr of trs) {
      try {
        torrents.push((await this.parseWholeTorrentFromRow({}, tr, searchConfig)) as ITorrent);
      } catch (e) {
        failedRows++;
        // B-1：单行解析失败（典型场景是时间单元格为空 / "昨天" / "01.03.2024 10:00" 这类
        // parseTimeWithZone 无法处理的原始文本）不应让整站搜索结果全部作废，
        // 这里与 Gazelle 的逐行处理保持一致：记日志 + 跳过该行，其余 N-1 条照常返回。
        console.debug(`[PTD] site '${this.name}' parseWholeTorrentFromRow Error:`, e, tr);
      }
    }

    // B-1：但「每一行都失败」不是部分坏数据，而是该站点整体解析失败（例如整列时间格式变化），
    // 必须让上层看到明确的错误（classifySiteError 会归为 parseError），
    // 而不是伪装成「搜索成功但 0 结果」让用户以为站点没有该关键词的资源。
    if (torrents.length === 0 && failedRows > 0) {
      throw new Error(`site '${this.name}': all ${failedRows} rows failed to parse`);
    }

    return torrents;
  }

  /**
   * 生成（并缓存）当前 searchEntry.selectors 对应的逐字段解析计划：
   * 键列表（union + 过滤 rows）、parseTorrentRowForX 分派表都在这里按 searchEntry.selectors 计算一次，
   * 避免每一行都重复 Object.keys/union/pascalCase 与 `in this` 反射。
   */
  protected getTorrentRowParsePlan(searchEntry: ISearchEntryRequestConfig): TorrentRowParsePlanItem[] {
    const selectors = searchEntry.selectors! as Record<string, any>;
    const cacheKey = selectors as object;

    let parsePlan = this._torrentRowParsePlanCache.get(cacheKey);
    if (!parsePlan) {
      const definedTorrentSelectorKey = Object.keys(selectors).filter((key) => key !== "rows");

      parsePlan = (union(definedTorrentSelectorKey, defaultTorrentSelectorKey) as (keyof Omit<ITorrent, "site">)[]).map(
        (key) => {
          const planItem: TorrentRowParsePlanItem = { key };

          const dynamicParseFuncKey = `parseTorrentRowFor${pascalCase(key as string)}` as keyof this;
          if (dynamicParseFuncKey in this && typeof this[dynamicParseFuncKey] === "function") {
            planItem.fnKey = dynamicParseFuncKey as string;
          }

          if (selectors[key]) {
            planItem.selector = selectors[key] as IElementQuery;
          }

          return planItem;
        },
      );

      this._torrentRowParsePlanCache.set(cacheKey, parsePlan);
    }

    return parsePlan;
  }

  protected async parseWholeTorrentFromRow(
    torrent: Partial<ITorrent> = {},
    row: Element | Document | object,
    searchConfig: ISearchInput,
  ): Promise<Partial<ITorrent>> {
    const { searchEntry, requestConfig } = searchConfig;

    /**
     * 对种子文件的任意非rows属性进行处理，例如 "id" 属性：
     * - 如果对应的实例中有 parseTorrentRowForId 方法，则调用该方法，注意该方法会需要返回更新后的 torrent 对象
     * - 不然则使用 selectors.id 的定义来获取，此时只更新 torrent 的id属性
     */
    for (const { key, fnKey, selector } of this.getTorrentRowParsePlan(searchEntry!)) {
      // 如果已经有值，则跳过
      if (Object.hasOwn(torrent, key)) {
        continue;
      }

      const dynamicParseFunc = fnKey ? (this as any)[fnKey] : undefined;
      if (typeof dynamicParseFunc === "function") {
        torrent = await dynamicParseFunc.call(this, torrent, row, searchConfig);
      } else if (selector) {
        // 传入 key 让返回值类型按字段推导（见 P2-4）。
        // 注意：key 在此处是字段名联合类型，TS 对「联合键赋值」会求各属性类型的交集，
        // 因此写入侧显式收窄为 Record<string, any>，读取侧仍走泛型重载。
        (torrent as Record<string, any>)[key] = this.getFieldData(row, selector, key);
      }
    }

    // 对获取到的种子进行一些通用的处理
    torrent.site ??= this.metadata.id; // 补全种子的 site 属性
    // DEF1/DEF5 证据：selector 命中但拿到空串时 `??=` 不会补全（"" 不是 nullish），会让 uniqueId 塌缩；
    // 这里按「缺失或空串」补全 id（0 仍是合法 id，不能用 falsy 判断）。
    if (torrent.id === undefined || torrent.id === null || torrent.id === "") {
      torrent.id = tryToNumber(torrent.url || torrent.link); // 补全种子的 id 属性，如果不存在，则由 url, link 属性替代
    }
    typeof torrent.url != "undefined" && (torrent.url = this.fixLink(torrent.url as string, requestConfig!));
    typeof torrent.link != "undefined" && (torrent.link = this.fixLink(torrent.link as string, requestConfig!));
    if (typeof (torrent.size as unknown) === "string") {
      torrent.size = parseSizeString(torrent.size as unknown as string);
    }
    typeof torrent.size != "undefined" && (torrent.size = tryToNumber(torrent.size));
    typeof torrent.seeders != "undefined" && (torrent.seeders = tryToNumber(torrent.seeders));
    typeof torrent.leechers != "undefined" && (torrent.leechers = tryToNumber(torrent.leechers));
    typeof torrent.completed != "undefined" && (torrent.completed = tryToNumber(torrent.completed));
    typeof torrent.comments != "undefined" && (torrent.comments = tryToNumber(torrent.comments));
    // category 不做 tryToNumber（上游 0d62ee64）：它是分类名 / 分类标识，不是数值字段，
    // 站点给出的 "401"、"007" 一类分类标识应原样保留，而不是被转成 401 / 7。
    // E19 补充：计数类字段（torrentCountFieldKeys）selector 零命中时 `getFieldData` 回落 `""`，
    // 直接写进种子对象会破坏 `ITorrent` 的 number 契约（排序/比较按字符串处理）。
    // 只在**组装种子对象**的这一步归 0（用 D2 的 normalizeNumericField），不改 `getFieldData` 的
    // 「零命中 = ""」引擎契约（站点定义有直接探测该行为的用例）。
    for (const countField of torrentCountFieldKeys) {
      const countValue = (torrent as Record<string, any>)[countField];
      if (typeof countValue === "string" && countValue.trim() === "") {
        (torrent as Record<string, any>)[countField] = normalizeNumericField(countValue, 0);
      }
    }
    typeof torrent.status == "undefined" && (torrent.status = ETorrentStatus.unknown);

    // 仅当设置了时区偏移时，才进行转换
    if (this.metadata.timezoneOffset && typeof torrent.time !== "undefined") {
      torrent.time = parseTimeWithZone(torrent.time as unknown as string, this.metadata.timezoneOffset);
    }

    // 在此基础上，不同 schema 可以复写处理过程
    torrent = this.fixParsedTorrent(torrent as ITorrent, row, searchConfig);
    return torrent;
  }

  protected parseTorrentRowForTags(
    torrent: Partial<ITorrent>,
    row: Element | Document | object,
    searchConfig: ISearchInput,
  ): Partial<ITorrent> {
    if (searchConfig?.searchEntry?.selectors?.tags) {
      const tags: ITorrentTag[] = [];
      const tagConfigs = searchConfig.searchEntry.selectors.tags;

      if (isElementNode(row)) {
        const tagSelectors = tagConfigs.map(({ selector }) => selector).filter(Boolean) as string[];

        // 合并为一次候选查询，再用 matchesSelector 判定归属，避免为每个 tag 都做一次整行 DOM 查询
        const canUseMergedQuery =
          tagSelectors.length > 0 && !tagSelectors.some((selector) => positionalSelectorPattern.test(selector));

        if (canUseMergedQuery) {
          const candidates = selectElements(tagSelectors.join(", "), row) as Element[];
          tagConfigs.forEach(({ name, color, selector }) => {
            if (candidates.some((candidate) => matchesSelector(candidate, selector))) {
              tags.push({ name, color });
            }
          });
        } else {
          // 存在位置伪类时无法用候选集等价判定，回落为逐个选择器的原实现
          tagConfigs.forEach(({ name, color, selector }) => {
            if (selectElements(selector, row).length > 0) {
              tags.push({ name, color });
            }
          });
        }
      } else {
        tagConfigs.forEach(({ name, color, selector }) => {
          if (get(row, selector)) {
            tags.push({ name, color });
          }
        });
      }

      torrent.tags = tags;
    }

    return torrent;
  }

  protected fixParsedTorrent(
    torrent: ITorrent,
    row: Element | Document | object,
    searchConfig: ISearchInput,
  ): ITorrent {
    return torrent;
  }

  /**
   * 此方法主要在 content-script 中调用，用于在种子列表页将传入的 Document 转换为种子列表和关键词
   * @param doc
   */
  public async transformListPage(doc: Document): Promise<IParsedTorrentListPage> {
    const retData = { keywords: "", torrents: [] } as IParsedTorrentListPage;

    const parsedListPageUrl = doc.URL || location.href; // 获取当前页面的 URL

    // 注意：selectors 需要浅拷贝一份局部副本，后续的删除/改写（如 delete keywords）不应污染共享的 metadata.search.selectors
    const metadataSearch = this.metadata.search ?? {};
    const searchEntry: { selectors: TSchemaMetadataListSelectors } = {
      ...metadataSearch,
      selectors: { ...(metadataSearch.selectors ?? {}) },
    };

    // 使用 list 中定义的 selectors 覆盖掉 search 中的 selectors
    for (const list of this.metadata.list ?? []) {
      const { urlPattern: listUrlPattern = [], selectors: listSelectors = {}, mergeSearchSelectors = true } = list;
      if (listUrlPattern.some((pattern) => new RegExp(pattern, "i").test(parsedListPageUrl))) {
        searchEntry.selectors = { ...(mergeSearchSelectors ? searchEntry.selectors : {}), ...listSelectors };
        break; // 找到匹配的 list 后，直接跳出循环
      }
    }

    // 如果有 keywords 选择器，则获取当前搜索页的关键词
    if (searchEntry.selectors.keywords) {
      // E18 附带项：关键词是文本，不能因为「1917」这类纯数字查询被 getFieldData 转成 number
      retData.keywords = String(this.getFieldData(doc, searchEntry.selectors.keywords as IElementQuery) ?? "");
      delete searchEntry.selectors.keywords; // 删除 keywords 选择器，避免污染后续的种子解析
    } else {
      // 参照 searchEntry 中的 keywordPath 来获取关键词
      const keywordPath = (searchEntry as ISiteMetadata["search"])!.keywordPath || "params.keywords";
      const [keywordField, keywordParams] = keywordPath.split(".");

      // 首先尝试使用 getFieldData 获取关键词
      retData.keywords = String(
        this.getFieldData(doc, {
          selector: [
            keywordField === "params" ? `input[name="${keywordParams}"]` : false,
            // E-1：这里要取的是关键词参数名（keywordParams，如 searchstr），
            // 而不是 keywordField（字面量 "data"），否则会生成 input[name="data"] 永远匹配不到。
            keywordField === "data" ? `form[method="post" i] input[name="${keywordParams}"]` : false,
          ].filter(Boolean) as string[],
          elementProcess: (el: HTMLInputElement) => el.value,
          text: "",
        }) ?? "",
      );

      // 如果没有获取到关键词，则尝试从 URL 中解析
      if (retData.keywords === "") {
        const urlParams = new URLSearchParams(parsedListPageUrl.split("?")[1] ?? "");
        for (const keywordParam of [keywordParams, "search", "keywords", "keyword", "q"].filter(Boolean)) {
          // 尝试从 URL 中获取关键词
          if (urlParams.has(keywordParam)) {
            retData.keywords = urlParams.get(keywordParam) || "";
            break;
          }
        }
      }
    }

    try {
      // 将其委托到 transformSearchPage 方法中进行处理
      retData.torrents = await this.transformSearchPage(doc, {
        searchEntry,
        requestConfig: { url: parsedListPageUrl },
      });
    } catch (e) {
      // D1-7：列表页解析失败目前没有 UI 错误通道（IParsedTorrentListPage 无 status），
      // 至少写入扩展日志（用户可导出），而不是只留在页面 console 里。
      logMessage(
        `[Site] ${this.name} transformListPage failed`,
        { site: this.metadata.id, url: parsedListPageUrl.split("?")[0], error: siteErrorLogData(e) },
        "warn",
      );
    }

    return retData;
  }

  /**
   * 此方法主要在 content-script 中调用，用于将传入的 Document 转换为种子列表
   * @param doc
   */
  public async transformDetailPage(doc: Document): Promise<ITorrent> {
    let torrent: Partial<ITorrent> = { site: this.metadata.id };
    const parsedDetailsPage = doc.cloneNode(true) as Document; // 克隆一份文档，避免污染原始文档

    // 首先使用selectors来尝试获取种子详情
    const detailsSelectors = this.metadata.detail?.selectors || {};
    torrent = toMerged(torrent, this.getFieldsData(parsedDetailsPage, detailsSelectors));

    // 如果未获取到 url，则 url 会被自动设置为 doc.URL || location.href
    if (!torrent.url) {
      torrent.url = parsedDetailsPage.URL || location.href; // 如果没有 url，则使用当前页面的 URL
    }

    // 如果未获取到 id，且 url 中有 `&id=` 或者 `&tid=` 字段，则会被自动解析为 id
    if (!torrent.id) {
      const urlParams = new URLSearchParams(torrent.url.split("?")[1] ?? "");
      for (const idParam of ["tid", "id"]) {
        // 尝试从 URL 中获取关键词
        if (urlParams.has(idParam)) {
          torrent.id = urlParams.get(idParam) || "";
          break;
        }
      }

      // 如果还是没有 id，则使用 url 作为 id
      if (!torrent.id) {
        torrent.id = torrent.url;
      }
    }

    if (!torrent.title) {
      // SITECORE-6：<title> 位于 <head>，原选择器 `html > body > title` 在标准 HTML 下恒为 0 命中，
      // getFieldData 会回落到 text: ""，于是未声明 detail.title 的站点标题永远为空且无任何告警。
      //
      // E18 复检 L-1：这里是两参数调用，`getFieldData` 会保留「数字字符串 → number」的历史兼容行为，
      // 于是纯数字标题（《1917》《2012》）在详情页路径仍会变成 number，破坏 `ITorrent.title: string`。
      // 显式传入字段名 "title" 以启用文本字段白名单（不改变其它两参数调用的兼容语义）。
      torrent.title = this.getFieldData(parsedDetailsPage, { text: "", selector: ["head > title"] }, "title");
    }

    if (torrent.link) {
      torrent.link = this.fixLink(torrent.link, { baseURL: parsedDetailsPage.URL }); // 如果 link 存在，则进行修正
    }

    return torrent as ITorrent;
  }

  /**
   * 使用该方法返回种子文件的下载链接
   * 可以在某些特殊站点通过覆写本方法，来更新搜索结果中的种子链接：
   *  - 如果在搜索页面没有提供下载链接，可以在这里进行补全
   *  - 如果搜索页面提供的下载链接有特定的生存期限，可以在这里进行更新
   * @param torrent
   */
  public async getTorrentDownloadLink(torrent: ITorrent): Promise<string> {
    let resolvedLink = torrent.link;
    let resolvedFromDetailPage = false;

    if (!resolvedLink && this.metadata?.detail?.selectors?.link) {
      // E22 复检 L-5：同一个 torrent 对象在「校验 → 下载」链路里会被连续调用两次本方法
      // （`getTorrentDownloadRequestConfig` 内部也会调），这里复用短期的详情页解析结果，
      // 避免仅靠详情页提供下载链接的站点每次都被抓两遍详情页。
      const cached = this._resolvedDownloadLinkCache.get(torrent);
      if (cached && cached.expires > Date.now()) {
        resolvedLink = cached.link;
      }
    }

    if (!resolvedLink && this.metadata?.detail?.selectors?.link) {
      if (!torrent.url || !this.isTrustedDownloadLink(torrent.url)) {
        throw new Error(`Rejected detail URL outside site host allowlist for ${this.metadata.id}`);
      }
      const { data } = await this.request<any>(
        toMerged({ responseType: "document", url: torrent.url }, this.metadata.detail?.requestConfig ?? {}),
      );
      // 显式传字段名 "link"：link 属于字符串语义字段，避免纯数字形式的链接被 getFieldData 转成 number
      resolvedLink = this.getFieldData(data, this.metadata.detail.selectors.link, "link");
      resolvedFromDetailPage = true;
    }

    // E-9：链接缺失（或 fixLink 因协议不在白名单内返回空串）时必须明确失败，
    // 否则会先拼出 "undefined<后缀>" 这类脏 URL，下游只能拿到费解的 404。
    if (!resolvedLink) {
      // 报错信息里的 url 只保留 path：详情页 URL 可能带 passkey 等凭据，不应进入 UI/日志
      const safeUrl = torrent.url ? torrent.url.split("?")[0] : "";
      throw new Error(
        `[PTD] site '${this.name}' cannot parse torrent download link (torrentId=${torrent.id ?? ""}, url=${safeUrl})`,
      );
    }

    if (resolvedFromDetailPage && typeof resolvedLink === "string") {
      this._resolvedDownloadLinkCache.set(torrent, {
        link: resolvedLink,
        expires: Date.now() + BittorrentSite.resolvedDownloadLinkCacheTtl,
      });
    }

    // E22：追加用户配置的下载链接后缀，但**不写回** torrent.link（见上）
    return this.userConfig.downloadLinkAppendix
      ? `${resolvedLink}${this.userConfig.downloadLinkAppendix}`
      : resolvedLink;
  }

  /**
   * 使用该方法返回种子文件的下载配置
   * @param torrent
   */
  public async getTorrentDownloadRequestConfig(torrent: ITorrent): Promise<AxiosRequestConfig> {
    const torrentDownloadLink = await this.getTorrentDownloadLink(torrent);
    return toMerged(
      { baseURL: this.url, url: torrentDownloadLink, method: "GET", timeout: this.userConfig.timeout ?? 30e3 },
      this.metadata.download?.requestConfig ?? {},
    );
  }
}
