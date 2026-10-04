/**
 * B-19：内容脚本实例不得读写宿主页面的 sessionStorage（见代码审查报告 B-19；报告已移出仓库树，可在提交 3b066d59 中查阅）。
 *
 * 背景：`useRuntimeStore` 会被 content-script 注册（content-script/app/App.vue、app/utils.ts），
 * 而内容脚本里的 `sessionStorage` 与宿主页面**同一个**：
 * 1. 页面脚本能读到扩展持久化的内容（例如 `search.searchKey`）；
 * 2. 页面能在内容脚本加载前预置 `__ptd_runtime_store` 注入任意 JSON
 *    （修复前只校验 `typeof parsed === "object"`）。
 * 这里覆盖两条分支：
 * - 内容脚本（`location.href` 不是扩展 URL 前缀）：纯内存，既不恢复也不写入；
 * - 扩展页面（`location.href` 是 `chrome.runtime.getURL("")` 前缀）：照旧节流持久化。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia } from "pinia";
import { nextTick } from "vue";

// runtime.ts 只在 showSnakebar 里用到 antd 的 message
vi.mock("ant-design-vue", () => ({ message: { open: vi.fn() } }));

const RUNTIME_KEY = "__ptd_runtime_store";
const EXTENSION_URL = "chrome-extension://test/";

function stubChromeExtension() {
  vi.stubGlobal("chrome", { runtime: { getURL: (path: string) => `${EXTENSION_URL}${path}` } });
}

/** runtime.ts 在模块求值期就决定是否使用 sessionStorage，因此每次都要 resetModules 后重新 import */
async function loadRuntimeStore() {
  vi.resetModules();
  const { useRuntimeStore, setupRuntimeStorePersistence } = await import("@/options/stores/runtime.ts");
  const store = useRuntimeStore(createPinia());
  setupRuntimeStorePersistence(store);
  return store;
}

beforeEach(() => {
  vi.useFakeTimers();
  sessionStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
  sessionStorage.clear();
});

describe("B-19 内容脚本：纯内存，且不信任宿主页面预置的内容", () => {
  it("预置的非法 JSON 不会进入 store", async () => {
    stubChromeExtension();
    sessionStorage.setItem(
      RUNTIME_KEY,
      JSON.stringify({
        search: { isSearching: "yes", startAt: "0", searchKey: 42, searchResult: "not-an-array", searchPlan: [] },
        userInfo: { flushPlan: { site1: "yes", site2: true } },
        mediaServerSearch: "junk",
      }),
    );

    const store = await loadRuntimeStore();

    expect(store.search.searchKey).toBe("");
    expect(store.search.searchResult).toEqual([]);
    expect(store.search.isSearching).toBe(false);
    expect(store.search.startAt).toBe(0);
    expect(store.search.searchPlan).toEqual({});
    expect(store.userInfo.flushPlan).toEqual({});
    expect(store.mediaServerSearch.searchKey).toBe("");
  });

  it("顶层的非对象 JSON（字符串/数组）也不会进入 store", async () => {
    stubChromeExtension();
    sessionStorage.setItem(RUNTIME_KEY, JSON.stringify(["junk"]));

    const store = await loadRuntimeStore();

    expect(store.search.searchKey).toBe("");
    expect(store.mediaServerSearch.searchResult).toEqual([]);
  });

  it("内容脚本不写回 sessionStorage（页面无法读到扩展数据）", async () => {
    stubChromeExtension();
    const seeded = JSON.stringify({ search: { searchKey: "page-seeded", searchResult: [] } });
    sessionStorage.setItem(RUNTIME_KEY, seeded);

    const store = await loadRuntimeStore();
    const setItemSpy = vi.spyOn(sessionStorage, "setItem");

    store.search.searchKey = "secret keyword";
    store.search.searchResult.push({ id: 1 } as any);
    store.persistNow();
    await nextTick();
    vi.advanceTimersByTime(1000);

    expect(setItemSpy).not.toHaveBeenCalled();
    // 页面自己预置的内容保持原样（我们既不读也不写）
    expect(sessionStorage.getItem(RUNTIME_KEY)).toBe(seeded);
    // 内存态照常工作
    expect(store.search.searchKey).toBe("secret keyword");
  });
});

describe("B-19 扩展页面：节流持久化行为不变", () => {
  it("扩展页面（location 是扩展 URL）仍然能恢复并节流写入", async () => {
    stubChromeExtension();
    (window as any).happyDOM?.setURL(`${EXTENSION_URL}options.html`);
    sessionStorage.setItem(
      RUNTIME_KEY,
      JSON.stringify({
        search: {
          isSearching: false,
          startAt: 1,
          searchKey: "keyword",
          searchPlanKey: "default",
          searchPlan: {},
          searchResult: [{ id: 1 }],
        },
        userInfo: { flushPlan: {} },
      }),
    );

    const store = await loadRuntimeStore();
    expect(store.search.searchKey).toBe("keyword");
    expect(store.search.searchResult).toHaveLength(1);

    const setItemSpy = vi.spyOn(sessionStorage, "setItem");
    store.search.searchKey = "changed";
    await nextTick();
    expect(setItemSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(500);
    expect(setItemSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(sessionStorage.getItem(RUNTIME_KEY) as string).search.searchKey).toBe("changed");
  });
});
