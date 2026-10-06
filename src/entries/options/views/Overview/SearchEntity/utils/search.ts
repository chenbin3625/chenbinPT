import PQueue from "p-queue";
import { computed, markRaw } from "vue";
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
 * V-15：搜索轮次 epoch。
 *
 * 切换快照（或开始新一轮 flush 搜索）时 `runtimeStore.search.*` 会被**整体替换**，但此前排队/在途的
 * 队列任务仍会继续写入（`searchPlan[...]`、`searchResult.push(...)`、`advanceItemPropsRef`），
 * 把实时搜索结果污染到快照视图上。这里让每个任务在入队时捕获当时的 epoch，每次写入前校验：
 * 一旦轮次被 `invalidateSearchTasks()` 取代，任务就静默结束，不再碰 store。
 */
let searchTaskEpoch = 0;

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

export function cancelSearchQueue(): void {
  invalidateSearchTasks();
  searchQueue.clear();

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
  const currentPriority = runtimeStore.search.searchPlan[solutionKey].queuePriority ?? 1;
  searchQueue.setPriority(solutionKey, currentPriority + 1);
}

export async function doSearchEntity(
  siteId: TSiteID,
  searchEntryName: string,
  searchEntry: IAdvanceKeywordSearchConfig,
  flush: boolean = false,
) {
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

export async function doSearch(search: string, plan?: string, flush: boolean = true) {
  const searchKey = search ?? runtimeStore.search.searchKey ?? "";
  const searchPlanKey = plan ?? runtimeStore.search.searchPlanKey ?? "default";

  if (flush) {
    runtimeStore.resetSearchData();

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

  // Expand search plan
  const searchSolution = await metadataStore.getSearchSolution(runtimeStore.search.searchPlanKey);

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
      await doSearchEntity(siteId, searchEntryName, searchEntry);
    }
  }
}

export async function retrySearch(retryStatus: EResultParseStatus[] = defaultErrorSearchPlanStatus) {
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
