import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryHistory, createRouter } from "vue-router";
import { mountOptionsView, loadScopedStyles, prepareOptionsPinia } from "../../helpers/optionsView.ts";

vi.mock("@/options/stores/config.ts", () => ({
  useConfigStore: () => ({ searchEntity: { allowSingleSiteSearch: false, showHotRecommendations: false } }),
}));
vi.mock("@/options/stores/metadata.ts", () => ({
  useMetadataStore: () => ({
    getSearchSolutions: [],
    getSortedAddedSites: [],
    getAddedSites: [],
    defaultSolutionId: "default",
    getSearchSolutionName: (id: string) => id,
  }),
}));
vi.mock("@/options/views/Overview/MyData/utils/siteMetadataCache.ts", () => ({ getCachedSiteMetadata: vi.fn() }));
vi.mock("@/options/components/SiteFavicon/Index.vue", () => ({ default: { render: () => null } }));
vi.mock("@/options/components/SiteName.vue", () => ({ default: { render: () => null } }));
vi.mock("@/options/views/Layout/RecommendationMenu.vue", () => ({ default: { render: () => null } }));

import Topbar from "@/options/views/Layout/Topbar.vue";

let view: ReturnType<typeof mountOptionsView>;

async function mountTopbar(initialPath = "/") {
  const pinia = prepareOptionsPinia();
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", name: "Home", component: { render: () => null } },
      { path: "/search-entity", name: "SearchEntity", component: { render: () => null } },
    ],
  });
  await router.push(initialPath);
  view = mountOptionsView(Topbar, { pinia, plugins: [router] });
  await view.settle();
  return { router, pinia, input: view.$<HTMLInputElement>(".ptd-search-key input")! };
}

function pressEnter(input: HTMLInputElement, isComposing = false) {
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 13, isComposing, bubbles: true }));
}

afterEach(() => view?.unmount());

describe("顶栏搜索交互", () => {
  it("首次打开搜索地址时恢复关键词和搜索方案", async () => {
    const { input } = await mountTopbar("/search-entity?search=movie&plan=site%3Atest");
    expect(input.value).toBe("movie");
    expect(view.$(".ptd-search-plan-label")?.textContent).toBe("test");
  });

  it("前进后退到空关键词搜索时同步清空输入框", async () => {
    const { router, input } = await mountTopbar();
    await router.push("/search-entity?search=movie&plan=default");
    await view.settle();
    expect(input.value).toBe("movie");
    await router.push("/search-entity?search=&plan=default");
    await view.settle();
    expect(input.value).toBe("");
  });

  it("搜索进行中仍可再次搜索：用新关键词替换当前搜索", async () => {
    const { router, pinia, input } = await mountTopbar("/search-entity?search=first-query&plan=default");
    const { useRuntimeStore } = await import("@/options/stores/runtime.ts");
    const runtimeStore = useRuntimeStore(pinia);
    runtimeStore.search.isSearching = true;
    await view.settle();

    // 旧实现会在 runtimeStore.search.isSearching=true 时禁用输入框回车 / 搜索按钮
    const searchBtn = view.$<HTMLButtonElement>('button[title="搜索"]');
    expect(searchBtn?.disabled).toBe(false);

    const pushSpy = vi.spyOn(router, "push");
    try {
      input.value = "replacement-query";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      pressEnter(input);
      await view.settle();

      expect(pushSpy).toHaveBeenCalledTimes(1);
      expect(router.currentRoute.value.name).toBe("SearchEntity");
      expect(router.currentRoute.value.query.search).toBe("replacement-query");
      expect(runtimeStore.search.isSearching).toBe(true);
    } finally {
      pushSpy.mockRestore();
    }
  });

  it("中文输入法确认候选词的回车不触发搜索", async () => {
    const { router, input } = await mountTopbar();
    pressEnter(input, true);
    await view.settle();
    expect(router.currentRoute.value.name).toBe("Home");
  });

  it("窄屏下方案按钮与搜索按钮不被 flex 压缩（保住 24px 触控命中区）", async () => {
    loadScopedStyles("src/entries/options/views/Layout/Topbar.vue");
    await mountTopbar();
    const plan = view.$<HTMLElement>(".ptd-search-plan-btn")!;
    const search = view.$<HTMLElement>(".ptd-search-input > .ant-btn:last-child")!;
    expect(getComputedStyle(plan).flexShrink, "方案按钮是固定控件，不应被输入框挤压").toBe("0");
    expect(getComputedStyle(search).flexShrink, "搜索按钮是固定控件，不应被输入框挤压").toBe("0");
  });

  it("导航完成前连续回车只提交一次，完成后可以再次搜索", async () => {
    const { router, input } = await mountTopbar();
    let releaseNavigation!: () => void;
    const navigation = new Promise<void>((resolve) => (releaseNavigation = resolve));
    const removeGuard = router.beforeEach(() => navigation);
    const push = vi.spyOn(router, "push");

    try {
      pressEnter(input);
      pressEnter(input);
      await view.settle();
      expect(push).toHaveBeenCalledTimes(1);
    } finally {
      releaseNavigation();
      removeGuard();
      await view.settle();
    }

    pressEnter(input);
    await view.settle();
    expect(push).toHaveBeenCalledTimes(2);
  });
});
