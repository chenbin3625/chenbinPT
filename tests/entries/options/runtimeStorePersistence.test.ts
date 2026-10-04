/**
 * runtime store 持久化行为测试（见 docs/performance-audit.md P0-1）。
 *
 * 修复前的实现走 `pinia-plugin-state-persistence` 的默认行为：
 * `$subscribe(..., { flush: "sync" })` + pinia 默认 `deep: true`
 * → **每次 mutation** 都深遍历整个 state 并 `JSON.stringify` + 同步写 sessionStorage。
 * 搜索期间每个站点会产生 5~6 次 mutation，媒体服务器搜索甚至逐条 push，
 * 写入量累计为 O(站点数 × 结果数)。
 *
 * 修复后：内存态照旧，落盘改为 500ms 节流合并（并在 pagehide/visibilitychange 立即 flush）。
 * 这里用假计时器 + setItem 计数把这个行为钉住：
 * - 大量 mutation 在节流窗口内不产生任何写盘；
 * - 窗口结束后只写一次，且内容完整（搜索结果能跨刷新保留）；
 * - 从 sessionStorage 恢复的逻辑仍然有效；
 * - 配额不足时降级为"不保存搜索结果"而不是整份静默丢失（修复前的行为）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia } from "pinia";
import { nextTick } from "vue";

// runtime.ts 只在 showSnakebar 里用到 antd 的 message，这里不需要真实实现
vi.mock("ant-design-vue", () => ({ message: { open: vi.fn() } }));

const RUNTIME_KEY = "__ptd_runtime_store";

async function loadRuntimeStore(seed?: unknown) {
  vi.resetModules();
  sessionStorage.clear();
  if (seed !== undefined) {
    sessionStorage.setItem(RUNTIME_KEY, JSON.stringify(seed));
  }

  const { useRuntimeStore, setupRuntimeStorePersistence } = await import("@/options/stores/runtime.ts");
  const store = useRuntimeStore(createPinia());
  setupRuntimeStorePersistence(store);
  return store;
}

describe("runtime store：节流持久化（P0-1）", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it("从 sessionStorage 恢复：刷新页面后搜索结果仍在", async () => {
    const store = await loadRuntimeStore({
      search: {
        isSearching: false,
        startAt: 1,
        endAt: 2,
        searchKey: "keyword",
        searchPlanKey: "default",
        searchPlan: {},
        searchResult: [{ id: 1, title: "t1" }],
      },
      userInfo: { flushPlan: {} },
      mediaServerSearch: { isSearching: false, searchKey: "", searchStatus: {}, searchResult: [] },
    });

    expect(store.search.searchKey).toBe("keyword");
    expect(store.search.searchResult).toHaveLength(1);
  });

  it("节流窗口内多次 mutation 不写盘，窗口结束只写一次且内容完整", async () => {
    vi.useFakeTimers();
    try {
      const store = await loadRuntimeStore();
      const setItemSpy = vi.spyOn(sessionStorage, "setItem");
      setItemSpy.mockClear();

      // 模拟一次搜索：多个站点的进度写入 + 每个站点一次结果批量 push
      const plan = store.search.searchPlan as Record<string, any>;
      const results = store.search.searchResult as any[];
      for (let site = 0; site < 5; site++) {
        plan[`site${site}`] = { status: 1 };
        results.push(...Array.from({ length: 60 }, (_, i) => ({ id: `${site}-${i}` })));
      }

      // 等 $subscribe 的 post flush 跑完（Pinia 用 Vue 调度器，flush: "post" 不是同步回调）
      await nextTick();

      // 节流窗口内：不应有任何写盘（修复前这里会有 300+ 次全量序列化）
      expect(setItemSpy).not.toHaveBeenCalled();

      vi.advanceTimersByTime(500);

      expect(setItemSpy).toHaveBeenCalledTimes(1);
      const saved = JSON.parse(sessionStorage.getItem(RUNTIME_KEY) as string);
      expect(saved.search.searchResult).toHaveLength(300);
      expect(Object.keys(saved.search.searchPlan)).toHaveLength(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it("配额不足时降级：丢弃两个 searchResult 但仍保存其余状态（修复前是整份静默丢失）", async () => {
    vi.useFakeTimers();
    try {
      const store = await loadRuntimeStore();
      const originalSetItem = sessionStorage.setItem.bind(sessionStorage);
      const spy = vi.spyOn(sessionStorage, "setItem").mockImplementation((key: string, value: string) => {
        const parsed = JSON.parse(value);
        // 只在包含搜索结果时抛出配额错误，模拟 sessionStorage 写满
        if (parsed?.search?.searchResult?.length > 0) {
          throw new DOMException("QuotaExceededError", "QuotaExceededError");
        }
        originalSetItem(key, value);
      });

      store.search.searchKey = "keep-me";
      (store.search.searchResult as any[]).push({ id: 1 });
      await nextTick();
      vi.advanceTimersByTime(500);

      expect(spy).toHaveBeenCalled();
      const saved = JSON.parse(sessionStorage.getItem(RUNTIME_KEY) as string);
      expect(saved.search.searchKey).toBe("keep-me");
      expect(saved.search.searchResult).toEqual([]);
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });
});
