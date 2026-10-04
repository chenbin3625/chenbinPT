<script setup lang="ts">
import { ExportOutlined, DeleteOutlined, EditOutlined, MinusOutlined, PlusOutlined } from "@ant-design/icons-vue";
import { get } from "es-toolkit/compat";
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import type { DataTableHeader } from "@/options/types/dataTable.ts";
import { getMediaServerIcon } from "@ptd/mediaServer";

import { useMetadataStore } from "@/options/stores/metadata.ts";
import { useConfigStore } from "@/options/stores/config.ts";
import { withEllipsisCell } from "@/options/views/Overview/utils/antdTable.ts";
import { useStoreHydrating } from "@/options/composables/useStoreHydrating.ts";
import type { TDownloaderKey, TMediaServerKey } from "@/shared/types.ts";

import AddDialog from "./AddDialog.vue";
import EditDialog from "./EditDialog.vue";
import NavButton from "@/options/components/NavButton.vue";
import DeleteDialog from "@/options/components/DeleteDialog.vue";
import NoDataPlaceholder from "@/options/components/NoDataPlaceholder.vue";

const { t } = useI18n();
const configStore = useConfigStore();
const metadataStore = useMetadataStore();

// 媒体服务器列表来自 metadata store，异步水合完成前不能把空列表当成「暂无数据」
const isStoreHydrating = useStoreHydrating(metadataStore);

const showAddDialog = ref<boolean>(false);
const showEditDialog = ref<boolean>(false);
const showDeleteDialog = ref<boolean>(false);

const fullTableHeader = [
  { title: t("common.type"), key: "type", align: "center" },
  { title: t("SetDownloader.common.name"), key: "name", align: "start" },
  { title: t("SetDownloader.common.address"), key: "address", align: "start" },
  { title: t("SetDownloader.index.table.enabled"), key: "enabled", align: "center" },
  { title: t("common.action"), key: "action", sortable: false },
] as DataTableHeader[];
const tableSelected = ref<TMediaServerKey[]>([]);

const columns = computed(() => {
  const multiSort = configStore.enableTableMultiSort;
  // 名称列走 antd 默认文本渲染，这里补上最大宽度限制（type/address/action 列由 #bodyCell 接管）
  const ellipsisMaxWidth: Record<string, string> = { name: "14rem", type: "6rem", enabled: "6rem" };
  return fullTableHeader.map((header) => {
    const key = String(header.key);
    const compare = (a: Record<string, any>, b: Record<string, any>) => {
      const left = get(a, key);
      const right = get(b, key);
      if (typeof left === "number" && typeof right === "number") return left - right;
      return String(left ?? "").localeCompare(String(right ?? ""));
    };
    return withEllipsisCell(
      {
        align: header.align === "end" ? "right" : header.align === "start" ? "left" : (header.align as "center"),
        dataIndex: key,
        key,
        sorter: header.sortable === false ? false : multiSort ? { compare, multiple: 1 } : compare,
        title: header.title,
        width: header.width,
      },
      ellipsisMaxWidth[key] ?? header.maxWidth,
    );
  });
});

const rowSelection = computed(() => ({
  selectedRowKeys: tableSelected.value,
  onChange: (keys: (string | number)[]) => {
    tableSelected.value = keys as TMediaServerKey[];
  },
}));

const toEditMediaServerId = ref<TDownloaderKey | null>(null);
function editMediaServer(mediaServerId: TMediaServerKey) {
  toEditMediaServerId.value = mediaServerId;
  showEditDialog.value = true;
}

const toDeleteIds = ref<TMediaServerKey[]>([]);
function deleteMediaServer(mediaServerId: TMediaServerKey[]) {
  toDeleteIds.value = mediaServerId;
  showDeleteDialog.value = true;
}

async function confirmDeleteMediaServer(mediaServerId: TMediaServerKey) {
  return await metadataStore.removeMediaServer(mediaServerId);
}
</script>

<template>
  <a-card class="ptd-settings-card">
    <template #title>
      <a-flex class="page-toolbar" align="center" :gap="8">
        <NavButton :text="t('common.btn.add')" color="success" :icon="PlusOutlined" @click="showAddDialog = true" />
        <NavButton
          :disabled="tableSelected.length === 0"
          :text="t('common.remove')"
          color="error"
          :icon="MinusOutlined"
          @click="deleteMediaServer(tableSelected)"
        />
      </a-flex>
    </template>

    <a-table
      class="table-stripe table-header-no-wrap"
      :columns="columns"
      :data-source="metadataStore.getMediaServers"
      :loading="isStoreHydrating"
      :pagination="{ pageSize: 25, showSizeChanger: true }"
      :row-key="(record: any) => record.id"
      :row-selection="rowSelection"
    >
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'type'">
          <a-avatar :alt="record.type" :src="getMediaServerIcon(record.type)" />
        </template>

        <template v-else-if="column.key === 'address'">
          <span class="ptd-cell-ellipsis" style="max-width: 40rem" :title="String(record.address ?? '')">
            <a-typography-link :href="record.address" rel="noopener noreferrer nofollow" target="_blank">
              {{ record.address }}
              <ExportOutlined class="ptd-icon-sm" />
            </a-typography-link>
          </span>
        </template>

        <template v-else-if="column.key === 'enabled'">
          <a-switch
            v-model:checked="record.enabled"
            class="table-switch-btn"
            @change="(v: boolean) => metadataStore.simplePatch('mediaServers', record.id, 'enabled', v)"
          />
        </template>

        <template v-else-if="column.key === 'action'">
          <a-space class="table-action">
            <a-tooltip :title="t('common.edit')">
              <a-button size="small" @click="editMediaServer(record.id)">
                <template #icon>
                  <EditOutlined />
                </template>
              </a-button>
            </a-tooltip>
            <a-tooltip :title="t('common.remove')">
              <a-button size="small" @click="deleteMediaServer([record.id])">
                <template #icon>
                  <DeleteOutlined />
                </template>
              </a-button>
            </a-tooltip>
          </a-space>
        </template>
      </template>

      <!-- 无任何媒体服务器时的空状态占位 -->
      <template #emptyText>
        <NoDataPlaceholder compact />
      </template>
    </a-table>

    <AddDialog v-model="showAddDialog" />
    <EditDialog v-model="showEditDialog" :client-id="toEditMediaServerId!" />

    <DeleteDialog v-model="showDeleteDialog" :to-delete-ids="toDeleteIds" :confirm-delete="confirmDeleteMediaServer" />
  </a-card>
</template>
