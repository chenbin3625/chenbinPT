<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { cloneDeep } from "es-toolkit";

import { useMetadataStore } from "@/options/stores/metadata.ts";
import { useRuntimeStore } from "@/options/stores/runtime.ts";
import type { IMediaServerMetadata, TMediaServerKey } from "@/shared/types.ts";

import Editor from "./Editor.vue";

const showDialog = defineModel<boolean>();
const { clientId } = defineProps<{
  clientId: TMediaServerKey;
}>();

const clientConfig = ref<IMediaServerMetadata>();
// F2-Medium-15：编辑已有媒体服务器同样持续校验；校验不通过时「确定」禁用。
const isFormValid = ref<boolean>(false);
const { t } = useI18n();
const metadataStore = useMetadataStore();
const runtimeStore = useRuntimeStore();

function dialogEnter() {
  if (clientId) {
    // H-1（V-17 同坑）：命令式置 false 会让第二次打开时的「确定」永久禁用 ——
    // Editor 的 `watch(formValid)` 只在值变化时 emit，true → true 不会再发
    // update:config-valid=true。表单有效性完全由 Editor 的持续校验驱动。
    // 必须深拷贝：auth 等嵌套对象若与 store 共用引用，编辑会实时改写 store，
    // 导致「取消」不回滚，且列表页下一次保存会把半途输入的凭据落盘。
    clientConfig.value = cloneDeep(metadataStore.mediaServers[clientId]);
  }
}

async function editClientConfig() {
  if (!isFormValid.value) return;
  try {
    await metadataStore.addMediaServer(clientConfig.value as IMediaServerMetadata);
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
    :title="t('SetMediaServer.edit.title')"
    :width="800"
    @ok="editClientConfig"
  >
    <Editor v-model="clientConfig" @update:config-valid="(v: boolean) => (isFormValid = v)" />
  </a-modal>
</template>
