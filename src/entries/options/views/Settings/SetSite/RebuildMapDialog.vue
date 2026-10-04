<script setup lang="ts">
import { computed, nextTick, watch } from "vue";
import { useI18n } from "vue-i18n";

import { useMetadataStore } from "@/options/stores/metadata.ts";
import { useResetableRef } from "@/options/directives/useResetableRef.ts";

const showDialog = defineModel<boolean>();

const { t } = useI18n();

const { ref: reBuildControlRef, reset: resetReBuildControlRef } = useResetableRef(() => ({
  rebuildSiteHostMap: true,
  rebuildSiteNameMap: false,
}));

async function doReBuild() {
  const metadataStore = useMetadataStore();

  if (reBuildControlRef.value.rebuildSiteHostMap) {
    await metadataStore.buildSiteHostMap();
  }

  if (reBuildControlRef.value.rebuildSiteNameMap) {
    await metadataStore.buildSiteNameMap();
  }

  await metadataStore.$save();
  showDialog.value = false;
}

const canReBuild = computed<boolean>(() => Object.values(reBuildControlRef.value).some(Boolean));

function dialogEnter() {
  resetReBuildControlRef();
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
    :ok-button-props="{ disabled: !canReBuild }"
    :ok-text="t('SetSite.ReBuildMapDialog.doRebuildBtn')"
    :title="t('SetSite.ReBuildMapDialog.title')"
    :width="600"
    @ok="doReBuild"
  >
    <a-flex align="center" :gap="8" style="margin-bottom: 8px">
      <a-switch v-model:checked="reBuildControlRef.rebuildSiteHostMap" />
      <a-typography-text>{{ t("SetSite.ReBuildMapDialog.rebuildSiteHostMap") }}</a-typography-text>
    </a-flex>

    <a-flex align="center" :gap="8">
      <a-switch v-model:checked="reBuildControlRef.rebuildSiteNameMap" />
      <a-typography-text>{{ t("SetSite.ReBuildMapDialog.rebuildSiteNameMap") }}</a-typography-text>
    </a-flex>
  </a-modal>
</template>
