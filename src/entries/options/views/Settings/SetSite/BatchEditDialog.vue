<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { TSiteID } from "@ptd/site";

import { useMetadataStore } from "@/options/stores/metadata.ts";
import { useRuntimeStore } from "@/options/stores/runtime.ts";

const showDialog = defineModel<boolean>();
const props = defineProps<{
  siteIds: TSiteID[];
}>();

const { t } = useI18n();
const metadataStore = useMetadataStore();
const runtimeStore = useRuntimeStore();

type TTriState = "keep" | "true" | "false";

const addGroups = ref<string[]>([]);
const removeGroups = ref<string[]>([]);
const allowSearchState = ref<TTriState>("keep");
const allowQueryUserInfoState = ref<TTriState>("keep");
const isOfflineState = ref<TTriState>("keep");
const saving = ref(false);

const existingGroups = computed(() =>
  Object.keys(metadataStore.getSitesGroupData).map((g) => ({ label: g, value: g })),
);

const triStateOptions = computed(() => [
  { label: t("SetSite.batchEdit.keep"), value: "keep" },
  { label: t("SetSite.batchEdit.enable"), value: "true" },
  { label: t("SetSite.batchEdit.disable"), value: "false" },
]);

watch(showDialog, (open) => {
  if (open) {
    addGroups.value = [];
    removeGroups.value = [];
    allowSearchState.value = "keep";
    allowQueryUserInfoState.value = "keep";
    isOfflineState.value = "keep";
  }
});

async function submit() {
  if (props.siteIds.length === 0 || saving.value) return;
  saving.value = true;
  try {
    let updated = 0;
    const toAdd = addGroups.value.map((g) => g.trim()).filter(Boolean);
    const toRemove = new Set(removeGroups.value);

    for (const siteId of props.siteIds) {
      const site = metadataStore.sites[siteId];
      if (!site) continue;

      if (toAdd.length > 0 || toRemove.size > 0) {
        const nextGroups = new Set((site.groups ?? []).filter((g) => !toRemove.has(g)));
        for (const g of toAdd) nextGroups.add(g);
        site.groups = Array.from(nextGroups);
      }

      if (allowSearchState.value !== "keep") {
        site.allowSearch = allowSearchState.value === "true";
      }
      if (allowQueryUserInfoState.value !== "keep") {
        site.allowQueryUserInfo = allowQueryUserInfoState.value === "true";
      }
      if (isOfflineState.value !== "keep") {
        site.isOffline = isOfflineState.value === "true";
      }
      updated += 1;
    }

    await metadataStore.$save();
    runtimeStore.showSnackbar(t("SetSite.batchEdit.success", { count: updated }), { color: "success" });
    showDialog.value = false;
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <a-modal
    v-model:open="showDialog"
    :title="t('SetSite.batchEdit.title', { count: siteIds.length })"
    :width="560"
    :confirm-loading="saving"
    @ok="submit"
  >
    <a-form layout="vertical">
      <a-form-item :label="t('SetSite.batchEdit.addGroups')">
        <a-select
          v-model:value="addGroups"
          mode="tags"
          :options="existingGroups"
          :placeholder="t('SetSite.batchEdit.addGroupsPlaceholder')"
          allow-clear
        />
      </a-form-item>

      <a-form-item :label="t('SetSite.batchEdit.removeGroups')">
        <a-select
          v-model:value="removeGroups"
          mode="multiple"
          :options="existingGroups"
          :placeholder="t('SetSite.batchEdit.removeGroupsPlaceholder')"
          allow-clear
        />
      </a-form-item>

      <a-row :gutter="12">
        <a-col :span="8">
          <a-form-item :label="t('SetSite.common.allowSearch')">
            <a-select v-model:value="allowSearchState" :options="triStateOptions" />
          </a-form-item>
        </a-col>
        <a-col :span="8">
          <a-form-item :label="t('SetSite.common.allowQueryUserInfo')">
            <a-select v-model:value="allowQueryUserInfoState" :options="triStateOptions" />
          </a-form-item>
        </a-col>
        <a-col :span="8">
          <a-form-item :label="t('SetSite.common.isOffline')">
            <a-select v-model:value="isOfflineState" :options="triStateOptions" />
          </a-form-item>
        </a-col>
      </a-row>
    </a-form>
  </a-modal>
</template>
