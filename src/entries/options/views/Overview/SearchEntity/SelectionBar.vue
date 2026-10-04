<script setup lang="ts">
import { CheckCircleFilled, CloseOutlined, HddOutlined } from "@ant-design/icons-vue";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useDisplay } from "@/options/composables/useDisplay.ts";

import { formatSize } from "@/options/utils.ts";
import type { ISearchResultTorrent } from "@/shared/types/storages/runtime.ts";

import ActionTd from "./ActionTd.vue";

const { selectedTorrents } = defineProps<{
  selectedTorrents: ISearchResultTorrent[];
}>();

const emit = defineEmits<{
  (e: "clear"): void;
}>();

const { t } = useI18n();
const display = useDisplay();

const totalSize = computed(() => selectedTorrents.reduce((sum, torrent) => sum + (torrent.size || 0), 0));

// 操作条固定在视口底部（页面滚动时始终可见），因此不能用 sticky：
// #ptd-main 带 overflow: auto，是 sticky 的滚动容器且自身从不滚动（高度由内容撑开）。
// 这里用 #ptd-main 的实际内边界做定位，随左侧导航折叠/断点变化自动跟随，避免写死 220/64 等宽度。
const insets = ref({ bottom: "16px", left: "16px", right: "16px" });

function syncInsets() {
  const main = document.getElementById("ptd-main");
  if (!main) return;
  const rect = main.getBoundingClientRect();
  const style = getComputedStyle(main);
  const padding = (value: string) => Number.parseFloat(value) || 0;
  insets.value = {
    bottom: `${padding(style.paddingBottom) || 16}px`,
    left: `${rect.left + padding(style.paddingLeft)}px`,
    right: `${Math.max(window.innerWidth - rect.right + padding(style.paddingRight), 0)}px`,
  };
}

let observer: ResizeObserver | undefined;
let syncFrame = 0;

function scheduleSyncInsets() {
  if (syncFrame) return;
  syncFrame = window.requestAnimationFrame(() => {
    syncFrame = 0;
    syncInsets();
  });
}

onMounted(() => {
  syncInsets();
  observer = new ResizeObserver(scheduleSyncInsets);
  const main = document.getElementById("ptd-main");
  if (main) observer.observe(main);
  window.addEventListener("resize", scheduleSyncInsets);
});

onBeforeUnmount(() => {
  observer?.disconnect();
  window.removeEventListener("resize", scheduleSyncInsets);
  if (syncFrame) {
    window.cancelAnimationFrame(syncFrame);
    syncFrame = 0;
  }
});
</script>

<template>
  <!-- 多选操作条：仅在选中种子后出现，不使用 alert 样式，固定在页面（视口）底部 -->
  <div v-if="selectedTorrents.length > 0" :style="insets" class="ptd-selection-bar">
    <span class="ptd-selection-bar__info">
      <CheckCircleFilled />
      {{ t("SearchEntity.index.selectedTorrents", [selectedTorrents.length]) }}
    </span>

    <a-divider class="ptd-selection-bar__divider" type="vertical"></a-divider>

    <span class="ptd-selection-bar__info ptd-selection-bar__size ptd-secondary-text">
      <HddOutlined />
      {{ t("SearchEntity.index.totalSize", [formatSize(totalSize)]) }}
    </span>

    <a-divider class="ptd-selection-bar__divider" type="vertical"></a-divider>

    <!-- 窄屏（<840px）操作条宽度有限，批量按钮退回图标 + tooltip，避免换行成一整块 -->
    <ActionTd :show-label="!display.smAndDown.value" :torrent-items="selectedTorrents" variant="bar" />

    <div class="ptd-selection-bar__spacer"></div>

    <a-button :title="t('SearchEntity.index.clearSelection')" @click="emit('clear')" type="text" danger
      ><template #icon><CloseOutlined /></template>
      {{ t("SearchEntity.index.clearSelection") }}
    </a-button>
  </div>
</template>
