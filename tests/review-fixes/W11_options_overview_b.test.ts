import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, markRaw, nextTick, reactive, ref } from "vue";
import dayjs from "dayjs";
import Antd from "ant-design-vue";
import { createPinia, setActivePinia } from "pinia";
import { EResultParseStatus, ETorrentStatus } from "@ptd/site";

import { i18nInstance } from "@/options/plugins/i18n.ts";
import { mountOptionsView, prepareOptionsPinia } from "../helpers/optionsView.ts";

(globalThis as any).__BROWSER__ ??= "chrome";
(globalThis as any).__EXT_VERSION__ ??= "0.0.0.0";

async function flushAsync(turns = 10) {
  for (let i = 0; i < turns; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeStubComponent(name: string, tag = "span") {
  return defineComponent({
    name,
    props: {
      siteId: { type: String, default: "" },
    },
    setup:
      (props, { slots }) =>
      () =>
        h(tag, { "data-stub": name }, slots.default?.() ?? props.siteId),
  });
}

describe("F0156: realFormatRatio and formatRatio handle numeric strings and missing values safely", () => {
  it("formats numeric strings without TypeError and maps missing values to '-'", async () => {
    const { realFormatRatio, formatRatio } = await import("@/options/views/Overview/MyData/utils/format.ts");

    expect(realFormatRatio("2.34")).toBe("2.34");
    expect(realFormatRatio(" 12.345 ")).toBe("12.35");
    expect(realFormatRatio("10001")).toBe("∞");
    expect(realFormatRatio("∞")).toBe("∞");
    expect(realFormatRatio("Infinity")).toBe("∞");
    expect(realFormatRatio(-1)).toBe("∞");
    expect(realFormatRatio(Infinity)).toBe("∞");
    expect(realFormatRatio(0)).toBe("0.00");
    expect(realFormatRatio("")).toBe("-");
    expect(realFormatRatio("   ")).toBe("-");
    expect(realFormatRatio("abc")).toBe("-");
    expect(realFormatRatio(null)).toBe("-");
    expect(realFormatRatio(undefined)).toBe("-");
    expect(realFormatRatio(NaN)).toBe("-");
    expect(realFormatRatio(-Infinity)).toBe("-");

    expect(formatRatio({} as any)).toBe("-");
    expect(formatRatio({ ratio: undefined } as any)).toBe("-");
    expect(formatRatio({ ratio: null } as any)).toBe("-");
    expect(formatRatio({ ratio: "" } as any)).toBe("-");
    expect(formatRatio({ ratio: -1 } as any)).toBe("∞");
    expect(formatRatio({ ratio: "3.5" } as any)).toBe("3.50");
    expect(formatRatio({ trueRatio: "1.25" } as any, "trueRatio")).toBe("1.25");
  });
});

describe("F0155 & F0160: UserDataStatistic utils handle empty per-site history and zero-sum tooltips", () => {
  afterEach(() => {
    vi.doUnmock("@/messages.ts");
    vi.doUnmock("@/options/stores/metadata.ts");
    vi.resetModules();
  });

  it("skips empty per-site objects and invalid date keys in loadFullData without RangeError", async () => {
    vi.resetModules();
    vi.doMock("@/messages.ts", () => ({
      sendMessage: vi.fn(async (type: string) => {
        if (type === "getExtStorage") {
          return {
            "empty-site": {},
            "invalid-only": { "not-a-date": { status: EResultParseStatus.success, uploaded: 100 } },
            "valid-site": {
              "2026-03-01": {
                status: EResultParseStatus.success,
                uploaded: 100,
                downloaded: 50,
                bonus: 10,
                seeding: 1,
                seedingSize: 1024,
              },
              "2026-03-02": {
                status: EResultParseStatus.success,
                uploaded: 250,
                downloaded: 50,
                bonus: 25,
                seeding: 2,
                seedingSize: 2048,
              },
              badKey: { status: EResultParseStatus.success, uploaded: 999 },
            },
          };
        }
        return undefined;
      }),
    }));
    vi.doMock("@/options/stores/metadata.ts", () => ({
      useMetadataStore: () => ({
        getAddedSiteIds: ["empty-site", "invalid-only", "valid-site"],
      }),
    }));

    const { loadFullData } = await import("@/options/views/Overview/MyData/UserDataStatistic/utils.ts");
    const result = await loadFullData();

    expect(Object.keys(result.siteDateRange)).toEqual(["valid-site"]);
    expect(Object.keys(result.dailyUserInfo)).toEqual(["2026-03-01", "2026-03-02"]);
    expect(result.incrementalData["valid-site"]["2026-03-02"].uploaded).toBe(150);
  });

  it("renders '-' instead of Infinity% / -Infinity% when incremental tooltip sum is 0", async () => {
    const { buildPerSiteTooltipFormatter } = await import("@/options/views/Overview/MyData/UserDataStatistic/utils.ts");
    const formatter = buildPerSiteTooltipFormatter({
      formatValue: (v) => String(v),
      siteName: (site) => site,
      siteFavicon: () => "data:image/png;base64,",
      translate: (key) => key,
      isHighlighted: () => false,
      hideThreshold: 5,
    });

    const html = formatter([
      { name: "2026-03-02", seriesName: "siteA", data: 100, seriesIndex: 0, color: "#111" },
      { name: "2026-03-02", seriesName: "siteB", data: -100, seriesIndex: 1, color: "#222" },
    ]);

    expect(html).not.toContain("Infinity%");
    expect(html).not.toContain("-Infinity%");
    expect(html).not.toContain("NaN%");
    expect(html).toContain("siteA");
    expect(html).toContain("siteB");
    expect(html).toContain('<td style="text-align: right">-</td>');
  });
});

describe("F0147 & F0154: HistoryDataViewDialog clears stale state on site switch and renders numeric 0 bonuses", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock("@/messages.ts");
    vi.doUnmock("@/options/views/Overview/utils/antdConfirm.ts");
    vi.doUnmock("@/options/components/SiteName.vue");
    vi.doUnmock("@/options/components/SiteFavicon/Index.vue");
    vi.doUnmock("@/options/views/Overview/MyData/utils/lastUserData.ts");
    vi.resetModules();
    document.body.innerHTML = "";
  });

  it("clears tableSelected on site switch/load error, captures targetSiteId before confirm, and displays 0 bonuses", async () => {
    const siteBDeferred = createDeferred<any[]>();
    const confirmDeferred = createDeferred<boolean>();
    const loadSiteHistoryDataMock = vi.fn((targetSite: string) => {
      if (targetSite === "siteA") {
        return Promise.resolve([
          {
            date: "2026-03-01",
            site: "siteA",
            status: EResultParseStatus.success,
            uploaded: 1024,
            downloaded: 512,
            bonus: 0,
            seedingBonus: 0,
            updateAt: Date.now(),
          },
        ]);
      }
      if (targetSite === "siteB") {
        return siteBDeferred.promise;
      }
      return Promise.resolve([]);
    });
    const sendMessageMock = vi.fn(async () => undefined);
    const confirmModalMock = vi.fn(() => confirmDeferred.promise);

    vi.doMock("@/messages.ts", () => ({ sendMessage: sendMessageMock }));
    vi.doMock("@/options/views/Overview/utils/antdConfirm.ts", () => ({ confirmModal: confirmModalMock }));
    vi.doMock("@/options/components/SiteName.vue", () => ({ default: makeStubComponent("SiteName") }));
    vi.doMock("@/options/components/SiteFavicon/Index.vue", () => ({ default: makeStubComponent("SiteFavicon") }));
    vi.doMock("@/options/views/Overview/MyData/utils/lastUserData.ts", () => ({
      loadSiteHistoryData: loadSiteHistoryDataMock,
      tableData: ref([]),
      initTableData: vi.fn(),
    }));

    const pinia = prepareOptionsPinia();
    const { useRuntimeStore } = await import("@/options/stores/runtime.ts");
    const runtimeStore = useRuntimeStore(pinia);
    const showSnackbarSpy = vi.spyOn(runtimeStore, "showSnackbar").mockImplementation(() => {});

    const HistoryDataViewDialog = (await import("@/options/views/Overview/MyData/HistoryDataViewDialog.vue")).default;

    const open = ref(false);
    const siteId = ref("siteA");
    const Host = defineComponent({
      setup: () => () =>
        h(HistoryDataViewDialog as any, {
          modelValue: open.value,
          "onUpdate:modelValue": (v: boolean) => {
            open.value = v;
          },
          siteId: siteId.value,
        }),
    });

    const handle = mountOptionsView(Host, { pinia });
    try {
      open.value = true;
      await flushAsync(8);

      // F0154: numeric 0 bonus and seedingBonus render "0.00" (via BonusFormatSpan) instead of "-"
      const modalBody = document.body.querySelector(".ant-modal-body")!;
      expect(modalBody.textContent).toContain("0.00");

      // Select Site A's row checkbox
      const rowCheckbox = document.body.querySelector<HTMLInputElement>(".ant-table-tbody .ant-checkbox-input");
      expect(rowCheckbox).not.toBeNull();
      rowCheckbox!.click();
      await nextTick();

      const deleteBtn = Array.from(document.body.querySelectorAll<HTMLButtonElement>(".ant-table-footer button")).find(
        (btn) => btn.textContent?.includes(i18nInstance.global.t("common.remove")),
      );
      expect(deleteBtn).toBeDefined();
      expect(deleteBtn!.disabled).toBe(false);

      // Switch to Site B while Site B load is still pending: selection must be cleared and footer delete disabled
      siteId.value = "siteB";
      await nextTick();
      expect(deleteBtn!.disabled).toBe(true);

      // Reject Site B load: should be caught with error snackbar, and selection must stay empty
      siteBDeferred.reject(new Error("IPC failed"));
      await flushAsync(8);
      expect(showSnackbarSpy).toHaveBeenCalledWith(expect.any(String), { color: "error" });
      expect(deleteBtn!.disabled).toBe(true);

      // Verify targetSiteId is captured before await confirmModal
      siteId.value = "siteA";
      await flushAsync(8);
      const removeTitle = i18nInstance.global.t("common.remove");
      const rowDeleteBtn = document.body.querySelector<HTMLButtonElement>(
        `.ant-table-tbody button[title="${removeTitle}"]`,
      );
      expect(rowDeleteBtn).not.toBeNull();
      rowDeleteBtn!.click();
      await nextTick();

      // Switch siteId before confirming modal
      siteId.value = "siteB";
      confirmDeferred.resolve(true);
      await flushAsync(8);

      expect(sendMessageMock).toHaveBeenCalledWith("removeSiteUserInfo", {
        siteId: "siteA",
        date: ["2026-03-01"],
      });
    } finally {
      handle.unmount();
    }
  });
});

describe("F0161: lastUserData initTableData waits for configStore.$onReady before filtering sites", () => {
  afterEach(() => {
    vi.doUnmock("@/messages.ts");
    vi.doUnmock("@/options/stores/metadata.ts");
    vi.doUnmock("@/options/stores/config.ts");
    vi.doUnmock("@/options/stores/runtime.ts");
    vi.doUnmock("@/options/views/Overview/MyData/utils/siteMetadata.ts");
    vi.resetModules();
  });

  it("respects hydrated configStore.userInfo.showDeadSiteInOverview", async () => {
    vi.resetModules();
    const configReady = createDeferred<void>();
    const configState = reactive({
      userInfo: {
        showDeadSiteInOverview: false,
        showPassedSiteInOverview: false,
      },
      $onReady: vi.fn(() => configReady.promise),
    });

    vi.doMock("@/messages.ts", () => ({ sendMessage: vi.fn() }));
    vi.doMock("@/options/stores/config.ts", () => ({ useConfigStore: () => configState }));
    vi.doMock("@/options/stores/metadata.ts", () => ({
      useMetadataStore: () => ({
        $onReady: vi.fn(async () => {}),
        sites: { deadSite: { isOffline: false, allowQueryUserInfo: true } },
        lastUserInfo: {},
        getAddedSiteIds: ["deadSite"],
        siteNameMap: { deadSite: "Dead Site" },
      }),
    }));
    vi.doMock("@/options/stores/runtime.ts", () => ({
      useRuntimeStore: () => ({ userInfo: { flushPlan: {} }, showSnackbar: vi.fn() }),
    }));
    vi.doMock("@/options/views/Overview/MyData/utils/siteMetadata.ts", () => ({
      loadAllAddedSiteMetadata: vi.fn(async () => ({
        deadSite: { isDead: true, type: "private", combinedSiteName: "Dead Site" },
      })),
      isSiteOffline: () => false,
    }));

    const { initTableData, tableData } = await import("@/options/views/Overview/MyData/utils/lastUserData.ts");

    const initPromise = initTableData();
    await flushAsync(4);
    // Simulate storage hydration enabling showDeadSiteInOverview
    configState.userInfo.showDeadSiteInOverview = true;
    configReady.resolve();
    await initPromise;

    expect(configState.$onReady).toHaveBeenCalledTimes(1);
    expect(tableData.value.map((r) => r.site)).toEqual(["deadSite"]);
  });
});

describe("F0167: siteMetadataCache invalidation discards stale in-flight getSiteLevelMetadata", () => {
  afterEach(() => {
    vi.doUnmock("@/options/stores/metadata.ts");
    vi.resetModules();
  });

  it("ignores stale pre-invalidation metadata response and preserves newer loading/cache state", async () => {
    vi.resetModules();
    const firstCall = createDeferred<any>();
    const secondCall = createDeferred<any>();
    let generation = 1;

    const sitesRef = reactive<Record<string, any>>({
      siteA: { url: "https://a.example" },
    });
    const getSiteUserConfigMock = vi.fn(() => (generation === 1 ? firstCall.promise : secondCall.promise));
    const getSiteMetadataMock = vi.fn(async () => ({
      id: "siteA",
      name: "Site A",
      urls: ["https://a.example"],
      levelRequirements: [],
    }));

    vi.doMock("@/options/stores/metadata.ts", () => ({
      useMetadataStore: () => ({
        sites: sitesRef,
        getSiteUserConfig: getSiteUserConfigMock,
        getSiteMetadata: getSiteMetadataMock,
      }),
    }));

    const { getSiteLevelMetadata } = await import("@/options/views/Overview/MyData/utils/siteMetadataCache.ts");

    // Start first (stale) fetch
    expect(getSiteLevelMetadata("siteA").loaded).toBe(false);
    expect(getSiteUserConfigMock).toHaveBeenCalledTimes(2);

    // Mutate metadataStore.sites to trigger cache invalidation while first request is in flight
    sitesRef.siteB = { url: "https://b.example" };
    await nextTick();

    // Kick off a fresh post-invalidation load
    generation = 2;
    expect(getSiteLevelMetadata("siteA").loaded).toBe(false);
    expect(getSiteUserConfigMock).toHaveBeenCalledTimes(4);

    // Resolve the stale pre-invalidation request first
    firstCall.resolve({
      merge: {
        levelRequirements: [{ id: 1, name: "StaleLevel" }],
      },
    });
    await flushAsync(6);

    // Must not overwrite cache with stale data or clear the new loading state (no duplicate fetch triggered)
    const afterStale = getSiteLevelMetadata("siteA");
    expect(afterStale.loaded).toBe(false);
    expect(afterStale.levelRequirements).toEqual([]);
    expect(getSiteUserConfigMock).toHaveBeenCalledTimes(4);

    // Resolve fresh request
    secondCall.resolve({
      merge: {
        levelRequirements: [{ id: 2, name: "FreshLevel" }],
      },
    });
    await flushAsync(6);

    const afterFresh = getSiteLevelMetadata("siteA");
    expect(afterFresh.loaded).toBe(true);
    expect(afterFresh.levelRequirements[0]?.name).toBe("FreshLevel");
  });
});

describe("F0157: MyData multiOpen respects quickFilter and groupFilter when no rows are selected", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock("@/messages.ts");
    vi.doUnmock("@/options/views/Overview/MyData/utils/lastUserData.ts");
    vi.doUnmock("@/options/components/SiteName.vue");
    vi.doUnmock("@/options/components/SiteFavicon/Index.vue");
    vi.doUnmock("@/options/views/Overview/MyData/HistoryDataViewDialog.vue");
    vi.doUnmock("@/options/views/Overview/MyData/ExportUserInfoDialog.vue");
    vi.doUnmock("@/options/views/Overview/MyData/UserLevelRequirementsTd.vue");
    vi.resetModules();
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("opens only failed sites when quickFilter='failed' is active with no selection", async () => {
    const tableDataRef = ref([
      {
        site: "okSite",
        siteName: "OK Site",
        status: EResultParseStatus.success,
        updateAt: Date.now(),
        siteUserConfig: { groups: ["G1"], sortIndex: 1 },
      },
      {
        site: "badSite",
        siteName: "Bad Site",
        status: EResultParseStatus.needLogin,
        updateAt: Date.now(),
        siteUserConfig: { groups: ["G2"], sortIndex: 2 },
      },
    ]);

    vi.doMock("@/messages.ts", () => ({ sendMessage: vi.fn() }));
    vi.doMock("@/options/views/Overview/MyData/utils/lastUserData.ts", () => ({
      tableData: tableDataRef,
      initTableData: vi.fn(async () => {}),
      cancelFlushSiteLastUserInfo: vi.fn(),
      flushProgress: reactive({ total: 0, done: 0 }),
      flushSiteLastUserInfo: vi.fn(),
      formatFlushStatusMsg: () => undefined,
      isFlushFailed: (record: any) => record.status !== EResultParseStatus.success,
      isTableDataLoading: ref(false),
      reconcileFlushPlan: vi.fn(),
    }));
    vi.doMock("@/options/components/SiteName.vue", () => ({ default: makeStubComponent("SiteName") }));
    vi.doMock("@/options/components/SiteFavicon/Index.vue", () => ({ default: makeStubComponent("SiteFavicon") }));
    vi.doMock("@/options/views/Overview/MyData/HistoryDataViewDialog.vue", () => ({
      default: makeStubComponent("HistoryDataViewDialog", "div"),
    }));
    vi.doMock("@/options/views/Overview/MyData/ExportUserInfoDialog.vue", () => ({
      default: makeStubComponent("ExportUserInfoDialog", "div"),
    }));
    vi.doMock("@/options/views/Overview/MyData/UserLevelRequirementsTd.vue", () => ({
      default: makeStubComponent("UserLevelRequirementsTd"),
    }));

    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    const pinia = prepareOptionsPinia();
    const { useMetadataStore } = await import("@/options/stores/metadata.ts");
    const metadataStore = useMetadataStore(pinia);
    metadataStore.sites = {
      okSite: { url: "https://ok.example", groups: ["G1"] } as any,
      badSite: { url: "https://bad.example", groups: ["G2"] } as any,
    };

    const MyDataIndex = (await import("@/options/views/Overview/MyData/Index.vue")).default;
    const handle = mountOptionsView(MyDataIndex, { pinia, router: true });
    try {
      await handle.settle(50);

      // Click the "failed" quick filter chip
      const failedChip = handle.$<HTMLButtonElement>(".search-filter-chips .search-filter-chip");
      expect(failedChip).not.toBeNull();
      failedChip!.click();
      await nextTick();

      // Click "multiOpen" toolbar action button
      const openBtn = handle
        .$$<HTMLButtonElement>(".page-toolbar button")
        .find((btn) => btn.textContent?.includes(i18nInstance.global.t("MyData.index.multiOpen")));
      expect(openBtn).toBeDefined();
      openBtn!.click();
      await nextTick();

      expect(openSpy).toHaveBeenCalledTimes(1);
      expect(openSpy).toHaveBeenCalledWith("https://bad.example", "_blank", "noopener noreferrer");
    } finally {
      handle.unmount();
    }
  });
});

describe("F0162: UserDataStatistic/Index.vue waits for configStore.$onReady before applying persisted controls", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock("@/options/views/Overview/MyData/UserDataStatistic/utils.ts");
    vi.doUnmock("@/options/views/Overview/MyData/utils/siteMetadata.ts");
    vi.doUnmock("@/options/components/SiteName.vue");
    vi.doUnmock("@/options/components/SiteFavicon/Index.vue");
    vi.doUnmock("vue-echarts");
    vi.resetModules();
    document.body.innerHTML = "";
  });

  it("awaits configStore.$onReady so persisted selectedSites and userName are applied", async () => {
    const configReady = createDeferred<void>();

    vi.doMock("vue-echarts", () => ({
      default: makeStubComponent("VChart", "div"),
      THEME_KEY: Symbol("theme"),
    }));
    vi.doMock("@/options/components/SiteName.vue", () => ({ default: makeStubComponent("SiteName") }));
    vi.doMock("@/options/components/SiteFavicon/Index.vue", () => ({ default: makeStubComponent("SiteFavicon") }));
    vi.doMock("@/options/views/Overview/MyData/utils/siteMetadata.ts", () => ({
      allAddedSiteMetadata: reactive({
        siteA: { siteName: "Site A", faviconSrc: "" },
        siteB: { siteName: "Site B", faviconSrc: "" },
      }),
      loadAllAddedSiteMetadata: vi.fn(async () => {}),
    }));
    vi.doMock("@/options/views/Overview/MyData/UserDataStatistic/utils.ts", async (importOriginal) => {
      const actual = await importOriginal<Record<string, unknown>>();
      return {
        ...actual,
        loadFullData: vi.fn(async () => ({
          siteDateRange: { siteA: ["2026-03-01"], siteB: ["2026-03-01"] },
          dailyUserInfo: { "2026-03-01": { siteA: { uploaded: 10 }, siteB: { uploaded: 20 } } },
          incrementalData: { siteA: {}, siteB: {} },
        })),
      };
    });

    const pinia = createPinia();
    createApp({ render: () => null }).use(pinia);
    pinia.use(({ store }) => {
      (store as any).$save = vi.fn();
      if (store.$id === "config") {
        (store as any).$onReady = vi.fn(() => configReady.promise);
      } else {
        (store as any).$onReady = vi.fn(async () => {});
      }
    });
    setActivePinia(pinia);

    const { useConfigStore } = await import("@/options/stores/config.ts");
    const configStore = useConfigStore(pinia);

    const UserDataStatistic = (await import("@/options/views/Overview/MyData/UserDataStatistic/Index.vue")).default;
    const handle = mountOptionsView(UserDataStatistic, { pinia, router: true });
    try {
      await flushAsync(4);
      // Hydrate configStore after mount
      configStore.userStatisticControl.selectedSites = ["siteB"];
      configStore.userName = "HydratedUser";
      configReady.resolve();
      await flushAsync(8);

      const checkboxes = handle.$$<HTMLInputElement>(".user-statistic-site-list input[type='checkbox']");
      expect(checkboxes).toHaveLength(2);
      expect(checkboxes[0].checked).toBe(false);
      expect(checkboxes[1].checked).toBe(true);
      expect(configStore.userName).toBe("HydratedUser");
    } finally {
      handle.unmount();
    }
  });
});

describe("F0158, F0159 & F0163: UserDataTimeline handles undecoded favicons, MDI font loading, and configStore hydration", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock("vue-konva/core");
    vi.doUnmock("@/options/views/Overview/MyData/utils/siteMetadata.ts");
    vi.doUnmock("@/options/views/Overview/MyData/UserDataTimeline/utils.ts");
    vi.doUnmock("@/options/components/SiteName.vue");
    vi.doUnmock("@/options/components/SiteFavicon/Index.vue");
    vi.unstubAllGlobals();
    vi.resetModules();
    document.body.innerHTML = "";
  });

  it("waits for configStore.$onReady and document.fonts.load, and re-renders undecoded favicons on load", async () => {
    const configReady = createDeferred<void>();
    const fontLoadDeferred = createDeferred<unknown[]>();
    const fontLoadSpy = vi.fn(() => fontLoadDeferred.promise);
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: { load: fontLoadSpy },
    });

    const drawnImages: unknown[] = [];
    const createdCanvases: unknown[] = [];
    class FakeOffscreenCanvas {
      width: number;
      height: number;
      constructor(w: number, h: number) {
        this.width = w;
        this.height = h;
        createdCanvases.push(this);
      }
      getContext() {
        return {
          fillStyle: "",
          fillRect: vi.fn(),
          drawImage: (img: unknown) => {
            drawnImages.push(img);
          },
        };
      }
    }
    vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);

    // Fake undecoded HTMLImageElement supporting load listener
    const listeners = new Map<string, Set<() => void>>();
    const fakeImg: any = markRaw({
      complete: false,
      naturalWidth: 0,
      width: 24,
      height: 24,
      addEventListener: (ev: string, fn: () => void) => {
        if (!listeners.has(ev)) listeners.set(ev, new Set());
        listeners.get(ev)!.add(fn);
      },
      removeEventListener: (ev: string, fn: () => void) => {
        listeners.get(ev)?.delete(fn);
      },
    });

    const vkImageConfigs: any[] = [];
    const makeVkStub = (name: string) =>
      defineComponent({
        name,
        props: { config: { type: Object, default: () => ({}) } },
        setup(props, { slots, expose }) {
          const fakeNode = {
            isCached: () => true,
            cache: vi.fn(),
            image: () => props.config?.image,
            batchDraw: vi.fn(),
          };
          expose({ getNode: () => fakeNode, getStage: () => ({ toBlob: vi.fn() }) });
          return () => {
            if (name === "VkImage") vkImageConfigs.push(props.config);
            return h("div", { "data-vk": name }, slots.default?.());
          };
        },
      });

    vi.doMock("vue-konva/core", () => ({
      Stage: makeVkStub("VkStage"),
      Layer: makeVkStub("VkLayer"),
      Group: makeVkStub("VkGroup"),
      Rect: makeVkStub("VkRect"),
      Text: makeVkStub("VkText"),
      Line: makeVkStub("VkLine"),
      Image: makeVkStub("VkImage"),
    }));
    vi.doMock("@/options/components/SiteName.vue", () => ({ default: makeStubComponent("SiteName") }));
    vi.doMock("@/options/components/SiteFavicon/Index.vue", () => ({ default: makeStubComponent("SiteFavicon") }));
    vi.doMock("@/options/views/Overview/MyData/utils/siteMetadata.ts", () => ({
      allAddedSiteMetadata: reactive({
        siteA: { siteName: "Site A", faviconElement: fakeImg, isDead: false },
      }),
      isSiteOffline: () => false,
      loadAllAddedSiteMetadata: vi.fn(async () => {}),
    }));

    const fixedLastUserInfoRef = ref<Record<string, any>>({});
    const selectedSitesRef = ref<string[]>([]);
    const timelineData = ref({
      title: "Timeline",
      createAt: Date.now(),
      siteInfo: [
        {
          site: "siteA",
          name: "alice",
          levelName: "VIP",
          joinTime: Date.now() - 86400_000,
          uploaded: 1000,
          downloaded: 100,
          ratio: 10,
          seeding: 5,
          seedingSize: 500,
          bonus: 100,
        },
      ],
      totalInfo: {
        sites: 1,
        deadSites: 0,
        uploaded: 1000,
        downloaded: 100,
        ratio: 10,
        seeding: 5,
        seedingSize: 500,
        bonus: 100,
      },
      joinTimeInfo: { years: "1.0" },
      topInfo: {
        uploaded: { topSite: { site: "siteA" }, topValue: 1000, secondSite: { site: "siteA" }, secondValue: 0 },
      },
    });
    vi.doMock("@/options/views/Overview/MyData/UserDataTimeline/utils.ts", () => ({
      canThisSiteShow: () => true,
      timelineDataRef: { ref: timelineData, reset: vi.fn() },
      selectedSites: selectedSitesRef,
      topSiteRenderAttr: [{ iconFill: "gold", siteKey: "topSite", valueKey: "topValue" }],
      CTimelineUserInfoField: [{ name: "uploaded", format: (v: any) => String(v) }],
      image: (cfg: any) => cfg,
      text: (cfg: any) => cfg,
      divider: (cfg: any) => cfg,
      icon: (cfg: any) => cfg,
      fixedLastUserInfo: fixedLastUserInfoRef,
      loadFullData: vi.fn(async () => ({ siteA: { site: "siteA", joinTime: 1000 } })),
    }));

    const pinia = createPinia();
    createApp({ render: () => null }).use(pinia);
    pinia.use(({ store }) => {
      (store as any).$save = vi.fn();
      if (store.$id === "config") {
        (store as any).$onReady = vi.fn(() => configReady.promise);
      } else {
        (store as any).$onReady = vi.fn(async () => {});
      }
    });
    setActivePinia(pinia);

    const { useConfigStore } = await import("@/options/stores/config.ts");
    const configStore = useConfigStore(pinia);

    const TimelineView = (await import("@/options/views/Overview/MyData/UserDataTimeline/Index.vue")).default;
    const handle = mountOptionsView(TimelineView, { pinia, router: true });
    try {
      await flushAsync(4);
      // F0163: Still loading while configStore.$onReady is pending
      expect(handle.$(".ant-skeleton")).not.toBeNull();
      configStore.userDataTimelineControl.selectedSites = ["siteA"];
      configStore.userDataTimelineControl.showField = { uploaded: true } as any;
      configReady.resolve();
      await flushAsync(4);

      // F0159: document.fonts.load was called and is still awaited before finishing skeleton
      expect(fontLoadSpy).toHaveBeenCalledWith('24px "Material Design Icons For PTD"');
      expect(handle.$(".ant-skeleton")).not.toBeNull();

      fontLoadDeferred.resolve([]);
      await flushAsync(6);

      // Stage is now rendered; F0158: undecoded image must NOT have been drawn onto canvas yet
      expect(handle.$("[data-vk='VkStage']")).not.toBeNull();
      expect(drawnImages).toHaveLength(0);

      // Simulate image finishing load
      fakeImg.complete = true;
      fakeImg.naturalWidth = 16;
      for (const fn of Array.from(listeners.get("load") ?? [])) {
        fn();
      }
      await flushAsync(6);

      // Now favicon was drawn and cached
      expect(drawnImages.length).toBeGreaterThan(0);
      expect(drawnImages[0]).toBe(fakeImg);
      expect(createdCanvases.length).toBeGreaterThan(1);
    } finally {
      handle.unmount();
    }
  });
});

describe("F0165 & F0170: SearchEntity/AdvanceFilterGenerateDialog 3-state checkboxes and custom date picker", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock("@/options/components/SiteName.vue");
    vi.doUnmock("@/options/components/SiteFavicon/Index.vue");
    vi.doUnmock("@/options/views/Overview/SearchEntity/utils/filter.ts");
    vi.resetModules();
    document.body.innerHTML = "";
  });

  it("cycles site/tags/status through none -> required -> exclude -> none and handles unbounded time safely", async () => {
    const advanceFilterDictRef = ref<Record<string, any>>({
      text: { required: [], exclude: [] },
      site: { required: [], exclude: [] },
      tags: { required: [], exclude: [] },
      status: { required: [], exclude: [] },
      time: [-Infinity, Infinity],
      size: [-Infinity, Infinity],
      seeders: [-Infinity, Infinity],
      leechers: [-Infinity, Infinity],
      completed: [-Infinity, Infinity],
      uploadVolumeFactor: [0, 3],
      downloadVolumeFactor: [0, 1],
    });
    const advanceItemPropsRef = ref<Record<string, any>>({
      site: ["siteA"],
      tags: [{ name: "Free" }],
      time: { range: [-Infinity, Infinity], ticks: [] },
      size: { range: [-Infinity, Infinity], ticks: [] },
      seeders: { range: [-Infinity, Infinity], ticks: [] },
      leechers: { range: [-Infinity, Infinity], ticks: [] },
      completed: { range: [-Infinity, Infinity], ticks: [] },
    });

    vi.doMock("@/options/components/SiteName.vue", () => ({ default: makeStubComponent("SiteName") }));
    vi.doMock("@/options/components/SiteFavicon/Index.vue", () => ({ default: makeStubComponent("SiteFavicon") }));
    vi.doMock("@/options/views/Overview/SearchEntity/utils/filter.ts", () => ({
      tableCustomFilter: {
        advanceItemPropsRef,
        advanceFilterDictRef,
        reBuildFilterCountRef: ref(0),
        reBuildAdvanceFilter: vi.fn(),
        updateTableFilterValueFn: vi.fn(),
      },
    }));

    const pinia = prepareOptionsPinia();
    const Dialog = (await import("@/options/views/Overview/SearchEntity/AdvanceFilterGenerateDialog.vue")).default;

    // Capture a-range-picker props by mounting with custom stub for ARangePicker & APopover
    let lastRangePickerProps: any = null;
    const host = document.createElement("div");
    document.body.appendChild(host);
    const app = createApp(Dialog, { modelValue: true });
    app.use(pinia);
    app.use(i18nInstance);
    app.use(Antd as any);
    app.component(
      "APopover",
      defineComponent({
        setup:
          (_props, { slots }) =>
          () =>
            h("div", [slots.default?.(), slots.content?.()]),
      }),
    );
    app.component(
      "ARangePicker",
      defineComponent({
        props: ["value", "disabledDate"],
        emits: ["change"],
        setup(props, { emit }) {
          return () => {
            lastRangePickerProps = { ...props, emit };
            return h("div", { class: "stub-range-picker" });
          };
        },
      }),
    );
    app.mount(host);

    try {
      await flushAsync(6);

      // F0170: With empty results (range = [-Infinity, Infinity]), value is null (not Invalid Date) and disabledDate is safe
      expect(lastRangePickerProps.value).toBeNull();
      expect(lastRangePickerProps.disabledDate(dayjs("2026-03-10"))).toBe(false);

      // Selecting a custom range updates advanceFilterDictRef.time and picker reflects it
      const d1 = dayjs("2026-03-01");
      const d2 = dayjs("2026-03-05");
      lastRangePickerProps.emit("change", [d1, d2]);
      await nextTick();
      expect(advanceFilterDictRef.value.time).toEqual([d1.toDate().getTime(), d2.toDate().getTime()]);
      expect(lastRangePickerProps.value?.[0]?.valueOf()).toBe(d1.toDate().getTime());
      expect(lastRangePickerProps.value?.[1]?.valueOf()).toBe(d2.toDate().getTime());

      // Clearing picker resets advanceFilterDictRef.time to [-Infinity, Infinity]
      lastRangePickerProps.emit("change", null);
      await nextTick();
      expect(advanceFilterDictRef.value.time).toEqual([-Infinity, Infinity]);
      expect(lastRangePickerProps.value).toBeNull();

      // F0165: Site checkbox cycles none -> required -> exclude -> none
      const checkboxes = Array.from(document.body.querySelectorAll<HTMLElement>(".ant-checkbox-wrapper"));
      const siteCheckbox = checkboxes.find((el) => el.textContent?.includes("siteA"))!;
      const tagCheckbox = checkboxes.find((el) => el.textContent?.includes("Free"))!;
      const statusCheckbox = checkboxes.find((el) =>
        el.textContent?.includes(i18nInstance.global.t("torrent.status.seeding")),
      )!;

      // 1st click: none -> required
      siteCheckbox.click();
      await nextTick();
      expect(advanceFilterDictRef.value.site).toEqual({ required: ["siteA"], exclude: [] });

      // 2nd click: required -> exclude
      siteCheckbox.click();
      await nextTick();
      expect(advanceFilterDictRef.value.site).toEqual({ required: [], exclude: ["siteA"] });

      // 3rd click: exclude -> none
      siteCheckbox.click();
      await nextTick();
      expect(advanceFilterDictRef.value.site).toEqual({ required: [], exclude: [] });

      // Tags & status 3-state cycle
      tagCheckbox.click();
      tagCheckbox.click();
      await nextTick();
      expect(advanceFilterDictRef.value.tags).toEqual({ required: [], exclude: ["Free"] });

      statusCheckbox.click();
      statusCheckbox.click();
      await nextTick();
      expect(advanceFilterDictRef.value.status).toEqual({ required: [], exclude: [ETorrentStatus.seeding] });
    } finally {
      app.unmount();
      host.remove();
    }
  });
});

describe("F0164 & F0168: SearchEntity/Index.vue isolates reconciliation to search and preserves hidden promo column", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    sessionStorage.clear();
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock("@/messages.ts");
    vi.doUnmock("@/options/components/SiteName.vue");
    vi.doUnmock("@/options/components/SiteFavicon/Index.vue");
    vi.resetModules();
    document.body.innerHTML = "";
  });

  it("does not clobber mediaServerSearch/userInfo in-flight state and shows warning on search reconciliation (F0164)", async () => {
    vi.doMock("@/messages.ts", () => ({ sendMessage: vi.fn(), onMessage: vi.fn() }));
    vi.doMock("@/options/components/SiteName.vue", () => ({ default: makeStubComponent("SiteName") }));
    vi.doMock("@/options/components/SiteFavicon/Index.vue", () => ({ default: makeStubComponent("SiteFavicon") }));

    const pinia = prepareOptionsPinia();
    const { useRuntimeStore } = await import("@/options/stores/runtime.ts");
    const runtimeStore = useRuntimeStore(pinia);
    const snackbarSpy = vi.spyOn(runtimeStore, "showSnackbar").mockImplementation(() => {});

    // Simulate active background tasks on other pages + stale search state
    runtimeStore.mediaServerSearch.isSearching = true;
    runtimeStore.userInfo.flushPlan = { siteA: true };
    runtimeStore.search.isSearching = true;
    runtimeStore.search.searchPlan = {
      "siteA|$|default": { status: EResultParseStatus.waiting, siteId: "siteA" } as any,
    };

    const SearchEntityView = (await import("@/options/views/Overview/SearchEntity/Index.vue")).default;
    const handle = mountOptionsView(SearchEntityView, { pinia, router: true });
    try {
      await flushAsync(6);

      // Search state was reconciled and notified
      expect(runtimeStore.search.isSearching).toBe(false);
      expect(snackbarSpy).toHaveBeenCalledWith(i18nInstance.global.t("SearchEntity.index.alert.searchInterrupted"), {
        color: "warning",
      });

      // Other pages' active tasks MUST remain intact
      expect(runtimeStore.mediaServerSearch.isSearching).toBe(true);
      expect(runtimeStore.userInfo.flushPlan).toEqual({ siteA: true });
    } finally {
      handle.unmount();
    }
  });

  it("preserves manually hidden downloadVolumeFactor column on mount/hydration in factor mode, while reacting to later mode switches (F0168)", async () => {
    vi.doMock("@/messages.ts", () => ({ sendMessage: vi.fn(), onMessage: vi.fn() }));
    vi.doMock("@/options/components/SiteName.vue", () => ({ default: makeStubComponent("SiteName") }));
    vi.doMock("@/options/components/SiteFavicon/Index.vue", () => ({ default: makeStubComponent("SiteFavicon") }));

    const configReady = createDeferred<void>();
    const pinia = createPinia();
    createApp({ render: () => null }).use(pinia);
    pinia.use(({ store }) => {
      (store as any).$save = vi.fn();
      if (store.$id === "config") {
        (store as any).$onReady = vi.fn(() => configReady.promise);
      } else {
        (store as any).$onReady = vi.fn(async () => {});
      }
    });
    setActivePinia(pinia);

    const { useConfigStore } = await import("@/options/stores/config.ts");
    const configStore = useConfigStore(pinia);
    configStore.searchEntifyControl.promotionDisplay = "factor";
    configStore.tableBehavior.SearchEntity.columns = ["site", "title", "size", "action"];

    const SearchEntityView = (await import("@/options/views/Overview/SearchEntity/Index.vue")).default;
    const handle = mountOptionsView(SearchEntityView, { pinia, router: true });
    try {
      configReady.resolve();
      await flushAsync(6);

      // Must NOT re-add downloadVolumeFactor when it was already hidden on mount/hydration
      expect(configStore.tableBehavior.SearchEntity.columns).not.toContain("downloadVolumeFactor");

      // Switching away to tags then back to factor SHOULD auto-add it
      configStore.searchEntifyControl.promotionDisplay = "tags";
      await nextTick();
      configStore.searchEntifyControl.promotionDisplay = "factor";
      await nextTick();
      expect(configStore.tableBehavior.SearchEntity.columns).toContain("downloadVolumeFactor");

      // Switching back to tags removes it
      configStore.searchEntifyControl.promotionDisplay = "tags";
      await nextTick();
      expect(configStore.tableBehavior.SearchEntity.columns).not.toContain("downloadVolumeFactor");
    } finally {
      handle.unmount();
    }
  });
});

describe("F0166: KeepUploadDialog guards against stale epochs, resets all items synchronously, and clears timers", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.doUnmock("@/messages.ts");
    vi.doUnmock("@/options/components/SiteFavicon/Index.vue");
    vi.resetModules();
    document.body.innerHTML = "";
  });

  it("synchronously resets items beyond VERIFY_CONCURRENCY on base removal and ignores stale responses/timers", async () => {
    vi.useFakeTimers();
    const pendingRequests: Array<{ title: string; deferred: ReturnType<typeof createDeferred<any>> }> = [];
    const sendMessageMock = vi.fn((type: string, payload: any) => {
      if (type === "getTorrentInfoForVerification") {
        const deferred = createDeferred<any>();
        pendingRequests.push({ title: payload.title, deferred });
        return deferred.promise;
      }
      return Promise.resolve(undefined);
    });

    vi.doMock("@/messages.ts", () => ({ sendMessage: sendMessageMock }));
    vi.doMock("@/options/components/SiteFavicon/Index.vue", () => ({ default: makeStubComponent("SiteFavicon") }));

    const pinia = prepareOptionsPinia();
    const KeepUploadDialog = (await import("@/options/views/Overview/SearchEntity/KeepUploadDialog.vue")).default;

    const makeTorrent = (idx: number) => ({
      site: `site${idx}`,
      id: idx,
      title: `Torrent ${idx}`,
      size: 1000,
      link: `https://example.com/${idx}.torrent`,
      url: `https://example.com/${idx}`,
    });
    const torrents = [1, 2, 3, 4, 5, 6].map(makeTorrent);
    const open = ref(true);

    const Host = defineComponent({
      setup: () => () =>
        h(KeepUploadDialog as any, {
          modelValue: open.value,
          "onUpdate:modelValue": (v: boolean) => {
            open.value = v;
          },
          torrentItems: torrents as any,
        }),
    });

    const handle = mountOptionsView(Host, { pinia });
    try {
      await Promise.resolve();
      await nextTick();

      // Resolve all 6 initial verification requests with matching hashA
      const hashA = { infoHash: "hash-a", name: "t", length: 1000, files: [{ path: "a", length: 1000 }] };
      for (let i = 0; i < 6; i++) {
        await vi.waitFor(() => expect(pendingRequests.length).toBeGreaterThan(i));
        pendingRequests[i].deferred.resolve(hashA);
        await Promise.resolve();
        await Promise.resolve();
      }
      await vi.advanceTimersByTimeAsync(250);
      await nextTick();

      // Remove base item (index 0 -> Torrent 1), triggering restartVerification()
      const removeTitle = i18nInstance.global.t("SearchEntity.KeepUploadDialog.removeFromKeepUpload");
      const removeButtons = Array.from(
        document.body.querySelectorAll<HTMLButtonElement>(`button[title="${removeTitle}"]`),
      );
      expect(removeButtons).toHaveLength(6);
      removeButtons[0].click();
      await nextTick();

      // All 5 remaining items (including 5th item = Torrent 6 beyond concurrency 4) must be synchronously reset to loading/downloading
      const downloadingLabel = i18nInstance.global.t("SearchEntity.KeepUploadDialog.status.downloading");
      const listItems = Array.from(document.body.querySelectorAll(".ant-list-item"));
      expect(listItems).toHaveLength(5);
      for (const itemEl of listItems) {
        expect(itemEl.textContent).toContain(downloadingLabel);
      }

      // Resolve non-base Torrent 3 before new base Torrent 2 so a 200ms timer is scheduled, then close dialog
      const epoch2Requests = pendingRequests.slice(6);
      const reqTorrent3 = epoch2Requests.find((r) => r.title === "Torrent 3")!;
      expect(reqTorrent3).toBeDefined();
      reqTorrent3.deferred.resolve({ infoHash: "hash-b", name: "t", length: 1000, files: [] });
      await Promise.resolve();
      await Promise.resolve();

      // Closing dialog invalidates epoch and clears timers; advancing timers must not crash or mutate state
      open.value = false;
      await nextTick();
      await vi.advanceTimersByTimeAsync(500);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      handle.unmount();
    }
  });
});

describe("F0169: SearchEntity/utils/filter.ts waits for both metadataStore and configStore readiness", () => {
  afterEach(() => {
    vi.doUnmock("@/options/stores/metadata.ts");
    vi.doUnmock("@/options/stores/config.ts");
    vi.doUnmock("@/options/stores/runtime.ts");
    vi.resetModules();
  });

  it("restores lastSearchFilter even when metadataStore.$onReady resolves before configStore.$onReady", async () => {
    vi.resetModules();
    const metadataReady = createDeferred<void>();
    const configReady = createDeferred<void>();

    const metadataStore = reactive({
      lastSearchFilter: "site:siteA 1080p",
      $onReady: (cb?: () => void) =>
        metadataReady.promise.then(() => {
          cb?.();
        }),
      $save: vi.fn(),
    });
    const configStore = reactive({
      searchEntity: { saveLastFilter: false },
      $onReady: (cb?: () => void) =>
        configReady.promise.then(() => {
          cb?.();
        }),
    });
    const runtimeStore = reactive({
      search: { searchResult: [] },
    });

    vi.doMock("@/options/stores/metadata.ts", () => ({ useMetadataStore: () => metadataStore }));
    vi.doMock("@/options/stores/config.ts", () => ({ useConfigStore: () => configStore }));
    vi.doMock("@/options/stores/runtime.ts", () => ({ useRuntimeStore: () => runtimeStore }));

    const { tableCustomFilter } = await import("@/options/views/Overview/SearchEntity/utils/filter.ts");

    // metadataStore becomes ready FIRST while configStore still has default saveLastFilter=false
    metadataReady.resolve();
    await flushAsync(4);
    expect(tableCustomFilter.tableWaitFilterRef.value).toBe("");

    // configStore hydrates saveLastFilter=true AFTER metadataStore
    configStore.searchEntity.saveLastFilter = true;
    configReady.resolve();
    await flushAsync(4);

    expect(tableCustomFilter.tableWaitFilterRef.value).toBe("site:siteA 1080p");
    expect(tableCustomFilter.advanceFilterDictRef.value.site.required).toEqual(["siteA"]);
  });
});

describe("F0171: SearchFilterBar handles upper-bounded time filter [-Infinity, end] without '-Infinity' or Invalid Date", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock("@/options/components/SiteName.vue");
    vi.resetModules();
    document.body.innerHTML = "";
  });

  it("formats [-Infinity, end] as '~ yyyy-MM-dd' and binds [null, dayjs(end)] to range picker", async () => {
    vi.doMock("@/options/components/SiteName.vue", () => ({ default: makeStubComponent("SiteName") }));

    const pinia = prepareOptionsPinia();
    const { tableCustomFilter } = await import("@/options/views/Overview/SearchEntity/utils/filter.ts");
    const endTs = new Date("2026-04-01T12:00:00Z").getTime();
    tableCustomFilter.advanceFilterDictRef.value.time = [-Infinity, endTs];

    const SearchFilterBar = (await import("@/options/views/Overview/SearchEntity/SearchFilterBar.vue")).default;

    let capturedRangeValue: any = undefined;
    const host = document.createElement("div");
    document.body.appendChild(host);
    const app = createApp(SearchFilterBar);
    app.use(pinia);
    app.use(i18nInstance);
    app.use(Antd as any);
    app.component(
      "APopover",
      defineComponent({
        setup:
          (_props, { slots }) =>
          () =>
            h("div", [slots.default?.(), slots.content?.()]),
      }),
    );
    app.component(
      "ARangePicker",
      defineComponent({
        props: ["value"],
        setup(props) {
          return () => {
            capturedRangeValue = props.value;
            return h("div", { class: "stub-range-picker" });
          };
        },
      }),
    );
    app.mount(host);

    try {
      await nextTick();
      const timeChip = host.querySelector<HTMLButtonElement>('button[data-filter="time"]')!;
      expect(timeChip.textContent).toContain("~ 2026-04-01");
      expect(timeChip.textContent).not.toContain("-Infinity");
      expect(timeChip.textContent).not.toContain("Invalid Date");

      expect(Array.isArray(capturedRangeValue)).toBe(true);
      expect(capturedRangeValue[0]).toBeNull();
      expect(capturedRangeValue[1]?.valueOf()).toBe(endTs);
    } finally {
      app.unmount();
      host.remove();
    }
  });
});
