import PQueue from "p-queue";
import { computed, markRaw, ref } from "vue";
import {
  definedFilters,
  EResultParseStatus,
  ETorrentStatus,
  type IAdvanceKeywordSearchConfig,
  type TSiteID,
} from "@ptd/site";

import { sendMessage } from "@/messages.ts";
import { i18n } from "@/options/plugins/i18n.ts";
import { useMetadataStore } from "@/options/stores/metadata.ts";
import { useRuntimeStore } from "@/options/stores/runtime.ts";
import { useConfigStore } from "@/options/stores/config.ts";
import type { ISearchResultTorrent, TSearchSolutionKey } from "@/shared/types.ts";

import { tableCustomFilter } from "./filter.ts";

const runtimeStore = useRuntimeStore();
const configStore = useConfigStore();
const metadataStore = useMetadataStore();

const { advanceFilterDictRef, buildAdvanceItemPropsFn, updateTableFilterValueFn, advanceItemPropsRef } =
  tableCustomFilter;

// 模块级别的 Set，用于跟踪已存在的搜索结果 ID，避免并发时的重复
const globalExistingIds = new Set<string>();

export const searchQueue = new PQueue({ concurrency: 1 }); // 默认设置为 1，避免并发搜索

/**
 * 搜索队列是否处于「暂停」状态。
 *
 * `PQueue.isPaused` 是普通字段、不参与 Vue 响应式，原先视图用 `ref(searchQueue.isPaused)` 只在 setup
 * 求值一次，之后暂停/开始都不会反映到界面上（按钮文案、重试按钮禁用态停留在旧值）。
 * 这里用响应式 ref 作为唯一事实来源，所有暂停/开始都经过 pauseSearchQueue/startSearchQueue。
 */
export const searchQueuePaused = ref<boolean>(false);

/**
 * V-15：搜索轮次 epoch。
 *
 * 切换快照（或开始新一轮 flush 搜索）时 `runtimeStore.search.*` 会被**整体替换**，但此前排队/在途的
 * 队列任务仍会继续写入（`searchPlan[...]`、`searchResult.push(...)`、`advanceItemPropsRef`），
 * 把实时搜索结果污染到快照视图上。这里让每个任务在入队时捕获当时的 epoch，每次写入前校验：
 * 一旦轮次被 `invalidateSearchTasks()` 取代，任务就静默结束，不再碰 store。
 */
let searchTaskEpoch = 0;
let searchExpansionToken = 0;

/** 让当前所有在途/排队的搜索任务失效（调用方通常还会 `searchQueue.clear()` 清掉尚未开始的任务） */
export function invalidateSearchTasks() {
  searchTaskEpoch++;
}

export function captureSearchTaskEpoch(): number {
  return searchTaskEpoch;
}

export function isSearchTaskCurrent(taskEpoch: number): boolean {
  return taskEpoch === searchTaskEpoch;
}

export function pauseSearchQueue(): void {
  searchQueue.pause();
  searchQueuePaused.value = true;
}

export function startSearchQueue(): void {
  searchQueue.start();
  searchQueuePaused.value = false;
}

export function cancelSearchQueue(): void {
  invalidateSearchTasks();
  searchQueue.clear();

  // F2：「暂停 → 取消」后队列必须恢复运行。
  // PQueue 的 paused 是持久状态，clear() 只是清掉任务、不会 start；若这里不恢复，
  // 下一次 doSearch 会把任务 add 进暂停队列，任务永远停在 waiting，一个请求都不会发出
  // （页面却显示「正在搜索」），直到用户注意到再手动点「开始搜索」。
  if (searchQueue.isPaused || searchQueuePaused.value) {
    startSearchQueue();
  }

  for (const plan of Object.values(runtimeStore.search.searchPlan)) {
    // M-22：在途（working）的计划同样要写终态。它的响应会因轮次失效在写入前早退，
    // 不在这里收尾的话状态会永远停在 working（顶部「排队中 1」、该项 loading 永转，且不在重试集合内）。
    if (plan?.status === EResultParseStatus.waiting || plan?.status === EResultParseStatus.working) {
      plan.status = EResultParseStatus.passParse;
      plan.statusMsg = "i18n.userCancel";
      plan.endAt ??= Date.now();
    }
  }

  runtimeStore.search.isSearching = false;
  runtimeStore.search.endAt ||= Date.now();
}

/**
 * D2-01：页面加载时对账从 sessionStorage 恢复出来的「在途」搜索状态。
 *
 * runtime store 会把 `isSearching` 与 `searchPlan[*].status` 原样恢复到新页面，但这些 in-flight
 * 状态对应的队列任务早已不存在（`searchQueue` 是模块级内存对象）。不收敛的话：
 * - 页面一直显示「搜索中…」，顶栏搜索按钮/热门推荐被禁用；
 * - waiting 计划仍显示「排队中」，其「上移队列」会抛 `No promise function with the id ...`；
 * - 用户只能靠点「取消」自救（取消本不该是恢复后的必需操作）。
 *
 * 只在队列里没有任何存活任务时收尾：同一页面内离开再回来时，队列可能仍有真实任务。
 *
 * @returns 是否修正了残留状态
 */
export function reconcileRestoredSearchState(): boolean {
  if (!runtimeStore.search.isSearching) return false;
  if (searchQueue.size > 0 || searchQueue.pending > 0) return false;

  for (const plan of Object.values(runtimeStore.search.searchPlan)) {
    if (plan?.status === EResultParseStatus.waiting || plan?.status === EResultParseStatus.working) {
      plan.status = EResultParseStatus.passParse;
      plan.statusMsg = "i18n.userCancel";
      plan.endAt ??= Date.now();
    }
  }

  runtimeStore.search.isSearching = false;
  runtimeStore.search.endAt ||= Date.now();
  return true;
}

/** 当前是否处于「搜索快照」视图（快照数据不允许与实时搜索结果混在一起） */
export function isSnapshotView(): boolean {
  return Boolean(runtimeStore.search.snapshot);
}

/** 把 vue-router 的 query 值归一化成单个字符串（重复参数 `?search=a&search=b` 在 router 里是数组） */
export function normalizeRouteQueryValue(value: unknown): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === "string" && first !== "" ? first : undefined;
}

/** `flush` 只在「刚刚发起搜索」的那一次导航里有效，任何非空值都视为真（兼容 flush=1/true） */
export function isFlushQuery(value: unknown): boolean {
  const first = Array.isArray(value) ? value[0] : value;
  return first !== undefined && first !== null && first !== "" && first !== "0" && first !== "false";
}

/**
 * OUI-2：等待搜索队列**真正**空闲（所有排队 + 在途任务结束、`idle` 事件处理完成），
 * 而不是 `doSearch()` resolve 的「任务已全部入队」时机。
 *
 * 调用方（SearchEntity/Index.vue 的 runSearch）必须在本次搜索真正结束后才能把 URL 上的
 * `flush` 摘掉：`doSearch` 只负责入队，入队完成就摘 flush 的话，搜索进行中刷新页面会被
 * 当成「上一次搜索已完成」，把部分结果当完整结果展示（且计划被标成 userCancel 不再重试）。
 *
 * 依赖 p-queue 的事件顺序：模块底部注册的 `searchQueue.on("idle", ...)`（把
 * `isSearching` 置 false、写 `endAt`、构建高级筛选词）先于 `onIdle()` 的内部监听执行，
 * 因此 await 返回时 store 已处于终态。
 */
export function waitForSearchQueueIdle(): Promise<void> {
  if (searchQueue.size === 0 && searchQueue.pending === 0) {
    return Promise.resolve();
  }
  return searchQueue.onIdle();
}

/** 处理完 flush 后从 query 中去掉它（配合 router.replace，避免刷新/后退再次清空结果重搜） */
export function stripFlushFromQuery(query: Record<string, unknown>): Record<string, unknown> {
  // E（REVIEW-FINDINGS P2-3）：顶栏/标题的「搜索同名」用 `t: Date.now()` 作为 nonce 保证重复导航不丢失，
  // 但它只服务于发起搜索的那一次导航；搜索处理完还留在地址里会让 URL 不断变化、分享/后退都带上
  // 一个无意义的时间戳。这里与 flush 一起摘除。
  const { flush: _flush, t: _nonce, ...rest } = query;
  return rest;
}

export interface IRouteSearchState {
  snapshot?: string;
  searchKey: string;
  searchPlanKey: string;
  startAt: number;
  resultCount: number;
}

export interface IRouteSearchDecision {
  /** 需要发起的搜索关键词；undefined 表示本次路由变化不需要搜索 */
  search?: string;
  plan?: string;
  /** 是否需要清空/替换搜索数据（离开快照视图，或本次要发起新一轮搜索） */
  resetData: boolean;
}

/**
 * D2-03：根据路由变化决定「是否要真正发起一次搜索」。
 *
 * 修复前 watcher 是 `immediate: true`（首次挂载 `oldParams === undefined`），只要 URL 里带
 * `search` / `plan` 就在挂载时 `doSearch(..., true)`，即使这只是刷新/后退到同一个地址：
 * sessionStorage 里恢复出来的结果被清空重搜。而且 `flush` 一直留在 URL 里（全仓没有 replace），
 * 每次刷新/后退都会再清一次。
 *
 * 现在的语义：
 * - `flush`：明确的一次新搜索（顶栏搜索/重新搜索），总是发起；
 * - 非首次挂载：只有 `search`/`plan` 真的变化才发起；
 * - 首次挂载：URL 里的条件与已恢复的结果对得上就沿用恢复结果，不重搜；
 *   地址里没有搜索条件时同样保留恢复结果（否则刷新后结果凭空消失）。
 *
 * 注意这里不比较 `plan`：`doSearch` 会把 `searchPlanKey` 重写成方案的内部 id（例如 `default`
 * → 实际方案 id），URL 里保留的仍是用户请求的方案 key，直接比较会在每次刷新时误判为「方案变了」。
 * 不搜索时也不改写 store，因此界面展示的方案与结果始终一致。
 */
export function resolveRouteSearchDecision(params: {
  query: Record<string, unknown>;
  previousQuery?: Record<string, unknown>;
  state: IRouteSearchState;
}): IRouteSearchDecision {
  const { query, previousQuery, state } = params;
  const search = normalizeRouteQueryValue(query.search);
  const plan = normalizeRouteQueryValue(query.plan);
  const flush = isFlushQuery(query.flush);
  const isInitial = previousQuery === undefined;

  // 快照视图的数据不能当作实时结果继续展示：离开快照（URL 已无 snapshot）时先清掉它。
  // 若本次还需要搜索，doSearch 会自己 resetSearchData（幂等）。
  const resetData = Boolean(state.snapshot);

  const buildSearch = (): IRouteSearchDecision => ({
    search: search ?? "",
    plan: plan ?? "default",
    resetData: true,
  });

  if (flush) return buildSearch();

  if (!isInitial) {
    const searchChanged = search !== undefined && search !== normalizeRouteQueryValue(previousQuery?.search);
    const planChanged = plan !== undefined && plan !== normalizeRouteQueryValue(previousQuery?.plan);
    if (searchChanged || planChanged) return buildSearch();
    return { resetData };
  }

  // 首次挂载：只有「地址里指定了搜索条件」且「恢复结果对不上」时才搜索
  if (search !== undefined) {
    const restoredMatches = state.startAt > 0 && state.resultCount > 0 && search === state.searchKey;
    return restoredMatches ? { resetData } : buildSearch();
  }

  return { resetData };
}

export function summarizeSearchResultForLog(
  searchResult: unknown,
  status: EResultParseStatus,
  statusMsg?: string,
): { status: EResultParseStatus; statusMsg?: string; count: number } {
  return {
    status,
    statusMsg,
    count: Array.isArray(searchResult) ? searchResult.length : 0,
  };
}

searchQueue.on("active", () => {
  runtimeStore.search.isSearching = true;
  // 启动后，根据 configStore 的值，自动更新 searchQueue 的并发数
  if (searchQueue.concurrency != configStore.searchEntity.queueConcurrency) {
    searchQueue.concurrency = configStore.searchEntity.queueConcurrency;
    console.debug("Search queue concurrency changed to: ", searchQueue.concurrency);
  }
  // 队列开始活跃时，更新全局 Set
  globalExistingIds.clear();
  runtimeStore.search.searchResult.forEach((r) => globalExistingIds.add(r.uniqueId));
});

searchQueue.on("idle", () => {
  // 快照视图的数据来自快照，不是本轮实时搜索的产物：不要让「上一轮实时搜索收尾」写进来
  // （endAt / 高级筛选词都属于实时结果的状态）。
  if (isSnapshotView()) return;

  runtimeStore.search.isSearching = false;
  runtimeStore.search.endAt = Date.now();

  globalExistingIds.clear(); // 队列空闲时，清空全局 Set
  buildAdvanceItemPropsFn(); // 队列空闲时，构建高级筛选词
});

interface ISearchPlanStatusMap {
  success: number; // success, noResults
  error: number; // unknownError, parseError, needLogin
  queued: number; // waiting, working
}

export const defaultErrorSearchPlanStatus = [
  EResultParseStatus.parseError,
  EResultParseStatus.unknownError,
  EResultParseStatus.CFBlocked,
  EResultParseStatus.needLogin,
  EResultParseStatus.noUserInput,
];

export const searchPlanStatus = computed<ISearchPlanStatusMap>(() => {
  const statusMap: ISearchPlanStatusMap = { success: 0, error: 0, queued: 0 };
  Object.values(runtimeStore.search.searchPlan ?? {}).forEach((plan) => {
    switch (plan.status) {
      case EResultParseStatus.success:
      case EResultParseStatus.noResults:
        statusMap.success++;
        break;
      case EResultParseStatus.unknownError:
      case EResultParseStatus.parseError:
      case EResultParseStatus.CFBlocked:
      case EResultParseStatus.needLogin:
      case EResultParseStatus.noUserInput:
        statusMap.error++;
        break;
      case EResultParseStatus.waiting:
      case EResultParseStatus.working:
        statusMap.queued++;
        break;
    }
  });
  return statusMap;
});

export async function raiseSearchPriority(solutionKey: TSearchSolutionKey) {
  const currentPriority = runtimeStore.search.searchPlan[solutionKey]?.queuePriority ?? 1;
  try {
    searchQueue.setPriority(solutionKey, currentPriority + 1);
  } catch {
    // D2-01：恢复出来 / 已经结束的计划在队列里没有对应任务，`setPriority` 会抛
    // `No promise function with the id "..." exists in the queue.` —— 原实现是未处理的 rejection。
    // 这里降级为「无队列任务可调整」，上移按钮点击不再报错。
  }
}

export async function doSearchEntity(
  siteId: TSiteID,
  searchEntryName: string,
  searchEntry: IAdvanceKeywordSearchConfig,
  flush: boolean = false,
) {
  // D2-04：快照视图里的结果来自快照，单方案重搜会把实时结果混进快照视图（其它方案仍是快照数据，
  // 顶部却已切到实时样式）。视图侧已禁用这些入口，这里再做一层防御。
  if (isSnapshotView()) {
    // console 日志在本仓库是需要逐条豁免的（eslint no-console），这里静默忽略即可；
    // 视图侧对应入口已禁用，正常用户操作不会走到这里。
    return;
  }

  const solutionKey = `${siteId}|$|${searchEntryName}` as TSearchSolutionKey;
  let queuePriority = runtimeStore.search.searchPlan[solutionKey]?.queuePriority ?? 1;

  // 对重新搜索的，清除对应搜索方法的搜索结果
  if (flush) {
    const removedItems = runtimeStore.search.searchResult.filter((item) => item.solutionKey === solutionKey);
    runtimeStore.search.searchResult = runtimeStore.search.searchResult.filter(
      (item) => item.solutionKey != solutionKey,
    );
    // 同步更新全局 Set，移除被删除项目的 uniqueId
    removedItems.forEach((item) => globalExistingIds.delete(item.uniqueId));
    queuePriority -= 1; // 对重新搜索的，降低优先级
  }

  runtimeStore.search.searchPlan[solutionKey] = {
    siteId,
    searchEntryName,
    searchEntry,
    status: EResultParseStatus.waiting,
    statusMsg: undefined,
    queuePriority,
    count: 0,
  };

  // Search site by plan in queue
  console.log(`Add search ${solutionKey} to queue.`);
  runtimeStore.search.searchPlan[solutionKey].queueAt = Date.now();

  // V-15：捕获入队时的搜索轮次，任务开始/写入前校验（见 searchTaskEpoch 的说明）
  const taskEpoch = searchTaskEpoch;

  void searchQueue
    .add(
      async () => {
        // V-15：轮次已被取代（切换快照 / 新一轮 flush 搜索）时直接结束，避免写入已被替换的 store
        if (taskEpoch !== searchTaskEpoch) return;

        const startAt = (runtimeStore.search.searchPlan[solutionKey].startAt = Date.now());
        console.log(`search ${solutionKey} start at ${startAt}`);
        runtimeStore.search.searchPlan[solutionKey].status = EResultParseStatus.working;

        let searchKeyword = runtimeStore.search.searchKey ?? "";
        if (configStore.searchEntity.treatTTQueryAsImdbSearch && searchKeyword.match(/^tt\d{7,8}/)) {
          searchKeyword = "imdb|" + searchKeyword;
        }

        let imdbSearchKeywords;
        if (searchKeyword.startsWith("imdb|")) {
          imdbSearchKeywords = definedFilters.extImdbId(searchKeyword.replace("imdb|", ""));
        }

        const {
          status: searchStatus,
          statusMsg: searchStatusMsg,
          data: searchResult,
        } = await sendMessage("getSiteSearchResult", {
          keyword: searchKeyword,
          siteId,
          searchEntry,
          autoDetectOfficialGroupFromTitle: configStore.searchEntity.autoDetectOfficialGroupFromTitle,
        });

        // V-15：等待响应期间轮次可能已被取代（例如用户切到了某个搜索快照），此时这份实时结果必须丢弃
        if (taskEpoch !== searchTaskEpoch) return;

        console.log(
          `success get search ${solutionKey} result`,
          summarizeSearchResultForLog(searchResult, searchStatus, searchStatusMsg),
        );
        runtimeStore.search.searchPlan[solutionKey].status = searchStatus;
        searchStatusMsg && (runtimeStore.search.searchPlan[solutionKey].statusMsg = searchStatusMsg);

        // 优化：批量处理搜索结果，减少响应式更新次数
        const newItems: ISearchResultTorrent[] = [];

        for (const item of searchResult) {
          const itemUniqueId = `${item.site}-${item.id}`;
          if (!globalExistingIds.has(itemUniqueId)) {
            const searchResultItem = item as ISearchResultTorrent;
            searchResultItem.uniqueId = itemUniqueId;
            searchResultItem.solutionId = searchEntryName;
            searchResultItem.solutionKey = solutionKey;
            searchResultItem.status ??= ETorrentStatus.unknown; // 确保 status 字段有默认值，避免过滤器无法处理 undefined

            if (imdbSearchKeywords && configStore.searchEntity.forceImdbIdMatchFilter && searchResultItem.ext_imdb) {
              if (definedFilters.extImdbId(String(searchResultItem.ext_imdb)) !== imdbSearchKeywords) {
                continue;
              }
            }

            newItems.push(markRaw(searchResultItem)); // 使用 markRaw 冻结对象，避免 Vue 创建响应式代理，提升性能
            globalExistingIds.add(itemUniqueId);
          }
        }

        // 批量添加新项目，减少响应式更新
        if (newItems.length > 0) {
          runtimeStore.search.searchResult.push(...newItems);
        }

        // 更新计数状态
        const endAt = Date.now();
        runtimeStore.search.searchPlan[solutionKey].count = newItems.length;
        runtimeStore.search.searchPlan[solutionKey].endAt = endAt;
        runtimeStore.search.searchPlan[solutionKey].costTime = endAt - startAt;

        // 直接向 advanceItemPropsRef.site 添加 siteId，而不是重新构造全部字典，以便于站点快速选择器更新
        const sites = advanceItemPropsRef.value.site;
        if (Array.isArray(sites) && !sites.includes(siteId)) {
          sites.push(siteId);
        }
      },
      { priority: queuePriority, id: solutionKey },
    )
    .catch((error: unknown) => {
      if (!isSearchTaskCurrent(taskEpoch)) return;
      const plan = runtimeStore.search.searchPlan[solutionKey];
      if (plan) {
        plan.status = EResultParseStatus.unknownError;
        plan.statusMsg = error instanceof Error ? error.message : String(error);
        plan.endAt = Date.now();
      }
    });
}

export async function doSearch(search?: string | null, plan?: string | null, flush: boolean = true) {
  // D2-04：非 flush 的「补搜/重试」在快照视图下一律拒绝（flush 表示用户明确发起新一轮实时搜索，
  // 下面的 resetSearchData 会清掉快照标记，属于「先清理快照标记」的正确语义）。
  if (isSnapshotView() && !flush) {
    return;
  }

  const expansionToken = ++searchExpansionToken;
  // F13：调用方可能传入非字符串（例如路由重复 query 解出来的数组），这里统一归一化，
  // 否则 `searchKeyword.match` 会在队列任务里抛 TypeError、store 里残留非字符串值。
  const searchKey = typeof search === "string" ? search : (runtimeStore.search.searchKey ?? "");
  const searchPlanKey = typeof plan === "string" ? plan : (runtimeStore.search.searchPlanKey ?? "default");

  if (flush) {
    invalidateSearchTasks();
    searchQueue.clear();
    runtimeStore.resetSearchData();

    // F（REVIEW-FINDINGS P2-4）：新一轮搜索必须保证队列真的在跑。
    // 旧实现只在 cancelSearchQueue 里恢复 start()：用户在「暂停」状态下发起搜索（顶栏搜索/重新搜索）
    // 时任务会被 add 进暂停队列，一个请求都不发、`isSearching` 却已置 true（页面永远停在「搜索中」）。
    if (searchQueue.isPaused || searchQueuePaused.value) {
      startSearchQueue();
    }

    try {
      // 清除过滤器中的站点关键词，但保留其他过滤器
      advanceItemPropsRef.value.site = [];
      advanceFilterDictRef.value.site = { required: [], exclude: [] };
      updateTableFilterValueFn();
    } catch (e) {
      console.error("Failed to reset table filter site field: ", e);
    }
  }

  console.log("Start search with: ", searchKey, searchPlanKey, flush);

  runtimeStore.search.searchKey = searchKey;
  runtimeStore.search.searchPlanKey = searchPlanKey;
  const taskEpoch = searchTaskEpoch;

  // Expand search plan
  const searchSolution = await metadataStore.getSearchSolution(searchPlanKey);
  if (expansionToken !== searchExpansionToken || !isSearchTaskCurrent(taskEpoch)) return;

  if (!searchSolution) {
    runtimeStore.showSnakebar(i18n.t("SearchEntity.searchSolutionNotFound", [searchPlanKey]), { color: "error" });
    return;
  }

  runtimeStore.search.searchPlanKey = searchSolution.id; // 重写 searchPlanKey 为实际的 id
  console.log(`Expanded Search Plan for ${searchPlanKey}: `, searchSolution);

  if (searchSolution.solutions.length === 0) {
    runtimeStore.showSnakebar(i18n.t("SearchEntity.noSiteToSearch"), { color: "error" });
    return;
  }

  runtimeStore.search.startAt = Date.now();
  runtimeStore.search.isSearching = true;

  for (const { siteId, searchEntries } of searchSolution.solutions) {
    for (const [searchEntryName, searchEntry] of Object.entries(searchEntries)) {
      if (expansionToken !== searchExpansionToken || !isSearchTaskCurrent(taskEpoch)) return;
      await doSearchEntity(siteId, searchEntryName, searchEntry);
    }
  }
}

export async function retrySearch(retryStatus: EResultParseStatus[] = defaultErrorSearchPlanStatus) {
  // D2-04：快照视图禁止把失败方案的实时重试结果混进快照数据
  if (isSnapshotView()) {
    return;
  }

  const shouldRetrySearchPlan = Object.values(runtimeStore.search.searchPlan).filter((plan) =>
    retryStatus.includes(plan.status),
  );
  if (shouldRetrySearchPlan.length === 0) {
    runtimeStore.showSnakebar(i18n.t("SearchEntity.noSearchPlanToRetry"), { color: "info" });
    return;
  }
  console.log("Retrying search plans: ", shouldRetrySearchPlan);
  for (const plan of shouldRetrySearchPlan) {
    await doSearchEntity(plan.siteId, plan.searchEntryName, plan.searchEntry, true);
  }
}
