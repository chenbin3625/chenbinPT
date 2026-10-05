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
  StopOutlined,
  SwapOutlined,
  SyncOutlined,
  TagOutlined,
  UpOutlined,
} from "@ant-design/icons-vue";
import { computed, onMounted, onUnmounted, ref } from "vue";
import ColumnSelector from "../components/ColumnSelector.vue";
import { toAntdColumns, toPagination, toSortBy } from "../utils/antdTable.ts";
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

import DeleteDialog from "./DeleteDialog.vue";
import PushToDownloaderDialog from "./PushToDownloaderDialog.vue";
import TorrentStateTd from "./TorrentStateTd.vue";
import ClientStatusDialog from "./ClientStatusDialog.vue";
import TorrentDetailDialog from "./TorrentDetailDialog.vue";
import SpeedLimitDialog from "./SpeedLimitDialog.vue";
import LabelDialog from "./LabelDialog.vue";
import RecheckConfirmDialog from "./RecheckConfirmDialog.vue";

import {
  torrents,
  selectedDownloaderIds,
  autoRefreshRunning,
  globalRefreshInterval,
  normalizeTorrentProgress,
  formatTorrentProgressLabel,
  torrentKey,
  useClientRefresh,
} from "./utils.ts";

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
  stopAllTimers,
  resetRefreshState,
  startAutoRefresh,
  toggleAutoRefresh,
} = useClientRefresh();

// ── state ──────────────────────────────────────────────────────────────────
const loading = ref(false);

const tableSelected = ref<CTorrent[]>([]);
const searchText = ref("");
// P1-20：搜索框输入做防抖，避免每敲一个字符都对数千种子做一次全量过滤
const searchTextDebounced = refDebounced(searchText, 300);

// delete dialog
const showDeleteDialog = ref(false);
const toDeleteTorrents = ref<CTorrent[]>([]);

// push to downloader dialog
const showPushToDownloaderDialog = ref(false);

// detail dialog
const showDetailDialog = ref(false);
const detailTorrent = ref<CTorrent | null>(null);

// speed limit dialog
const showSpeedLimitDialog = ref(false);

// label dialog
const showLabelDialog = ref(false);

// recheck confirm dialog
const showRecheckDialog = ref(false);
const toRecheckTorrents = ref<CTorrent[]>([]);

// client status dialog
const showClientStatusDialog = ref(false);

const totalUpSpeed = computed(() => allTorrents.value.reduce((acc, t) => acc + (t.uploadSpeed ?? 0), 0));
const totalDlSpeed = computed(() => allTorrents.value.reduce((acc, t) => acc + (t.downloadSpeed ?? 0), 0));

// ── computed ───────────────────────────────────────────────────────────────
const allTorrents = computed(() => Object.values(torrents.value).flat());

const tableColumns = computed(() =>
  toAntdColumns(fullTableHeader.value, {
    sortBy: configStore.tableBehavior["MyClient"]?.sortBy,
    multiSort: configStore.enableTableMultiSort,
    visibleKeys: (configStore.tableBehavior["MyClient"] as any)?.columns,
  }),
);
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

onMounted(() => {
  // 支持从 SetDownloader 等页面通过 ?downloader=<id> 预选单个下载服务器
  const queryDownloaderId = route.query.downloader as string | undefined;
  let hasQueryDownloader = false;
  if (queryDownloaderId && metadataStore.downloaders[queryDownloaderId]) {
    hasQueryDownloader = true;
    selectedDownloaderIds.value = [queryDownloaderId];
    // 预选是一次性导航行为，清除 URL query 避免刷新页面后重复预选
    void router.replace({ path: "/my-client" });
  }

  startAutoRefresh();

  if (hasQueryDownloader || configStore.download.initDownloaderTorrentOnEnter || autoRefreshRunning.value) {
    void loadTorrents();
  }
});

onUnmounted(() => {
  stopAllTimers();
});

// ── actions ───────────────────────────────────────────────────────────────
async function pauseTorrents(torrents: CTorrent[]) {
  if (torrents.length === 0) return;
  const results = await Promise.allSettled(
    torrents.map((t) => sendMessage("pauseClientTorrent", { downloaderId: t.clientId, id: t.id })),
  );
  const succeeded = results.filter((r) => r.status === "fulfilled" && Boolean(r.value)).length;
  runtimeStore.showSnakebar(t("MyClient.action.pauseSelectedSuccess", { count: succeeded }), { color: "success" });
  const affectedIds = [...new Set(torrents.map((t) => t.clientId))];
  await Promise.allSettled(affectedIds.map(loadSingleDownloader));
}

async function resumeTorrents(torrents: CTorrent[]) {
  if (torrents.length === 0) return;
  const results = await Promise.allSettled(
    torrents.map((t) => sendMessage("resumeClientTorrent", { downloaderId: t.clientId, id: t.id })),
  );
  const succeeded = results.filter((r) => r.status === "fulfilled" && Boolean(r.value)).length;
  runtimeStore.showSnakebar(t("MyClient.action.resumeSelectedSuccess", { count: succeeded }), { color: "success" });
  const affectedIds = [...new Set(torrents.map((t) => t.clientId))];
  await Promise.allSettled(affectedIds.map(loadSingleDownloader));
}

function openDeleteDialog(torrentList: CTorrent[]) {
  toDeleteTorrents.value = torrentList;
  showDeleteDialog.value = true;
}

function openDetailDialog(item: CTorrent) {
  detailTorrent.value = item;
  showDetailDialog.value = true;
}

function openRecheckDialog(torrentList: CTorrent[]) {
  if (torrentList.length === 0) return;
  toRecheckTorrents.value = torrentList;
  showRecheckDialog.value = true;
}

async function recheckTorrents() {
  const torrentList = toRecheckTorrents.value;
  if (torrentList.length === 0) return;
  const results = await Promise.allSettled(
    torrentList.map((t) => sendMessage("recheckClientTorrent", { downloaderId: t.clientId, id: t.id })),
  );
  const succeeded = results.filter((r) => r.status === "fulfilled" && Boolean(r.value)).length;
  runtimeStore.showSnakebar(t("MyClient.action.recheckSelectedSuccess", { count: succeeded }), {
    color: succeeded > 0 ? "success" : "error",
  });
  const affectedIds = [...new Set(torrentList.map((t) => t.clientId))];
  await Promise.allSettled(affectedIds.map(loadSingleDownloader));
}

async function moveTorrentsInQueue(torrentList: CTorrent[], direction: TorrentQueueDirection) {
  if (torrentList.length === 0) return;
  const results = await Promise.allSettled(
    torrentList.map((t) => sendMessage("moveClientTorrentInQueue", { downloaderId: t.clientId, id: t.id, direction })),
  );
  const succeeded = results.filter((r) => r.status === "fulfilled" && Boolean(r.value)).length;
  runtimeStore.showSnakebar(t("MyClient.action.moveQueueSuccess", { count: succeeded }), {
    color: succeeded > 0 ? "success" : "error",
  });
  const affectedIds = [...new Set(torrentList.map((t) => t.clientId))];
  await Promise.allSettled(affectedIds.map(loadSingleDownloader));
}

// Called per-item by DeleteDialog
async function confirmDeleteTorrent(torrentKey_: string, removeData: boolean): Promise<void> {
  const torrent = toDeleteTorrents.value.find((t) => torrentKey(t) === torrentKey_);
  if (!torrent) return;
  await sendMessage("deleteClientTorrent", {
    downloaderId: torrent.clientId,
    id: torrent.id,
    removeData,
  });
}

function clientName(clientId: string) {
  return metadataStore.downloaders[clientId]?.name ?? clientId;
}

function clientIcon(clientId: string) {
  const type = metadataStore.downloaders[clientId]?.type;
  return type ? getDownloaderIcon(type) : undefined;
}

/** 清除下载器预选筛选（恢复显示全部下载器） */
function clearDownloaderFilter() {
  selectedDownloaderIds.value = [];
  void loadTorrents();
}
</script>

<template>
  <a-card>
    <a-typography-text strong>
      <div class="my-client-toolbar">
        <div class="my-client-toolbar__actions">
          <a-button
            :title="t('MyClient.pushToDownloader.navBtn')"
            @click="showPushToDownloaderDialog = true"
            type="link"
            ><template #icon><CloudUploadOutlined /></template>{{ t("MyClient.pushToDownloader.navBtn") }}</a-button
          >

          <a-divider type="vertical" style="margin-left: 8px; margin-right: 8px"></a-divider>

          <a-button
            :disabled="tableSelected.length === 0"
            :title="t('MyClient.resumeSelected')"
            @click="() => resumeTorrents(tableSelected)"
            type="link"
            ><template #icon><PlayCircleOutlined /></template>{{ t("MyClient.resumeSelected") }}</a-button
          >

          <a-button
            :disabled="tableSelected.length === 0"
            :title="t('MyClient.pauseSelected')"
            @click="() => pauseTorrents(tableSelected)"
            type="text"
            ><template #icon><PauseOutlined /></template>{{ t("MyClient.pauseSelected") }}</a-button
          >

          <a-button
            :disabled="tableSelected.length === 0"
            :title="t('MyClient.deleteSelected')"
            @click="() => openDeleteDialog(tableSelected)"
            type="text"
            danger
            ><template #icon><DeleteOutlined /></template>{{ t("MyClient.deleteSelected") }}</a-button
          >

          <a-button
            :disabled="tableSelected.length === 0"
            :title="t('MyClient.recheckSelected')"
            @click="() => openRecheckDialog(tableSelected)"
            type="text"
            ><template #icon><ReloadOutlined /></template>{{ t("MyClient.recheckSelected") }}</a-button
          >

          <a-button
            :disabled="tableSelected.length === 0"
            :title="t('MyClient.speedLimit.batchBtn')"
            @click="showSpeedLimitDialog = true"
            type="text"
            ><template #icon><DashboardOutlined /></template>{{ t("MyClient.speedLimit.batchBtn") }}</a-button
          >

          <a-button
            :disabled="tableSelected.length === 0"
            :title="t('MyClient.label.batchBtn')"
            @click="showLabelDialog = true"
            type="text"
            ><template #icon><TagOutlined /></template>{{ t("MyClient.label.batchBtn") }}</a-button
          >

          <a-divider type="vertical" style="margin-left: 8px; margin-right: 8px"></a-divider>

          <a-button :title="t('MyClient.refresh')" @click="loadTorrents" type="link"
            ><template #icon><SyncOutlined /></template>{{ t("MyClient.refresh") }}</a-button
          >

          <!-- auto-refresh controls -->
          <a-popover placement="bottom" trigger="click">
            <a-button :title="t('MyClient.autoRefresh.btnTitle')" type="text" style="margin-left: 4px">
              <template #icon>
                <component :is="autoRefreshRunning ? FieldTimeOutlined : ClockCircleOutlined" />
              </template>
              {{ t("MyClient.autoRefresh.btnTitle") }}
            </a-button>
            <template #content>
              <a-card style="min-width: 240px; padding: 8px">
                <a-typography-text type="secondary" style="padding: 4px">
                  {{ t("MyClient.autoRefresh.intervalLabel") }}
                </a-typography-text>
                <a-form-item :label="t('MyClient.autoRefresh.intervalUnit')">
                  <a-input-number v-model:value="globalRefreshInterval" :min="0" :max="3600" style="margin: 4px" />
                </a-form-item>
                <div style="padding: 8px 4px 4px">
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

          <a-divider type="vertical" style="margin-left: 8px; margin-right: 8px"></a-divider>

          <!-- 客户端状态汇总（原「页面标题 alert」的 append 区，标题 alert 已移除，按钮移到工具条内保留入口） -->
          <a-button
            :title="t('MyClient.clientStatusDialog.openBtn')"
            class="status-btn"
            @click="showClientStatusDialog = true"
            type="primary"
            size="small"
          >
            <span class="status-btn__item"> {{ allTorrents.length }}<DatabaseOutlined class="ptd-icon-sm" /> </span>
            <span class="status-btn__item">
              {{ formatSize(totalUpSpeed) }}/s<UpOutlined class="ptd-icon-sm" style="color: var(--ptd-success)" />
            </span>
            <span class="status-btn__item">
              {{ formatSize(totalDlSpeed) }}/s<DownOutlined class="ptd-icon-sm" style="color: var(--ptd-danger)" />
            </span>
          </a-button>
        </div>

        <div class="my-client-toolbar__filters">
          <a-tag v-if="selectedDownloaderIds.length === 1" closable color="#1677ff" @close="clearDownloaderFilter"
            ><a-avatar :src="clientIcon(selectedDownloaderIds[0])" :size="20" style="margin-right: 4px" />
            {{ clientName(selectedDownloaderIds[0]) }}
          </a-tag>

          <a-input v-model:value="searchText" allow-clear :placeholder="t('MyClient.searchPlaceholder')"></a-input>
        </div>
      </div>
    </a-typography-text>

    <a-table
      :columns="tableColumns"
      :data-source="filteredTorrents"
      :loading="loading"
      :pagination="tablePagination"
      :row-key="torrentKey"
      :row-selection="{ selectedRowKeys: tableSelected.map(torrentKey), onChange: onSelectionChange }"
      :scroll="{ x: 'max-content' }"
      class="table-stripe"
      @change="onTableChange"
    >
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'clientId'">
          <div style="display: flex; flex-direction: column; align-items: center">
            <a-avatar :src="clientIcon(record.clientId)" :size="22"></a-avatar>
            <span style="font-size: 12px; white-space: nowrap; margin-top: 4px">{{ clientName(record.clientId) }}</span>
          </div>
        </template>

        <!-- name column -->
        <template v-else-if="column.key === 'name'">
          <div>
            <span
              class="ptd-cell-ellipsis"
              style="font-weight: 500; max-width: 20rem"
              :title="String(record.name ?? '')"
              >{{ record.name }}</span
            >
            <div
              v-if="record.label"
              class="ptd-cell-ellipsis"
              style="font-size: 12px; color: var(--ptd-text-tertiary); max-width: 20rem"
              :title="String(record.label)"
            >
              <TagOutlined class="ptd-icon-sm" /> {{ record.label }}
            </div>
          </div>
        </template>

        <!-- size column -->
        <template v-else-if="column.key === 'totalSize'">
          <span style="white-space: nowrap">{{ formatSize(record.totalSize) }}</span>
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
          <span v-if="record.uploadSpeed > 0" style="white-space: nowrap; color: var(--ptd-success)">
            {{ formatSize(record.uploadSpeed) }}/s
          </span>
          <span v-else style="color: var(--ptd-text-tertiary)">-</span>
        </template>

        <!-- download speed -->
        <template v-else-if="column.key === 'downloadSpeed'">
          <span v-if="record.downloadSpeed > 0" style="white-space: nowrap; color: var(--ptd-primary)">
            {{ formatSize(record.downloadSpeed) }}/s
          </span>
          <span v-else style="color: var(--ptd-text-tertiary)">-</span>
        </template>

        <!-- total uploaded -->
        <template v-else-if="column.key === 'totalUploaded'">
          <span style="white-space: nowrap; color: var(--ptd-success)">{{ formatSize(record.totalUploaded) }}</span>
        </template>

        <!-- total downloaded -->
        <template v-else-if="column.key === 'totalDownloaded'">
          <span style="white-space: nowrap; color: var(--ptd-primary)">{{ formatSize(record.totalDownloaded) }}</span>
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
          <span
            class="ptd-cell-ellipsis"
            style="font-size: 12px; max-width: 16rem"
            :title="String(record.savePath ?? '')"
            >{{ record.savePath }}</span
          >
        </template>

        <!-- date added -->
        <template v-else-if="column.key === 'dateAdded'">
          <span class="ptd-date-time" style="font-size: 12px">{{
            formatDateTimeForTable(record.dateAdded * 1000)
          }}</span>
        </template>

        <!-- actions -->
        <template v-else-if="column.key === 'action'">
          <a-button-group class="table-action">
            <a-button
              v-if="record.state === CTorrentState.downloading || record.state === CTorrentState.seeding"
              :title="t('MyClient.action.pause')"
              @click="() => pauseTorrents([record])"
              size="small"
              ><template #icon><PauseOutlined /></template
            ></a-button>
            <a-button
              v-else-if="record.state === CTorrentState.paused || record.state === CTorrentState.error"
              :title="t('MyClient.action.resume')"
              @click="() => resumeTorrents([record])"
              type="primary"
              size="small"
              ><template #icon><PlayCircleOutlined /></template
            ></a-button>

            <!-- 重新校验 -->
            <a-button
              v-if="isFeatureAllowed(record.clientId, 'Recheck')"
              :title="t('MyClient.action.recheck')"
              @click="() => openRecheckDialog([record])"
              size="small"
              ><template #icon><ReloadOutlined /></template
            ></a-button>

            <!-- 队列调整 -->
            <a-dropdown placement="bottom" :trigger="['click']">
              <a-button
                v-if="isFeatureAllowed(record.clientId, 'Queue')"
                :title="t('MyClient.action.queue')"
                size="small"
                ><template #icon><SwapOutlined /></template
              ></a-button>
              <template #overlay>
                <a-menu
                  @click="({ key }: any) => moveTorrentsInQueue([record], key as 'top' | 'up' | 'down' | 'bottom')"
                >
                  <a-menu-item key="top"
                    ><DoubleLeftOutlined style="margin-right: 4px" />{{ t("MyClient.action.queueTop") }}</a-menu-item
                  >
                  <a-menu-item key="up"
                    ><UpOutlined style="margin-right: 4px" />{{ t("MyClient.action.queueUp") }}</a-menu-item
                  >
                  <a-menu-item key="down"
                    ><DownOutlined style="margin-right: 4px" />{{ t("MyClient.action.queueDown") }}</a-menu-item
                  >
                  <a-menu-item key="bottom"
                    ><DoubleRightOutlined style="margin-right: 4px" />{{
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

            <a-button :title="t('MyClient.action.delete')" @click="() => openDeleteDialog([record])" danger size="small"
              ><template #icon><DeleteOutlined /></template
            ></a-button>
          </a-button-group>
        </template>
      </template>

      <template #emptyText>
        <NoDataPlaceholder compact />
      </template>
      <template #title>
        <div style="display: flex; justify-content: flex-end">
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

  <DeleteDialog
    v-model="showDeleteDialog"
    :to-delete-ids="toDeleteTorrents.map((t) => torrentKey(t))"
    :confirm-delete="confirmDeleteTorrent"
    @all-delete="loadTorrents"
  />

  <PushToDownloaderDialog v-model="showPushToDownloaderDialog" />

  <ClientStatusDialog v-model="showClientStatusDialog" />

  <TorrentDetailDialog v-model="showDetailDialog" :torrent="detailTorrent" />

  <SpeedLimitDialog v-model="showSpeedLimitDialog" :torrents="tableSelected" />

  <LabelDialog v-model="showLabelDialog" :torrents="tableSelected" />

  <RecheckConfirmDialog
    v-model="showRecheckDialog"
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
