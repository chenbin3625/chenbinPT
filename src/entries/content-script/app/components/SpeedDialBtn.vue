<script setup lang="ts">
import { computed, type Component } from "vue";
import { LoadingOutlined } from "@ant-design/icons-vue";

import { useConfigStore } from "@/options/stores/config.ts";

const configStore = useConfigStore();

const {
  title,
  icon,
  type = "default",
  disabled = false,
  loading = false,
} = defineProps<{
  title: string;
  /** 图标组件（如 `HomeOutlined`）；antd 用组件而非 mdi 字符串 */
  icon: Component;
  /** antd FloatButton 只有 default / primary，替代 Vuetify 的 color 调色板 */
  type?: "default" | "primary";
  disabled?: boolean;
  loading?: boolean;
}>();

const emit = defineEmits<{ (e: "click", event: MouseEvent): void }>();

/**
 * 大图标模式（stackedButtons=false）下，未 hover 时半透明、hover 时实心。
 * 原来挂在无定义的 Vuetify 过渡 `fade-transition` 上，现在由 app.css 的 .ptd-fade-enter 提供。
 */
const shouldFadeEnter = computed(
  () => !configStore.contentScript.stackedButtons && configStore.contentScript.fadeEnterStyle,
);

function handleClick(event: MouseEvent) {
  if (disabled || loading) return;
  emit("click", event);
}
</script>

<template>
  <a-float-button
    :type="type"
    :disabled="disabled || loading"
    :tooltip="title"
    :class="{ 'ptd-fade-enter': shouldFadeEnter }"
    @click="handleClick"
  >
    <template #icon>
      <LoadingOutlined v-if="loading" />
      <component :is="icon" v-else />
    </template>
    <template #description>
      <span v-if="configStore.contentScript.stackedButtons">{{ title }}</span>
    </template>
  </a-float-button>
</template>
