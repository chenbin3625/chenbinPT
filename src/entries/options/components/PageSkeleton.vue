<script setup lang="ts">
import { computed } from "vue";

/**
 * 通用页面骨架屏。
 *
 * 用途：页面 / 卡片在「首次加载且尚无任何可渲染数据」时占位，避免出现空白内容区
 * （以及数据到位后整块画布高度跳动）。
 *
 * 与 `PtdDataTable` 的 `loading` 属性的分工：
 * - 表格类页面（已有表头 + 分页框架）直接用 `:loading`，由 antd 在表格上盖一层 spin；
 * - 非表格内容（卡片瀑布流、图表、自定义列表）用本组件撑起同尺寸的骨架。
 */
const props = withDefaults(
  defineProps<{
    /** 骨架形态：table 表格 / list 列表 / masonry 卡片瀑布流 / chart 图表 / card 卡片 */
    variant?: "card" | "chart" | "list" | "masonry" | "table";
    /** 重复的骨架块数量（list / masonry 生效） */
    count?: number;
    /** 单个骨架块的段落行数（chart 固定按整个画布高度给行） */
    rows?: number;
    /** 是否渲染标题占位 */
    title?: boolean;
  }>(),
  { variant: "table", count: 1, rows: 6, title: true },
);

const containerStyle = computed(() => {
  switch (props.variant) {
    case "list":
    case "masonry":
      return {
        display: "grid",
        gap: "16px",
        gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
      };
    case "chart":
      return { minHeight: "320px" };
    default:
      return { padding: "8px 0" };
  }
});
</script>

<template>
  <div :style="containerStyle">
    <template v-if="variant === 'masonry' || variant === 'list'">
      <a-skeleton v-for="index in count" :key="index" active :paragraph="{ rows }" :title="title" />
    </template>
    <!-- 图表没有「标题 + 段落」的结构，直接用无标题的多行骨架占满画布高度 -->
    <a-skeleton v-else active :paragraph="{ rows }" :title="variant === 'chart' ? false : title" />
  </div>
</template>
