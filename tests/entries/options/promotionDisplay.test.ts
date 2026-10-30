/**
 * 优惠信息的展示形式（移植自上游 13991d15b5 / #1650 的 S4 消费层）。
 *
 * 覆盖四件事：
 * 1. 种子标题里的优惠标签随 `searchEntifyControl.promotionDisplay` 显隐：`tags`/`both` 显示、
 *    `factor`/`none` 隐藏，但**非优惠标签（H&R / 官方 / 可退款）永远显示**；
 * 2. 优惠标签的悬停释义来自 `tagsToPromotion`（「下载不计流量」「上传量 ×2」），且不占用
 *    点击筛选用的 title；
 * 3. 搜索结果表新增「优惠」列：只在 `factor` / `both` 模式出现，并按下载系数升序排序；
 * 4. 搜索快照装载时在写入 Pinia store **之前**对普通对象做一次归一（旧快照可能只有 tags 没有 factor）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// 快照数据在真实实现里由 offscreen 经 sendMessage 返回，这里用可变状态喂给 mock
const messageState = vi.hoisted(() => ({ snapshotData: undefined as unknown }));
vi.mock("@/messages.ts", () => ({
  sendMessage: vi.fn(async (name: string) =>
    name === "getSearchResultSnapshotData" ? messageState.snapshotData : undefined,
  ),
  onMessage: vi.fn(),
}));
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
      setup: () => () => h("i", { class: "stub-site-favicon" }),
    }),
  };
});

import { createMemoryHistory, createRouter } from "vue-router";

import { mountOptionsView, prepareOptionsPinia } from "../../helpers/optionsView.ts";

/** 一个「免费」+ 一个「2 倍上传」+ 一个「正常」种子，外加非优惠标签 */
const PROMO_TAGS = [
  { name: "Free", color: "blue" },
  { name: "2xUp", color: "lime" },
  { name: "H&R", color: "red" },
];

async function mountTitleCell(promotionDisplay: "tags" | "factor" | "both" | "none") {
  const pinia = prepareOptionsPinia();
  const { useConfigStore } = await import("@/options/stores/config.ts");
  const configStore = useConfigStore(pinia);
  configStore.searchEntifyControl.showTorrentTag = true;
  configStore.searchEntifyControl.showTorrentSubtitle = false;
  configStore.searchEntifyControl.showSocialInformation = false;
  configStore.searchEntifyControl.maxTagCountBeforeGroup = 0;
  configStore.searchEntifyControl.hiddenTagNames = [];
  configStore.searchEntifyControl.promotionDisplay = promotionDisplay;

  const { default: TorrentTitleTd } = await import("@/options/components/TorrentTitleTd.vue");
  const view = mountOptionsView(TorrentTitleTd, {
    props: { item: { title: "种子标题", tags: PROMO_TAGS } },
    pinia,
    router: true,
  });
  await view.settle();
  return view;
}

const renderedTagNames = (view: { $$: (selector: string) => HTMLElement[] }) =>
  view.$$(".ant-tag").map((tag) => tag.textContent?.trim());

describe("种子标题：优惠标签随 promotionDisplay 显隐", () => {
  it.each([
    ["tags", ["Free", "2xUp", "H&R"]],
    ["both", ["Free", "2xUp", "H&R"]],
    ["factor", ["H&R"]],
    ["none", ["H&R"]],
  ] as const)("promotionDisplay=%s 时渲染 %j", async (mode, expected) => {
    const view = await mountTitleCell(mode);
    try {
      expect(renderedTagNames(view)).toEqual([...expected]);
    } finally {
      view.unmount();
    }
  });
});

describe("种子标题：优惠标签的悬停释义", () => {
  const cleanupTooltips = () => {
    document.querySelectorAll(".ant-tooltip").forEach((element) => element.remove());
  };

  it("悬停「Free」给出「下载不计流量」，且不覆盖点击筛选的 title", async () => {
    cleanupTooltips();
    const view = await mountTitleCell("tags");
    try {
      const freeTag = view.$$(".ant-tag").find((tag) => tag.textContent?.trim() === "Free")!;
      expect(freeTag).toBeTruthy();

      // 点击筛选未开启时不应有 title（释义走 Tooltip 浮层，不占用 title 属性）
      expect(freeTag.getAttribute("title") ?? "").not.toContain("流量");

      freeTag.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
      await view.settle(200);

      const tooltip = document.querySelector<HTMLElement>(".ant-tooltip");
      expect(tooltip?.textContent ?? "").toContain("下载不计流量");
    } finally {
      view.unmount();
      cleanupTooltips();
    }
  });
});

describe("搜索结果表：优惠列", () => {
  /** 造一份可直接写入 runtime store 的搜索结果 */
  function searchResult() {
    return [
      // 旧快照：只有 tags、没有 factor —— 装载时必须被归一成 factor
      { site: "site-a", id: 1, title: "免费种子", size: 1024 ** 3, tags: [{ name: "Free" }] },
      { site: "site-a", id: 2, title: "2x 种子", size: 1024 ** 3, tags: [{ name: "2xUp" }] },
      { site: "site-a", id: 3, title: "正常种子", size: 1024 ** 3, tags: [] },
    ];
  }

  async function mountSearchEntity(promotionDisplay: "tags" | "factor" | "both" | "none") {
    document.body.innerHTML = "";
    const pinia = prepareOptionsPinia();
    const { useConfigStore } = await import("@/options/stores/config.ts");
    const configStore = useConfigStore(pinia);
    configStore.searchEntifyControl.promotionDisplay = promotionDisplay;
    // 关掉「记住表格行为」：否则联动逻辑会调 updateTableBehavior → $save()，
    // 而测试用的 pinia 没有持久化插件（与真实运行时无关，这里只验证列配置本身）
    configStore.saveTableBehavior = false;

    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: "/:pathMatch(.*)*", name: "SearchEntity", component: { template: "<div />" } }],
    });
    await router.push("/search-entity");

    const { default: SearchEntityView } = await import("@/options/views/Overview/SearchEntity/Index.vue");
    const view = mountOptionsView(SearchEntityView, { pinia, plugins: [router] });
    await view.settle(80);

    const runtimeModule = await import("@/options/stores/runtime.ts");
    const runtimeStore = runtimeModule.useRuntimeStore(pinia);
    const metadataModule = await import("@/options/stores/metadata.ts");
    const metadataStore = metadataModule.useMetadataStore(pinia);

    // 快照必须先在 metadata store 里登记，getSearchSnapshotData 才会去 requests offscreen 的数据
    metadataStore.snapshots["snap-1"] = { id: "snap-1", name: "test", createdAt: Date.now(), recordCount: 3 };
    messageState.snapshotData = {
      searchKey: "kw",
      searchPlanKey: "plan",
      startAt: Date.now(),
      isSearching: false,
      searchPlan: {},
      searchResult: searchResult(),
    };

    await router.push({ path: "/search-entity", query: { snapshot: "snap-1" } });
    await view.settle(120);

    return { view, configStore, runtimeStore };
  }

  it("factor 模式：显示「优惠」列，且旧快照在写入 store 前已被归一", async () => {
    const { view, runtimeStore } = await mountSearchEntity("factor");
    try {
      // 归一发生在入 store 之前：只有 tags 的旧快照也应带出 factor
      const [free, doubleUp, normal] = runtimeStore.search.searchResult;
      expect(free?.downloadVolumeFactor).toBe(0);
      expect(doubleUp?.uploadVolumeFactor).toBe(2);
      expect(normal?.downloadVolumeFactor).toBeUndefined();

      // 表头出现「优惠」列
      const headers = view.$$(".ant-table-thead th").map((th) => th.textContent?.trim());
      expect(headers).toContain("优惠");

      // 单元格按「系数 → 标签」规则展示（免费 → Free，2xUp → 2xUp，正常 → -）
      const cellTexts = view.$$("tbody tr td").map((td) => td.textContent?.trim());
      expect(cellTexts).toContain("Free");
      expect(cellTexts).toContain("2xUp");
      expect(cellTexts).toContain("-");
    } finally {
      view.unmount();
    }
  });

  it("tags 模式：不显示「优惠」列（默认与原行为一致）", async () => {
    const { view } = await mountSearchEntity("tags");
    try {
      const headers = view.$$(".ant-table-thead th").map((th) => th.textContent?.trim());
      expect(headers).not.toContain("优惠");
    } finally {
      view.unmount();
    }
  });
});
