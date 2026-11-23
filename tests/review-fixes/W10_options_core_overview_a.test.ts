// @vitest-environment happy-dom
/**
 * Batch W10_options_core_overview_a regression tests.
 * Covers F0131–F0153 (20 findings) + cross-batch F0122 (setLastDownloader deep clone).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { createApp, defineComponent, h, nextTick, reactive, ref, type Component } from "vue";
import { createI18n } from "vue-i18n";
import dayjs from "dayjs";
import { CTorrentState, type CTorrent, type TorrentClientMetaData } from "@ptd/downloader";

const RUNTIME_STORE_KEY = "__ptd_runtime_store";

function createMemoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    key: (i: number) => [...store.keys()][i] ?? null,
    removeItem: (k: string) => {
      store.delete(k);
    },
    setItem: (k: string, v: string) => {
      store.set(k, String(v));
    },
  };
}

async function settle(turns = 6) {
  for (let i = 0; i < turns; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
  await nextTick();
}

const PassthroughStub = defineComponent({
  setup(_, { slots, attrs }) {
    return () =>
      h("div", attrs, [
        slots.content?.(),
        slots.default?.(),
        slots.primary?.(),
        slots.title?.(),
        slots.description?.(),
        slots.footer?.(),
      ]);
  },
});

const EmptyStub = defineComponent({
  setup() {
    return () => null;
  },
});

interface MountHandle {
  el: HTMLElement;
  props: Record<string, any>;
  unmount: () => void;
}

function mountComponent(
  component: Component,
  options: {
    props?: Record<string, any>;
    stubs?: Record<string, Component | true>;
    directives?: Record<string, any>;
    messages?: Record<string, any>;
  } = {},
): MountHandle {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const propsState = reactive<Record<string, any>>({ ...(options.props ?? {}) });

  const Root = defineComponent({
    setup() {
      return () => h(component as any, propsState);
    },
  });

  const app = createApp(Root);
  const i18n = createI18n({
    legacy: false,
    locale: "en",
    missingWarn: false,
    fallbackWarn: false,
    messages: { en: options.messages ?? {} },
  });
  app.use(i18n);

  for (const [name, stub] of Object.entries(options.stubs ?? {})) {
    app.component(name, stub === true ? EmptyStub : stub);
  }
  for (const [name, dir] of Object.entries(options.directives ?? {})) {
    app.directive(name, dir);
  }

  app.mount(host);
  return {
    el: host,
    props: propsState,
    unmount: () => {
      app.unmount();
      host.remove();
    },
  };
}

function makeTorrent(clientId: string, id: string, overrides: Partial<CTorrent> = {}): CTorrent {
  return {
    id,
    clientId,
    name: `Torrent ${id}`,
    infoHash: `hash-${id}`,
    state: CTorrentState.downloading,
    progress: 50,
    totalSize: 1024 * 1024,
    uploadSpeed: 0,
    downloadSpeed: 0,
    totalUploaded: 0,
    totalDownloaded: 0,
    ratio: 1,
    savePath: "/downloads",
    label: "",
    dateAdded: 1700000000,
    ...overrides,
  } as CTorrent;
}

describe("F0131 & F0133: runtime store persistence and fail-closed host storage guard", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("F0131: flushes deferred search results on pagehide even after 500ms debounce drained pendingState", async () => {
    const storage = createMemoryStorage();
    vi.stubGlobal("sessionStorage", storage);
    vi.stubGlobal("chrome", undefined);

    const { useRuntimeStore, setupRuntimeStorePersistence } = await import("@/options/stores/runtime.ts");
    setActivePinia(createPinia());
    const store = useRuntimeStore();
    setupRuntimeStorePersistence(store);

    store.search.isSearching = true;
    store.search.searchKey = "matrix";
    store.search.searchResult.push({ id: "t1", title: "Matrix" } as any);

    await nextTick();
    // 500ms debounce tick runs while search is still in progress: strips search.searchResult and clears pendingState
    vi.advanceTimersByTime(600);
    const duringSearch = JSON.parse(storage.getItem(RUNTIME_STORE_KEY)!);
    expect(duringSearch.search.searchResult).toEqual([]);

    // Now pagehide fires with no new mutations: deferred results MUST still be flushed
    window.dispatchEvent(new Event("pagehide"));
    const afterPagehide = JSON.parse(storage.getItem(RUNTIME_STORE_KEY)!);
    expect(afterPagehide.search.searchResult).toHaveLength(1);
    expect(afterPagehide.search.searchResult[0].id).toBe("t1");
  });

  it("F0131: starting mediaServerSearch does not wipe completed torrent search results on 500ms flush", async () => {
    const storage = createMemoryStorage();
    vi.stubGlobal("sessionStorage", storage);
    vi.stubGlobal("chrome", undefined);

    const { useRuntimeStore, setupRuntimeStorePersistence } = await import("@/options/stores/runtime.ts");
    setActivePinia(createPinia());
    const store = useRuntimeStore();
    setupRuntimeStorePersistence(store);

    // Completed torrent search
    store.search.isSearching = false;
    store.search.searchKey = "dune";
    store.search.searchResult.push({ id: "t-done", title: "Dune" } as any);
    await nextTick();
    vi.advanceTimersByTime(600);

    // Start media server search while torrent search is NOT searching
    store.mediaServerSearch.isSearching = true;
    store.mediaServerSearch.searchResult.push({ url: "http://emby/1", name: "Item 1" } as any);
    await nextTick();
    vi.advanceTimersByTime(600);

    const persisted = JSON.parse(storage.getItem(RUNTIME_STORE_KEY)!);
    expect(persisted.search.searchResult).toHaveLength(1);
    expect(persisted.search.searchResult[0].id).toBe("t-done");
    expect(persisted.mediaServerSearch.searchResult).toEqual([]);
  });

  it("F0133: fails closed to memoryOnly when chrome.runtime.getURL throws", async () => {
    const storage = createMemoryStorage();
    storage.setItem(
      RUNTIME_STORE_KEY,
      JSON.stringify({
        search: { searchKey: "injected", searchResult: [{ id: "evil" }] },
      }),
    );
    vi.stubGlobal("sessionStorage", storage);
    vi.stubGlobal("chrome", {
      runtime: {
        getURL: () => {
          throw new Error("Extension context invalidated");
        },
      },
    });

    const { useRuntimeStore, setupRuntimeStorePersistence } = await import("@/options/stores/runtime.ts");
    setActivePinia(createPinia());
    const store = useRuntimeStore();
    setupRuntimeStorePersistence(store);

    // Must not trust host-page sessionStorage
    expect(store.search.searchKey).toBe("");
    expect(store.search.searchResult).toEqual([]);

    // Must not write to host-page sessionStorage
    const setSpy = vi.spyOn(storage, "setItem");
    store.search.searchKey = "secret-title";
    store.persistNow();
    expect(setSpy).not.toHaveBeenCalled();
  });
});

describe("F0132, F0135, F0136 & F0122: metadata store security, cascade cleanup, falsy merge, and deep clone", () => {
  const getDefinedSiteMetadataMock = vi.fn();
  const sendMessageMock = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    getDefinedSiteMetadataMock.mockReset();
    sendMessageMock.mockReset();
  });

  afterEach(() => {
    vi.doUnmock("@ptd/site");
    vi.doUnmock("@ptd/site/metadataIndex");
    vi.doUnmock("@/messages.ts");
    vi.doUnmock("@/options/plugins/i18n.ts");
    vi.doUnmock("@/options/stores/runtime.ts");
    vi.doUnmock("@/options/stores/config.ts");
    vi.resetModules();
  });

  async function loadMetadataStore(siteMetadataIndexStub: Record<string, any> = {}) {
    vi.doMock("@ptd/site", () => ({
      getHostFromUrl: (u: string) => {
        try {
          return new URL(u).host;
        } catch {
          return u;
        }
      },
      getDefinedSiteMetadata: getDefinedSiteMetadataMock,
      isIndexedMetadataField: (field: string) => ["name", "urls", "isDead"].includes(field),
    }));
    vi.doMock("@ptd/site/metadataIndex", () => ({
      siteMetadataIndex: siteMetadataIndexStub,
    }));
    vi.doMock("@/messages.ts", () => ({ sendMessage: sendMessageMock }));
    vi.doMock("@/options/plugins/i18n.ts", () => ({ i18n: { t: (k: string) => k } }));
    vi.doMock("@/options/stores/runtime.ts", () => ({
      useRuntimeStore: () => ({ showSnackbar: vi.fn(), userInfo: { flushPlan: {} }, search: { isSearching: false } }),
    }));
    vi.doMock("@/options/stores/config.ts", () => ({
      useConfigStore: () => ({
        download: { allowDownloaderFilterForSite: false },
        userDataTimelineControl: { selectedSites: [] },
        userStatisticControl: { selectedSites: [] },
        $save: vi.fn().mockResolvedValue(undefined),
      }),
    }));

    const { useMetadataStore } = await import("@/options/stores/metadata.ts");
    setActivePinia(createPinia());
    const store = useMetadataStore();
    (store as any).$save = vi.fn().mockResolvedValue(undefined);
    return store;
  }

  it("F0132: rejects backslash scheme-relative, C0 control-char, and non-HTTP(S) URLs in search solutions", async () => {
    getDefinedSiteMetadataMock.mockResolvedValue({
      id: "demo",
      urls: ["https://allowed.example/"],
      legacyUrls: [],
      category: [],
    });

    const store = await loadMetadataStore();
    await store.addSearchSolution({
      id: "sol-1",
      name: "Imported",
      sort: 0,
      enabled: true,
      isDefault: false,
      createdAt: 1,
      solutions: [
        {
          id: "entry-1",
          siteId: "demo",
          searchEntries: {
            backslash1: { requestConfig: { url: "/\\evil.com/steal" } },
            backslash2: { requestConfig: { url: "\\\\evil.com/steal" } },
            backslash3: { requestConfig: { url: "\\/evil.com/steal" } },
            c0Relative: { requestConfig: { url: "\u0001//evil.com/steal" } },
            c0Absolute: { requestConfig: { url: "\u0001https://evil.com/steal" } },
            wsAllowed: { requestConfig: { url: "ws://allowed.example/socket" } },
            ftpAllowed: { requestConfig: { baseURL: "ftp://allowed.example/files" } },
            validRelative: { requestConfig: { url: "/torrents.php?q=test" } },
            validAllowedHttps: { requestConfig: { baseURL: "https://allowed.example/api" } },
          },
        },
      ],
    });

    const entries = store.solutions["sol-1"].solutions[0].searchEntries!;
    expect(entries.backslash1.requestConfig?.url).toBeUndefined();
    expect(entries.backslash2.requestConfig?.url).toBeUndefined();
    expect(entries.backslash3.requestConfig?.url).toBeUndefined();
    expect(entries.c0Relative.requestConfig?.url).toBeUndefined();
    expect(entries.c0Absolute.requestConfig?.url).toBeUndefined();
    expect(entries.wsAllowed.requestConfig?.url).toBeUndefined();
    expect(entries.ftpAllowed.requestConfig?.baseURL).toBeUndefined();
    expect(entries.validRelative.requestConfig?.url).toBe("/torrents.php?q=test");
    expect(entries.validAllowedHttps.requestConfig?.baseURL).toBe("https://allowed.example/api");
  });

  it("F0135: removeDownloader cascade-clears lastDownloader, lastKeepUpload, and defaultDownloader", async () => {
    const store = await loadMetadataStore();
    store.downloaders = {
      d1: { id: "d1", name: "D1", type: "qbittorrent", enabled: true } as any,
      d2: { id: "d2", name: "D2", type: "aria2", enabled: true } as any,
    };
    store.lastDownloader = { id: "d1", options: { savePath: "/dl", addAtPaused: false } };
    store.lastKeepUpload = { downloaderId: "d1", folder: "/dl" } as any;
    store.defaultDownloader = { id: "d1", folder: "/dl" };

    await store.removeDownloader("d1");
    expect(store.downloaders.d1).toBeUndefined();
    expect(store.lastDownloader).toEqual({});
    expect(store.lastKeepUpload).toEqual({});
    expect(store.defaultDownloader).toEqual({});

    // Unrelated downloader references remain untouched
    store.lastDownloader = { id: "d2", options: { savePath: "/dl2", addAtPaused: false } };
    store.lastKeepUpload = { downloaderId: "d2", folder: "/dl2" } as any;
    store.defaultDownloader = { id: "d2", folder: "/dl2" };
    await store.removeDownloader("d1");
    expect(store.lastDownloader?.id).toBe("d2");
    expect(store.lastKeepUpload?.downloaderId).toBe("d2");
    expect(store.defaultDownloader.id).toBe("d2");
  });

  it("F0122/H8: setLastDownloader defensively deep-clones incoming object", async () => {
    const store = await loadMetadataStore();
    const callerObj = {
      id: "d1",
      options: { savePath: "/movies", labels: ["4k"] },
    } as any;

    await store.setLastDownloader(callerObj);
    callerObj.id = "mutated";
    callerObj.options.savePath = "/corrupted";
    callerObj.options.labels.push("hacked");

    expect(store.lastDownloader?.id).toBe("d1");
    expect(store.lastDownloader?.options?.savePath).toBe("/movies");
    expect((store.lastDownloader?.options as any)?.labels).toEqual(["4k"]);
  });

  it("F0136: getSiteMergedMetadata honors falsy user overrides such as isDead: false", async () => {
    const store = await loadMetadataStore({
      deadSite: { name: "DeadSite", urls: ["https://dead.example/"], isDead: true },
    });
    store.sites = {
      deadSite: { merge: { isDead: false } } as any,
    };

    const isDead = await store.getSiteMergedMetadata("deadSite", "isDead");
    expect(isDead).toBe(false);
  });
});

describe("F0137: router scrollMainTo cancels stale retry loop on rapid navigation", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    document.body.innerHTML = "";
  });

  it("cancels an earlier scroll retry when a newer navigation starts", async () => {
    vi.resetModules();
    const rafCallbacks: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    });

    const main = document.createElement("div");
    main.id = "ptd-main";
    let scrollableHeight = 100;
    Object.defineProperty(main, "scrollHeight", { get: () => scrollableHeight, configurable: true });
    Object.defineProperty(main, "clientHeight", { get: () => 100, configurable: true });
    main.scrollTop = 300;
    document.body.appendChild(main);

    const { routerInstance, saveMainScrollTop } = await import("@/options/plugins/router.ts");
    saveMainScrollTop("/page-a");

    const scrollBehavior = routerInstance.options.scrollBehavior!;
    // First navigation: popstate back to /page-a (wants top=300), but scrollHeight is too small yet
    const p1 = scrollBehavior(
      { fullPath: "/page-a", name: "MyData" } as any,
      { fullPath: "/page-b", name: "MyClient" } as any,
      { left: 0, top: 0 },
    );
    // Run 1 frame while height is still too small -> retries
    rafCallbacks.shift()?.(0);
    await Promise.resolve();
    expect(rafCallbacks.length).toBe(1);

    // Second navigation starts immediately (normal navigation -> wants top=0)
    const p2 = scrollBehavior(
      { fullPath: "/page-c", name: "SearchEntity" } as any,
      { fullPath: "/page-a", name: "MyData" } as any,
      null,
    );

    // Now content grows tall enough for 300
    scrollableHeight = 1000;
    while (rafCallbacks.length > 0) {
      rafCallbacks.shift()?.(0);
      await Promise.resolve();
    }
    await Promise.all([p1, p2]);

    // Stale p1 (top=300) must have been canceled and must NOT overwrite p2 (top=0)
    expect(main.scrollTop).toBe(0);
  });
});

describe("F0138: formValidateRules.url accepts ws:// and wss:// for Aria2", () => {
  it("validates http, https, ws, and wss URLs while rejecting unsupported schemes", async () => {
    const { formValidateRules } = await import("@/options/utils.ts");
    const validator = formValidateRules.url("Invalid URL");

    expect(validator("http://127.0.0.1:6800/jsonrpc")).toBe(true);
    expect(validator("https://qb.example.com:8443/")).toBe(true);
    expect(validator("ws://127.0.0.1:6800/jsonrpc")).toBe(true);
    expect(validator("wss://aria2.example.com/jsonrpc")).toBe(true);
    expect(validator("ftp://files.example.com/")).toBe("Invalid URL");
    expect(validator("not-a-url")).toBe("Invalid URL");
    expect(validator(null)).toBe("Invalid URL");
  });
});

describe("F0139: AdvanceFilterGenerateDialog range-picker binding and clear handling", () => {
  afterEach(() => {
    vi.doUnmock("@/options/views/Overview/DownloadHistory/utils.ts");
    vi.resetModules();
  });

  it("binds a-range-picker to downloadAtSliderValue and resets downloadAt on clear without throwing", async () => {
    const startTs = new Date("2025-01-01T00:00:00Z").getTime();
    const endTs = new Date("2025-01-31T00:00:00Z").getTime();
    const selectedStart = new Date("2025-01-10T00:00:00Z").getTime();
    const selectedEnd = new Date("2025-01-20T00:00:00Z").getTime();

    const advanceFilterDictRef = ref<any>({
      text: { required: [], exclude: [] },
      siteId: { required: [], exclude: [] },
      downloaderId: { required: [], exclude: [] },
      downloadStatus: { required: [], exclude: [] },
      downloadAt: [selectedStart, selectedEnd],
    });
    const advanceItemPropsRef = ref<any>({
      siteId: [],
      downloaderId: [],
      downloadAt: { range: [startTs, endTs], ticks: [] },
    });

    vi.resetModules();
    vi.doMock("@/options/views/Overview/DownloadHistory/utils.ts", () => ({
      downloadStatusMap: ref({}),
      tableCustomFilter: {
        advanceItemPropsRef,
        advanceFilterDictRef,
        reBuildFilterCountRef: ref(0),
        reBuildAdvanceFilter: vi.fn(),
        updateTableFilterValueFn: vi.fn(),
      },
    }));

    const { default: AdvanceFilterGenerateDialog } =
      await import("@/options/views/Overview/DownloadHistory/AdvanceFilterGenerateDialog.vue");

    let capturedValue: any;
    let capturedOnChange: ((v: any) => void) | undefined;

    const ARangePickerStub = defineComponent({
      props: ["value", "disabledDate"],
      emits: ["change"],
      setup(props, { emit }) {
        capturedOnChange = (v: any) => emit("change", v);
        return () => {
          capturedValue = props.value;
          return h("div", { class: "range-picker-stub" });
        };
      },
    });

    const view = mountComponent(AdvanceFilterGenerateDialog, {
      props: { modelValue: true },
      stubs: {
        "a-modal": PassthroughStub,
        "a-popover": PassthroughStub,
        "a-range-picker": ARangePickerStub,
        "a-row": PassthroughStub,
        "a-col": PassthroughStub,
        "a-flex": PassthroughStub,
        "a-select": true,
        "a-checkbox": true,
        "a-tag": true,
        "a-slider": true,
        "a-button": true,
        "a-typography-text": true,
        SiteName: true,
        SiteFavicon: true,
        DownloaderLabel: true,
      },
    });

    try {
      // Value reflects current downloadAtSliderValue, NOT the full downloadAtRange
      expect(capturedValue[0].valueOf()).toBe(selectedStart);
      expect(capturedValue[1].valueOf()).toBe(selectedEnd);

      // Partial/malformed values do not throw
      expect(() => capturedOnChange!([dayjs(selectedStart), null])).not.toThrow();
      expect(advanceFilterDictRef.value.downloadAt).toEqual([selectedStart, selectedEnd]);

      // Clearing picker resets filter to [-Infinity, Infinity]
      capturedOnChange!(null);
      expect(advanceFilterDictRef.value.downloadAt).toEqual([-Infinity, Infinity]);
    } finally {
      view.unmount();
    }
  });
});

describe("F0140: DownloadHistory/Index.vue cancels trailing throttleLoadDownloadHistory on unmount", () => {
  it("cancels throttled loader before clearWatchingMap on unmount and guards post-unmount emits", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/entries/options/views/Overview/DownloadHistory/Index.vue"),
      "utf8",
    );
    expect(source).toContain("isMounted = false");
    expect(source).toMatch(/throttleLoadDownloadHistory[\s\S]*?\.cancel\?\.\(\)/);
    const cancelIdx = source.indexOf(".cancel?.()");
    const clearIdx = source.indexOf("clearWatchingMap()");
    expect(cancelIdx).toBeGreaterThan(-1);
    expect(clearIdx).toBeGreaterThan(cancelIdx);
  });
});

describe("F0142: ReDownloadSelectDialog accounts for pending download status separately", () => {
  afterEach(() => {
    vi.doUnmock("@/messages.ts");
    vi.doUnmock("@/options/stores/runtime.ts");
    vi.doUnmock("@/options/components/SentToDownloaderDialog/Index.vue");
    vi.resetModules();
  });

  it("counts pending items in pendingText and uses warning color instead of counting them as succeeded", async () => {
    const showSnackbar = vi.fn();
    const sendMessageMock = vi
      .fn()
      .mockResolvedValueOnce({ downloadStatus: "pending" })
      .mockResolvedValueOnce({ downloadStatus: "completed" });

    vi.resetModules();
    vi.doMock("@/messages.ts", () => ({ sendMessage: sendMessageMock }));
    vi.doMock("@/options/stores/runtime.ts", () => ({
      useRuntimeStore: () => ({ showSnackbar }),
    }));
    vi.doMock("@/options/components/SentToDownloaderDialog/Index.vue", () => ({
      default: EmptyStub,
    }));

    const { default: ReDownloadSelectDialog } =
      await import("@/options/views/Overview/DownloadHistory/ReDownloadSelectDialog.vue");

    const ButtonStub = defineComponent({
      emits: ["click"],
      setup(_, { slots, emit }) {
        return () => h("button", { onClick: () => emit("click") }, slots.default?.());
      },
    });

    const view = mountComponent(ReDownloadSelectDialog, {
      props: {
        modelValue: true,
        torrentItems: [
          { id: 1, downloaderId: "d1", torrent: { link: "https://a/1.torrent" } } as any,
          { id: 2, downloaderId: "d1", torrent: { link: "https://a/2.torrent" } } as any,
        ],
      },
      messages: {
        SentToDownloaderDialog: {
          sendSummary: "ok={success}{pending}{failed}",
          sendSummaryPending: ",pending={count}",
          sendSummaryFailed: ",failed={count}",
        },
      },
      stubs: {
        "a-modal": PassthroughStub,
        "a-list": PassthroughStub,
        "a-list-item": PassthroughStub,
        "a-button": ButtonStub,
      },
    });

    try {
      view.el.querySelector("button")!.click();
      await settle();

      expect(showSnackbar).toHaveBeenCalledTimes(1);
      const [text, options] = showSnackbar.mock.calls[0];
      expect(options).toEqual({ color: "warning" });
      expect(text).toBe("ok=1,pending=1");
    } finally {
      view.unmount();
    }
  });
});

describe("F0141 & F0144: MediaServerEntity cursor preservation and deep-link ?search= on mount", () => {
  afterEach(() => {
    vi.doUnmock("@/messages.ts");
    vi.doUnmock("@/options/stores/runtime.ts");
    vi.doUnmock("@/options/stores/config.ts");
    vi.doUnmock("@/options/stores/metadata.ts");
    vi.doUnmock("@/options/views/Overview/MediaServerEntity/utils.ts");
    vi.doUnmock("vue-router");
    vi.resetModules();
  });

  it("F0141: unchecking a media server preserves its searchStatus cursor; disabling it prunes searchStatus", async () => {
    const enabledServers = ref([
      { id: "s1", name: "Emby 1", type: "emby", enabled: true },
      { id: "s2", name: "Emby 2", type: "emby", enabled: true },
    ]);
    const mediaServerSearch = reactive({
      isSearching: false,
      searchKey: "matrix",
      searchStatus: {
        s1: { status: 2, options: { startIndex: 0, limit: 50 }, canLoadMore: true },
        s2: { status: 2, options: { startIndex: 0, limit: 50 }, canLoadMore: true },
      } as Record<string, any>,
      searchResult: [] as any[],
    });

    vi.resetModules();
    vi.doMock("@/messages.ts", () => ({ sendMessage: vi.fn().mockResolvedValue({ status: 2, items: [] }) }));
    vi.doMock("@/options/stores/runtime.ts", () => ({
      useRuntimeStore: () => ({
        mediaServerSearch,
        resetMediaServerSearchData: () => {
          mediaServerSearch.searchStatus = {};
          mediaServerSearch.searchResult = [];
        },
        showSnackbar: vi.fn(),
      }),
    }));
    vi.doMock("@/options/stores/config.ts", () => ({
      useConfigStore: () => ({ mediaServerEntity: { queueConcurrency: 1, searchLimit: 50 } }),
    }));
    vi.doMock("@/options/stores/metadata.ts", () => ({
      useMetadataStore: () => ({
        get getEnabledMediaServers() {
          return enabledServers.value;
        },
        mediaServers: { s1: enabledServers.value[0], s2: enabledServers.value[1] },
      }),
    }));

    const { searchMediaServerIds } = await import("@/options/views/Overview/MediaServerEntity/utils.ts");
    expect(searchMediaServerIds.value).toEqual(["s1", "s2"]);

    // Unchecking s2 must NOT delete s2's pagination cursor
    searchMediaServerIds.value = ["s1"];
    await nextTick();
    expect(mediaServerSearch.searchStatus.s2).toBeDefined();
    expect(mediaServerSearch.searchStatus.s2.options).toEqual({ startIndex: 0, limit: 50 });

    // Disabling/removing s2 in metadataStore MUST prune s2's searchStatus
    enabledServers.value = [enabledServers.value[0]];
    await nextTick();
    expect(mediaServerSearch.searchStatus.s2).toBeUndefined();
    expect(mediaServerSearch.searchStatus.s1).toBeDefined();
  });

  it("F0144: mounting MediaServerEntity with ?search=... triggers doSearch even with cached results", async () => {
    const doSearchMock = vi.fn();
    vi.resetModules();
    vi.doMock("vue-router", () => ({
      useRoute: () => ({ query: { search: "Interstellar" } }),
      useRouter: () => ({ push: vi.fn() }),
    }));
    vi.doMock("@/options/views/Overview/MediaServerEntity/utils.ts", () => ({
      doSearch: doSearchMock,
      resetSearchingStateIfIdle: vi.fn(),
      searchMediaServerIds: ref(["s1"]),
    }));
    vi.doMock("@/options/stores/runtime.ts", () => ({
      useRuntimeStore: () => ({
        mediaServerSearch: reactive({
          isSearching: false,
          searchKey: "old-query",
          searchStatus: {},
          searchResult: [{ url: "http://cached/1", name: "Cached", server: "s1" }],
        }),
      }),
    }));
    vi.doMock("@/options/stores/config.ts", () => ({
      useConfigStore: () => ({
        mediaServerEntity: { autoSearchWhenMount: false, autoSearchMoreWhenScroll: false },
      }),
    }));
    vi.doMock("@/options/stores/metadata.ts", () => ({
      useMetadataStore: () => ({
        $onReady: vi.fn().mockResolvedValue(undefined),
        getEnabledMediaServers: [{ id: "s1", name: "Emby", type: "emby" }],
        mediaServers: { s1: { id: "s1", name: "Emby", type: "emby" } },
      }),
    }));

    const { default: MediaServerEntityIndex } = await import("@/options/views/Overview/MediaServerEntity/Index.vue");

    const view = mountComponent(MediaServerEntityIndex, {
      directives: { scroll: () => {} },
      stubs: {
        "a-input": true,
        "a-button": true,
        "a-typography-text": true,
        "a-spin": true,
        "a-alert": true,
        "a-popover": true,
        "a-avatar": true,
        "a-tooltip": true,
        "a-flex": true,
      },
    });

    try {
      await settle();
      expect(doSearchMock).toHaveBeenCalledWith({ searchKey: "Interstellar", userInitiated: true });
    } finally {
      view.unmount();
    }
  });
});

describe("F0143: ClientStatusDialog decouples version/status fetches and guards concurrent refreshes", () => {
  afterEach(() => {
    vi.doUnmock("@/messages.ts");
    vi.doUnmock("@/options/views/Overview/MyClient/utils.ts");
    vi.resetModules();
  });

  it("still fetches status when version fails, retries version next time, and ignores stale responses", async () => {
    let versionCall = 0;
    let resolveSlowStatus!: (v: any) => void;
    let statusCall = 0;

    const sendMessageMock = vi.fn((action: string) => {
      if (action === "getDownloaderVersion") {
        versionCall++;
        if (versionCall === 1) return Promise.reject(new Error("version failed"));
        return Promise.resolve("v4.6.0");
      }
      if (action === "getDownloaderStatus") {
        statusCall++;
        if (statusCall === 1) {
          return new Promise((r) => {
            resolveSlowStatus = r;
          });
        }
        return Promise.resolve({ upSpeed: 2048, upData: 4096, dlSpeed: 1024, dlData: 2048 });
      }
      return Promise.resolve(undefined);
    });

    vi.resetModules();
    vi.doMock("@/messages.ts", () => ({ sendMessage: sendMessageMock }));
    vi.doMock("@/options/views/Overview/MyClient/utils.ts", () => ({
      torrents: ref({ d1: [] }),
      selectedDownloaderIds: ref([]),
      suspendedDownloaders: ref(new Set()),
      autoRefreshRunning: ref(false),
      useClientRefresh: () => ({
        enabledDownloaders: ref([{ id: "d1", name: "QB", type: "qbittorrent", address: "http://localhost:8080" }]),
        resumeDownloaderRefresh: vi.fn(),
        clearDownloaderTimer: vi.fn(),
      }),
    }));

    const { default: ClientStatusDialog } = await import("@/options/views/Overview/MyClient/ClientStatusDialog.vue");

    const ButtonStub = defineComponent({
      props: ["title"],
      emits: ["click"],
      setup(props, { slots, emit }) {
        return () => h("button", { title: props.title, onClick: () => emit("click") }, slots.default?.());
      },
    });

    const view = mountComponent(ClientStatusDialog, {
      props: { modelValue: false },
      stubs: {
        "a-modal": PassthroughStub,
        "a-list": PassthroughStub,
        "a-list-item": PassthroughStub,
        "a-list-item-meta": PassthroughStub,
        "a-flex": PassthroughStub,
        "a-button": ButtonStub,
        "a-avatar": true,
        "a-tooltip": true,
        "a-typography-link": true,
        "a-spin": defineComponent({ setup: () => () => h("span", { class: "loading-spin" }) }),
        "a-divider": true,
      },
    });

    try {
      // Open dialog -> starts fetch #1 (version rejects, status pending)
      view.props.modelValue = true;
      await settle();
      expect(view.el.querySelector(".loading-spin")).not.toBeNull();

      // Click refresh button -> starts fetch #2 (version succeeds with v4.6.0, status returns 2048 upSpeed)
      const refreshBtn = view.el.querySelector<HTMLButtonElement>('button[title="MyClient.refresh"]')!;
      refreshBtn.click();
      await settle();

      // Fetch #2 completed -> version is v4.6.0 and loading cleared
      expect(view.el.textContent).toContain("v4.6.0");
      expect(view.el.textContent).toContain("2.00 KiB/s");

      // Now fetch #1's stale status resolves with different numbers -> MUST be discarded
      resolveSlowStatus({ upSpeed: 999999, upData: 999999, dlSpeed: 999999, dlData: 999999 });
      await settle();
      expect(view.el.textContent).toContain("2.00 KiB/s");
      expect(view.el.textContent).not.toContain("976.56 KiB/s");
    } finally {
      view.unmount();
    }
  });
});

describe("F0146 & F0150: TorrentDetailDialog resets synchronously on rapid reopen and gates tracker toolbar", () => {
  afterEach(() => {
    vi.doUnmock("@/messages.ts");
    vi.doUnmock("@/options/stores/runtime.ts");
    vi.resetModules();
  });

  it("F0146: rapid close-reopen without afterClose resets activeTab and clears stale files/trackers", async () => {
    const filesA = [{ index: 0, path: "torrent-A.mkv", size: 1000, progress: 1, priority: "normal", wanted: true }];
    const trackersA = [{ url: "http://tracker-a/announce", tier: 0, status: "working" }];
    const trackersB = [{ url: "http://tracker-b/announce", tier: 0, status: "working" }];

    const sendMessageMock = vi.fn(async (action: string, payload: any) => {
      if (action === "getDownloaderMetaData") {
        return {
          feature: {
            FileList: { allowed: true },
            FilePriority: { allowed: true },
            PeerList: { allowed: true },
            TrackerList: { allowed: true },
            TrackerManage: { allowed: true },
          },
        } as TorrentClientMetaData;
      }
      if (action === "getClientTorrentFiles") {
        return payload.torrent.id === "A" ? filesA : [];
      }
      if (action === "getClientTorrentTrackersDetail") {
        return payload.torrent.id === "A" ? trackersA : trackersB;
      }
      return [];
    });

    vi.resetModules();
    vi.doMock("@/messages.ts", () => ({ sendMessage: sendMessageMock }));
    vi.doMock("@/options/stores/runtime.ts", () => ({
      useRuntimeStore: () => ({ showSnackbar: vi.fn() }),
    }));

    const { default: TorrentDetailDialog } = await import("@/options/views/Overview/MyClient/TorrentDetailDialog.vue");

    const tabsState = { activeKey: "info", onChange: null as ((k: string) => void) | null };

    const ModalStub = defineComponent({
      props: ["open", "afterClose"],
      setup(props, { slots }) {
        // Deliberately NEVER calls props.afterClose to simulate rapid close-reopen during leave animation
        return () => (props.open ? h("div", { class: "modal-open" }, slots.default?.()) : null);
      },
    });
    const TabsStub = defineComponent({
      props: ["activeKey"],
      emits: ["update:activeKey", "change"],
      setup(props, { slots, emit }) {
        tabsState.onChange = (k: string) => {
          emit("update:activeKey", k);
          emit("change", k);
        };
        return () => {
          tabsState.activeKey = props.activeKey;
          return h("div", { "data-active-tab": props.activeKey }, slots.default?.());
        };
      },
    });

    const torrentA = makeTorrent("c1", "A");
    const torrentB = makeTorrent("c1", "B");

    const view = mountComponent(TorrentDetailDialog, {
      props: { modelValue: false, torrent: torrentA },
      stubs: {
        "a-modal": ModalStub,
        "a-tabs": TabsStub,
        "a-tab-pane": PassthroughStub,
        "a-list": PassthroughStub,
        "a-list-item": PassthroughStub,
        "a-list-item-meta": PassthroughStub,
        "a-row": PassthroughStub,
        "a-col": PassthroughStub,
        "a-flex": PassthroughStub,
        "a-form-item": PassthroughStub,
        "a-table": defineComponent({
          props: ["dataSource"],
          setup(props) {
            return () => h("div", { class: "table-rows" }, JSON.stringify(props.dataSource));
          },
        }),
        "a-divider": true,
        "a-button": true,
        "a-input": true,
        "a-spin": true,
        "a-select": true,
      },
    });

    try {
      // Open torrent A and switch to files tab
      view.props.modelValue = true;
      await settle();
      tabsState.onChange!("files");
      await settle();
      expect(tabsState.activeKey).toBe("files");
      expect(view.el.textContent).toContain("torrent-A.mkv");

      // Rapid close (no afterClose) and immediately reopen with torrent B
      view.props.modelValue = false;
      await nextTick();
      view.props.torrent = torrentB;
      view.props.modelValue = true;
      await settle();

      // Must have synchronously reset back to info tab and cleared torrent A's files & trackers
      expect(tabsState.activeKey).toBe("info");
      expect(view.el.textContent).not.toContain("torrent-A.mkv");
      expect(view.el.textContent).not.toContain("tracker-a");
      expect(view.el.textContent).toContain("tracker-b");
    } finally {
      view.unmount();
    }
  });

  it("F0150: hides add-tracker toolbar when TrackerList is allowed but TrackerManage is disallowed", async () => {
    const sendMessageMock = vi.fn(async (action: string) => {
      if (action === "getDownloaderMetaData") {
        return {
          feature: {
            TrackerList: { allowed: true },
            TrackerManage: { allowed: false },
          },
        } as TorrentClientMetaData;
      }
      if (action === "getClientTorrentTrackersDetail") {
        return [{ url: "http://tracker/announce", tier: 0, status: "working" }];
      }
      return [];
    });

    vi.resetModules();
    vi.doMock("@/messages.ts", () => ({ sendMessage: sendMessageMock }));
    vi.doMock("@/options/stores/runtime.ts", () => ({
      useRuntimeStore: () => ({ showSnackbar: vi.fn() }),
    }));

    const { default: TorrentDetailDialog } = await import("@/options/views/Overview/MyClient/TorrentDetailDialog.vue");

    const view = mountComponent(TorrentDetailDialog, {
      props: { modelValue: false, torrent: makeTorrent("c1", "T1") },
      stubs: {
        "a-modal": PassthroughStub,
        "a-tabs": PassthroughStub,
        "a-tab-pane": PassthroughStub,
        "a-list": PassthroughStub,
        "a-list-item": PassthroughStub,
        "a-list-item-meta": PassthroughStub,
        "a-row": PassthroughStub,
        "a-col": PassthroughStub,
        "a-flex": PassthroughStub,
        "a-form-item": PassthroughStub,
        "a-table": true,
        "a-divider": true,
        "a-button": true,
        "a-input": true,
        "a-spin": true,
        "a-select": true,
      },
    });

    try {
      view.props.modelValue = true;
      await settle();
      expect(view.el.querySelector(".torrent-detail__tracker-toolbar")).toBeNull();
    } finally {
      view.unmount();
    }
  });
});

describe("F0148, F0149 & F0152: MyClient/Index.vue capability meta watcher, live selection, and dateAdded guard", () => {
  afterEach(() => {
    vi.doUnmock("@ptd/downloader");
    vi.doUnmock("@/messages.ts");
    vi.doUnmock("@/options/stores/metadata.ts");
    vi.doUnmock("@/options/stores/runtime.ts");
    vi.doUnmock("@/options/stores/config.ts");
    vi.doUnmock("vue-router");
    vi.doUnmock("@/options/components/ToolbarActions.vue");
    vi.doUnmock("@/options/views/Overview/MyClient/DeleteDialog.vue");
    vi.doUnmock("@/options/views/Overview/MyClient/PushToDownloaderDialog.vue");
    vi.doUnmock("@/options/views/Overview/MyClient/ClientStatusDialog.vue");
    vi.doUnmock("@/options/views/Overview/MyClient/TorrentDetailDialog.vue");
    vi.doUnmock("@/options/views/Overview/MyClient/SpeedLimitDialog.vue");
    vi.doUnmock("@/options/views/Overview/MyClient/LabelDialog.vue");
    vi.doUnmock("@/options/views/Overview/MyClient/RecheckConfirmDialog.vue");
    vi.resetModules();
  });

  it("loads capability metadata without loadTorrents, resolves fresh selectedTorrents, and renders '-' for dateAdded=0", async () => {
    const getDownloaderMetaDataMock = vi.fn().mockResolvedValue({
      feature: {
        Recheck: { allowed: false },
        Queue: { allowed: false },
        SpeedLimit: { allowed: false },
        Label: { allowed: false },
      },
    });

    let capturedDeleteTorrents: CTorrent[] = [];
    const DeleteDialogStub = defineComponent({
      props: ["torrents"],
      setup(props) {
        return () => {
          capturedDeleteTorrents = (props.torrents as CTorrent[]) ?? [];
          return null;
        };
      },
    });

    vi.resetModules();
    vi.doMock("@ptd/downloader", async () => {
      const actual = await vi.importActual<typeof import("@ptd/downloader")>("@ptd/downloader");
      return {
        ...actual,
        getDownloaderMetaData: getDownloaderMetaDataMock,
        getDownloaderIcon: () => "",
      };
    });
    vi.doMock("@/messages.ts", () => ({ sendMessage: vi.fn().mockResolvedValue([]) }));
    vi.doMock("vue-router", () => ({
      useRoute: () => ({ query: {} }),
      useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
    }));
    vi.doMock("@/options/stores/metadata.ts", () => ({
      useMetadataStore: () => ({
        $onReady: vi.fn().mockResolvedValue(undefined),
        downloaders: {
          aria1: { id: "aria1", name: "Aria2", type: "Aria2", enabled: true },
        },
        getEnabledDownloaders: [{ id: "aria1", name: "Aria2", type: "Aria2", enabled: true }],
      }),
    }));
    vi.doMock("@/options/stores/runtime.ts", () => ({
      useRuntimeStore: () => ({ showSnackbar: vi.fn() }),
    }));
    vi.doMock("@/options/stores/config.ts", () => ({
      useConfigStore: () => ({
        $onReady: vi.fn().mockResolvedValue(undefined),
        download: { initDownloaderTorrentOnEnter: false },
        tableBehavior: { MyClient: { itemsPerPage: 25, sortBy: [] } },
        enableTableMultiSort: false,
        updateTableBehavior: vi.fn(),
      }),
    }));
    vi.doMock("@/options/components/ToolbarActions.vue", () => ({ default: PassthroughStub }));
    vi.doMock("@/options/views/Overview/MyClient/DeleteDialog.vue", () => ({ default: DeleteDialogStub }));
    vi.doMock("@/options/views/Overview/MyClient/PushToDownloaderDialog.vue", () => ({ default: EmptyStub }));
    vi.doMock("@/options/views/Overview/MyClient/ClientStatusDialog.vue", () => ({ default: EmptyStub }));
    vi.doMock("@/options/views/Overview/MyClient/TorrentDetailDialog.vue", () => ({ default: EmptyStub }));
    vi.doMock("@/options/views/Overview/MyClient/SpeedLimitDialog.vue", () => ({ default: EmptyStub }));
    vi.doMock("@/options/views/Overview/MyClient/LabelDialog.vue", () => ({ default: EmptyStub }));
    vi.doMock("@/options/views/Overview/MyClient/RecheckConfirmDialog.vue", () => ({ default: EmptyStub }));

    const clientUtils = await import("@/options/views/Overview/MyClient/utils.ts");
    clientUtils.torrents.value = {
      aria1: [makeTorrent("aria1", "t1", { label: "old-label", dateAdded: 0 })],
    };
    clientUtils.autoRefreshRunning.value = false;
    clientUtils.autoRefreshUserStopped.value = true;

    const { default: MyClientIndex } = await import("@/options/views/Overview/MyClient/Index.vue");

    let capturedRowSelection: any;

    const ATableStub = defineComponent({
      props: ["dataSource", "rowSelection"],
      setup(props, { slots }) {
        return () => {
          capturedRowSelection = props.rowSelection;
          const record = (props.dataSource as any[])?.[0];
          const dateVNode = record ? slots.bodyCell?.({ column: { key: "dateAdded" }, record }) : null;
          return h("div", { class: "table-stub" }, [dateVNode]);
        };
      },
    });
    const AButtonStub = defineComponent({
      props: ["title"],
      emits: ["click"],
      setup(props, { slots, emit }) {
        return () => h("button", { title: props.title, onClick: () => emit("click") }, slots.default?.());
      },
    });

    const view = mountComponent(MyClientIndex, {
      stubs: {
        "a-card": PassthroughStub,
        "a-table": ATableStub,
        "a-button": AButtonStub,
        "a-button-group": PassthroughStub,
        "a-popover": PassthroughStub,
        "a-input": true,
        "a-input-number": true,
        "a-form-item": true,
        "a-typography-text": true,
        "a-tag": true,
        "a-avatar": true,
        "a-progress": true,
        "a-dropdown": true,
        "a-menu": true,
        "a-menu-item": true,
      },
    });

    try {
      await settle();

      // F0148: metadata was loaded even though initDownloaderTorrentOnEnter=false skipped loadTorrents()
      expect(getDownloaderMetaDataMock).toHaveBeenCalledWith("Aria2");

      // F0152: dateAdded === 0 renders "-" instead of 1970-01-01
      expect(view.el.querySelector(".my-client-date")?.textContent).toBe("-");

      // F0149: select row by key, then simulate refresh replacing CTorrent snapshot
      const oldTorrent = clientUtils.torrents.value.aria1[0];
      capturedRowSelection.onChange(["aria1:t1"], [oldTorrent]);
      await nextTick();
      expect(capturedRowSelection.selectedRowKeys).toEqual(["aria1:t1"]);

      // Auto-refresh replaces torrent with updated label
      clientUtils.torrents.value = {
        aria1: [makeTorrent("aria1", "t1", { label: "new-label", dateAdded: 0 })],
      };
      await nextTick();

      // Click batch delete button -> DeleteDialog receives FRESH CTorrent snapshot with label "new-label"
      view.el.querySelector<HTMLButtonElement>('button[title="MyClient.deleteSelected"]')!.click();
      await nextTick();
      expect(capturedDeleteTorrents).toHaveLength(1);
      expect(capturedDeleteTorrents[0].label).toBe("new-label");

      // When torrent disappears on refresh, selection drops it automatically
      clientUtils.torrents.value = { aria1: [] };
      await nextTick();
      expect(capturedRowSelection.selectedRowKeys).toEqual([]);
    } finally {
      view.unmount();
    }
  });
});

describe("F0151: PushToDownloaderDialog handles file removal from a-upload", () => {
  afterEach(() => {
    vi.doUnmock("@/options/stores/metadata.ts");
    vi.doUnmock("@/options/components/SentToDownloaderDialog/Index.vue");
    vi.resetModules();
  });

  it("removes only the targeted File when a-upload emits remove", async () => {
    vi.resetModules();
    vi.doMock("@/options/stores/metadata.ts", () => ({
      useMetadataStore: () => ({ siteHostMap: {} }),
    }));
    vi.doMock("@/options/components/SentToDownloaderDialog/Index.vue", () => ({
      default: EmptyStub,
    }));

    const { default: PushToDownloaderDialog } =
      await import("@/options/views/Overview/MyClient/PushToDownloaderDialog.vue");

    let uploadProps: any;
    let emitRemove!: (file: any) => void;
    let switchMode!: (mode: string) => void;

    const AUploadStub = defineComponent({
      props: ["fileList", "beforeUpload"],
      emits: ["remove"],
      setup(props, { emit }) {
        emitRemove = (file: any) => emit("remove", file);
        return () => {
          uploadProps = props;
          return h("div", { class: "upload-stub" }, String(props.fileList?.length ?? 0));
        };
      },
    });
    const ARadioGroupStub = defineComponent({
      props: ["value"],
      emits: ["update:value"],
      setup(_, { emit, slots }) {
        switchMode = (m: string) => emit("update:value", m);
        return () => h("div", slots.default?.());
      },
    });

    const view = mountComponent(PushToDownloaderDialog, {
      props: { modelValue: true },
      stubs: {
        "a-modal": PassthroughStub,
        "a-radio-group": ARadioGroupStub,
        "a-radio-button": PassthroughStub,
        "a-form-item": PassthroughStub,
        "a-textarea": true,
        "a-upload": AUploadStub,
        "a-button": true,
      },
    });

    try {
      switchMode("file");
      await nextTick();

      const fileA = new File(["aaa"], "a.torrent");
      const fileB = new File(["bbb"], "b.torrent");
      uploadProps.beforeUpload(fileA);
      uploadProps.beforeUpload(fileB);
      await nextTick();

      expect(uploadProps.fileList).toHaveLength(2);
      const firstEntry = uploadProps.fileList[0];

      emitRemove(firstEntry);
      await nextTick();

      expect(uploadProps.fileList).toHaveLength(1);
      expect(uploadProps.fileList[0].name).toBe("b.torrent");
    } finally {
      view.unmount();
    }
  });
});

describe("F0153: TorrentStateTd binds semantic color to a-tag", () => {
  it("passes stateDisplay color to a-tag for each torrent state", async () => {
    const { default: TorrentStateTd } = await import("@/options/views/Overview/MyClient/TorrentStateTd.vue");

    const ATagStub = defineComponent({
      props: ["color"],
      setup(props, { slots }) {
        return () => h("span", { class: "tag-stub", "data-color": props.color }, slots.default?.());
      },
    });

    const cases: Array<[CTorrentState, string]> = [
      [CTorrentState.downloading, "blue"],
      [CTorrentState.seeding, "green"],
      [CTorrentState.paused, "default"],
      [CTorrentState.queued, "orange"],
      [CTorrentState.checking, "cyan"],
      [CTorrentState.error, "red"],
      [CTorrentState.unknown, "default"],
    ];

    for (const [state, expectedColor] of cases) {
      const view = mountComponent(TorrentStateTd, {
        props: { item: makeTorrent("c1", "1", { state }) },
        stubs: { "a-tag": ATagStub },
      });
      try {
        expect(view.el.querySelector(".tag-stub")?.getAttribute("data-color")).toBe(expectedColor);
      } finally {
        view.unmount();
      }
    }
  });
});
