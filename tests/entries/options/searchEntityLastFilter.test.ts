/**
 * V-5：「记住上次筛选」必须在 metadata store 恢复完成之后再初始化。
 *
 * 缺陷：`SearchEntity/utils/filter.ts` 在**模块求值期**读 `metadataStore.lastSearchFilter`，
 * 而该文件是懒加载路由 chunk —— 首次导航（含深链）时 metadata store 才刚创建，
 * `chrome.storage` 的水合尚未 resolve，于是读到的是 state 初始值 `""`，上次筛选静默丢失。
 *
 * 这里用假的 metadata store 精确控制「恢复完成」的时机（它比真实 store 更可控：
 * 真实 store 的恢复时序由 chrome.storage 决定），验证：
 * - 恢复完成后才灌入上次筛选（含高级筛选字典）；
 * - 开关关闭时不恢复历史残留，也不回写；
 * - 恢复本身不会触发一次回声写入；
 * - 用户真的改了筛选时照旧写入。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";

// @ptd/site → adapter.ts → messages.ts 会读取 vite 的构建期常量 __BROWSER__（单测环境下不存在）
vi.hoisted(() => {
  (globalThis as any).__BROWSER__ = "chrome";
});

const mocks = vi.hoisted(() => {
  const state = {
    readyCallbacks: [] as Array<() => void>,
    lastSearchFilter: "" as string | undefined,
    setLastSearchFilter: vi.fn(),
  };

  return {
    state,
    metadataStore: {
      get lastSearchFilter() {
        return state.lastSearchFilter;
      },
      $onReady: (callback?: () => void) =>
        new Promise<void>((resolve) => {
          state.readyCallbacks.push(() => {
            resolve();
            callback?.();
          });
        }),
      setLastSearchFilter: (value: string) => {
        state.setLastSearchFilter(value);
      },
    },
    configStore: { searchEntity: { saveLastFilter: true } },
    runtimeStore: { search: { searchResult: [] } },
  };
});

vi.mock("@/options/stores/metadata.ts", () => ({ useMetadataStore: () => mocks.metadataStore }));
vi.mock("@/options/stores/config.ts", () => ({ useConfigStore: () => mocks.configStore }));
vi.mock("@/options/stores/runtime.ts", () => ({ useRuntimeStore: () => mocks.runtimeStore }));

/** 每个用例都重新求值 filter.ts（模块求值期的行为正是本缺陷的现场） */
async function loadFilter() {
  vi.resetModules();
  const module = await import("@/options/views/Overview/SearchEntity/utils/filter.ts");
  return module.tableCustomFilter;
}

/** 模拟 metadata store 的 chrome.storage 水合完成 */
async function finishStoreRestore() {
  const callbacks = [...mocks.state.readyCallbacks];
  mocks.state.readyCallbacks.length = 0;
  callbacks.forEach((callback) => callback());
  await nextTick();
}

beforeEach(() => {
  vi.useFakeTimers();
  mocks.state.readyCallbacks.length = 0;
  mocks.state.lastSearchFilter = "";
  mocks.state.setLastSearchFilter.mockClear();
  mocks.configStore.searchEntity.saveLastFilter = true;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("V-5：恢复完成后才初始化筛选词", () => {
  it("水合完成前是空串，完成后灌入上次筛选与高级筛选字典", async () => {
    const filter = await loadFilter();
    expect(filter.tableWaitFilterRef.value).toBe("");

    mocks.state.lastSearchFilter = "tags:uhd status:seeding";
    await finishStoreRestore();

    expect(filter.tableWaitFilterRef.value).toBe("tags:uhd status:seeding");
    expect(filter.advanceFilterDictRef.value.tags.required).toEqual(["uhd"]);
    expect(filter.advanceFilterDictRef.value.status.required).toEqual(["seeding"]);
  });

  it("开关关闭时不恢复历史残留", async () => {
    mocks.configStore.searchEntity.saveLastFilter = false;
    mocks.state.lastSearchFilter = "tags:uhd";

    const filter = await loadFilter();
    await finishStoreRestore();

    expect(filter.tableWaitFilterRef.value).toBe("");
    expect(filter.advanceFilterDictRef.value.tags.required).toEqual([]);
  });

  it("输入框已有内容时不覆盖", async () => {
    const filter = await loadFilter();
    filter.tableWaitFilterRef.value = "user-typed";

    mocks.state.lastSearchFilter = "tags:uhd";
    await finishStoreRestore();

    expect(filter.tableWaitFilterRef.value).toBe("user-typed");
  });

  it("恢复本身不会回声写入 lastSearchFilter", async () => {
    const filter = await loadFilter();
    mocks.state.lastSearchFilter = "tags:uhd";
    await finishStoreRestore();

    vi.advanceTimersByTime(1000); // 越过 refDebounced 窗口，让 watcher 有机会执行
    await nextTick();

    expect(mocks.state.setLastSearchFilter).not.toHaveBeenCalled();
  });

  it("用户改动筛选时照旧写入（不会因为上面的抑制而漏写）", async () => {
    const filter = await loadFilter();
    mocks.state.lastSearchFilter = "tags:uhd";
    await finishStoreRestore();

    filter.tableWaitFilterRef.value = "site:mteam tags:uhd";
    vi.advanceTimersByTime(1000);
    await nextTick();

    expect(mocks.state.setLastSearchFilter).toHaveBeenCalledWith("site:mteam tags:uhd");
  });
});
