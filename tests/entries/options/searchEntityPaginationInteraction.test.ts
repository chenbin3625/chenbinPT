/**
 * 搜索结果页的页码行为。
 *
 * antd Table 的 `innerPagination.current` 只在渲染时被钳制到有效范围：换一批数据后它仍停在
 * 上一次的页码。旧实现没有传 `current`，实测「在第 3 页重新搜索」会随着结果流式写入一路跳回
 * 第 3 页；筛选条件变化时也只是被钳制而不是回到第 1 页。这里锁定视图层的受控页码。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { mountOptionsView, prepareOptionsPinia } from "../../helpers/optionsView.ts";

vi.mock("@/messages.ts", () => ({ sendMessage: vi.fn().mockResolvedValue(undefined), onMessage: vi.fn() }));

const DESKTOP_WIDTH = 1024;
const ROW_COUNT = 8;
const PAGE_SIZE = 5;

let SearchEntityView: any;
let filterModule: typeof import("@/options/views/Overview/SearchEntity/utils/filter.ts");

beforeAll(async () => {
  const pinia = prepareOptionsPinia();
  const { useMetadataStore } = await import("@/options/stores/metadata.ts");
  (useMetadataStore(pinia) as any).$save = vi.fn(async () => undefined);
  filterModule = await import("@/options/views/Overview/SearchEntity/utils/filter.ts");
  SearchEntityView = (await import("@/options/views/Overview/SearchEntity/Index.vue")).default;
});

beforeEach(() => {
  window.innerWidth = DESKTOP_WIDTH;
  window.dispatchEvent(new Event("resize"));
});

afterEach(() => {
  window.innerWidth = DESKTOP_WIDTH;
});

function makeRows(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    site: "mteam",
    id: String(index + 1),
    uniqueId: `mteam-${index + 1}`,
    title: `The.Matrix.1999.2160p.BluRay.REMUX.${index + 1}`,
    size: 1024 * 1024 * 1024,
    seeders: 3,
    leechers: 1,
    completed: 100,
    comments: 2,
    time: Date.now(),
    url: `https://example.com/torrent/${index + 1}`,
  }));
}

async function mountPage() {
  const pinia = prepareOptionsPinia();

  const { useMetadataStore } = await import("@/options/stores/metadata.ts");
  const metadataStore = useMetadataStore(pinia);
  (metadataStore as any).$save = vi.fn(async () => undefined);
  metadataStore.sites = { mteam: { id: "mteam", url: "https://example.com/" } } as any;

  const { useConfigStore } = await import("@/options/stores/config.ts");
  const configStore = useConfigStore(pinia);
  // updateTableBehavior 在 saveTableBehavior 开启时会落盘（排序变化也会走这里），单测里没有持久化插件
  (configStore as any).$save = vi.fn(async () => undefined);
  configStore.tableBehavior.SearchEntity.itemsPerPage = PAGE_SIZE;

  const { useRuntimeStore } = await import("@/options/stores/runtime.ts");
  const runtimeStore = useRuntimeStore(pinia);
  runtimeStore.search = {
    ...runtimeStore.search,
    startAt: Date.now(),
    endAt: Date.now(),
    isSearching: false,
    searchKey: "matrix",
    searchPlanKey: "all",
    searchResult: makeRows(ROW_COUNT),
  } as any;

  const view = mountOptionsView(SearchEntityView, { pinia, router: true });
  await view.settle(80);
  return { view, runtimeStore };
}

function activePage(view: ReturnType<typeof mountOptionsView>) {
  return view.$<HTMLElement>(".ant-pagination-item-active")?.textContent?.trim();
}

async function goToPage2(view: any) {
  view.$(".ant-pagination-item-2")!.click();
  await view.settle();
}

describe("搜索结果页页码", () => {
  it("翻页正常，且新一轮搜索回到第 1 页", async () => {
    const { view, runtimeStore } = await mountPage();
    expect(view.host.querySelectorAll(".ant-table-tbody tr.ant-table-row")).toHaveLength(PAGE_SIZE);
    expect(activePage(view)).toBe("1");

    await goToPage2(view);
    expect(activePage(view)).toBe("2");
    expect(view.host.querySelectorAll(".ant-table-tbody tr.ant-table-row")).toHaveLength(ROW_COUNT - PAGE_SIZE);

    // 新一轮搜索（startAt 变化）后，页码不应停留在上一轮的第 2 页
    runtimeStore.search.startAt = Date.now() + 1000;
    await view.settle();
    expect(activePage(view)).toBe("1");

    view.unmount();
  });

  it("筛选条件变化后回到第 1 页", async () => {
    const { view } = await mountPage();
    await goToPage2(view);
    expect(activePage(view)).toBe("2");

    const dict = filterModule.tableCustomFilter.advanceFilterDictRef.value as any;
    (dict.site ??= { required: [], exclude: [] }).required = ["mteam"];
    filterModule.updateTableFilterNow();
    await view.settle();

    expect(activePage(view)).toBe("1");
    // 8 条结果全部属于 mteam，筛选后仍有 8 条（说明重置来自筛选动作，而不是结果变少被钳制）
    expect(view.host.querySelectorAll(".ant-table-tbody tr.ant-table-row")).toHaveLength(PAGE_SIZE);

    view.unmount();
  });
});
