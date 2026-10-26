<script lang="ts" setup>
import { nextTick, provide, ref, useTemplateRef, watch } from "vue";
import { useI18n } from "vue-i18n";
import { cloneDeep } from "es-toolkit";
import { type ISiteUserConfig, type TSiteID } from "@ptd/site";

import { useMetadataStore } from "@/options/stores/metadata.ts";
import { useRuntimeStore } from "@/options/stores/runtime.ts";

import Editor from "./Editor.vue";

const showDialog = defineModel<boolean>();
const props = defineProps<{
  siteId: TSiteID;
}>();

const { t } = useI18n();
const metadataStore = useMetadataStore();
const runtimeStore = useRuntimeStore();

const isFormValid = ref<boolean>(false);
const isSaving = ref(false);

const storedSiteUserConfig = ref<ISiteUserConfig & { valid?: boolean }>({ valid: false });
provide("storedSiteUserConfig", storedSiteUserConfig);

const editorRef = useTemplateRef<{ resetLocalState?: () => void }>("editor");

async function patchSite() {
  if (!isFormValid.value || isSaving.value) return;
  isSaving.value = true;
  try {
    await metadataStore.addSite(props.siteId, storedSiteUserConfig.value);
    showDialog.value = false;
  } catch {
    runtimeStore.showSnakebar(t("common.saveFailed"), { color: "error" });
  } finally {
    isSaving.value = false;
  }
}

function dialogEnter() {
  // OPTIONSSETTINGS-1：必须深拷贝。merge/inputSetting 等嵌套对象若与 store 共用引用，
  // 对话框内编辑会实时改写 store（点「取消」不回滚），且之后任一次 $save() 会把改动落盘。
  storedSiteUserConfig.value = cloneDeep({
    valid: false,
    ...(metadataStore.sites[props.siteId] ?? {}),
  });
  // F2-Low-08：Editor 实例会被复用，重置它上一次残留的自定义 URL 草稿 / 明文显示状态，
  // 否则上次未填完的非法自定义 URL 会让本次打开时「确定」直接置灰。
  editorRef.value?.resetLocalState?.();
}

// 原生 a-modal 没有 afterOpenChange（只有 afterClose），打开时的初始化自行监听 open。
watch(showDialog, (open) => {
  if (open) nextTick(dialogEnter);
});
</script>

<template>
  <a-modal
    v-model:open="showDialog"
    :confirm-loading="isSaving"
    :cancel-button-props="{ disabled: isSaving }"
    :closable="!isSaving"
    :keyboard="!isSaving"
    :mask-closable="!isSaving"
    :cancel-text="t('common.dialog.cancel')"
    :ok-button-props="{ disabled: !isFormValid }"
    :ok-text="t('common.dialog.ok')"
    :title="t('SetSite.edit.title')"
    :width="800"
    @ok="patchSite"
  >
    <Editor ref="editor" v-model="props.siteId" @update:form-valid="(v) => (isFormValid = v)" />
  </a-modal>
</template>
