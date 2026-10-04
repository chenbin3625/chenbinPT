/**
 * 搜索结果页快速站点筛选。
 *
 * Q-3 改造：原本「全部站点和普通站点使用同一按钮结构与紧凑排列」这一组断言读
 * `QuickFilterNotice.vue` / `style.css` 的**源码文本**（数 `class="quick-site-filter__option"` 出现 2 次、
 * 正则匹配 class 绑定表达式、正则匹配 CSS 规则），等价重构即红。
 * 现在真实挂载组件 + 注入真实样式表：
 * - 按钮数量 / 选中态 → 查渲染结果；
 * - 点击后的筛选字典变化 → 断言真实副作用（applyQuickSiteFilter 的落地结果）；
 * - 紧凑排列 → 断言 `getComputedStyle` 的计算值。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { computedStyle, loadOptionsStyles, mountOptionsView, prepareOptionsPinia } from "../../helpers/optionsView.ts";

vi.mock("@/messages.ts", () => ({ sendMessage: vi.fn(), onMessage: vi.fn() }));

/** 子组件会去读 metadata store（真实实现有异步水合），本用例只关心父组件的按钮结构 */
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
 * `SearchEntity/utils/filter.ts` 在模块求值期就创建 store / 调 `$onReady`，
 * 单测里替换成可控的 ref（该 composable 自身的逻辑由 searchEntityLastFilter.test.ts 覆盖）。
 */
const filterMock = vi.hoisted(() => ({ state: {} as Record<string, any> }));

vi.mock("@/options/views/Overview/SearchEntity/utils/filter.ts", async () => {
  const { ref } = await import("vue");
  const { vi: vitest } = await import("vitest");

  const advanceItemPropsRef = ref<Record<string, any>>({ site: [] });
  const advanceFilterDictRef = ref<Record<string, any>>({ site: { required: [], exclude: [] } });
  const updateTableFilterValueFn = vitest.fn();

  filterMock.state = { advanceItemPropsRef, advanceFilterDictRef, updateTableFilterValueFn };

  const tableCustomFilter = { advanceItemPropsRef, advanceFilterDictRef, updateTableFilterValueFn };
  return { tableCustomFilter, advanceItemPropsRef, advanceFilterDictRef, updateTableFilterValueFn };
});

const SITES = ["mteam", "ourbits"];

let QuickFilterNotice: any;
let applyQuickSiteFilter: any;
let getQuickSiteFilterSelection: any;

beforeEach(async () => {
  prepareOptionsPinia();
  QuickFilterNotice = (await import("@/options/views/Overview/SearchEntity/QuickFilterNotice.vue")).default;
  ({ applyQuickSiteFilter, getQuickSiteFilterSelection } =
    await import("@/options/views/Overview/SearchEntity/utils/quickSiteFilter.ts"));

  const { useConfigStore } = await import("@/options/stores/config.ts");
  useConfigStore().searchEntity.quickSiteFilter = true;
  filterMock.state.advanceItemPropsRef.value = { site: [...SITES] };
  filterMock.state.advanceFilterDictRef.value = { site: { required: [], exclude: [] } };
  filterMock.state.updateTableFilterValueFn.mockClear();
});

const mountNotice = () => mountOptionsView(QuickFilterNotice, { pinia: prepareOptionsPinia() });

describe("搜索结果页快速站点筛选（纯逻辑）", () => {
  it("只在无筛选时选中全部站点，只在单个正向站点筛选时选中对应站点", () => {
    expect(getQuickSiteFilterSelection({ required: [], exclude: [] })).toEqual({
      isAllSelected: true,
      selectedSite: null,
    });
    expect(getQuickSiteFilterSelection({ required: ["mteam"], exclude: [] })).toEqual({
      isAllSelected: false,
      selectedSite: "mteam",
    });
    expect(getQuickSiteFilterSelection({ required: ["mteam", "ourbits"], exclude: [] })).toEqual({
      isAllSelected: false,
      selectedSite: null,
    });
    expect(getQuickSiteFilterSelection({ required: [], exclude: ["mteam"] })).toEqual({
      isAllSelected: false,
      selectedSite: null,
    });
  });

  it("选择站点时替换为单站点筛选，选择全部时同时清空正向和排除筛选", () => {
    const filter = { required: ["mteam", "ourbits"], exclude: ["hdhome"] };

    applyQuickSiteFilter(filter, "pter");
    expect(filter).toEqual({ required: ["pter"], exclude: [] });

    applyQuickSiteFilter(filter, null);
    expect(filter).toEqual({ required: [], exclude: [] });
  });
});

describe("搜索结果页快速站点筛选（渲染与样式行为）", () => {
  loadOptionsStyles();

  it("全部站点与每个站点各渲染一个同构按钮，页面上没有旧版 a-space 包装", async () => {
    const view = mountNotice();
    await view.settle();

    const options = view.$$(".quick-site-filter__option");
    expect(options).toHaveLength(SITES.length + 1);
    // 两个分支（全部 / 单站点）必须使用同一个类名，否则样式无法复用
    for (const option of options) {
      expect(option.tagName).toBe("BUTTON");
      expect(option.getAttribute("type")).toBe("button");
    }

    // 反证旧写法：不再有 a-space 渲染出的 .ant-space 布局节点
    expect(view.$(".quick-site-filter .ant-space")).toBeNull();
    // 站点名 / 图标确实进了按钮（按钮不是空的）
    expect(view.$$(".stub-site-name").map((el) => el.textContent)).toEqual(SITES);

    view.unmount();
  });

  it("无筛选时「全部」高亮；单站点筛选时只有该站点高亮", async () => {
    const view = mountNotice();
    await view.settle();

    const activeTexts = () => view.$$(".quick-site-filter__option--active").map((el) => el.textContent?.trim() ?? "");

    // 「全部」那颗按钮只有图标、没有站点名
    expect(activeTexts()).toHaveLength(1);
    expect(activeTexts()[0]).not.toContain("mteam");

    filterMock.state.advanceFilterDictRef.value = { site: { required: ["ourbits"], exclude: [] } };
    await view.settle();

    const active = activeTexts();
    expect(active).toHaveLength(1);
    expect(active[0]).toContain("ourbits");

    view.unmount();
  });

  it("点击站点按钮把筛选字典换成单站点，并触发一次表格筛选刷新；点「全部」清空", async () => {
    const view = mountNotice();
    await view.settle();

    filterMock.state.advanceFilterDictRef.value = { site: { required: ["mteam", "ourbits"], exclude: ["hdhome"] } };
    await view.settle();

    // 第 2 颗按钮 = 第 1 个站点（第 1 颗是「全部」）
    view.$$(".quick-site-filter__option")[1]!.click();
    await view.settle();

    expect(filterMock.state.advanceFilterDictRef.value.site).toEqual({ required: ["mteam"], exclude: [] });
    expect(filterMock.state.updateTableFilterValueFn).toHaveBeenCalledTimes(1);

    view.$$(".quick-site-filter__option")[0]!.click();
    await view.settle();

    expect(filterMock.state.advanceFilterDictRef.value.site).toEqual({ required: [], exclude: [] });
    expect(filterMock.state.updateTableFilterValueFn).toHaveBeenCalledTimes(2);

    view.unmount();
  });

  it("快速筛选条与按钮的计算样式是紧凑单行排列，且图标确实渲染在每个按钮里", async () => {
    const view = mountNotice();
    await view.settle();

    const bar = view.$(".quick-site-filter")!;
    const option = view.$(".quick-site-filter__option")!;

    expect(computedStyle(bar, "display")).toBe("flex");
    expect(computedStyle(bar, "gap")).toBe("6px");
    expect(computedStyle(bar, "align-items")).toBe("center");
    expect(computedStyle(option, "display")).toBe("inline-flex");
    expect(computedStyle(option, "height")).toBe("28px");

    // 每个按钮都有图标（「全部」用 GlobalOutlined，站点用 favicon）
    expect(view.$(".quick-site-filter__option .quick-site-filter__icon")).not.toBeNull();
    expect(view.$$(".quick-site-filter__option .stub-site-favicon")).toHaveLength(SITES.length);

    view.unmount();
  });
});
