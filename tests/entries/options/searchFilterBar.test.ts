import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mountOptionsView, prepareOptionsPinia } from "../../helpers/optionsView.ts";

vi.mock("@/options/components/SiteName.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    default: defineComponent({
      props: { siteId: String },
      setup: (props) => () => h("span", props.siteId),
    }),
  };
});

const filterMock = vi.hoisted(() => ({ state: {} as Record<string, any> }));
vi.mock("@/options/views/Overview/SearchEntity/utils/filter.ts", async () => {
  const { ref } = await import("vue");
  const { vi: vitest } = await import("vitest");
  const advanceFilterDictRef = ref<Record<string, any>>({});
  const advanceItemPropsRef = ref<Record<string, any>>({});
  const tableWaitFilterRef = ref("");
  const updateTableFilterValueFn = vitest.fn();
  const buildFilterDictFn = vitest.fn();
  filterMock.state = {
    advanceFilterDictRef,
    advanceItemPropsRef,
    tableWaitFilterRef,
    updateTableFilterValueFn,
    buildFilterDictFn,
  };
  return { tableCustomFilter: filterMock.state };
});

const emptyDict = () => ({
  site: { required: [], exclude: [] },
  tags: { required: [], exclude: [] },
  status: { required: [], exclude: [] },
  text: { required: [], exclude: [] },
  time: [-Infinity, Infinity],
  size: [-Infinity, Infinity],
  seeders: [-Infinity, Infinity],
  leechers: [-Infinity, Infinity],
  completed: [-Infinity, Infinity],
});

let Bar: any;
beforeAll(async () => {
  prepareOptionsPinia();
  Bar = (await import("@/options/views/Overview/SearchEntity/SearchFilterBar.vue")).default;
});

beforeEach(() => {
  prepareOptionsPinia();
  filterMock.state.advanceFilterDictRef.value = emptyDict();
  filterMock.state.advanceItemPropsRef.value = {
    site: ["a", "b", "c"],
    tags: [{ name: "4K" }, { name: "HDR" }],
  };
  filterMock.state.tableWaitFilterRef.value = "";
  filterMock.state.updateTableFilterValueFn.mockClear();
});

describe("搜索结果下拉筛选", () => {
  it("默认展示全部筛选项；多选后只展示首项和 +n", async () => {
    const view = mountOptionsView(Bar, { pinia: prepareOptionsPinia() });
    await view.settle();
    expect(view.$$(".search-filter-chip")).toHaveLength(10);
    expect(view.$('[data-filter="site"]')?.textContent).toContain("站点");

    filterMock.state.advanceFilterDictRef.value.site.required = ["a", "b", "c"];
    await view.settle();
    expect(view.$('[data-filter="site"]')?.textContent).toContain("站点：a");
    expect(view.$('[data-filter="site"] .search-filter-count')?.textContent).toContain("+2");
    view.unmount();
  });

  it("大小和人数预设是单选，选择后更新现有查询串", async () => {
    const view = mountOptionsView(Bar, { pinia: prepareOptionsPinia() });
    await view.settle();
    view.$<HTMLButtonElement>('[data-filter="seeders"]')!.click();
    await view.settle();
    const menu = Array.from(document.querySelectorAll<HTMLElement>(".search-filter-menu")).at(-1)!;
    const options = Array.from(menu.querySelectorAll<HTMLElement>("input[type=radio]"));
    expect(options).toHaveLength(4);
    expect(menu.textContent).not.toContain("全部");
    options[1]!.click();
    await view.settle();
    expect(filterMock.state.advanceFilterDictRef.value.seeders).toEqual([10, Infinity]);
    expect(filterMock.state.updateTableFilterValueFn).toHaveBeenCalledTimes(1);
    expect(view.$('[data-filter="seeders"]')?.textContent).toContain("10");
    const clear = menu.querySelector<HTMLButtonElement>(".search-filter-clear");
    expect(clear?.textContent).toContain("清除");
    clear!.click();
    await view.settle();
    expect(filterMock.state.advanceFilterDictRef.value.seeders).toEqual([-Infinity, Infinity]);
    expect(view.$('[data-filter="seeders"]')?.textContent).toBe("上传人数");
    view.unmount();
  });

  it("站点可以多选且筛选状态即时同步", async () => {
    const view = mountOptionsView(Bar, { pinia: prepareOptionsPinia() });
    await view.settle();
    view.$<HTMLButtonElement>('[data-filter="site"]')!.click();
    await view.settle();
    const sites = Array.from(document.querySelectorAll<HTMLInputElement>(".search-filter-menu input[type=checkbox]"));
    expect(sites).toHaveLength(3);
    sites[0]!.click();
    sites[1]!.click();
    await view.settle();
    expect(filterMock.state.advanceFilterDictRef.value.site.required).toEqual(["a", "b"]);
    expect(filterMock.state.updateTableFilterValueFn).toHaveBeenCalledTimes(2);
    expect(view.$('[data-filter="site"]')?.textContent).toContain("站点：a");
    expect(view.$('[data-filter="site"] .search-filter-count')?.textContent).toBe("+1");
    view.unmount();
  });

  it("日期预设可选且清空后恢复默认文案", async () => {
    const view = mountOptionsView(Bar, { pinia: prepareOptionsPinia() });
    await view.settle();
    view.$<HTMLButtonElement>('[data-filter="time"]')!.click();
    await view.settle();
    const menu = Array.from(document.querySelectorAll<HTMLElement>(".search-filter-menu")).at(-1)!;
    const dates = Array.from(menu.querySelectorAll<HTMLInputElement>("input[type=radio]"));
    expect(dates).toHaveLength(5);
    expect(menu.textContent).not.toContain("全部");
    dates[0]!.click();
    await view.settle();
    expect(filterMock.state.advanceFilterDictRef.value.time[0]).toBeGreaterThan(0);
    expect(view.$('[data-filter="time"]')?.textContent).toContain("今天");
    menu.querySelector<HTMLButtonElement>(".search-filter-clear")!.click();
    await view.settle();
    expect(filterMock.state.advanceFilterDictRef.value.time).toEqual([-Infinity, Infinity]);
    expect(view.$('[data-filter="time"]')?.textContent).toBe("日期");
    view.unmount();
  });

  it("已有排除站点筛选在标签上明确标示为排除", async () => {
    filterMock.state.advanceFilterDictRef.value.site.exclude = ["c"];
    const view = mountOptionsView(Bar, { pinia: prepareOptionsPinia() });
    await view.settle();
    expect(view.$('[data-filter="site"]')?.textContent).toContain("排除 c");
    view.unmount();
  });

  it("结果筛选输入框始终在标签旁边，编辑时同步查询字典", async () => {
    const view = mountOptionsView(Bar, { pinia: prepareOptionsPinia() });
    await view.settle();
    const input = view.$<HTMLInputElement>('.search-filter-bar input[placeholder="过滤搜索结果"]');
    expect(input).not.toBeNull();
    input!.value = "1080p";
    input!.dispatchEvent(new Event("input", { bubbles: true }));
    await view.settle();
    expect(filterMock.state.tableWaitFilterRef.value).toBe("1080p");
    expect(filterMock.state.buildFilterDictFn).toHaveBeenCalledWith("1080p");
    view.unmount();
  });

  it("清除关键词不会删除独立的排除词", async () => {
    filterMock.state.advanceFilterDictRef.value.text = { required: ["movie"], exclude: ["cam"] };
    const view = mountOptionsView(Bar, { pinia: prepareOptionsPinia() });
    await view.settle();
    view.$<HTMLButtonElement>('[data-filter="text"]')!.click();
    await view.settle();
    const menu = Array.from(document.querySelectorAll<HTMLElement>(".search-filter-menu")).at(-1)!;
    menu.querySelector<HTMLButtonElement>(".search-filter-clear")!.click();
    await view.settle();
    expect(filterMock.state.advanceFilterDictRef.value.text).toEqual({ required: [], exclude: ["cam"] });
    expect(view.$('[data-filter="text"]')?.textContent).toBe("关键词");
    expect(view.$('[data-filter="exclude"]')?.textContent).toContain("cam");
    view.unmount();
  });
});
