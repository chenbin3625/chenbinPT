/**
 * options-overview-b 的修复回归网（OPTIONSOVERVIEW-6/7/8/9）。
 *
 * 每条用例都打在**真实渲染 / 真实副作用**上，旧实现下会红：
 * - 6：搜索页真的渲染出 `.quick-site-filter`，且关掉 `searchEntity.quickSiteFilter` 后消失（不再是空开关）；
 * - 7：ClientStatusDialog 的下载器筛选行可聚焦、能报出 aria-pressed、Enter/Space 能切换筛选；
 * - 8：日期预设写进筛选字典的上界是 Infinity，系统时间前进 61 秒后仍显示「今天」且 radio 仍有选中项；
 * - 9：暂停/继续全部失败时 snackbar 用 error 色（与 recheck/moveQueue 一致）。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const sendMessageMock = vi.hoisted(() => vi.fn());
vi.mock("@/messages.ts", () => ({ sendMessage: sendMessageMock, onMessage: vi.fn() }));
vi.mock("file-saver", () => ({ saveAs: vi.fn() }));

/** `getDownloaderMetaData` 依赖 Vite 的 `import.meta.glob`，单测环境下拿不到实体模块 */
vi.mock("@ptd/downloader", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getDownloaderMetaData: async (type: string) => ({ type, name: type, feature: {}, advanceAddTorrentOptions: {} }),
    getDownloaderIcon: () => "",
  };
});

/** 站点名 / favicon 子组件会去读 metadata store 并打后台消息，这里只关心父组件结构 */
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
      setup: (props) => () => h("i", { class: "stub-site-favicon" }, props.siteId),
    }),
  };
});

/**
 * `SearchEntity/utils/filter.ts` 在模块求值期就创建 store / 调 `$onReady`；
 * 这里换成可控的 ref，既服务 SearchFilterBar，也服务 SearchEntity/Index.vue 的挂载。
 */
const filterMock = vi.hoisted(() => ({ state: {} as Record<string, any> }));
vi.mock("@/options/views/Overview/SearchEntity/utils/filter.ts", async () => {
  const { ref } = await import("vue");
  const { vi: vitest } = await import("vitest");

  const advanceItemPropsRef = ref<Record<string, any>>({ site: [], tags: [] });
  const advanceFilterDictRef = ref<Record<string, any>>({});
  const tableWaitFilterRef = ref("");
  const tableFilterRef = ref("");
  const updateTableFilterValueFn = vitest.fn();
  const buildFilterDictFn = vitest.fn();
  const buildAdvanceItemPropsFn = vitest.fn();
  const tableFilterFn = vitest.fn(() => true);

  filterMock.state = {
    advanceItemPropsRef,
    advanceFilterDictRef,
    tableWaitFilterRef,
    tableFilterRef,
    updateTableFilterValueFn,
    buildFilterDictFn,
    buildAdvanceItemPropsFn,
    tableFilterFn,
  };

  return { tableCustomFilter: filterMock.state };
});

import { mountOptionsView, prepareOptionsPinia } from "../../helpers/optionsView.ts";

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

let SearchEntityView: any;
let SearchFilterBar: any;
let ClientStatusDialog: any;
let MyClientView: any;

beforeAll(async () => {
  prepareOptionsPinia();
  SearchEntityView = (await import("@/options/views/Overview/SearchEntity/Index.vue")).default;
  SearchFilterBar = (await import("@/options/views/Overview/SearchEntity/SearchFilterBar.vue")).default;
  ClientStatusDialog = (await import("@/options/views/Overview/MyClient/ClientStatusDialog.vue")).default;
  MyClientView = (await import("@/options/views/Overview/MyClient/Index.vue")).default;
});

/** 每个用例前把 filter mock 复位到「无筛选」 */
function resetFilterMock() {
  filterMock.state.advanceFilterDictRef.value = emptyDict();
  filterMock.state.advanceItemPropsRef.value = { site: ["mteam"], tags: [] };
  filterMock.state.tableWaitFilterRef.value = "";
  filterMock.state.tableFilterRef.value = "";
  filterMock.state.updateTableFilterValueFn.mockClear();
}

beforeEach(() => {
  resetFilterMock();
});

// ── OPTIONSOVERVIEW-6 ─────────────────────────────────────────────────────

describe("OPTIONSOVERVIEW-6：搜索页重新挂载快速站点筛选条", () => {
  it("配置开启时渲染筛选条，关闭后不再渲染（配置项不再是空开关）", async () => {
    const pinia = prepareOptionsPinia();
    const { useConfigStore } = await import("@/options/stores/config.ts");
    const { useMetadataStore } = await import("@/options/stores/metadata.ts");
    const { useRuntimeStore } = await import("@/options/stores/runtime.ts");

    const meta = useMetadataStore(pinia);
    meta.sites = { mteam: { id: "mteam", url: "https://example.com/" } } as any;
    const runtime = useRuntimeStore(pinia);
    runtime.search = {
      ...runtime.search,
      searchKey: "matrix",
      searchResult: [{ site: "mteam", id: "1", uniqueId: "mteam-1", title: "x" }],
    } as any;

    const config = useConfigStore(pinia);
    config.searchEntity.quickSiteFilter = true;

    const view = mountOptionsView(SearchEntityView, { pinia, router: true });
    await view.settle(80);

    expect(view.$(".quick-site-filter"), "开关开启时应有快速站点筛选条").not.toBeNull();
    // 「全部」+ 每个站点各一颗按钮
    expect(view.$$(".quick-site-filter__option")).toHaveLength(2);
    expect(view.$(".search-filter-bar"), "原来的下拉筛选条必须还在").not.toBeNull();

    config.searchEntity.quickSiteFilter = false;
    await view.settle();

    expect(view.$(".quick-site-filter"), "开关关闭后筛选条不应再渲染").toBeNull();
    // 表格仍在（不是整页崩掉）
    expect(view.$(".ant-table"), "关掉开关不应影响搜索结果表格").not.toBeNull();

    view.unmount();
  });
});

// ── OPTIONSOVERVIEW-7 ─────────────────────────────────────────────────────

describe("OPTIONSOVERVIEW-7：下载器筛选行可键盘操作", () => {
  /** a-modal 内容 teleport 到 body，按最后一个 .ant-list 取本次挂载的列表 */
  function listItems(): HTMLElement[] {
    const list = Array.from(document.querySelectorAll<HTMLElement>(".ant-list")).at(-1);
    return Array.from(list?.querySelectorAll<HTMLElement>(".ant-list-item") ?? []);
  }

  async function mountDialog() {
    const pinia = prepareOptionsPinia();
    const { useMetadataStore } = await import("@/options/stores/metadata.ts");
    const meta = useMetadataStore(pinia);
    meta.downloaders = {
      d1: { id: "d1", type: "qbittorrent", name: "QB", address: "http://qb.local", enabled: true },
      d2: { id: "d2", type: "transmission", name: "TR", address: "http://tr.local", enabled: true },
    } as any;

    const utils = await import("@/options/views/Overview/MyClient/utils.ts");
    utils.selectedDownloaderIds.value = [];

    const view = mountOptionsView(ClientStatusDialog, { pinia, props: { modelValue: true } });
    await view.settle(60);
    return { view, utils };
  }

  it("筛选行可聚焦、报出 aria-pressed，Enter/Space 都能切换筛选", async () => {
    const { view, utils } = await mountDialog();

    let items = listItems();
    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(item.getAttribute("role")).toBe("button");
      expect(item.getAttribute("tabindex")).toBe("0");
      // 未选择任何下载器时 = 不过滤，两个都算 active
      expect(item.getAttribute("aria-pressed")).toBe("true");
    }

    // Enter 选中第一个下载器（只保留该下载器的种子）
    items[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await view.settle();
    expect(utils.selectedDownloaderIds.value).toEqual(["d1"]);

    items = listItems();
    expect(items[0]!.getAttribute("aria-pressed")).toBe("true");
    expect(items[1]!.getAttribute("aria-pressed")).toBe("false");

    // Space 追加第二个下载器
    items[1]!.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }));
    await view.settle();
    expect(utils.selectedDownloaderIds.value).toEqual(["d1", "d2"]);

    view.unmount();
    utils.selectedDownloaderIds.value = [];
  });
});

// ── OPTIONSOVERVIEW-8 ─────────────────────────────────────────────────────

describe("OPTIONSOVERVIEW-8：日期预设的上界是 Infinity，不随时间回落", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("选择「今天」后上界为 Infinity；系统时间前进 61 秒仍显示「今天」且 radio 仍选中", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const base = new Date("2026-10-06T10:00:00");
    vi.setSystemTime(base);

    const pinia = prepareOptionsPinia();
    const view = mountOptionsView(SearchFilterBar, { pinia });
    await view.settle();

    view.$<HTMLButtonElement>('[data-filter="time"]')!.click();
    await view.settle();
    const menu = Array.from(document.querySelectorAll<HTMLElement>(".search-filter-menu")).at(-1)!;
    const dates = Array.from(menu.querySelectorAll<HTMLInputElement>("input[type=radio]"));
    expect(dates).toHaveLength(5);

    dates[0]!.click(); // 今天
    await view.settle();

    const time = filterMock.state.advanceFilterDictRef.value.time as [number, number];
    expect(time[1], "预设上界应为「直到现在」而不是点击那一刻的死值").toBe(Infinity);
    expect(time[0]).toBe(new Date("2026-10-06T00:00:00").getTime());
    expect(view.$('[data-filter="time"]')?.textContent).toContain("今天");

    // 时间前进 61 秒（旧实现用 60 秒时间差猜预设，此刻会回落到自定义区间）。
    // 组件只在有响应式依赖变化时重渲染，这里改一下搜索框绑定的值来触发，模拟任意一次页面更新。
    vi.setSystemTime(new Date(base.getTime() + 61_000));
    filterMock.state.tableWaitFilterRef.value = "matrix";
    await view.settle();

    expect(view.$('[data-filter="time"]')?.textContent).toContain("今天");
    expect(menu.querySelector(".ant-radio-wrapper-checked"), "预设 radio 不应变成无选中态").not.toBeNull();

    view.unmount();
  });

  it("自定义日期区间仍走 picker 的固定上界", async () => {
    const pinia = prepareOptionsPinia();
    const view = mountOptionsView(SearchFilterBar, { pinia });
    await view.settle();

    // 模拟用户在 picker 里选了区间（组件对外只暴露 setCustomDate 行为，这里直接落字典再断言展示）
    const start = new Date("2026-09-01T00:00:00").getTime();
    const end = new Date("2026-09-30T00:00:00").getTime();
    filterMock.state.advanceFilterDictRef.value.time = [start, end];
    await view.settle();

    expect(view.$('[data-filter="time"]')?.textContent).toContain("2026-09-01 ~ 2026-09-30");
    view.unmount();
  });
});

// ── OPTIONSOVERVIEW-9 ─────────────────────────────────────────────────────

const MYCLIENT_TORRENTS = [
  {
    clientId: "d1",
    id: "hash-1",
    infoHash: "hash-1",
    name: "下载中的种子",
    progress: 12.6,
    totalSize: 1024,
    savePath: "/downloads",
    label: "",
    state: "downloading",
    uploadSpeed: 0,
    downloadSpeed: 0,
    ratio: 1.5,
  },
  {
    clientId: "d1",
    id: "hash-2",
    infoHash: "hash-2",
    name: "已暂停的种子",
    progress: 100,
    totalSize: 2048,
    savePath: "/downloads",
    label: "",
    state: "paused",
    uploadSpeed: 0,
    downloadSpeed: 0,
    ratio: 1.2,
  },
];

describe("OPTIONSOVERVIEW-9：暂停/继续全部失败时用 error 色提示", () => {
  let pauseResult: boolean;

  async function mountMyClient() {
    const pinia = prepareOptionsPinia();
    const { useMetadataStore } = await import("@/options/stores/metadata.ts");
    const { useRuntimeStore } = await import("@/options/stores/runtime.ts");
    const meta = useMetadataStore(pinia);
    meta.downloaders = {
      d1: { id: "d1", type: "qbittorrent", name: "QB", address: "http://qb.local", enabled: true },
    } as any;

    const utils = await import("@/options/views/Overview/MyClient/utils.ts");
    utils.autoRefreshRunning.value = false;
    utils.torrents.value = {};
    utils.selectedDownloaderIds.value = [];
    utils.suspendedDownloaders.value = new Set();

    pauseResult = false;
    sendMessageMock.mockReset();
    sendMessageMock.mockImplementation(async (type: string) => {
      if (type === "getClientTorrents") return JSON.parse(JSON.stringify(MYCLIENT_TORRENTS));
      if (type === "pauseClientTorrent" || type === "resumeClientTorrent") return pauseResult;
      return undefined;
    });

    const runtimeStore = useRuntimeStore(pinia);
    const showSnakebar = vi.spyOn(runtimeStore, "showSnakebar").mockImplementation(() => {});

    const view = mountOptionsView(MyClientView, { pinia, router: true });
    await view.settle(150);
    return { view, showSnakebar };
  }

  it("0 个成功时 color 为 error，全部成功时为 success", async () => {
    const { view, showSnakebar } = await mountMyClient();

    const { i18nInstance } = await import("@/options/plugins/i18n.ts");
    const t = i18nInstance.global.t;
    const before = view.$$("button").length;
    expect(before, "页面应渲染出操作按钮").toBeGreaterThan(0);

    // 下载器拒绝暂停
    const pauseBtn = view.$<HTMLButtonElement>(`.ant-table button[title="${t("MyClient.action.pause")}"]`);
    expect(pauseBtn, "应找到暂停按钮").not.toBeNull();
    pauseBtn!.click();
    await view.settle(60);

    expect(showSnakebar).toHaveBeenCalledTimes(1);
    expect(showSnakebar.mock.calls[0]![1]).toMatchObject({ color: "error" });

    // 下载器拒绝继续
    const resumeBtn = view.$<HTMLButtonElement>(`.ant-table button[title="${t("MyClient.action.resume")}"]`);
    expect(resumeBtn, "应找到继续按钮").not.toBeNull();
    resumeBtn!.click();
    await view.settle(60);

    expect(showSnakebar).toHaveBeenCalledTimes(2);
    expect(showSnakebar.mock.calls[1]![1]).toMatchObject({ color: "error" });

    // 成功路径仍然是 success
    pauseResult = true;
    pauseBtn!.click();
    await view.settle(60);

    expect(showSnakebar).toHaveBeenCalledTimes(3);
    expect(showSnakebar.mock.calls[2]![1]).toMatchObject({ color: "success" });

    view.unmount();
  });
});
