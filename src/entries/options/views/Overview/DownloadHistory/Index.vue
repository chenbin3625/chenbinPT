<script setup lang="ts">
import {
  DeleteOutlined,
  DownloadOutlined,
  FilterOutlined,
  MinusOutlined,
  SyncOutlined,
  WarningOutlined,
} from "@ant-design/icons-vue";
import { useI18n } from "vue-i18n";
import { onMounted, onUnmounted, ref, shallowRef, computed } from "vue";
import {
  titleColumnMaxWidth as titleColumnMaxWidthFor,
  toAntdColumns,
  toPagination,
  toSortBy,
} from "../utils/antdTable.ts";
import { useDisplay } from "@/options/composables/useDisplay.ts";
import type { DataTableHeader } from "@/options/types/dataTable.ts";

import { sendMessage } from "@/messages.ts";
import { formatDate, formatDateTimeForTable } from "@/options/utils.ts";
import { useConfigStore } from "@/options/stores/config.ts";
import type { ITorrentDownloadMetadata, TTorrentDownloadKey } from "@/shared/types.ts";

import SiteFavicon from "@/options/components/SiteFavicon/Index.vue";
import SiteName from "@/options/components/SiteName.vue";
import TorrentTitleTd from "@/options/components/TorrentTitleTd.vue";
import DeleteDialog from "@/options/components/DeleteDialog.vue";
import DownloaderLabel from "@/options/components/DownloaderLabel.vue";
import NavButton from "@/options/components/NavButton.vue";
import NoDataPlaceholder from "@/options/components/NoDataPlaceholder.vue";
import ReDownloadSelectDialog from "./ReDownloadSelectDialog.vue";
import AdvanceFilterGenerateDialog from "./AdvanceFilterGenerateDialog.vue";

import {
  downloadHistory,
  downloadHistoryList,
  downloadStatusMap,
  tableCustomFilter,
  clearWatchingMap,
  throttleLoadDownloadHistory,
  isLoadingDownloadHistory,
} from "./utils.ts"; // <-- 主要方法

const { t } = useI18n();
const configStore = useConfigStore();
const display = useDisplay();

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
  toAntdColumns(tableHeader.value, {
    sortBy: configStore.tableBehavior.DownloadHistory.sortBy,
    multiSort: configStore.enableTableMultiSort,
  }),
);
const filteredTableData = computed(() =>
  downloadHistoryList.value.filter((item) => tableFilterFn(undefined, tableFilterRef.value, { raw: item })),
);
const tablePagination = computed(() =>
  toPagination(configStore.tableBehavior.DownloadHistory.itemsPerPage, (v) =>
    configStore.updateTableBehavior("DownloadHistory", "itemsPerPage", v),
  ),
);
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

async function deleteDownloadHistory(downloadHistoryIds: TTorrentDownloadKey[]) {
  toDeleteIds.value = downloadHistoryIds;
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
  throttleLoadDownloadHistory();
});

onUnmounted(() => {
  clearWatchingMap();
});
</script>

<template>
  <a-card>
    <a-typography-text strong>
      <a-flex class="page-toolbar" align="center" :gap="8">
        <!-- 按钮组 -->
        <NavButton
          color="green"
          :icon="SyncOutlined"
          :text="t('DownloadHistory.refresh')"
          @click="() => throttleLoadDownloadHistory()"
        />

        <a-divider type="vertical" style="margin-left: 8px; margin-right: 8px"></a-divider>

        <NavButton
          :disabled="tableSelected.length === 0"
          color="primary"
          :icon="DownloadOutlined"
          :text="t('DownloadHistory.reDownload')"
          @click="() => reDownloadTorrent(tableSelected)"
        />

        <NavButton
          :disabled="tableSelected.length === 0"
          :text="t('common.remove')"
          color="error"
          :icon="MinusOutlined"
          @click="deleteDownloadHistory(tableSelected)"
        />

        <div style="flex: 1 1 auto"></div>

        <!-- 筛选框 -->
        <a-input v-model:value="tableWaitFilterRef" allow-clear :placeholder="t('DownloadHistory.filterPlaceholder')">
          <template #prefix>
            <FilterOutlined style="cursor: pointer" @click="showAdvanceFilterDialog = true" />
          </template>
        </a-input>
      </a-flex>
    </a-typography-text>
    <a-table
      :columns="tableColumns"
      :data-source="filteredTableData"
      :loading="isLoadingDownloadHistory"
      :pagination="tablePagination"
      :row-key="'id'"
      :row-selection="{ selectedRowKeys: tableSelected, onChange: onSelectionChange }"
      :scroll="{ x: 'max-content' }"
      class="table-stripe"
      @change="onTableChange"
    >
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'siteId'">
          <div style="display: flex; flex-direction: column; align-items: center">
            <SiteFavicon :site-id="record.siteId" :size="18" />
            <SiteName class="ptd-cell-ellipsis" style="max-width: 10rem" :site-id="record.siteId" />
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
              ><component :is="downloadStatusMeta(record.downloadStatus).icon" style="margin-right: 4px" />
              {{ downloadStatusMeta(record.downloadStatus).title }}
            </a-tag>
            <!-- DOWNLOADER-8：成功但降级的记录在列表里也要可见。用 warning 色（浅色告警，不是 error 红）
                 + tooltip 承载完整文案，避免把长文案塞进表格列把行撑高 -->
            <a-tooltip v-if="record.warningMessage" :title="record.warningMessage">
              <a-tag class="ptd-download-warning" color="warning" @click="() => viewDownloadDetail(record)"
                ><WarningOutlined style="margin-right: 4px" />{{ t("DownloadHistory.warning") }}</a-tag
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
        <NoDataPlaceholder compact />
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
    @all-delete="() => throttleLoadDownloadHistory()"
  />

  <a-modal v-model:open="showDownloadDetailDialog" :footer="null" :width="800">
    <!-- DOWNLOADER-8：告警与失败原因必须分开渲染 —— 降级记录 downloadStatus 仍是 completed，
         用红色「失败原因」展示会让用户以为推送失败了 -->
    <a-alert
      v-if="downloadDetail.warningMessage"
      type="warning"
      show-icon
      style="margin-bottom: 12px"
      class="ptd-download-warning-detail"
      ><template #icon><WarningOutlined /></template
      ><template #description>
        <div style="font-size: 14px; font-weight: 600; margin-bottom: 4px">
          {{ t("DownloadHistory.detail.warningMessage") }}
        </div>
        <code style="font-size: 14px">{{ downloadDetail.warningMessage }}</code>
      </template></a-alert
    >
    <a-alert v-if="downloadDetail.errorMessage" type="error" show-icon style="margin-bottom: 12px"
      ><template #icon><WarningOutlined /></template
      ><template #description>
        <div style="font-size: 14px; font-weight: 600; margin-bottom: 4px">
          {{ t("DownloadHistory.detail.errorMessage") }}
        </div>
        <code style="font-size: 14px">{{ downloadDetail.errorMessage }}</code>
      </template></a-alert
    >
    <pre> {{ JSON.stringify(downloadDetail, null, 2) }}</pre>
  </a-modal>
</template>
