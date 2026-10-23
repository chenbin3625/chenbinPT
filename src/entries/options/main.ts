import { createApp } from "vue";
import { message } from "ant-design-vue";
import "ant-design-vue/dist/reset.css";
import App from "./App.vue";

// Vue Plugins
import { antdInstance as antd } from "./plugins/antd";
import { piniaInstance as pinia } from "./plugins/pinia";
import { routerInstance as router } from "./plugins/router";
import { i18nInstance as i18n } from "./plugins/i18n";
import { installResizeObserverLoopErrorFilter } from "./resizeObserverErrorFilter.ts";
import { sendMessage } from "@/messages.ts";
// NOTE(P2-2)：vue-konva / konva 只在懒加载的 UserDataTimeline 路由中使用，
// 不再在这里静态 import + app.use（否则会被打进 options 入口 chunk）。改由该组件局部注册。

installResizeObserverLoopErrorFilter();

/**
 * F1-09：options 入口的全局错误兜底。
 *
 * 修复前这里没有任何 `app.config.errorHandler` / `unhandledrejection` 处理：
 * 扩展升级/重载后旧页面继续运行、懒加载路由 chunk 404、某个 `onMounted` 里的 `await` 抛错……
 * 用户侧的统一表现都是「点了没反应 / 页面空白」，只有 DevTools 里有一条未捕获异常，
 * 没有任何提示告诉用户「刷新页面即可」。
 *
 * 现在的行为（不改变正常语义）：
 * - 错误写进扩展日志（`logger` 消息 → offscreen 的日志面板），便于事后排查；
 * - 最多每 10s 弹一次通用错误提示（避免懒加载失败等场景把提示刷爆）；
 * - 绝不因为「记录/提示失败」再抛出异常（扩展上下文失效时 sendMessage 会 reject）。
 */
const GLOBAL_ERROR_TOAST_INTERVAL = 10_000;
let lastGlobalErrorToastAt = 0;

function reportGlobalError(error: unknown, source: "vue" | "unhandledrejection" | "router") {
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error ?? "");
  const stack = error instanceof Error ? error.stack : undefined;

  void sendMessage("logger", { level: "error", module: `options/${source}`, msg: detail, data: { stack } }).catch(
    () => undefined,
  );

  const now = Date.now();
  if (now - lastGlobalErrorToastAt < GLOBAL_ERROR_TOAST_INTERVAL) return;
  lastGlobalErrorToastAt = now;

  // 文案 key 由 G 在 locales 里补充（见 fix report）；缺失时退化为 common.unknown，不影响功能。
  const title = i18n.global.te("common.unexpectedError")
    ? i18n.global.t("common.unexpectedError")
    : i18n.global.t("common.unknown");
  const hint = i18n.global.te("common.refreshPageHint") ? ` ${i18n.global.t("common.refreshPageHint")}` : "";
  const toastText = `${title}${hint}${detail ? `: ${detail.slice(0, 160)}` : ""}`;

  try {
    message.error(toastText);
  } catch {
    // 提示层不可用（样式尚未注入 / 上下文失效）时静默：记录已经发往扩展日志
  }
}

window.addEventListener("unhandledrejection", (event) => {
  reportGlobalError(event.reason, "unhandledrejection");
});

const app = createApp(App);

app.config.errorHandler = (error) => {
  reportGlobalError(error, "vue");
};

// 懒加载路由 chunk 失败（例如扩展更新后旧 chunk URL 失效）也要提示，而不是静默无反应
router.onError((error) => {
  reportGlobalError(error, "router");
});

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
    if (typeof handler !== "function") return;
    scrollHandlers.set(el, handler);
    window.addEventListener("scroll", handler, { passive: true });
  },
  updated(el, binding) {
    const previous = scrollHandlers.get(el);
    const handler = binding.value as EventListener;
    if (typeof handler !== "function") return;
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
