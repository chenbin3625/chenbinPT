<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { cloneDeep } from "es-toolkit";

import { useMetadataStore } from "@/options/stores/metadata.ts";
import type { IBackupServerMetadata, TBackupServerKey } from "@/shared/types.ts";

import Editor from "./Editor.vue";

const showDialog = defineModel<boolean>();
const { clientId } = defineProps<{
  clientId: TBackupServerKey;
}>();
const clientConfig = ref<IBackupServerMetadata>();

const { t } = useI18n();
const metadataStore = useMetadataStore();

function dialogEnter() {
  if (clientId) {
    // 必须深拷贝：config 等嵌套对象若与 store 共用引用，编辑会实时改写 store，
    // 导致「取消」不回滚，且列表页下一次保存会把半途输入的云存储密钥落盘。
    clientConfig.value = cloneDeep(metadataStore.backupServers[clientId]);
  }
}

function editClientConfig() {
  metadataStore.addBackupServer(clientConfig.value as IBackupServerMetadata);
  showDialog.value = false;
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
    :ok-text="t('common.dialog.ok')"
    :title="t('SetDownloader.edit.title')"
    :width="800"
    @ok="editClientConfig"
  >
    <Editor v-if="clientConfig" v-model="clientConfig" />
  </a-modal>
</template>
