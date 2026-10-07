/**
 * DOWNLOADER-8（第五波收尾）：下载器「成功但降级」的告警必须在 UI 可见，且不能伪装成失败。
 *
 * 背景：offscreen 在下载器实体返回 success=true + message（如 uTorrent 直发 http(s) 链接拿不到
 * infoHash，暂停 / 标签 / 上传限速被跳过）时，曾经把 message 写进 `errorMessage` —— 于是只有下载历史
 * 详情弹窗按红色「失败原因」渲染，列表、重新下载弹窗、搜索页推送汇总全都看不到，用户以为设置生效了。
 * 现在告警走独立的 `warningMessage` 字段，本文件的断言都打在**真实渲染 / 真实汇总**上：
 *
 * - 列表：`completed` + `warningMessage` 的记录渲染 warning 色 tag（`.ant-tag-warning`），不是 error 红；
 * - 详情弹窗：告警 `type="warning"`、失败原因 `type="error"`，互不串门（判别力：写回 errorMessage 即红）；
 * - 重新下载弹窗：结果里只有 warningMessage 时按 warning 汇总并带上告警文案；
 * - 搜索页推送（ActionTd 的本地下载汇总）：只有告警、没有失败时也必须提示。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h, ref } from "vue";

import { mountOptionsView, prepareOptionsPinia } from "../../helpers/optionsView.ts";

// ActionTd / SentToDownloaderDialog 在模块求值期可能读 chrome.runtime
(globalThis as any).chrome ??= { runtime: { id: "test-extension-id" } };

const mocks = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  showSnakebar: vi.fn(),
  historyState: {} as Record<string, any>,
}));

vi.mock("@/messages.ts", () => ({ sendMessage: mocks.sendMessage, onMessage: vi.fn() }));

// 三个组件（下载历史 / 重新下载 / ActionTd）都只消费这两个 store 的少量字段，用替身即可
vi.mock("@/options/stores/runtime.ts", () => ({
  useRuntimeStore: () => ({ showSnakebar: mocks.showSnakebar }),
}));
vi.mock("@/options/stores/config.ts", () => ({
  useConfigStore: () => ({
    tableBehavior: { DownloadHistory: { sortBy: [], itemsPerPage: 20 } },
    enableTableMultiSort: false,
    updateTableBehavior: vi.fn(),
  }),
}));
vi.mock("@/options/stores/metadata.ts", () => ({
  useMetadataStore: () => ({ defaultDownloader: { id: undefined } }),
}));

// 下载历史的轮询 / 筛选与本条修复无关，替换成可控 ref，直接喂入记录
vi.mock("@/options/views/Overview/DownloadHistory/utils.ts", async () => {
  const vue = await import("vue");
  const icons = await import("@ant-design/icons-vue");

  const downloadHistory = vue.shallowRef<Record<string, any>>({});
  const downloadHistoryList = vue.computed(() => Object.values(downloadHistory.value));
  const isLoadingDownloadHistory = vue.ref(false);
  const downloadStatusMap = vue.computed(() => ({
    downloading: { title: "下载中", icon: icons.DownloadOutlined, color: "blue" },
    pending: { title: "等待中", icon: icons.ClockCircleOutlined, color: "orange" },
    completed: { title: "已完成", icon: icons.CheckOutlined, color: "green" },
    failed: { title: "错误", icon: icons.WarningOutlined, color: "red" },
  }));

  mocks.historyState = { downloadHistory };

  return {
    downloadHistory,
    downloadHistoryList,
    isLoadingDownloadHistory,
    downloadStatusMap,
    tableCustomFilter: {
      tableFilterRef: vue.ref(""),
      tableWaitFilterRef: vue.ref(""),
      tableFilterFn: () => true,
    },
    clearWatchingMap: vi.fn(),
    throttleLoadDownloadHistory: vi.fn(),
  };
});

/** 把依赖 store / 路由 / 站点元数据的子组件换成原样透传的桩，只保留父组件结构与事件 */
const passthrough = (name: string, tag = "div") =>
  defineComponent({
    name,
    setup:
      (_props, { slots }) =>
      () =>
        h(tag, { class: `stub-${name}` }, slots.default?.() ?? []),
  });

vi.mock("@/options/components/SiteFavicon/Index.vue", () => ({ default: passthrough("SiteFavicon", "i") }));
vi.mock("@/options/components/SiteName.vue", () => ({ default: passthrough("SiteName", "span") }));
vi.mock("@/options/components/TorrentTitleTd.vue", () => ({ default: passthrough("TorrentTitleTd") }));
vi.mock("@/options/components/DownloaderLabel.vue", () => ({ default: passthrough("DownloaderLabel", "span") }));
vi.mock("@/options/components/DeleteDialog.vue", () => ({ default: passthrough("DeleteDialog") }));
vi.mock("@/options/components/NavButton.vue", () => ({ default: passthrough("NavButton", "button") }));
vi.mock("@/options/components/NoDataPlaceholder.vue", () => ({ default: passthrough("NoDataPlaceholder") }));
vi.mock("@/options/views/Overview/DownloadHistory/AdvanceFilterGenerateDialog.vue", () => ({
  default: passthrough("AdvanceFilterGenerateDialog"),
}));
vi.mock("@/options/components/SentToDownloaderDialog/Index.vue", () => ({
  default: passthrough("SentToDownloaderDialog"),
}));
vi.mock("@/options/views/Overview/SearchEntity/KeepUploadDialog.vue", () => ({
  default: passthrough("KeepUploadDialog"),
}));

const WARNING = "uTorrent add-url 未返回 infoHash，添加后暂停 / 标签 / 上传限速设置未生效";

function makeRecord(overrides: Record<string, any>) {
  return {
    id: 1,
    siteId: "testsite",
    torrentId: "t1",
    title: "title",
    torrent: { site: "testsite", id: "t1", title: "title", link: "https://example.com/1" },
    downloaderId: "local",
    downloadAt: Date.now(),
    downloadStatus: "completed",
    addTorrentOptions: {},
    ...overrides,
  };
}

/** 挂载下载历史列表，并喂入给定记录 */
async function mountHistory(records: Record<string, any>[]) {
  // 先 import（触发 utils 的 mock 工厂），再写数据、再挂载
  const { default: IndexView } = await import("@/options/views/Overview/DownloadHistory/Index.vue");
  const { downloadHistory } = mocks.historyState;
  downloadHistory.value = Object.fromEntries(records.map((x) => [x.id!, x]));
  const view = mountOptionsView(IndexView, { pinia: prepareOptionsPinia() });
  await view.settle(60);
  return view;
}

/** a-modal 会 teleport 到 body，按类名在文档里找本次渲染的弹窗内容 */
const inDocument = (selector: string) => Array.from(document.querySelectorAll<HTMLElement>(selector));

beforeEach(() => {
  mocks.sendMessage.mockReset();
  mocks.showSnakebar.mockReset();
});

describe("DOWNLOADER-8：下载历史列表 / 详情必须把「成功但降级」渲染成告警而不是失败", () => {
  it("completed + warningMessage：列表渲染 warning 色 tag 与完整 tooltip，且没有 error 红", async () => {
    const view = await mountHistory([makeRecord({ warningMessage: WARNING })]);

    const warningTag = view.$<HTMLElement>(".ptd-download-warning");
    expect(warningTag, "列表必须给出告警标记，否则用户不知道设置没生效").not.toBeNull();
    expect(warningTag!.classList.contains("ant-tag-warning"), "告警应是 warning 色而不是 error 红").toBe(true);
    expect(warningTag!.classList.contains("ant-tag-error")).toBe(false);
    expect(warningTag!.textContent).toContain("告警");

    // tooltip 承载完整文案（列表列放不下长文案）
    for (const type of ["mouseover", "mouseenter", "mousemove"]) {
      warningTag!.dispatchEvent(new MouseEvent(type, { bubbles: true }));
    }
    await view.settle(300);
    const tooltip = inDocument(".ant-tooltip-inner").find((element) => element.textContent?.includes("infoHash"));
    expect(tooltip, "告警 tag 必须能通过 tooltip 展示完整文案").toBeTruthy();

    view.unmount();
  });

  it("列表里打开详情弹窗：告警走 warning alert，失败原因走 error alert（互不串门）", async () => {
    const view = await mountHistory([makeRecord({ warningMessage: WARNING })]);

    view.$<HTMLElement>(".ptd-download-warning")!.click();
    await view.settle(80);

    // 判别力：若 offscreen 把告警写回 errorMessage（旧行为），这里只会出现 error alert，本断言即红
    expect(inDocument(".ptd-download-warning-detail").length, "详情弹窗必须渲染告警 alert").toBe(1);
    expect(inDocument(".ant-alert-warning").length).toBe(1);
    expect(inDocument(".ant-alert-error").length, "成功但降级的记录不能被标成失败原因").toBe(0);
    expect(document.body.textContent).toContain("infoHash");

    view.unmount();
  });

  it("失败的记录仍只渲染红色「失败原因」，不会冒出告警 tag", async () => {
    const view = await mountHistory([makeRecord({ downloadStatus: "failed", errorMessage: "downloader rejected" })]);

    expect(view.$(".ptd-download-warning"), "没有告警字段就不该有告警标记").toBeNull();

    // 用状态 tag 打开详情
    view.$<HTMLElement>(".ant-table .ant-tag")!.click();
    await view.settle(80);

    expect(inDocument(".ant-alert-error").length).toBe(1);
    expect(inDocument(".ptd-download-warning-detail").length).toBe(0);
    expect(document.body.textContent).toContain("downloader rejected");

    view.unmount();
  });

  it("阴性对照：普通成功记录（无 warningMessage）不渲染任何告警", async () => {
    const view = await mountHistory([makeRecord({})]);

    expect(view.$(".ptd-download-warning")).toBeNull();
    expect(view.text()).toContain("已完成");

    view.unmount();
  });
});

describe("DOWNLOADER-8：重新下载弹窗的结果汇总必须带上告警", () => {
  const torrentItems = [
    makeRecord({ downloaderId: "local", torrent: { site: "testsite", id: "1", title: "t", link: "https://e/1" } }),
  ];

  it("只有 warningMessage、没有失败时：汇总用 warning 色并带上告警文案", async () => {
    mocks.sendMessage.mockResolvedValue({ downloadId: 1, downloadStatus: "completed", warningMessage: WARNING });

    const { default: Dialog } = await import("@/options/views/Overview/DownloadHistory/ReDownloadSelectDialog.vue");
    // a-modal 只在 open 由 false → true 时渲染内容，与真实调用方（点击后打开）保持一致
    const open = ref(false);
    const Host = defineComponent({
      name: "ReDownloadDialogHost",
      setup: () => () =>
        h(Dialog as any, {
          modelValue: open.value,
          "onUpdate:modelValue": (value: boolean) => (open.value = value),
          torrentItems,
        }),
    });
    const view = mountOptionsView(Host, { pinia: prepareOptionsPinia() });
    open.value = true;
    await view.settle(80);

    // 三个按钮：old / local / downloader，点「本地下载」触发 sendMessage
    const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>(".ant-modal-body .ant-list-item button"));
    expect(buttons.length).toBe(3);
    buttons[1]!.click();
    await view.settle(80);

    expect(mocks.showSnakebar).toHaveBeenCalledTimes(1);
    const [content, options] = mocks.showSnakebar.mock.calls[0] as [string, { color: string }];
    expect(options.color, "推送成功但有降级时不能用 success 色").toBe("warning");
    expect(content).toContain(WARNING);

    view.unmount();
  });
});

describe("DOWNLOADER-8：搜索页推送汇总不能把「成功但降级」吞掉", () => {
  it("ActionTd 本地下载批次只有告警时也要提示 warning", async () => {
    mocks.sendMessage.mockResolvedValue({ downloadId: 1, downloadStatus: "completed", warningMessage: WARNING });

    const { default: ActionTd } = await import("@/options/views/Overview/SearchEntity/ActionTd.vue");
    const view = mountOptionsView(ActionTd, {
      pinia: prepareOptionsPinia(),
      props: {
        torrentItems: [{ site: "testsite", id: "1", title: "t", link: "https://e/1" }],
        variant: "bar",
        showKeepUploadBtn: false,
      },
    });
    await view.settle();

    // 本地下载按钮（默认下载器为空时按钮组顺序为：推送 / 复制链接 / 本地下载）
    const buttons = view.$$<HTMLButtonElement>(".ptd-action-bar button");
    expect(buttons.length).toBe(3);
    buttons[2]!.click();
    await view.settle(80);

    expect(mocks.showSnakebar).toHaveBeenCalledTimes(1);
    const [content, options] = mocks.showSnakebar.mock.calls[0] as [string, { color: string }];
    expect(options.color).toBe("warning");
    expect(content).toContain(WARNING);

    view.unmount();
  });
});
