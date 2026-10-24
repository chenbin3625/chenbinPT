/**
 * 搜索结果页「点击种子标签一键筛选」。
 *
 * 覆盖两端真实行为，而不是读源码：
 * 1. `TorrentTitleTd`：可筛选模式下标签会 emit `filter-tag`、暴露按钮语义（role/tabindex/aria-pressed/title）、
 *    已激活标签高亮；不传 `tagFilterable` 时保持纯展示（DownloadHistory / content-script 也复用该组件，
 *    那两处不能因为这次改动莫名变成可点击）。
 * 2. `SearchEntity/utils/filter.ts`：`toggleTagFilter` 直接改与筛选条共用的 `advanceFilterDictRef`，
 *    多标签是「且」关系，加入必选会摘掉同名排除项，特殊字符（空格 / 百分号）经筛选串往返后仍能命中。
 *
 * 注意：filter.ts 在**模块求值期**就 `useXxxStore()`；必须先 `prepareOptionsPinia()` 再动态 import，
 * 否则 `getActivePinia()` 直接抛错（时序说明见 tests/helpers/optionsView.ts）。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";

import { mountOptionsView, prepareOptionsPinia } from "../../helpers/optionsView.ts";

// TorrentTitleTd 会经 @ptd/social / messages.ts 引入构建期常量与后台消息，这里只做交互，不需要真实实现
vi.mock("@/messages.ts", () => ({ sendMessage: vi.fn(), onMessage: vi.fn() }));

// 下面三个 mock 只服务「挂载整个搜索结果页」的接线用例：Index.vue 的子组件会拉真实下载器 / 站点组件，
// 单测里既没有 Vite 的 import.meta.glob，也不需要它们的行为。
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
      setup: (props) => () => h("i", { class: "stub-site-favicon" }, props.siteId),
    }),
  };
});

const TAGS = [{ name: "中字", color: "pink-darken-1" }, { name: "Free", color: "#1976D2" }, { name: "完结" }] as any;

let TorrentTitleTd: any;
let SearchEntityView: any;
let pinia: ReturnType<typeof prepareOptionsPinia>;
let filterModule: typeof import("@/options/views/Overview/SearchEntity/utils/filter.ts");
let tableCustomFilter: typeof filterModule.tableCustomFilter;

beforeAll(async () => {
  pinia = prepareOptionsPinia();
  TorrentTitleTd = (await import("@/options/components/TorrentTitleTd.vue")).default;
  filterModule = await import("@/options/views/Overview/SearchEntity/utils/filter.ts");
  tableCustomFilter = filterModule.tableCustomFilter;
  // 搜索结果页视图同样在求值期碰 store，必须排在 prepareOptionsPinia() 之后
  SearchEntityView = (await import("@/options/views/Overview/SearchEntity/Index.vue")).default;
});

/** 每个用例都从「无筛选、标签纯展示偏好」的干净状态出发 */
beforeEach(async () => {
  const { useConfigStore } = await import("@/options/stores/config.ts");
  const configStore = useConfigStore(pinia);

  configStore.searchEntifyControl.showTorrentTag = true;
  configStore.searchEntifyControl.showTorrentSubtitle = false;
  configStore.searchEntifyControl.showSocialInformation = false;
  configStore.searchEntifyControl.maxTagCountBeforeGroup = 0;
  configStore.searchEntifyControl.hiddenTagNames = [];
  configStore.searchEntifyControl.tagClickToFilter = true;

  // 关闭「记住上次筛选」：否则 filter.ts 的 watcher 会在用例里触发 metadata 落盘（与本功能无关的噪声）
  configStore.searchEntity.saveLastFilter = false;
});

// ── TorrentTitleTd：标签的点击 / 键盘 / 已激活态 ───────────────────────────────

describe("种子标题标签（TorrentTitleTd 可筛选交互）", () => {
  function mountTitle(props: Record<string, unknown> = {}) {
    return mountOptionsView(TorrentTitleTd, {
      props: { item: { title: "种子标题", tags: TAGS }, ...props },
      pinia,
      router: true,
    });
  }

  it("tagFilterable 时标签是按钮：点击 emit filter-tag 且参数为标签名", async () => {
    const onFilterTag = vi.fn();
    const view = mountTitle({ tagFilterable: true, onFilterTag });
    await view.settle();

    const tags = view.$$(".ant-tag");
    expect(tags).toHaveLength(TAGS.length);

    for (const tag of tags) {
      expect(tag.classList.contains("ptd-torrent-tag--filterable"), "可筛选标签应有 pointer 类").toBe(true);
      expect(tag.getAttribute("role")).toBe("button");
      expect(tag.getAttribute("tabindex")).toBe("0");
      expect(tag.getAttribute("aria-pressed"), "未激活的标签 aria-pressed 为 false").toBe("false");
      // 原生 title 给出「点击会做什么」的提示（文案里含标签名）
      expect(tag.getAttribute("title")).toContain(tag.textContent!.trim());
    }

    // 点第二个标签（Free）：事件参数必须是标签名，而不是标签对象 / 索引
    tags[1]!.click();
    await view.settle();
    expect(onFilterTag).toHaveBeenCalledTimes(1);
    expect(onFilterTag).toHaveBeenCalledWith("Free");

    view.unmount();
  });

  it("不传 tagFilterable 时保持纯展示：不 emit、无筛选类 / role / tabindex / title", async () => {
    const onFilterTag = vi.fn();
    const view = mountTitle({ onFilterTag });
    await view.settle();

    const tags = view.$$(".ant-tag");
    expect(tags).toHaveLength(TAGS.length);
    for (const tag of tags) {
      expect(tag.classList.contains("ptd-torrent-tag--filterable")).toBe(false);
      expect(tag.classList.contains("ptd-torrent-tag--filtered")).toBe(false);
      expect(tag.getAttribute("role")).toBeNull();
      expect(tag.getAttribute("tabindex")).toBeNull();
      expect(tag.getAttribute("aria-pressed")).toBeNull();
      expect(tag.getAttribute("title"), "纯展示标签不应多出悬浮提示").toBeNull();
      tag.click();
    }
    await view.settle();
    expect(onFilterTag, "关闭时点击标签不应发出筛选事件").not.toHaveBeenCalled();

    view.unmount();
  });

  it("activeTagNames 命中的标签高亮为已筛选并提示「点击取消」，其余标签仍提示「点击筛选」", async () => {
    const view = mountTitle({ tagFilterable: true, activeTagNames: ["Free"] });
    await view.settle();

    const tags = view.$$(".ant-tag");
    const free = tags.find((tag) => tag.textContent?.trim() === "Free")!;
    const other = tags.find((tag) => tag.textContent?.trim() === "中字")!;

    expect(free.classList.contains("ptd-torrent-tag--filtered"), "已激活标签应有高亮类").toBe(true);
    expect(free.getAttribute("aria-pressed")).toBe("true");
    expect(other.classList.contains("ptd-torrent-tag--filtered")).toBe(false);
    expect(other.getAttribute("aria-pressed")).toBe("false");

    // 文案要能区分两种状态：激活态提示「点击取消」，未激活态提示「点击按标签筛选」
    expect(free.getAttribute("title")).toContain("取消");
    expect(other.getAttribute("title")).not.toContain("取消");

    view.unmount();
  });

  it("键盘 Enter / Space 与鼠标点击等价（可聚焦控件必须能键盘操作）", async () => {
    const onFilterTag = vi.fn();
    const view = mountTitle({ tagFilterable: true, onFilterTag });
    await view.settle();

    const tag = view.$$(".ant-tag")[1]!;

    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    tag.dispatchEvent(enter);
    await view.settle();
    expect(onFilterTag).toHaveBeenLastCalledWith("Free");

    // Space 在浏览器里默认滚动页面，必须 preventDefault
    const space = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
    tag.dispatchEvent(space);
    await view.settle();
    expect(onFilterTag).toHaveBeenCalledTimes(2);
    expect(space.defaultPrevented).toBe(true);

    view.unmount();
  });
});

// ── filter.ts：筛选状态切换 / 筛选串语义 ──────────────────────────────────────

/** 造一行搜索结果；`tags` 的形态与 runtimeStore.search.searchResult 里的真实数据一致 */
function torrent(tagNames: string[], title = "种子标题") {
  return { title, tags: tagNames.map((name) => ({ name })) };
}

/** 与搜索结果页表格一致：用当前（防抖后）筛选词跑 tableFilterFn */
function matchRow(rawItem: Record<string, any>): boolean {
  return tableCustomFilter.tableFilterFn(undefined, tableCustomFilter.tableFilterRef.value, { raw: rawItem });
}

/** 越过 refDebounced 的 500ms 窗口，让 tableFilterRef 追上 tableWaitFilterRef（不是点击路径，仅用于断言） */
async function flushDebounce() {
  await nextTick();
  vi.advanceTimersByTime(1000);
  await nextTick();
}

describe("点击标签切换筛选（filter.ts 行为）", () => {
  beforeEach(async () => {
    // 过滤词同步依赖 refDebounced 的 500ms 窗口；假定时器让「等防抖」不拖慢用例
    vi.useFakeTimers();

    // 回到「无筛选」状态：重建空字典 + 清空输入框，并等防抖副本归零
    tableCustomFilter.buildFilterDictFn("");
    tableCustomFilter.tableWaitFilterRef.value = "";
    await flushDebounce();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("点击加入必选：返回 true，筛选串与激活标签同步更新", async () => {
    expect(filterModule.toggleTagFilter("Free")).toBe(true);

    expect(filterModule.getActiveTagFilterNames()).toEqual(["Free"]);
    expect(tableCustomFilter.advanceFilterDictRef.value.tags.required).toEqual(["Free"]);
    expect(tableCustomFilter.tableWaitFilterRef.value).toContain("tags:Free");

    await flushDebounce();
    expect(matchRow(torrent(["Free"])), "带 Free 标签的种子应命中").toBe(true);
    expect(matchRow(torrent(["中字"])), "不带 Free 标签的种子应被过滤掉").toBe(false);
  });

  it("再次点击同一标签取消筛选：返回 false，恢复无标签筛选", async () => {
    filterModule.toggleTagFilter("Free");
    await flushDebounce();

    expect(filterModule.toggleTagFilter("Free")).toBe(false);
    expect(filterModule.getActiveTagFilterNames()).toEqual([]);
    expect(tableCustomFilter.advanceFilterDictRef.value.tags.required).toEqual([]);
    expect(tableCustomFilter.tableWaitFilterRef.value.trim(), "取消最后一个标签后筛选串应回空").toBe("");

    await flushDebounce();
    expect(matchRow(torrent(["Free"]))).toBe(true);
    expect(matchRow(torrent(["中字"]))).toBe(true);
  });

  it("多个标签是「且」关系：只有同时带全部选中标签的种子命中", async () => {
    filterModule.toggleTagFilter("Free");
    filterModule.toggleTagFilter("中字");

    expect(filterModule.getActiveTagFilterNames(), "保持点击顺序").toEqual(["Free", "中字"]);
    await flushDebounce();

    expect(matchRow(torrent(["Free", "中字"])), "两个标签都带的种子命中").toBe(true);
    expect(matchRow(torrent(["Free"])), "只带 Free 的种子应被过滤掉").toBe(false);
    expect(matchRow(torrent(["中字"])), "只带中字的种子应被过滤掉").toBe(false);
  });

  it("同名标签已在排除项时，点击加入必选会把它从排除项摘掉（不能既必选又排除）", async () => {
    tableCustomFilter.advanceFilterDictRef.value.tags = { required: [], exclude: ["Free"] };

    filterModule.toggleTagFilter("Free");

    expect(tableCustomFilter.advanceFilterDictRef.value.tags.required).toEqual(["Free"]);
    expect(tableCustomFilter.advanceFilterDictRef.value.tags.exclude).toEqual([]);
    expect(tableCustomFilter.tableWaitFilterRef.value.match(/tags:/g) ?? [], "筛选串里只应出现一次 tags").toHaveLength(
      1,
    );

    await flushDebounce();
    expect(matchRow(torrent(["Free"]))).toBe(true);
  });

  it("标签名含空格 / 百分号时，经筛选串往返后仍能命中同名标签", async () => {
    filterModule.toggleTagFilter("My Tag");
    expect(filterModule.getActiveTagFilterNames()).toEqual(["My Tag"]);
    const text = tableCustomFilter.tableWaitFilterRef.value;
    expect(text).toContain("tags:");

    await flushDebounce();
    expect(matchRow(torrent(["My Tag"])), "含空格标签应能命中").toBe(true);
    expect(matchRow(torrent(["MyTag"]))).toBe(false);

    // 从筛选串重建字典必须拿回原始标签名（否则 SearchFilterBar 的勾选状态与标签高亮会错位）
    tableCustomFilter.buildFilterDictFn(text);
    expect(filterModule.getActiveTagFilterNames()).toEqual(["My Tag"]);

    // 取消后再来一个含百分号的标签：% 必须先编码自身，才能无损往返
    expect(filterModule.toggleTagFilter("My Tag")).toBe(false);
    filterModule.toggleTagFilter("100%");
    const percentText = tableCustomFilter.tableWaitFilterRef.value;
    await flushDebounce();
    expect(matchRow(torrent(["100%"])), "含百分号标签应能命中").toBe(true);
    tableCustomFilter.buildFilterDictFn(percentText);
    expect(filterModule.getActiveTagFilterNames()).toEqual(["100%"]);
  });

  it("getActiveTagFilterNames 返回拷贝，外部改动不会污染筛选字典", () => {
    filterModule.toggleTagFilter("Free");

    const names = filterModule.getActiveTagFilterNames();
    names.push("中字");

    expect(tableCustomFilter.advanceFilterDictRef.value.tags.required).toEqual(["Free"]);
    expect(filterModule.getActiveTagFilterNames()).toEqual(["Free"]);
  });

  it("页面点击必须立即生效：tableFilterRef 在 toggleTagFilter 内同步为新筛选串（绕过 500ms 防抖）", async () => {
    filterModule.toggleTagFilter("Free");
    expect(tableCustomFilter.tableWaitFilterRef.value).toContain("tags:Free");

    // 契约：点击是离散操作，不能等 500ms；这里**不推进定时器**就断言表格过滤已生效
    expect(tableCustomFilter.tableFilterRef.value, "tableFilterRef 应在 toggleTagFilter 内被同步").toContain(
      "tags:Free",
    );
    expect(matchRow(torrent(["Free"]))).toBe(true);
    expect(matchRow(torrent(["中字"]))).toBe(false);

    // 清掉假定时器里尚未落地的防抖任务，避免影响后续用例
    await flushDebounce();
  });
});

// ── 搜索结果页接线：配置开关 → 组件 props → 共用筛选状态 ──────────────────────

describe("搜索结果页接线（SearchEntity/Index.vue）", () => {
  /** 两条结果各带一个不同标签；仅渲染两行，避免分页干扰 */
  const SEARCH_ROWS = [
    { site: "mteam", id: "1", uniqueId: "mteam-1", title: "带 Free 的种子", tags: [{ name: "Free" }] },
    { site: "mteam", id: "2", uniqueId: "mteam-2", title: "带中字的种子", tags: [{ name: "中字" }] },
  ];

  const tableRows = (view: ReturnType<typeof mountOptionsView>) => view.$$(".ant-table-tbody tr.ant-table-row");

  beforeEach(() => {
    // 模块级筛选状态在用例之间是共享的：把上次残留的标签筛选逐个点掉（保持字典与筛选串一致）
    for (const name of filterModule.getActiveTagFilterNames()) filterModule.toggleTagFilter(name);
  });

  async function mountSearchEntity() {
    const { useRuntimeStore } = await import("@/options/stores/runtime.ts");
    const { useConfigStore } = await import("@/options/stores/config.ts");
    const configStore = useConfigStore(pinia);
    const runtimeStore = useRuntimeStore(pinia);

    configStore.searchEntifyControl.tagClickToFilter = true;
    configStore.searchEntifyControl.showTorrentTag = true;
    runtimeStore.search = {
      ...runtimeStore.search,
      searchKey: "matrix",
      searchResult: SEARCH_ROWS.map((row) => ({ ...row })),
    } as any;

    const view = mountOptionsView(SearchEntityView, { pinia, router: true });
    await view.settle(150);
    return { view, configStore, runtimeStore };
  }

  it("点击标题里的标签只保留该标签的行，再次点击恢复，标签同步高亮", async () => {
    const { view } = await mountSearchEntity();
    try {
      expect(tableRows(view), "初始应展示两条搜索结果").toHaveLength(2);

      const freeTag = view.$$(".ptd-torrent-tag--filterable").find((tag) => tag.textContent?.trim() === "Free");
      expect(freeTag, "搜索页的标签应可点击筛选（tagFilterable 已接线）").toBeDefined();
      freeTag!.click();
      await view.settle(80);

      expect(tableRows(view), "只应保留带 Free 标签的行").toHaveLength(1);
      expect(view.text()).toContain("带 Free 的种子");
      expect(view.text()).not.toContain("带中字的种子");

      // activeTagNames 接线：已激活的标签在页面上高亮 + aria-pressed=true
      const filteredTag = view.$$(".ptd-torrent-tag--filtered").find((tag) => tag.textContent?.trim() === "Free");
      expect(filteredTag, "已激活标签应高亮").toBeDefined();
      expect(filteredTag!.getAttribute("aria-pressed")).toBe("true");

      // 与筛选条共用 advanceFilterDictRef：顶部「标签」筛选 chip 也要同步显示 Free
      const tagChipText = () => view.$('[data-filter="tags"]')?.textContent ?? "";
      expect(tagChipText()).toContain("Free");

      filteredTag!.click();
      await view.settle(80);
      expect(tableRows(view), "再次点击应恢复全部结果").toHaveLength(2);
      expect(tagChipText()).not.toContain("Free");
    } finally {
      view.unmount();
    }
  });

  it("配置 tagClickToFilter 关闭后标签恢复纯展示：没有可点击类，点击也不筛选", async () => {
    const { view, configStore } = await mountSearchEntity();
    try {
      configStore.searchEntifyControl.tagClickToFilter = false;
      await view.settle(80);

      expect(view.$$(".ptd-torrent-tag--filterable"), "关闭后不应再有可点击标签").toHaveLength(0);
      const tags = view.$$(".ant-tag");
      expect(tags.length).toBeGreaterThan(0);

      tags[0]!.click();
      await view.settle(80);
      expect(tableRows(view), "关闭后点击标签不应改变结果集").toHaveLength(2);
    } finally {
      view.unmount();
    }
  });
});
