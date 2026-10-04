import PQueue from "p-queue";
import { markRaw, ref, watch } from "vue";
import { omit } from "es-toolkit";
import { type IMediaServerItem, type IMediaServerSearchOptions } from "@ptd/mediaServer";

import { sendMessage } from "@/messages.ts";
import { useRuntimeStore } from "@/options/stores/runtime.ts";
import { useConfigStore } from "@/options/stores/config.ts";
import { useMetadataStore } from "@/options/stores/metadata.ts";
import type { TMediaServerKey } from "@/shared/types.ts";
import { EResultParseStatus } from "@ptd/site";
const runtimeStore = useRuntimeStore();
const configStore = useConfigStore();
const metadataStore = useMetadataStore();

export const searchMediaServerIds = ref<TMediaServerKey[]>(
  metadataStore.getEnabledMediaServers.map((mediaServer) => mediaServer.id) ?? [],
);

/**
 * V-19：`searchMediaServerIds` 原先只在模块加载时初始化一次，之后用户在设置里禁用（或删除）某个媒体服务器
 * 时不会被同步 —— 搜索**仍会把已存凭据发给它**（offscreen 侧按 id 取配置就搜，不检查 `enabled`），
 * 而 UI 上留下一个「已禁用 → disabled 但仍勾选、点不动」的复选框，只有整页刷新才恢复。
 * 这里跟随启用列表把不再启用的 id 剪掉，保证「勾选 = 会搜索」始终成立。
 */
watch(
  () => metadataStore.getEnabledMediaServers.map((mediaServer) => mediaServer.id),
  (enabledIds) => {
    const stillEnabled = searchMediaServerIds.value.filter((id) => enabledIds.includes(id));
    if (stillEnabled.length !== searchMediaServerIds.value.length) {
      searchMediaServerIds.value = stillEnabled;
    }
  },
);

export const searchQueue = new PQueue({ concurrency: 1 }); // 默认设置为 1，避免并发搜索

// 模块级别的 Set，用于跟踪已存在的搜索结果 ID，避免并发时的重复
const globalExistingIds = new Set<string>();

searchQueue.on("active", () => {
  runtimeStore.mediaServerSearch.isSearching = true;
  // 启动后，根据 configStore 的值，自动更新 searchQueue 的并发数
  if (searchQueue.concurrency != configStore.mediaServerEntity.queueConcurrency) {
    searchQueue.concurrency = configStore.mediaServerEntity.queueConcurrency;
    sendMessage("logger", { msg: `Search queue concurrency changed to: ${searchQueue.concurrency}` }).catch();
  }

  // 队列开始活跃时，更新全局 Set
  globalExistingIds.clear();
  runtimeStore.mediaServerSearch.searchResult.forEach((r) => globalExistingIds.add(r.url));
});

searchQueue.on("idle", () => {
  runtimeStore.mediaServerSearch.isSearching = false;

  // 队列空闲时，清空全局 Set
  globalExistingIds.clear();
});

export async function doSearch(option: { searchKey?: string; loadMore?: boolean } = {}) {
  const { searchKey = "", loadMore = false } = option;

  if (searchKey != runtimeStore.mediaServerSearch.searchKey) {
    runtimeStore.resetMediaServerSearchData();
  }

  runtimeStore.mediaServerSearch.searchKey = searchKey;

  // V-19：只搜索「已启用且仍被勾选」的媒体服务器（上面的 watcher 之外再兜一层，
  // 避免 store 变更与本次搜索落在同一 tick 时按旧选择把凭据发给刚被禁用的服务器）
  const enabledIds = metadataStore.getEnabledMediaServers.map((mediaServer) => mediaServer.id);
  for (const mediaServerId of searchMediaServerIds.value.filter((id) => enabledIds.includes(id))) {
    // noinspection ES6MissingAwait
    searchQueue.add(async () => {
      let searchOptions: IMediaServerSearchOptions = { limit: configStore.mediaServerEntity.searchLimit ?? 50 };
      if (loadMore) {
        searchOptions = runtimeStore.mediaServerSearch.searchStatus[mediaServerId]?.options ?? {};
        searchOptions.startIndex = (searchOptions.startIndex ?? 0) + (searchOptions.limit ?? 0);
      }

      const searchResult = await sendMessage("getMediaServerSearchResult", {
        mediaServerId,
        keywords: searchKey,
        options: searchOptions,
      });

      runtimeStore.mediaServerSearch.searchStatus[mediaServerId] = {
        ...omit(searchResult, ["items"]),
        canLoadMore: false,
      };

      if (searchResult.status !== EResultParseStatus.success) {
        const mediaServerDetail = metadataStore.mediaServers[mediaServerId];
        // 只有认证类失败才提示检查认证信息，其余（超时/网络不可达/解析异常）展示真实原因（#1396）
        const failReason =
          searchResult.status === EResultParseStatus.needLogin
            ? "请检查认证信息"
            : (searchResult.errorMessage ?? "未知错误");
        runtimeStore.showSnakebar(
          `媒体服务器 ${mediaServerDetail.name} [${mediaServerDetail.address}] 更新失败：${failReason}`,
          {
            color: "error",
          },
        );
        return;
      }

      // P2-5：先聚合本次新增（去重）的条目，再一次性 push，
      // 避免逐条 push 触发逐条响应式通知与逐次重渲染。
      const newItems: IMediaServerItem[] = [];
      for (const item of searchResult.items) {
        // 根据 url 去重
        if (globalExistingIds.has(item.url)) continue;
        newItems.push(markRaw(item));
        globalExistingIds.add(item.url);
      }

      if (newItems.length > 0) {
        runtimeStore.mediaServerSearch.searchResult.push(...newItems);
        // 如果本次有成功添加的，则认为可以加载更多
        runtimeStore.mediaServerSearch.searchStatus[mediaServerId].canLoadMore = true;
      }
    });
  }
}
