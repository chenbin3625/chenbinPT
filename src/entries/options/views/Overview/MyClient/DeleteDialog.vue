<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import type { CTorrent } from "@ptd/downloader";
import BaseDeleteDialog from "@/options/components/DeleteDialog.vue";

const showDialog = defineModel<boolean>();
const props = defineProps<{
  toDeleteIds: string[];
  // D2-07：确认框需要列出「到底要删哪些种子」，不能只显示数量
  torrents?: CTorrent[];
  // N17：部分客户端（Aria2）不支持「同时删除数据」，勾选后必然整批失败 —— 禁用该选项
  removeDataSupported?: boolean;
  // DOWNLOADER-3：confirmDeleteTorrent 会把 deleteClientTorrent 的 boolean 结果带出来（false = 删不掉）
  confirmDelete: (toDeleteId: string, removeData: boolean) => Promise<boolean | void> | void;
}>();
const emits = defineEmits<{
  (e: "allDelete"): void;
}>();

const { t } = useI18n();

const removeData = ref(false);

// 只列出前 100 个标题：批量删除可能选中数千个种子，整表渲染到弹窗里既慢又不可读
const TITLE_PREVIEW_LIMIT = 100;
const torrentTitles = computed(() =>
  (props.torrents ?? []).slice(0, TITLE_PREVIEW_LIMIT).map((torrent) => torrent.name),
);
const hasMoreTitles = computed(() => (props.torrents?.length ?? 0) > TITLE_PREVIEW_LIMIT);

watch(showDialog, (val) => {
  if (val) removeData.value = false;
});

// 所选种子全部来自不支持删除数据的客户端时，强制不勾选（避免走进必然失败的路径）
watch(
  () => props.removeDataSupported,
  (supported) => {
    if (supported === false) removeData.value = false;
  },
  { immediate: true },
);

function wrappedConfirmDelete(id: string) {
  return props.confirmDelete(id, props.removeDataSupported === false ? false : removeData.value);
}
</script>

<template>
  <BaseDeleteDialog
    v-model="showDialog"
    :to-delete-ids="toDeleteIds"
    :confirm-delete="wrappedConfirmDelete"
    @all-delete="emits('allDelete')"
  >
    <template #append-text>
      <!-- D2-07：列出待删除对象，避免「数量对得上、对象不对」的误删 -->
      <div v-if="torrentTitles.length > 0" class="my-client-delete-list">
        <div v-for="(title, index) in torrentTitles" :key="index" :title="title">{{ title }}</div>
        <div v-if="hasMoreTitles">…</div>
      </div>
      <a-checkbox v-model:checked="removeData" :disabled="removeDataSupported === false">{{
        t("MyClient.dialog.removeData")
      }}</a-checkbox>
      <!-- L2（F1）：禁用原因必须可见，否则用户只看到勾选框变灰、不知道是「客户端不支持」 -->
      <div v-if="removeDataSupported === false" class="my-client-delete-unsupported">
        {{ t("MyClient.dialog.removeDataUnsupported") }}
      </div>
    </template>
  </BaseDeleteDialog>
</template>

<style scoped>
.my-client-delete-list {
  max-height: 160px;
  margin: 8px 0;
  overflow-y: auto;
  text-align: left;
  word-break: break-all;
}

.my-client-delete-list > div {
  position: relative;
  padding-left: 14px;
}

.my-client-delete-list > div::before {
  content: "•";
  position: absolute;
  left: 2px;
}

.my-client-delete-unsupported {
  margin-top: 4px;
  color: var(--ptd-text-tertiary);
  font-size: 12px;
  line-height: 1.5;
}
</style>
