/**
 * seeders / leechers / completed 的范围筛选必须支持「查询串 → 字典 → 查询串」往返。
 *
 * 缺陷：`filter.ts` 没有为这三个字段配置 parse/build，`buildFilterDictFn("seeders:10")`
 * 得到的是字符串 "10"；`stringifyFilterDictFn` 用 `Number.isFinite` 判断边界，字符串会被当成
 * 「未设置」，筛选被静默丢弃、chip 退回 0~∞。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";

vi.hoisted(() => {
  (globalThis as any).__BROWSER__ = "chrome";
});

const mocks = vi.hoisted(() => ({
  metadataStore: {
    lastSearchFilter: "",
    $onReady: (callback?: () => void) => Promise.resolve().then(() => callback?.()),
    setLastSearchFilter: vi.fn(),
  },
  configStore: { searchEntity: { saveLastFilter: false } },
  runtimeStore: { search: { searchResult: [] as any[] } },
}));

vi.mock("@/options/stores/metadata.ts", () => ({ useMetadataStore: () => mocks.metadataStore }));
vi.mock("@/options/stores/config.ts", () => ({ useConfigStore: () => mocks.configStore }));
vi.mock("@/options/stores/runtime.ts", () => ({ useRuntimeStore: () => mocks.runtimeStore }));
vi.mock("@/options/components/SiteName.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    default: defineComponent({
      name: "SiteNameStub",
      props: { siteId: String, tag: { type: String, default: "span" } },
      setup: (props) => () => h(props.tag, { class: "stub-site-name" }, props.siteId),
    }),
  };
});

import { mountOptionsView, prepareOptionsPinia } from "../../helpers/optionsView.ts";

async function loadFilter() {
  return (await import("@/options/views/Overview/SearchEntity/utils/filter.ts")).tableCustomFilter;
}

beforeEach(() => {
  prepareOptionsPinia();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("seeders / leechers / completed 范围筛选", () => {
  it("`seeders:10` 的字典值是 number，往返后仍保留 ≥10", async () => {
    const filter = await loadFilter();

    filter.buildFilterDictFn("seeders:10");
    expect(filter.advanceFilterDictRef.value.seeders).toEqual([10, Infinity]);

    const text = filter.stringifyFilterDictFn();
    expect(text).toContain("seeders:10");

    filter.buildFilterDictFn(text);
    expect(filter.advanceFilterDictRef.value.seeders).toEqual([10, Infinity]);
  });

  it("leechers / completed 同样不会被 `Number.isFinite` 丢弃", async () => {
    const filter = await loadFilter();

    filter.buildFilterDictFn("leechers:10 completed:50");
    expect(filter.advanceFilterDictRef.value.leechers).toEqual([10, Infinity]);
    expect(filter.advanceFilterDictRef.value.completed).toEqual([50, Infinity]);

    const text = filter.stringifyFilterDictFn();
    expect(text).toContain("leechers:10");
    expect(text).toContain("completed:50");
  });

  it("往返后的 seeders 范围仍能过滤结果，chip 显示 ≥10", async () => {
    vi.useFakeTimers();
    const filter = await loadFilter();

    filter.buildFilterDictFn("seeders:10");
    filter.tableWaitFilterRef.value = filter.stringifyFilterDictFn();
    await nextTick();
    vi.advanceTimersByTime(1000);
    await nextTick();

    expect(filter.tableFilterFn(undefined, filter.tableFilterRef.value, { raw: { title: "a", seeders: 10 } })).toBe(
      true,
    );
    expect(filter.tableFilterFn(undefined, filter.tableFilterRef.value, { raw: { title: "b", seeders: 3 } })).toBe(
      false,
    );

    vi.useRealTimers();
    const { default: SearchFilterBar } = await import("@/options/views/Overview/SearchEntity/SearchFilterBar.vue");
    const view = mountOptionsView(SearchFilterBar, { pinia: prepareOptionsPinia() });
    await view.settle();
    expect(view.$('[data-filter="seeders"]')?.textContent).toContain("10");
    view.unmount();
  });
});
