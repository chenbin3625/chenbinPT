import appCss from "./app.css?inline";
import antdResetCss from "ant-design-vue/dist/reset.css?inline";
import { ConfigProvider } from "ant-design-vue";
import { StyleProvider } from "ant-design-vue/es/_util/cssinjs";

import { computed, createApp, defineComponent, h } from "vue";
import { message } from "ant-design-vue";

import App from "./App.vue";
import { createRemountGuard } from "./remountGuard.ts";
import { stopRetargetedSelectPointerDown } from "./shadowPopupEvents.ts";
import { syncThemeVarsToHost } from "./themeVars.ts";
import { setClipboardFallbackContainer } from "./utils.ts";
import { piniaInstance as pinia } from "@/options/plugins/pinia.ts";
import { i18nInstance as i18n } from "@/options/plugins/i18n.ts";
import { antdInstance as antd, useAntdConfig } from "@/options/plugins/antd.ts";
import { useConfigStore } from "@/options/stores/config.ts";

/**
 * 重挂载预算：模块级单例，跨 `mountApp()` 的递归调用共享（见 remountGuard.ts 的 L-4 说明）。
 * 一个 content-script 上下文只挂载一个应用实例，因此不需要按 document 区分。
 */
const remountGuard = createRemountGuard();

export function mountApp(document: Document, data: any = {}) {
  // 创建一个全局的 div 并挂载到 body 中，作为 shadow DOM 的挂载点
  const contentRoot = document.createElement("div");
  contentRoot.className = "ptd-content-script-root";
  const shadowRoot = contentRoot.attachShadow({ mode: "closed" });

  // 将 css 的样式添加到 shadow DOM 中
  const baseStyleElement = document.createElement("style");
  baseStyleElement.id = "ptd-content-script-style-base";
  baseStyleElement.textContent = (antdResetCss + "\n" + appCss).replaceAll(":root", ":host");
  shadowRoot.appendChild(baseStyleElement);

  // 图标已全部迁移到 @ant-design/icons-vue（组件内联 svg），
  // 不再往 shadow root 注入额外的图标 webfont（字体文件已从 public/ 移除）。

  // 将构造过程中产生的样式 chenbinpt.css 添加到 shadow DOM 中
  // （cssCodeSplit=false 后全量样式合并为该单一文件——动态 import 不会自动加载
  //   css 分片，页面上下文需按固定地址显式引入）
  const buildStyleElement = document.createElement("link");
  buildStyleElement.id = "ptd-content-script-style-build";
  buildStyleElement.rel = "stylesheet";
  buildStyleElement.href = chrome.runtime.getURL("chenbinpt.css");
  shadowRoot.appendChild(buildStyleElement);

  // 在 shadow DOM 中创建一个 html 作为所有元素的容器
  const appMountElement = document.createElement("div");
  appMountElement.id = "ptd-content-script-app";
  appMountElement.className = "ptd-content-script-app";
  shadowRoot.appendChild(appMountElement);
  setClipboardFallbackContainer(appMountElement);

  const popupHostElement = document.createElement("div");
  popupHostElement.id = "ptd-content-script-popup-host";
  popupHostElement.className = "ptd-content-script-popup-host";
  popupHostElement.addEventListener("mousedown", stopRetargetedSelectPointerDown);
  popupHostElement.addEventListener("touchstart", stopRetargetedSelectPointerDown);
  shadowRoot.appendChild(popupHostElement);
  message.config({ getContainer: () => popupHostElement });

  // 插入到页面中
  document.body.append(contentRoot);

  // 挂载 Vue 应用
  const Root = defineComponent({
    name: "PtdContentScriptRoot",
    setup() {
      const configStore = useConfigStore();
      const { locale, themeConfig, themeVars } = useAntdConfig();
      const appliedThemeConfig = computed(() => (configStore.contentScript.applyTheme ? themeConfig.value : undefined));
      const getPopupContainer = () => popupHostElement;

      // 把 antd Design Token 派生的 `--ptd-*` 写到 shadow host（contentRoot）上，
      // 供 shadow tree 内的 chenbinpt.css 使用；判定与 appliedThemeConfig 保持一致
      // （未跟随主题时显式写 `buildThemeVars(false)` 的浅色一套）。详见 ./themeVars.ts。
      syncThemeVarsToHost(
        contentRoot,
        () => themeVars.value,
        () => configStore.contentScript.applyTheme,
      );

      return () =>
        h(
          StyleProvider,
          { container: shadowRoot as unknown as HTMLElement },
          {
            default: () =>
              h(
                ConfigProvider,
                {
                  getPopupContainer,
                  getTargetContainer: getPopupContainer,
                  locale: locale.value,
                  theme: appliedThemeConfig.value,
                },
                { default: () => h(App) },
              ),
          },
        );
    },
  });
  const app = createApp(Root).use(pinia).use(i18n).use(antd);
  app.provide("ptd_data", data); // 提供数据给 Vue 应用
  app.mount(appMountElement);

  // 防止某些网站动态修改 body，从而移除我们的 contentRoot，因此使用 MutationObserver 监听 body 的变化
  // 一旦发现 contentRoot 被移除，则重新挂载应用
  // 注意：只监听 body 的直接子节点变化（不用 subtree）：contentRoot 是 body 的直接子元素，
  // 而 subtree: true 会让页面上任何 DOM 变更（SPA 站点可能每秒数百次）都回调一次 JS（见 docs/performance-audit.md P2-7）。
  remountGuard.noteMounted();
  const mutationObserver = new MutationObserver(() => {
    if (!document.body || document.body.contains(contentRoot)) return;
    // L-4：重挂载预算由模块级 guard 持有。旧实现在函数体内声明计数器，而重挂载是递归调用
    // mountApp()，每次进入函数体计数器都会归零 ⇒ 上限永远触发不到（宿主持续删 DOM 时无限循环）。
    if (!remountGuard.allowRemount()) {
      mutationObserver.disconnect();
      return;
    }
    mutationObserver.disconnect();
    setClipboardFallbackContainer(undefined);
    app.unmount();
    mountApp(document, data);
  });

  mutationObserver.observe(document.body, { childList: true });

  return { contentRoot, shadowRoot, appMountElement, app };
}
