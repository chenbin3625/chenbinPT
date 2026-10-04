import { createApp } from "vue";
import "ant-design-vue/dist/reset.css";
import App from "./App.vue";

// Vue Plugins
import { antdInstance as antd } from "./plugins/antd";
import { piniaInstance as pinia } from "./plugins/pinia";
import { routerInstance as router } from "./plugins/router";
import { i18nInstance as i18n } from "./plugins/i18n";
import { installResizeObserverLoopErrorFilter } from "./resizeObserverErrorFilter.ts";
// NOTE(P2-2)：vue-konva / konva 只在懒加载的 UserDataTimeline 路由中使用，
// 不再在这里静态 import + app.use（否则会被打进 options 入口 chunk）。改由该组件局部注册。

installResizeObserverLoopErrorFilter();

const app = createApp(App);

/**
 * v-scroll：在窗口滚动时调用 binding.value。
 *
 * 为什么固定在 window 上，而不是像 Vuetify 的 v-scroll 那样自动寻找可滚动祖先（以及为什么不能用元素滚动）：
 * - options 页面的滚动容器是 document/body：#ptd 与 .ant-layout 都只有 min-height（style.css:19-22），
 *   #ptd-main 的 `overflow: auto` 因其高度同样由内容撑开而**永远不会产生元素级滚动**（scrollTop 恒为 0）。
 * - 唯一调用点 `views/Overview/MediaServerEntity/Index.vue` 的 `onScroll` 也是按页面滚动来判断的
 *   （`window.innerHeight + window.scrollY >= document.body.offsetHeight - 50`）。
 *   监听挂在元素上时该元素从不触发 scroll，因而「滚动加载更多」永远不会执行（style-layout-audit G-09）。
 * - 挂在 window 上时 `event.currentTarget === window`（不是 HTMLElement），恰好吃到调用点的 window 分支。
 */
// 记录每个元素当前注册的回调，避免 updated/unmounted 时移除错回调或重复注册
const scrollHandlers = new WeakMap<HTMLElement, EventListener>();

app.directive("scroll", {
  mounted(el, binding) {
    const handler = binding.value as EventListener;
    scrollHandlers.set(el, handler);
    window.addEventListener("scroll", handler, { passive: true });
  },
  updated(el, binding) {
    const previous = scrollHandlers.get(el);
    const handler = binding.value as EventListener;
    if (previous === handler) return; // 回调未变化，避免重复注册
    if (previous) {
      window.removeEventListener("scroll", previous);
    }
    scrollHandlers.set(el, handler);
    window.addEventListener("scroll", handler, { passive: true });
  },
  unmounted(el) {
    const handler = scrollHandlers.get(el);
    if (handler) {
      window.removeEventListener("scroll", handler);
    }
    scrollHandlers.delete(el);
  },
});

app.use(pinia).use(i18n).use(router).use(antd).mount("#app");
