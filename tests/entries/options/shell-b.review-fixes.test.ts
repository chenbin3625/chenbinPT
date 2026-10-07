/**
 * options-shell-b 的修复回归网（OPTIONSSHELL-3 / 6 / 8 / 9 / 10，外加 PLAN 跨包契约里归本包的
 * 「OPTIONSOVERVIEW-1 指令侧防御」）。
 *
 * 每条用例都打在真实渲染 / 真实副作用上，旧实现下会红：
 * - OPTIONSSHELL-3：打开高级筛选弹窗（`reBuildAdvanceFilter()`）必须按当前筛选串重建勾选字典，
 *   只有「重置」按钮（`reBuildAdvanceFilter(true)`）才清空；点「生成」不再丢掉只存在于字符串里的筛选；
 * - OPTIONSSHELL-6：DownloaderLabel 在 `metadata.downloaders` 水合/被外部改写后必须更新名称与图标；
 * - OPTIONSSHELL-8：`checkFn` 解析为 false（不只是抛错）时也要在 resetTimeout 后复位连接指示；
 * - OPTIONSSHELL-9：快速切换下载器时，先发起的 `getDownloaderMetaData` 迟到结果不得覆盖当前下载器，
 *   加载失败也不留 unhandled rejection；
 * - OPTIONSSHELL-10：SiteName / SiteFavicon 的异步取值要做「当前性校验 + 失败回退」，
 *   并且 siteId 变化时必须重新取值；
 * - OPTIONSOVERVIEW-1（指令侧）：range 字段退化成标量时 `stringifyFilterDictFn` 不得抛 TypeError。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h, nextTick, ref, type Ref } from "vue";

// @ptd/site → adapter.ts → messages.ts 会读取 vite 的构建期常量（单测环境下不存在），必须在模块求值前补上
vi.hoisted(() => {
  (globalThis as any).__BROWSER__ = "chrome";
  (globalThis as any).__EXT_VERSION__ = "0.0.0.0";
  // SentToDownloaderDialog 的图标包装会调 chrome.runtime.getURL；这里给 happy-dom 补一个最小桩
  (globalThis as any).chrome = { runtime: { getURL: (path: string) => `chrome-extension://ptd-test/${path}` } };
});

/** 站点定义读取：SiteName 的竞态 / 失败路径都靠它控制时序 */
const siteMock = vi.hoisted(() => ({
  pending: {} as Record<string, { resolve: (v: any) => void; reject: (e: unknown) => void }>,
}));

vi.mock("@ptd/site", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getDefinedSiteMetadata: (siteId: string) => {
      let resolve!: (v: any) => void;
      let reject!: (e: unknown) => void;
      const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
      });
      siteMock.pending[siteId] = { resolve, reject };
      return promise;
    },
  };
});

/** 下载器元数据：SentToDownloaderDialog 的竞态 / 失败路径靠它控制时序 */
const downloaderMock = vi.hoisted(() => ({
  calls: [] as string[],
  pending: {} as Record<string, { resolve: (v: any) => void; reject: (e: unknown) => void }>,
}));

vi.mock("@ptd/downloader", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getDownloaderIcon: () => "",
    getDownloaderMetaData: (type: string) => {
      downloaderMock.calls.push(type);
      let resolve!: (v: any) => void;
      let reject!: (e: unknown) => void;
      const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
      });
      downloaderMock.pending[type] = { resolve, reject };
      return promise;
    },
  };
});

vi.mock("@/options/components/SiteFavicon/utils.ts", () => ({ getSiteFavicon: vi.fn() }));

vi.mock("@/options/components/SentToDownloaderDialog/utils.ts", () => ({
  createDynamicReplacePrompter: () => vi.fn(),
  sendTorrentToDownloader: vi.fn().mockResolvedValue(undefined),
}));

import { mountOptionsView, prepareOptionsPinia } from "../../helpers/optionsView.ts";

import { useTableCustomFilter } from "@/options/directives/useAdvanceFilter.ts";

/** unhandled rejection 探针：修复后的实现不应再产生 */
const unhandledRejections: unknown[] = [];
const onUnhandledRejection = (reason: unknown) => {
  unhandledRejections.push(reason);
};

beforeAll(() => {
  process.on("unhandledRejection", onUnhandledRejection);
});

afterAll(() => {
  process.off("unhandledRejection", onUnhandledRejection);
});

beforeEach(() => {
  unhandledRejections.length = 0;
  siteMock.pending = {};
  downloaderMock.pending = {};
  downloaderMock.calls.length = 0;
});

/* ------------------------------------------------------------------ *
 * OPTIONSSHELL-3：弹窗打开按当前筛选串重建，只有「重置」才清空
 * ------------------------------------------------------------------ */

function createSearchFilter() {
  return useTableCustomFilter<Record<string, any>>({
    parseOptions: { keywords: ["site", "tags"], ranges: ["size"] },
    titleFields: ["title"],
    format: { size: "size" },
  });
}

type TSearchFilter = ReturnType<typeof createSearchFilter>;

/** 与 views 里的用法一致：写进 v-model，并等 refDebounced 的窗口过去 */
async function applyFilterText(filter: TSearchFilter, text: string) {
  filter.tableWaitFilterRef.value = text;
  await nextTick();
  vi.advanceTimersByTime(1000);
  await nextTick();
}

function runFilter(filter: TSearchFilter, raw: Record<string, any>) {
  return filter.tableFilterFn(undefined, filter.tableFilterRef.value, { raw });
}

describe("OPTIONSSHELL-3：reBuildAdvanceFilter 区分重建与重置", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("打开弹窗（无参）按当前筛选串重建字典，点「生成」不再清空 site: 筛选", async () => {
    const filter = createSearchFilter();
    await applyFilterText(filter, "site:siteA");

    filter.reBuildAdvanceFilter(); // 弹窗打开

    // 旧实现这里被 buildFilterDictFn("") 清空成 { required: [], exclude: [] }
    expect(filter.advanceFilterDictRef.value.site).toEqual({ required: ["siteA"], exclude: [] });

    filter.updateTableFilterValueFn(); // 点「生成」
    expect(filter.tableWaitFilterRef.value).toContain("site:siteA");

    await applyFilterText(filter, filter.tableWaitFilterRef.value);
    expect(runFilter(filter, { title: "命中的行", site: "siteA" })).toBe(true);
    expect(runFilter(filter, { title: "被排除的行", site: "siteB" })).toBe(false);
  });

  it("打开弹窗不会丢掉只存在于字符串里的文本框筛选", async () => {
    const filter = createSearchFilter();
    await applyFilterText(filter, "hello");

    filter.reBuildAdvanceFilter();
    expect(filter.advanceFilterDictRef.value.text).toEqual({ required: ["hello"], exclude: [] });

    filter.updateTableFilterValueFn();
    expect(filter.tableWaitFilterRef.value).toContain("hello");
  });

  it("「重置」按钮（reBuildAdvanceFilter(true)）仍清空字典并生成空筛选", async () => {
    const filter = createSearchFilter();
    await applyFilterText(filter, "site:siteA size:1GB-2GB");

    filter.reBuildAdvanceFilter(true);

    expect(filter.advanceFilterDictRef.value.site).toEqual({ required: [], exclude: [] });
    expect(filter.advanceFilterDictRef.value.size).toEqual([-Infinity, Infinity]);

    filter.updateTableFilterValueFn();
    expect(filter.tableWaitFilterRef.value.trim()).toBe("");
  });
});

/* ------------------------------------------------------------------ *
 * OPTIONSOVERVIEW-1 的指令侧防御（PLAN §2 归本包）
 * ------------------------------------------------------------------ */

describe("OPTIONSOVERVIEW-1 指令侧防御：range 字段退化成标量时不得抛 TypeError", () => {
  it("number 格式的 range 值是标量时按下界生成筛选", () => {
    const filter = useTableCustomFilter<Record<string, any>>({
      parseOptions: { ranges: ["downloadAt"] },
      titleFields: ["title"],
      format: { downloadAt: { parse: Number, build: String } },
    });

    // 漏写 `range` 的 a-slider 拖动后会把 [min,max] 写成标量
    filter.advanceFilterDictRef.value.downloadAt = 1000;

    let text = "";
    expect(() => {
      text = filter.stringifyFilterDictFn();
    }).not.toThrow();
    expect(text).toBe("downloadAt:1000"); // 旧实现在 .map 处抛 `map is not a function`
  });

  it("size 格式的标量同样不抛错（parseSizeString 不接受 undefined）", () => {
    const filter = useTableCustomFilter<Record<string, any>>({
      parseOptions: { ranges: ["size"] },
      titleFields: ["title"],
      format: { size: "size" },
    });

    filter.advanceFilterDictRef.value.size = 5 * 1024 ** 3;
    expect(() => filter.stringifyFilterDictFn()).not.toThrow();
  });

  it("range 值缺失时退化为「无该范围筛选」，不抛错", () => {
    const filter = useTableCustomFilter<Record<string, any>>({
      parseOptions: { ranges: ["size"] },
      titleFields: ["title"],
      format: { size: "size" },
    });

    filter.advanceFilterDictRef.value.size = undefined;
    expect(() => filter.stringifyFilterDictFn()).not.toThrow();
    expect(filter.stringifyFilterDictFn()).toBe("");
  });
});

/* ------------------------------------------------------------------ *
 * OPTIONSSHELL-6：DownloaderLabel 必须跟随 store 更新
 * ------------------------------------------------------------------ */

describe("OPTIONSSHELL-6：DownloaderLabel 响应 metadata.downloaders 变化", () => {
  it("水合完成/外部改写后，名称、title、地址与图标都更新", async () => {
    const pinia = prepareOptionsPinia();
    const { useMetadataStore } = await import("@/options/stores/metadata.ts");
    const metadataStore = useMetadataStore(pinia);

    const { default: DownloaderLabel } = await import("@/options/components/DownloaderLabel.vue");
    const view = mountOptionsView(DownloaderLabel, { pinia, props: { downloader: "d1" } });
    await view.settle();

    // 尚未水合：兜底为 [d1] + 断连图标（与修复前一致）
    expect(view.$("strong")?.getAttribute("title")).toBe("[d1]");
    expect(view.$(".anticon-disconnect")).not.toBeNull();

    // 模拟插件水合 / 另一个标签页的 onChanged 最小 patch
    metadataStore.downloaders = {
      d1: {
        id: "d1",
        name: "QB #1",
        type: "qbittorrent",
        address: "http://127.0.0.1:8080",
        enabled: true,
        feature: {},
      },
    } as any;
    await view.settle();

    expect(view.text()).toContain("QB #1");
    expect(view.$("strong")?.getAttribute("title")).toBe("QB #1");
    expect(view.$("a")?.getAttribute("href")).toBe("http://127.0.0.1:8080");
    // 有配置后走真实图标，不再是断连兜底图标
    expect(view.$(".anticon-disconnect")).toBeNull();

    view.unmount();
  });
});

/* ------------------------------------------------------------------ *
 * OPTIONSSHELL-8：checkFn 返回 false / 抛错都要复位
 * ------------------------------------------------------------------ */

describe("OPTIONSSHELL-8：ConnectCheckButton 的失败指示必须复位", () => {
  it("checkFn 解析为 false 时 3xx ms 后回到 default 指示", async () => {
    const { default: ConnectCheckButton } = await import("@/options/components/ConnectCheckButton.vue");
    const checkFn = vi.fn().mockResolvedValue(false);
    const view = mountOptionsView(ConnectCheckButton, { props: { checkFn, resetTimeout: 300 } });
    await view.settle();

    expect(view.$(".anticon-wifi")).not.toBeNull(); // 初始 default

    (view.$("button") as HTMLButtonElement).click();
    await view.settle(60);
    expect(checkFn).toHaveBeenCalledTimes(1);
    expect(view.$(".anticon-disconnect")).not.toBeNull(); // 失败 → error

    // 旧实现只在 catch 分支调度 setTimeout，这条路径会永远停在 error
    await view.settle(400);
    expect(view.$(".anticon-wifi")).not.toBeNull();
    expect(view.$(".anticon-disconnect")).toBeNull();

    view.unmount();
  });

  it("checkFn 抛错时同样复位（原有行为不回归）", async () => {
    const { default: ConnectCheckButton } = await import("@/options/components/ConnectCheckButton.vue");
    const checkFn = vi.fn().mockRejectedValue(new Error("network down"));
    const view = mountOptionsView(ConnectCheckButton, { props: { checkFn, resetTimeout: 200 } });
    await view.settle();

    (view.$("button") as HTMLButtonElement).click();
    await view.settle(60);
    expect(view.$(".anticon-disconnect")).not.toBeNull();

    await view.settle(300);
    expect(view.$(".anticon-wifi")).not.toBeNull();

    view.unmount();
  });
});

/* ------------------------------------------------------------------ *
 * OPTIONSSHELL-9：SentToDownloaderDialog 的元数据竞态与失败
 * ------------------------------------------------------------------ */

describe("OPTIONSSHELL-9：下载器元数据必须只服务当前选中的下载器", () => {
  interface IDialogHandle {
    view: ReturnType<typeof mountOptionsView>;
    open: Ref<boolean>;
    metadataStore: any;
  }

  async function mountDialog(): Promise<IDialogHandle> {
    const pinia = prepareOptionsPinia();
    const { useMetadataStore } = await import("@/options/stores/metadata.ts");
    const { useConfigStore } = await import("@/options/stores/config.ts");
    const metadataStore = useMetadataStore(pinia);
    const configStore = useConfigStore(pinia);

    metadataStore.downloaders = {
      dA: { id: "dA", name: "A", type: "qbittorrent", address: "http://a", enabled: true, feature: {} },
      dB: { id: "dB", name: "B", type: "transmission", address: "http://b", enabled: true, feature: {} },
      dC: { id: "dC", name: "C", type: "broken", address: "http://c", enabled: true, feature: {} },
    } as any;
    metadataStore.lastDownloader = { id: "dA" };
    configStore.download.useQuickSendToClient = false;
    configStore.download.saveLastDownloader = false;

    const { default: SentToDownloaderDialog } = await import("@/options/components/SentToDownloaderDialog/Index.vue");

    const open = ref(true);
    const Host = defineComponent({
      name: "SentToDownloaderDialogHost",
      setup: () => () =>
        h(SentToDownloaderDialog, {
          modelValue: open.value,
          "onUpdate:modelValue": (v: boolean | undefined) => (open.value = v ?? false),
          torrentItems: [],
        }),
    });

    const view = mountOptionsView(Host, { pinia });
    await view.settle(60);
    return { view, open, metadataStore };
  }

  /** a-modal 会 teleport 到 body，因此断言从 document 查；用面板的 disabled class 判断当前元数据是否生效 */
  function advancePanelDisabled(): boolean {
    const item = document.querySelector(".ant-collapse-item");
    expect(item, "a-collapse 面板未渲染").not.toBeNull();
    return item!.classList.contains("ant-collapse-item-disabled");
  }

  async function selectDownloader(handle: IDialogHandle, downloaderId: string) {
    handle.open.value = false;
    await nextTick();
    handle.metadataStore.lastDownloader = { id: downloaderId };
    handle.open.value = true;
    await nextTick();
    await nextTick();
    await handle.view.settle(40);
  }

  it("先发起的下载器元数据迟到时不得覆盖当前下载器", async () => {
    const handle = await mountDialog();
    expect(downloaderMock.calls).toEqual(["qbittorrent"]);

    // 切换到 B：A 的元数据请求仍在 pending
    await selectDownloader(handle, "dB");
    expect(downloaderMock.calls).toEqual(["qbittorrent", "transmission"]);
    expect(advancePanelDisabled(), "切换后不应继续沿用 A 的元数据").toBe(true);

    // B 先返回（带一个高级选项）
    downloaderMock.pending["transmission"].resolve({
      type: "transmission",
      feature: {},
      advanceAddTorrentOptions: [{ key: "b-opt", name: "B Option", type: "boolean" }],
    });
    await handle.view.settle(40);
    expect(advancePanelDisabled()).toBe(false);

    // A 的响应迟到：旧实现会把它写进 selectedDownloaderMetadata，面板随之退回 A 的（空）选项
    downloaderMock.pending["qbittorrent"].resolve({
      type: "qbittorrent",
      feature: {},
      advanceAddTorrentOptions: [],
    });
    await handle.view.settle(60);

    expect(advancePanelDisabled(), "迟到的 A 元数据覆盖了当前选中的 B").toBe(false);
    expect(unhandledRejections).toEqual([]);

    handle.view.unmount();
  });

  it("元数据加载失败时面板置灰且不产生 unhandled rejection", async () => {
    const handle = await mountDialog();
    await selectDownloader(handle, "dC");

    downloaderMock.pending["broken"].reject(new Error("downloader module load failed"));
    await handle.view.settle(60);

    expect(advancePanelDisabled()).toBe(true);
    expect(unhandledRejections).toEqual([]);

    handle.view.unmount();
  });
});

/* ------------------------------------------------------------------ *
 * OPTIONSSHELL-10：SiteName / SiteFavicon 的当前性校验与失败回退
 * ------------------------------------------------------------------ */

function mountWithSiteId(component: any, initial: string) {
  const siteIdRef = ref(initial);
  const Host = defineComponent({
    name: "SiteIdHost",
    setup: () => () => h(component, { siteId: siteIdRef.value }),
  });
  const view = mountOptionsView(Host);
  return { view, siteIdRef };
}

describe("OPTIONSSHELL-10：SiteName", () => {
  async function prepareMetadataStore() {
    const pinia = prepareOptionsPinia();
    const { useMetadataStore } = await import("@/options/stores/metadata.ts");
    const metadataStore = useMetadataStore(pinia);
    // 非空 userConfig：getSiteUrl 直接用 config.url，getSiteName 则等 getDefinedSiteMetadata（被 mock 控制）
    metadataStore.sites = {
      siteA: { url: "https://a.example/" },
      siteB: { url: "https://b.example/" },
      broken: { url: "https://broken.example/" },
    } as any;
    return { pinia, metadataStore };
  }

  it("切换 siteId 后 href 跟随新站点，旧请求迟到不覆盖新名称", async () => {
    const { pinia } = await prepareMetadataStore();
    const { default: SiteName } = await import("@/options/components/SiteName.vue");
    const siteIdRef = ref("siteA");
    const Host = defineComponent({
      name: "SiteNameHost",
      setup: () => () => h(SiteName, { siteId: siteIdRef.value }),
    });
    const view = mountOptionsView(Host, { pinia });
    await view.settle(20);

    expect(view.text()).toBe("siteA");
    expect(view.$("a")?.getAttribute("href")).toBe("https://a.example/");

    // 切到 B：旧实现只在 setup 期取一次 href，这里会停在 a.example
    siteIdRef.value = "siteB";
    await nextTick();
    await view.settle(20);
    expect(view.$("a")?.getAttribute("href")).toBe("https://b.example/");
    expect(view.text()).toBe("siteB");

    siteMock.pending["siteB"].resolve({ name: "Name B" });
    await view.settle(20);
    expect(view.text()).toBe("Name B");

    // A 的响应迟到：旧实现会覆盖成 "Name A"
    siteMock.pending["siteA"].resolve({ name: "Name A" });
    await view.settle(40);
    expect(view.text()).toBe("Name B");
    expect(view.$("a")?.getAttribute("href")).toBe("https://b.example/");
    expect(unhandledRejections).toEqual([]);

    view.unmount();
  });

  it("站点定义读取失败时回退 siteId，不产生 unhandled rejection", async () => {
    const { pinia } = await prepareMetadataStore();
    const { default: SiteName } = await import("@/options/components/SiteName.vue");
    const view = mountOptionsView(SiteName, { pinia, props: { siteId: "broken" } });
    await view.settle(20);

    expect(view.text()).toBe("broken");

    siteMock.pending["broken"].reject(new TypeError("definition not found"));
    await view.settle(60);

    // 旧实现没有 .catch：这里既不会有回退（文本保持 broken 是兜底初值），也会留下 unhandled rejection
    expect(view.text()).toBe("broken");
    expect(siteMock.pending["broken"]).toBeDefined();
    expect(unhandledRejections).toEqual([]);

    view.unmount();
  });
});

describe("OPTIONSSHELL-10：SiteFavicon", () => {
  it("siteId 变化时重新取图，失败回退 NO_IMAGE", async () => {
    const { NO_IMAGE } = await import("@ptd/site");
    const { getSiteFavicon } = await import("@/options/components/SiteFavicon/utils.ts");
    const getSiteFaviconMock = vi.mocked(getSiteFavicon);
    getSiteFaviconMock.mockImplementation(async (site: string) => {
      if (site === "siteC") throw new Error("favicon unavailable");
      return `favicon://${site}`;
    });

    const { default: SiteFavicon } = await import("@/options/components/SiteFavicon/Index.vue");
    const siteIdRef = ref("siteA");
    const Host = defineComponent({
      name: "SiteFaviconHost",
      setup: () => () => h(SiteFavicon, { siteId: siteIdRef.value }),
    });
    const view = mountOptionsView(Host);
    await view.settle(20);

    expect(view.$("img")?.getAttribute("src")).toBe("favicon://siteA");

    // 旧实现只有 onMounted，实例复用渲染另一个 siteId 时不会重新取图
    siteIdRef.value = "siteB";
    await nextTick();
    await view.settle(20);
    expect(view.$("img")?.getAttribute("src")).toBe("favicon://siteB");

    // 失败路径：回退默认图，且不产生 unhandled rejection
    siteIdRef.value = "siteC";
    await nextTick();
    await view.settle(60);
    expect(view.$("img")?.getAttribute("src")).toBe(NO_IMAGE);
    expect(unhandledRejections).toEqual([]);

    view.unmount();
  });
});
