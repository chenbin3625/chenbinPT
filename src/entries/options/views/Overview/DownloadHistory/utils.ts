import { throttle } from "es-toolkit";
import { computed, reactive, ref, shallowRef, type Component } from "vue";
import { CheckOutlined, ClockCircleOutlined, DownloadOutlined, WarningOutlined } from "@ant-design/icons-vue";
import { sendMessage } from "@/messages.ts";
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
function watchDownloadHistory(downloadHistoryId: TTorrentDownloadKey) {
  watchingMap[downloadHistoryId] = setTimeout(async () => {
    let history: ITorrentDownloadMetadata | undefined;
    try {
      history = await sendMessage("getDownloadHistoryById", downloadHistoryId);
    } catch {
      // 轮询期间的 rejection 不能逃逸（否则既是 unhandled rejection，又让这条轮询链静默死掉）。
      // 这里不删掉表格里的行——下载可能仍在进行，只是这一轮状态读不到；但要提示用户一次，
      // 否则这些行会永久停在「下载中」而用户毫不知情（options 侧没有可用的日志查看器，见审查报告 L-7）。
      delete watchingMap[downloadHistoryId];
      if (!hasWarnedPollFailure) {
        hasWarnedPollFailure = true;
        useRuntimeStore().showSnakebar("刷新下载状态失败，部分任务的状态可能不会自动更新", { color: "error" });
      }
      return;
    }

    // A-21：记录可能在等待期间被删除（该 handler 返回 IndexedDB 的原始 get，键不存在时是 undefined）。
    // 直接读 `history.downloadStatus` 会在定时器内抛 TypeError、让轮询链静默死掉，
    // 并且 undefined 会残留在 map 里破坏列表行。
    if (!history) {
      delete watchingMap[downloadHistoryId];
      const nextDownloadHistory = { ...downloadHistory.value };
      delete nextDownloadHistory[downloadHistoryId];
      downloadHistory.value = nextDownloadHistory;
      return;
    }

    // V-14：shallowRef 只在 `.value` 被重新赋值时触发；就地写内层对象既不动 ref、也不会让
    // `downloadHistoryList` 失效，表格会一直持有旧记录 ——「下载中/等待中」永远不会翻成「已完成/错误」。
    downloadHistory.value = { ...downloadHistory.value, [downloadHistoryId]: history };

    if (history.downloadStatus == "downloading" || history.downloadStatus == "pending") {
      watchDownloadHistory(downloadHistoryId);
    } else {
      delete watchingMap[downloadHistoryId];
    }
  }, 1e3) as unknown as number;
}

export function clearWatchingMap() {
  for (const key of Object.keys(watchingMap)) {
    clearTimeout(watchingMap[key as unknown as number]);
    delete watchingMap[key as unknown as number];
  }
}

async function loadDownloadHistory() {
  // 首先清除所有的下载状态监听
  clearWatchingMap();
  // 每次重新加载（含用户手动刷新）都允许再提示一次轮询失败
  hasWarnedPollFailure = false;

  isLoadingDownloadHistory.value = true;
  try {
    const history: ITorrentDownloadMetadata[] = await sendMessage("getDownloadHistory", undefined);
    // 整体替换当前下载记录：先构建完整映射再赋值，避免「先置空、再就地填充」在同一 tick 内让
    // computed 拿到空对象（V-14 同类问题的另一面）
    const nextHistory: Record<TTorrentDownloadKey, ITorrentDownloadMetadata> = {};
    history.forEach((item) => {
      nextHistory[item.id!] = item;
    });
    downloadHistory.value = nextHistory;

    history.forEach((item) => {
      if (item.downloadStatus == "downloading" || item.downloadStatus == "pending") {
        watchDownloadHistory(item.id!);
      }
    });
    tableCustomFilter.buildAdvanceItemPropsFn();
  } finally {
    // 无论成功与否都要复位 loading（throttleLoadDownloadHistory 也复用本函数）
    isLoadingDownloadHistory.value = false;
  }
}

export const throttleLoadDownloadHistory = throttle(loadDownloadHistory, 1e3);

export const downloadStatusMap: Record<
  ITorrentDownloadMetadata["downloadStatus"],
  { title: string; icon: Component; color: string }
> = {
  downloading: { title: "下载中", icon: DownloadOutlined, color: "blue" },
  pending: { title: "等待中", icon: ClockCircleOutlined, color: "orange" },
  completed: { title: "已完成", icon: CheckOutlined, color: "green" },
  failed: { title: "错误", icon: WarningOutlined, color: "red" },
};
