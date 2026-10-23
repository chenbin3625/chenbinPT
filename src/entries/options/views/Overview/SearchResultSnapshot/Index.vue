<script setup lang="ts">
import { DeleteOutlined, EditOutlined, FileSearchOutlined, MinusOutlined } from "@ant-design/icons-vue";
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import { refDebounced } from "@vueuse/core";
import type { DataTableHeader } from "@/options/types/dataTable.ts";

import { formatDateTimeForTable } from "@/options/utils.ts";
import { useMetadataStore } from "@/options/stores/metadata.ts";
import { useConfigStore } from "@/options/stores/config.ts";
import { useStoreHydrating } from "@/options/composables/useStoreHydrating.ts";
import { type TSearchSnapshotKey } from "@/shared/types.ts";

import DeleteDialog from "@/options/components/DeleteDialog.vue";
import NavButton from "@/options/components/NavButton.vue";
import NoDataPlaceholder from "@/options/components/NoDataPlaceholder.vue";
import EditNameDialog from "./EditNameDialog.vue";
import { matchesHeaders, toAntdColumns, toPagination, toSortBy } from "../utils/antdTable.ts";

const { t } = useI18n();
const router = useRouter();
const configStore = useConfigStore();
const metadataStore = useMetadataStore();

// 快照列表来自 metadata store，该 store 需要先从 chrome.storage 异步水合；
// 水合完成前绑定 loading，避免先闪一下「暂无数据」再蹦出数据
const isStoreHydrating = useStoreHydrating(metadataStore);

const showEditNameDialog = ref<boolean>(false);
const showDeleteDialog = ref<boolean>(false);

// F11：表头是 `t()` 求值的，若写成 setup 期常量，切语言后不会重新求值（页面其它文案会变、列头停在旧语言）
const tableHeader = computed<DataTableHeader[]>(() => [
  {
    title: t("SearchResultSnapshot.table.header.name"),
    key: "name",
    align: "start",
    // 快照名 = [方案] 搜索词 (时间)，可能很长；限宽后单行省略、悬停看全文
    maxWidth: "48rem",
  },
  { title: t("SearchResultSnapshot.table.header.recordCount"), key: "recordCount", align: "end", width: 100 },
  {
    title: t("SearchResultSnapshot.table.header.createdAt"),
    key: "createdAt",
    align: "center",
    width: 150,
    minWidth: 150,
  },
  {
    title: t("common.action"),
    key: "action",
    align: "center",
    width: 125,
    minWidth: 125,
    sortable: false,
    alwaysShow: true,
  },
]);
const tableSelected = ref<TSearchSnapshotKey[]>([]);
const tableWaitFilter = ref("");
const tableFilter = refDebounced(tableWaitFilter, 500); // 延迟搜索过滤词的生成

const columns = computed(() =>
  toAntdColumns(tableHeader.value, {
    sortBy: configStore.tableBehavior.SearchResultSnapshot.sortBy,
    multiSort: configStore.enableTableMultiSort,
  }),
);
const tableData = computed(() =>
  metadataStore.getSearchSnapshotList.filter((item) => matchesHeaders(item, tableFilter.value, tableHeader.value)),
);
const pagination = computed(() =>
  // F16：历史配置里的 itemsPerPage = -1 会让 a-table 完全不渲染分页器（连「每页条数」都改不回来），
  // 与 SearchEntity 保持一致：不允许「不分页」这个历史取值。
  toPagination(
    configStore.tableBehavior.SearchResultSnapshot.itemsPerPage,
    (v) => configStore.updateTableBehavior("SearchResultSnapshot", "itemsPerPage", v),
    { allowUnpaginated: false },
  ),
);

function onSelectionChange(keys: (string | number)[]) {
  tableSelected.value = keys as TSearchSnapshotKey[];
}

// F4：删除（单条/批量/其他标签页）成功后，选择集里不能残留已不存在的 id；
// 否则底部「移除」按钮仍可用，并对已删除的快照再次发送删除消息。
watch(
  () => metadataStore.getSearchSnapshotList.map((item) => item.id),
  (snapshotIds) => {
    if (tableSelected.value.length === 0) return;
    const existing = new Set(snapshotIds);
    const nextSelected = tableSelected.value.filter((id) => existing.has(id));
    if (nextSelected.length !== tableSelected.value.length) tableSelected.value = nextSelected;
  },
);

function clearTableSelection() {
  tableSelected.value = [];
}

function onTableChange(_pagination: unknown, _filters: unknown, sorter: unknown) {
  configStore.updateTableBehavior("SearchResultSnapshot", "sortBy", toSortBy(sorter as never));
}

function viewSnapshot(searchSnapshotId: TSearchSnapshotKey) {
  router.push({
    name: "SearchEntity",
    query: {
      snapshot: searchSnapshotId,
    },
  });
}

const toEditId = ref<TSearchSnapshotKey | null>(null);
function editSnapshotName(searchSnapshotId: TSearchSnapshotKey) {
  toEditId.value = searchSnapshotId;
  showEditNameDialog.value = true;
}

const toDeleteIds = ref<TSearchSnapshotKey[]>([]);
function tryToDeleteSearchSnapshot(searchSnapshotId: TSearchSnapshotKey[]) {
  toDeleteIds.value = searchSnapshotId;
  showDeleteDialog.value = true;
}

async function confirmDeleteSearchSnapshot(searchSnapshotId: TSearchSnapshotKey) {
  return await metadataStore.removeSearchSnapshotData(searchSnapshotId);
}
</script>

<template>
  <a-card>
    <a-typography-text strong>
      <a-flex class="page-toolbar" align="center" :gap="8">
        <NavButton
          :disabled="tableSelected.length === 0"
          color="error"
          :icon="MinusOutlined"
          :text="t('common.remove')"
          @click="tryToDeleteSearchSnapshot(tableSelected)"
        />

        <div style="flex: 1 1 auto"></div>
        <a-input
          v-model:value="tableWaitFilter"
          allow-clear
          :placeholder="t('SearchResultSnapshot.table.filterLabel')"
        ></a-input>
      </a-flex>
    </a-typography-text>

    <a-table
      :columns="columns"
      :data-source="tableData"
      :loading="isStoreHydrating"
      :pagination="pagination"
      :row-key="'id'"
      :row-selection="{
        selectedRowKeys: tableSelected,
        onChange: onSelectionChange,
        // F4：筛选改变 dataSource 后，antd 默认会丢弃「不在当前 dataSource 里」的已选 key
        preserveSelectedRowKeys: true,
      }"
      class="table-stripe table-header-no-wrap"
      @change="onTableChange"
    >
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'createdAt'">
          <span class="ptd-date-time">{{ formatDateTimeForTable(record.createdAt) }}</span>
        </template>
        <template v-else-if="column.key === 'action'">
          <a-button-group class="table-action">
            <a-button
              :title="t('SearchResultSnapshot.table.action.view')"
              type="primary"
              size="small"
              @click="() => viewSnapshot(record.id)"
              ><template #icon><FileSearchOutlined /></template
            ></a-button>
            <a-button
              :title="t('SearchResultSnapshot.table.action.editTitle')"
              size="small"
              @click="() => editSnapshotName(record.id)"
              ><template #icon><EditOutlined /></template
            ></a-button>
            <a-button :title="t('common.remove')" danger size="small" @click="tryToDeleteSearchSnapshot([record.id])"
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

  <EditNameDialog v-model="showEditNameDialog" :edit-id="toEditId!" />
  <DeleteDialog
    v-model="showDeleteDialog"
    :to-delete-ids="toDeleteIds"
    :confirm-delete="confirmDeleteSearchSnapshot"
    @all-delete="clearTableSelection"
  />
</template>
