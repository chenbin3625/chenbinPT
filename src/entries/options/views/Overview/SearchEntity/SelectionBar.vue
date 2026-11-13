<script setup lang="ts">
import { CheckCircleFilled, CloseOutlined, HddOutlined } from "@ant-design/icons-vue";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useDisplay } from "@/options/composables/useDisplay.ts";

import { getTorrentVolumeFactors } from "@ptd/site";

import { formatSize } from "@/options/utils.ts";
import { useConfigStore } from "@/options/stores/config.ts";
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
const configStore = useConfigStore();

const totalSize = computed(() => selectedTorrents.reduce((sum, torrent) => sum + (torrent.size || 0), 0));

/**
 * 计费体积：按下载量系数折算后的实际下载流量（系数未知时按 1 计，即与总大小一致）。
 *
 * 与上游 QuickFilterNotice 的「计费体积」等价：选片时用户真正关心的是「这一批会记多少下载」，
 * 而 `totalSize` 在 50%/免费种子占比高时会明显高估。
 */
const billableSize = computed(() =>
  selectedTorrents.reduce((sum, torrent) => {
    const { downloadVolumeFactor } = getTorrentVolumeFactors(torrent);
    return sum + (torrent.size || 0) * (downloadVolumeFactor ?? 1);
  }, 0),
);

/** 「不显示」模式下连计费体积也一起隐藏（它同样是优惠系数的折算结果） */
const showBillableSize = computed(() => configStore.searchEntifyControl.promotionDisplay !== "none");

// 操作条固定在视口底部（列表滚动时始终可见），因此不能用 sticky：
// #ptd-main 是列表的滚动容器（自身滚动、高度固定），sticky 会跟着滚动内容走。
// 这里用 #ptd-main 的内容盒边界做定位，随左侧导航折叠/断点变化自动跟随，避免写死 220/64 等宽度。
//
// 右边界取 `rect.left + clientWidth` 而不是 `rect.right`：滚动条现在在 #ptd-main **内部**
// （`overflow: auto`），`rect.right` 等于视口右缘，用它算出的 right 会少掉一个滚动条宽度，
// 操作条会压到滚动条上并向右多伸出约 15px。
const insets = ref({ bottom: "16px", left: "16px", right: "16px" });

function syncInsets() {
  const main = document.getElementById("ptd-main");
  if (!main) return;
  const rect = main.getBoundingClientRect();
  const style = getComputedStyle(main);
  const padding = (value: string) => Number.parseFloat(value) || 0;
  const contentRight = rect.left + main.clientWidth;
  insets.value = {
    bottom: `${padding(style.paddingBottom) || 16}px`,
    left: `${rect.left + padding(style.paddingLeft)}px`,
    right: `${Math.max(window.innerWidth - contentRight + padding(style.paddingRight), 0)}px`,
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

    <template v-if="showBillableSize && billableSize !== totalSize">
      <a-divider class="ptd-selection-bar__divider" type="vertical"></a-divider>
      <span class="ptd-selection-bar__info ptd-secondary-text" :title="t('SearchEntity.index.billableSizeHint')">
        {{ t("SearchEntity.index.billableSize", [formatSize(billableSize)]) }}
      </span>
    </template>

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
