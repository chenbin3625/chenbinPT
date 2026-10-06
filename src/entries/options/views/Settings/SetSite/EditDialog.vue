<script lang="ts" setup>
import { nextTick, provide, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
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

const storedSiteUserConfig = ref<ISiteUserConfig & { valid?: boolean }>({ valid: false });
provide("storedSiteUserConfig", storedSiteUserConfig);

async function patchSite() {
  try {
    await metadataStore.addSite(props.siteId, storedSiteUserConfig.value);
    showDialog.value = false;
  } catch {
    runtimeStore.showSnakebar(t("common.saveFailed"), { color: "error" });
  }
}

function dialogEnter() {
  storedSiteUserConfig.value = {
    valid: false,
    ...(metadataStore.sites[props.siteId] ?? {}),
  };
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
    :title="t('SetSite.edit.title')"
    :width="800"
    @ok="patchSite"
  >
    <Editor v-model="props.siteId" @update:form-valid="(v) => (isFormValid = v)" />
  </a-modal>
</template>
