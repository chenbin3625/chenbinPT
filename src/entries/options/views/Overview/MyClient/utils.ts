import { computed, markRaw, ref, shallowRef } from "vue";

import type { CTorrent } from "@ptd/downloader";
import { sendMessage } from "@/messages.ts";
import { useMetadataStore } from "@/options/stores/metadata.ts";
import { useRuntimeStore } from "@/options/stores/runtime.ts";
import { useI18n } from "vue-i18n";

// ── module-level shared state ─────────────────────────────────────────────

/**
 * Loaded torrent map keyed by clientId, shared between Index.vue and ClientStatusDialog.vue.
 *
 * P1-20：这里只做「整体替换赋值」（loadSingleDownloader 里 `{ ...torrents.value, [id]: result }`），
 * 没有任何就地修改，所以用 shallowRef 即可：避免数千个种子对象被深度代理，
 * 也避免每次刷新都重新代理整批种子（表格过滤 / 速度求和只需遍历原始对象）。
 */
export const torrents = shallowRef<Record<string, CTorrent[]>>({});

/** Which downloader IDs are selected in the torrent filter (empty = all). */
export const selectedDownloaderIds = ref<string[]>([]);

/** Downloaders whose auto-refresh has been suspended due to ≥3 consecutive failures. */
export const suspendedDownloaders = ref(new Set<string>());

export const DEFAULT_CLIENT_REFRESH_INTERVAL_SECONDS = 30;

/** Global auto-refresh interval in seconds (0 = off). */
export const globalRefreshInterval = ref(DEFAULT_CLIENT_REFRESH_INTERVAL_SECONDS);

/** Whether auto-refresh is currently running. */
export const autoRefreshRunning = ref(false);

// private – not reactive, managed by the composable only
const failCounts = new Map<string, number>();
const refreshTimers = new Map<string, number>();

/**
 * 种子的全局唯一键。
 *
 * 同一 info hash 的种子可能同时存在于多个下载器上（qBittorrent 的 id 就是 info hash），
 * 所以表格行 key / 已加载标记都必须带上 clientId，只用 id 会撞键。
 */
export function torrentKey(torrent: CTorrent): string {
  return `${torrent.clientId}:${String(torrent.id)}`;
}

/**
 * 「按种子身份记录加载状态」的请求守卫（B-30）。
 *
 * TorrentDetailDialog 是复用实例：关闭时清空数据并复位加载标记，但无法取消在途请求。
 * 若迟到的响应直接写回，就会把上一个种子的数据与「已加载」状态留给下一个种子
 * （随后 removeTracker / updateFilePriority 会对着错误的种子发操作）。
 *
 * 因此把「已加载」标记按种子身份（torrentKey）记录，所有写回都必须经由 commit：
 * 「校验 + 写入 + 标记已加载」绑定在一起，调用方无法只做其中一步。
 */
export function createTorrentLoadGuard(isDialogOpen: () => boolean, getTorrent: () => CTorrent | null | undefined) {
  const loadedFor = ref<string | null>(null);

  /** 当前弹窗展示的种子身份；null 表示当前没有种子 */
  const currentKey = computed(() => {
    const torrent = getTorrent();
    return torrent ? torrentKey(torrent) : null;
  });

  /** 是否已经为「当前这个种子」加载过（而不是为上一个种子加载过） */
  const isLoaded = computed(() => currentKey.value !== null && loadedFor.value === currentKey.value);

  /** 发起请求时记录本次请求的目标种子身份，供后续 isStale / commit 使用 */
  function begin(): string | null {
    return currentKey.value;
  }

  /** 响应是否已过期：弹窗已关闭，或当前种子已不是发起请求时的那个 */
  function isStale(requestKey: string | null): boolean {
    return !isDialogOpen() || requestKey === null || requestKey !== currentKey.value;
  }

  /**
   * 写回响应：仅在响应未过期时执行 `apply`。
   *
   * @param markLoaded 成功拿到数据时为 true（默认）；失败分支传 false，
   *   以免把一次失败当成「已加载」而不再重试。
   * @returns 是否真正写回（调用方可据此决定是否清空输入框等后续动作）
   */
  function commit(requestKey: string | null, apply: () => void, markLoaded = true): boolean {
    if (isStale(requestKey)) return false;
    apply();
    if (markLoaded) {
      loadedFor.value = requestKey;
    }
    return true;
  }

  function reset() {
    loadedFor.value = null;
  }

  return { currentKey, isLoaded, begin, isStale, commit, reset };
}

export function finishTorrentLoad(
  guard: Pick<ReturnType<typeof createTorrentLoadGuard>, "isStale">,
  requestKey: string | null,
  setLoading: () => void,
): void {
  if (!guard.isStale(requestKey)) {
    setLoading();
  }
}

export function normalizeTorrentProgress(value: unknown): number {
  const progress = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(progress)) return 0;
  return Math.min(100, Math.max(0, progress));
}

export function formatTorrentProgressLabel(value: unknown): string {
  return `${normalizeTorrentProgress(value).toFixed(0)}%`;
}

// ── composable ────────────────────────────────────────────────────────────

/**
 * Composable providing auto-refresh logic for the MyClient page.
 * All state is module-level and shared across component instances.
 */
export function useClientRefresh() {
  const { t } = useI18n();
  const metadataStore = useMetadataStore();
  const runtimeStore = useRuntimeStore();

  const enabledDownloaders = computed(() => metadataStore.getEnabledDownloaders);

  const activeDownloaderIds = computed(() =>
    selectedDownloaderIds.value.length > 0 ? selectedDownloaderIds.value : enabledDownloaders.value.map((d) => d.id),
  );

  function clearDownloaderTimer(id: string) {
    const tid = refreshTimers.get(id);
    if (tid !== undefined) {
      clearTimeout(tid);
      refreshTimers.delete(id);
    }
  }

  async function loadSingleDownloader(id: string): Promise<void> {
    try {
      const result = await sendMessage("getClientTorrents", id);
      // P1-20：结果来自 sendMessage 的结构化克隆，永远不会被就地修改，标记为 raw 避免被代理
      torrents.value = { ...torrents.value, [id]: markRaw(result) };
      failCounts.set(id, 0);
    } catch {
      const prev = failCounts.get(id) ?? 0;
      const next = prev + 1;
      failCounts.set(id, next);
      if (next >= 3) {
        suspendedDownloaders.value.add(id);
        clearDownloaderTimer(id);
        runtimeStore.showSnakebar(
          t("MyClient.autoRefresh.clientSuspended", { name: metadataStore.downloaders[id]?.name ?? id }),
          { color: "error", timeout: 8000 },
        );
      }
    }
  }

  function scheduleDownloaderRefresh(id: string) {
    if (!autoRefreshRunning.value) return;
    if (suspendedDownloaders.value.has(id)) return;
    if (globalRefreshInterval.value <= 0) return;

    clearDownloaderTimer(id);
    const tid = window.setTimeout(async () => {
      await loadSingleDownloader(id);
      scheduleDownloaderRefresh(id);
    }, globalRefreshInterval.value * 1000);
    refreshTimers.set(id, tid);
  }

  function stopAllTimers() {
    for (const id of refreshTimers.keys()) {
      clearDownloaderTimer(id);
    }
    autoRefreshRunning.value = false;
  }

  /** Reset failure-tracking and suspended state (call before a manual full reload). */
  function resetRefreshState() {
    suspendedDownloaders.value = new Set();
    failCounts.clear();
  }

  function resumeDownloaderRefresh(id: string) {
    suspendedDownloaders.value.delete(id);
    failCounts.set(id, 0);
    if (autoRefreshRunning.value) {
      scheduleDownloaderRefresh(id);
    }
  }

  function startAutoRefresh() {
    if (globalRefreshInterval.value <= 0) return;
    autoRefreshRunning.value = true;
    for (const id of activeDownloaderIds.value) {
      scheduleDownloaderRefresh(id);
    }
  }

  function stopAutoRefresh() {
    stopAllTimers();
    resetRefreshState();
  }

  function toggleAutoRefresh() {
    if (autoRefreshRunning.value) {
      stopAutoRefresh();
    } else {
      startAutoRefresh();
    }
  }

  return {
    enabledDownloaders,
    activeDownloaderIds,
    loadSingleDownloader,
    clearDownloaderTimer,
    scheduleDownloaderRefresh,
    stopAllTimers,
    resetRefreshState,
    resumeDownloaderRefresh,
    startAutoRefresh,
    stopAutoRefresh,
    toggleAutoRefresh,
  };
}
