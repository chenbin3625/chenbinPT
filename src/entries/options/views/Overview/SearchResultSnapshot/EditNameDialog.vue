<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import { useMetadataStore } from "@/options/stores/metadata.ts";
import { type TSearchSnapshotKey } from "@/shared/types.ts";

const { t } = useI18n();

const showDialog = defineModel<boolean>();

const props = defineProps<{
  editId: TSearchSnapshotKey;
}>();

const metadataStore = useMetadataStore();
const snapshotName = ref("");

function saveSearchSnapshotData() {
  metadataStore.editSearchSnapshotDataName(props.editId, snapshotName.value);
  showDialog.value = false;
}

function dialogEnter() {
  snapshotName.value = metadataStore.snapshots[props.editId]?.name ?? ""; // 快照可能已在别处被删除
}

// 原生 a-modal 没有 afterOpenChange（只有 afterClose），打开时的初始化自行监听 open。
watch(showDialog, (open) => {
  if (open) nextTick(() => props.editId && dialogEnter());
});
</script>

<template>
  <a-modal
    v-model:open="showDialog"
    :title="t('SearchResultSnapshot.EditNameDialog.title')"
    :width="500"
    :after-close="() => (snapshotName = '')"
  >
    <a-form-item :label="t('SearchResultSnapshot.EditNameDialog.snapshotName')"
      ><a-input v-model:value="snapshotName"></a-input
    ></a-form-item>

    <template #footer>
      <a-flex align="center" justify="flex-end">
        <a-button type="primary" @click="saveSearchSnapshotData">{{ t("common.save") }}</a-button>
      </a-flex>
    </template>
  </a-modal>
</template>
