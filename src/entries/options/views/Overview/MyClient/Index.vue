<script setup lang="ts">
import {
  ClockCircleOutlined,
  CloudUploadOutlined,
  DashboardOutlined,
  DatabaseOutlined,
  DoubleLeftOutlined,
  DoubleRightOutlined,
  DeleteOutlined,
  DownOutlined,
  FieldTimeOutlined,
  FileSearchOutlined,
  PauseOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  SettingOutlined,
  StopOutlined,
  SwapOutlined,
  SyncOutlined,
  TagOutlined,
  UpOutlined,
} from "@ant-design/icons-vue";
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import ColumnSelector from "../components/ColumnSelector.vue";
import {
  applyTableActionColumn,
  toAntdColumns,
  toPagination,
  toSortBy,
  useTableActionColumnLayout,
  useMainTableSticky,
} from "../utils/antdTable.ts";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";
import { refDebounced } from "@vueuse/core";
import type { DataTableHeader } from "@/options/types/dataTable.ts";

import {
  CTorrentState,
  getDownloaderIcon,
  getDownloaderMetaData,
  type CTorrent,
  type TorrentClientMetaData,
  type TorrentQueueDirection,
} from "@ptd/downloader";
import { sendMessage } from "@/messages.ts";
import { formatDateTimeForTable, formatRatio, formatSize, isRatioHealthy } from "@/options/utils.ts";
import { useMetadataStore } from "@/options/stores/metadata.ts";
import { useRuntimeStore } from "@/options/stores/runtime.ts";
import { useConfigStore } from "@/options/stores/config.ts";

import NoDataPlaceholder from "@/options/components/NoDataPlaceholder.vue";
import ToolbarActions, { type ToolbarAction } from "@/options/components/ToolbarActions.vue";

import DeleteDialog from "./DeleteDialog.vue";
import PushToDownloaderDialog from "./PushToDownloaderDialog.vue";
import TorrentSiteTd from "./TorrentSiteTd.vue";
import TorrentStateTd from "./TorrentStateTd.vue";
import ClientStatusDialog from "./ClientStatusDialog.vue";
import TorrentDetailDialog from "./TorrentDetailDialog.vue";
import SpeedLimitDialog from "./SpeedLimitDialog.vue";
import LabelDialog from "./LabelDialog.vue";
import RecheckConfirmDialog from "./RecheckConfirmDialog.vue";

import {
  torrents,
  selectedDownloaderIds,
  suspendedDownloaders,
  autoRefreshRunning,
  autoRefreshUserStopped,
  globalRefreshInterval,
  normalizeTorrentProgress,
  formatTorrentProgressLabel,
  summarizeBatchResults,
  formatBatchOpMessage,
  batchOpColor,
  torrentKey,
  useClientRefresh,
} from "./utils.ts";

// 页面级表格表头吸顶（滚动容器是 #ptd-main，见 useMainTableSticky 的说明）
const mainTableSticky = useMainTableSticky();

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const metadataStore = useMetadataStore();
const runtimeStore = useRuntimeStore();
const configStore = useConfigStore();

const {
  activeDownloaderIds,
  loadSingleDownloader,
  scheduleDownloaderRefresh,
  clearDownloaderTimer,
  clearAllTimers,
  stopAllTimers,
  resetRefreshState,
  resumeDownloaderRefresh,
  startAutoRefresh,
  toggleAutoRefresh,
  beginPageRefresh,
  endPageRefresh,
} = useClientRefresh();

// ── state ──────────────────────────────────────────────────────────────────
const loading = ref(false);
const pendingCommand = ref<"pause" | "resume" | "queue" | null>(null);

const tableSelected = ref<CTorrent[]>([]);
const searchText = ref("");
// P1-20：搜索框输入做防抖，避免每敲一个字符都对数千种子做一次全量过滤
const searchTextDebounced = refDebounced(searchText, 300);

// delete dialog
const showDeleteDialog = ref(false);
const toDeleteTorrents = ref<CTorrent[]>([]);
// DOWNLOADER-3：删除失败的「原因」通道（下载器实体只回 boolean，见 confirmDeleteTorrent）
const deleteFailureHints = ref<Record<string, string>>({});

// push to downloader dialog
const showPushToDownloaderDialog = ref(false);

// detail dialog
const showDetailDialog = ref(false);
const detailTorrent = ref<CTorrent | null>(null);

// speed limit dialog
const showSpeedLimitDialog = ref(false);
const toSpeedLimitTorrents = ref<CTorrent[]>([]);

// label dialog
const showLabelDialog = ref(false);
const toLabelTorrents = ref<CTorrent[]>([]);

// recheck confirm dialog
const showRecheckDialog = ref(false);
const toRecheckTorrents = ref<CTorrent[]>([]);

// client status dialog
const showClientStatusDialog = ref(false);

const totalUpSpeed = computed(() => allTorrents.value.reduce((acc, t) => acc + (t.uploadSpeed ?? 0), 0));
const totalDlSpeed = computed(() => allTorrents.value.reduce((acc, t) => acc + (t.downloadSpeed ?? 0), 0));

// ── computed ───────────────────────────────────────────────────────────────
/**
 * 当前筛选（已启用 / 已被选中的下载器）里的全部种子。
 *
 * D2-10：页头统计（种子数 / 上下行速度）原先用 `Object.values(torrents)`（全部缓存），
 * 只看某个下载器时统计仍是全部下载器之和；且模块级 `torrents` 不会剔除已停用/已删除下载器的键，
 * 停用后旧数据会一直计入。这里以 `activeDownloaderIds` 为准，停用/删除的缓存由下方 watcher 清理。
 */
const allTorrents = computed(() => activeDownloaderIds.value.flatMap((id) => torrents.value[id] ?? []));

const tableColumns = computed(() =>
  // 操作列位置 / 固定（#1598）：先按可见列过滤 → toAntdColumns，最后再调整操作列位置
  applyTableActionColumn(
    toAntdColumns(fullTableHeader.value, {
      sortBy: configStore.tableBehavior["MyClient"]?.sortBy,
      multiSort: configStore.enableTableMultiSort,
      visibleKeys: (configStore.tableBehavior["MyClient"] as any)?.columns,
    }),
  ),
);
// 操作列固定在行首时，行首的选择列要一起固定
const { rowSelectionFixed } = useTableActionColumnLayout();
const tablePagination = computed(() =>
  toPagination(configStore.tableBehavior["MyClient"]?.itemsPerPage ?? 25, (v) =>
    configStore.updateTableBehavior("MyClient", "itemsPerPage", v),
  ),
);
function onSelectionChange(_keys: (string | number)[], rows: CTorrent[]) {
  tableSelected.value = rows;
}
function onTableChange(_pagination: unknown, _filters: unknown, sorter: unknown) {
  configStore.updateTableBehavior("MyClient", "sortBy", toSortBy(sorter as never));
}

const filteredTorrents = computed(() => {
  const active = activeDownloaderIds.value;
  const base = active.flatMap((id) => torrents.value[id] ?? []);
  if (!searchTextDebounced.value) return base;
  const q = searchTextDebounced.value.toLowerCase();
  return base.filter(
    (t) =>
      t.name.toLowerCase().includes(q) ||
      t.infoHash.toLowerCase().includes(q) ||
      (t.label ?? "").toLowerCase().includes(q) ||
      t.savePath.toLowerCase().includes(q),
  );
});

/**
 * 批量操作只作用于「当前可见且仍被勾选」的种子（D2-07）。
 *
 * antd 的 `selectedRowKeys` 不会在数据源被筛选时主动裁剪：用户先全选、再输入搜索词过滤，
 * 隐藏行仍留在选中集合里，此时点删除/限速/标签会作用到看不见的行。这里用当前可见集合求交，
 * 所有批量入口（按钮禁用条件、确认框、批量弹窗）都只使用这个交集。
 */
const selectedTorrents = computed(() => {
  const visibleKeys = new Set(filteredTorrents.value.map((t) => torrentKey(t)));
  return tableSelected.value.filter((t) => visibleKeys.has(torrentKey(t)));
});

// 当前选中种子的下载器类型对应的能力元数据（用于显示可用操作）
const clientMetaMap = ref<Record<string, TorrentClientMetaData>>({});

async function ensureClientMeta(clientId: string) {
  const type = metadataStore.downloaders[clientId]?.type;
  if (type && !clientMetaMap.value[type]) {
    clientMetaMap.value[type] = await getDownloaderMetaData(type);
  }
}

/** 判断某个 feature 在该下载器上是否可用 */
function isFeatureAllowed(clientId: string, feature: keyof TorrentClientMetaData["feature"]): boolean {
  const type = metadataStore.downloaders[clientId]?.type;
  return clientMetaMap.value[type]?.feature?.[feature]?.allowed !== false;
}

/**
 * 批量操作的能力门禁（N7）。
 *
 * 行内按钮一直按 `isFeatureAllowed` 隐藏，但批量入口原先完全不看能力：对 Aria2/Flood 等
 * 不支持标签/限速的客户端批量操作，实体按契约返回 false，用户只看到「已设置 0 个」，
 * 无法判断是「不支持」还是「网络失败」。这里要求所选种子**全部**支持该能力才允许批量操作，
 * 与行内按钮「不支持就不显示」的语义保持一致。
 */
function isFeatureAllowedForAll(list: CTorrent[], feature: keyof TorrentClientMetaData["feature"]): boolean {
  return list.every((t) => isFeatureAllowed(t.clientId, feature));
}

// 在表格渲染时按需加载选中/可见种子的客户端能力元数据
async function loadVisibleClientMeta() {
  const ids = new Set(allTorrents.value.map((t) => t.clientId));
  await Promise.all([...ids].map(ensureClientMeta));
}

// ── table headers ─────────────────────────────────────────────────────────
const fullTableHeader = computed(
  () =>
    [
      // 说明：数值列不再写死 width，交给 auto 布局按内容分配，只保留「客户端 / 添加时间 / 操作」
      // 三个硬约束。13 列全部写死宽度时，叠加数值列 nowrap 的文本，表格最小宽度会超过
      // 1152–1536 窗口下的可用宽度（见 docs/style-layout-audit.md 第 7 条），从而挤出横向滚动条。
      { title: t("MyClient.table.client"), key: "clientId", align: "center", width: "90", props: { disabled: true } },
      { title: t("MyClient.table.name"), key: "name", align: "start", maxWidth: "20rem", props: { disabled: true } },
      {
        // 站点判定在 loadSingleDownloader 中统一完成（urls / legacyUrls / trackerUrls 的 host 匹配），
        // 判定未完成的行先显示加载态，故该列不参与排序
        title: t("common.site"),
        key: "site",
        align: "center",
        sortable: false,
      },
      { title: t("MyClient.table.size"), key: "totalSize", align: "end" },
      { title: t("MyClient.table.progress"), key: "progress", align: "end", width: "120" },
      { title: t("MyClient.table.status"), key: "state", align: "center" },
      { title: t("MyClient.table.upSpeed"), key: "uploadSpeed", align: "end" },
      { title: t("MyClient.table.dlSpeed"), key: "downloadSpeed", align: "end" },
      { title: t("MyClient.table.totalUploaded"), key: "totalUploaded", align: "end" },
      { title: t("MyClient.table.totalDownloaded"), key: "totalDownloaded", align: "end" },
      { title: t("MyClient.table.ratio"), key: "ratio", align: "end" },
      { title: t("MyClient.table.savePath"), key: "savePath", align: "start", maxWidth: "16rem" },
      { title: t("MyClient.table.addedAt"), key: "dateAdded", align: "center", width: "110" },
      {
        title: t("common.action"),
        key: "action",
        align: "center",
        sortable: false,
        width: "150",
        props: { disabled: true },
      },
    ] as (DataTableHeader & { props?: any })[],
);

// ── data loading ──────────────────────────────────────────────────────────
/** Manual full refresh: fetch all active downloaders, reset error state. */
async function loadTorrents() {
  loading.value = true;
  tableSelected.value = [];
  resetRefreshState();
  try {
    await Promise.allSettled(activeDownloaderIds.value.map((id) => loadSingleDownloader(id)));
  } finally {
    loading.value = false;
    await loadVisibleClientMeta();
    if (autoRefreshRunning.value) {
      for (const id of activeDownloaderIds.value) {
        scheduleDownloaderRefresh(id);
      }
    }
  }
}

let mounted = false;
let initialized = false;

/**
 * 清理「已停用 / 已删除」下载器留下的状态（D2-10 / N14）。
 *
 * - `selectedDownloaderIds` 是模块级筛选状态，跨路由保留：用户从「设置 → 下载器」删除某下载器后
 *   回到本页，原先仍按失效 id 过滤（表格空白、clientName 回退成原始 id、还会继续对它发请求）；
 * - `torrents` 也只增不减：停用下载器后旧数据一直计入页头统计，直到整页刷新。
 */
function pruneInactiveDownloaderState() {
  const enabledIds = metadataStore.getEnabledDownloaders.map((d) => d.id);

  const nextSelection = selectedDownloaderIds.value.filter((id) => enabledIds.includes(id));
  if (nextSelection.length !== selectedDownloaderIds.value.length) {
    selectedDownloaderIds.value = nextSelection;
  }

  const nextTorrents: Record<string, CTorrent[]> = {};
  for (const [id, list] of Object.entries(torrents.value)) {
    if (enabledIds.includes(id)) nextTorrents[id] = list;
  }
  if (Object.keys(nextTorrents).length !== Object.keys(torrents.value).length) {
    torrents.value = nextTorrents;
  }
}

watch(
  () => metadataStore.getEnabledDownloaders.map((d) => d.id),
  () => {
    if (initialized) pruneInactiveDownloaderState();
  },
);

watch(activeDownloaderIds, (ids, previousIds) => {
  if (!initialized || !mounted) return;
  for (const id of previousIds ?? []) {
    if (!ids.includes(id)) clearDownloaderTimer(id);
  }
  for (const id of ids) {
    if (!previousIds?.includes(id)) {
      if (autoRefreshRunning.value) scheduleDownloaderRefresh(id);
      void loadSingleDownloader(id);
    }
  }
});
watch(globalRefreshInterval, (value) => {
  if (!initialized || !autoRefreshRunning.value) return;
  // N5：间隔改为 0 表示关闭自动刷新。原实现只清定时器不清状态：按钮仍显示「停止自动刷新」，
  // 实际一个定时器都没有。这里直接走 stopAllTimers，让运行状态与「有没有定时器」保持一致。
  if (value <= 0) {
    stopAllTimers();
    return;
  }
  for (const id of activeDownloaderIds.value) {
    clearDownloaderTimer(id);
    scheduleDownloaderRefresh(id);
  }
});

onMounted(async () => {
  mounted = true;
  await Promise.all([metadataStore.$onReady(), configStore.$onReady()]);
  if (!mounted) return;
  // 激活页面级刷新会话：离开页面后，旧的在途请求回调会因 epoch 不匹配而不再续订定时器
  beginPageRefresh();
  // 支持从 SetDownloader 等页面通过 ?downloader=<id> 预选单个下载服务器
  const queryDownloaderId = route.query.downloader as string | undefined;
  let hasQueryDownloader = false;
  if (queryDownloaderId && metadataStore.downloaders[queryDownloaderId]) {
    hasQueryDownloader = true;
    selectedDownloaderIds.value = [queryDownloaderId];
    // 预选是一次性导航行为，清除 URL query 避免刷新页面后重复预选
    void router.replace({ path: "/my-client" });
  }

  initialized = true;

  // D2-06：先记录「挂载前」的自动刷新状态，再决定要不要重新启动。
  // 原实现无条件 startAutoRefresh()，随后条件里又用刚被置 true 的 autoRefreshRunning 兜底，
  // 因此 initDownloaderTorrentOnEnter=false 永远被忽略；卸载时 stopAllTimers() 还会把用户
  // 手动「停止自动刷新」的选择一起复位。
  const autoRefreshWasRunning = autoRefreshRunning.value;

  // 清理失效下载器的残留状态（停用/删除后再次进入页面）
  pruneInactiveDownloaderState();

  if (!autoRefreshUserStopped.value) {
    startAutoRefresh();
  }

  if (hasQueryDownloader || configStore.download.initDownloaderTorrentOnEnter || autoRefreshWasRunning) {
    void loadTorrents();
  }
});

onUnmounted(() => {
  mounted = false;
  initialized = false;
  // 先让在途请求回调失效（否则它们会在 await 之后重新挂上定时器），再清定时器；
  // 保留「是否运行 / 用户是否主动停止」的模块级选择，供下次进入页面恢复（D2-06）。
  endPageRefresh();
  clearAllTimers();
});

// ── actions ───────────────────────────────────────────────────────────────
/** D2-09：批量操作统一提示「成功 N / 失败 M（首个原因）」，不再只报成功数。 */
function showBatchResult(results: readonly PromiseSettledResult<unknown>[], successKey: string) {
  const summary = summarizeBatchResults(results);
  runtimeStore.showSnackbar(formatBatchOpMessage(t, successKey, summary), { color: batchOpColor(summary) });
  return summary;
}

async function pauseTorrents(torrents: CTorrent[]) {
  if (torrents.length === 0 || pendingCommand.value) return;
  pendingCommand.value = "pause";
  try {
    const results = await Promise.allSettled(
      torrents.map((t) => sendMessage("pauseClientTorrent", { downloaderId: t.clientId, id: t.id })),
    );
    // OPTIONSOVERVIEW-9：与 recheckTorrents/moveTorrentsInQueue 对齐 —— 0 个成功不能仍报绿色成功
    showBatchResult(results, "MyClient.action.pauseSelectedSuccess");
    const affectedIds = [...new Set(torrents.map((t) => t.clientId))];
    await Promise.allSettled(affectedIds.map(loadSingleDownloader));
  } finally {
    pendingCommand.value = null;
  }
}

async function resumeTorrents(torrents: CTorrent[]) {
  if (torrents.length === 0 || pendingCommand.value) return;
  pendingCommand.value = "resume";
  try {
    const results = await Promise.allSettled(
      torrents.map((t) => sendMessage("resumeClientTorrent", { downloaderId: t.clientId, id: t.id })),
    );
    // OPTIONSOVERVIEW-9：同 pauseTorrents，全部失败时用 error 色提示
    showBatchResult(results, "MyClient.action.resumeSelectedSuccess");
    const affectedIds = [...new Set(torrents.map((t) => t.clientId))];
    await Promise.allSettled(affectedIds.map(loadSingleDownloader));
  } finally {
    pendingCommand.value = null;
  }
}

function openDeleteDialog(torrentList: CTorrent[]) {
  if (torrentList.length === 0 || pendingCommand.value) return;
  toDeleteTorrents.value = torrentList;
  // 每次打开都清空上一轮的失败原因，避免把旧的提示带到新的删除操作上
  deleteFailureHints.value = {};
  showDeleteDialog.value = true;
}

function openDetailDialog(item: CTorrent) {
  detailTorrent.value = item;
  showDetailDialog.value = true;
}

function openRecheckDialog(torrentList: CTorrent[]) {
  if (torrentList.length === 0 || pendingCommand.value) return;
  toRecheckTorrents.value = torrentList;
  showRecheckDialog.value = true;
}

/**
 * 批量限速 / 批量标签入口（N7）。
 *
 * 只在「所选种子全部支持该能力」时打开：能力不足时实体按契约返回 false，用户只会看到
 * 「已设置 0 个」，无法判断是「不支持」还是「临时失败」。按钮的 disabled 条件用同一个判定。
 */
function openSpeedLimitDialog() {
  if (selectedTorrents.value.length === 0 || !isFeatureAllowedForAll(selectedTorrents.value, "SpeedLimit")) return;
  toSpeedLimitTorrents.value = [...selectedTorrents.value];
  showSpeedLimitDialog.value = true;
}

function openLabelDialog() {
  if (selectedTorrents.value.length === 0 || !isFeatureAllowedForAll(selectedTorrents.value, "Label")) return;
  toLabelTorrents.value = [...selectedTorrents.value];
  showLabelDialog.value = true;
}

/**
 * Aria2 的 `aria2.remove` 不支持同时删除数据（`Aria2.removeTorrent` 在 `removeData=true` 时按契约
 * 返回 false），因此勾选「同时删除数据」后必然整批失败且没有可读原因（N17）。
 * 这里在删除弹窗里禁用该选项，避免用户走进必然失败的路径。
 *
 * A（REVIEW-FINDINGS P1-7）：实体 type 是 `"Aria2"`（entity/Aria2.ts），旧集合写的是小写
 * `"aria2"` → 恒不命中、守卫失效。这里统一按 `toLowerCase()` 归一比较。
 */
const CLIENT_TYPES_WITHOUT_REMOVE_DATA = new Set(["aria2"]);

const removeDataSupported = computed(() =>
  toDeleteTorrents.value.every((item) => {
    const type = metadataStore.downloaders[item.clientId]?.type;
    return !type || !CLIENT_TYPES_WITHOUT_REMOVE_DATA.has(type.toLowerCase());
  }),
);

async function recheckTorrents() {
  const torrentList = toRecheckTorrents.value;
  if (torrentList.length === 0) return;
  const results = await Promise.allSettled(
    torrentList.map((t) => sendMessage("recheckClientTorrent", { downloaderId: t.clientId, id: t.id })),
  );
  showBatchResult(results, "MyClient.action.recheckSelectedSuccess");
  const affectedIds = [...new Set(torrentList.map((t) => t.clientId))];
  await Promise.allSettled(affectedIds.map(loadSingleDownloader));
}

async function moveTorrentsInQueue(torrentList: CTorrent[], direction: TorrentQueueDirection) {
  if (torrentList.length === 0 || pendingCommand.value) return;
  pendingCommand.value = "queue";
  try {
    const results = await Promise.allSettled(
      torrentList.map((t) =>
        sendMessage("moveClientTorrentInQueue", { downloaderId: t.clientId, id: t.id, direction }),
      ),
    );
    showBatchResult(results, "MyClient.action.moveQueueSuccess");
    const affectedIds = [...new Set(torrentList.map((t) => t.clientId))];
    await Promise.allSettled(affectedIds.map(loadSingleDownloader));
  } finally {
    pendingCommand.value = null;
  }
}

/** 批量限速 / 批量标签弹窗成功后刷新受影响下载器（D2-09：标签列不再等下一轮自动刷新）。 */
async function onBatchDialogDone(clientIds: string[]) {
  await Promise.allSettled(clientIds.map((id) => loadSingleDownloader(id)));
}

// DOWNLOADER-3：下载器实体用 `return false` 表达「这个客户端没法这样删」，但 `throw` 里原本那句
// 唯一的解释（Synology 必须勾选删除数据）也随之丢了，BaseDeleteDialog 只能提示一串删不掉的 id。
// 下载器类型只有这里知道，所以在这里按类型（+ 当前复选框状态）映射一句可操作提示，交给
// DeleteDialog 附在失败提示里；无法归因的客户端不编造原因，保持原样。
function deleteFailureHintFor(torrent: CTorrent, removeData: boolean): string | undefined {
  const downloader = metadataStore.downloaders[torrent.clientId];
  if (!downloader) return undefined;
  if (downloader.type === "synologyDownloadStation" && !removeData) {
    // Synology 的 SYNO.DownloadStation2.Task delete 必须带 removeData，否则实体直接回 false。
    // 文案复用对话框里那个复选框的 key，保证提示里的名字与用户要勾的选项完全一致。
    return `${downloader.name || downloader.type}：${t("MyClient.dialog.removeData")}`;
  }
  return undefined;
}

// Called per-item by DeleteDialog
// DOWNLOADER-3：删除器实体用返回值表达「删不掉」（false），必须把结果交给 DeleteDialog，
// 否则 Synology 默认路径（未勾选删除数据）这类失败会被当成成功、弹窗照常关闭。
async function confirmDeleteTorrent(torrentKey_: string, removeData: boolean): Promise<boolean | void> {
  const torrent = toDeleteTorrents.value.find((t) => torrentKey(t) === torrentKey_);
  if (!torrent) return;
  const result = await sendMessage("deleteClientTorrent", {
    downloaderId: torrent.clientId,
    id: torrent.id,
    removeData,
  });

  if (result === false) {
    const hint = deleteFailureHintFor(torrent, removeData);
    if (hint) deleteFailureHints.value[torrentKey_] = hint;
  }

  return result;
}

function clientName(clientId: string) {
  return metadataStore.downloaders[clientId]?.name ?? clientId;
}

function clientIcon(clientId: string) {
  const type = metadataStore.downloaders[clientId]?.type;
  return type ? getDownloaderIcon(type) : undefined;
}

/**
 * N6：「{name} 刷新失败 3 次，已暂停自动刷新。点击下载器标签可恢复」——
 * 标签原先只绑了 @close，点它没有任何反应。只有被暂停时才恢复（平时点击不改动定时器）。
 */
function onDownloaderTagClick(clientId: string) {
  if (suspendedDownloaders.value.has(clientId)) {
    resumeDownloaderRefresh(clientId);
  }
}

/** 清除下载器预选筛选（恢复显示全部下载器） */
function clearDownloaderFilter() {
  selectedDownloaderIds.value = [];
  void loadTorrents();
}

/**
 * 工具条次操作（重新校验 / 批量限速 / 批量标签 / 刷新）。
 *
 * 为什么收进 ToolbarActions：这 4 个操作在窄屏会把工具条折成两三行，且与「推送 / 开始暂停 / 删除」
 * 混在一起看不出主次。ToolbarActions 在 >=840px 平铺、以下收进「更多」下拉，状态与主区同源。
 * 自动刷新是带输入框的 Popover、客户端状态是统计药丸，无法表达成菜单项，仍留在主区（窄屏只留图标）。
 */
const toolbarSecondaryItems = computed<ToolbarAction[]>(() => {
  const noSelection = selectedTorrents.value.length === 0;
  const recheckUnsupported = !noSelection && !isFeatureAllowedForAll(selectedTorrents.value, "Recheck");
  const speedLimitUnsupported = !noSelection && !isFeatureAllowedForAll(selectedTorrents.value, "SpeedLimit");
  const labelUnsupported = !noSelection && !isFeatureAllowedForAll(selectedTorrents.value, "Label");

  return [
    {
      key: "recheck",
      label: t("MyClient.recheckSelected"),
      icon: ReloadOutlined,
      disabled: !!pendingCommand.value || noSelection || recheckUnsupported,
      title: recheckUnsupported ? t("MyClient.batch.unsupported") : t("MyClient.recheckSelected"),
    },
    {
      key: "speedLimit",
      label: t("MyClient.speedLimit.batchBtn"),
      icon: DashboardOutlined,
      disabled: !!pendingCommand.value || noSelection || speedLimitUnsupported,
      title: speedLimitUnsupported ? t("MyClient.batch.unsupported") : t("MyClient.speedLimit.batchBtn"),
    },
    {
      key: "label",
      label: t("MyClient.label.batchBtn"),
      icon: TagOutlined,
      disabled: !!pendingCommand.value || noSelection || labelUnsupported,
      title: labelUnsupported ? t("MyClient.batch.unsupported") : t("MyClient.label.batchBtn"),
    },
    {
      key: "refresh",
      label: t("MyClient.refresh"),
      icon: SyncOutlined,
    },
  ];
});

function onToolbarSecondaryAction(key: string) {
  switch (key) {
    case "recheck":
      openRecheckDialog(selectedTorrents.value);
      break;
    case "speedLimit":
      openSpeedLimitDialog();
      break;
    case "label":
      openLabelDialog();
      break;
    case "refresh":
      void loadTorrents();
      break;
  }
}
</script>

<template>
  <a-card>
    <div class="my-client-toolbar" :class="{ 'my-client-toolbar--selected': selectedTorrents.length > 0 }">
      <div class="my-client-toolbar__actions">
        <!-- 主操作常显；次操作（重新校验 / 批量限速 / 批量标签 / 刷新）见 toolbarSecondaryItems -->
        <ToolbarActions :items="toolbarSecondaryItems" @select="onToolbarSecondaryAction">
          <template #primary>
            <a-button
              :title="t('MyClient.pushToDownloader.navBtn')"
              :aria-label="t('MyClient.pushToDownloader.navBtn')"
              @click="showPushToDownloaderDialog = true"
              type="primary"
              ><template #icon><CloudUploadOutlined /></template
              ><span class="my-client-toolbar__label">{{ t("MyClient.pushToDownloader.navBtn") }}</span></a-button
            >

            <template v-if="selectedTorrents.length > 0">
              <a-button
                :disabled="!!pendingCommand"
                :loading="pendingCommand === 'resume'"
                :title="t('MyClient.resumeSelected')"
                :aria-label="t('MyClient.resumeSelected')"
                @click="() => resumeTorrents(selectedTorrents)"
                type="link"
                ><template #icon><PlayCircleOutlined /></template
                ><span class="my-client-toolbar__label">{{ t("MyClient.resumeSelected") }}</span></a-button
              >

              <a-button
                :disabled="!!pendingCommand"
                :loading="pendingCommand === 'pause'"
                :title="t('MyClient.pauseSelected')"
                :aria-label="t('MyClient.pauseSelected')"
                @click="() => pauseTorrents(selectedTorrents)"
                type="text"
                ><template #icon><PauseOutlined /></template
                ><span class="my-client-toolbar__label">{{ t("MyClient.pauseSelected") }}</span></a-button
              >

              <a-button
                :disabled="!!pendingCommand"
                :title="t('MyClient.deleteSelected')"
                :aria-label="t('MyClient.deleteSelected')"
                @click="() => openDeleteDialog(selectedTorrents)"
                type="text"
                danger
                ><template #icon><DeleteOutlined /></template
                ><span class="my-client-toolbar__label">{{ t("MyClient.deleteSelected") }}</span></a-button
              >
            </template>
          </template>
        </ToolbarActions>

        <span v-if="selectedTorrents.length > 0" class="my-client-selection-count">
          {{ t("MyClient.selectedCount", [selectedTorrents.length]) }}
        </span>

        <!-- auto-refresh controls -->
        <a-popover placement="bottom" trigger="click">
          <a-button
            :title="t('MyClient.autoRefresh.btnTitle')"
            :aria-label="t('MyClient.autoRefresh.btnTitle')"
            class="my-client-toolbar__auto-refresh"
            type="text"
          >
            <template #icon>
              <component :is="autoRefreshRunning ? FieldTimeOutlined : ClockCircleOutlined" />
            </template>
            <span class="my-client-toolbar__label">{{ t("MyClient.autoRefresh.btnTitle") }}</span>
          </a-button>
          <template #content>
            <a-card class="my-client-auto-refresh__card">
              <a-typography-text type="secondary" class="my-client-auto-refresh__hint">
                {{ t("MyClient.autoRefresh.intervalLabel") }}
              </a-typography-text>
              <a-form-item :label="t('MyClient.autoRefresh.intervalUnit')">
                <a-input-number
                  v-model:value="globalRefreshInterval"
                  :min="0"
                  :max="3600"
                  class="my-client-auto-refresh__interval"
                />
              </a-form-item>
              <div class="my-client-auto-refresh__start">
                <a-button
                  :danger="autoRefreshRunning"
                  :type="autoRefreshRunning ? 'default' : 'primary'"
                  :disabled="!autoRefreshRunning && globalRefreshInterval <= 0"
                  block
                  @click="toggleAutoRefresh"
                >
                  <component :is="autoRefreshRunning ? StopOutlined : PlayCircleOutlined" />
                  {{ autoRefreshRunning ? t("MyClient.autoRefresh.stop") : t("MyClient.autoRefresh.start") }}
                </a-button>
              </div>
            </a-card>
          </template>
        </a-popover>

        <!-- 客户端状态汇总（原「页面标题 alert」的 append 区，标题 alert 已移除，按钮移到工具条内保留入口） -->
        <a-button
          :title="t('MyClient.clientStatusDialog.openBtn')"
          class="status-btn"
          @click="showClientStatusDialog = true"
          size="small"
        >
          <span class="status-btn__item"> {{ allTorrents.length }}<DatabaseOutlined class="ptd-icon-sm" /> </span>
          <span class="status-btn__item">
            {{ formatSize(totalUpSpeed) }}/s<UpOutlined class="ptd-icon-sm my-client-status__up" />
          </span>
          <span class="status-btn__item">
            {{ formatSize(totalDlSpeed) }}/s<DownOutlined class="ptd-icon-sm my-client-status__down" />
          </span>
        </a-button>
      </div>

      <div class="my-client-toolbar__filters">
        <!-- N6：自动刷新因连续失败被暂停时，文案提示「点击下载器标签可恢复」；标签原先只绑了 @close，
             点它没有任何反应。这里让标签本身也能恢复该下载器的自动刷新（未暂停时点击无副作用）。 -->
        <a-tag
          v-if="selectedDownloaderIds.length === 1"
          closable
          color="#1677ff"
          :title="
            suspendedDownloaders.has(selectedDownloaderIds[0]) ? t('MyClient.autoRefresh.resumeDownloader') : undefined
          "
          @click="() => onDownloaderTagClick(selectedDownloaderIds[0])"
          @close="clearDownloaderFilter"
          ><a-avatar
            :src="clientIcon(selectedDownloaderIds[0])"
            :size="20"
            class="my-client-toolbar__downloader-avatar"
          />
          {{ clientName(selectedDownloaderIds[0]) }}
        </a-tag>

        <a-input v-model:value="searchText" allow-clear :placeholder="t('MyClient.searchPlaceholder')"></a-input>
      </div>
    </div>

    <a-table
      :sticky="mainTableSticky"
      :columns="tableColumns"
      :data-source="filteredTorrents"
      :loading="loading"
      :pagination="tablePagination"
      :row-key="torrentKey"
      :row-selection="{
        selectedRowKeys: tableSelected.map(torrentKey),
        onChange: onSelectionChange,
        // D2-07：保留数据源之外的选中行，避免「筛选后再勾选」把隐藏行静默丢弃
        // （真正参与批量操作的是 selectedTorrents = 选中集合 ∩ 可见集合）
        preserveSelectedRowKeys: true,
        // 操作列固定在行首时选择列也必须固定，保持固定列连续
        fixed: rowSelectionFixed,
      }"
      :scroll="{ x: 'max-content' }"
      class="table-stripe table-header-no-wrap"
      @change="onTableChange"
    >
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'clientId'">
          <div class="my-client-cell">
            <a-avatar :src="clientIcon(record.clientId)" :size="22"></a-avatar>
            <span class="my-client-cell__client-name">{{ clientName(record.clientId) }}</span>
          </div>
        </template>

        <!-- name column -->
        <template v-else-if="column.key === 'name'">
          <div>
            <span class="ptd-cell-ellipsis my-client-name" :title="String(record.name ?? '')">{{ record.name }}</span>
            <div v-if="record.label" class="ptd-cell-ellipsis my-client-label" :title="String(record.label)">
              <TagOutlined class="ptd-icon-sm" /> {{ record.label }}
            </div>
          </div>
        </template>

        <!-- site column: 根据种子内的 tracker 地址识别所属站点，未匹配时按 public / unmatched 区分显示 -->
        <template v-else-if="column.key === 'site'">
          <TorrentSiteTd :item="record" />
        </template>

        <!-- size column -->
        <template v-else-if="column.key === 'totalSize'">
          <span class="my-client-nowrap">{{ formatSize(record.totalSize) }}</span>
        </template>

        <!-- progress column -->
        <template v-else-if="column.key === 'progress'">
          <a-progress
            :format="() => formatTorrentProgressLabel(record.progress)"
            :percent="normalizeTorrentProgress(record.progress)"
            class="my-client-progress"
            :stroke-width="8"
            size="small"
            type="line"
          />
        </template>

        <!-- state column -->
        <template v-else-if="column.key === 'state'">
          <TorrentStateTd :item="record" />
        </template>

        <!-- upload speed -->
        <template v-else-if="column.key === 'uploadSpeed'">
          <span v-if="record.uploadSpeed > 0" class="my-client-nowrap my-client-speed-up">
            {{ formatSize(record.uploadSpeed) }}/s
          </span>
          <span v-else class="my-client-muted">-</span>
        </template>

        <!-- download speed -->
        <template v-else-if="column.key === 'downloadSpeed'">
          <span v-if="record.downloadSpeed > 0" class="my-client-nowrap my-client-speed-down">
            {{ formatSize(record.downloadSpeed) }}/s
          </span>
          <span v-else class="my-client-muted">-</span>
        </template>

        <!-- total uploaded -->
        <template v-else-if="column.key === 'totalUploaded'">
          <span class="my-client-nowrap my-client-speed-up">{{ formatSize(record.totalUploaded) }}</span>
        </template>

        <!-- total downloaded -->
        <template v-else-if="column.key === 'totalDownloaded'">
          <span class="my-client-nowrap my-client-speed-down">{{ formatSize(record.totalDownloaded) }}</span>
        </template>

        <!-- ratio column -->
        <template v-else-if="column.key === 'ratio'">
          <!-- ITorrent 未声明 ratio，缺失时直接 .toFixed(2) 会抛 TypeError 并让整个表格渲染崩掉；
               用共享的 formatRatio 兜底为 "-"，颜色也只在有限数时才着色。 -->
          <span
            :style="{
              color: isRatioHealthy(record.ratio) ? 'var(--ptd-success)' : 'var(--ptd-danger)',
            }"
          >
            {{ formatRatio(record.ratio) }}
          </span>
        </template>

        <!-- save path -->
        <template v-else-if="column.key === 'savePath'">
          <span class="ptd-cell-ellipsis my-client-path" :title="String(record.savePath ?? '')">{{
            record.savePath
          }}</span>
        </template>

        <!-- date added -->
        <template v-else-if="column.key === 'dateAdded'">
          <span class="ptd-date-time my-client-date">{{ formatDateTimeForTable(record.dateAdded * 1000) }}</span>
        </template>

        <!-- actions -->
        <template v-else-if="column.key === 'action'">
          <a-button-group class="table-action">
            <a-button
              v-if="record.state === CTorrentState.downloading || record.state === CTorrentState.seeding"
              :disabled="!!pendingCommand"
              :title="t('MyClient.action.pause')"
              @click="() => pauseTorrents([record])"
              size="small"
              ><template #icon><PauseOutlined /></template
            ></a-button>
            <a-button
              v-else-if="record.state === CTorrentState.paused || record.state === CTorrentState.error"
              :disabled="!!pendingCommand"
              :title="t('MyClient.action.resume')"
              @click="() => resumeTorrents([record])"
              type="primary"
              size="small"
              ><template #icon><PlayCircleOutlined /></template
            ></a-button>

            <!-- 重新校验 -->
            <a-button
              v-if="isFeatureAllowed(record.clientId, 'Recheck')"
              :disabled="!!pendingCommand"
              :title="t('MyClient.action.recheck')"
              @click="() => openRecheckDialog([record])"
              size="small"
              ><template #icon><ReloadOutlined /></template
            ></a-button>

            <!-- 队列调整 -->
            <a-dropdown placement="bottom" :trigger="['click']" :disabled="!!pendingCommand">
              <a-button
                v-if="isFeatureAllowed(record.clientId, 'Queue')"
                :disabled="!!pendingCommand"
                :title="t('MyClient.action.queue')"
                size="small"
                ><template #icon><SwapOutlined /></template
              ></a-button>
              <template #overlay>
                <a-menu
                  @click="({ key }: any) => moveTorrentsInQueue([record], key as 'top' | 'up' | 'down' | 'bottom')"
                >
                  <a-menu-item key="top"
                    ><DoubleLeftOutlined class="my-client-menu-icon" />{{ t("MyClient.action.queueTop") }}</a-menu-item
                  >
                  <a-menu-item key="up"
                    ><UpOutlined class="my-client-menu-icon" />{{ t("MyClient.action.queueUp") }}</a-menu-item
                  >
                  <a-menu-item key="down"
                    ><DownOutlined class="my-client-menu-icon" />{{ t("MyClient.action.queueDown") }}</a-menu-item
                  >
                  <a-menu-item key="bottom"
                    ><DoubleRightOutlined class="my-client-menu-icon" />{{
                      t("MyClient.action.queueBottom")
                    }}</a-menu-item
                  >
                </a-menu>
              </template>
            </a-dropdown>

            <!-- 详情 -->
            <a-button :title="t('MyClient.action.detail')" @click="() => openDetailDialog(record)" size="small"
              ><template #icon><FileSearchOutlined /></template
            ></a-button>

            <a-button
              :disabled="!!pendingCommand"
              :title="t('MyClient.action.delete')"
              @click="() => openDeleteDialog([record])"
              danger
              size="small"
              ><template #icon><DeleteOutlined /></template
            ></a-button>
          </a-button-group>
        </template>
      </template>

      <template #emptyText>
        <NoDataPlaceholder compact>
          <!-- 全量为空时才引导去下载设置；只是搜索词没命中时不应把用户带去别处 -->
          <a-button
            v-if="allTorrents.length === 0 && !loading"
            type="primary"
            @click="router.push({ name: 'SetDownloader' })"
          >
            <template #icon><SettingOutlined /></template>
            {{ t("route.Settings.SetDownloader") }}
          </a-button>
        </NoDataPlaceholder>
      </template>
      <template #title>
        <div class="my-client-table-title">
          <ColumnSelector
            :headers="fullTableHeader"
            :visible-keys="(configStore.tableBehavior['MyClient'] as any)?.columns"
            :title="t('common.columnSelector')"
            @update:visible-keys="(keys: string[]) => configStore.updateTableBehavior('MyClient', 'columns', keys)"
          />
        </div>
      </template>
    </a-table>
  </a-card>

  <!-- DOWNLOADER-3：failure-hints 是给 BaseDeleteDialog（components/DeleteDialog.vue）的失败原因通道。
       MyClient/DeleteDialog.vue 这个包装组件没有声明它，靠 Vue 的属性透传（inheritAttrs 默认 true）
       落到基础弹窗上；删掉这行会让「Synology 要勾选同时删除数据」的原因重新丢失。 -->
  <DeleteDialog
    v-model="showDeleteDialog"
    :to-delete-ids="toDeleteTorrents.map((t) => torrentKey(t))"
    :torrents="toDeleteTorrents"
    :remove-data-supported="removeDataSupported"
    :confirm-delete="confirmDeleteTorrent"
    :failure-hints="deleteFailureHints"
    @all-delete="loadTorrents"
  />

  <PushToDownloaderDialog v-model="showPushToDownloaderDialog" />

  <ClientStatusDialog v-model="showClientStatusDialog" />

  <TorrentDetailDialog v-model="showDetailDialog" :torrent="detailTorrent" />

  <SpeedLimitDialog v-model="showSpeedLimitDialog" :torrents="toSpeedLimitTorrents" @done="onBatchDialogDone" />

  <LabelDialog v-model="showLabelDialog" :torrents="toLabelTorrents" @done="onBatchDialogDone" />

  <RecheckConfirmDialog
    v-model="showRecheckDialog"
    :torrents="toRecheckTorrents"
    :torrent-count="toRecheckTorrents.length"
    :confirm-fn="recheckTorrents"
  />
</template>

<style scoped>
.my-client-toolbar {
  display: flex;
  flex: 1 1 auto;
  /* 桌面端按钮组与搜索框保持同一行（窄屏见下方 @media 回退） */
  flex-wrap: nowrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 16px;
  min-width: 0;
  padding: 8px;
  border: 1px solid var(--ptd-border, rgba(5, 5, 5, 0.08));
  border-radius: var(--ptd-radius-lg, 8px);
  background: var(--ptd-surface, #fff);
  transition:
    border-color 0.15s ease,
    background-color 0.15s ease;
}

.my-client-toolbar--selected {
  border-color: var(--ptd-primary-border, rgba(22, 119, 255, 0.45));
  background: var(--ptd-primary-soft, rgba(22, 119, 255, 0.1));
}

.my-client-toolbar__actions,
.my-client-toolbar__filters {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  min-width: 0;
}

.my-client-toolbar__actions {
  flex: 0 1 auto;
}

.my-client-toolbar__filters {
  flex: 1 1 320px;
  justify-content: flex-end;
}

.my-client-toolbar__filters :deep(.ptd-field) {
  flex: 1 1 260px;
  min-width: min(100%, 240px);
  max-width: 400px;
}

/*
 * 窄屏（<840px，与 useDisplay 的 md 断点一致）隐藏文字标签，只留图标：
 * ToolbarActions 已经把次操作收进「更多」，主区里的常显按钮与自定义 Popover 仍会挤压行宽。
 * 图标按钮的 title 仍保留完整文案，纯键盘/读屏也通过 aria-label 获取（ToolbarActions/NavButton 已带）。
 */
.my-client-toolbar__label {
  white-space: nowrap;
}

.my-client-toolbar__auto-refresh {
  margin-left: 4px;
}

.my-client-selection-count {
  display: inline-flex;
  align-items: center;
  min-height: 24px;
  padding: 0 8px;
  border-radius: 999px;
  background: var(--ptd-surface, #fff);
  color: var(--ptd-primary, #1677ff);
  font-size: var(--ptd-font-size-sm);
  font-weight: 500;
  white-space: nowrap;
}

.my-client-toolbar__downloader-avatar {
  margin-right: 4px;
}

.my-client-auto-refresh__card {
  min-width: 240px;
  padding: 8px;
}

.my-client-auto-refresh__hint {
  padding: 4px;
}

.my-client-auto-refresh__interval {
  margin: 4px;
}

.my-client-auto-refresh__start {
  padding: 8px 4px 4px;
}

.my-client-status__up {
  color: var(--ptd-success);
}

.my-client-status__down {
  color: var(--ptd-danger);
}

/* 表格单元格：原先散落在模板里的静态行内样式，收敛为语义类（动态 max-width 仍走 :style） */
.my-client-cell {
  display: flex;
  flex-direction: column;
  align-items: center;
}

.my-client-cell__client-name {
  margin-top: 4px;
  font-size: var(--ptd-font-size-sm);
  white-space: nowrap;
}

.my-client-name {
  max-width: 20rem;
  font-weight: 500;
}

.my-client-label {
  max-width: 20rem;
  font-size: var(--ptd-font-size-sm);
  color: var(--ptd-text-tertiary);
}

.my-client-nowrap {
  white-space: nowrap;
}

.my-client-muted {
  color: var(--ptd-text-tertiary);
}

.my-client-speed-up {
  color: var(--ptd-success);
}

.my-client-speed-down {
  color: var(--ptd-primary);
}

.my-client-path {
  max-width: 16rem;
  font-size: var(--ptd-font-size-sm);
}

.my-client-date {
  font-size: var(--ptd-font-size-sm);
}

.my-client-table-title {
  display: flex;
  justify-content: flex-end;
}

.my-client-menu-icon {
  margin-right: 4px;
}

@media (max-width: 839px) {
  /* 窄屏只留图标：文字被裁掉后按钮的可访问名改由 aria-label 提供（见模板），
     否则读屏软件只能靠 title 猜测。 */
  .my-client-toolbar__label {
    display: none;
  }
}

.my-client-progress {
  min-width: 108px;
  margin: 0;
}

.my-client-progress :deep(.ant-progress-outer) {
  margin-inline-end: 0;
  padding-inline-end: 0;
}

.my-client-progress :deep(.ant-progress-text) {
  min-width: 34px;
  margin-inline-start: 6px;
  font-size: 12px;
}

@media (max-width: 1279px) {
  .my-client-toolbar {
    flex-wrap: wrap;
  }
}
</style>
