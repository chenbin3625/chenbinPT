<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { nextTick, ref, shallowRef, watch } from "vue";
import { CloudDownloadOutlined, DeleteOutlined } from "@ant-design/icons-vue";
import type { IBackupFileInfo } from "@ptd/backupServer";

import { sendMessage } from "@/messages.ts";
import { formatDate, formatDateTimeForTable, formatSize } from "@/options/utils.ts";
import { withEllipsisCell } from "@/options/views/Overview/utils/antdTable.ts";
import { useRuntimeStore } from "@/options/stores/runtime.ts";
import { useMetadataStore } from "@/options/stores/metadata.ts";

import DeleteDialog from "@/options/components/DeleteDialog.vue";
import NavButton from "@/options/components/NavButton.vue";
import NoDataPlaceholder from "@/options/components/NoDataPlaceholder.vue";
import { getBackupHistoryErrorReason } from "./utils.ts";
import RestoreDialog from "./RestoreDialog.vue";

const showDialog = defineModel<boolean>();
const { backupServerId } = defineProps<{
  backupServerId: string;
}>();

const { t } = useI18n();
const metadataStore = useMetadataStore();
const runtimeStore = useRuntimeStore();

const isLoading = ref<boolean>(false);
const backupHistory = shallowRef<IBackupFileInfo[]>([]);

const columns = [
  withEllipsisCell(
    {
      title: t("SetBackup.HistoryDialog.table.filename"),
      dataIndex: "filename",
      key: "filename",
      sorter: (a: IBackupFileInfo, b: IBackupFileInfo) => a.filename.localeCompare(b.filename),
    },
    // 备份文件名 = 服务器前缀 + 时间戳 + 类型，比较长；限宽省略 + 悬停看全文
    "24rem",
  ),
  {
    title: t("SetBackup.HistoryDialog.table.size"),
    dataIndex: "size",
    key: "size",
    align: "right" as const,
    sorter: (a: IBackupFileInfo, b: IBackupFileInfo) =>
      (typeof a.size === "number" ? a.size : -1) - (typeof b.size === "number" ? b.size : -1),
  },
  {
    title: t("SetBackup.HistoryDialog.table.time"),
    dataIndex: "time",
    key: "time",
    defaultSortOrder: "descend" as const,
    sorter: (a: IBackupFileInfo, b: IBackupFileInfo) => a.time - b.time,
  },
  { title: t("common.action"), key: "action", align: "right" as const },
];
const tableSelected = ref<string[]>([]);

function onSelectionChange(keys: (string | number)[]) {
  tableSelected.value = keys.map((key) => String(key));
}

const showRestoreDialog = ref<boolean>(false);
const restoreMetadata = ref<{ type: "remote"; server: string; path: string }>({ type: "remote", server: "", path: "" });
function restoreBackup(path: string) {
  restoreMetadata.value = { type: "remote", server: backupServerId, path };
  showRestoreDialog.value = true;
}

const showDeleteDialog = ref<boolean>(false);
const toDeleteBackupHistory = ref<string[]>([]);
async function deleteBackupHistory(paths: string[]) {
  showDeleteDialog.value = true;
  toDeleteBackupHistory.value = paths;
}

async function confirmDeleteBackupHistory(toDeleteId: string) {
  const toDeleteName = backupHistory.value.find((item) => item.path === toDeleteId)?.filename ?? toDeleteId;
  const deleteStatus = await sendMessage("deleteBackupHistory", { path: toDeleteId, backupServerId });
  if (!deleteStatus) {
    runtimeStore.showSnakebar(t("SetBackup.HistoryDialog.deleteFailure", { name: toDeleteName }), { color: "error" });
  } else {
    runtimeStore.showSnakebar(t("SetBackup.HistoryDialog.deleteSuccess", { name: toDeleteName }), { color: "success" });
    backupHistory.value = backupHistory.value.filter((item) => item.path !== toDeleteId);
  }
}

async function loadBackupHistory() {
  isLoading.value = true;
  try {
    backupHistory.value = await sendMessage("getBackupHistory", backupServerId);
  } catch (e) {
    backupHistory.value = [];
    runtimeStore.showSnakebar(t("SetBackup.HistoryDialog.loadFailure", { error: getBackupHistoryErrorReason(e) }), {
      color: "error",
    });
    console.error("获取备份历史失败", e);
  } finally {
    isLoading.value = false;
  }
}

async function dialogEnter() {
  // noinspection ES6MissingAwait
  loadBackupHistory();
}

async function dialogLeave() {
  backupHistory.value = [];
  tableSelected.value = [];
}

// 原生 a-modal 没有 afterOpenChange（只有 afterClose），打开时的初始化自行监听 open。
watch(showDialog, (open) => {
  if (open) nextTick(dialogEnter);
});
</script>

<template>
  <a-modal
    v-model:open="showDialog"
    :footer="null"
    :title="
      t('SetBackup.HistoryDialog.title', {
        // backupServerId 在未打开对话框时是 undefined（父组件传的是 toShowHistoryBackupServerId!），
        // 而 a-modal 的 title 是「父组件渲染期求值的 prop」——不像 Vuetify 的 v-dialog 只在打开时渲染内容，
        // 因此这里必须判空，否则备份设置页每次重渲染都会抛 TypeError。
        name: metadataStore.backupServers[backupServerId]?.name ?? backupServerId,
      })
    "
    :width="1000"
    :after-close="dialogLeave"
  >
    <NavButton
      :disabled="tableSelected.length === 0"
      :icon="DeleteOutlined"
      :text="t('common.remove')"
      color="error"
      @click="deleteBackupHistory(tableSelected)"
    />

    <a-table
      :columns="columns"
      :data-source="backupHistory"
      :loading="isLoading"
      :pagination="{ pageSize: 25, pageSizeOptions: ['5', '10', '25', '50', '100'], showSizeChanger: true }"
      :row-key="'path'"
      :row-selection="{ selectedRowKeys: tableSelected, onChange: onSelectionChange }"
      class="table-header-no-wrap table-stripe"
      size="small"
      style="margin-top: 8px"
    >
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'size'">
          <span style="white-space: nowrap">
            {{ record.size !== "N/A" ? formatSize(record.size) : record.size }}
          </span>
        </template>

        <template v-else-if="column.key === 'time'">
          <span class="ptd-date-time">{{ formatDateTimeForTable(record.time) }}</span>
        </template>

        <template v-else-if="column.key === 'action'">
          <a-button-group class="table-action">
            <a-button
              :title="t('SetBackup.HistoryDialog.restore')"
              size="small"
              type="primary"
              @click="restoreBackup(record.path)"
            >
              <template #icon><CloudDownloadOutlined /></template>
            </a-button>

            <a-button danger :title="t('common.remove')" size="small" @click="deleteBackupHistory([record.path])">
              <template #icon><DeleteOutlined /></template>
            </a-button>
          </a-button-group>
        </template>
      </template>

      <!-- 该备份服务器上还没有历史备份文件时的空状态占位 -->
      <template #emptyText>
        <NoDataPlaceholder compact />
      </template>
    </a-table>
  </a-modal>

  <RestoreDialog v-model="showRestoreDialog" :restore-metadata="restoreMetadata" />
  <DeleteDialog
    v-model="showDeleteDialog"
    :confirm-delete="confirmDeleteBackupHistory"
    :to-delete-ids="toDeleteBackupHistory"
    @all-delete="loadBackupHistory"
  />
</template>
