/**
 * 搜索结果页的工具条层级 / 顶部状态行 / 空状态引导。
 *
 * 这三处旧实现都依赖一长串加粗文字与整条被 `<strong>` 包裹的工具条：
 * - 工具条：次操作与主操作混在一行，窄屏会折成两三行；
 * - 状态行：`方案 [xx]，关键词 [xx]，共 N 条，耗时 x 秒` 只能作为一段普通文本读；
 * - 空状态：只说明「还没搜索」，没有可点的入口。
 *
 * 这里真实挂载视图，按渲染结果断言，而不是对模板源码做正则匹配。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EResultParseStatus } from "@ptd/site";

import { mountOptionsView, prepareOptionsPinia } from "../../helpers/optionsView.ts";

vi.mock("@/messages.ts", () => ({ sendMessage: vi.fn().mockResolvedValue(undefined), onMessage: vi.fn() }));

const DESKTOP_WIDTH = 1024;
const MOBILE_WIDTH = 600;

let SearchEntityView: any;

beforeEach(async () => {
  prepareOptionsPinia();
  SearchEntityView = (await import("@/options/views/Overview/SearchEntity/Index.vue")).default;
});

afterEach(() => {
  window.innerWidth = DESKTOP_WIDTH;
});

async function mountSearchEntity(
  viewportWidth: number,
  search: Record<string, unknown> = {},
  options: { sites?: Record<string, unknown>; siteNameMap?: Record<string, string> } = {},
) {
  window.innerWidth = viewportWidth;
  window.dispatchEvent(new Event("resize"));

  const pinia = prepareOptionsPinia();
  const { useRuntimeStore } = await import("@/options/stores/runtime.ts");
  const { useMetadataStore } = await import("@/options/stores/metadata.ts");
  // 空状态需要区分「已添加站点」与「还没有站点」，默认给一个站点（无结果行，不会触发站点组件请求）
  const metadataStore = useMetadataStore(pinia);
  metadataStore.sites = (options.sites ?? { mteam: { id: "mteam", url: "https://example.com/" } }) as any;
  metadataStore.siteNameMap = (options.siteNameMap ?? {}) as any;
  const runtimeStore = useRuntimeStore(pinia);
  runtimeStore.search = { ...runtimeStore.search, ...search } as any;

  const view = mountOptionsView(SearchEntityView, { pinia, router: true });
  await view.settle(80);
  return view;
}

const completedSearch = {
  startAt: Date.now(),
  endAt: Date.now(),
  isSearching: false,
  searchKey: "matrix",
  searchPlanKey: "all",
  searchResult: [],
};

describe("搜索结果页工具条", () => {
  it("工具条不再被 strong 包裹，次操作由 ToolbarActions 渲染", async () => {
    const view = await mountSearchEntity(DESKTOP_WIDTH, completedSearch);

    const toolbar = view.$<HTMLElement>(".page-toolbar")!;
    expect(toolbar).not.toBeNull();
    expect(toolbar.querySelector("strong"), "整条工具条不应再被加粗").toBeNull();

    const actions = view.$<HTMLElement>(".toolbar-actions")!;
    expect(actions).not.toBeNull();
    // 宽屏（md 及以上）次操作按普通按钮平铺
    const labels = Array.from(actions.querySelectorAll("button")).map((button) => button.textContent?.trim() ?? "");
    expect(labels).toContain("重试失败");
    expect(labels).toContain("搜索快照");
    // 展示偏好带弹层，必须是真实按钮作为 popover 触发器，因此留在工具栏、不进 ToolbarActions
    expect(labels).not.toContain("展示偏好");
    expect(toolbar.textContent).toContain("展示偏好");

    view.unmount();
  });

  it("窄屏把次操作收进「更多」，不再折成两三行按钮", async () => {
    const view = await mountSearchEntity(MOBILE_WIDTH, completedSearch);

    const toolbar = view.$<HTMLElement>(".page-toolbar")!;
    expect(toolbar.textContent).toContain("更多");
    expect(toolbar.textContent, "窄屏的次操作收进「更多」，不再平铺").not.toContain("搜索快照");
    // 已结束的搜索：主操作是「重新搜索」，不再出现只对进行中搜索有意义的「暂停」
    expect(toolbar.textContent).toContain("重新搜索");
    expect(toolbar.textContent, "未在搜索时不应显示暂停按钮").not.toContain("暂停");

    view.unmount();
  });

  it("展示偏好由真实按钮触发弹层（不是藏在工具条角落的隐形锚点）", async () => {
    const view = await mountSearchEntity(DESKTOP_WIDTH, completedSearch);

    const toolbar = view.$<HTMLElement>(".page-toolbar")!;
    const button = Array.from(toolbar.querySelectorAll<HTMLButtonElement>("button")).find((item) =>
      item.textContent?.includes("展示偏好"),
    );
    expect(button, "应渲染出展示偏好按钮").toBeDefined();
    expect(button!.getAttribute("title"), "按钮要带完整说明的悬停提示").toBe("搜索结果展示偏好");
    button!.click();
    await view.settle(80);

    const popover = Array.from(document.querySelectorAll<HTMLElement>(".ant-popover")).at(-1)!;
    expect(popover).toBeDefined();
    expect(popover.textContent).toContain("显示站点名称");

    view.unmount();
  });

  it("窄屏下展示偏好退化为图标按钮，悬停提示仍在", async () => {
    const view = await mountSearchEntity(MOBILE_WIDTH, completedSearch);

    const toolbar = view.$<HTMLElement>(".page-toolbar")!;
    const button = Array.from(toolbar.querySelectorAll<HTMLButtonElement>("button")).find(
      (item) => item.getAttribute("title") === "搜索结果展示偏好",
    );
    expect(button, "窄屏仍保留展示偏好入口").toBeDefined();
    expect(button!.textContent?.trim(), "窄屏只显示图标，不占文字宽度").toBe("");

    view.unmount();
  });
});

describe("搜索结果页顶部状态行", () => {
  it("搜索方案 / 关键词 / 结果数用结构化标签与次级文字展示", async () => {
    const view = await mountSearchEntity(DESKTOP_WIDTH, completedSearch);

    const status = view.$<HTMLElement>(".search-status")!;
    expect(status).not.toBeNull();

    // 方案名与关键词各是一个 a-tag；状态主文案不再是一整段加粗文字
    expect(status.querySelectorAll(".ant-tag").length).toBeGreaterThanOrEqual(2);
    expect(status.textContent).toContain("搜索方案");
    expect(status.textContent).toContain("关键词");
    expect(status.textContent).toContain("matrix");
    expect(status.textContent).toContain("共 0 条结果");
    expect(status.querySelector("strong")).toBeNull();

    view.unmount();
  });

  it("搜索中 / 暂停分别用 processing / warning 状态标签区分", async () => {
    const view = await mountSearchEntity(DESKTOP_WIDTH, completedSearch);

    // 挂载时 reconcileRestoredSearchState 会把没有队列任务的在途状态收敛掉，
    // 所以要在挂载后再切到「搜索中」，模拟队列真正活跃的状态。
    const { useRuntimeStore } = await import("@/options/stores/runtime.ts");
    const { searchQueuePaused } = await import("@/options/views/Overview/SearchEntity/utils/search.ts");
    const runtimeStore = useRuntimeStore();
    runtimeStore.search.isSearching = true;
    runtimeStore.search.endAt = 0;
    await view.settle();

    let tags = Array.from(view.$<HTMLElement>(".search-status")!.querySelectorAll(".ant-tag"));
    const processing = tags.find((tag) => tag.classList.contains("ant-tag-processing"));
    expect(processing?.textContent).toContain("搜索中");

    searchQueuePaused.value = true;
    await view.settle();
    tags = Array.from(view.$<HTMLElement>(".search-status")!.querySelectorAll(".ant-tag"));
    const warning = tags.find((tag) => tag.classList.contains("ant-tag-warning"));
    expect(warning?.textContent).toContain("搜索暂停中");

    searchQueuePaused.value = false;
    view.unmount();
  });
});

describe("搜索结果页空状态引导", () => {
  it("还未开始搜索时给出可点击的搜索 / 搜索方案入口", async () => {
    const view = await mountSearchEntity(DESKTOP_WIDTH, {
      startAt: 0,
      endAt: 0,
      isSearching: false,
      searchKey: "",
      searchResult: [],
    });

    const empty = view.$<HTMLElement>(".ant-table-placeholder .ant-empty");
    expect(empty).not.toBeNull();

    const buttons = Array.from(empty!.querySelectorAll("button")).map((button) => button.textContent?.trim() ?? "");
    expect(buttons).toContain("搜索");
    expect(buttons).toContain("搜索方案");

    view.unmount();
  });

  it("还没有添加站点时引导去站点设置，而不是给一个点了会失败的搜索入口", async () => {
    const view = await mountSearchEntity(
      DESKTOP_WIDTH,
      { startAt: 0, endAt: 0, isSearching: false, searchKey: "", searchResult: [] },
      { sites: {} },
    );

    const empty = view.$<HTMLElement>(".ant-table-placeholder .ant-empty")!;
    const buttons = Array.from(empty.querySelectorAll("button")).map((button) => button.textContent?.trim() ?? "");
    expect(buttons).toContain("去添加站点");
    expect(buttons, "没有站点时不应再给搜索按钮").not.toContain("搜索");
    expect(empty.textContent).toContain("还没有添加可搜索的站点");

    view.unmount();
  });

  it("搜索进行中且还没有结果时提示正在搜索，不再让用户去开始搜索", async () => {
    const view = await mountSearchEntity(DESKTOP_WIDTH, completedSearch);

    // 挂载时 reconcileRestoredSearchState 会收敛没有队列任务的在途状态，因此在挂载后再切到搜索中
    const { useRuntimeStore } = await import("@/options/stores/runtime.ts");
    const runtimeStore = useRuntimeStore();
    runtimeStore.search.isSearching = true;
    runtimeStore.search.endAt = 0;
    await view.settle();

    const empty = view.$<HTMLElement>(".ant-table-placeholder .ant-empty")!;
    expect(empty.textContent).toContain("正在搜索各站点");
    expect(empty.textContent, "搜索中不应提示「开始搜索」").not.toContain("请输入关键词");
    expect(empty.querySelectorAll("button")).toHaveLength(0);

    view.unmount();
  });

  it("已经搜索过但没有结果时说明「没找到」，不给误导性的开始入口", async () => {
    const view = await mountSearchEntity(DESKTOP_WIDTH, completedSearch);

    const empty = view.$<HTMLElement>(".ant-table-placeholder .ant-empty");
    expect(empty).not.toBeNull();
    expect(empty!.querySelectorAll("button")).toHaveLength(0);
    expect(empty!.textContent).toContain("没有找到与「matrix」相关的结果");

    view.unmount();
  });
});

describe("搜索结果页的失败可见性", () => {
  const row = {
    site: "mteam",
    id: "1",
    uniqueId: "mteam-1",
    title: "The.Matrix.1999.2160p.BluRay.REMUX",
    size: 1024 * 1024 * 1024,
    seeders: 3,
    leechers: 1,
    completed: 100,
    comments: 2,
    time: Date.now(),
    url: "https://example.com/torrent/1",
  };
  const failedPlan = {
    siteId: "pthome",
    searchEntryName: "default",
    searchEntry: {},
    status: EResultParseStatus.needLogin,
    count: 0,
  };
  const failedSearch = {
    startAt: Date.now(),
    endAt: Date.now(),
    isSearching: false,
    searchKey: "matrix",
    searchPlanKey: "all",
    searchResult: [row],
    searchPlan: { "pthome|$|default": failedPlan },
  };

  it("有结果但部分站点失败时，提示条列出失败站点与原因，并提供重试入口", async () => {
    const view = await mountSearchEntity(DESKTOP_WIDTH, failedSearch, {
      siteNameMap: { mteam: "馒头", pthome: "PTHome" },
    });

    const alert = view.$<HTMLElement>(".search-failure-alert")!;
    expect(alert, "失败站点不能被藏进「搜索情况」弹窗").not.toBeNull();
    expect(alert.textContent).toContain("1 个站点搜索失败");
    expect(alert.textContent).toContain("PTHome");
    expect(alert.textContent).toContain("需要登录");

    const buttons = Array.from(alert.querySelectorAll("button")).map((button) => button.textContent?.trim() ?? "");
    expect(buttons).toContain("重试失败");
    expect(buttons).toContain("查看搜索情况");

    view.unmount();
  });

  it("0 条结果且有站点失败时，空状态直接给出重试入口", async () => {
    const view = await mountSearchEntity(
      DESKTOP_WIDTH,
      { ...failedSearch, searchResult: [] },
      { siteNameMap: { pthome: "PTHome" } },
    );

    const empty = view.$<HTMLElement>(".ant-table-placeholder .ant-empty")!;
    expect(empty.textContent).toContain("没有找到结果，且 1 个站点搜索失败");
    const buttons = Array.from(empty.querySelectorAll("button")).map((button) => button.textContent?.trim() ?? "");
    expect(buttons).toContain("重试失败");
    expect(buttons).toContain("查看搜索情况");
    // 失败提示条只负责「有结果可看」的场景，避免与空状态重复
    expect(view.$(".search-failure-alert")).toBeNull();

    view.unmount();
  });
});
