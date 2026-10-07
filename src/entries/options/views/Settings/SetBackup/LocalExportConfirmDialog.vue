<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import { BackupFields, TBackupFields } from "@/shared/types.ts";
import { useRuntimeStore } from "@/options/stores/runtime.ts";
import { sendMessage } from "@/messages.ts";

const showDialog = defineModel<boolean>();
const { t } = useI18n();
const runtimeStore = useRuntimeStore();

const backupFields = ref<TBackupFields[]>([]);
const isExporting = ref(false);

/**
 * L-11：antd Modal 的 ok 只 emit，不会自动关闭；同类弹窗（ExportUserInfoDialog / RestoreDialog）都显式关闭。
 * 不关的话用户以为确认没生效，再点一次会在同一分钟内重复生成并下载同一份 zip。
 *
 * OPTIONSSETTINGS-3：原实现只有 finally，exportBackupData 因取 cookie / 加密 / downloadFile 被拒而 reject 时
 * 会以 unhandled rejection 收场——弹窗不关、界面上没有任何失败提示；这里补 catch 与返回值检查（与
 * SetBackup/Index.vue 的 M-25 修复对齐）。
 */
async function doLocalExport() {
  if (isExporting.value) return;
  if (backupFields.value.length === 0) return; // 同模板里的确定按钮禁用条件，防被绕过时导出空 manifest
  isExporting.value = true;
  try {
    const exportStatus = await sendMessage("exportBackupData", {
      backupFields: backupFields.value,
      backupServerId: "local",
    });
    if (exportStatus === false) {
      runtimeStore.showSnakebar(t("SetBackup.snackbar.failure"), { color: "error" });
      return;
    }
    showDialog.value = false;
  } catch {
    runtimeStore.showSnakebar(t("SetBackup.snackbar.failure"), { color: "error" });
  } finally {
    isExporting.value = false;
  }
}

function dialogEnter() {
  backupFields.value = [...BackupFields];
}

// 原生 a-modal 没有 afterOpenChange（只有 afterClose），打开时的初始化自行监听 open。
// immediate：OPTIONSSETTINGS-3 给确定按钮加了「一项都不勾选就禁用」的守卫，若挂载时弹窗已经是打开状态
// 而这里不初始化，勾选项会是空的、导出再也点不动 —— 首帧就补一次。
watch(
  showDialog,
  (open) => {
    if (open) nextTick(dialogEnter);
  },
  { immediate: true },
);
</script>

<template>
  <!-- OPTIONSSETTINGS-3：一项都没勾选时导出的 zip 只有 manifest，禁用确定而不是静默产出空备份 -->
  <a-modal
    v-model:open="showDialog"
    :cancel-text="t('common.dialog.cancel')"
    :confirm-loading="isExporting"
    :ok-button-props="{ disabled: backupFields.length === 0 }"
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
