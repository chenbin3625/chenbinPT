<script setup lang="ts">
import { computed, type Component } from "vue";

import { useDisplay } from "@/options/composables/useDisplay.ts";

const {
  disabled = false,
  icon,
  text,
  color,
} = defineProps<{
  /** antd 图标组件（如 `PlusOutlined`） */
  icon?: Component | null;
  text: string;
  /** 历史 Vuetify 调色板名（primary/success/green/error/red/info/...），映射为 antd 按钮语义 */
  color?: string;
  disabled?: boolean;
}>();

/** 窄屏（<840px）只显示图标：按钮压缩为 32×32 方形，文案交给 title/aria-label */
const display = useDisplay();
const iconOnly = display.smAndDown;

const buttonType = computed<"primary" | "default">(() =>
  ["primary", "success", "green"].includes(color ?? "") ? "primary" : "default",
);
const isDanger = computed(() => ["error", "red"].includes(color ?? ""));
</script>

<template>
  <a-button
    :danger="isDanger"
    :disabled="disabled"
    :style="iconOnly ? { width: '32px', paddingInline: 0 } : undefined"
    :title="text"
    :type="buttonType"
  >
    <template v-if="icon" #icon>
      <component :is="icon" />
    </template>
    <span v-if="!iconOnly">{{ text }}</span>
  </a-button>
</template>
