<script setup lang="ts">
import { ref, computed } from "vue";
import { useI18n } from "vue-i18n";
import {
  CloudUploadOutlined,
  DeleteOutlined,
  EditOutlined,
  ExportOutlined,
  FilterOutlined,
  ImportOutlined,
  MinusOutlined,
  PlusOutlined,
  SearchOutlined,
  UnorderedListOutlined,
} from "@ant-design/icons-vue";
import { getBackupServerIcon } from "@ptd/backupServer";
import { hasBackupRetentionToApply } from "@ptd/backupServer/utils.ts";

import { useMetadataStore } from "@/options/stores/metadata.ts";
import { useRuntimeStore } from "@/options/stores/runtime.ts";
import { useConfigStore } from "@/options/stores/config.ts";
import { formatDate, formatDateTimeForTable } from "@/options/utils.ts";
import { withEllipsisCell } from "@/options/views/Overview/utils/antdTable.ts";
import { useStoreHydrating } from "@/options/composables/useStoreHydrating.ts";
import { BackupFields, type IBackupServerMetadata, type TBackupServerKey } from "@/shared/types.ts";
import { resolveColor } from "@/shared/colors.ts";
import { sendMessage } from "@/messages.ts";

import NavButton from "@/options/components/NavButton.vue";
import DeleteDialog from "@/options/components/DeleteDialog.vue";
import NoDataPlaceholder from "@/options/components/NoDataPlaceholder.vue";
import AddDialog from "./AddDialog.vue";
import EditDialog from "./EditDialog.vue";
import LocalExportConfirmDialog from "./LocalExportConfirmDialog.vue";
import HistoryDialog from "./HistoryDialog.vue";
import RestoreDialog from "./RestoreDialog.vue";

const { t } = useI18n();
const runtimeStore = useRuntimeStore();
const metadataStore = useMetadataStore();
const configStore = useConfigStore();

// 备份服务器列表来自 metadata store，异步水合完成前不能把空列表当成「暂无数据」
const isStoreHydrating = useStoreHydrating(metadataStore);

const showAddDialog = ref<boolean>(false);
const showLocalExportConfirmDialog = ref<boolean>(false);
const showHistoryDialog = ref<boolean>(false);
const showEditDialog = ref<boolean>(false);
const showRestoreDialog = ref<boolean>(false);
const showDeleteDialog = ref<boolean>(false);

const columns = computed(() => {
  const multiple = configStore.enableTableMultiSort ? 4 : undefined;
  return [
    { title: t("common.type"), dataIndex: "type", key: "type", align: "center" as const, width: 90 },
    withEllipsisCell(
      {
        title: t("common.name"),
        dataIndex: "name",
        key: "name",
        sorter: {
          compare: (a: IBackupServerMetadata, b: IBackupServerMetadata) =>
            String(a.name ?? "").localeCompare(String(b.name ?? "")),
          multiple,
        },
      },
      "12rem",
    ),
    { title: t("SetBackup.table.backupFields"), key: "backupFields" },
    {
      title: t("SetBackup.table.backupInterval"),
      dataIndex: "backupInterval",
      key: "backupInterval",
      align: "center" as const,
      sorter: {
        compare: (a: IBackupServerMetadata, b: IBackupServerMetadata) =>
          Number(a.backupInterval ?? 0) - Number(b.backupInterval ?? 0),
        multiple,
      },
    },
    { title: t("SetBackup.table.retention"), key: "retention", align: "center" as const },
    {
      title: t("SetBackup.table.lastBackupAt"),
      dataIndex: "lastBackupAt",
      key: "lastBackupAt",
      align: "right" as const,
      sorter: {
        compare: (a: IBackupServerMetadata, b: IBackupServerMetadata) =>
          Number(a.lastBackupAt ?? 0) - Number(b.lastBackupAt ?? 0),
        multiple,
      },
    },
    {
      title: t("common.enable"),
      dataIndex: "enabled",
      key: "enabled",
      align: "center" as const,
      sorter: {
        compare: (a: IBackupServerMetadata, b: IBackupServerMetadata) => Number(a.enabled) - Number(b.enabled),
        multiple,
      },
    },
    { title: t("common.action"), key: "action" },
  ];
});
const tableSelected = ref<TBackupServerKey[]>([]);
/** 工具条搜索词：按名称 / 类型过滤备份服务器列表 */
const tableFilter = ref("");

const tableData = computed(() =>
  metadataStore.getBackupServers.filter((server) => {
    if (!tableFilter.value) return true;
    const keyword = tableFilter.value.toLowerCase();
    return (
      String(server.type ?? "")
        .toLowerCase()
        .includes(keyword) ||
      String(server.name ?? "")
        .toLowerCase()
        .includes(keyword)
    );
  }),
);

function onSelectionChange(keys: (string | number)[]) {
  tableSelected.value = keys.map((key) => String(key));
}

/** 自动备份间隔（小时），支持小数以表达不足 1 小时的间隔 */
function formatBackupInterval(serverConfig: IBackupServerMetadata): string {
  const interval = serverConfig.backupInterval ?? 0;
  if (!(interval > 0)) {
    return "";
  }
  return t("SetBackup.table.everyNHour", { n: Number(interval.toFixed(2)) });
}

const localBackup = Symbol("localBackup");
const doBackupStatus = ref<Record<TBackupServerKey | symbol, boolean>>({});
async function doBackup(backupServerId: TBackupServerKey | symbol) {
  doBackupStatus.value[backupServerId] = true;

  // M-25：复位放在 finally、异常给出失败提示。WebDAV.addFile 等不带 try，exportBackupData 又不在消息重试白名单里，
  // 401 之类会以 rejection 抛到这里；原先复位写在 await 之后，按钮会永久 loading（antd loading 还会拦截点击）。
  try {
    if (typeof backupServerId == "string") {
      const serverConfig = metadataStore.backupServers[backupServerId];
      const backupFields = serverConfig.backupFields ?? [...BackupFields];
      const backupStatus = await sendMessage("exportBackupData", { backupFields, backupServerId });
      if (backupStatus) {
        // 备份成功后的保留策略清理由 exportBackupData 内部完成，此处仅对启用了保留策略的服务器加以提示
        const hasRetention = hasBackupRetentionToApply(serverConfig?.retention);
        runtimeStore.showSnakebar(
          t(hasRetention ? "SetBackup.snackbar.successWithRetention" : "SetBackup.snackbar.success"),
          {
            color: "success",
          },
        );
      } else {
        runtimeStore.showSnakebar(t("SetBackup.snackbar.failure"), { color: "error" });
      }
    } else if (backupServerId == localBackup) {
      showLocalExportConfirmDialog.value = true;
    }
  } catch {
    runtimeStore.showSnakebar(t("SetBackup.snackbar.failure"), { color: "error" });
  } finally {
    doBackupStatus.value[backupServerId] = false;
  }
}

const toEditBackupServerId = ref<TBackupServerKey | null>(null);
function editBackupServer(id: TBackupServerKey) {
  toEditBackupServerId.value = id;
  showEditDialog.value = true;
}

const toShowHistoryBackupServerId = ref<TBackupServerKey | null>(null);
function showHistory(id: TBackupServerKey) {
  toShowHistoryBackupServerId.value = id;
  showHistoryDialog.value = true;
}

const toDeleteIds = ref<TBackupServerKey[]>([]);
function deleteBackupServer(ids: TBackupServerKey[]) {
  toDeleteIds.value = ids;
  showDeleteDialog.value = true;
}

async function confirmDeleteBackupServer(id: TBackupServerKey) {
  return await metadataStore.removeBackupServer(id);
}
</script>

<template>
  <a-card class="ptd-settings-card">
    <template #title>
      <a-flex class="page-toolbar" align="center" :gap="8">
        <NavButton :icon="PlusOutlined" :text="t('common.btn.add')" color="success" @click="showAddDialog = true" />
        <NavButton
          :disabled="tableSelected.length === 0"
          :icon="MinusOutlined"
          :text="t('common.remove')"
          color="error"
          @click="deleteBackupServer(tableSelected)"
        />

        <a-divider style="margin: 0 8px" type="vertical" />

        <NavButton
          :icon="ExportOutlined"
          :loading="doBackupStatus[localBackup]"
          color="info"
          :text="t('SetBackup.localExport')"
          @click="doBackup(localBackup)"
        />
        <NavButton
          :icon="ImportOutlined"
          color="blue"
          :text="t('SetBackup.localImport')"
          @click="() => (showRestoreDialog = true)"
        />

        <span style="flex: 1 1 auto" />

        <a-input v-model:value="tableFilter" allow-clear :placeholder="t('common.search')" style="max-width: 500px">
          <template #suffix><SearchOutlined /></template>
        </a-input>
      </a-flex>
    </template>

    <a-table
      :columns="columns"
      :data-source="tableData"
      :loading="isStoreHydrating"
      :pagination="{ pageSize: 25, pageSizeOptions: ['5', '10', '25', '50', '100'], showSizeChanger: true }"
      :row-key="'id'"
      :row-selection="{ selectedRowKeys: tableSelected, onChange: onSelectionChange }"
      class="table-stripe table-header-no-wrap"
      size="small"
    >
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'type'">
          <a-avatar :alt="record.type" :src="getBackupServerIcon(record.type)" :title="record.type" />
        </template>

        <template v-else-if="column.key === 'backupFields'">
          <a-tag v-for="backupField in record.backupFields" :key="backupField" style="margin-bottom: 2px">
            <!-- 备份项标签很长（“站点与用户数据 (metadata)”），限宽省略 + 悬停看全文，
                 避免这一格把整行撑到三行高 -->
            <span class="ptd-cell-ellipsis" style="max-width: 7rem" :title="t(`SetBackup.fields.${backupField}`)">{{
              t(`SetBackup.fields.${backupField}`)
            }}</span>
          </a-tag>
        </template>

        <template v-else-if="column.key === 'backupInterval'">
          <span v-if="record.backupInterval && record.backupInterval > 0" style="white-space: nowrap">
            {{ formatBackupInterval(record) }}
          </span>
          <a-typography-text v-else type="secondary">—</a-typography-text>
        </template>

        <template v-else-if="column.key === 'retention'">
          <a-tooltip
            :title="
              hasBackupRetentionToApply(record.retention)
                ? t('SetBackup.table.retentionEnabled')
                : t('SetBackup.table.retentionDisabled')
            "
          >
            <FilterOutlined
              :style="{ color: hasBackupRetentionToApply(record.retention) ? resolveColor('success') : undefined }"
            />
          </a-tooltip>
        </template>

        <template v-else-if="column.key === 'lastBackupAt'">
          <span class="ptd-date-time">{{
            record.lastBackupAt ? formatDateTimeForTable(record.lastBackupAt) : "notBackup"
          }}</span>
        </template>

        <template v-else-if="column.key === 'enabled'">
          <a-switch
            v-model:checked="record.enabled"
            class="table-switch-btn"
            @change="(v: any) => metadataStore.simplePatch('backupServers', record.id, 'enabled', v as boolean)"
          />
        </template>

        <template v-else-if="column.key === 'action'">
          <a-button-group class="table-action">
            <a-button
              :loading="doBackupStatus[record.id]"
              :title="t('SetBackup.table.action.backupNow')"
              size="small"
              type="primary"
              @click="doBackup(record.id)"
            >
              <template #icon><CloudUploadOutlined /></template>
            </a-button>
            <a-button
              :title="t('SetBackup.table.action.viewHistoryBackup')"
              size="small"
              @click="showHistory(record.id)"
            >
              <template #icon><UnorderedListOutlined /></template>
            </a-button>

            <a-button :title="t('common.edit')" size="small" @click="editBackupServer(record.id)">
              <template #icon><EditOutlined /></template>
            </a-button>

            <a-button danger :title="t('common.remove')" size="small" @click="deleteBackupServer([record.id])">
              <template #icon><DeleteOutlined /></template>
            </a-button>
          </a-button-group>
        </template>
      </template>

      <!-- 无任何备份服务器时的空状态占位 -->
      <template #emptyText>
        <NoDataPlaceholder compact />
      </template>
    </a-table>
  </a-card>

  <AddDialog v-model="showAddDialog" />
  <EditDialog v-model="showEditDialog" :client-id="toEditBackupServerId!" />
  <DeleteDialog v-model="showDeleteDialog" :to-delete-ids="toDeleteIds" :confirm-delete="confirmDeleteBackupServer" />
  <HistoryDialog v-model="showHistoryDialog" :backup-server-id="toShowHistoryBackupServerId!" />
  <LocalExportConfirmDialog v-model="showLocalExportConfirmDialog" />
  <RestoreDialog v-model="showRestoreDialog" :restore-metadata="{ type: 'file' }" />
</template>
