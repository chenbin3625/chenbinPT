<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { cloneDeep } from "es-toolkit";

import { useMetadataStore } from "@/options/stores/metadata.ts";
import { useRuntimeStore } from "@/options/stores/runtime.ts";
import type { IDownloaderMetadata, TDownloaderKey } from "@/shared/types.ts";

import Editor from "./Editor.vue";

const showDialog = defineModel<boolean>();
const { clientId } = defineProps<{
  clientId: TDownloaderKey;
}>();
const clientConfig = ref<IDownloaderMetadata>();
// F2-Medium-03：编辑已有下载器同样要持续校验，校验不通过时「确定」禁用。
const isFormValid = ref<boolean>(false);

const { t } = useI18n();
const metadataStore = useMetadataStore();
const runtimeStore = useRuntimeStore();

function dialogEnter() {
  if (clientId) {
    // H-1（与 V-17 同一坑）：这里**不能**命令式 `isFormValid.value = false`。
    // 子 Editor 的校验是 `watch(formValid, emit, { immediate: true })`，只在 computed 值
    // **变化**时 emit：第二次打开时新配置与旧配置同样合法（true → true）不会再次 emit，
    // 而父组件的 false 再也等不到 update:config-valid=true → 「确定」永久禁用。
    // 表单有效性完全交给 Editor 的持续校验驱动（打开时配置合法则沿用上一次的 true，
    // 配置非法时 formValid 变为 false 并 emit）。详见 SetSite/Editor.vue 的 V-17 注释。
    // 必须深拷贝：feature / advanceAddTorrentOptions 等嵌套对象若与 store 共用引用，
    // 编辑会实时改写 store，导致「取消」不回滚，且列表页下一次保存会把半途输入的凭据落盘。
    clientConfig.value = cloneDeep({
      sortIndex: 100,
      advanceAddTorrentOptions: {},
      ...metadataStore.downloaders[clientId],
    });
  }
}

async function editClientConfig() {
  if (!isFormValid.value) return;
  try {
    await metadataStore.addDownloader(clientConfig.value as IDownloaderMetadata);
    showDialog.value = false;
  } catch {
    runtimeStore.showSnakebar(t("common.saveFailed"), { color: "error" });
  }
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
    :ok-button-props="{ disabled: !isFormValid }"
    :ok-text="t('common.dialog.ok')"
    :title="t('SetDownloader.edit.title')"
    :width="800"
    @ok="editClientConfig"
  >
    <Editor v-model="clientConfig" @update:config-valid="(v: boolean) => (isFormValid = v)" />
  </a-modal>
</template>
