import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryHistory, createRouter } from "vue-router";
import { mountOptionsView } from "../../helpers/optionsView.ts";

const stores = vi.hoisted(() => ({ runtime: undefined as any }));

vi.mock("@/options/stores/runtime.ts", async () => {
  const { reactive } = await import("vue");
  stores.runtime = reactive({ search: { isSearching: false } });
  return { useRuntimeStore: () => stores.runtime };
});
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
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", name: "Home", component: { render: () => null } },
      { path: "/search-entity", name: "SearchEntity", component: { render: () => null } },
    ],
  });
  await router.push(initialPath);
  view = mountOptionsView(Topbar, { plugins: [router] });
  await view.settle();
  return { router, input: view.$<HTMLInputElement>(".ptd-search-key input")! };
}

function pressEnter(input: HTMLInputElement, isComposing = false) {
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 13, isComposing, bubbles: true }));
}

beforeEach(() => {
  stores.runtime.search.isSearching = false;
});
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

  it("搜索期间回车与禁用的搜索按钮保持一致", async () => {
    const { router, input } = await mountTopbar();
    stores.runtime.search.isSearching = true;
    await view.settle();
    pressEnter(input);
    await view.settle();
    expect(router.currentRoute.value.name).toBe("Home");
    expect(view.$<HTMLButtonElement>('button[title="搜索"]')?.disabled).toBe(true);
  });

  it("中文输入法确认候选词的回车不触发搜索", async () => {
    const { router, input } = await mountTopbar();
    pressEnter(input, true);
    await view.settle();
    expect(router.currentRoute.value.name).toBe("Home");
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
