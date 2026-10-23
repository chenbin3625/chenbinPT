<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import type { CTorrent } from "@ptd/downloader";

const showDialog = defineModel<boolean>();
const { torrentCount, torrents, confirmFn } = defineProps<{
  torrentCount: number;
  // D2-07：确认框列出将被重新校验的对象（批量操作不能只靠数量确认）
  torrents?: CTorrent[];
  confirmFn: () => Promise<void> | void;
}>();

const { t } = useI18n();

const isRechecking = ref(false);

const TITLE_PREVIEW_LIMIT = 100;
const torrentTitles = computed(() => (torrents ?? []).slice(0, TITLE_PREVIEW_LIMIT).map((torrent) => torrent.name));
const hasMoreTitles = computed(() => (torrents?.length ?? 0) > TITLE_PREVIEW_LIMIT);

async function confirmRecheck() {
  if (isRechecking.value) return;
  isRechecking.value = true;
  try {
    await confirmFn();
  } finally {
    isRechecking.value = false;
    showDialog.value = false;
  }
}

function dialogEnter() {
  isRechecking.value = false;
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
    :confirm-loading="isRechecking"
    :keyboard="!isRechecking"
    :mask-closable="!isRechecking"
    :ok-text="t('common.dialog.ok')"
    :title="t('MyClient.recheckDialog.title')"
    :width="420"
    @ok="confirmRecheck"
  >
    <div style="font-size: 16px">
      {{ t("MyClient.recheckDialog.text", { count: torrentCount }) }}
    </div>
    <div v-if="torrentTitles.length > 0" class="my-client-recheck-list">
      <div v-for="(title, index) in torrentTitles" :key="index" :title="title">{{ title }}</div>
      <div v-if="hasMoreTitles">…</div>
    </div>
  </a-modal>
</template>

<style scoped>
.my-client-recheck-list {
  max-height: 160px;
  margin: 8px 0 0;
  overflow-y: auto;
  word-break: break-all;
}

.my-client-recheck-list > div {
  position: relative;
  padding-left: 14px;
}

.my-client-recheck-list > div::before {
  content: "•";
  position: absolute;
  left: 2px;
}
</style>
