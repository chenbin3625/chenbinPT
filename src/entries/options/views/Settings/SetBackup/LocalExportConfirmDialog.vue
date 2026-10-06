<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import { BackupFields, TBackupFields } from "@/shared/types.ts";
import { sendMessage } from "@/messages.ts";

const showDialog = defineModel<boolean>();
const { t } = useI18n();

const backupFields = ref<TBackupFields[]>([]);
const isExporting = ref(false);

/**
 * L-11：antd Modal 的 ok 只 emit，不会自动关闭；同类弹窗（ExportUserInfoDialog / RestoreDialog）都显式关闭。
 * 不关的话用户以为确认没生效，再点一次会在同一分钟内重复生成并下载同一份 zip。
 */
async function doLocalExport() {
  if (isExporting.value) return;
  isExporting.value = true;
  try {
    await sendMessage("exportBackupData", { backupFields: backupFields.value, backupServerId: "local" });
    showDialog.value = false;
  } finally {
    isExporting.value = false;
  }
}

function dialogEnter() {
  backupFields.value = [...BackupFields];
}

// 原生 a-modal 没有 afterOpenChange（只有 afterClose），打开时的初始化自行监听 open。
watch(showDialog, (open) => {
  if (open) nextTick(dialogEnter);
});
</script>

<template>
  <a-modal
    v-model:open="showDialog"
    :cancel-text="t('common.dialog.cancel')"
    :confirm-loading="isExporting"
    :ok-text="t('common.export')"
    :title="t('SetBackup.LocalExportConfirmDialog.title')"
    :width="600"
    @ok="() => doLocalExport()"
  >
    <a-checkbox-group v-model:value="backupFields" style="width: 100%">
      <a-row :gutter="[0, 8]">
        <a-col v-for="backupField in BackupFields" :key="backupField" :md="12" :xs="24">
          <a-checkbox :value="backupField">{{ t(`SetBackup.fields.${backupField}`) }}</a-checkbox>
        </a-col>
      </a-row>
    </a-checkbox-group>
  </a-modal>
</template>
