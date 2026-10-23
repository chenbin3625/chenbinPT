import { nanoid } from "nanoid";
import { defineStore } from "pinia";
import { cloneDeep } from "es-toolkit";
import { isEmpty, set } from "es-toolkit/compat";
import { toRaw } from "vue";
import { i18n } from "@/options/plugins/i18n.ts";
import {
  getHostFromUrl,
  getDefinedSiteMetadata,
  type ISearchCategories,
  type ISearchEntryRequestConfig,
  type ISiteMetadata,
  type ISiteUserConfig,
  type TSiteHost,
  type TSiteID,
} from "@ptd/site";

import {
  IBackupServerMetadata,
  IDownloaderMetadata,
  IMediaServerMetadata,
  IMetadataPiniaStorageSchema,
  ISearchSolution,
  TDownloaderKey,
  TMediaServerKey,
  TSearchSnapshotKey,
  TSolutionKey,
  ISearchSolutionMetadata,
} from "@/shared/types.ts";
import { sendMessage } from "@/messages.ts";
import { useConfigStore } from "@/options/stores/config.ts";
import { useRuntimeStore } from "@/options/stores/runtime.ts";
import { registerMetadataStoreAccessor } from "./metadataStoreBridge.ts";
import { buildSearchSolutionFromCategories } from "@/options/utils/searchSolutionConfig.ts";

type TSimplePatchFieldKey = keyof Pick<
  IMetadataPiniaStorageSchema,
  "sites" | "solutions" | "snapshots" | "downloaders" | "mediaServers" | "backupServers"
>;

/** 去抖写入只需要插件的 `$save()`，不依赖 pinia 的内部结构（也便于在单测里替换） */
type TSaveableStore = {
  $save: (newState?: unknown, options?: { skipMerge?: boolean }) => Promise<void>;
};

/* ------------------------------------------------------------------ *
 * F1-01（原 D1-High-14 残余）：搜索方案里 `searchEntries` 的请求地址安全化。
 *
 * 背景：搜索方案可以被导出/导入（`SetSearchSolution/Index.vue` 的导入只做形状校验），
 * 而 `searchEntries[*].requestConfig` 会作为 `advanceKeywordConfig` 一路传到站点实例、
 * 被 `toMerged` 进最终 axios 配置。若方案里带 `requestConfig.url / baseURL` 指向外部地址，
 * 多个站点定义又会在 `request()` 里无条件注入凭据（x-api-key / APITOKEN / passkey …），
 * 导入他人方案后搜索一次就会把本机凭据发到对方服务器。
 *
 * 这里在 **store 层**统一收口（写入与读取两条路径都过一遍，覆盖已有的坏数据）：
 * - `requestConfig.headers` 一律丢弃（方案不需要自定义请求头，它只是"转向外站后带凭据"的通道）；
 * - `requestConfig.url / baseURL` 只允许「站点内相对路径」或「站点定义声明过的 host」（镜像站，
 *   例如 nyaa 的 `baseURL` 分类会取 siteMetadata.urls 里的镜像地址）；
 * - `selectedCategories` 的取值必须是站点定义 `category.options` 里声明过的值（或数组子集）；
 *   这挡住 `#url` / `baseURL` 这类"分类值直接变成请求地址"的分类被写成任意外站地址；
 * - 读取时（`refreshSavedSearchSolutionItem`）自身 entry 一律按 `selectedCategories` **整份重建**，
 *   导入的 `requestConfig` 不再参与合并（否则 `selectedCategories:{}`/分类被清空时它会原样残留）。
 * ------------------------------------------------------------------ */
type TSafeRequestConfigHosts = Set<string>;

/** I-9：`set()` 点路径里绝不允许出现的段（会造成原型链写入） */
const UNSAFE_PATH_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

function isPlainObjectRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pickStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** 站点定义声明过的所有 host（含 legacyUrls），用于判定绝对地址是否仍属于本站点 */
function collectSiteUrlHosts(siteMetadata?: ISiteMetadata | null): TSafeRequestConfigHosts {
  const hosts = new Set<string>();
  const urls = [...pickStringArray(siteMetadata?.urls), ...pickStringArray(siteMetadata?.legacyUrls)];
  for (const url of urls) {
    try {
      const { host } = new URL(url);
      if (host) hosts.add(host.toLowerCase());
    } catch {
      // 站点定义里的 url 可能是被加密/占位的形式，解析失败就跳过（该站点只允许相对路径）
    }
  }
  return hosts;
}

/**
 * `requestConfig.url` / `baseURL` 是否安全：
 * - 相对路径（"search/x"、"/search"）会拼到站点 baseURL 上 → 安全；
 * - 协议相对地址（"//host/..."）会跳到外站 → 不安全；
 * - 绝对地址只有 host 属于站点定义声明过的镜像时才安全。
 */
function isSafeSolutionRequestUrl(value: unknown, allowedHosts: TSafeRequestConfigHosts): boolean {
  if (typeof value !== "string") return false;
  const url = value.trim();
  if (url === "" || url.startsWith("//")) return false;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) return true; // 相对路径
  try {
    const { host } = new URL(url);
    return host !== "" && allowedHosts.has(host.toLowerCase());
  } catch {
    return false;
  }
}

/** 剥离方案 entry 中可能把请求转向外站的 axios 配置，其余字段原样保留 */
function sanitizeSolutionEntry(entry: unknown, allowedHosts: TSafeRequestConfigHosts): ISearchEntryRequestConfig {
  if (!isPlainObjectRecord(entry)) return {};
  const next: Record<string, any> = { ...entry };
  const requestConfig = next.requestConfig;
  if (isPlainObjectRecord(requestConfig)) {
    const safeRequestConfig: Record<string, any> = {};
    for (const [key, value] of Object.entries(requestConfig)) {
      if (key === "headers") continue;
      if ((key === "url" || key === "baseURL") && !isSafeSolutionRequestUrl(value, allowedHosts)) continue;
      safeRequestConfig[key] = value;
    }
    next.requestConfig = safeRequestConfig;
  }
  return next as ISearchEntryRequestConfig;
}

function sanitizeSolutionSearchEntries(
  entries: unknown,
  allowedHosts: TSafeRequestConfigHosts,
): Record<string, ISearchEntryRequestConfig> {
  if (!isPlainObjectRecord(entries)) return {};
  const result: Record<string, ISearchEntryRequestConfig> = {};
  for (const [name, entry] of Object.entries(entries)) {
    if (name === "__proto__" || name === "constructor" || name === "prototype") continue;
    result[name] = sanitizeSolutionEntry(entry, allowedHosts);
  }
  return result;
}

/** entry 里是否真的存在 url / baseURL（没有就不必加载站点定义，省掉一次 cloneDeep） */
function hasSolutionEntryUrl(entries: unknown): boolean {
  if (!isPlainObjectRecord(entries)) return false;
  return Object.values(entries).some((entry) => {
    const requestConfig = (entry as any)?.requestConfig;
    return (
      isPlainObjectRecord(requestConfig) &&
      (typeof requestConfig.url === "string" || typeof requestConfig.baseURL === "string")
    );
  });
}

/** I/L5：读取路径里「因站点定义更新而不再匹配」的分类被丢弃时记录一次，供 UI 提示 */
export interface IDroppedSearchSolutionCategoryNotice {
  solutionId?: string;
  siteId?: string;
  /** 被丢弃的分类 key（已按 solution+site+key 去重） */
  droppedCategories: string[];
}

const droppedSearchSolutionCategoryNotices: IDroppedSearchSolutionCategoryNotice[] = [];
let droppedSearchSolutionCategoryNoticeKeys = new Set<string>();

/**
 * I/L5：取走「已选分类被静默丢弃」的提示记录（消费后清空，避免每次读方案都重复提示）。
 *
 * 站点定义更新（本轮改了 341 个定义）后，旧方案里不在新 `category.options` 中的取值会被
 * 白名单过滤掉；过滤本身是安全需要，但旧实现完全静默 —— 用户只看到过滤条件少了。
 */
export function consumeDroppedSearchSolutionCategoryNotices(): IDroppedSearchSolutionCategoryNotice[] {
  const notices = droppedSearchSolutionCategoryNotices.map((notice) => ({
    ...notice,
    droppedCategories: [...notice.droppedCategories],
  }));
  droppedSearchSolutionCategoryNotices.length = 0;
  droppedSearchSolutionCategoryNoticeKeys = new Set();
  return notices;
}

function recordDroppedSearchSolutionCategories(
  context: { solutionId?: string; siteId?: string } | undefined,
  droppedCategories: string[],
): void {
  if (!context || droppedCategories.length === 0) return;
  const dedupeKey = `${context.solutionId ?? ""}|${context.siteId ?? ""}`;
  const existing = droppedSearchSolutionCategoryNotices.find(
    (notice) => `${notice.solutionId ?? ""}|${notice.siteId ?? ""}` === dedupeKey,
  );
  const notice = existing ?? { solutionId: context.solutionId, siteId: context.siteId, droppedCategories: [] };
  for (const key of droppedCategories) {
    const uniqueKey = `${dedupeKey}|${key}`;
    if (droppedSearchSolutionCategoryNoticeKeys.has(uniqueKey)) continue;
    droppedSearchSolutionCategoryNoticeKeys.add(uniqueKey);
    notice.droppedCategories.push(key);
  }
  if (!existing) droppedSearchSolutionCategoryNotices.push(notice);
}

/**
 * 校验 `selectedCategories`：取值必须来自站点定义的可选项。
 * 没有 options 的分类（完全由 `generateRequestConfig` 处理）无法白名单校验，
 * 但至少要求是原始值（string / number / 数组），拒绝对象等结构。
 *
 * I/L5：被丢弃的分类会通过 `context` 记录一条提示（见 recordDroppedSearchSolutionCategories）。
 */
function sanitizeSolutionSelectedCategories(
  categories: ISearchCategories[],
  selectedCategories: Record<string, any>,
  context?: { solutionId?: string; siteId?: string },
): Record<string, any> {
  const result: Record<string, any> = {};
  const droppedCategories: string[] = [];

  for (const category of categories) {
    if (!Object.hasOwn(selectedCategories, category.key)) continue;
    const value = selectedCategories[category.key];
    const options = category.options ?? [];

    if (options.length === 0) {
      if (typeof value === "string" || typeof value === "number") {
        result[category.key] = value;
      } else if (Array.isArray(value)) {
        const kept = value.filter((item) => typeof item === "string" || typeof item === "number");
        if (kept.length > 0) result[category.key] = kept;
        if (kept.length !== value.length) droppedCategories.push(category.key);
      }
      continue;
    }

    const allowed = new Set(options.map((option) => option.value));
    if (Array.isArray(value)) {
      const kept = value.filter((item) => allowed.has(item as any));
      if (kept.length > 0) result[category.key] = kept;
      if (kept.length !== value.length) droppedCategories.push(category.key);
    } else if (allowed.has(value)) {
      result[category.key] = value;
    } else {
      droppedCategories.push(category.key);
    }
  }

  recordDroppedSearchSolutionCategories(context, droppedCategories);
  return result;
}

/**
 * F1-01：把一条搜索方案条目安全化（**不重建**，只剥离危险字段）。
 * 写入路径（`addSearchSolution`，导入/自定义方案都走这里）用它，避免坏数据被落盘、再被导出分享。
 */
async function sanitizeSearchSolutionItem(solutionItem: ISearchSolution): Promise<ISearchSolution> {
  let siteMetadata: ISiteMetadata | undefined;
  try {
    siteMetadata = await getDefinedSiteMetadata(solutionItem.siteId);
  } catch {
    // 站点定义不在构建产物里：仍然做「相对路径/无 headers」的基础安全化
    siteMetadata = undefined;
  }

  const allowedHosts = collectSiteUrlHosts(siteMetadata);
  const next: ISearchSolution = {
    ...solutionItem,
    searchEntries: sanitizeSolutionSearchEntries(solutionItem.searchEntries, allowedHosts),
  };

  if (siteMetadata && solutionItem.selectedCategories) {
    next.selectedCategories = sanitizeSolutionSelectedCategories(
      siteMetadata.category ?? [],
      solutionItem.selectedCategories,
      { solutionId: solutionItem.id, siteId: solutionItem.siteId },
    ) as ISearchSolution["selectedCategories"];
  }

  return next;
}

async function refreshSavedSearchSolutionItem(solutionItem: ISearchSolution): Promise<ISearchSolution> {
  const rawEntries = solutionItem.searchEntries ?? {};
  // 只有需要重建分类或 entry 里真的带 url/baseURL 时才去加载站点定义（绝大多数方案只有 params，零额外开销）
  const needsSiteMetadata = !!solutionItem.selectedCategories || hasSolutionEntryUrl(rawEntries);

  let siteMetadata: ISiteMetadata | undefined;
  if (needsSiteMetadata) {
    try {
      siteMetadata = await getDefinedSiteMetadata(solutionItem.siteId);
    } catch {
      // 站点定义已不在构建产物里（B-13 同类场景）：无法重建，退化为「只剥离危险请求字段」
      siteMetadata = undefined;
    }
  }

  const allowedHosts = collectSiteUrlHosts(siteMetadata);
  const sanitizedEntries = sanitizeSolutionSearchEntries(rawEntries, allowedHosts);

  if (!solutionItem.selectedCategories || !siteMetadata) {
    return { ...solutionItem, searchEntries: sanitizedEntries };
  }

  const categories = siteMetadata.category ?? [];
  const safeSelectedCategories = sanitizeSolutionSelectedCategories(categories, solutionItem.selectedCategories, {
    solutionId: solutionItem.id,
    siteId: solutionItem.siteId,
  });
  const { requestConfig: regeneratedEntry } = buildSearchSolutionFromCategories(categories, safeSelectedCategories);
  // 自身 entry 以 selectedCategories 为准整份重建：导入的 requestConfig 直接丢弃
  const restCurrentEntry = { ...(sanitizedEntries[solutionItem.id] ?? {}) };
  delete restCurrentEntry.requestConfig;

  return {
    ...solutionItem,
    selectedCategories: safeSelectedCategories as ISearchSolution["selectedCategories"],
    searchEntries: {
      ...sanitizedEntries,
      [solutionItem.id]: sanitizeSolutionEntry({ ...restCurrentEntry, ...regeneratedEntry }, allowedHosts),
    },
  };
}

/**
 * V-8：metadata 写入的短去抖合并（对照 runtime.ts 的 sessionStorage 500ms 节流）。
 *
 * 设置页每点一个开关都会走 `simplePatch` → `$save()`，而 `$save()` 会
 * `toWriteSnapshot(整份 state)` 全量序列化（含所有站点配置与 lastUserInfo）并把整个
 * `"metadata"` key 写回 —— runtime.ts 早已因为同样的原因专门脱离了这条路径。
 * 这里在调用方侧加一层 500ms 合并窗口 + pagehide/visibilitychange flush：
 * - 窗口内的多次保存只落盘一次（连续开关、批量导入/删除都合并成一次写入）；
 * - **刻意不返回 Promise**：像 runtime.ts 的 schedulePersist 一样是「登记待保存」，
 *   调用方不会被去抖窗口阻塞（否则逐个 await addSite 的批量导入会变成每个站点 500ms）；
 *   需要「返回即已落盘」的场景继续直接用 `metadataStore.$save()`（插件语义未变）。
 * - webExtPersistence 自身的回声抑制与「单飞 + 尾部合并」保持不变，这里只减少调用次数。
 *
 * 按 store 实例分别记录（而不是模块级单例），这样多个 pinia 实例（如单测）也不会互相顶掉写入。
 */
const SAVE_MERGE_DELAY = 500;

const pendingSaveTimers = new Map<TSaveableStore, ReturnType<typeof setTimeout>>();

function flushMetadataSave(store: TSaveableStore, skipMerge = false): void {
  const timer = pendingSaveTimers.get(store);
  if (timer === undefined) {
    return;
  }
  // 先摘除再写盘：写盘期间新到的调用会重新排一次窗口，不会被本次 flush 吞掉
  pendingSaveTimers.delete(store);
  clearTimeout(timer);

  // 写盘失败由 webExtPersistence 记录（doWrite 内部 catch），这里无需等待结果
  void store.$save(undefined, skipMerge ? { skipMerge: true } : undefined);
}

/** 立即落盘所有待保存的 store（页面卸载/隐藏时调用） */
function flushAllMetadataSaves(): void {
  [...pendingSaveTimers.keys()].forEach((store) => flushMetadataSave(store, true));
}

function scheduleMetadataSave(store: TSaveableStore): void {
  if (pendingSaveTimers.has(store)) {
    return; // 已在本轮合并窗口内，等窗口结束时会写入最新 state
  }

  const timer = setTimeout(() => {
    flushMetadataSave(store);
  }, SAVE_MERGE_DELAY);
  pendingSaveTimers.set(store, timer);
}

// 页面被关闭/切到后台时立即落盘，避免去抖窗口内的改动丢失（与 runtime.ts 的做法一致）
try {
  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("pagehide", flushAllMetadataSaves);
    document?.addEventListener?.("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        flushAllMetadataSaves();
      }
    });
  }
} catch {
  // ignore
}

/**
 * V-7：站点映射重建的合并状态。
 *
 * `addSite`/`removeSite` 每次都会重建整张站点映射：`buildSiteNameMap` 对每个站点调用
 * `getSiteName`（动态 import + cloneDeep 站点定义），`buildSiteHostMap` 再遍历一次；
 * 而 `components/DeleteDialog.vue` 用 `Promise.allSettled` 并发调用 `removeSite` ——
 * 删 50 个站点就是 50 轮 O(N) 全量重建（外加 50 次整状态写入，已由上面的去抖合并）。
 *
 * 这里按 store 实例记录「站点变更版本号」，让并发调用共享同一轮重建，并在重建期间仍有
 * 变更时补跑一轮：50 次并发删除最多重建 2 轮，且每个调用返回时映射已覆盖自己的变更。
 * 用 WeakMap 而不是 pinia state —— 其中包含 Promise，既不该响应式追踪也不该被持久化。
 */
interface ISiteMapRebuildState {
  version: number; // 最近一次站点变更（addSite/removeSite）的版本号
  builtVersion: number; // 最近一次完成的重建所覆盖的版本号
  inFlight: Promise<void> | null; // 正在进行的重建
}

const siteMapRebuildStates = new WeakMap<object, ISiteMapRebuildState>();

function getSiteMapRebuildState(store: object): ISiteMapRebuildState {
  let state = siteMapRebuildStates.get(store);
  if (!state) {
    // builtVersion 从 -1 开始：首次调用必定重建一次（与修复前的行为一致）
    state = { version: 0, builtVersion: -1, inFlight: null };
    siteMapRebuildStates.set(store, state);
  }
  return state;
}

/**
 * OPTIONSSHELL-2：站点定义不可用时的提示（按 store 去重）。
 *
 * `state.sites` 里可能残留「已从构建产物移除」的站点 id（扩展升级删掉定义、站点改名后用户配置仍在），
 * 对这类站点取元数据会抛 TypeError。映射重建改成逐站点降级后，同一个坏站点会在每次
 * addSite/removeSite 重建时再次命中 —— 这里按 store 记录已提示过的站点，只在出现新的失败站点时提示一次，
 * 避免连续删除/批量导入时反复弹同一条提示（与 MyData/utils/siteMetadata.ts 的做法一致）。
 */
const reportedUnavailableSiteIds = new WeakMap<object, Set<TSiteID>>();

function reportUnavailableSiteIds(store: object, failedSiteIds: TSiteID[]): void {
  if (failedSiteIds.length === 0) {
    return;
  }

  let reported = reportedUnavailableSiteIds.get(store);
  if (!reported) {
    reported = new Set();
    reportedUnavailableSiteIds.set(store, reported);
  }

  const newFailedSiteIds = failedSiteIds.filter((siteId) => !reported.has(siteId));
  if (newFailedSiteIds.length === 0) {
    return;
  }
  newFailedSiteIds.forEach((siteId) => reported.add(siteId));

  const showSites = newFailedSiteIds.slice(0, 5).join("、");
  const moreText = newFailedSiteIds.length > 5 ? i18n.t("common.moreSites", { count: newFailedSiteIds.length }) : "";
  // 复用 MyData 侧已有的同一句「站点定义不可用」文案，不为这一条提示去改不属于本包的 locale 文件
  useRuntimeStore().showSnakebar(i18n.t("MyData.siteMetadataLoadFailed", { sites: showSites, more: moreText }), {
    color: "error",
  });
}

export const useMetadataStore = defineStore("metadata", {
  persistWebExt: true,
  state: (): IMetadataPiniaStorageSchema => ({
    sites: {},
    solutions: {},
    snapshots: {},
    downloaders: {},
    mediaServers: {},
    backupServers: {},

    defaultSolutionId: "default",
    defaultDownloader: {},

    lastSearchFilter: "",
    lastUserInfo: {},
    lastDownloader: {},
    lastKeepUpload: {},
    lastUserInfoAutoFlushAt: 0,

    siteHostMap: {},
    siteNameMap: {},
  }),

  getters: {
    getAddedSiteIds(state) {
      return Object.keys(state.sites);
    },

    getAddedSites(state) {
      return Object.entries(state.sites).map(([siteId, metadata]) => {
        return { ...metadata, id: siteId };
      });
    },

    getSortedAddedSites(state): Array<ISiteUserConfig & { id: string }> {
      // F1（原 D1-Low-10）：先复制再排序。直接 `this.getAddedSites.sort()` 会原地改写
      // 另一个 getter 的 computed 缓存数组，任何调用过本 getter 的地方都会连带改变
      // `getAddedSites` 的返回顺序（与 getSortedEnabledDownloadersBySite 的写法对齐）。
      return [...this.getAddedSites].sort((a, b) => {
        return (b.sortIndex ?? 0) - (a.sortIndex ?? 0);
      });
    },

    getSitesGroupData(state) {
      const sitesGroupData: Record<string, TSiteID[]> = {};
      for (const siteId in state.sites) {
        const site = state.sites[siteId];
        if (site.groups) {
          for (const group of site.groups) {
            sitesGroupData[group] ??= [];
            sitesGroupData[group].push(siteId);
          }
        }
      }
      return sitesGroupData;
    },

    getSiteMetadata(state) {
      return async (siteId: TSiteID): Promise<ISiteMetadata> => {
        return await getDefinedSiteMetadata(siteId);
      };
    },

    getSiteUserConfig(state) {
      return async (siteId: TSiteID, flush: boolean = false): Promise<ISiteUserConfig> => {
        const siteUserConfig = state.sites[siteId] ?? {};
        if (flush || isEmpty(siteUserConfig)) {
          return await sendMessage("getSiteUserConfig", { siteId, flush });
        }
        return siteUserConfig;
      };
    },

    getSiteMergedMetadata(state) {
      return async <T extends keyof ISiteMetadata>(
        siteId: TSiteID,
        field: T,
        defaultValue?: ISiteMetadata[T],
      ): Promise<ISiteMetadata[T]> => {
        const siteConfig = await this.getSiteUserConfig(siteId);
        if (siteConfig.merge?.[field]) {
          return siteConfig.merge[field];
        }
        const siteMetadata = await this.getSiteMetadata(siteId);
        return siteMetadata[field] ?? (defaultValue as ISiteMetadata[T]);
      };
    },

    getSiteName(state) {
      return async (siteId: TSiteID): Promise<string> => {
        return await this.getSiteMergedMetadata(siteId, "name", siteId);
      };
    },

    getSiteUrl(state) {
      return async (siteId: TSiteID): Promise<string> => {
        const siteConfig = await this.getSiteUserConfig(siteId);
        if (siteConfig.url) {
          return siteConfig.url;
        }
        const siteMetadata = await this.getSiteMetadata(siteId);
        return siteMetadata.urls?.[0] ?? "#";
      };
    },

    getSiteCategory(state) {
      return async (siteId: TSiteID, categoryKey?: string): Promise<ISearchCategories | ISearchCategories[]> => {
        const siteMetadataCategory = await this.getSiteMergedMetadata(siteId, "category", []);
        if (categoryKey) {
          return siteMetadataCategory?.find((x) => x.key === categoryKey) as ISearchCategories;
        }
        return siteMetadataCategory as ISearchCategories[];
      };
    },

    getSiteCategoryName(state) {
      return async (siteId: TSiteID, categoryKey: string): Promise<string> => {
        const siteMetadataCategory = (await this.getSiteCategory(siteId, categoryKey)) as ISearchCategories;
        return siteMetadataCategory?.name ?? categoryKey;
      };
    },

    getSiteCategoryOptionName(state) {
      return async (
        siteId: TSiteID,
        categoryKey: string,
        optionKey: string | number | (string | number)[],
      ): Promise<string> => {
        const siteMetadataCategory = (await this.getSiteCategory(siteId, categoryKey)) as ISearchCategories;
        const options = siteMetadataCategory?.options ?? [];
        if (Array.isArray(optionKey)) {
          return optionKey.map((v) => options.find((o) => o.value === v)?.name ?? v).join(", ");
        } else {
          return options.find((o) => o.value === optionKey)?.name ?? (optionKey as string);
        }
      };
    },

    getSearchSolutionIds(state) {
      return Object.keys(state.solutions);
    },

    getSearchSolutions(state) {
      return Object.values(state.solutions);
    },

    getSiteDefaultSearchSolution(state) {
      // 如果站点 isDead 或者 isOffline 则不返回搜索方案（ undefined ），调用该方法的地方需要额外判断
      return async (siteId: TSiteID): Promise<Record<string, ISearchEntryRequestConfig> | undefined> => {
        // B-13：站点配置可能不存在 —— 方案里引用的站点已被 removeSite 删除，或方案来自导入/备份/
        // URL 深链（site:xxx）指向了未添加的站点。修复前这里是裸解引用，而下面的
        // getDefinedSiteMetadata 对不在构建产物里的站点 id 会抛 TypeError → 整次搜索中断。
        const siteUserConfig = state.sites[siteId];
        if (!siteUserConfig) {
          return;
        }
        const siteMetadata = await getDefinedSiteMetadata(siteId);

        if (siteUserConfig.isOffline || siteMetadata.isDead) {
          return;
        }

        let searchEntries = siteMetadata.searchEntry ?? { default: {} };
        for (const [key, value] of Object.entries(siteUserConfig?.merge?.searchEntry ?? {})) {
          if (searchEntries[key] && typeof value.enabled === "boolean") {
            /**
             * 由于我们需要通过 sendMessage 向 offscreen 发送搜索方案，然而 sendMessage 不支持 Function 等复杂类型，
             * 所以我们这里只传递 id, name, enabled，其他的搜索方案的内容在 站点实例里面组合
             */
            searchEntries[key] = { id: key, name: searchEntries[key].name, enabled: value.enabled };
          }
        }
        return searchEntries;
      };
    },

    getSearchSolution(state) {
      return async (
        solutionId: TSolutionKey | `site:${string}` | "default" | "all",
      ): Promise<ISearchSolutionMetadata | undefined> => {
        // 首先判断是否是约定的 "all"  "default"  "site:xxx,xxx" 站点搜索方案
        if (
          // 全部站点
          solutionId === "all" ||
          (solutionId === "default" && state.defaultSolutionId === "default") ||
          // 特定站点
          solutionId.startsWith("site:")
        ) {
          const solutions: ISearchSolution[] = [];

          let addedSiteIds = Object.keys(state.sites);
          if (solutionId.startsWith("site:")) {
            addedSiteIds = solutionId
              .slice(5) //  /^site:/
              .split(",")
              .map((id) => id.trim());
          }

          for (const siteId of addedSiteIds) {
            const searchEntries = await this.getSiteDefaultSearchSolution(siteId);
            if (searchEntries) {
              solutions.push({ id: "default", siteId, searchEntries });
            }
          }

          return {
            name: "all",
            id: solutionId.startsWith("site:") ? (solutionId as `site:${string}`) : "all",
            sort: 0,
            enabled: true,
            isDefault: true,
            createdAt: 0,
            solutions,
          };
        } else if (solutionId === "default") {
          // 如果 solutionId 是 "default"，则使用默认的搜索方案 ID
          solutionId = state.defaultSolutionId;
        }

        // B-13：方案不存在时返回 undefined，而不是抛 TypeError。
        // 调用方本来就处理了这种情况（SearchEntity/utils/search.ts 的「搜索方案不存在」提示、
        // SetSearchSolution/Index.vue 的 `if (!toCopy) return`），修复前它们是不可达的死代码。
        const solution = state.solutions[solutionId];
        if (!solution) {
          return undefined;
        }

        // 对于已经存在的搜索方案，其中如果有 id === "default" 的特殊情况，将其动态解开。
        //
        // B-8：getter 内**绝不改写** state.solutions —— 修复前这里把截断后的数组写回 `solution.solutions`
        // （state 活引用），而 getSiteDefaultSearchSolution 在站点 isOffline/isDead/已删除时返回 undefined，
        // 于是「取不到就整条丢弃」会永久删除用户方案里的站点（该函数在每次搜索开始时都会被调用，
        // 随后任意 $save() 就会把删减结果落盘）。这里只构造本地数组并返回浅拷贝。
        const solutionItems: ISearchSolution[] = [];
        for (const solutionItem of solution.solutions) {
          if (solutionItem.id === "default") {
            const searchEntries = await this.getSiteDefaultSearchSolution(solutionItem.siteId);
            if (searchEntries) {
              solutionItems.push({ ...solutionItem, searchEntries });
            }
          } else {
            solutionItems.push(await refreshSavedSearchSolutionItem(solutionItem));
          }
        }

        return { ...solution, solutions: solutionItems };
      };
    },

    getSearchSolutionName(state) {
      return (solutionId: TSolutionKey): string => {
        if (solutionId === "all") {
          // F1（原 D1-Low-11）：不再硬编码 "全站"；复用顶栏搜索方案下拉里同一个 i18n key
          return i18n.t("layout.header.searchPlan.all");
        }

        return state.solutions[solutionId]?.name ?? solutionId;
      };
    },

    getSearchSnapshotList(state) {
      return Object.values(state.snapshots);
    },

    getSearchSnapshotData(state) {
      return async (id: TSearchSnapshotKey) => {
        const snapshotInfo = state.snapshots[id];
        if (snapshotInfo?.id) {
          return await sendMessage("getSearchResultSnapshotData", id);
        } else {
          const runtimeStorage = useRuntimeStore();
          runtimeStorage.showSnakebar(i18n.t("SearchResultSnapshot.notFound"), { color: "error" });
          return;
        }
      };
    },

    getDownloaderIds(state) {
      return Object.keys(state.downloaders);
    },

    getDownloaders(state) {
      return Object.values(state.downloaders);
    },

    getEnabledDownloaders(state) {
      return Object.values(state.downloaders).filter((downloader) => downloader.enabled);
    },

    getSortedEnabledDownloaders(state): Array<IDownloaderMetadata> {
      // F1（原 D1-Low-10）：复制后排序，避免原地改写 getEnabledDownloaders 的缓存数组
      return [...this.getEnabledDownloaders].sort((a, b) => {
        return (b.sortIndex ?? 0) - (a.sortIndex ?? 0);
      });
    },

    getEnabledDownloadersBySite(state) {
      return (siteId: string): IDownloaderMetadata[] => {
        const configStore = useConfigStore();
        if (!configStore.download.allowDownloaderFilterForSite) {
          return this.getEnabledDownloaders;
        }
        return this.getEnabledDownloaders.filter((d) => !d.excludedSites?.includes(siteId));
      };
    },

    getSortedEnabledDownloadersBySite(state) {
      return (siteId: string): IDownloaderMetadata[] => {
        return [...this.getEnabledDownloadersBySite(siteId)].sort((a, b) => {
          return (b.sortIndex ?? 0) - (a.sortIndex ?? 0);
        });
      };
    },

    getMediaServerIds(state) {
      return Object.keys(state.mediaServers);
    },

    getMediaServers(state) {
      return Object.values(state.mediaServers);
    },

    getEnabledMediaServers(state) {
      return Object.values(state.mediaServers).filter((mediaServer) => mediaServer.enabled);
    },

    getBackupServerIds(state) {
      return Object.keys(state.backupServers);
    },

    getBackupServers(state) {
      return Object.values(state.backupServers);
    },
  },
  actions: {
    async simplePatch<
      Field extends TSimplePatchFieldKey,
      Id extends keyof IMetadataPiniaStorageSchema[Field],
      Key extends keyof IMetadataPiniaStorageSchema[Field][Id],
      Value extends IMetadataPiniaStorageSchema[Field][Id][Key],
    >(schemaKey: Field, id: Id, key: Key | string, value: Value | any) {
      // V-6：目标不存在时 `set()` 是静默 no-op（典型场景：另一个标签页已删除该行，本页仍在编辑），
      // 而修复前仍会执行一次 `$save()`：修改被丢弃，却付出一次整状态序列化 + 整 key 写入。
      // 这里提前判断并告知用户，不再落盘。
      const target = this[schemaKey][id];
      if (!target) {
        useRuntimeStore().showSnakebar(
          i18n.t("SearchResultSnapshot.updateNotSaved", {
            schema: String(schemaKey),
            id: String(id),
          }),
          { color: "error" },
        );
        return;
      }

      // I-9：`set()` 会按点路径逐段写入。当前调用点的 key 都是字面量，但路径里一旦混入
      // `__proto__` / `constructor` / `prototype` 就会变成原型链写入（外部数据可能走到这里），
      // 因此统一拒绝（与 extends/pinia/webExtPersistence.ts 的 isUnsafePathSegment 同口径）。
      // 这里不写 console（本文件受 no-console 门禁约束）：拒绝本身就是防御，调用方也不会感知到差异。
      if (
        String(key)
          .split(".")
          .some((segment) => UNSAFE_PATH_SEGMENTS.has(segment))
      ) {
        return;
      }

      set(target, key, value);
      scheduleMetadataSave(this);
    },

    async addSite(siteId: TSiteID, siteConfig: ISiteUserConfig, options?: { reBuildMap?: boolean }) {
      const { reBuildMap = true } = options ?? {};

      // D1-Medium-05：入库前深拷贝（先解代理），既不再修改调用方对象（旧实现 `delete siteConfig.valid`），
      // 也避免 store 与对话框共享同一个对象 —— 共享时对话框里未确认的输入会被任意一次 $save 落盘。
      const nextSiteConfig: ISiteUserConfig = cloneDeep(toRaw(siteConfig));
      delete nextSiteConfig.valid;
      this.sites[siteId] = nextSiteConfig;
      // V-7：无条件登记站点变更版本 —— 即使本次不重建（批量导入的中间态），
      // 之后的 buildSiteMapCache() 也能据此补上重建。
      getSiteMapRebuildState(this).version++;

      if (reBuildMap) {
        // H-8：站点配置本身必须落盘，不能被「派生索引重建失败」连带丢掉 ——
        // 旧实现在 buildSiteMapCache 抛错（站点定义加载失败等）时直接跳过保存：内存已改、磁盘未改，
        // 刷新页面后新增/删除就像没发生过。先保存，再把重建错误抛给调用方提示。
        await this.$save();
        await this.buildSiteMapCache(false);
        await this.$save(); // 重建出的 siteHostMap / siteNameMap 同样需要持久化
      } else {
        // OPTIONSSHELL-4：reBuildMap:false 也必须「返回即已落盘」。
        // 该分支的唯一调用方是一键导入的 URL 探测：addSite 之后立刻 sendMessage("getSiteSearchResult")，
        // 而 offscreen 侧是从 chrome.storage 读 metadata.sites 的。旧实现只登记 500ms 去抖，
        // 于是探测用的 url 往往不是刚写入的候选（多 URL 站点永远测 urls[0]，可用站点被判失败并从 store 移除）。
        await this.$save();
      }
    },

    async removeSite(siteId: TSiteID, options?: { reBuildMap?: boolean }) {
      const { reBuildMap = true } = options ?? {};

      delete this.sites[siteId];
      getSiteMapRebuildState(this).version++; // V-7：见 addSite

      // B-13：级联清理对已删除站点的引用。
      // 修复前只做 `delete this.sites[siteId]`，于是方案里保留着指向该站点的条目
      // （运行方案时会走到 getSiteDefaultSearchSolution 的裸解引用 / 抛错），
      // lastUserInfo 也会留下永不更新的孤儿记录。
      //
      // I（REVIEW-FINDINGS stores-6）：`solution.solutions` 来自导入/备份恢复，形状可能被破坏
      // （null / 非数组 / 元素非对象）。旧实现裸调 `.filter` 会抛 TypeError，中断后面所有级联清理
      // （lastUserInfo / 排除站点 / 时间线 / flushPlan 全部残留）。这里逐条防御，坏数据直接重置为 []。
      for (const solution of Object.values(this.solutions)) {
        if (!solution || typeof solution !== "object") continue;
        const items = Array.isArray(solution.solutions) ? solution.solutions : [];
        solution.solutions = items.filter(
          (solutionItem) => !!solutionItem && typeof solutionItem === "object" && solutionItem.siteId !== siteId,
        );
      }
      delete this.lastUserInfo[siteId];

      // F1（原 D1-Medium-06）：被清空的方案若正是默认方案，回退到 "default" ——
      // 否则用户下次搜索会选中一个空方案，静默返回 0 结果。
      for (const [solutionId, solution] of Object.entries(this.solutions)) {
        if (
          Array.isArray(solution?.solutions) &&
          solution.solutions.length === 0 &&
          this.defaultSolutionId === solutionId
        ) {
          this.defaultSolutionId = "default";
        }
      }

      // F1（原 D1-Medium-06）：下载器排除列表 / 统计与时间线的已选站点 / 用户信息刷新计划里
      // 残留的 siteId 同样要清掉：否则重新添加该站点后，它仍被下载器排除（推送列表与右键菜单
      // 都看不到它），时间线里留着一个不存在的站点，flushPlan 里留着永不复位的 true。
      for (const downloader of Object.values(this.downloaders)) {
        if (Array.isArray(downloader.excludedSites) && downloader.excludedSites.includes(siteId)) {
          downloader.excludedSites = downloader.excludedSites.filter((id) => id !== siteId);
        }
      }

      const configStore = useConfigStore();
      let configChanged = false;
      for (const control of [configStore.userDataTimelineControl, configStore.userStatisticControl] as Array<{
        selectedSites?: TSiteID[];
      }>) {
        const selectedSites = control?.selectedSites;
        if (Array.isArray(selectedSites) && selectedSites.includes(siteId)) {
          control.selectedSites = selectedSites.filter((id) => id !== siteId);
          configChanged = true;
        }
      }
      if (configChanged) {
        void configStore.$save().catch(() => undefined);
      }

      const runtimeStore = useRuntimeStore();
      if (Object.hasOwn(runtimeStore.userInfo.flushPlan, siteId)) {
        delete runtimeStore.userInfo.flushPlan[siteId];
      }

      // H-8：保存安排在 finally 里 —— 旧实现在 buildSiteMapCache 抛错时直接跳过保存，
      // 内存里站点已删、磁盘上还在，刷新后删除像没发生过。
      // 这里仍走合并写入（DeleteDialog 并发删除 N 个站点时只写一次，见 V-7），只是不再被重建错误短路。
      try {
        if (reBuildMap) {
          await this.buildSiteMapCache(false);
        }
      } finally {
        scheduleMetadataSave(this);
      }
    },

    /**
     * 在添加、编辑站点时调用，重新生成 host 对站点的映射，
     * 便于 content-script 等其他地方通过 (await extStorage.getItem('metadata')).siteHostMap[host] 获取站点 ID
     */
    async buildSiteHostMap() {
      const siteHostMap: Record<TSiteHost, TSiteID> = {};
      const failedSiteIds: TSiteID[] = [];
      for (const siteId in this.sites) {
        const site = this.sites[siteId];
        if (site.url) {
          siteHostMap[getHostFromUrl(site.url)] = siteId;
        }
        // OPTIONSSHELL-2：逐站点降级 —— getSiteMergedMetadata 对「定义已不在构建产物里」的站点会抛
        // TypeError，旧实现会让循环直接中断：siteHostMap/siteNameMap 都不赋值、syncSiteIndex 也不执行，
        // 新加站点的 host 永远写不进 siteIndex、已删站点的 host 永远清不掉。这里跳过失败站点，
        // 保证其余站点与索引同步照常完成，并在末尾统一提示用户。
        try {
          const urls = await this.getSiteMergedMetadata(siteId, "urls", []);
          if (urls.length > 0) {
            for (const url of urls) {
              siteHostMap[getHostFromUrl(url)] = siteId;
            }
          }
          const legacyUrls = (await this.getSiteMergedMetadata(siteId, "legacyUrls", []))!;
          if (legacyUrls.length > 0) {
            for (const url of legacyUrls) {
              siteHostMap[getHostFromUrl(url)] = siteId;
            }
          }
        } catch {
          failedSiteIds.push(siteId);
        }
      }
      this.siteHostMap = siteHostMap;
      reportUnavailableSiteIds(this, failedSiteIds);
      await this.syncSiteIndex();
    },

    async buildSiteNameMap() {
      const siteNameMap: Record<TSiteID, string> = {};
      const failedSiteIds: TSiteID[] = [];
      for (const siteId in this.sites) {
        // OPTIONSSHELL-2：同 buildSiteHostMap，单个站点定义缺失不能让整张映射停在旧值。
        try {
          siteNameMap[siteId] = await this.getSiteName(siteId);
        } catch {
          failedSiteIds.push(siteId);
        }
      }
      this.siteNameMap = siteNameMap;
      reportUnavailableSiteIds(this, failedSiteIds);
      await this.syncSiteIndex();
    },

    /**
     * 把 host/name 索引同步到独立的 siteIndex key（见 docs/performance-audit.md P2-17）。
     * metadata 可能很大且会被高频写入反复失效，content script / 右键菜单只需要这个小表。
     */
    async syncSiteIndex() {
      await sendMessage("setExtStorage", {
        key: "siteIndex",
        value: { siteHostMap: this.siteHostMap, siteNameMap: this.siteNameMap },
      });
    },

    async buildSiteMapCache(save: boolean = false) {
      // V-7：把并发调用合并到同一轮重建；重建期间又有站点变更时补跑一轮，
      // 保证每个调用返回时映射已覆盖自己这次的变更（见 ISiteMapRebuildState 的注释）。
      const rebuildState = getSiteMapRebuildState(this);

      while (rebuildState.builtVersion < rebuildState.version) {
        if (rebuildState.inFlight) {
          await rebuildState.inFlight;
          continue;
        }

        const targetVersion = rebuildState.version;
        const flight = (async () => {
          await this.buildSiteNameMap();
          await this.buildSiteHostMap();
        })().then(() => {
          // 只记录「开始重建时」的版本：期间的变更由外层 while 再补跑一轮
          rebuildState.builtVersion = targetVersion;
        });

        rebuildState.inFlight = flight.finally(() => {
          rebuildState.inFlight = null;
        });
        await rebuildState.inFlight;
      }

      if (save) {
        scheduleMetadataSave(this);
      }
    },

    async addSearchSolution(solution: ISearchSolutionMetadata) {
      // D1-Medium-05 + F1-01：先与调用方对象解耦（深拷贝），再对每条站点的 `searchEntries`
      // 做请求地址安全化 —— 导入的方案与被改过的备份都可能把 `requestConfig.url/baseURL/headers`
      // 写成外部地址，落盘后还会被继续导出分享给他人。读取路径（getSearchSolution）另有一道同样的
      // 安全化，用来覆盖「已经被写进 storage 的旧数据」。
      const nextSolution: ISearchSolutionMetadata = cloneDeep(toRaw(solution));
      const sanitizedItems: ISearchSolution[] = [];
      for (const solutionItem of nextSolution.solutions ?? []) {
        sanitizedItems.push(await sanitizeSearchSolutionItem(solutionItem));
      }
      nextSolution.solutions = sanitizedItems;

      this.solutions[nextSolution.id] = nextSolution;
      scheduleMetadataSave(this);
    },

    async removeSearchSolution(solutionId: TSolutionKey) {
      delete this.solutions[solutionId];

      if (this.defaultSolutionId === solutionId) {
        this.defaultSolutionId = "default";
      }

      scheduleMetadataSave(this);
    },

    async saveSearchSnapshotData(name: string) {
      const runtimeStorage = useRuntimeStore();
      const searchSnapshotData = runtimeStorage.search;

      if (searchSnapshotData.isSearching) {
        runtimeStorage.showSnakebar(i18n.t("SearchResultSnapshot.cannotSaveWhileSearching"), { color: "error" });
        return;
      }

      const snapshotId = nanoid();

      // OPTIONSSHELL-7：先写外部快照数据、成功后再登记内存元数据 —— 旧实现先写 this.snapshots 再 await，
      // offscreen 写 IndexedDB 失败（配额/上下文失效）时元数据已留在内存，之后任意一次 $save 就把它落盘，
      // 用户在列表里看到一条点开取不到数据的「幽灵快照」；调用方是 fire-and-forget，异常也无人提示。
      // 这里失败即提示并返回，不产生任何内存记录。
      try {
        // 保存搜索快照数据
        await sendMessage("saveSearchResultSnapshotData", { snapshotId, data: searchSnapshotData });
      } catch {
        runtimeStorage.showSnakebar(i18n.t("common.saveFailed"), { color: "error" });
        return;
      }

      this.snapshots[snapshotId] = {
        id: snapshotId,
        name,
        createdAt: Date.now(),
        recordCount: searchSnapshotData.searchResult.length,
      };

      scheduleMetadataSave(this);
    },

    async editSearchSnapshotDataName(id: TSearchSnapshotKey, name: string) {
      // OPTIONSSHELL-5：与 simplePatch(V-6) 对齐的存在性守卫。快照可能已在另一个标签页被删除
      // （调用方 EditNameDialog 的 dialogEnter 也只做 `?.` 读），旧实现裸解引用 this.snapshots[id]
      // 会抛 TypeError：改名静默丢失 + unhandled rejection。这里提示用户并放弃这次修改。
      const snapshot = this.snapshots[id];
      if (!snapshot) {
        useRuntimeStore().showSnakebar(
          i18n.t("SearchResultSnapshot.updateNotSaved", { schema: "snapshots", id: String(id) }),
          { color: "error" },
        );
        return;
      }

      snapshot.name = name;
      scheduleMetadataSave(this);
    },

    async removeSearchSnapshotData(id: TSearchSnapshotKey) {
      const runtimeStorage = useRuntimeStore();

      // OPTIONSSHELL-7 孪生：旧实现先 delete 内存元数据再 await 外部删除 —— 外部删除失败（IndexedDB
      // 配额/上下文失效）时内存记录已消失、异常又让 scheduleMetadataSave 短路：既没有回滚也没有提示，
      // 用户看到的是「列表里没了、存储里还在」。这里与 saveSearchSnapshotData 保持同一顺序，
      // 外部删除成功后才改内存；失败则保留记录并提示，用户可重试（也避免留下无法回收的数据）。
      try {
        await sendMessage("removeSearchResultSnapshotData", id); // 删除搜索快照数据
      } catch {
        runtimeStorage.showSnakebar(i18n.t("KeepUploadTask.deleteError"), { color: "error" });
        return;
      }

      delete this.snapshots[id]; // 删除搜索快照元数据
      scheduleMetadataSave(this);
    },

    async addDownloader(downloaderConfig: IDownloaderMetadata) {
      // D1-Medium-05：拷贝后入库，不修改调用方对象、也不再与对话框共享同一份引用
      const nextDownloaderConfig: IDownloaderMetadata = cloneDeep(toRaw(downloaderConfig));
      delete nextDownloaderConfig.valid;
      this.downloaders[nextDownloaderConfig.id] = nextDownloaderConfig;
      await this.$save();
    },

    async removeDownloader(downloaderId: TDownloaderKey) {
      delete this.downloaders[downloaderId];
      scheduleMetadataSave(this);
    },

    async setLastSearchFilter(filter: string) {
      this.lastSearchFilter = (filter ?? "").replace(/\s*site:\S+/g, "").trim();
      scheduleMetadataSave(this);
    },

    async setLastDownloader(downloader: IMetadataPiniaStorageSchema["lastDownloader"]) {
      this.lastDownloader = downloader;
      scheduleMetadataSave(this);
    },

    async addMediaServer(mediaServerConfig: IMediaServerMetadata) {
      // D1-Medium-05：拷贝后入库（同上）
      const nextMediaServerConfig: IMediaServerMetadata = cloneDeep(toRaw(mediaServerConfig));
      this.mediaServers[nextMediaServerConfig.id] = nextMediaServerConfig;
      scheduleMetadataSave(this);
    },

    async removeMediaServer(mediaServerId: TMediaServerKey) {
      delete this.mediaServers[mediaServerId];
      scheduleMetadataSave(this);
    },

    async addBackupServer(backupServerConfig: IBackupServerMetadata) {
      // D1-Medium-05：拷贝后入库（同上）
      const nextBackupServerConfig: IBackupServerMetadata = cloneDeep(toRaw(backupServerConfig));
      this.backupServers[nextBackupServerConfig.id] = nextBackupServerConfig;
      scheduleMetadataSave(this);
    },

    async removeBackupServer(backupServerId: string) {
      delete this.backupServers[backupServerId];
      scheduleMetadataSave(this);
    },
  },
});

// 注册给 config store 的惰性访问器（见 metadataStoreBridge.ts）：
// config.ts 需要读 metadata 的 lastUserInfo，但直接 import 会形成循环依赖，
// 因此由本模块在求值完成时把 store 工厂登记到 bridge 里。
registerMetadataStoreAccessor(useMetadataStore);
