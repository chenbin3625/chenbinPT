<script setup lang="ts">
import { ArrowDownOutlined, ArrowUpOutlined } from "@ant-design/icons-vue";
import { onLongPress } from "@vueuse/core";
import { ref, type ComponentPublicInstance } from "vue";

/**
 * 站点优先级快捷排序按钮：短按（点击）移动一位，长按移至最前 / 最后。
 *
 * 两种操作都由 onLongPress 的 pointer 事件驱动：
 * · 长按 → handler，移至最前 / 最后；
 * · 短按 → onMouseUp 的 !isLongPress 分支，移动一位；
 * · `modifiers.prevent` 挡掉浏览器在触摸释放时补发的兼容 click，避免「长按完又被当成一次点击」。
 * 键盘（Enter / Space）激活不会产生 pointer 事件，只会触发 click（`detail === 0`），单独走移动一位。
 */
const { direction, disabled = false } = defineProps<{
  direction: "up" | "down";
  disabled?: boolean;
  title: string;
}>();

const emit = defineEmits<{
  move: [position: "up" | "down" | "top" | "bottom"];
}>();

/** 短按与长按的分界（ms） */
const LONG_PRESS_DELAY = 600;

const buttonRef = ref<ComponentPublicInstance | null>(null);

onLongPress(
  buttonRef,
  () => {
    if (!disabled) emit("move", direction === "up" ? "top" : "bottom");
  },
  {
    delay: LONG_PRESS_DELAY,
    modifiers: { prevent: true },
    onMouseUp: (_duration, _distance, isLongPress) => {
      if (!isLongPress && !disabled) emit("move", direction);
    },
  },
);

function onClick(event: MouseEvent) {
  // 指针点击已由上面的 pointer 事件处理，这里只处理键盘激活
  if (event.detail === 0 && !disabled) emit("move", direction);
}
</script>

<template>
  <a-tooltip :title="title">
    <a-button ref="buttonRef" :aria-label="title" :disabled="disabled" size="small" @click="onClick">
      <template #icon>
        <ArrowUpOutlined v-if="direction === 'up'" />
        <ArrowDownOutlined v-else />
      </template>
    </a-button>
  </a-tooltip>
</template>
