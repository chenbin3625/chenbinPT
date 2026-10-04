<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import { BackupFields, TBackupFields } from "@/shared/types.ts";
import { sendMessage } from "@/messages.ts";

const showDialog = defineModel<boolean>();
const { t } = useI18n();

const backupFields = ref<TBackupFields[]>([]);

async function doLocalExport() {
  await sendMessage("exportBackupData", { backupFields: backupFields.value, backupServerId: "local" });
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
