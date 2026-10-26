<script setup lang="ts">
/**
 * 观看状态图标（调研 A6）。
 *
 * 上游用 `mdi-circle-slice-N` 七档切片表示进度；本仓库不再使用 MDI，改为：
 * 看完 → 勾；看了一部分 → 按百分比填充的小圆环；未观看 → 减号圆圈（与原先的「未看」图标一致）。
 */
import { CheckOutlined, MinusCircleOutlined } from "@ant-design/icons-vue";
import { computed } from "vue";
import { getPlayedState } from "@ptd/mediaServer";

const {
  percent,
  isPlayed,
  size = 14,
} = defineProps<{
  percent?: number;
  isPlayed?: boolean;
  /** 图标尺寸（px），圆环与图标保持同一大小 */
  size?: number;
}>();

const state = computed(() => getPlayedState(percent, isPlayed));
</script>

<template>
  <CheckOutlined v-if="state === 'played'" :style="{ color: 'var(--ptd-success)', fontSize: `${size}px` }" />
  <a-progress
    v-else-if="state === 'partial'"
    :percent="percent"
    :show-info="false"
    :size="size"
    :stroke-width="16"
    stroke-color="var(--ptd-success)"
    style="line-height: 1; vertical-align: -0.125em"
    type="circle"
  />
  <MinusCircleOutlined v-else :style="{ color: 'var(--ptd-success)', fontSize: `${size}px` }" />
</template>
