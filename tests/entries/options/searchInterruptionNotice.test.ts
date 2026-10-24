/**
 * OUI-2（复检 Medium）：搜索中刷新页面后，部分结果会被当成「完整结果」展示，且没有
 * 「上次搜索被中断」提示。
 *
 * 根因有两段：
 * 1. `SearchEntity/Index.vue` 的 `runSearch()` 在 `doSearch()` resolve 时（= 任务全部**入队**）
 *    就把 URL 上的 `flush` 摘掉；搜索还没结束就刷新，恢复出来的部分结果会被判成
 *    「与 URL 匹配」而不再重搜。现在改为等 `waitForSearchQueueIdle()`（队列真正空闲）再摘
 *    （由 searchCancel.test.ts 的 waitForSearchQueueIdle 用例覆盖）。
 * 2. runtime store 恢复时把 `isSearching` 强制置 false、waiting/working 计划改写成
 *    `passParse + i18n.userCancel`，但 `getRuntimeRestoreInterruptions()` 在生产代码里
 *    **零调用者** —— 用户看不到任何「上次搜索被中断」提示。现在 SearchEntity 首次挂载消费
 *    一次该标记并提示（同一会话只提示一次）。
 *
 * 本文件只验证第 2 段：用真实 sessionStorage 种子 + 真实 runtime store 恢复路径 + 真实挂载搜索页。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 搜索页会经这些模块拉站点 / 下载器组件；单测只需要页面能挂载，不需要它们的行为。
vi.mock("@/messages.ts", () => ({ sendMessage: vi.fn(), onMessage: vi.fn() }));
vi.mock("@/options/utils/saveAs.ts", () => ({ saveAs: vi.fn() }));
vi.mock("@ptd/downloader", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getDownloaderMetaData: async (type: string) => ({ type, name: type, feature: {}, advanceAddTorrentOptions: {} }),
    getDownloaderIcon: () => "",
  };
});
vi.mock("@/options/components/SiteName.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    default: defineComponent({
      name: "SiteNameStub",
      props: { siteId: { type: String, default: "" }, tag: { type: String, default: "span" } },
      setup: (props) => () => h(props.tag, { class: "stub-site-name" }, props.siteId),
    }),
  };
});
vi.mock("@/options/components/SiteFavicon/Index.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    default: defineComponent({
      name: "SiteFaviconStub",
      props: { siteId: { type: String, default: "" } },
      setup: () => () => h("i", { class: "stub-site-favicon" }),
    }),
  };
});

import { mountOptionsView, prepareOptionsPinia } from "../../helpers/optionsView.ts";

const RUNTIME_KEY = "__ptd_runtime_store";
const EXTENSION_URL = "chrome-extension://test/";

/** 与 @ptd/site 的 EResultParseStatus 数值一致（避免为两个字面量把站点包拉进单测） */
const STATUS_WAITING = 1;

beforeEach(() => {
  document.body.innerHTML = "";
  sessionStorage.clear();
  // runtime.ts 的恢复在模块求值期执行：既决定 storage 分支（扩展页），也读取 sessionStorage 种子。
  vi.stubGlobal("chrome", { runtime: { getURL: (path: string) => `${EXTENSION_URL}${path}` } });
  (window as any).happyDOM?.setURL(`${EXTENSION_URL}options.html`);
});

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
  (window as any).happyDOM?.setURL("http://localhost:3000/");
});

/**
 * 造一份「上次搜索被中断」的持久化状态，并在干净的模块图上加载 runtime store + 搜索页。
 * `vi.resetModules()` 必须在读取 runtime store 之前调用：恢复只在模块求值期做一次。
 */
async function loadInterruptedSearchPage() {
  sessionStorage.setItem(
    RUNTIME_KEY,
    JSON.stringify({
      search: {
        isSearching: true,
        startAt: Date.now() - 5000,
        searchKey: "kw",
        searchResult: [{ site: "site-a", id: 1, title: "partial result" }],
        searchPlan: { "site-a|$|default": { status: STATUS_WAITING } },
      },
    }),
  );

  vi.resetModules();
  const pinia = prepareOptionsPinia();
  const runtimeModule = await import("@/options/stores/runtime.ts");
  const runtimeStore = runtimeModule.useRuntimeStore(pinia);
  const snackbar = vi.spyOn(runtimeStore, "showSnakebar").mockImplementation(() => {});

  const { default: SearchEntityView } = await import("@/options/views/Overview/SearchEntity/Index.vue");
  const mount = () => mountOptionsView(SearchEntityView, { pinia, router: true });

  return { runtimeModule, runtimeStore, snackbar, mount };
}

describe("OUI-2：恢复出的「上次搜索被中断」必须给出可见提示", () => {
  it("恢复阶段收尾了 waiting 计划 / isSearching 后，搜索页挂载时提示一次且带 warning 色", async () => {
    const { runtimeModule, snackbar, mount } = await loadInterruptedSearchPage();

    // 恢复语义本身：in-flight 已收尾，并记录了「发生过中断」
    expect(runtimeModule.getRuntimeRestoreInterruptions().search).toBe(true);

    const view = mount();
    try {
      await new Promise((resolve) => setTimeout(resolve, 80));
      const { i18nInstance } = await import("@/options/plugins/i18n.ts");
      const expected = i18nInstance.global.t("SearchEntity.index.alert.searchInterrupted");
      expect(snackbar).toHaveBeenCalledWith(expected, { color: "warning" });
    } finally {
      view.unmount();
    }
  });

  it("同一会话内再次进入搜索页不重复提示（中断标记已被消费）", async () => {
    const { snackbar, mount } = await loadInterruptedSearchPage();
    const { i18nInstance } = await import("@/options/plugins/i18n.ts");
    const expected = i18nInstance.global.t("SearchEntity.index.alert.searchInterrupted");

    const first = mount();
    await new Promise((resolve) => setTimeout(resolve, 80));
    first.unmount();
    document.body.innerHTML = "";

    const second = mount();
    try {
      await new Promise((resolve) => setTimeout(resolve, 80));
      const calls = snackbar.mock.calls.filter(([text]) => text === expected);
      expect(calls, "中断提示只应在首次挂载时出现一次").toHaveLength(1);
    } finally {
      second.unmount();
    }
  });
});
