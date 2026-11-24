import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Antd from "ant-design-vue";
import { createPinia, setActivePinia } from "pinia";
import searchQueryParser from "search-query-parser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, nextTick, onUnmounted, ref } from "vue";
import { createMemoryHistory, createRouter } from "vue-router";

async function flushAsync(turns = 12) {
  for (let i = 0; i < turns; i++) {
    await Promise.resolve();
  }
  await new Promise((r) => setTimeout(r, 0));
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function stubChromeBase() {
  vi.stubGlobal("__BROWSER__", "chrome");
  const storage = new Map<string, any>();
  vi.stubGlobal("chrome", {
    runtime: {
      id: "test-ext",
      getURL: (path: string) => `chrome-extension://test-ext/${path}`,
      sendMessage: () => Promise.resolve(undefined),
      onMessage: { addListener: () => undefined, removeListener: () => undefined },
    },
    storage: {
      local: {
        get: (key: string) => Promise.resolve(storage.has(key) ? { [key]: storage.get(key) } : {}),
        set: (items: Record<string, any>) => {
          for (const [k, v] of Object.entries(items)) storage.set(k, v);
          return Promise.resolve();
        },
        remove: (key: string) => {
          storage.delete(key);
          return Promise.resolve();
        },
        onChanged: { addListener: () => undefined, removeListener: () => undefined },
      },
      onChanged: { addListener: () => undefined, removeListener: () => undefined },
    },
    cookies: { get: () => Promise.resolve(null), set: () => Promise.resolve(), getAll: () => Promise.resolve([]) },
  });
}

describe("F0123 & F0126: useAdvanceFilter open-ended ranges and null value guards", () => {
  it("matches open-ended lower/upper range queries from search-query-parser (F0123)", async () => {
    const { checkRangeValue } = await import("@/options/directives/useAdvanceFilter.ts");

    const parsedSeedersLower = searchQueryParser.parse("seeders:10-", {
      ranges: ["seeders"],
      tokenize: true,
      offsets: false,
      alwaysArray: true,
    }) as any;
    expect(parsedSeedersLower.seeders).toEqual({ from: "10", to: "" });
    expect(checkRangeValue(parsedSeedersLower, { seeders: 10 }, "seeders")).toBe(true);
    expect(checkRangeValue(parsedSeedersLower, { seeders: 42 }, "seeders")).toBe(true);
    expect(checkRangeValue(parsedSeedersLower, { seeders: 9 }, "seeders")).toBe(false);

    const parsedSeedersUpper = searchQueryParser.parse("seeders:-10", {
      ranges: ["seeders"],
      tokenize: true,
      offsets: false,
      alwaysArray: true,
    }) as any;
    expect(checkRangeValue(parsedSeedersUpper, { seeders: 0 }, "seeders")).toBe(true);
    expect(checkRangeValue(parsedSeedersUpper, { seeders: 10 }, "seeders")).toBe(true);
    expect(checkRangeValue(parsedSeedersUpper, { seeders: 11 }, "seeders")).toBe(false);

    const parsedSizeLower = searchQueryParser.parse("size:1GB-", {
      ranges: ["size"],
      tokenize: true,
      offsets: false,
      alwaysArray: true,
    }) as any;
    expect(checkRangeValue(parsedSizeLower, { size: 2 * 1024 ** 3 }, "size", { size: "size" })).toBe(true);
    expect(checkRangeValue(parsedSizeLower, { size: 500 * 1024 ** 2 }, "size", { size: "size" })).toBe(false);

    const parsedDateLower = searchQueryParser.parse("time:20250101T000000-", {
      ranges: ["time"],
      tokenize: true,
      offsets: false,
      alwaysArray: true,
    }) as any;
    expect(
      checkRangeValue(parsedDateLower, { time: new Date("2025-06-01T00:00:00Z").getTime() }, "time", {
        time: "date",
      }),
    ).toBe(true);
    expect(
      checkRangeValue(parsedDateLower, { time: new Date("2024-06-01T00:00:00Z").getTime() }, "time", {
        time: "date",
      }),
    ).toBe(false);

    const parsedZeroLower = searchQueryParser.parse("downloadVolumeFactor:0-", {
      ranges: ["downloadVolumeFactor"],
      tokenize: true,
      offsets: false,
      alwaysArray: true,
    }) as any;
    expect(checkRangeValue(parsedZeroLower, { downloadVolumeFactor: 0 }, "downloadVolumeFactor")).toBe(true);
    expect(checkRangeValue(parsedZeroLower, { downloadVolumeFactor: 1 }, "downloadVolumeFactor")).toBe(true);
  });

  it("handles null item values safely without TypeError or false 0 coercion (F0126)", async () => {
    const { checkKeywordValue, checkRangeValue } = await import("@/options/directives/useAdvanceFilter.ts");

    // null scalar in number keyword filter must return false without throwing
    expect(() =>
      checkKeywordValue({ status: ["2"] } as any, { status: null }, "status", { status: "number" }),
    ).not.toThrow();
    expect(checkKeywordValue({ status: ["2"] } as any, { status: null }, "status", { status: "number" })).toBe(false);

    // null elements inside array value must be skipped safely
    expect(
      checkKeywordValue({ status: ["2"] } as any, { status: [null, undefined, 2] }, "status", { status: "number" }),
    ).toBe(true);
    expect(
      checkKeywordValue({ status: ["2"] } as any, { status: [null, undefined] }, "status", { status: "number" }),
    ).toBe(false);

    // null in range filter must NOT coerce to 0 and falsely match [0, 0.5]
    expect(
      checkRangeValue(
        { downloadVolumeFactor: { from: 0, to: 0.5 } } as any,
        { downloadVolumeFactor: null },
        "downloadVolumeFactor",
      ),
    ).toBe(false);
    expect(
      checkRangeValue(
        { downloadVolumeFactor: { from: 0, to: 0.5 } } as any,
        { downloadVolumeFactor: "" },
        "downloadVolumeFactor",
      ),
    ).toBe(false);
  });
});

describe("F0115 & F0116: content script bootstrap data omits undefined and includes lang/theme/searchEntifyControl", () => {
  afterEach(() => {
    vi.doUnmock("@/messages.ts");
    vi.doUnmock("@/storage.ts");
    vi.doUnmock("@/content-script/app/App.vue");
    vi.resetModules();
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("getContentScriptBootstrapData omits undefined fields on fresh install and forwards lang/theme/searchEntifyControl", async () => {
    vi.resetModules();
    stubChromeBase();

    const handlers = new Map<string, (msg?: any) => Promise<any>>();
    let storedConfig: any = undefined;
    let storedMetadata: any = undefined;

    vi.doMock("@/messages.ts", () => ({
      onMessage: (name: string, fn: (msg?: any) => Promise<any>) => {
        handlers.set(name, fn);
      },
      sendMessage: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock("@/storage.ts", () => ({
      extStorage: {
        getItem: vi.fn(async (key: string) => (key === "config" ? storedConfig : storedMetadata)),
        setItem: vi.fn(async () => undefined),
      },
    }));

    const { invalidateStorageReadCache } = await import("@/background/utils/base.ts");
    const bootstrapHandler = handlers.get("getContentScriptBootstrapData");
    expect(bootstrapHandler).toBeDefined();

    // Fresh install: no undefined keys anywhere in config payload
    const freshPayload = await bootstrapHandler!();
    expect(Object.hasOwn(freshPayload.config, "contentScript")).toBe(false);
    expect(Object.hasOwn(freshPayload.config, "lang")).toBe(false);
    expect(Object.hasOwn(freshPayload.config, "theme")).toBe(false);
    expect(Object.hasOwn(freshPayload.config, "searchEntifyControl")).toBe(false);
    expect(freshPayload.config.download).toEqual({ saveLastDownloader: false });

    // Configured install: forwards lang, theme, searchEntifyControl, contentScript, and defined download options
    invalidateStorageReadCache("config");
    invalidateStorageReadCache("metadata");
    storedConfig = {
      lang: "en",
      theme: "dark",
      contentScript: { enabled: true, applyTheme: true, defaultOpenSpeedDial: true },
      searchEntifyControl: { showTorrentCover: true, titleDisplayMode: "middle" },
      download: { allowDirectSendToClient: true, allowDownloaderFilterForSite: undefined, useQuickSendToClient: false },
    };
    storedMetadata = {
      downloaders: {
        d1: { id: "d1", type: "qbittorrent", name: "QB", address: "http://localhost:8080", enabled: true },
      },
    };

    const configuredPayload = await bootstrapHandler!();
    expect(configuredPayload.config.lang).toBe("en");
    expect(configuredPayload.config.theme).toBe("dark");
    expect(configuredPayload.config.searchEntifyControl).toEqual({
      showTorrentCover: true,
      titleDisplayMode: "middle",
    });
    expect(configuredPayload.config.contentScript).toEqual({
      enabled: true,
      applyTheme: true,
      defaultOpenSpeedDial: true,
    });
    expect(configuredPayload.config.download).toEqual({
      allowDirectSendToClient: true,
      saveLastDownloader: false,
      useQuickSendToClient: false,
    });
    expect(Object.hasOwn(configuredPayload.config.download, "allowDownloaderFilterForSite")).toBe(false);
  });

  it("mountApp strips undefined nested properties before $patch and applies lang/theme/searchEntifyControl", async () => {
    vi.resetModules();
    stubChromeBase();
    // Stub MutationObserver so removing contentRoot in finally does not trigger background remounts across tests
    vi.stubGlobal(
      "MutationObserver",
      class {
        observe() {}
        disconnect() {}
        takeRecords() {
          return [];
        }
      },
    );
    vi.doMock("@/content-script/app/App.vue", () => ({
      default: defineComponent({ name: "StubApp", render: () => null }),
    }));

    const { mountApp, stripUndefinedProps } = await import("@/content-script/app/init.ts");
    const { piniaInstance } = await import("@/options/plugins/pinia.ts");
    const { i18nInstance } = await import("@/options/plugins/i18n.ts");
    const { useConfigStore } = await import("@/options/stores/config.ts");

    expect(stripUndefinedProps({ a: 1, b: undefined, nested: { x: undefined, y: false } })).toEqual({
      a: 1,
      nested: { y: false },
    });

    const mounted = mountApp(document as unknown as Document, {
      config: {
        lang: "en",
        theme: "dark",
        contentScript: undefined,
        download: { allowDownloaderFilterForSite: undefined, saveLastDownloader: false },
        searchEntifyControl: { showTorrentCover: true },
      },
      metadata: { downloaders: {} },
    });
    await flushAsync();

    try {
      const configStore = useConfigStore(piniaInstance);
      expect(configStore.contentScript).toBeDefined();
      expect(typeof configStore.contentScript.applyTheme).toBe("boolean");
      expect(configStore.lang).toBe("en");
      expect(configStore.theme).toBe("dark");
      expect(configStore.searchEntifyControl.showTorrentCover).toBe(true);
      expect(i18nInstance.global.locale.value).toBe("en");
    } finally {
      mounted.app.unmount();
      mounted.contentRoot.remove();
      i18nInstance.global.locale.value = "zh_CN";
    }
  });
});

describe("F0118: exhausting remount budget still unmounts Vue app", () => {
  afterEach(() => {
    vi.doUnmock("@/content-script/app/App.vue");
    vi.resetModules();
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("calls app.unmount() on the final removal after remount budget is exhausted", async () => {
    vi.resetModules();
    stubChromeBase();

    let unmountCalls = 0;
    vi.doMock("@/content-script/app/App.vue", () => ({
      default: defineComponent({
        name: "UnmountTrackingApp",
        setup() {
          onUnmounted(() => {
            unmountCalls += 1;
          });
          return () => null;
        },
      }),
    }));

    const { mountApp } = await import("@/content-script/app/init.ts");
    const { REMOUNT_MAX_ATTEMPTS } = await import("@/content-script/app/remountGuard.ts");

    mountApp(document as unknown as Document, {});
    await flushAsync();

    // Remove REMOUNT_MAX_ATTEMPTS + 1 times (the final one exhausts remount budget)
    for (let i = 0; i < REMOUNT_MAX_ATTEMPTS + 1; i++) {
      const root = document.body.querySelector(".ptd-content-script-root");
      expect(root).not.toBeNull();
      root!.remove();
      await flushAsync();
    }

    expect(document.body.querySelectorAll(".ptd-content-script-root")).toHaveLength(0);
    // Every single mounted instance (initial + REMOUNT_MAX_ATTEMPTS remounts) must be unmounted
    expect(unmountCalls).toBe(REMOUNT_MAX_ATTEMPTS + 1);
  });
});

describe("F0119: App.vue unmounting before dataReady does not install URL watcher", () => {
  afterEach(() => {
    vi.doUnmock("@/content-script/app/utils.ts");
    vi.resetModules();
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("skips installPageTypeUrlWatcher when unmounted before ptd_data_ready resolves", async () => {
    vi.resetModules();
    stubChromeBase();

    const installPageTypeUrlWatcher = vi.fn(() => vi.fn());
    const updatePageType = vi.fn(async () => undefined);

    vi.doMock("@/content-script/app/utils.ts", async (importOriginal) => {
      const original = (await importOriginal()) as Record<string, any>;
      return {
        ...original,
        installPageTypeUrlWatcher,
        updatePageType,
      };
    });

    const { default: App } = await import("@/content-script/app/App.vue");
    const { PTD_DATA_KEY, PTD_DATA_READY_KEY } = await import("@/content-script/app/injectionKeys.ts");
    const { i18nInstance } = await import("@/options/plugins/i18n.ts");

    const pinia = createPinia();
    setActivePinia(pinia);
    const dataReady = createDeferred<void>();

    const host = document.createElement("div");
    document.body.appendChild(host);
    const app = createApp(App)
      .use(pinia)
      .use(i18nInstance)
      .use(Antd as any);
    app.provide(PTD_DATA_KEY, { siteId: "testsite" });
    app.provide(PTD_DATA_READY_KEY, dataReady.promise);
    app.mount(host);

    // Unmount before dataReady resolves
    app.unmount();
    host.remove();

    dataReady.resolve();
    await flushAsync();

    expect(installPageTypeUrlWatcher).not.toHaveBeenCalled();
    expect(updatePageType).not.toHaveBeenCalled();
  });
});

describe("F0117: SiteListPage.vue counts resolved { downloadStatus: 'failed' } in handleLocalDownloadMulti", () => {
  afterEach(() => {
    vi.doUnmock("@/messages.ts");
    vi.doUnmock("@/content-script/app/utils.ts");
    vi.resetModules();
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("shows error snackbar when all local downloads resolve with downloadStatus: 'failed'", async () => {
    vi.resetModules();
    stubChromeBase();

    const sendMessageMock = vi.fn(async () => ({
      downloadId: 1,
      downloadStatus: "failed",
      errorMessage: "boom",
    }));
    vi.doMock("@/messages.ts", () => ({ sendMessage: sendMessageMock, onMessage: vi.fn() }));
    vi.doMock("@/content-script/app/utils.ts", () => ({
      copyTextToClipboard: vi.fn(async () => true),
      doKeywordSearch: vi.fn(async () => undefined),
      getTrustedLinkHosts: vi.fn(async () => new Set(["pt.example.com"])),
      sanitizeParsedTorrents: (torrents: any[]) => torrents,
      siteInstance: ref({
        transformListPage: vi.fn(async () => ({
          torrents: [
            { id: "1", site: "testsite", title: "T1", link: "https://pt.example.com/dl/1" },
            { id: "2", site: "testsite", title: "T2", link: "https://pt.example.com/dl/2" },
          ],
          keywords: "",
        })),
      }),
      wrapperConfirmFn: (fn: () => unknown) => fn(),
    }));

    const { default: SiteListPage } = await import("@/content-script/app/pages/SiteListPage.vue");
    const { PTD_DATA_KEY, REMOTE_DOWNLOAD_DIALOG_DATA_KEY } = await import("@/content-script/app/injectionKeys.ts");
    const { useConfigStore } = await import("@/options/stores/config.ts");
    const { useRuntimeStore } = await import("@/options/stores/runtime.ts");
    const { i18nInstance } = await import("@/options/plugins/i18n.ts");

    const pinia = createPinia();
    setActivePinia(pinia);
    const configStore = useConfigStore(pinia);
    // Enable stackedButtons so SpeedDialBtn renders visible label text inside each float button
    configStore.contentScript.stackedButtons = true;
    const runtimeStore = useRuntimeStore(pinia);
    const snackbarSpy = vi.spyOn(runtimeStore, "showSnackbar").mockImplementation(() => {});

    const host = document.createElement("div");
    document.body.appendChild(host);
    const app = createApp(SiteListPage)
      .use(pinia)
      .use(i18nInstance)
      .use(Antd as any);
    app.provide(PTD_DATA_KEY, { siteId: "testsite" });
    app.provide(REMOTE_DOWNLOAD_DIALOG_DATA_KEY, { show: false, torrents: [], isDefaultSend: false });
    app.mount(host);
    await flushAsync();

    try {
      const buttons = Array.from(host.querySelectorAll<HTMLElement>("button, .ant-float-btn"));
      const localDownloadLabel = i18nInstance.global.t("contentScript.speedDial.localDownload");
      const localDownloadBtn = buttons.find((el) => el.textContent?.includes(localDownloadLabel));
      expect(localDownloadBtn).toBeTruthy();

      // Case 1: all failed via resolved status
      localDownloadBtn!.click();
      await flushAsync();
      expect(snackbarSpy).toHaveBeenCalledWith(i18nInstance.global.t("contentScript.localDownloadFailed"), {
        color: "error",
      });

      // Case 2: partial failure (1 completed + 1 resolved failed)
      snackbarSpy.mockClear();
      sendMessageMock
        .mockResolvedValueOnce({ downloadId: 1, downloadStatus: "completed" } as any)
        .mockResolvedValueOnce({ downloadId: 2, downloadStatus: "failed", errorMessage: "err" });

      localDownloadBtn!.click();
      await flushAsync();
      expect(snackbarSpy).toHaveBeenCalledWith(
        i18nInstance.global.t("contentScript.localDownloadPartial", { success: 1, failed: 1 }),
        { color: "warning" },
      );
    } finally {
      app.unmount();
      host.remove();
    }
  });
});

describe("F0120: extractLinksManually supports magnet: in text/uri-list and falls back when empty", () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it("extracts magnet: and \\n-delimited links from text/uri-list and falls back to text/html when uri-list has no valid links", async () => {
    vi.resetModules();
    stubChromeBase();

    const { resolveDroppedTorrents } = await import("@/content-script/app/utils.ts");
    const pinia = createPinia();
    setActivePinia(pinia);

    const magnet = "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=test";
    const httpLink = "https://pt.example.com/download.php?id=99";

    const dtMagnet = new DataTransfer();
    dtMagnet.setData("text/uri-list", `# comment\n${magnet}\n${httpLink}`);
    const magnetRes = resolveDroppedTorrents(dtMagnet, "testsite", ["pt.example.com"]);
    expect(magnetRes.torrents.map((t) => t.link)).toEqual([magnet, httpLink]);

    // When text/uri-list only has comments or non-allowed schemes, fallback to text/html still runs
    const dtFallback = new DataTransfer();
    dtFallback.setData("text/uri-list", "# just a comment\njavascript:alert(1)");
    dtFallback.setData("text/html", `<a href="${magnet}">Magnet</a>`);
    const fallbackRes = resolveDroppedTorrents(dtFallback, "testsite", ["pt.example.com"]);
    expect(fallbackRes.torrents.map((t) => t.link)).toEqual([magnet]);
  });
});

describe("F0121, F0122 & F0124: SentToDownloaderDialog selection, lastDownloader cloning, and site/enabled eligibility", () => {
  afterEach(() => {
    vi.doUnmock("@/messages.ts");
    vi.doUnmock("@ptd/downloader");
    vi.resetModules();
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("renders pre-selected downloader via string ID, switches selection, clones lastDownloader options across dialogLeave, and filters ineligible lastDownloader", async () => {
    vi.resetModules();
    stubChromeBase();

    const sendMessageMock = vi.fn(async () => ({ downloadId: 1, downloadStatus: "completed" }));
    vi.doMock("@/messages.ts", () => ({ sendMessage: sendMessageMock, onMessage: vi.fn() }));
    vi.doMock("@ptd/downloader", async (importOriginal) => {
      const original = (await importOriginal()) as Record<string, any>;
      return {
        ...original,
        getDownloaderMetaData: vi.fn(async () => ({ advanceAddTorrentOptions: [] })),
      };
    });

    const { default: SentToDownloaderDialog } = await import("@/options/components/SentToDownloaderDialog/Index.vue");
    const { useConfigStore } = await import("@/options/stores/config.ts");
    const { useMetadataStore } = await import("@/options/stores/metadata.ts");
    const { useRuntimeStore } = await import("@/options/stores/runtime.ts");
    const { i18nInstance } = await import("@/options/plugins/i18n.ts");

    const pinia = createPinia();
    setActivePinia(pinia);
    const configStore = useConfigStore(pinia);
    const metadataStore = useMetadataStore(pinia);
    const runtimeStore = useRuntimeStore(pinia);
    vi.spyOn(runtimeStore, "showSnackbar").mockImplementation(() => {});

    configStore.download.useQuickSendToClient = false;
    configStore.download.saveLastDownloader = true;
    configStore.download.allowDownloaderFilterForSite = true;

    metadataStore.downloaders = {
      d1: {
        id: "d1",
        type: "qbittorrent",
        name: "AlphaQB",
        address: "http://127.0.0.1:8080",
        enabled: true,
        sortIndex: 200,
        excludedSites: ["siteB"],
        advanceAddTorrentOptions: { autoTMM: true },
      },
      d2: {
        id: "d2",
        type: "transmission",
        name: "BetaTR",
        address: "http://127.0.0.1:9091",
        enabled: true,
        sortIndex: 100,
        excludedSites: [],
        advanceAddTorrentOptions: {},
      },
    } as any;

    let savedLastDownloader: any;
    vi.spyOn(metadataStore, "setLastDownloader").mockImplementation(async (val: any) => {
      savedLastDownloader = val;
      metadataStore.lastDownloader = val;
    });

    const openRef = ref(true);
    const itemsRef = ref([{ id: "1", site: "siteA", title: "Movie 1", link: "https://a.test/1.torrent" }] as any[]);
    metadataStore.lastDownloader = {
      id: "d1",
      options: { savePath: "/movies", label: "hd", addAtPaused: true, advanceAddTorrentOptions: { autoTMM: true } },
    } as any;

    const host = document.createElement("div");
    document.body.appendChild(host);
    const app = createApp(
      defineComponent({
        setup: () => () =>
          h(SentToDownloaderDialog as any, {
            modelValue: openRef.value,
            "onUpdate:modelValue": (v: boolean) => {
              openRef.value = v;
            },
            torrentItems: itemsRef.value,
          }),
      }),
    )
      .use(pinia)
      .use(i18nInstance)
      .use(Antd as any);
    app.mount(host);
    await flushAsync();

    try {
      // F0121: pre-selected downloader renders visible label (not blank)
      const selectionItem = document.querySelector<HTMLElement>(".ant-select-selection-item");
      expect(selectionItem?.textContent).toContain("AlphaQB [http://127.0.0.1:8080]");

      // Click OK to send and save lastDownloader
      const okBtn = Array.from(document.querySelectorAll<HTMLButtonElement>(".ant-modal-footer button")).find((b) =>
        b.textContent?.includes(i18nInstance.global.t("common.dialog.ok")),
      );
      expect(okBtn).toBeTruthy();
      expect(okBtn!.disabled).toBe(false);
      okBtn!.click();
      await flushAsync(20);

      // F0122: even after modal closes & dialogLeave runs, saved lastDownloader options must NOT be wiped
      expect(savedLastDownloader?.id).toBe("d1");
      expect(savedLastDownloader?.options?.savePath).toBe("/movies");
      expect(savedLastDownloader?.options?.label).toBe("hd");
      expect(savedLastDownloader?.options?.addAtPaused).toBe(true);
      expect(savedLastDownloader?.options?.advanceAddTorrentOptions).toEqual({ autoTMM: true });

      // F0124: reopen for siteB where d1 is excluded -> must NOT select d1 or merge d1's stale "/movies" savePath
      itemsRef.value = [{ id: "2", site: "siteB", title: "Movie 2", link: "https://b.test/2.torrent" }];
      openRef.value = true;
      await flushAsync(20);

      // Only d2 is eligible for siteB, so single-downloader fallback selects d2 cleanly without stale options
      const selectionAfterSiteChange = document.querySelector<HTMLElement>(".ant-select-selection-item");
      expect(selectionAfterSiteChange?.textContent).toContain("BetaTR [http://127.0.0.1:9091]");
      const inputs = Array.from(document.querySelectorAll<HTMLInputElement>(".ant-select-auto-complete input"));
      expect(inputs.every((input) => input.value === "")).toBe(true);
    } finally {
      app.unmount();
      host.remove();
    }
  });
});

describe("F0125: sendTorrentToDownloader surfaces resolved failure errorMessage with error color", () => {
  afterEach(() => {
    vi.doUnmock("@/messages.ts");
    vi.doUnmock("@/options/stores/runtime.ts");
    vi.doUnmock("@/options/stores/metadata.ts");
    vi.resetModules();
  });

  it("shows error snackbar with errorMessage instead of noTasks when all tasks resolve failed", async () => {
    vi.resetModules();
    stubChromeBase();

    const sendMessageMock = vi.fn();
    const showSnackbar = vi.fn();
    vi.doMock("@/messages.ts", () => ({ sendMessage: sendMessageMock, onMessage: vi.fn() }));
    vi.doMock("@/options/stores/runtime.ts", () => ({
      useRuntimeStore: () => ({ search: { searchKey: "", searchPlanKey: "" }, showSnackbar }),
    }));
    vi.doMock("@/options/stores/metadata.ts", () => ({
      useMetadataStore: () => ({ getSearchSolutionName: () => "default", getSiteName: async () => "site" }),
    }));

    const { sendTorrentToDownloader } = await import("@/options/components/SentToDownloaderDialog/utils.ts");
    const { i18nInstance } = await import("@/options/plugins/i18n.ts");

    // Single resolved failure with errorMessage
    sendMessageMock.mockResolvedValueOnce({
      downloadId: 1,
      downloadStatus: "failed",
      errorMessage: "Connection refused",
    });
    await sendTorrentToDownloader([{ title: "Movie A" } as any], "d1", {} as any, vi.fn());
    expect(showSnackbar).toHaveBeenCalledTimes(1);
    const [singleMsg, singleOpts] = showSnackbar.mock.calls[0]!;
    expect(singleOpts).toEqual({ color: "error" });
    expect(singleMsg).toContain("Connection refused");
    expect(singleMsg).not.toBe(i18nInstance.global.t("SentToDownloaderDialog.noTasks"));

    // Multiple resolved failures with errorMessage
    showSnackbar.mockReset();
    sendMessageMock
      .mockResolvedValueOnce({ downloadId: 1, downloadStatus: "failed", errorMessage: "Auth failed" })
      .mockResolvedValueOnce({ downloadId: 2, downloadStatus: "failed", errorMessage: "Auth failed" });
    await sendTorrentToDownloader([{ title: "A" } as any, { title: "B" } as any], "d1", {} as any, vi.fn());
    expect(showSnackbar).toHaveBeenCalledTimes(1);
    const [multiMsg, multiOpts] = showSnackbar.mock.calls[0]!;
    expect(multiOpts).toEqual({ color: "error" });
    expect(multiMsg).toContain("2");
    expect(multiMsg).toContain("Auth failed");
    expect(multiMsg).not.toBe(i18nInstance.global.t("SentToDownloaderDialog.noTasks"));
  });
});

describe("F0127: TorrentFavoriteDialog staleness guard and loading state", () => {
  afterEach(() => {
    vi.doUnmock("@/messages.ts");
    vi.resetModules();
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("disables inputs and Save while loading and ignores stale getTorrentFavoriteStatus responses", async () => {
    vi.resetModules();
    stubChromeBase();

    const firstReq = createDeferred<any>();
    const secondReq = createDeferred<any>();
    const sendMessageMock = vi
      .fn()
      .mockImplementationOnce(() => firstReq.promise)
      .mockImplementationOnce(() => secondReq.promise);
    vi.doMock("@/messages.ts", () => ({ sendMessage: sendMessageMock, onMessage: vi.fn() }));

    const { default: TorrentFavoriteDialog } = await import("@/options/components/TorrentFavoriteDialog.vue");
    const { i18nInstance } = await import("@/options/plugins/i18n.ts");

    const pinia = createPinia();
    setActivePinia(pinia);

    const openRef = ref(true);
    const itemsRef = ref([{ site: "s1", id: "1", title: "First" }] as any[]);

    const host = document.createElement("div");
    document.body.appendChild(host);
    const app = createApp(
      defineComponent({
        setup: () => () =>
          h(TorrentFavoriteDialog as any, {
            modelValue: openRef.value,
            "onUpdate:modelValue": (v: boolean) => {
              openRef.value = v;
            },
            torrentItems: itemsRef.value,
          }),
      }),
    )
      .use(pinia)
      .use(i18nInstance)
      .use(Antd as any);
    app.mount(host);
    await flushAsync();

    try {
      // While first request is in flight, textarea and OK button must be disabled
      const textarea = document.querySelector<HTMLTextAreaElement>("textarea");
      const okBtn = Array.from(document.querySelectorAll<HTMLButtonElement>(".ant-modal-footer button")).find((b) =>
        b.textContent?.includes(i18nInstance.global.t("common.dialog.ok")),
      );
      expect(textarea?.disabled).toBe(true);
      expect(okBtn?.disabled).toBe(true);

      // Close and reopen for second torrent before first request settles
      openRef.value = false;
      await nextTick();
      itemsRef.value = [{ site: "s1", id: "2", title: "Second" }];
      openRef.value = true;
      await flushAsync();

      // Resolve second request first (key format from getTorrentFavoriteKey is `${site}-${id}`)
      secondReq.resolve({
        favorites: [{ key: "s1-2", favCategories: ["cat2"], comment: "second comment" }],
        favCategories: ["cat2"],
      });
      await flushAsync();
      expect(document.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("second comment");
      expect(document.querySelector<HTMLTextAreaElement>("textarea")?.disabled).toBe(false);

      // Late resolution of first request must NOT overwrite second torrent's state
      firstReq.resolve({
        favorites: [{ key: "s1-1", favCategories: ["cat1"], comment: "stale comment" }],
        favCategories: ["cat1"],
      });
      await flushAsync();
      expect(document.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("second comment");
    } finally {
      app.unmount();
      host.remove();
    }
  });
});

describe("F0128, F0129, F0130, F0134 & F0196: Verified UI component, CSS, and locale fixes", () => {
  afterEach(() => {
    vi.doUnmock("@/messages.ts");
    vi.doUnmock("@/options/components/SiteFavicon/utils.ts");
    vi.resetModules();
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("SiteName sets title tooltip to cached site name on cache hit (F0128)", async () => {
    vi.resetModules();
    stubChromeBase();

    const { default: SiteName } = await import("@/options/components/SiteName.vue");
    const { useMetadataStore } = await import("@/options/stores/metadata.ts");

    const pinia = createPinia();
    setActivePinia(pinia);
    const metadataStore = useMetadataStore(pinia);
    metadataStore.siteNameMap = { hdsky: "HDSky Friendly Name" };

    const host = document.createElement("div");
    document.body.appendChild(host);
    const app = createApp(SiteName, { siteId: "hdsky", tag: "span" })
      .use(pinia)
      .use(Antd as any);
    app.mount(host);
    await flushAsync();

    try {
      const span = host.querySelector("span");
      expect(span?.textContent).toBe("HDSky Friendly Name");
      expect(span?.getAttribute("title")).toBe("HDSky Friendly Name");
    } finally {
      app.unmount();
      host.remove();
    }
  });

  it("SiteFavicon.doFlush preserves existing icon on error and guards stale siteId (F0129)", async () => {
    vi.resetModules();
    stubChromeBase();

    const flushDeferred = createDeferred<string>();
    const getSiteFavicon = vi
      .fn()
      .mockResolvedValueOnce("data:image/png;base64,INITIAL_A")
      .mockRejectedValueOnce(new Error("network fail"))
      .mockImplementationOnce(() => flushDeferred.promise)
      .mockResolvedValueOnce("data:image/png;base64,SITE_B");

    vi.doMock("@/options/components/SiteFavicon/utils.ts", () => ({ getSiteFavicon }));

    const { default: SiteFavicon } = await import("@/options/components/SiteFavicon/Index.vue");
    const siteIdRef = ref("siteA");

    const host = document.createElement("div");
    document.body.appendChild(host);
    const app = createApp(
      defineComponent({
        setup: () => () => h(SiteFavicon as any, { siteId: siteIdRef.value, flushOnClick: true }),
      }),
    ).use(Antd as any);
    app.mount(host);
    await flushAsync();

    try {
      const img = () => host.querySelector("img");
      expect(img()?.getAttribute("src")).toBe("data:image/png;base64,INITIAL_A");

      // Click to flush -> rejects -> must keep existing icon instead of wiping to NO_IMAGE
      host.querySelector(".ant-image")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await flushAsync();
      expect(img()?.getAttribute("src")).toBe("data:image/png;base64,INITIAL_A");

      // Click to flush again (pending), then switch siteId to siteB before flush resolves
      host.querySelector(".ant-image")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      siteIdRef.value = "siteB";
      await flushAsync();
      expect(img()?.getAttribute("src")).toBe("data:image/png;base64,SITE_B");

      // Late resolution for siteA must NOT overwrite siteB
      flushDeferred.resolve("data:image/png;base64,STALE_A");
      await flushAsync();
      expect(img()?.getAttribute("src")).toBe("data:image/png;base64,SITE_B");
    } finally {
      app.unmount();
      host.remove();
    }
  });

  it("TorrentTitleTd clears stale socialInformation and drops late responses when item prop changes (F0130)", async () => {
    vi.resetModules();
    stubChromeBase();

    const firstSocial = createDeferred<any>();
    const secondSocial = createDeferred<any>();
    const sendMessageMock = vi
      .fn()
      .mockImplementationOnce(() => firstSocial.promise)
      .mockImplementationOnce(() => secondSocial.promise);
    vi.doMock("@/messages.ts", () => ({ sendMessage: sendMessageMock, onMessage: vi.fn() }));

    const { default: TorrentTitleTd } = await import("@/options/components/TorrentTitleTd.vue");
    const { i18nInstance } = await import("@/options/plugins/i18n.ts");

    const pinia = createPinia();
    setActivePinia(pinia);
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: "/", name: "SearchEntity", component: { render: () => null } }],
    });

    const itemRef = ref<any>({ title: "Movie One", url: "https://a.test/1", ext_imdb: "tt0000001" });
    const host = document.createElement("div");
    document.body.appendChild(host);
    const app = createApp(
      defineComponent({
        setup: () => () => h(TorrentTitleTd as any, { item: itemRef.value }),
      }),
    )
      .use(pinia)
      .use(i18nInstance)
      .use(Antd as any)
      .use(router);
    app.mount(host);
    await flushAsync();

    try {
      const avatar = host.querySelector<HTMLElement>(".torrent-title__social-avatar");
      expect(avatar).toBeTruthy();
      avatar!.click();
      await flushAsync();
      expect(sendMessageMock).toHaveBeenCalledWith("getSocialInformation", { site: "imdb", sid: "tt0000001" });

      // Switch item to a different torrent while first request is still pending
      itemRef.value = { title: "Movie Two", url: "https://a.test/2", ext_imdb: "tt0000002" };
      await flushAsync();

      // First request resolves late -> must be ignored so clicking again fetches tt0000002
      firstSocial.resolve({ id: "tt0000001", title: "Stale Movie One" });
      await flushAsync();

      const avatar2 = host.querySelector<HTMLElement>(".torrent-title__social-avatar");
      avatar2!.click();
      await flushAsync();
      expect(sendMessageMock).toHaveBeenCalledWith("getSocialInformation", { site: "imdb", sid: "tt0000002" });
      secondSocial.resolve({ id: "tt0000002", title: "Fresh Movie Two" });
      await flushAsync();
    } finally {
      app.unmount();
      host.remove();
    }
  });

  it("style.css gives fixed table cells explicit opaque backgrounds instead of inherit (F0134)", () => {
    const css = readFileSync(resolve(process.cwd(), "src/entries/options/style.css"), "utf8");
    expect(css).not.toMatch(/td\.ant-table-cell-fix-(?:left|right)[^{]*\{[^}]*background-color:\s*inherit/);
    expect(css).toMatch(/td\.ant-table-cell-fix-left[^{]*\{[^}]*background-color:\s*var\(--ptd-surface/);
    expect(css).toMatch(/linear-gradient\(var\(--ptd-stripe/);
  });

  it("en.json SetBase.ui.tableMultiSortNote has unescaped quotes without literal backslashes (F0196)", () => {
    const enLocale = JSON.parse(readFileSync(resolve(process.cwd(), "src/locales/en.json"), "utf8"));
    const note: string = enLocale.SetBase.ui.tableMultiSortNote;
    expect(note).toContain('"1"');
    expect(note).toContain('"2"');
    expect(note).toContain('"3"');
    expect(note).not.toContain('\\"');
  });
});
