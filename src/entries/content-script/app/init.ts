import appCss from "./app.css?inline";
import antdResetCss from "ant-design-vue/dist/reset.css?inline";
// 与管理页共用的组件样式（`.ptd-*` 工具类、`.ant-btn` 图标顺序等，被 NavButton / TorrentTitleTd 等共享组件使用）
import optionsCss from "@/options/style.css?inline";
import { ConfigProvider } from "ant-design-vue";
import { StyleProvider } from "ant-design-vue/es/_util/cssinjs";

import { computed, createApp, defineComponent, h } from "vue";
import { message } from "ant-design-vue";

import App from "./App.vue";
import { PTD_DATA_KEY, PTD_DATA_READY_KEY } from "./injectionKeys.ts";
import { createRemountGuard } from "./remountGuard.ts";
import { installDialogSentinelFocusGuard, stopRetargetedSelectPointerDown } from "./shadowPopupEvents.ts";
import { syncThemeVarsToHost } from "./themeVars.ts";
import { setClipboardFallbackContainer } from "./utils.ts";
import { piniaInstance as pinia } from "@/options/plugins/pinia.ts";
import { i18nInstance as i18n } from "@/options/plugins/i18n.ts";
import { antdInstance as antd, useAntdConfig } from "@/options/plugins/antd.ts";
import { useConfigStore } from "@/options/stores/config.ts";
import { useMetadataStore } from "@/options/stores/metadata.ts";

/**
 * 重挂载预算：模块级单例，跨 `mountApp()` 的递归调用共享（见 remountGuard.ts 的 L-4 说明）。
 * 一个 content-script 上下文只挂载一个应用实例，因此不需要按 document 区分。
 */
const remountGuard = createRemountGuard();

function isPlainObject(value: unknown): value is Record<string, any> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * 递归剥离普通对象中的 `undefined` 自有属性：
 * Pinia 的 `$patch` 会把 `{ contentScript: undefined }` 直接赋给目标对象，覆盖默认配置并引发 TypeError。
 */
export function stripUndefinedProps<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => stripUndefinedProps(item)) as T;
  }
  if (!isPlainObject(value)) {
    return value;
  }
  const result: Record<string, any> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) continue;
    result[key] = stripUndefinedProps(entry);
  }
  return result as T;
}

function sanitizeConfigPatch(raw: unknown): Record<string, any> | undefined {
  if (!isPlainObject(raw)) return undefined;
  const cleaned = stripUndefinedProps(raw);
  // 嵌套对象分区只能是普通对象，避免 null / 非对象覆盖 configStore 默认结构
  for (const nestedKey of ["contentScript", "download", "searchEntifyControl"] as const) {
    if (nestedKey in cleaned && !isPlainObject(cleaned[nestedKey])) {
      delete cleaned[nestedKey];
    }
  }
  return cleaned;
}

function sanitizeMetadataPatch(raw: unknown): Record<string, any> | undefined {
  if (!isPlainObject(raw)) return undefined;
  return stripUndefinedProps(raw);
}

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

  // 共享组件样式同样以字符串注入（旧构建把整份管理页 CSS 打成 chenbinpt.css，再以
  // web_accessible_resources 暴露给页面用 <link> 加载；现在内容脚本只带自己依赖图里的样式，
  // 不再需要任何可被网页探测的 CSS 资源。构建期由 vite/plugin/forbidContentScriptCssAssets.ts 守卫：
  // 内容脚本依赖图里一旦出现会被抽成独立文件的 CSS，构建直接失败）
  const buildStyleElement = document.createElement("style");
  buildStyleElement.id = "ptd-content-script-style-build";
  buildStyleElement.textContent = optionsCss;
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
  // closed shadow 下 vc-dialog 的焦点误判会把焦点从已展开的 Select 上抢走并关掉其下拉
  // （TESTS-5 残留，机理见 shadowPopupEvents.ts）。
  installDialogSentinelFocusGuard(shadowRoot);
  shadowRoot.appendChild(popupHostElement);
  // CONTENTSCRIPT-1：这里只作为静态 message 的兜底挂载点（真正的通路是 App.vue 的 useMessage 实例，
  // 见 modal.ts）。静态实例的 cssinjs 规则仍在宿主 head，无法在 shadow root 内生效，因此兜底不保证样式。
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
      // 供 shadow tree 内注入的 options/style.css 使用；判定与 appliedThemeConfig 保持一致
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
  const configStore = useConfigStore(pinia);
  const metadataStore = useMetadataStore(pinia);

  const sanitizedConfig = sanitizeConfigPatch(data?.config);
  const sanitizedMetadata = sanitizeMetadataPatch(data?.metadata);

  // 挂载前先同步 patch 一次，保证 Root setup 里的 useAntdConfig() 首次渲染即读到正确的 lang/theme/contentScript
  if (sanitizedConfig) {
    configStore.$patch(sanitizedConfig);
  }
  if (sanitizedMetadata) {
    metadataStore.$patch(sanitizedMetadata);
  }

  /**
   * 两个 store 都水合并把 bootstrap 注入的 config/metadata patch 完成之后才 resolve。
   *
   * 旧实现把这个 Promise 丢在一边（`void ...then`），App.vue 里只等 `configStore.$onReady()`：
   * config 单独水合完成时回调就执行，此时 `data.config` 还没 patch 进来，读到的全是默认值
   * （`defaultOpenSpeedDial`、悬浮球位置等）。这些值随后只写进普通 ref，不会重新求值。
   * 这里把该 Promise 提供给 App.vue，让它等「水合 + patch」都完成后再初始化。
   */
  const dataReady = Promise.all([configStore.$onReady(), metadataStore.$onReady()]).then(() => {
    if (sanitizedConfig) {
      configStore.$patch(sanitizedConfig);
    }
    if (sanitizedMetadata) {
      metadataStore.$patch(sanitizedMetadata);
    }
  });
  app.provide(PTD_DATA_KEY, data); // 提供数据给 Vue 应用
  app.provide(PTD_DATA_READY_KEY, dataReady);
  app.mount(appMountElement);

  // 防止某些网站动态修改 body，从而移除我们的 contentRoot，因此使用 MutationObserver 监听 body 的变化
  // 一旦发现 contentRoot 被移除，则重新挂载应用
  // 注意：只监听 body 的直接子节点变化（不用 subtree）：contentRoot 是 body 的直接子元素，
  // 而 subtree: true 会让页面上任何 DOM 变更（SPA 站点可能每秒数百次）都回调一次 JS（见 docs/performance-audit.md P2-7）。
  remountGuard.noteMounted();
  const mutationObserver = new MutationObserver(() => {
    if (!document.body || document.body.contains(contentRoot)) return;
    mutationObserver.disconnect();
    setClipboardFallbackContainer(undefined);
    app.unmount();
    // L-4：重挂载预算由模块级 guard 持有。旧实现在函数体内声明计数器，而重挂载是递归调用
    // mountApp()，每次进入函数体计数器都会归零 ⇒ 上限永远触发不到（宿主持续删 DOM 时无限循环）。
    if (!remountGuard.allowRemount()) {
      return;
    }
    mountApp(document, data);
  });

  mutationObserver.observe(document.body, { childList: true });

  return { contentRoot, shadowRoot, appMountElement, app };
}
