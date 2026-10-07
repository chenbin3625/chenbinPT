<script setup lang="ts">
import { computed, type Component } from "vue";
import { LoadingOutlined } from "@ant-design/icons-vue";

import { useConfigStore } from "@/options/stores/config.ts";

const configStore = useConfigStore();

const {
  title,
  label,
  icon,
  type = "default",
  disabled = false,
  loading = false,
} = defineProps<{
  title: string;
  /** 方形菜单使用的短标签；tooltip 仍显示完整标题 */
  label?: string;
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
    :shape="configStore.contentScript.stackedButtons ? 'square' : 'circle'"
    :class="{ 'ptd-fade-enter': shouldFadeEnter }"
    @click="handleClick"
  >
    <template #icon>
      <LoadingOutlined v-if="loading" />
      <component :is="icon" v-else />
    </template>
    <!-- CONTENTSCRIPT-4：description 必须整体条件化。antd 的告警判据是
         `warning(!(shape === 'circle' && description))`，而 description 取的是「插槽是否存在」：
         把 v-if 放进插槽内部时它仍返回 vnode 数组（truthy），circle 形态下每个按钮都会告警。
         另外 label 只在方形菜单（stackedButtons）下才有意义。

         这里显式传 shape：FloatButtonGroup 只通过 context 把 shape 传给子按钮的样式类，
         子按钮自己的 props.shape 仍是默认 circle，square 菜单下 antd 会据此误报同一条告警。 -->
    <template v-if="configStore.contentScript.stackedButtons" #description>
      <span>{{ label ?? title }}</span>
    </template>
  </a-float-button>
</template>
