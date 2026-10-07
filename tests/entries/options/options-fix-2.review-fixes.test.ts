/**
 * options-fix-2（第四波收口）回归网。
 *
 * 覆盖的问题（断言全部落在真实挂载后的行为 / 真实副作用上）：
 * - DOWNLOADER-3 可解释性：`throw`→`return false` 后丢失的失败原因，要能经
 *   MyClient 按下载器类型映射的一句可操作提示传到 BaseDeleteDialog 的失败提示里；
 * - OPTIONSSHELL-7 孪生：`removeSearchSnapshotData` 必须先外部删除成功再改内存，失败要保留记录并提示；
 * - OPTIONSOVERVIEW-8 残留：预设名不再依赖「当天零点」反查（跨自然日仍选中），
 *   且 a-range-picker 在只有起点/无区间时显示有效内容或占位，而不是整块空白。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, ref } from "vue";
import { createPinia, setActivePinia } from "pinia";

const { sendMessageMock, getDefinedSiteMetadataMock, filterMock } = vi.hoisted(() => ({
  sendMessageMock: vi.fn(async (_type: string, _payload?: any): Promise<any> => undefined),
  getDefinedSiteMetadataMock: vi.fn(async (siteId: string) => ({
    id: siteId,
    name: `站点 ${siteId}`,
    urls: [`https://${siteId}.example/`],
    isDead: false,
    searchEntry: { default: {} },
  })),
  filterMock: { state: {} as Record<string, any> },
}));

vi.mock("@/messages.ts", () => ({ sendMessage: sendMessageMock, onMessage: vi.fn() }));

/** SearchFilterBar 需要真实的 ETorrentStatus / sortTorrentTags，只替掉 metadata store 用到的站点定义查询 */
vi.mock("@ptd/site", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getDefinedSiteMetadata: getDefinedSiteMetadataMock,
}));

/** `getDownloaderMetaData` 依赖 Vite 的 `import.meta.glob`，单测环境下拿不到实体模块 */
vi.mock("@ptd/downloader", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getDownloaderMetaData: async (type: string) => ({ type, name: type, feature: {}, advanceAddTorrentOptions: {} }),
    getDownloaderIcon: () => "",
  };
});

/** 高级筛选字典换成可控 ref（SearchFilterBar 的日期/区间状态都在这里） */
vi.mock("@/options/views/Overview/SearchEntity/utils/filter.ts", async () => {
  const { ref: vueRef } = await import("vue");
  const { vi: vitest } = await import("vitest");

  const advanceItemPropsRef = vueRef<Record<string, any>>({ site: [], tags: [] });
  const advanceFilterDictRef = vueRef<Record<string, any>>({});
  const tableWaitFilterRef = vueRef("");
  const updateTableFilterValueFn = vitest.fn();
  const buildFilterDictFn = vitest.fn();

  filterMock.state = {
    advanceItemPropsRef,
    advanceFilterDictRef,
    tableWaitFilterRef,
    updateTableFilterValueFn,
    buildFilterDictFn,
  };

  return { tableCustomFilter: filterMock.state };
});

/** 站点名 / favicon 子组件会去读 store 并打后台消息，这里只关心父组件结构 */
const passthrough = (name: string, tag = "span") =>
  defineComponent({
    name,
    props: { siteId: { type: String, default: "" }, tag: { type: String, default: "span" } },
    setup(props, { slots }) {
      return () => h(tag, { class: `stub-${name}` }, slots.default?.() ?? props.siteId);
    },
  });
vi.mock("@/options/components/SiteName.vue", async () => ({ default: passthrough("SiteName") }));
vi.mock("@/options/components/SiteFavicon/Index.vue", async () => ({ default: passthrough("SiteFavicon") }));

import { piniaWebExtPersistencePlugin } from "~/extends/pinia/webExtPersistence.ts";
import { mountOptionsView, prepareOptionsPinia } from "../../helpers/optionsView.ts";
import { i18nInstance } from "@/options/plugins/i18n.ts";
import { useMetadataStore } from "@/options/stores/metadata.ts";
import { useRuntimeStore } from "@/options/stores/runtime.ts";

const t = i18nInstance.global.t;

let BaseDeleteDialog: any;
let MyClientView: any;
let SearchFilterBar: any;

beforeAll(async () => {
  prepareOptionsPinia();
  BaseDeleteDialog = (await import("@/options/components/DeleteDialog.vue")).default;
  MyClientView = (await import("@/options/views/Overview/MyClient/Index.vue")).default;
  SearchFilterBar = (await import("@/options/views/Overview/SearchEntity/SearchFilterBar.vue")).default;
});

beforeEach(() => {
  sendMessageMock.mockReset();
  sendMessageMock.mockImplementation(async () => undefined);
});

function modalOkButton() {
  // DeleteDialog 用 ok-type="danger"，antd 渲染成 ant-btn-dangerous（不带 ant-btn-primary）
  return document.querySelector<HTMLButtonElement>(".ant-modal-footer .ant-btn-dangerous")!;
}

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

function resetFilterMock() {
  filterMock.state.advanceFilterDictRef.value = emptyDict();
  filterMock.state.advanceItemPropsRef.value = { site: ["mteam"], tags: [] };
  filterMock.state.tableWaitFilterRef.value = "";
  filterMock.state.updateTableFilterValueFn.mockClear();
}

// ── DOWNLOADER-3：失败原因要能传到用户 ────────────────────────────────────

describe("DOWNLOADER-3：删除失败的原因可解释", () => {
  it("BaseDeleteDialog 把 failureHints 里的原因附在失败提示里，同一条原因只出现一次", async () => {
    const open = ref(true);
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
            confirmDelete: async () => false,
            failureHints: {
              "d1:hash-1": "群晖 DS920：同时删除数据",
              "d1:hash-2": "群晖 DS920：同时删除数据",
            },
          }),
      }),
      { pinia },
    );

    try {
      await view.settle();
      modalOkButton().click();
      await view.settle();

      expect(snackbar).toHaveBeenCalledTimes(1);
      const message = snackbar.mock.calls[0][0] as string;
      expect(message).toContain("d1:hash-1");
      // 原因必须带着（修复前只有「删除失败: id」）
      expect(message).toContain("群晖 DS920：同时删除数据");
      // 两条相同的原因不能重复堆叠
      expect(message.match(/同时删除数据/g)).toHaveLength(1);
      expect(snackbar.mock.calls[0][1]).toMatchObject({ color: "error" });
    } finally {
      view.unmount();
      snackbar.mockRestore();
    }
  });

  it("MyClient：Synology 未勾选「同时删除数据」时，提示里带上要勾选的那一项", async () => {
    const pinia = prepareOptionsPinia();
    const meta = useMetadataStore(pinia);
    meta.downloaders = {
      d1: {
        id: "d1",
        type: "synologyDownloadStation",
        name: "群晖 DS920",
        address: "http://ds920.local",
        enabled: true,
      },
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
      if (type === "deleteClientTorrent") return false; // 实体：未勾选删除数据时只回 false
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

      const lastCall = snackbar.mock.calls.at(-1)!;
      const message = lastCall[0] as string;
      expect(message).toContain("d1:hash-1");
      // 关键：必须告诉用户去勾哪个选项（修复前只有 id 列表）
      expect(message).toContain(t("MyClient.dialog.removeData"));
      expect(message).toContain("群晖 DS920");
      expect(lastCall[1]).toMatchObject({ color: "error" });
    } finally {
      view.unmount();
      snackbar.mockRestore();
    }
  });

  it("MyClient：无法归因的下载器（qBittorrent）不编造原因", async () => {
    const pinia = prepareOptionsPinia();
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
      if (type === "deleteClientTorrent") return false;
      return undefined;
    });

    const runtimeStore = useRuntimeStore(pinia);
    const snackbar = vi.spyOn(runtimeStore, "showSnakebar").mockImplementation(() => {});
    const view = mountOptionsView(MyClientView, { pinia, router: true });

    try {
      await view.settle(150);
      view.$<HTMLButtonElement>(`.ant-table button[title="${t("MyClient.action.delete")}"]`)!.click();
      await view.settle(80);
      modalOkButton().click();
      await view.settle(80);

      const lastCall = snackbar.mock.calls.at(-1)!;
      expect(lastCall[0]).toContain("d1:hash-1");
      expect(lastCall[0]).not.toContain(t("MyClient.dialog.removeData"));
    } finally {
      view.unmount();
      snackbar.mockRestore();
    }
  });
});

// ── OPTIONSSHELL-7 孪生：快照删除顺序 ─────────────────────────────────────

async function createMetadataStore() {
  const pinia = createPinia();
  pinia.use(piniaWebExtPersistencePlugin);
  createApp({ render: () => h("div") }).use(pinia);
  setActivePinia(pinia);

  const store = useMetadataStore(pinia);
  await store.$onReady();
  return store;
}

describe("OPTIONSSHELL-7 孪生：removeSearchSnapshotData 先外部删除成功再改内存", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    sendMessageMock.mockReset();
    sendMessageMock.mockImplementation(async () => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("外部删除失败时保留内存记录、给出提示，且不落盘", async () => {
    const store = await createMetadataStore();
    store.snapshots["snap1"] = { id: "snap1", name: "快照", createdAt: 0, recordCount: 3 } as any;
    const snackbarSpy = vi.spyOn(useRuntimeStore(), "showSnakebar");
    const saveSpy = vi.spyOn(store, "$save").mockResolvedValue(undefined);

    sendMessageMock.mockRejectedValueOnce(new Error("IndexedDB 上下文失效"));

    await expect(store.removeSearchSnapshotData("snap1")).resolves.toBeUndefined();

    // 修复前内存记录已被 delete：列表里看不到、存储里还占着，也无法重试
    expect(store.snapshots.snap1, "外部删除失败时不能把内存记录删掉").toBeDefined();
    expect(snackbarSpy).toHaveBeenCalledTimes(1);
    expect(snackbarSpy.mock.calls[0][1]).toMatchObject({ color: "error" });

    // 异常不再让 scheduleMetadataSave 短路，但也不应该把「已失败的删除」落盘
    await vi.advanceTimersByTimeAsync(600);
    expect(saveSpy).not.toHaveBeenCalled();
  });

  it("内存记录的删除发生在外部删除成功之后", async () => {
    const store = await createMetadataStore();
    store.snapshots["snap1"] = { id: "snap1", name: "快照", createdAt: 0, recordCount: 3 } as any;
    const saveSpy = vi.spyOn(store, "$save").mockResolvedValue(undefined);

    let snapshotsWhenSend = -1;
    sendMessageMock.mockImplementation(async (type: string) => {
      if (type === "removeSearchResultSnapshotData") {
        snapshotsWhenSend = Object.keys(store.snapshots).length;
      }
      return undefined;
    });

    await store.removeSearchSnapshotData("snap1");

    // 修复前是 0（先 delete 再 await），失败时就会留下「元数据没了、数据还在」的不一致
    expect(snapshotsWhenSend).toBe(1);
    expect(store.snapshots.snap1).toBeUndefined();
    await vi.advanceTimersByTimeAsync(600);
    expect(saveSpy).toHaveBeenCalledTimes(1);
  });
});

// ── OPTIONSOVERVIEW-8 残留 ───────────────────────────────────────────────

describe("OPTIONSOVERVIEW-8 残留：跨自然日后预设仍选中，区间选择器不再空白", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function timeMenu() {
    return Array.from(document.querySelectorAll<HTMLElement>(".search-filter-menu")).at(-1)!;
  }

  it("选「今天」后跨过自然日，radio 仍选中且 chip 仍是预设名", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-06T10:00:00"));

    resetFilterMock();
    const pinia = prepareOptionsPinia();
    const view = mountOptionsView(SearchFilterBar, { pinia });
    await view.settle();

    view.$<HTMLButtonElement>('[data-filter="time"]')!.click();
    await view.settle();
    const dates = Array.from(timeMenu().querySelectorAll<HTMLInputElement>("input[type=radio]"));
    expect(dates).toHaveLength(5);
    dates[0]!.click(); // 今天
    await view.settle();

    const time = filterMock.state.advanceFilterDictRef.value.time as [number, number];
    expect(time[1]).toBe(Infinity);
    expect(time[0]).toBe(new Date("2026-10-06T00:00:00").getTime());
    expect(view.$('[data-filter="time"]')?.textContent).toContain("今天");

    // 跨过自然日：dateStart("today") 变成 10-07，旧实现按「当天零点」反查必然匹配不上，
    // radio 会退回无选中态、chip 会退化成 `2026-10-06 ~ ∞`。
    vi.setSystemTime(new Date("2026-10-07T01:00:00"));
    filterMock.state.tableWaitFilterRef.value = "matrix";
    await view.settle();

    expect(view.$('[data-filter="time"]')?.textContent).toContain("今天");
    expect(view.$('[data-filter="time"]')?.textContent).not.toContain("∞");
    expect(timeMenu().querySelector(".ant-radio-wrapper-checked"), "跨日后预设 radio 不应变成无选中态").not.toBeNull();

    view.unmount();
  });

  it("选中预设时区间选择器显示生效的起点（终点留空占位），未筛选时两端都是占位", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-06T10:00:00"));

    resetFilterMock();
    const pinia = prepareOptionsPinia();
    const view = mountOptionsView(SearchFilterBar, { pinia });
    await view.settle();

    view.$<HTMLButtonElement>('[data-filter="time"]')!.click();
    await view.settle();
    Array.from(timeMenu().querySelectorAll<HTMLInputElement>("input[type=radio]"))[0]!.click(); // 今天
    await view.settle();

    const pickerInputs = () =>
      Array.from(document.querySelectorAll<HTMLInputElement>(".search-filter-menu .ant-picker input"));

    let inputs = pickerInputs();
    expect(inputs, "日期区间选择器必须存在，不能因为预设上界是 Infinity 就整块空白").toHaveLength(2);
    // 起点显示出来（修复前两边都是空字符串），终点为空但必须有占位文案
    expect(inputs[0]!.value).toContain("2026-10-06");
    expect(inputs[1]!.value).toBe("");
    expect(inputs[1]!.placeholder, "空的一端要有占位文案而不是无提示的空白").not.toBe("");

    // 完全未筛选（两端都无效）时仍然是两端占位，而不是渲染成多余的内容
    filterMock.state.advanceFilterDictRef.value.time = [-Infinity, Infinity];
    await view.settle();
    inputs = pickerInputs();
    expect(inputs[0]!.value).toBe("");
    expect(inputs[0]!.placeholder).not.toBe("");
    expect(inputs[1]!.placeholder).not.toBe("");

    view.unmount();
  });
});
