<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
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

// F10：空名称会写入一条无法辨认的空白快照名，保存前 trim，空则不允许保存
const normalizedSnapshotName = computed(() => snapshotName.value.trim());

function saveSearchSnapshotData() {
  const name = normalizedSnapshotName.value;
  if (!name) return;

  metadataStore.editSearchSnapshotDataName(props.editId, name);
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
      ><a-input v-model:value="snapshotName" :maxlength="200"></a-input
    ></a-form-item>

    <template #footer>
      <a-flex align="center" justify="flex-end">
        <a-button type="primary" :disabled="!normalizedSnapshotName" @click="saveSearchSnapshotData">{{
          t("common.save")
        }}</a-button>
      </a-flex>
    </template>
  </a-modal>
</template>
