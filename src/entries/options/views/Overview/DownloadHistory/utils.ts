import { throttle } from "es-toolkit";
import { computed, reactive, ref, shallowRef, type Component } from "vue";
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

// 使用 setTimeout 监听下载状态变化
const watchingMap = reactive<Record<TTorrentDownloadKey, number>>({});
// 轮询失败（例如 offscreen 被回收）只提示一次：否则每个卡住的任务都会弹一条，提示本身反而成为噪音
let hasWarnedPollFailure = false;

/**
 * 轮询链的轮次号（N2）。
 *
 * 每个 id 的轮询链都带一个创建时的 `epoch`。`clearWatchingMap()` / 任意一次重新加载都会把
 * `pollEpoch` +1，于是：
 * - 旧链在下一次 `setTimeout` 回调里发现 epoch 不匹配，直接退出（不会在 clear 之后「复活」）；
 * - 已经在 `await sendMessage` 中的旧回调返回后同样会因 epoch 不匹配而丢弃结果、不再递归排链；
 * - `loadDownloadHistory` 捕获开始时的 epoch，若中途发生重载/卸载，也不会用旧数据覆盖新数据或重排链。
 */
let pollEpoch = 0;

function clearPollTimer(downloadHistoryId: TTorrentDownloadKey) {
  const handle = watchingMap[downloadHistoryId];
  if (handle !== undefined) {
    clearTimeout(handle);
    delete watchingMap[downloadHistoryId];
  }
}

function watchDownloadHistory(downloadHistoryId: TTorrentDownloadKey, epoch: number = pollEpoch) {
  // 过期轮次：不再排新链（调用方可能是已被取代的旧加载）
  if (epoch !== pollEpoch) return;
  // 同一记录只允许一条链：先清掉可能存在的旧 handle，避免两个加载各排一条
  clearPollTimer(downloadHistoryId);

  watchingMap[downloadHistoryId] = setTimeout(async () => {
    if (epoch !== pollEpoch) return;
    let history: ITorrentDownloadMetadata | undefined;
    try {
      history = await sendMessage("getDownloadHistoryById", downloadHistoryId);
    } catch {
      // 轮询期间的 rejection 不能逃逸（否则既是 unhandled rejection，又让这条轮询链静默死掉）。
      // 这里不删掉表格里的行——下载可能仍在进行，只是这一轮状态读不到；但要提示用户一次，
      // 否则这些行会永久停在「下载中」而用户毫不知情（options 侧没有可用的日志查看器，见审查报告 L-7）。
      if (epoch !== pollEpoch) return;
      clearPollTimer(downloadHistoryId);
      if (!hasWarnedPollFailure) {
        hasWarnedPollFailure = true;
        useRuntimeStore().showSnakebar(i18n.t("DownloadHistory.pollingError"), { color: "error" });
      }
      return;
    }

    // 等待期间被 clearWatchingMap / 新一轮加载取代：丢弃这次响应，且绝不再排链
    if (epoch !== pollEpoch) return;

    // A-21：记录可能在等待期间被删除（该 handler 返回 IndexedDB 的原始 get，键不存在时是 undefined）。
    // 直接读 `history.downloadStatus` 会在定时器内抛 TypeError、让轮询链静默死掉，
    // 并且 undefined 会残留在 map 里破坏列表行。
    if (!history) {
      clearPollTimer(downloadHistoryId);
      const nextDownloadHistory = { ...downloadHistory.value };
      delete nextDownloadHistory[downloadHistoryId];
      downloadHistory.value = nextDownloadHistory;
      return;
    }

    // V-14：shallowRef 只在 `.value` 被重新赋值时触发；就地写内层对象既不动 ref、也不会让
    // `downloadHistoryList` 失效，表格会一直持有旧记录 ——「下载中/等待中」永远不会翻成「已完成/错误」。
    downloadHistory.value = { ...downloadHistory.value, [downloadHistoryId]: history };

    if (history.downloadStatus == "downloading" || history.downloadStatus == "pending") {
      watchDownloadHistory(downloadHistoryId, epoch);
    } else {
      clearPollTimer(downloadHistoryId);
    }
  }, 1e3) as unknown as number;
}

/** 取消全部轮询链（卸载页面、重新加载列表前调用）。在途回调会因 epoch 失效而丢弃。 */
export function clearWatchingMap() {
  pollEpoch++;
  for (const key of Object.keys(watchingMap)) {
    clearPollTimer(key as unknown as TTorrentDownloadKey);
  }
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
    useRuntimeStore().showSnakebar(i18n.t("DownloadHistory.loadError"), { color: "error" });
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
