<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import { useMetadataStore } from "@/options/stores/metadata.ts";
import { useRuntimeStore } from "@/options/stores/runtime.ts";
import { formatDate } from "@/options/utils.ts";
import { getSearchSolutionDisplayName } from "./utils/planName.ts";

const { t } = useI18n();

const showDialog = defineModel<boolean>();

const metadataStore = useMetadataStore();
const runtimeStore = useRuntimeStore();

// 默认快照名（只用于生成初值）
const defaultSnapshotName = computed(
  () =>
    "[" +
    getSearchSolutionDisplayName(runtimeStore.search.searchPlanKey, (key) => metadataStore.getSearchSolutionName(key)) +
    "] " +
    runtimeStore.search.searchKey +
    " (" +
    formatDate(runtimeStore.search.startAt) +
    ")",
);

// 必须是可写状态：模板用 v-model 绑定，只读 computed 会让用户输入被静默丢弃
const snapshotName = ref<string>(defaultSnapshotName.value);

// F10：空名称会让快照列表出现无法辨认的空白行，保存前必须 trim，空则不允许保存
const normalizedSnapshotName = computed(() => snapshotName.value.trim());

// 每次打开对话框都用当前搜索结果重置默认名，避免沿用上一次编辑后的旧值
watch(showDialog, (visible) => {
  if (visible) {
    snapshotName.value = defaultSnapshotName.value;
  }
});

function saveSearchSnapshotData() {
  const name = normalizedSnapshotName.value;
  if (!name) return;

  metadataStore.saveSearchSnapshotData(name);
  showDialog.value = false;
}
</script>

<template>
  <a-modal v-model:open="showDialog" :title="t('SearchEntity.index.action.saveSnapshot')" :width="500">
    <a-form-item :label="t('SearchEntity.SaveSnapshotDialog.snapshotName')"
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
