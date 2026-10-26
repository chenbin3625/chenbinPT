<script setup lang="ts">
import { useIntersectionObserver } from "@vueuse/core";
import { ref, shallowRef } from "vue";

/**
 * 进入视口（含 rootMargin 预读区）后才挂载插槽内容，挂载后不再卸载（对应 Vuetify 的 v-lazy）。
 *
 * 用于一次列出数百张卡片的场景：未进入视口的卡片只占一个 `minHeight` 高的占位，
 * 既省去首屏的挂载开销，也避免卡片里的子组件（例如 SiteFavicon）一次性发出数百个请求。
 * 不支持 IntersectionObserver 的环境直接挂载，保证内容总能显示出来。
 */
const { minHeight = 0, rootMargin = "200px" } = defineProps<{
  /** 挂载前占位的最小高度（px），避免懒加载过程中滚动条来回抖动 */
  minHeight?: number;
  rootMargin?: string;
}>();

const placeholderRef = ref<HTMLElement | null>(null);
const isMounted = shallowRef(false);

const { isSupported, stop } = useIntersectionObserver(
  placeholderRef,
  (entries) => {
    if (entries.some((entry) => entry.isIntersecting)) {
      isMounted.value = true;
      stop();
    }
  },
  { rootMargin },
);

if (!isSupported.value) {
  isMounted.value = true;
}
</script>

<template>
  <slot v-if="isMounted" />
  <div v-else ref="placeholderRef" :style="{ minHeight: `${minHeight}px` }" aria-hidden="true" />
</template>
