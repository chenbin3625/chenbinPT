import { throttle } from "es-toolkit";
import { computed, ref, shallowRef, type Component } from "vue";
import { CheckOutlined, ClockCircleOutlined, DownloadOutlined, WarningOutlined } from "@ant-design/icons-vue";
import { sendMessage } from "@/messages.ts";
import { i18n } from "@/options/plugins/i18n.ts";
import { useRuntimeStore } from "@/options/stores/runtime.ts";
import { useTableCustomFilter } from "@/options/directives/useAdvanceFilter.ts";

import type { ITorrentDownloadMetadata, TTorrentDownloadKey } from "@/shared/types.ts";

// 使用 shallowRef 优化大量下载历史数据的性能
export const downloadHistory = shallowRef<Record<TTorrentDownloadKey, ITorrentDownloadMetadata>>({});
export const downloadHistoryList = computed(() => Object.values(downloadHistory.value));

// 下载历史需要经 sendMessage 从后台异步读取，导出该状态供页面绑定表格 loading，
// 避免首屏在请求返回前闪现「暂无数据」
export const isLoadingDownloadHistory = ref<boolean>(false);

export const tableCustomFilter = useTableCustomFilter({
  parseOptions: {
    keywords: ["siteId", "downloaderId", "downloadStatus"],
    ranges: ["downloadAt"],
  },
  titleFields: ["title", "subTitle"],
  initialItems: downloadHistoryList,
  format: {
    downloadAt: "date",
  },
});

// 轮询：所有「下载中/等待中」记录共用**一个**定时器，每轮并发查询后只整体替换一次 map。
// 旧实现为每条记录各排一条 1s setTimeout，且每条回包都复制并替换整个 map：
// K 条记录 = 每秒 K 条消息 + K 次全表重算/重渲染。集中后同一轮只触发一次列表失效。
const watchingIds = new Set<TTorrentDownloadKey>();
let pollTimer: ReturnType<typeof setTimeout> | null = null;
// 轮询失败（例如 offscreen 被回收）只提示一次：否则每个卡住的任务都会弹一条，提示本身反而成为噪音
let hasWarnedPollFailure = false;

/**
 * 轮询轮次号（N2）。
 *
 * `clearWatchingMap()` / 任意一次重新加载都会把 `pollEpoch` +1，于是：
 * - 旧轮次排下的定时器触发时发现 epoch 不匹配，直接退出（不会在 clear 之后「复活」）；
 * - 已经在 `await` 中的旧回调返回后同样会因 epoch 不匹配而丢弃结果、不再排下一轮；
 * - `loadDownloadHistory` 捕获开始时的 epoch，若中途发生重载/卸载，也不会用旧数据覆盖新数据或重排轮询。
 */
let pollEpoch = 0;

function stopPollTimer() {
  if (pollTimer !== null) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

function scheduleNextPoll(delay: number, epoch: number) {
  if (epoch !== pollEpoch || watchingIds.size === 0) return;
  if (pollTimer !== null) return; // 已有下一轮，等它跑完再排
  // 页面隐藏期间不排下一轮。只在 visibilitychange 里 stop 是不够的：隐藏恰好发生在
  // 一次 await 期间时，回包后的这里会重新排上定时器，之后就一直「隐藏也在轮询」。
  if (typeof document !== "undefined" && document.hidden) return;
  pollTimer = setTimeout(() => void pollWatching(epoch), delay);
}

async function pollWatching(epoch: number) {
  pollTimer = null;
  if (epoch !== pollEpoch || watchingIds.size === 0) return;

  const ids = [...watchingIds];
  const results = await Promise.allSettled(ids.map((id) => sendMessage("getDownloadHistoryById", id)));

  // 等待期间被 clearWatchingMap / 新一轮加载取代：丢弃这次响应，且不再排下一轮
  if (epoch !== pollEpoch) return;

  let nextHistory = downloadHistory.value;
  let changed = false;
  let failed = false;

  ids.forEach((id, index) => {
    const result = results[index]!;
    if (result.status === "rejected") {
      // 一轮里只要有一条失败就提示一次（hasWarnedPollFailure 保证每次加载最多一条），
      // 并让整轮退避到 5s；下载可能仍在进行，不删表格行。
      failed = true;
      return;
    }

    // A-21：记录可能在等待期间被删除（handler 返回 IndexedDB 的原始 get，键不存在时是 undefined）。
    // 直接读 `history.downloadStatus` 会抛 TypeError、让轮询静默死掉，undefined 还会残留在 map 里破坏列表行。
    const history = result.value as ITorrentDownloadMetadata | undefined;
    if (!history) {
      if (nextHistory === downloadHistory.value) nextHistory = { ...downloadHistory.value };
      delete nextHistory[id];
      watchingIds.delete(id);
      changed = true;
      return;
    }

    // V-14：shallowRef 只在 `.value` 被重新赋值时触发；就地写内层对象不会让 `downloadHistoryList` 失效。
    // 同一轮先累积到同一个副本里，循环结束后只赋值一次。
    if (nextHistory === downloadHistory.value) nextHistory = { ...downloadHistory.value };
    nextHistory[id] = history;
    changed = true;
    if (history.downloadStatus !== "downloading" && history.downloadStatus !== "pending") {
      watchingIds.delete(id);
    }
  });

  if (changed) {
    downloadHistory.value = nextHistory;
  }

  if (failed && !hasWarnedPollFailure) {
    hasWarnedPollFailure = true;
    useRuntimeStore().showSnackbar(i18n.t("DownloadHistory.pollingError"), { color: "error" });
  }

  // 失败时退避到 5s，避免 offscreen 不可用时每秒重试一次
  scheduleNextPoll(failed ? 5e3 : 1e3, epoch);
}

function watchDownloadHistory(downloadHistoryId: TTorrentDownloadKey, epoch: number = pollEpoch) {
  // 过期轮次：不再加入（调用方可能是已被取代的旧加载）
  if (epoch !== pollEpoch) return;
  watchingIds.add(downloadHistoryId);
  scheduleNextPoll(1e3, epoch);
}

/** 取消全部轮询（卸载页面、重新加载列表前调用）。在途回调会因 epoch 失效而丢弃。 */
export function clearWatchingMap() {
  pollEpoch++;
  watchingIds.clear();
  stopPollTimer();
}

// 页面隐藏时不再轮询（表格没人看），恢复可见后继续。定时器只在本模块被加载的管理页里存在。
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      stopPollTimer();
    } else {
      scheduleNextPoll(1e3, pollEpoch);
    }
  });
}

/**
 * 批量删除 / 重新下载只作用于「当前筛选下可见」的记录（N3）。
 *
 * antd 的 `selectedRowKeys` 不会在数据源被筛选时裁剪：全选后再输入筛选词，隐藏记录仍留在
 * 选中集合里，直接用 `tableSelected` 会删除/重下看不见的记录（下载历史没有回收站）。
 */
export function pickVisibleDownloadHistoryIds(
  selectedIds: TTorrentDownloadKey[],
  visibleItems: ITorrentDownloadMetadata[],
): TTorrentDownloadKey[] {
  const visibleKeys = new Set(visibleItems.map((item) => item.id!));
  return selectedIds.filter((id) => visibleKeys.has(id));
}

// 加载序号：卸载后重新进入页面会立刻发起新一轮加载，旧请求的 finally 不能把新一轮的 loading 关掉
let loadSequence = 0;

async function loadDownloadHistory() {
  // N2：重入保护 —— 首屏加载在途时重复点「刷新」不再并发发一次全量请求。
  // 否则两次加载会各自对同一记录排一条轮询链（旧链 handle 被覆盖后变成杀不掉的孤儿链）。
  if (isLoadingDownloadHistory.value) return;

  // 首先清除所有的下载状态监听
  clearWatchingMap();
  const epoch = pollEpoch;
  const sequence = ++loadSequence;
  // 每次重新加载（含用户手动刷新）都允许再提示一次轮询失败
  hasWarnedPollFailure = false;

  isLoadingDownloadHistory.value = true;
  try {
    const history: ITorrentDownloadMetadata[] = await sendMessage("getDownloadHistory", undefined);
    // 等待期间又被卸载 / 重载：不要用旧响应覆盖新状态，也不要重排轮询链
    if (epoch !== pollEpoch) return;
    // 整体替换当前下载记录：先构建完整映射再赋值，避免「先置空、再就地填充」在同一 tick 内让
    // computed 拿到空对象（V-14 同类问题的另一面）
    const nextHistory: Record<TTorrentDownloadKey, ITorrentDownloadMetadata> = {};
    history.forEach((item) => {
      nextHistory[item.id!] = item;
    });
    downloadHistory.value = nextHistory;

    history.forEach((item) => {
      if (item.downloadStatus == "downloading" || item.downloadStatus == "pending") {
        watchDownloadHistory(item.id!, epoch);
      }
    });
    tableCustomFilter.buildAdvanceItemPropsFn();
  } catch (e) {
    // N4：整表加载失败原先没有 catch —— 浏览器里是 unhandled rejection，列表保持空/旧数据，
    // 用户以为历史被清空。这里保留旧数据并明确提示（与轮询失败的处理对齐）。
    // L2（F1）：改用 DownloadHistory 专用 key，不再借用备份恢复的文案。
    useRuntimeStore().showSnackbar(i18n.t("DownloadHistory.loadError"), { color: "error" });
  } finally {
    // 无论成功与否都要复位 loading（throttleLoadDownloadHistory 也复用本函数）；
    // 只有「最新一轮」才允许复位，避免上一轮迟到的 finally 关掉新一轮的 loading
    if (sequence === loadSequence) {
      isLoadingDownloadHistory.value = false;
    }
  }
}

export const throttleLoadDownloadHistory = throttle(loadDownloadHistory, 1e3);

export const downloadStatusMap = computed<
  Record<ITorrentDownloadMetadata["downloadStatus"], { title: string; icon: Component; color: string }>
>(() => ({
  downloading: { title: i18n.t("DownloadHistory.status.downloading"), icon: DownloadOutlined, color: "blue" },
  pending: { title: i18n.t("DownloadHistory.status.pending"), icon: ClockCircleOutlined, color: "orange" },
  completed: { title: i18n.t("DownloadHistory.status.completed"), icon: CheckOutlined, color: "green" },
  failed: { title: i18n.t("DownloadHistory.status.failed"), icon: WarningOutlined, color: "red" },
}));
