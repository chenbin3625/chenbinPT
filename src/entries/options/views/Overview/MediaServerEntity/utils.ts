import PQueue from "p-queue";
import { markRaw, ref, watch } from "vue";
import { omit } from "es-toolkit";
import { type IMediaServerItem, type IMediaServerSearchOptions, type IMediaServerSearchResult } from "@ptd/mediaServer";

import { sendMessage } from "@/messages.ts";
import { useRuntimeStore } from "@/options/stores/runtime.ts";
import { useConfigStore } from "@/options/stores/config.ts";
import { useMetadataStore } from "@/options/stores/metadata.ts";
import type { TMediaServerKey } from "@/shared/types.ts";
import { EResultParseStatus } from "@ptd/site";
import { i18n } from "@/options/plugins/i18n.ts";
const runtimeStore = useRuntimeStore();
const configStore = useConfigStore();
const metadataStore = useMetadataStore();

export const searchMediaServerIds = ref<TMediaServerKey[]>(
  metadataStore.getEnabledMediaServers.map((mediaServer) => mediaServer.id) ?? [],
);
let selectionInitialized = searchMediaServerIds.value.length > 0;

/**
 * V-19：`searchMediaServerIds` 原先只在模块加载时初始化一次，之后用户在设置里禁用（或删除）某个媒体服务器
 * 时不会被同步 —— 搜索**仍会把已存凭据发给它**（offscreen 侧按 id 取配置就搜，不检查 `enabled`），
 * 而 UI 上留下一个「已禁用 → disabled 但仍勾选、点不动」的复选框，只有整页刷新才恢复。
 * 这里跟随启用列表把不再启用的 id 剪掉，保证「勾选 = 会搜索」始终成立。
 */
watch(
  () => metadataStore.getEnabledMediaServers.map((mediaServer) => mediaServer.id),
  (enabledIds) => {
    if (!selectionInitialized && enabledIds.length > 0) {
      selectionInitialized = true;
      if (searchMediaServerIds.value.length === 0) {
        searchMediaServerIds.value = [...enabledIds];
        return;
      }
    }
    const stillEnabled = searchMediaServerIds.value.filter((id) => enabledIds.includes(id));
    if (stillEnabled.length !== searchMediaServerIds.value.length) {
      searchMediaServerIds.value = stillEnabled;
    }
  },
);

export const searchQueue = new PQueue({ concurrency: 1 }); // 默认设置为 1，避免并发搜索

let searchEpoch = 0;
let activeSearchSelection = "";

searchQueue.on("active", () => {
  runtimeStore.mediaServerSearch.isSearching = true;
  // 启动后，根据 configStore 的值，自动更新 searchQueue 的并发数
  if (searchQueue.concurrency != configStore.mediaServerEntity.queueConcurrency) {
    searchQueue.concurrency = configStore.mediaServerEntity.queueConcurrency;
    void sendMessage("logger", { msg: `Search queue concurrency changed to: ${searchQueue.concurrency}` }).catch(
      () => {},
    );
  }
});

searchQueue.on("idle", () => {
  runtimeStore.mediaServerSearch.isSearching = false;
});

/**
 * N1：`isSearching` 是「内存中的 PQueue 正在跑」的瞬时标志，但 runtime store 会把它持久化到
 * sessionStorage 并在 `restoreState()` 中原样恢复。PQueue 是模块内存对象，页面重载后队列为空，
 * `idle` 事件不会再发生 —— 恢复出来的 `true` 永远没人复位：滚动加载被挡住、「加载更多」按钮
 * 一直 loading、无结果时页面永久停在骨架屏。
 *
 * 这里在页面水合后做一次收尾：只有队列确实空闲（没有排队/运行中的任务）时才复位，
 * 避免把「从别的路由切回来时仍在进行中的搜索」错误地标记为已结束。
 *
 * 注：更彻底的做法是在 runtime store 的 `sanitizeMediaServerSearchData` 里忽略 `isSearching`
 * （F1 范围），已在 fix report 中列为需要 F1 跟进的接口需求。
 */
export function resetSearchingStateIfIdle(): boolean {
  if (!runtimeStore.mediaServerSearch.isSearching) return false;
  if (searchQueue.size > 0 || searchQueue.pending > 0) return false;
  runtimeStore.mediaServerSearch.isSearching = false;
  return true;
}

/**
 * N16：`searchStatus` 只保留「当前仍被勾选且启用」的媒体服务器。
 *
 * 原先只有换关键词时 `resetMediaServerSearchData()` 才清空，取消勾选的服务器条目会一直留着，
 * 使 `hasMore` 仍为 true（「加载更多」可点但只会搜当前勾选项，点完没有新增）。
 */
function pruneSearchStatus() {
  const status = runtimeStore.mediaServerSearch.searchStatus;
  if (!status) return;
  const enabledIds = metadataStore.getEnabledMediaServers.map((mediaServer) => mediaServer.id);
  const keepIds = new Set(searchMediaServerIds.value.filter((id) => enabledIds.includes(id)));
  for (const mediaServerId of Object.keys(status)) {
    if (!keepIds.has(mediaServerId)) {
      delete status[mediaServerId];
    }
  }
}

watch(
  () => [searchMediaServerIds.value.join(","), metadataStore.getEnabledMediaServers.map((item) => item.id).join(",")],
  () => pruneSearchStatus(),
);

export async function doSearch(option: { searchKey?: string; loadMore?: boolean; userInitiated?: boolean } = {}) {
  const { searchKey = "", loadMore = false, userInitiated = false } = option;

  // V-19：只搜索「已启用且仍被勾选」的媒体服务器（上面的 watcher 之外再兜一层，
  // 避免 store 变更与本次搜索落在同一 tick 时按旧选择把凭据发给刚被禁用的服务器）
  const enabledIds = metadataStore.getEnabledMediaServers.map((mediaServer) => mediaServer.id);
  const searchableIds = searchMediaServerIds.value.filter((id) => enabledIds.includes(id));

  // N16：一个都没勾选时循环为空 —— 不提示、不报错，页面只显示「暂无结果」，用户以为功能坏了。
  // 必须在「换词先清空结果」之前返回，否则用户会连已有结果一起丢掉。
  if (searchableIds.length === 0) {
    if (userInitiated) {
      // L2（F1）：媒体服务器专用 key，不再借用「添加站点」的文案
      runtimeStore.showSnackbar(i18n.t("MediaServerEntity.noServerSelected"), { color: "warning" });
    }
    return;
  }

  const sameSearch = searchKey === runtimeStore.mediaServerSearch.searchKey;
  const selection = JSON.stringify([...searchableIds].sort());
  const queueBusy = searchQueue.pending > 0 || searchQueue.size > 0;
  if (sameSearch && queueBusy && (loadMore || selection === activeSearchSelection)) return;

  if (!loadMore || !sameSearch) {
    searchEpoch++;
    searchQueue.clear();
    runtimeStore.resetMediaServerSearchData();
    runtimeStore.mediaServerSearch.isSearching = queueBusy;
  }

  activeSearchSelection = selection;
  runtimeStore.mediaServerSearch.searchKey = searchKey;
  pruneSearchStatus();
  const taskEpoch = searchEpoch;

  for (const mediaServerId of searchableIds) {
    if (loadMore && runtimeStore.mediaServerSearch.searchStatus[mediaServerId]?.canLoadMore === false) continue;
    // noinspection ES6MissingAwait
    searchQueue.add(async () => {
      if (taskEpoch !== searchEpoch) return;
      // 请求真正发出前再校验一次：排队期间筛选可能已经变化（取消勾选 / 被禁用），
      // 只向当前筛选出的服务器发送请求（上游 #1599）
      if (!searchMediaServerIds.value.includes(mediaServerId)) return;
      if (!metadataStore.getEnabledMediaServers.some((server) => server.id === mediaServerId)) return;
      const previousStatus = runtimeStore.mediaServerSearch.searchStatus[mediaServerId];
      if (loadMore && previousStatus?.canLoadMore === false) return;
      let searchOptions: IMediaServerSearchOptions = { limit: configStore.mediaServerEntity.searchLimit ?? 50 };
      if (loadMore && previousStatus?.options) {
        searchOptions = { ...searchOptions, ...previousStatus.options };
        searchOptions.startIndex = (searchOptions.startIndex ?? 0) + (searchOptions.limit ?? 0);
      }

      // M-17：任务 reject 时 p-queue 只 emit("error")，而本队列没有该监听 —— 失败会完全静默。
      // 这里把消息层的异常（offscreen 不可达、实体抛错）也收敛成一个失败结果，走下面统一的提示分支。
      const searchResult: IMediaServerSearchResult = await sendMessage("getMediaServerSearchResult", {
        mediaServerId,
        keywords: searchKey,
        options: searchOptions,
      }).catch((e: unknown) => ({
        status: EResultParseStatus.unknownError,
        items: [],
        errorMessage: e instanceof Error ? e.message : String(e),
      }));

      if (taskEpoch !== searchEpoch) return;
      if (!searchMediaServerIds.value.includes(mediaServerId)) return;
      if (!metadataStore.getEnabledMediaServers.some((server) => server.id === mediaServerId)) return;
      runtimeStore.mediaServerSearch.searchStatus[mediaServerId] = {
        ...omit(searchResult, ["items"]),
        // 失败不能推进游标；下一次重试仍请求同一页。
        options:
          searchResult.status === EResultParseStatus.success
            ? (searchResult.options ?? searchOptions)
            : previousStatus?.options,
        canLoadMore: searchResult.status !== EResultParseStatus.success || searchResult.items.length > 0,
      };

      if (searchResult.status !== EResultParseStatus.success) {
        const mediaServerDetail = metadataStore.mediaServers[mediaServerId];
        if (!mediaServerDetail) return;
        // 只有认证类失败才提示检查认证信息，其余（超时/网络不可达/解析异常）展示真实原因（#1396）
        const failReason =
          searchResult.status === EResultParseStatus.needLogin
            ? i18n.t("MediaServerEntity.error.checkAuth")
            : (searchResult.errorMessage ?? i18n.t("MediaServerEntity.error.unknown"));
        runtimeStore.showSnackbar(
          i18n.t("MediaServerEntity.error.updateFailed", {
            name: mediaServerDetail.name,
            address: mediaServerDetail.address,
            reason: failReason,
          }),
          {
            color: "error",
          },
        );
        return;
      }

      // P2-5：先聚合本次新增（去重）的条目，再一次性 push，
      // 避免逐条 push 触发逐条响应式通知与逐次重渲染。
      // 已存在的条目（同一 url）用新数据原位替换，保证收藏、观看状态等能随再次搜索刷新，
      // 而不是被当作重复丢弃（上游 #1662）。
      const newItems: IMediaServerItem[] = [];
      for (const item of searchResult.items) {
        const existingIndex = runtimeStore.mediaServerSearch.searchResult.findIndex((r) => r.url === item.url);
        if (existingIndex !== -1) {
          runtimeStore.mediaServerSearch.searchResult[existingIndex] = markRaw(item);
        } else {
          newItems.push(markRaw(item));
        }
      }

      if (newItems.length > 0) {
        runtimeStore.mediaServerSearch.searchResult.push(...newItems);
      }
    });
  }
}
