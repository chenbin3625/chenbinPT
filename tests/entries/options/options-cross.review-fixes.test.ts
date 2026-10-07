/**
 * options-cross（第二波跨包收口）回归网。
 *
 * 覆盖的问题（断言全部落在真实挂载后的行为 / 真实副作用上）：
 * - DOWNLOADER-3：MyClient 删除种子必须把 `deleteClientTorrent` 的 boolean 结果带出来，
 *   BaseDeleteDialog 必须把 `fulfilled && value === false` 也当失败；一个都没删掉时不能照常关窗；
 * - OPTIONSOVERVIEW-2 孪生：`canThisSiteShow` 不再因「用户信息有效」而恒真，元数据缺失的站点不进时间线；
 * - OPTIONSOVERVIEW-3 孪生：ActionTd 的批量本地下载失败必须提示（含首个失败原因），成功不打扰；
 * - OPTIONSOVERVIEW-1 孪生：SearchEntity 高级筛选弹窗的 5 个滑块必须是 range 双滑块；
 * - OPTIONSSETTINGS-8 收口：formValidateRules 的默认必填/URL 文案走 i18n（common.form.*）。
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h, ref } from "vue";

const { sendMessageMock, filterState, siteMetadataState } = vi.hoisted(() => ({
  sendMessageMock: vi.fn(async (_type: string, _payload?: any): Promise<any> => undefined),
  filterState: {} as Record<string, any>,
  siteMetadataState: { allAddedSiteMetadata: {} as Record<string, any> },
}));

vi.mock("@/messages.ts", () => ({ sendMessage: sendMessageMock, onMessage: vi.fn() }));

/** `getDownloaderMetaData` 依赖 Vite 的 `import.meta.glob`，单测环境下拿不到实体模块 */
vi.mock("@ptd/downloader", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getDownloaderMetaData: async (type: string) => ({ type, name: type, feature: {}, advanceAddTorrentOptions: {} }),
    getDownloaderIcon: () => "",
  };
});

/** 高级筛选弹窗只关心滑块接线：把 tableCustomFilter 换成可控 ref */
vi.mock("@/options/views/Overview/SearchEntity/utils/filter.ts", async () => {
  const { ref: vueRef } = await import("vue");
  const { vi: vitest } = await import("vitest");
  const MAX = 7 * 24 * 60 * 60 * 1000;
  const ranges = { time: [0, MAX], size: [0, MAX], seeders: [0, MAX], leechers: [0, MAX], completed: [0, MAX] };
  const advanceItemPropsRef = vueRef({
    site: [],
    tags: [],
    time: { range: ranges.time, ticks: [] },
    size: { range: ranges.size, ticks: [] },
    seeders: { range: ranges.seeders, ticks: [] },
    leechers: { range: ranges.leechers, ticks: [] },
    completed: { range: ranges.completed, ticks: [] },
  });
  const advanceFilterDictRef = vueRef({
    text: { required: [], exclude: [] },
    site: { required: [], exclude: [] },
    tags: { required: [], exclude: [] },
    status: { required: [], exclude: [] },
    ...ranges,
  });

  filterState.advanceItemPropsRef = advanceItemPropsRef;
  filterState.advanceFilterDictRef = advanceFilterDictRef;

  return {
    tableCustomFilter: {
      advanceItemPropsRef,
      advanceFilterDictRef,
      reBuildFilterCountRef: vueRef(0),
      toggleKeywordStateFn: vitest.fn(),
      reBuildAdvanceFilter: vitest.fn(),
      updateTableFilterValueFn: vitest.fn(),
    },
  };
});

vi.mock("@/options/directives/useAdvanceFilter.ts", () => ({
  setDateRangeByDatePicker: (values: [Date, Date]) => [values[0].getTime(), values[1].getTime()],
  getThisDateUnitRange: (_unit: string, range: [number, number]) => range,
}));

/** 站点元数据由测试直接摆放（模拟「站点定义已不在构建产物里」的缺失态） */
vi.mock("@/options/views/Overview/MyData/utils/siteMetadata.ts", async () => {
  const { shallowReactive } = await import("vue");
  const allAddedSiteMetadata = shallowReactive<Record<string, any>>({});
  siteMetadataState.allAddedSiteMetadata = allAddedSiteMetadata;
  return { allAddedSiteMetadata, loadAllAddedSiteMetadata: async () => allAddedSiteMetadata };
});

/** 站点名 / favicon 子组件会去读 store 并打后台消息，这里只关心父组件结构 */
const passthrough = (name: string, tag = "span") =>
  defineComponent({
    name,
    props: { siteId: { type: String, default: "" }, tag: { type: String, default: "span" } },
    setup:
      (props, { slots }) =>
      () =>
        h(tag, { class: `stub-${name}` }, slots.default?.() ?? props.siteId),
  });
vi.mock("@/options/components/SiteName.vue", async () => ({ default: passthrough("SiteName") }));
vi.mock("@/options/components/SiteFavicon/Index.vue", async () => ({ default: passthrough("SiteFavicon") }));

import { mountOptionsView, prepareOptionsPinia } from "../../helpers/optionsView.ts";
import { i18nInstance } from "@/options/plugins/i18n.ts";
import { useRuntimeStore } from "@/options/stores/runtime.ts";

const t = i18nInstance.global.t;

let BaseDeleteDialog: any;
let MyClientView: any;
let ActionTd: any;
let SearchEntityAdvanceDialog: any;
let timelineUtils: any;
let EResultParseStatus: any;

beforeAll(async () => {
  prepareOptionsPinia();
  BaseDeleteDialog = (await import("@/options/components/DeleteDialog.vue")).default;
  MyClientView = (await import("@/options/views/Overview/MyClient/Index.vue")).default;
  ActionTd = (await import("@/options/views/Overview/SearchEntity/ActionTd.vue")).default;
  SearchEntityAdvanceDialog = (await import("@/options/views/Overview/SearchEntity/AdvanceFilterGenerateDialog.vue"))
    .default;
  timelineUtils = await import("@/options/views/Overview/MyData/UserDataTimeline/utils.ts");
  ({ EResultParseStatus } = await import("@ptd/site"));
});

beforeEach(() => {
  sendMessageMock.mockReset();
  sendMessageMock.mockImplementation(async () => undefined);
});

function modalOkButton() {
  // DeleteDialog 用 ok-type="danger"，antd 渲染成 ant-btn-dangerous（不带 ant-btn-primary）
  return document.querySelector<HTMLButtonElement>(".ant-modal-footer .ant-btn-dangerous")!;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

// ── DOWNLOADER-3 / OPTIONSSHELL-1 调用方收口 ───────────────────────────────

describe("DOWNLOADER-3：删除失败必须由返回值可见，且全都失败时不能照常关窗", () => {
  it("confirmDelete 返回 false（未勾选删除数据）也算失败：提示 + 全部失败时保持弹窗打开", async () => {
    const open = ref(true);
    const allDelete = vi.fn();
    // 旧实现在 myClient 侧 await 但不 return，BaseDeleteDialog 只看到 fulfilled undefined
    const confirmDelete = vi.fn(async () => false);
    const pinia = prepareOptionsPinia();
    const runtime = useRuntimeStore(pinia);
    const snackbar = vi.spyOn(runtime, "showSnakebar").mockImplementation(() => {});

    const view = mountOptionsView(
      defineComponent({
        setup: () => () =>
          h(BaseDeleteDialog, {
            modelValue: open.value,
            "onUpdate:modelValue": (v: boolean) => (open.value = v),
            toDeleteIds: ["d1:hash-1", "d1:hash-2"],
            confirmDelete,
            onAllDelete: allDelete,
          }),
      }),
      { pinia },
    );

    try {
      await view.settle();
      modalOkButton().click();
      await view.settle();

      expect(confirmDelete).toHaveBeenCalledTimes(2);
      expect(snackbar).toHaveBeenCalledTimes(1);
      expect(snackbar.mock.calls[0][0]).toContain("d1:hash-1");
      expect(snackbar.mock.calls[0][1]).toMatchObject({ color: "error" });
      // 一个都没删掉：不关窗、不刷新父列表，用户可以改选项后重试
      expect(open.value).toBe(true);
      expect(allDelete).not.toHaveBeenCalled();
    } finally {
      view.unmount();
      snackbar.mockRestore();
    }
  });

  it("部分成功（一个 false、一个成功）时提示失败项并照常关窗刷新", async () => {
    const open = ref(true);
    const allDelete = vi.fn();
    const confirmDelete = vi.fn(async (toDeleteId: string) => (toDeleteId === "bad" ? false : undefined));
    const pinia = prepareOptionsPinia();
    const runtime = useRuntimeStore(pinia);
    const snackbar = vi.spyOn(runtime, "showSnakebar").mockImplementation(() => {});

    const view = mountOptionsView(
      defineComponent({
        setup: () => () =>
          h(BaseDeleteDialog, {
            modelValue: open.value,
            "onUpdate:modelValue": (v: boolean) => (open.value = v),
            toDeleteIds: ["good", "bad"],
            confirmDelete,
            onAllDelete: allDelete,
          }),
      }),
      { pinia },
    );

    try {
      await view.settle();
      modalOkButton().click();
      await view.settle();

      expect(snackbar).toHaveBeenCalledTimes(1);
      expect(snackbar.mock.calls[0][0]).toContain("bad");
      expect(open.value).toBe(false);
      expect(allDelete).toHaveBeenCalledTimes(1);
    } finally {
      view.unmount();
      snackbar.mockRestore();
    }
  });

  it("MyClient 端到端：deleteClientTorrent 返回 false 时弹失败提示（证明布尔结果带出了 Index.vue）", async () => {
    const pinia = prepareOptionsPinia();
    const { useMetadataStore } = await import("@/options/stores/metadata.ts");
    const meta = useMetadataStore(pinia);
    meta.downloaders = {
      d1: { id: "d1", type: "qbittorrent", name: "QB", address: "http://qb.local", enabled: true },
    } as any;

    const torrent = {
      clientId: "d1",
      id: "hash-1",
      infoHash: "hash-1",
      name: "删不掉的种子",
      progress: 50,
      totalSize: 1024,
      savePath: "/downloads",
      label: "",
      state: "downloading",
      uploadSpeed: 0,
      downloadSpeed: 0,
      ratio: 1,
    };

    const utils = await import("@/options/views/Overview/MyClient/utils.ts");
    utils.autoRefreshRunning.value = false;
    utils.torrents.value = {};
    utils.selectedDownloaderIds.value = [];
    utils.suspendedDownloaders.value = new Set();

    sendMessageMock.mockImplementation(async (type: string) => {
      if (type === "getClientTorrents") return [JSON.parse(JSON.stringify(torrent))];
      if (type === "deleteClientTorrent") return false; // 实体：删不掉
      return undefined;
    });

    const runtimeStore = useRuntimeStore(pinia);
    const snackbar = vi.spyOn(runtimeStore, "showSnakebar").mockImplementation(() => {});
    const view = mountOptionsView(MyClientView, { pinia, router: true });

    try {
      await view.settle(150);

      const deleteBtn = view.$<HTMLButtonElement>(`.ant-table button[title="${t("MyClient.action.delete")}"]`);
      expect(deleteBtn, "应渲染出行内删除按钮").not.toBeNull();
      deleteBtn!.click();
      await view.settle(80);

      modalOkButton().click();
      await view.settle(80);

      expect(snackbar).toHaveBeenCalled();
      const lastCall = snackbar.mock.calls.at(-1)!;
      expect(lastCall[0]).toContain("d1:hash-1");
      expect(lastCall[1]).toMatchObject({ color: "error" });
    } finally {
      view.unmount();
      snackbar.mockRestore();
    }
  });
});

// ── OPTIONSOVERVIEW-2 孪生：canThisSiteShow ────────────────────────────────

describe("OPTIONSOVERVIEW-2 孪生：canThisSiteShow 只以站点元数据为准", () => {
  it("元数据缺失（站点定义不在构建产物里）的站点不再进入时间线", async () => {
    const { canThisSiteShow, fixedLastUserInfo } = timelineUtils;
    const validUserInfo = { name: "u", joinTime: 1, status: EResultParseStatus.success };
    fixedLastUserInfo.value = {
      alive: validUserInfo,
      dead: validUserInfo,
      ghost: validUserInfo, // 元数据缺失
      nobody: { name: "u", joinTime: 1, status: EResultParseStatus.unknown }, // 用户信息无效
    };

    const table = siteMetadataState.allAddedSiteMetadata;
    table.alive = { hasUserInfo: true, isDead: false };
    table.dead = { hasUserInfo: false, isDead: true };
    // ghost 故意不写：模拟 loadAllAddedSiteMetadata 的 try/catch 把它排除在外

    try {
      expect(canThisSiteShow("alive")).toBe(true);
      // 注释里的意图：已死站点只要有有效用户信息就显示
      expect(canThisSiteShow("dead")).toBe(true);
      // 修复前这里恒为 true（`siteMetadata.hasUserInfo || isValidUserInfo(siteUserInfo)` 后半段恒真）
      expect(canThisSiteShow("ghost"), "元数据缺失的站点不能进入时间线").toBe(false);
      expect(canThisSiteShow("nobody")).toBe(false);
    } finally {
      fixedLastUserInfo.value = {};
      delete table.alive;
      delete table.dead;
    }
  });
});

// ── OPTIONSOVERVIEW-3 孪生：ActionTd 批量本地下载 ──────────────────────────

describe("OPTIONSOVERVIEW-3 孪生：批量本地下载失败不再静默", () => {
  async function mountActionTd(downloadResult: any) {
    sendMessageMock.mockImplementation(async (type: string) => {
      if (type === "downloadTorrent") {
        if (downloadResult instanceof Error) throw downloadResult;
        return downloadResult;
      }
      return undefined;
    });
    const pinia = prepareOptionsPinia();
    const runtime = useRuntimeStore(pinia);
    const snackbar = vi.spyOn(runtime, "showSnakebar").mockImplementation(() => {});
    const view = mountOptionsView(ActionTd, { pinia, props: { torrentItems: [{ site: "x", id: "1" }] } });
    await view.settle();
    return { view, snackbar };
  }

  it("downloadTorrent 返回 failed 时提示首个失败原因（error 色）", async () => {
    const { view, snackbar } = await mountActionTd({
      downloadId: 1,
      downloadStatus: "failed",
      errorMessage: "site not allowed",
    });
    try {
      const btn = view.$<HTMLButtonElement>(`button[title="${t("SearchEntity.ActionTd.localDownload")}"]`);
      expect(btn, "应渲染出「下载种子文件到本地」按钮").not.toBeNull();
      btn!.click();
      await view.settle(60);

      expect(snackbar).toHaveBeenCalledTimes(1);
      expect(snackbar.mock.calls[0][0]).toContain("site not allowed");
      expect(snackbar.mock.calls[0][0]).toContain(t("contentScript.localDownloadFailed"));
      expect(snackbar.mock.calls[0][1]).toMatchObject({ color: "error" });
    } finally {
      view.unmount();
      snackbar.mockRestore();
    }
  });

  it("消息通道 reject 时也有提示，且按钮 loading 复位", async () => {
    const { view, snackbar } = await mountActionTd(new Error("offscreen gone"));
    try {
      const btn = view.$<HTMLButtonElement>(`button[title="${t("SearchEntity.ActionTd.localDownload")}"]`);
      btn!.click();
      await view.settle(60);

      expect(snackbar).toHaveBeenCalledTimes(1);
      expect(snackbar.mock.calls[0][0]).toContain("offscreen gone");
      await flush();
      expect(view.$(`button[title="${t("SearchEntity.ActionTd.localDownload")}"]`)!.className).not.toContain(
        "ant-btn-loading",
      );
    } finally {
      view.unmount();
      snackbar.mockRestore();
    }
  });

  it("全部成功时不打扰用户", async () => {
    const { view, snackbar } = await mountActionTd({ downloadId: 2, downloadStatus: "success" });
    try {
      const btn = view.$<HTMLButtonElement>(`button[title="${t("SearchEntity.ActionTd.localDownload")}"]`);
      btn!.click();
      await view.settle(60);
      expect(snackbar).not.toHaveBeenCalled();
    } finally {
      view.unmount();
      snackbar.mockRestore();
    }
  });
});

// ── OPTIONSOVERVIEW-1 孪生：SearchEntity 高级筛选滑块 ───────────────────────

describe("OPTIONSOVERVIEW-1 孪生：SearchEntity 高级筛选弹窗的 5 个滑块必须是 range", () => {
  it("挂载后每个滑块渲染两个手柄，且元组没有被改写成标量", async () => {
    const warnings: string[] = [];
    const view = mountOptionsView(SearchEntityAdvanceDialog, {
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
      // 5 个单值滑块只有 5 个手柄；缺 range 时拖动一次就把 [min,max] 改写成标量
      expect(handles, "5 个 range 双滑块应渲染 10 个手柄").toHaveLength(10);
      expect(warnings.join("\n")).not.toContain('Invalid prop: type check failed for prop "value"');

      const dict = filterState.advanceFilterDictRef.value;
      for (const key of ["time", "size", "seeders", "leechers", "completed"]) {
        expect(Array.isArray(dict[key]), `${key} 应保持元组`).toBe(true);
        expect(dict[key]).toHaveLength(2);
      }
    } finally {
      view.unmount();
    }
  });
});

// ── OPTIONSSETTINGS-8：formValidateRules 默认文案走 i18n ───────────────────

describe("OPTIONSSETTINGS-8：formValidateRules 的默认文案来自 i18n", () => {
  it("不传 args 时返回 common.form.required / common.form.invalidUrl 的译文", async () => {
    const { formValidateRules } = await import("@/options/utils.ts");

    const required = formValidateRules.require();
    expect(required("")).toBe(t("common.form.required"));
    expect(required("站点名")).toBe(true);

    const url = formValidateRules.url();
    expect(url("not-a-url")).toBe(t("common.form.invalidUrl"));
    expect(url("https://example.com/")).toBe(true);

    // 调用方显式传入的文案仍然优先
    expect(formValidateRules.require("自定义文案")("")).toBe("自定义文案");
  });
});
