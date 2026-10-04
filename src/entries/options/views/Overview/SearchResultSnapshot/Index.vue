<script setup lang="ts">
import { DeleteOutlined, EditOutlined, FileSearchOutlined, MinusOutlined } from "@ant-design/icons-vue";
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import { refDebounced } from "@vueuse/core";
import type { DataTableHeader } from "@/options/types/dataTable.ts";

import { formatDate, formatDateTimeForTable } from "@/options/utils.ts";
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

const tableHeader = [
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
] as DataTableHeader[];
const tableSelected = ref<TSearchSnapshotKey[]>([]);
const tableWaitFilter = ref("");
const tableFilter = refDebounced(tableWaitFilter, 500); // 延迟搜索过滤词的生成

const columns = computed(() =>
  toAntdColumns(tableHeader, {
    sortBy: configStore.tableBehavior.SearchResultSnapshot.sortBy,
    multiSort: configStore.enableTableMultiSort,
  }),
);
const tableData = computed(() =>
  metadataStore.getSearchSnapshotList.filter((item) => matchesHeaders(item, tableFilter.value, tableHeader)),
);
const pagination = computed(() =>
  toPagination(configStore.tableBehavior.SearchResultSnapshot.itemsPerPage, (v) =>
    configStore.updateTableBehavior("SearchResultSnapshot", "itemsPerPage", v),
  ),
);

function onSelectionChange(keys: (string | number)[]) {
  tableSelected.value = keys as TSearchSnapshotKey[];
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
      :row-selection="{ selectedRowKeys: tableSelected, onChange: onSelectionChange }"
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
  <DeleteDialog v-model="showDeleteDialog" :to-delete-ids="toDeleteIds" :confirm-delete="confirmDeleteSearchSnapshot" />
</template>
