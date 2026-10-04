/**
 * options 页面 SFC 的挂载 / 样式断言工具。
 *
 * 背景（见代码审查报告 Q-3；报告已移出仓库树，可在提交 3b066d59 中查阅）：此前一批测试用 `readFileSync` 读 `.vue` / `style.css`
 * 后对**源码文本**做正则断言，双向失效 —— 等价重构变红，行为坏掉照样绿。
 * 本文件提供两件基础设施，把这批断言换成真正的行为断言：
 *
 * 1. `mountOptionsView()`：把 `src/entries/options/**` 的 SFC 真实挂载到 happy-dom，
 *    补齐它需要的 pinia / i18n / antd / router，返回可直接查询 DOM 的句柄。
 *    需要哪些协作模块（`@/messages.ts`、子组件、`utils.ts` …）由各测试自己 `vi.mock`，
 *    这里只负责"能渲染起来"。
 * 2. `loadOptionsStyles()` + `computedStyle()`：把 `style.css` 作为真实样式表注入文档，
 *    再用 `getComputedStyle` 读取**计算后的值**。这样断言的是"用户最终看到的样式"
 *    （含选择器权重、规则顺序、CSS 变量回退的相互作用），而不是某条规则的书写形式。
 *
 * 注意：`vitest.config.ts` 里的 `@vitejs/plugin-vue` 是本文件能存在的前提。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import Antd from "ant-design-vue";
import { createPinia, setActivePinia, type Pinia } from "pinia";
import { createApp, type App, type Component } from "vue";
import { createMemoryHistory, createRouter } from "vue-router";

import { i18nInstance } from "@/options/plugins/i18n.ts";

/**
 * `@ptd/site` 的 adapter.ts → messages.ts 会读取 Vite 的构建期常量。
 * 单测环境没有 Vite define，必须在**加载这些模块之前**补上，
 * 否则 `ReferenceError: __BROWSER__ is not defined`。
 */
(globalThis as any).__BROWSER__ ??= "chrome";
(globalThis as any).__EXT_VERSION__ ??= "0.0.0.0";

const STYLE_ELEMENT_ID = "ptd-options-style-in-test";

/** 把 `src/entries/options/style.css` 作为真实样式表注入当前文档（幂等）。 */
export function loadOptionsStyles(): void {
  if (document.getElementById(STYLE_ELEMENT_ID)) return;

  const style = document.createElement("style");
  style.id = STYLE_ELEMENT_ID;
  style.textContent = readFileSync(resolve(process.cwd(), "src/entries/options/style.css"), "utf8");
  document.head.appendChild(style);
}

/** 读取元素的计算样式值（CSS 简写属性在 happy-dom 下会展开成计算值，例如 gap → 6px）。 */
export function computedStyle(element: Element, property: string): string {
  return getComputedStyle(element).getPropertyValue(property);
}

/**
 * 把某个 SFC 的 `<style>`（含 `<style scoped>`）内容注入文档。
 *
 * 为什么需要它：vitest 默认不处理 CSS（`test.css` 未开启），SFC 里 `<style scoped>` 的声明
 * **不会**进入文档，`getComputedStyle` 读不到 —— 但那恰恰是"用户最终看到的样式"的一部分。
 * 这里把样式块原样注入：`scoped` 只是给选择器加 `[data-v-xxx]` 提高特异性，
 * 对本项目这些用独立类名写的规则来说，注入后计算值与线上一致。
 */
export function loadScopedStyles(sfcRelativePath: string): void {
  const source = readFileSync(resolve(process.cwd(), sfcRelativePath), "utf8");
  const css = [...source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((match) => match[1]).join("\n");
  if (!css.trim()) return;

  const style = document.createElement("style");
  style.dataset.source = sfcRelativePath;
  style.textContent = css;
  document.head.appendChild(style);
}

/**
 * 建一个测试用 pinia 并设为 active。
 *
 * 必须在**动态 import 被测 SFC 之前**调用：`SearchEntity/utils/filter.ts` 这类模块在求值期就
 * `useXxxStore()`，没有 active pinia 会直接抛 `getActivePinia()` 错误（静态 import 时序无法保证，
 * 所以各测试用 `beforeAll(async () => { View = (await import("...")).default })` 延迟加载）。
 *
 * `$onReady` 是 `pinia-plugin-state-persistence` 注入的：这里给一个立即 resolve 的替身，
 * 表示"存储已水合"，从而不必在单测里搭 chrome.storage。
 */
export function prepareOptionsPinia(): Pinia {
  const pinia = createPinia();

  // pinia 只有在被 `app.use()` 之后才会把 `use()` 登记的插件从 toBeInstalled 挪进 _p，
  // 而许多 options 模块（例如 `views/Overview/MyData/UserDataTimeline/utils.ts`）在**模块求值期**
  // 就 `useXxxStore()` —— 那早于 mountOptionsView 里的 `app.use(pinia)`，
  // 于是这些 store 拿不到下面的 $onReady 替身。这里先装到一个一次性 app 上，让插件立即生效。
  createApp({ render: () => null }).use(pinia);

  pinia.use(({ store }) => {
    (store as any).$onReady = async () => {};
  });
  setActivePinia(pinia);
  return pinia;
}

/** 建一个内存路由（`useRoute` / `useRouter` 可用；不做真实导航）。 */
export function createTestRouter(routeName = "TestRoot") {
  return createRouter({
    history: createMemoryHistory(),
    routes: [{ path: "/:pathMatch(.*)*", name: routeName, component: { template: "<div />" } }],
  });
}

export interface IMountOptions {
  /** 传给根组件的 props */
  props?: Record<string, unknown>;
  /** 已由 `prepareOptionsPinia()` 建好的 pinia；不传则新建 */
  pinia?: Pinia;
  /** 需要 `useRoute` / `useRouter` 的组件要置 true；传字符串表示当前路由名（供按 route.name 分支的组件使用） */
  router?: boolean | string;
  /** 额外的全局插件（例如局部注册的组件插件） */
  plugins?: Array<{ install: (app: App) => void }>;
}

export interface IMountHandle {
  /** 挂载容器（断言 DOM 时从这里查，避免命中别的用例残留） */
  host: HTMLElement;
  app: App;
  /** querySelector（限定在 host 之内） */
  $: <T extends Element = HTMLElement>(selector: string) => T | null;
  /** querySelectorAll（限定在 host 之内） */
  $$: <T extends Element = HTMLElement>(selector: string) => T[];
  html: () => string;
  text: () => string;
  /** 等一帧 + 一个宏任务，给 antd 的浮层（Popover / Tooltip）渲染留时间 */
  settle: (ms?: number) => Promise<void>;
  unmount: () => void;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * 把 SFC 真实挂载到 happy-dom 并返回查询句柄。
 *
 * 这里不使用 `@vue/test-utils`（不是本仓库依赖），直接用 `createApp`，与
 * `tests/entries/options/antdModalAfterClose.test.ts` 的方式一致。
 */
export function mountOptionsView(component: Component, options: IMountOptions = {}): IMountHandle {
  const host = document.createElement("div");
  document.body.appendChild(host);

  const app = createApp(component as any, options.props ?? {});
  const pinia = options.pinia ?? prepareOptionsPinia();

  app.use(pinia);
  app.use(i18nInstance);
  app.use(Antd as any);
  if (options.router) {
    app.use(createTestRouter(typeof options.router === "string" ? options.router : undefined));
  }
  for (const plugin of options.plugins ?? []) app.use(plugin as any);

  app.mount(host);

  const $$ = <T extends Element = HTMLElement>(selector: string) => Array.from(host.querySelectorAll<T>(selector));

  return {
    host,
    app,
    $: <T extends Element = HTMLElement>(selector: string) => host.querySelector<T>(selector),
    $$,
    html: () => host.innerHTML,
    text: () => host.textContent ?? "",
    settle: (ms = 40) => sleep(ms),
    unmount: () => {
      app.unmount();
      host.remove();
    },
  };
}

/** 造一个挂载在 body 上的裸 DOM 容器（只测 CSS 时用，不需要 Vue） */
export function mountDom(html: string): { root: HTMLElement; unmount: () => void } {
  const root = document.createElement("div");
  root.innerHTML = html;
  document.body.appendChild(root);
  return { root, unmount: () => root.remove() };
}
