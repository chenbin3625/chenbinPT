import { matchesSelector, selectElements } from "../utils/selector";
import { get, isEmpty, set } from "es-toolkit/compat";
import { chunk, pascalCase, pick, toMerged, union } from "es-toolkit";
import { type AxiosError, type AxiosRequestConfig, type AxiosResponse } from "axios";
import PQueue from "p-queue";
import { supportSocialSite } from "@ptd/social";

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
} from "../types";
import {
  definedFilters,
  filterNames,
  TQueryFilter,
  cfDecodeEmail,
  parseSizeString,
  parseTimeWithZone,
  tryToNumber,
  hasNonLatinCharacters,
  classifySiteError,
  redactSensitive,
  siteErrorLogData,
  NetworkError,
  ServerError,
} from "../utils";

export const SchemaMetadata: Partial<ISiteMetadata> = {
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
 * `//` 分支按既有逻辑会产出 `https:://host/path` 这种浏览器可容错、但 URL 解析器不保证接受的形式，
 * 重新解析会把这个既有的合法输入误判成危险链接。
 */
function hasAllowedLinkProtocol(url: string): boolean {
  const scheme = url.match(explicitSchemePattern)?.[0];
  return scheme ? allowedLinkProtocols.includes(scheme.toLowerCase()) : true;
}

// 适用于公网BT站点，同时也作为 所有站点方法 的基类
export default class BittorrentSite {
  public readonly metadata: ISiteMetadata; // 实际过程中使用的配置文件
  public readonly userConfig: ISiteUserConfig;

  // 行级选择器结果缓存：同一行内相同的选择器只求值一次（键为行元素，值为 选择器 -> 结果元素）
  private _rowElementQueryCache = new WeakMap<Element, Map<string, Element | null>>();
  // 逐字段解析计划的记忆化缓存（键为 searchEntry.selectors 对象）
  private _torrentRowParsePlanCache = new WeakMap<object, TorrentRowParsePlanItem[]>();

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

  get isOnline(): boolean {
    return !this.metadata.isDead && !this.userConfig.isOffline;
  }

  get allowSearch(): boolean {
    return this.isOnline && !!this.metadata.search && !(this.userConfig.allowSearch === false);
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

  public async request<T>(axiosConfig: AxiosRequestConfig, checkLogin: boolean = true): Promise<AxiosResponse<T>> {
    // 统一设置一些 AxiosRequestConfig， 当作默认值
    axiosConfig.baseURL ??= this.url;
    axiosConfig.url ??= "/";
    axiosConfig.timeout ??= this.userConfig.timeout ?? 30e3;

    // 如果站点有请求延迟，则等待一段时间
    await this.sleepAction(this.metadata.requestDelay ?? 0);

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
          if (doc instanceof Document && doc.documentElement.outerHTML.search("__cf_email__")) {
            const cfProtectSpan = selectElements(".__cf_email__", doc);

            cfProtectSpan.forEach((element) => {
              element.replaceWith(cfDecodeEmail((element as HTMLElement).dataset.cfemail!));
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
    console?.log(`[Site] ${this.name} start search with keywords:`, keywords, "input searchEntry:", searchEntry);
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

    console?.log(`[Site] ${this.name} start search with merged searchEntry:`, searchEntry);

    // 2.1 检查 keywords 是否为空
    if (searchEntry.skipWhiteSpacePlaceholder === true && !keywords) {
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

    console?.log(`[Site] ${this.name} start search with requestConfig:`, requestConfig);

    // 8. 请求页面并转化为document
    try {
      const req = await this.request(requestConfig);
      result.data = await this.transformSearchPage(req.data, { keywords, searchEntry, requestConfig });
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
      if (uri.startsWith("//")) {
        // 当 传入的uri 以 /{2,} 开头时，被转换成类似 https?:///xxxx/xxxx 的形式，
        // 虽不符合url规范，但是浏览器容错高，所以不用担心 2333
        const urlHelper = new URL(requestConfig.baseURL || this.url);
        url = `${urlHelper.protocol}:${uri}`;
      } else if (uri.slice(0, 4) !== "http") {
        // 基于请求地址，处理 ./xxx, xxxx, /xxxx 等相对路径
        const requestUrl = axios.getUri(requestConfig);
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
  >(element: Element | object, selectors: S, fields?: (keyof S)[]): { [key in keyof S]?: any } {
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
      retRecord[key] = this.getFieldData(element, selector, key as keyof Omit<ITorrent, "site">);
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
    if (!(element instanceof Element)) {
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

        if (element instanceof Node) {
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
        if (selectors.length > 0 && elementQuery.switchFilters?.[usedSelector!]) {
          query = this.runQueryFilters(query, elementQuery.switchFilters[usedSelector!]);
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
      if (/^-?\d+$/.test(query)) {
        // 尽可能的将返回值转成数字类型
        query = isNaN(parseInt(query)) ? 0 : parseInt(query);
      }
    } else if (typeof query === "number") {
      query = isNaN(query) ? 0 : query;
    }

    return query;
  }

  protected runQueryFilters<T>(query: any, filters: TQueryFilter[] | TQueryFilter): T {
    const realFilters = ([] as TQueryFilter[]).concat(filters);
    for (const realFilter of realFilters) {
      if (typeof realFilter === "function") {
        query = realFilter(query);
      } else if (realFilter?.name) {
        const { name, args = [] } = realFilter;
        if (filterNames.includes(name)) {
          query = definedFilters[name](query, args);
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
      if (options.isJson || !(context instanceof Document)) {
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
    let trs = this.findElementsBySelectors(rowsSelector.selector, doc, { isJson: !(doc instanceof Document) });

    if (doc instanceof Document) {
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
        torrents.push((await this.parseWholeTorrentFromRow({}, tr, searchConfig!)) as ITorrent);
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
    const selectors = searchEntry!.selectors! as Record<string, any>;
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
    torrent.id ??= tryToNumber(torrent.url || torrent.link); // 补全种子的 id 属性，如果不存在，则由 url, link 属性替代
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
    typeof torrent.category != "undefined" && (torrent.category = tryToNumber(torrent.category));
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

      if (row instanceof Element) {
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
      if (listUrlPattern.some((pattern) => new RegExp(pattern!, "i").test(parsedListPageUrl))) {
        searchEntry.selectors = { ...(mergeSearchSelectors ? searchEntry.selectors : {}), ...listSelectors };
        break; // 找到匹配的 list 后，直接跳出循环
      }
    }

    // 如果有 keywords 选择器，则获取当前搜索页的关键词
    if (searchEntry.selectors.keywords) {
      retData.keywords = this.getFieldData(doc, searchEntry.selectors.keywords as IElementQuery);
      delete searchEntry.selectors.keywords; // 删除 keywords 选择器，避免污染后续的种子解析
    } else {
      // 参照 searchEntry 中的 keywordPath 来获取关键词
      const keywordPath = (searchEntry as ISiteMetadata["search"])!.keywordPath || "params.keywords";
      const [keywordField, keywordParams] = keywordPath.split(".");

      // 首先尝试使用 getFieldData 获取关键词
      retData.keywords = this.getFieldData(doc, {
        selector: [
          keywordField === "params" ? `input[name="${keywordParams}"]` : false,
          // E-1：这里要取的是关键词参数名（keywordParams，如 searchstr），
          // 而不是 keywordField（字面量 "data"），否则会生成 input[name="data"] 永远匹配不到。
          keywordField === "data" ? `form[method="post" i] input[name="${keywordParams}"]` : false,
        ].filter(Boolean) as string[],
        elementProcess: (el: HTMLInputElement) => el.value,
        text: "",
      });

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
      console.error(`[PTD] site '${this.name}' transformListPage Error:`, e);
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
      torrent.title = this.getFieldData(parsedDetailsPage, { text: "", selector: ["html > body > title"] });
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
    if (!torrent.link && this.metadata?.detail?.selectors?.link) {
      const { data } = await this.request<any>(
        toMerged({ responseType: "document", url: torrent.url }, this.metadata.detail?.requestConfig ?? {}),
      );
      torrent.link = this.getFieldData(data, this.metadata.detail.selectors.link) as string;
    }

    // E-9：链接缺失（或 fixLink 因协议不在白名单内返回空串）时必须明确失败，
    // 否则会先拼出 "undefined<后缀>" 这类脏 URL，下游只能拿到费解的 404。
    if (!torrent.link) {
      // 报错信息里的 url 只保留 path：详情页 URL 可能带 passkey 等凭据，不应进入 UI/日志
      const safeUrl = torrent.url ? torrent.url.split("?")[0] : "";
      throw new Error(
        `[PTD] site '${this.name}' cannot parse torrent download link (torrentId=${torrent.id ?? ""}, url=${safeUrl})`,
      );
    }

    if (this.userConfig.downloadLinkAppendix) {
      // 如果用户配置了下载链接后缀，则在链接后追加
      torrent.link = `${torrent.link}${this.userConfig.downloadLinkAppendix}`;
    }

    return torrent.link;
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
