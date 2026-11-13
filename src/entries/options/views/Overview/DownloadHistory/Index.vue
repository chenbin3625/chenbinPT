<script setup lang="ts">
import {
  DeleteOutlined,
  DownloadOutlined,
  FilterOutlined,
  MinusOutlined,
  SearchOutlined,
  SyncOutlined,
  WarningOutlined,
} from "@ant-design/icons-vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import { onMounted, onUnmounted, ref, shallowRef, computed } from "vue";
import {
  applyTableActionColumn,
  titleColumnMaxWidth as titleColumnMaxWidthFor,
  toAntdColumns,
  toPagination,
  toSortBy,
  useTableActionColumnLayout,
  useMainTableSticky,
} from "../utils/antdTable.ts";
import { useDisplay } from "@/options/composables/useDisplay.ts";
import type { DataTableHeader } from "@/options/types/dataTable.ts";

import { sendMessage } from "@/messages.ts";
import { formatDateTimeForTable } from "@/options/utils.ts";
import { useConfigStore } from "@/options/stores/config.ts";
import type { ITorrentDownloadMetadata, TTorrentDownloadKey } from "@/shared/types.ts";

import SiteFavicon from "@/options/components/SiteFavicon/Index.vue";
import SiteName from "@/options/components/SiteName.vue";
import TorrentTitleTd from "@/options/components/TorrentTitleTd.vue";
import DeleteDialog from "@/options/components/DeleteDialog.vue";
import DownloaderLabel from "@/options/components/DownloaderLabel.vue";
import NavButton from "@/options/components/NavButton.vue";
import NoDataPlaceholder from "@/options/components/NoDataPlaceholder.vue";
import ToolbarActions, { type ToolbarAction } from "@/options/components/ToolbarActions.vue";
import ReDownloadSelectDialog from "./ReDownloadSelectDialog.vue";
import AdvanceFilterGenerateDialog from "./AdvanceFilterGenerateDialog.vue";

import {
  downloadHistory,
  downloadHistoryList,
  downloadStatusMap,
  tableCustomFilter,
  clearWatchingMap,
  pickVisibleDownloadHistoryIds,
  throttleLoadDownloadHistory,
  isLoadingDownloadHistory,
} from "./utils.ts"; // <-- 主要方法

const { t } = useI18n();

// 页面级表格表头吸顶（滚动容器是 #ptd-main，见 useMainTableSticky 的说明）
const mainTableSticky = useMainTableSticky();
const configStore = useConfigStore();
const display = useDisplay();
const router = useRouter();

const { tableFilterRef, tableWaitFilterRef, tableFilterFn } = tableCustomFilter;

// 标题单元格的宽度上限（`undefined` = 不限宽，让标题列吃满剩余宽度）：
// 规则、理由与实测数据见 utils/antdTable.ts 的 titleColumnMaxWidth。
const titleColumnMaxWidth = computed(() => titleColumnMaxWidthFor(display.smAndDown.value));

// 列宽跟随容器收缩（见 style.css「数据表统一排版」），但下载历史表只有「种子」列声明了
// 最小宽度，站点 / 下载服务器 / 下载时间 / 下载状态会被压得过窄：时间被拆成多行、
// 下载器地址与状态标签被裁切。这里为各列补上兜底的最小宽度（minWidth 会落到单元格的
// min-width 上，只限制下限，不锁定列宽，容器够宽时依旧按内容自动分配）。
const tableHeader = computed(
  () =>
    [
      { title: t("common.site"), key: "siteId", align: "center", minWidth: "6rem" },
      {
        title: t("DownloadHistory.table.title"),
        key: "title",
        align: "start",
        minWidth: "14rem",
        ...(titleColumnMaxWidth.value ? { maxWidth: titleColumnMaxWidth.value } : {}),
      },
      {
        title: t("DownloadHistory.table.downloader"),
        key: "downloaderId",
        width: "11%",
        // 下载器标签是「40px 头像 + 名称 + 地址」，地址允许折行，但至少留出名称可读的宽度
        minWidth: "10rem",
        align: "start",
      },
      {
        title: t("DownloadHistory.table.downloadAt"),
        key: "downloadAt",
        align: "center",
        // "yyyy-MM-dd HH:mm:ss" 单行约需 9rem，留出余量避免时间被拆行
        minWidth: "10rem",
      },
      { title: t("DownloadHistory.table.status"), key: "downloadStatus", minWidth: "6rem" },
      { title: t("common.action"), key: "action", align: "center", sortable: false, width: "90" },
    ] as DataTableHeader[],
);
const tableColumns = computed(() =>
  // 操作列位置 / 固定（#1598）：先按可见列过滤 → toAntdColumns，最后再调整操作列位置
  applyTableActionColumn(
    toAntdColumns(tableHeader.value, {
      sortBy: configStore.tableBehavior.DownloadHistory.sortBy,
      multiSort: configStore.enableTableMultiSort,
    }),
  ),
);
// 操作列固定在行首时，行首的选择列要一起固定；否则横向滚动会被操作列盖住
const { rowSelectionFixed } = useTableActionColumnLayout();
const filteredTableData = computed(() =>
  downloadHistoryList.value.filter((item) => tableFilterFn(undefined, tableFilterRef.value, { raw: item })),
);
const tablePagination = computed(() =>
  toPagination(configStore.tableBehavior.DownloadHistory.itemsPerPage, (v) =>
    configStore.updateTableBehavior("DownloadHistory", "itemsPerPage", v),
  ),
);

/**
 * 工具条次操作：刷新只保留在「更多」里，避免与已选记录的两个批量主操作抢位置。
 * 主要操作（重新下载 / 删除）放在 ToolbarActions 的 #primary 插槽，窄屏也始终可见。
 */
const toolbarItems = computed<ToolbarAction[]>(() => [
  { key: "refresh", label: t("DownloadHistory.refresh"), icon: SyncOutlined },
]);

function onToolbarAction(key: string) {
  if (key === "refresh") void throttleLoadDownloadHistory();
}

/**
 * 当前可见且仍被勾选的记录（N3）。
 *
 * antd 的 `selectedRowKeys` 在数据源被筛选时不会裁剪/通知，批量删除/重下若直接用
 * `tableSelected` 会把被筛选隐藏的记录一起处理（下载历史没有回收站）。
 */
const visibleSelectedIds = computed(() => pickVisibleDownloadHistoryIds(tableSelected.value, filteredTableData.value));

function onSelectionChange(keys: (string | number)[]) {
  tableSelected.value = keys as TTorrentDownloadKey[];
}
function onTableChange(_pagination: unknown, _filters: unknown, sorter: unknown) {
  configStore.updateTableBehavior("DownloadHistory", "sortBy", toSortBy(sorter as never));
}

const tableSelected = ref<TTorrentDownloadKey[]>([]);

const showAdvanceFilterDialog = ref<boolean>(false);

const showReDownloadSelectDialog = ref<boolean>(false);
const reDownloadTorrentListRef = shallowRef<ITorrentDownloadMetadata[]>([]);

function reDownloadTorrent(downloadHistoryIds: TTorrentDownloadKey[]) {
  const reDownloadTorrentList = [];
  for (const downloadHistoryId of downloadHistoryIds) {
    const history: ITorrentDownloadMetadata = downloadHistory.value[downloadHistoryId];
    if (history) {
      reDownloadTorrentList.push(history);
    }
  }
  reDownloadTorrentListRef.value = reDownloadTorrentList;
  showReDownloadSelectDialog.value = true;
}

const showDeleteDialog = ref<boolean>(false);
const toDeleteIds = ref<TTorrentDownloadKey[]>([]);

/** 删除确认框里列出的对象（标题），让用户能核对「删的是哪几条」而不是只看数量（N3） */
const TITLE_PREVIEW_LIMIT = 100;
const toDeleteTitles = computed(() =>
  toDeleteIds.value
    .slice(0, TITLE_PREVIEW_LIMIT)
    .map((id) => downloadHistory.value[id]?.title ?? String(id))
    .filter((title) => !!title),
);
const hasMoreDeleteTitles = computed(() => toDeleteIds.value.length > TITLE_PREVIEW_LIMIT);

async function deleteDownloadHistory(downloadHistoryIds: TTorrentDownloadKey[]) {
  // 防御：即使调用方传入了被隐藏的记录，也只删除当前可见的（按钮已经用 visibleSelectedIds 禁用）
  toDeleteIds.value = pickVisibleDownloadHistoryIds(downloadHistoryIds, filteredTableData.value);
  showDeleteDialog.value = true;
}

async function confirmDeleteDownloadHistory(downloadHistoryId: TTorrentDownloadKey) {
  return await sendMessage("deleteDownloadHistoryById", downloadHistoryId);
}

const showDownloadDetailDialog = ref<boolean>(false);
const downloadDetail = ref<any>({});

function viewDownloadDetail(history: ITorrentDownloadMetadata) {
  downloadDetail.value = history;
  showDownloadDetailDialog.value = true;
}

function downloadStatusMeta(status: ITorrentDownloadMetadata["downloadStatus"]) {
  return downloadStatusMap.value[status];
}

onMounted(() => {
  // N4：loadDownloadHistory 内部已经 catch 并提示；这里 return 的 promise 只是让 lint 知道已被处理
  void throttleLoadDownloadHistory();
});

onUnmounted(() => {
  clearWatchingMap();
  // 卸载时加载可能仍在途：复位 loading，否则重新进入页面时重入保护会把新一轮加载直接挡掉，
  // 页面会停在「加载中」直到旧请求返回（而旧请求已经因 epoch 失效不会写回数据）。
  isLoadingDownloadHistory.value = false;
});
</script>

<template>
  <a-card>
    <a-flex class="page-toolbar" align="center" :gap="8">
      <!-- 重新下载 / 删除是批量主操作：始终平铺；刷新是次操作，窄屏收进「更多」 -->
      <ToolbarActions :items="toolbarItems" @select="onToolbarAction">
        <template #primary>
          <NavButton
            :disabled="visibleSelectedIds.length === 0"
            color="primary"
            :icon="DownloadOutlined"
            :text="t('DownloadHistory.reDownload')"
            @click="() => reDownloadTorrent(visibleSelectedIds)"
          />

          <NavButton
            :disabled="visibleSelectedIds.length === 0"
            :text="t('common.remove')"
            color="error"
            :icon="MinusOutlined"
            @click="deleteDownloadHistory(visibleSelectedIds)"
          />
        </template>
      </ToolbarActions>

      <!-- 筛选框：style.css 的 .page-toolbar > .ant-input-affix-wrapper 会把它固定贴右 -->
      <a-input v-model:value="tableWaitFilterRef" allow-clear :placeholder="t('DownloadHistory.filterPlaceholder')">
        <template #prefix>
          <FilterOutlined class="download-history__filter-icon" @click="showAdvanceFilterDialog = true" />
        </template>
      </a-input>
    </a-flex>
    <a-table
      :sticky="mainTableSticky"
      :columns="tableColumns"
      :data-source="filteredTableData"
      :loading="isLoadingDownloadHistory"
      :pagination="tablePagination"
      :row-key="'id'"
      :row-selection="{
        selectedRowKeys: tableSelected,
        onChange: onSelectionChange,
        // 保留数据源之外的选中行（真正参与批量操作的是 visibleSelectedIds = 选中 ∩ 可见）
        preserveSelectedRowKeys: true,
        // 操作列固定在行首时选择列也必须固定，否则固定列不连续（横向滚动会被操作列盖住）
        fixed: rowSelectionFixed,
      }"
      :scroll="{ x: 'max-content' }"
      class="table-stripe"
      @change="onTableChange"
    >
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'siteId'">
          <div class="download-history__site">
            <SiteFavicon :site-id="record.siteId" :size="18" />
            <SiteName class="ptd-cell-ellipsis download-history__site-name" :site-id="record.siteId" />
          </div>
        </template>

        <template v-else-if="column.key === 'title'">
          <TorrentTitleTd v-if="record.torrent" :item="record.torrent" :max-width="titleColumnMaxWidth" />
        </template>

        <template v-else-if="column.key === 'downloaderId'">
          <DownloaderLabel :downloader="record.downloaderId" />
        </template>

        <template v-else-if="column.key === 'downloadAt'">
          <span class="ptd-date-time">{{ formatDateTimeForTable(record.downloadAt ?? 0) }}</span>
        </template>

        <template v-else-if="column.key === 'downloadStatus'">
          <a-flex align="center" justify="center" :gap="4">
            <a-tag @click="() => viewDownloadDetail(record)"
              ><component :is="downloadStatusMeta(record.downloadStatus).icon" class="download-history__status-icon" />
              {{ downloadStatusMeta(record.downloadStatus).title }}
            </a-tag>
            <!-- DOWNLOADER-8：成功但降级的记录在列表里也要可见。用 warning 色（浅色告警，不是 error 红）
                 + tooltip 承载完整文案，避免把长文案塞进表格列把行撑高 -->
            <a-tooltip v-if="record.warningMessage" :title="record.warningMessage">
              <a-tag class="ptd-download-warning" color="warning" @click="() => viewDownloadDetail(record)"
                ><WarningOutlined class="download-history__status-icon" />{{ t("DownloadHistory.warning") }}</a-tag
              >
            </a-tooltip>
          </a-flex>
        </template>

        <template v-else-if="column.key === 'action'">
          <a-button-group class="table-action">
            <a-button
              :title="t('DownloadHistory.reDownload')"
              @click="() => reDownloadTorrent([record.id!])"
              type="primary"
              size="small"
              ><template #icon><DownloadOutlined /></template
            ></a-button>

            <a-button :title="t('common.remove')" @click="() => deleteDownloadHistory([record.id!])" danger size="small"
              ><template #icon><DeleteOutlined /></template
            ></a-button>
          </a-button-group>
        </template>
      </template>

      <template #emptyText>
        <NoDataPlaceholder compact>
          <!-- 底层记录为空时才引导去搜索；仅筛选无结果时留在本页调整过滤词 -->
          <a-button
            v-if="downloadHistoryList.length === 0 && !isLoadingDownloadHistory"
            type="primary"
            @click="router.push({ name: 'SearchEntity' })"
          >
            <template #icon><SearchOutlined /></template>
            {{ t("common.search") }}
          </a-button>
        </NoDataPlaceholder>
      </template>
    </a-table>
  </a-card>

  <ReDownloadSelectDialog
    v-model="showReDownloadSelectDialog"
    :torrent-items="reDownloadTorrentListRef"
    @re-download-complete="() => throttleLoadDownloadHistory()"
  />

  <AdvanceFilterGenerateDialog v-model="showAdvanceFilterDialog" />

  <DeleteDialog
    v-model="showDeleteDialog"
    :to-delete-ids="toDeleteIds"
    :confirm-delete="confirmDeleteDownloadHistory"
    @all-delete="() => void throttleLoadDownloadHistory()"
  >
    <!-- N3：确认框列出待删除的下载记录标题 -->
    <template #append-text>
      <div v-if="toDeleteTitles.length > 0" class="download-history-delete-list">
        <div v-for="(title, index) in toDeleteTitles" :key="index" :title="title">{{ title }}</div>
        <div v-if="hasMoreDeleteTitles">…</div>
      </div>
    </template>
  </DeleteDialog>

  <a-modal v-model:open="showDownloadDetailDialog" :footer="null" :width="800">
    <!-- DOWNLOADER-8：告警与失败原因必须分开渲染 —— 降级记录 downloadStatus 仍是 completed，
         用红色「失败原因」展示会让用户以为推送失败了 -->
    <a-alert
      v-if="downloadDetail.warningMessage"
      type="warning"
      show-icon
      class="ptd-download-warning-detail download-history__detail-alert"
      ><template #icon><WarningOutlined /></template
      ><template #description>
        <div class="download-history__detail-heading">
          {{ t("DownloadHistory.detail.warningMessage") }}
        </div>
        <code class="download-history__detail-code">{{ downloadDetail.warningMessage }}</code>
      </template></a-alert
    >
    <a-alert v-if="downloadDetail.errorMessage" type="error" show-icon class="download-history__detail-alert"
      ><template #icon><WarningOutlined /></template
      ><template #description>
        <div class="download-history__detail-heading">
          {{ t("DownloadHistory.detail.errorMessage") }}
        </div>
        <code class="download-history__detail-code">{{ downloadDetail.errorMessage }}</code>
      </template></a-alert
    >
    <pre> {{ JSON.stringify(downloadDetail, null, 2) }}</pre>
  </a-modal>
</template>

<style scoped>
.download-history-delete-list {
  max-height: 160px;
  margin: 8px 0 0;
  overflow-y: auto;
  text-align: left;
  word-break: break-all;
}

.download-history-delete-list > div {
  position: relative;
  padding-left: 14px;
}

.download-history-delete-list > div::before {
  content: "•";
  position: absolute;
  left: 2px;
}

/* 表格单元格 / 详情弹窗中重复的静态样式，收敛为语义类（动态位置相关样式仍留在模板） */
.download-history__site {
  display: flex;
  flex-direction: column;
  align-items: center;
}

.download-history__site-name {
  max-width: 10rem;
}

.download-history__filter-icon {
  cursor: pointer;
}

.download-history__status-icon {
  margin-right: 4px;
}

.download-history__detail-alert {
  margin-bottom: 12px;
}

.download-history__detail-heading {
  margin-bottom: 4px;
  font-size: 14px;
  font-weight: 600;
}

.download-history__detail-code {
  font-size: 14px;
}
</style>
