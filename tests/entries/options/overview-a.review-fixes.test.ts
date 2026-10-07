/**
 * options-overview-a 包（OPTIONSOVERVIEW-1 ~ 5）的回归测试。
 *
 * 这五条都是「修了但没人守」的可见性/健壮性缺陷，因此断言全部落在**真实挂载后的行为**上：
 * - OPTIONSOVERVIEW-1：下载历史高级筛选的日期滑块必须是双滑块（range），否则拖动会把 [min,max] 元组
 *   改写成标量，点「生成」时 useAdvanceFilter 的 `.map()` 抛 TypeError；
 * - OPTIONSOVERVIEW-2：站点元数据缺失（站点定义已不在构建产物里）时 favicon() 必须降级，不得在渲染期抛错；
 * - OPTIONSOVERVIEW-3：ReDownloadSelectDialog 必须按 downloadTorrent 的返回值统计成功/失败并提示，
 *   magnet 批次要禁用「本地下载」；
 * - OPTIONSOVERVIEW-4：历史数据删除失败/当天记录要有提示，当天行的复选框与行内删除按钮都要禁用；
 * - OPTIONSOVERVIEW-5：导出用户信息时单个站点读取失败必须提示用户，而不是静默少导出。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h, ref, shallowRef } from "vue";

import { mountOptionsView } from "../../helpers/optionsView.ts";

const { sendMessageMock, runtimeStoreStub, metadataStoreStub, configStoreStub, saveAsMock, filterState } = vi.hoisted(
  () => ({
    sendMessageMock: vi.fn(),
    runtimeStoreStub: { showSnakebar: vi.fn() },
    metadataStoreStub: {
      sites: {} as Record<string, unknown>,
      siteNameMap: {} as Record<string, string>,
      lastUserInfo: {} as Record<string, unknown>,
      $onReady: async () => {},
      getSiteName: vi.fn(async (siteId: string) => siteId),
    },
    configStoreStub: {
      userName: "",
      getUserNames: { perfName: "tester", names: {} as Record<string, string> },
      userDataTimelineControl: {
        title: "",
        backgroundColor: "#101010",
        faviconBlue: 0,
        dateFormat: "time_added",
        showTop: true,
        showTimeline: true,
        showField: { uploads: true },
        showPerSiteField: { siteName: true, name: true, level: true, uid: true },
        selectedSites: [] as string[],
      },
      $save: vi.fn(),
    },
    saveAsMock: vi.fn(),
    filterState: {
      advanceItemPropsRef: null as any,
      advanceFilterDictRef: null as any,
      updateTableFilterValueFn: vi.fn(),
      reBuildAdvanceFilter: vi.fn(),
    },
  }),
);

vi.mock("@/messages.ts", () => ({ sendMessage: sendMessageMock, onMessage: vi.fn() }));
vi.mock("@/options/stores/runtime.ts", () => ({ useRuntimeStore: () => runtimeStoreStub }));
vi.mock("@/options/stores/metadata.ts", () => ({ useMetadataStore: () => metadataStoreStub }));
vi.mock("@/options/stores/config.ts", () => ({
  useConfigStore: () => configStoreStub,
  defaultTimelineBackgroundColor: "#101010",
}));
vi.mock("file-saver", () => ({ saveAs: saveAsMock }));

// 时间轴页用 useElementSize 监听容器宽度；单测里不需要真实 ResizeObserver。
// 其它组合式 API（useDisplay 会用 useWindowSize）必须保留真实实现。
vi.mock("@vueuse/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@vueuse/core")>();
  const { ref: vueRef } = await import("vue");
  return { ...actual, useElementSize: () => ({ width: vueRef(650) }) };
});

// 只关心 favicon 的降级路径：站点元数据固定为「加载失败 → 完全缺失」
vi.mock("@/options/views/Overview/MyData/utils/siteMetadata.ts", () => ({
  allAddedSiteMetadata: {},
  loadAllAddedSiteMetadata: vi.fn(async () => ({})),
}));

// 时间轴页的取数/画布辅助全部替换为可控桩，避免动态 import 真实站点定义
vi.mock("@/options/views/Overview/MyData/UserDataTimeline/utils.ts", async () => {
  const { ref: vueRef } = await import("vue");
  const selectedSites = vueRef(["ghost-site"]);
  const fixedLastUserInfo = vueRef({
    "ghost-site": { site: "ghost-site", name: "u", joinTime: 1, uploaded: 1, uploads: 1 },
  });
  const timelineData = shallowRef({
    createAt: new Date(),
    title: "timeline",
    siteInfo: [{ site: "ghost-site", joinTime: 1, uploaded: 1, uploads: 1 }],
    joinTimeInfo: { site: {}, time: 1, years: "0" },
    topInfo: {
      uploads: { site: { site: "ghost-site" }, subSite: {}, maxValue: 1, subValue: 0 },
    },
    totalInfo: {
      sites: 1,
      deadSites: 0,
      offlineSites: 0,
      uploads: 1,
      uploaded: 1,
      downloaded: 0,
      seeding: 0,
      seedingSize: 0,
      bonus: 0,
      bonusPerHour: 0,
      ratio: 1,
    },
  });

  return {
    canThisSiteShow: () => true,
    selectedSites,
    fixedLastUserInfo,
    timelineDataRef: { ref: timelineData, reset: () => {} },
    topSiteRenderAttr: [{ iconFill: "#C9B037", siteKey: "site", valueKey: "maxValue" }],
    CTimelineUserInfoField: [{ name: "uploads", format: (x: number) => x }],
    image: (config: any) => ({ ...config }),
    text: (config: any) => ({ ...config }),
    divider: (config: any) => ({ ...config }),
    icon: (config: any) => ({ ...config }),
    loadFullData: async () => ({
      "ghost-site": { site: "ghost-site", name: "u", joinTime: 1, uploaded: 1, uploads: 1 },
    }),
  };
});

// 画布组件换成只做标记的桩：既暴露 getNode()/getStage()（:ref 回调会调用），
// 又把收到的 config 里的 image 有无写进 DOM，便于断言 favicon 的降级结果
vi.mock("vue-konva", async () => {
  const { defineComponent: define, h: vnode } = await import("vue");
  const stub = (name: string) =>
    define({
      name: `Stub${name}`,
      props: { config: { type: Object, default: () => ({}) } },
      setup(props, { slots, expose }) {
        expose({ getNode: () => ({ cache: () => {}, batchDraw: () => {} }), getStage: () => ({}) });
        return () =>
          vnode(
            "div",
            {
              class: `stub-konva-${name}`,
              "data-has-image": String(Boolean((props.config as any)?.image)),
            },
            slots.default?.(),
          );
      },
    });

  return {
    Stage: stub("Stage"),
    Layer: stub("Layer"),
    Group: stub("Group"),
    Rect: stub("Rect"),
    Text: stub("Text"),
    Image: stub("Image"),
    Line: stub("Line"),
  };
});

// 只关心高级筛选弹窗自身的滑块接线
vi.mock("@/options/views/Overview/DownloadHistory/utils.ts", async () => {
  const { ref: vueRef } = await import("vue");
  const MAX = 7 * 24 * 60 * 60 * 1000;
  const advanceItemPropsRef = vueRef({
    siteId: [],
    downloaderId: [],
    downloadAt: { range: [0, MAX], ticks: [] },
  });
  const advanceFilterDictRef = vueRef({
    text: { required: [], exclude: [] },
    siteId: { required: [], exclude: [] },
    downloaderId: { required: [], exclude: [] },
    downloadAt: [0, MAX],
  });

  filterState.advanceItemPropsRef = advanceItemPropsRef;
  filterState.advanceFilterDictRef = advanceFilterDictRef;

  return {
    tableCustomFilter: {
      advanceItemPropsRef,
      advanceFilterDictRef,
      reBuildFilterCountRef: vueRef(0),
      toggleKeywordStateFn: vi.fn(),
      reBuildAdvanceFilter: filterState.reBuildAdvanceFilter,
      updateTableFilterValueFn: filterState.updateTableFilterValueFn,
    },
  };
});

vi.mock("@/options/directives/useAdvanceFilter.ts", () => ({
  setDateRangeByDatePicker: (values: [Date, Date]) => [values[0].getTime(), values[1].getTime()],
  getThisDateUnitRange: (_unit: string, range: [number, number]) => range,
}));

// 子组件依赖 store / 站点元数据，这里只保留「能渲染」的能力
const passthrough = (name: string, tag = "span") =>
  defineComponent({
    name,
    props: { siteId: { type: String, default: "" }, downloader: { type: String, default: "" } },
    setup(props, { slots }) {
      return () => h(tag, { class: `stub-${name}` }, slots.default?.() ?? props.siteId ?? "");
    },
  });

vi.mock("@/options/components/SiteName.vue", async () => ({ default: passthrough("SiteName") }));
vi.mock("@/options/components/SiteFavicon/Index.vue", async () => ({ default: passthrough("SiteFavicon") }));
vi.mock("@/options/components/DownloaderLabel.vue", async () => ({ default: passthrough("DownloaderLabel") }));
vi.mock("@/options/components/SentToDownloaderDialog/Index.vue", async () => {
  const { defineComponent: define, h: vnode } = await import("vue");
  return {
    default: define({
      name: "SentToDownloaderDialogStub",
      props: { modelValue: { type: Boolean, default: false }, torrentItems: { type: Array, default: () => [] } },
      emits: ["cancel", "done"],
      setup: () => () => vnode("div", { class: "stub-sent-to-downloader" }),
    }),
  };
});

const confirmModalMock = vi.hoisted(() => vi.fn(async () => true));
vi.mock("@/options/views/Overview/utils/antdConfirm.ts", () => ({ confirmModal: confirmModalMock }));

const loadSiteHistoryDataMock = vi.hoisted(() => vi.fn(async () => [] as any[]));
vi.mock("@/options/views/Overview/MyData/utils/lastUserData.ts", () => ({
  loadSiteHistoryData: loadSiteHistoryDataMock,
}));

/** 与组件里 currentDate() 同口径（formatDate(+new Date(), "yyyy-MM-dd")） */
async function today() {
  const { formatDate } = await import("@/options/utils.ts");
  return formatDate(+new Date(), "yyyy-MM-dd");
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * 这些弹窗的初始化都挂在 `watch(showDialog, open => open && nextTick(init))` 上，
 * 挂载时直接传 modelValue=true 不会触发 watch（初值即 true，没有变化）。
 * 因此统一「先挂载（关闭）→ 再打开」，与真实调用方（父组件点击后置 true）一致。
 */
async function mountDialogOpened(Component: any, props: Record<string, unknown> = {}) {
  const open = ref(false);
  const view = mountOptionsView(
    defineComponent({
      setup: () => () =>
        h(Component, {
          ...props,
          modelValue: open.value,
          "onUpdate:modelValue": (value: boolean) => (open.value = value),
        }),
    }),
  );
  open.value = true;
  await view.settle();
  return view;
}

beforeEach(() => {
  sendMessageMock.mockReset();
  runtimeStoreStub.showSnakebar.mockReset();
  metadataStoreStub.getSiteName.mockClear();
  saveAsMock.mockReset();
  confirmModalMock.mockReset();
  confirmModalMock.mockResolvedValue(true);
  loadSiteHistoryDataMock.mockReset();
  loadSiteHistoryDataMock.mockResolvedValue([]);
  filterState.updateTableFilterValueFn.mockReset();
  filterState.reBuildAdvanceFilter.mockReset();
});

describe("OPTIONSOVERVIEW-1：高级筛选日期滑块必须是双滑块（range）", () => {
  it("挂载后渲染两个滑块手柄，不再把 [min,max] 元组交给单值滑块", async () => {
    const { default: Dialog } =
      await import("@/options/views/Overview/DownloadHistory/AdvanceFilterGenerateDialog.vue");

    const warnings: string[] = [];
    const view = mountOptionsView(Dialog, {
      props: { modelValue: true },
      plugins: [
        {
          install: (app: any) => {
            app.config.warnHandler = (msg: string) => warnings.push(String(msg));
          },
        },
      ],
    });

    try {
      await view.settle();
      const handles = Array.from(document.querySelectorAll(".ant-modal .ant-slider-handle"));
      // 单值滑块只会渲染 1 个手柄；缺 range 时拖动即把数组改写成标量 → 「生成」抛 TypeError
      expect(handles, "日期滑块应是 range 双滑块").toHaveLength(2);

      const MAX = 7 * 24 * 60 * 60 * 1000;
      expect(handles.map((el) => el.getAttribute("aria-valuenow"))).toEqual(["0", String(MAX)]);
      expect(warnings.join("\n")).not.toContain('Invalid prop: type check failed for prop "value"');

      // 元组仍然是元组（没有被单值滑块改写）
      expect(Array.isArray(filterState.advanceFilterDictRef.value.downloadAt)).toBe(true);
      expect(filterState.advanceFilterDictRef.value.downloadAt).toHaveLength(2);
    } finally {
      view.unmount();
    }
  });

  it("区间退化为单点（min === max，下载历史只有一条记录）时也不抛错", async () => {
    filterState.advanceItemPropsRef.value.downloadAt.range = [5000, 5000];
    filterState.advanceFilterDictRef.value.downloadAt = [5000, 5000];

    try {
      const { default: Dialog } =
        await import("@/options/views/Overview/DownloadHistory/AdvanceFilterGenerateDialog.vue");
      const view = mountOptionsView(Dialog, { props: { modelValue: true } });
      try {
        await view.settle();
        expect(document.querySelectorAll(".ant-modal .ant-slider-handle")).toHaveLength(2);
      } finally {
        view.unmount();
      }
    } finally {
      const MAX = 7 * 24 * 60 * 60 * 1000;
      filterState.advanceItemPropsRef.value.downloadAt.range = [0, MAX];
      filterState.advanceFilterDictRef.value.downloadAt = [0, MAX];
    }
  });
});

describe("OPTIONSOVERVIEW-2：站点元数据缺失时 favicon() 降级而不是整页渲染失败", () => {
  it("allAddedSiteMetadata 里没有该站点时仍能渲染出 vk-stage（无渲染期异常）", async () => {
    const { default: TimelineIndex } = await import("@/options/views/Overview/MyData/UserDataTimeline/Index.vue");

    const renderErrors: unknown[] = [];
    const view = mountOptionsView(TimelineIndex, {
      router: true,
      plugins: [
        {
          install: (app: any) => {
            app.config.errorHandler = (err: unknown) => renderErrors.push(err);
          },
        },
      ],
    });

    try {
      await view.settle();

      expect(renderErrors, "渲染期不应抛错（修复前是 Cannot read properties of undefined）").toEqual([]);
      // 画布整体渲染出来了（不是骨架屏兜底）
      expect(view.$(".stub-konva-Stage")).not.toBeNull();
      // favicon 降级为「无图占位」，尺寸/定位仍由 image() 给出
      const imageNode = view.$(".stub-konva-Image");
      expect(imageNode).not.toBeNull();
      expect(imageNode!.getAttribute("data-has-image")).toBe("false");
    } finally {
      view.unmount();
    }
  });
});

describe("OPTIONSOVERVIEW-3：重新下载必须按 downloadTorrent 的返回值提示结果", () => {
  const torrentItems = [
    {
      id: "1",
      downloaderId: "local",
      torrent: { site: "testsite", id: "1", title: "t", link: "https://testsite/download?id=1" },
    },
  ];

  async function mountDialog(items: any[]) {
    const { default: Dialog } = await import("@/options/views/Overview/DownloadHistory/ReDownloadSelectDialog.vue");
    return await mountDialogOpened(Dialog, { torrentItems: items });
  }

  const localButton = () =>
    Array.from(document.querySelectorAll<HTMLButtonElement>(".ant-modal-body .ant-list-item button"))[1];

  it("downloadStatus=failed 时提示错误并带上失败原因", async () => {
    sendMessageMock.mockResolvedValue({ downloadId: -1, downloadStatus: "failed", errorMessage: "site not allowed" });

    const view = await mountDialog(torrentItems);
    try {
      localButton().click();
      await view.settle();

      expect(runtimeStoreStub.showSnakebar).toHaveBeenCalledTimes(1);
      const [content, options] = runtimeStoreStub.showSnakebar.mock.calls[0] as [string, { color: string }];
      expect(options.color).toBe("error");
      expect(content).toContain("site not allowed");
    } finally {
      view.unmount();
    }
  });

  it("部分成功时用 warning 汇总成功/失败数", async () => {
    sendMessageMock
      .mockResolvedValueOnce({ downloadId: 1, downloadStatus: "completed" })
      .mockResolvedValueOnce({ downloadId: 2, downloadStatus: "failed", errorMessage: "client rejected" });

    const view = await mountDialog([
      torrentItems[0],
      {
        id: "2",
        downloaderId: "local",
        torrent: { site: "testsite", id: "2", title: "t2", link: "https://testsite/download?id=2" },
      },
    ]);
    try {
      localButton().click();
      await view.settle();

      const [, options] = runtimeStoreStub.showSnakebar.mock.calls[0] as [string, { color: string }];
      expect(options.color).toBe("warning");
    } finally {
      view.unmount();
    }
  });

  it("magnet 批次禁用「本地下载」按钮（disableLocalDownload 不再是无用状态）", async () => {
    const view = await mountDialog([
      {
        id: "1",
        downloaderId: "local",
        torrent: { site: "testsite", id: "1", title: "t", link: "magnet:?xt=urn:btih:abc" },
      },
    ]);
    try {
      expect(localButton().disabled).toBe(true);
      // 其它两个按钮不受影响
      const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>(".ant-modal-body .ant-list-item button"));
      expect(buttons[0]!.disabled).toBe(false);
      expect(buttons[2]!.disabled).toBe(false);
    } finally {
      view.unmount();
    }
  });
});

describe("OPTIONSOVERVIEW-4：历史数据删除的失败/当天保护", () => {
  async function mountHistory() {
    const { default: Dialog } = await import("@/options/views/Overview/MyData/HistoryDataViewDialog.vue");
    const view = await mountDialogOpened(Dialog, { siteId: "testsite" });
    await flush();
    await view.settle();
    return view;
  }

  const rowByDate = (date: string) =>
    Array.from(document.querySelectorAll<HTMLTableRowElement>(".ant-table-tbody tr")).find((tr) =>
      tr.textContent?.includes(date),
    );

  it("当天行的复选框与删除按钮都禁用；过去行可正常删除", async () => {
    const now = await today();
    loadSiteHistoryDataMock.mockResolvedValue([
      { date: "2026-10-05", status: 1, name: "u", uploaded: 1 },
      { date: now, status: 1, name: "u", uploaded: 1 },
    ]);

    const view = await mountHistory();
    try {
      const todayRow = rowByDate(now)!;
      const pastRow = rowByDate("2026-10-05")!;
      expect(todayRow).toBeTruthy();
      expect(pastRow).toBeTruthy();

      expect(todayRow.querySelector<HTMLInputElement>(".ant-checkbox-input")!.disabled).toBe(true);
      expect(pastRow.querySelector<HTMLInputElement>(".ant-checkbox-input")!.disabled).toBe(false);
      expect(todayRow.querySelector<HTMLButtonElement>(".ant-btn-dangerous")!.disabled).toBe(true);
      expect(pastRow.querySelector<HTMLButtonElement>(".ant-btn-dangerous")!.disabled).toBe(false);
    } finally {
      view.unmount();
    }
  });

  it("sendMessage reject 时提示失败（不再静默）", async () => {
    loadSiteHistoryDataMock.mockResolvedValue([{ date: "2026-10-05", status: 1, name: "u", uploaded: 1 }]);
    sendMessageMock.mockRejectedValue(new Error("offscreen unavailable"));

    const view = await mountHistory();
    try {
      rowByDate("2026-10-05")!.querySelector<HTMLButtonElement>(".ant-btn-dangerous")!.click();
      await view.settle();
      await flush();

      expect(confirmModalMock).toHaveBeenCalled();
      expect(runtimeStoreStub.showSnakebar).toHaveBeenCalledTimes(1);
      const [, options] = runtimeStoreStub.showSnakebar.mock.calls[0] as [string, { color: string }];
      expect(options.color).toBe("error");
      expect(sendMessageMock).toHaveBeenCalledWith(
        "removeSiteUserInfo",
        expect.objectContaining({ siteId: "testsite" }),
      );
    } finally {
      view.unmount();
    }
  });

  it("删除成功后提示成功并重新加载列表", async () => {
    loadSiteHistoryDataMock.mockResolvedValue([{ date: "2026-10-05", status: 1, name: "u", uploaded: 1 }]);
    sendMessageMock.mockResolvedValue(undefined);

    const view = await mountHistory();
    try {
      expect(loadSiteHistoryDataMock).toHaveBeenCalledTimes(1);
      rowByDate("2026-10-05")!.querySelector<HTMLButtonElement>(".ant-btn-dangerous")!.click();
      await view.settle();
      await flush();

      const [, options] = runtimeStoreStub.showSnakebar.mock.calls[0] as [string, { color: string }];
      expect(options.color).toBe("success");
      // 打开时 1 次 + 删除成功后 1 次
      expect(loadSiteHistoryDataMock).toHaveBeenCalledTimes(2);
    } finally {
      view.unmount();
    }
  });
});

describe("OPTIONSOVERVIEW-5：导出用户信息时部分站点失败必须提示", () => {
  async function mountExport() {
    const { default: Dialog } = await import("@/options/views/Overview/MyData/ExportUserInfoDialog.vue");
    return await mountDialogOpened(Dialog, { selectedSiteIds: ["good-site", "bad-site"] });
  }

  const clickOk = () => document.querySelector<HTMLButtonElement>(".ant-modal-footer .ant-btn-primary")!.click();

  it("单个站点读取失败时提示失败站点，成功站点照常导出", async () => {
    metadataStoreStub.siteNameMap = { "good-site": "Good Site", "bad-site": "Bad Site" };
    sendMessageMock.mockImplementation(async (type: string, siteId: string) => {
      if (type !== "getSiteUserInfo") return undefined;
      if (siteId === "bad-site") throw new Error("site definition missing");
      return { "2026-10-05": { name: "u", uploaded: 1024 } };
    });

    const view = await mountExport();
    try {
      clickOk();
      await view.settle();
      await flush();

      expect(saveAsMock, "成功站点仍应导出文件").toHaveBeenCalledTimes(1);
      expect(runtimeStoreStub.showSnakebar).toHaveBeenCalledTimes(1);
      const [content, options] = runtimeStoreStub.showSnakebar.mock.calls[0] as [string, { color: string }];
      expect(options.color).toBe("warning");
      expect(content).toContain("Bad Site");
    } finally {
      view.unmount();
    }
  });

  it("全部站点失败时只提示失败站点，不再重复弹「暂无数据」，也不导出空文件", async () => {
    metadataStoreStub.siteNameMap = { "good-site": "Good Site", "bad-site": "Bad Site" };
    sendMessageMock.mockRejectedValue(new Error("offscreen unavailable"));

    const view = await mountExport();
    try {
      clickOk();
      await view.settle();
      await flush();

      expect(saveAsMock).not.toHaveBeenCalled();
      expect(runtimeStoreStub.showSnakebar).toHaveBeenCalledTimes(1);
      const [content, options] = runtimeStoreStub.showSnakebar.mock.calls[0] as [string, { color: string }];
      expect(options.color).toBe("warning");
      expect(content).toContain("Bad Site");
      expect(content).not.toContain("暂无数据");
    } finally {
      view.unmount();
    }
  });
});
