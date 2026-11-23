import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

async function flushAsync(turns = 15) {
  for (let i = 0; i < turns; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

describe("F0001: EJobType extracted to side-effect-free shared/types/jobs.ts", () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it("imports EJobType from shared/types/jobs.ts without touching chrome APIs", async () => {
    vi.resetModules();
    vi.stubGlobal("chrome", undefined);

    const { EJobType } = await import("@/shared/types/jobs.ts");
    expect(EJobType.FlushUserInfo).toBe("flushUserInfo");
    expect(EJobType.ReDownloadTorrent).toBe("reDownloadTorrent");
    expect(EJobType.AutoBackup).toBe("autoBackup");
  });

  it("UserInfoWindow.vue imports EJobType from shared/types/jobs.ts rather than background/utils/alarms.ts", () => {
    const vueSource = readFileSync(
      resolve(process.cwd(), "src/entries/options/views/Settings/SetBase/UserInfoWindow.vue"),
      "utf8",
    );
    expect(vueSource).toContain('@/shared/types/jobs.ts"');
    expect(vueSource).not.toContain("@/background/utils/alarms");
  });
});

describe("F0005: setupOffscreenDocument coalesces concurrent getContexts + createDocument", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock("@/messages.ts");
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it("invokes getContexts and createDocument only once under concurrent callers", async () => {
    vi.doMock("@/messages.ts", () => ({ onMessage: vi.fn() }));
    vi.stubGlobal("__BROWSER__", "chrome");

    let resolveGetContexts!: (v: unknown[]) => void;
    let resolveCreateDocument!: () => void;
    const getContexts = vi
      .fn()
      // Module-level warmup call sees an existing document so we can control the concurrent test cleanly
      .mockResolvedValueOnce([{}])
      .mockImplementationOnce(
        () =>
          new Promise<unknown[]>((r) => {
            resolveGetContexts = r;
          }),
      );
    const createDocument = vi.fn(
      () =>
        new Promise<void>((r) => {
          resolveCreateDocument = r;
        }),
    );

    vi.stubGlobal("chrome", {
      runtime: {
        ContextType: { OFFSCREEN_DOCUMENT: "OFFSCREEN_DOCUMENT" },
        getURL: (path: string) => `chrome-extension://test/${path}`,
        getContexts,
      },
      offscreen: {
        Reason: { DOM_PARSER: "DOM_PARSER", BLOBS: "BLOBS" },
        createDocument,
      },
    });

    const { setupOffscreenDocument } = await import("@/background/utils/offscreen.ts");
    await flushAsync(4);
    expect(getContexts).toHaveBeenCalledTimes(1);

    const callA = setupOffscreenDocument();
    const callB = setupOffscreenDocument();
    // Both callers share the single in-flight getContexts() check
    expect(getContexts).toHaveBeenCalledTimes(2);

    resolveGetContexts([]);
    await flushAsync(2);
    expect(createDocument).toHaveBeenCalledTimes(1);

    // A third caller arriving while createDocument() is in flight also shares the same promise
    const callC = setupOffscreenDocument();
    expect(getContexts).toHaveBeenCalledTimes(2);

    resolveCreateDocument();
    await Promise.all([callA, callB, callC]);
    expect(createDocument).toHaveBeenCalledTimes(1);
  });
});

describe("F0008: omnibox onInputEntered preserves keyword when prefix does not match any plan", () => {
  afterEach(() => {
    vi.doUnmock("@/messages.ts");
    vi.doUnmock("@/background/utils/base.ts");
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it("keeps full query containing ' → ' when prefix does not match a plan name", async () => {
    vi.resetModules();
    const openOptionsPage = vi.fn();
    const onInputEnteredListeners: Array<(text: string) => void> = [];

    vi.doMock("@/messages.ts", () => ({ onMessage: vi.fn(), sendMessage: vi.fn() }));
    vi.doMock("@/background/utils/base.ts", () => ({
      getExtStoragePathCached: vi.fn(async (key: string, path: unknown) => {
        if (key === "metadata" && Array.isArray(path) && path[0] === "solutions") {
          return { movie: { id: "movie", name: "电影方案", enabled: true, sort: 1 } };
        }
        if (key === "metadata" && Array.isArray(path) && path[0] === "defaultSolutionId") {
          return "default";
        }
        return undefined;
      }),
      openOptionsPage,
    }));

    vi.stubGlobal("__BROWSER__", "chrome");
    vi.stubGlobal("chrome", {
      omnibox: {
        onInputChanged: { addListener: vi.fn() },
        onInputEntered: {
          addListener: vi.fn((fn: (text: string) => void) => onInputEnteredListeners.push(fn)),
        },
      },
      i18n: { getMessage: vi.fn((key: string) => key) },
    });

    await import("@/background/utils/omnibox.ts");
    expect(onInputEnteredListeners).toHaveLength(1);

    // Unmatched prefix: must NOT strip "Title A → "
    onInputEnteredListeners[0]!("Title A → Title B");
    await flushAsync(4);
    expect(openOptionsPage).toHaveBeenLastCalledWith({
      path: "/search-entity",
      query: { search: "Title A → Title B", plan: "default", flush: 1 },
    });

    // Matched prefix: selects plan and strips only the plan prefix
    onInputEnteredListeners[0]!("电影方案 → Title A → Title B");
    await flushAsync(4);
    expect(openOptionsPage).toHaveBeenLastCalledWith({
      path: "/search-entity",
      query: { search: "Title A → Title B", plan: "movie", flush: 1 },
    });
  });
});

describe("F0003 & F0007: alarms replay eligibility and auto-backup dedupe persistence", () => {
  afterEach(() => {
    vi.doUnmock("@webext-core/job-scheduler");
    vi.doUnmock("@/messages.ts");
    vi.doUnmock("@/background/utils/base.ts");
    vi.doUnmock("@/background/utils/offscreen.ts");
    vi.doUnmock("@/background/utils/contextMenus.ts");
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  function setupAlarmsHarness() {
    const localStore = new Map<string, unknown>();
    const sessionStore = new Map<string, unknown>();
    const alarms = new Map<string, { name: string; when?: number }>();
    const alarmListeners: Array<(alarm: { name: string }) => unknown> = [];
    const jobs = new Map<string, { execute: () => Promise<void> }>();
    const sendMessage = vi.fn();
    const getExtStoragePathCached = vi.fn();
    const logBackgroundError = vi.fn();
    const showNotificationSafely = vi.fn();
    const searchDownload = vi.fn(async () => [] as unknown[]);

    vi.doMock("@webext-core/job-scheduler", () => ({
      defineJobScheduler: () => ({
        scheduleJob: (job: { id: string; execute: () => Promise<void> }) => {
          jobs.set(job.id, job);
        },
      }),
    }));
    vi.doMock("@/messages.ts", () => ({ onMessage: vi.fn(), sendMessage }));
    vi.doMock("@/background/utils/base.ts", () => ({
      getExtStoragePathCached,
      patchExtStoragePathLocal: vi.fn(),
      logBackgroundError,
    }));
    vi.doMock("@/background/utils/offscreen.ts", () => ({
      setupOffscreenDocument: vi.fn(async () => undefined),
    }));
    vi.doMock("@/background/utils/contextMenus.ts", () => ({
      showNotificationSafely,
    }));

    vi.stubGlobal("__BROWSER__", "chrome");
    vi.stubGlobal("chrome", {
      storage: {
        local: {
          get: async (key: string) => (localStore.has(key) ? { [key]: structuredClone(localStore.get(key)) } : {}),
          set: async (items: Record<string, unknown>) => {
            for (const [k, v] of Object.entries(items)) localStore.set(k, structuredClone(v));
          },
        },
        session: {
          get: async (key: string) => (sessionStore.has(key) ? { [key]: structuredClone(sessionStore.get(key)) } : {}),
          set: async (items: Record<string, unknown>) => {
            for (const [k, v] of Object.entries(items)) sessionStore.set(k, structuredClone(v));
          },
          remove: async (key: string) => {
            sessionStore.delete(key);
          },
        },
      },
      alarms: {
        get: async (name: string) => alarms.get(name),
        create: async (name: string, info: { when?: number }) => {
          alarms.set(name, { name, when: info.when });
        },
        clear: async (name: string) => alarms.delete(name),
        onAlarm: {
          addListener: (fn: (alarm: { name: string }) => unknown) => alarmListeners.push(fn),
        },
      },
      downloads: { search: searchDownload },
      i18n: { getMessage: vi.fn(() => "") },
      runtime: { id: "test", getURL: (p: string) => `chrome-extension://test/${p}` },
    });

    const boot = async () => {
      vi.resetModules();
      alarmListeners.length = 0;
      jobs.clear();
      return await import("@/background/utils/alarms.ts");
    };

    const fireAlarm = async (name: string) => {
      for (const listener of [...alarmListeners]) {
        await listener({ name });
      }
      await flushAsync(6);
    };

    return {
      localStore,
      sessionStore,
      alarms,
      jobs,
      sendMessage,
      getExtStoragePathCached,
      logBackgroundError,
      showNotificationSafely,
      searchDownload,
      boot,
      fireAlarm,
    };
  }

  it("F0007: clearing one server after SW recycle preserves other failing servers' dedupe timestamps", async () => {
    const h = setupAlarmsHarness();
    h.getExtStoragePathCached.mockImplementation(async (key: string, path: string) => {
      if (key === "metadata" && path === "backupServers") {
        return {
          serverA: { enabled: true, backupInterval: 1, lastBackupAt: 0, name: "Server A" },
          serverB: { enabled: true, backupInterval: 1, lastBackupAt: 0, name: "Server B" },
        };
      }
      return undefined;
    });

    h.sendMessage.mockImplementation(async (type: string, data: any) => {
      if (type === "getDownloadHistory") return [];
      if (type === "exportBackupData") {
        if (data.backupServerId === "serverA") throw new Error("A down");
        return true;
      }
      return undefined;
    });

    await h.boot();
    // Run 1: only serverA pending -> fails and writes { serverA: ts } into session
    h.getExtStoragePathCached.mockImplementationOnce(async () => ({
      serverA: { enabled: true, backupInterval: 1, lastBackupAt: 0, name: "Server A" },
    }));
    await h.jobs.get("autoBackup")!.execute();
    expect(h.showNotificationSafely).toHaveBeenCalledTimes(1);
    const savedBeforeRestart = h.sessionStore.get("autoBackupFailureNotifyAt") as Record<string, number>;
    expect(savedBeforeRestart.serverA).toBeTypeOf("number");

    // Simulate SW recycle: module-level Map is empty, session storage still holds serverA
    await h.boot();

    // Run 2: serverB succeeds BEFORE serverA runs in this SW lifetime
    h.getExtStoragePathCached.mockImplementationOnce(async () => ({
      serverB: { enabled: true, backupInterval: 1, lastBackupAt: 0, name: "Server B" },
      serverA: { enabled: true, backupInterval: 1, lastBackupAt: 0, name: "Server A" },
    }));
    await h.jobs.get("autoBackup")!.execute();

    // Server A's dedupe timestamp must NOT have been wiped by Server B's success
    expect(h.showNotificationSafely).toHaveBeenCalledTimes(1);
    const savedAfterRestart = h.sessionStore.get("autoBackupFailureNotifyAt") as Record<string, number>;
    expect(savedAfterRestart.serverA).toBe(savedBeforeRestart.serverA);
  });

  it("F0003: replays initial pending record, skips deleted/started/live/terminal records", async () => {
    const h = setupAlarmsHarness();
    const expiredAt = Date.now() - 6 * 60_000;
    const downloadOption = {
      downloadId: 42,
      torrent: { site: "mteam", id: 1, title: "T", link: "https://example.com/1.torrent" },
      downloaderId: "local",
    };

    const seedExpired = (name: string, attempt = 1) => {
      h.localStore.set("ptd_pending_once_jobs", {
        [name]: {
          kind: "running",
          job: { kind: "reDownloadTorrent", downloadId: 42, downloadOption, fireAt: expiredAt },
          owner: "dead-sw",
          at: expiredAt,
          fireAt: expiredAt,
          attempt,
        },
      });
    };

    // Case 1: initial pending row (no downloadRequestConfig, no live browser download) -> MUST replay
    seedExpired("reDownloadTorrent-42~case1");
    h.sessionStore.set("ptd_downloadRecoveryCheckedAt", Date.now());
    h.sendMessage.mockImplementation(async (type: string) =>
      type === "getDownloadHistory" ? [{ id: 42, downloadStatus: "pending" }] : undefined,
    );
    await h.boot();
    await h.fireAlarm("reDownloadTorrent-42~case1");
    expect(h.sendMessage.mock.calls.filter(([t]) => t === "downloadTorrent")).toHaveLength(1);

    // Case 2: pending row WITH downloadRequestConfig (dispatch already started) -> MUST skip
    h.sendMessage.mockClear();
    seedExpired("reDownloadTorrent-42~case2");
    h.sendMessage.mockImplementation(async (type: string) =>
      type === "getDownloadHistory"
        ? [{ id: 42, downloadStatus: "pending", downloadRequestConfig: { url: "https://example.com/dl" } }]
        : undefined,
    );
    await h.boot();
    await h.fireAlarm("reDownloadTorrent-42~case2");
    expect(h.sendMessage.mock.calls.filter(([t]) => t === "downloadTorrent")).toHaveLength(0);

    // Case 3: pending row WITH live browser download -> MUST skip
    h.sendMessage.mockClear();
    seedExpired("reDownloadTorrent-42~case3");
    h.sessionStore.set("ptd_downloadTracking", { 901: { downloadId: 42 } });
    h.searchDownload.mockResolvedValueOnce([{ id: 901, state: "in_progress" }]);
    h.sendMessage.mockImplementation(async (type: string) =>
      type === "getDownloadHistory" ? [{ id: 42, downloadStatus: "pending" }] : undefined,
    );
    await h.boot();
    await h.fireAlarm("reDownloadTorrent-42~case3");
    expect(h.sendMessage.mock.calls.filter(([t]) => t === "downloadTorrent")).toHaveLength(0);
    h.sessionStore.delete("ptd_downloadTracking");

    // Case 4: missing record (deleted by user) -> MUST skip (do not resurrect)
    h.sendMessage.mockClear();
    seedExpired("reDownloadTorrent-42~case4");
    h.sendMessage.mockImplementation(async (type: string) => (type === "getDownloadHistory" ? [] : undefined));
    await h.boot();
    await h.fireAlarm("reDownloadTorrent-42~case4");
    expect(h.sendMessage.mock.calls.filter(([t]) => t === "downloadTorrent")).toHaveLength(0);

    // Case 5: downloading/completed/failed -> MUST skip
    for (const status of ["downloading", "completed", "failed"]) {
      h.sendMessage.mockClear();
      const alarmName = `reDownloadTorrent-42~case5-${status}`;
      seedExpired(alarmName);
      h.sendMessage.mockImplementation(async (type: string) =>
        type === "getDownloadHistory" ? [{ id: 42, downloadStatus: status }] : undefined,
      );
      await h.boot();
      await h.fireAlarm(alarmName);
      expect(
        h.sendMessage.mock.calls.filter(([t]) => t === "downloadTorrent"),
        `status=${status}`,
      ).toHaveLength(0);
    }
  });
});

describe("F0002, F0004, F0006: nativeMessaging security, redaction, and lifecycle", () => {
  afterEach(() => {
    vi.doUnmock("@/messages.ts");
    vi.doUnmock("@/background/utils/offscreen.ts");
    vi.useRealTimers();
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  function setupNativeHarness(
    options: {
      permission?: boolean;
      enabled?: boolean;
      localGetImpl?: (key: string) => Promise<Record<string, unknown>>;
      postMessageThrowOnce?: boolean;
      connectNativeError?: Error;
    } = {},
  ) {
    const sendMessage = vi.fn();
    const onMessage = vi.fn();
    const sessionSets: Array<Record<string, unknown>> = [];
    const createdPorts: any[] = [];
    let shouldThrowPostMessage = options.postMessageThrowOnce ?? false;

    vi.doMock("@/messages.ts", () => ({ onMessage, sendMessage }));
    vi.doMock("@/background/utils/offscreen.ts", () => ({
      setupOffscreenDocument: vi.fn(async () => undefined),
    }));

    const connectNative = vi.fn(() => {
      if (options.connectNativeError) {
        throw options.connectNativeError;
      }
      const p: any = {
        posted: [] as any[],
        disconnect: vi.fn(),
        postMessage: vi.fn((msg: any) => {
          if (shouldThrowPostMessage) {
            shouldThrowPostMessage = false;
            throw new Error("Attempting to use a disconnected port object");
          }
          p.posted.push(msg);
        }),
        onMessage: {
          addListener: vi.fn((fn: (msg: any) => unknown) => {
            p.onMessageHandler = fn;
          }),
        },
        onDisconnect: {
          addListener: vi.fn((fn: () => void) => {
            p.onDisconnectHandler = fn;
          }),
        },
      };
      createdPorts.push(p);
      return p;
    });

    const alarmListeners: Array<(alarm: { name: string }) => void> = [];
    const localGet = vi.fn(async (key: string) => {
      if (options.localGetImpl) {
        return await options.localGetImpl(key);
      }
      if (key === "ptd_native_bridge_enabled") {
        return options.enabled === undefined ? {} : { ptd_native_bridge_enabled: options.enabled };
      }
      return {};
    });

    const runtimeMock: any = {
      id: "test-ext-id",
      lastError: undefined,
      connectNative,
    };

    vi.stubGlobal("__BROWSER__", "chrome");
    vi.stubGlobal("__EXT_VERSION__", "1.0.0-test");
    vi.stubGlobal("chrome", {
      alarms: {
        onAlarm: { addListener: vi.fn((fn: (a: { name: string }) => void) => alarmListeners.push(fn)) },
        create: vi.fn(),
        clear: vi.fn(),
      },
      permissions: {
        contains: vi.fn(async () => options.permission ?? true),
        onAdded: { addListener: vi.fn() },
        onRemoved: { addListener: vi.fn() },
      },
      storage: {
        local: { get: localGet, set: vi.fn(async () => undefined) },
        session: {
          get: vi.fn(async () => ({})),
          set: vi.fn(async (items: Record<string, unknown>) => {
            sessionSets.push(structuredClone(items));
          }),
        },
      },
      runtime: runtimeMock,
    });

    const lastSavedState = () =>
      (sessionSets.at(-1)?.nativeBridgeState as { state?: string; lastError?: string; reconnectAttempt?: number }) ??
      undefined;

    return {
      sendMessage,
      onMessage,
      connectNative,
      createdPorts,
      alarmListeners,
      runtimeMock,
      sessionSets,
      lastSavedState,
    };
  }

  it("F0006: redacts userinfo in embedded and protocol-relative URLs without corrupting emails or JSON", async () => {
    vi.resetModules();
    setupNativeHarness({ permission: true, enabled: false });
    const { sanitizeBridgeResult } = await import("@/background/utils/nativeMessaging.ts");

    const res = sanitizeBridgeResult({
      embedded: "Error fetching https://alice:s3cr3t@tracker.example/announce and http://bob:pw@b.example/dl",
      userinfoWithAt: "url: https://alice:p@ss@tracker.example/path",
      protocolRelativeStart: "//user:pass@cdn.example/file.torrent",
      protocolRelativeEmbedded: 'failed at ("//user:pass@cdn.example/file.torrent")',
      plainEmail: "Contact support@example.com for https://tracker.example/help",
      jsonWithEmail: '{"url":"https://tracker.example","email":"admin@example.com"}',
      dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk",
    }) as Record<string, string>;

    expect(res.embedded).toBe("Error fetching https://***@tracker.example/announce and http://***@b.example/dl");
    expect(res.userinfoWithAt).toBe("url: https://***@tracker.example/path");
    expect(res.protocolRelativeStart).toBe("//***@cdn.example/file.torrent");
    expect(res.protocolRelativeEmbedded).toBe('failed at ("//***@cdn.example/file.torrent")');
    expect(res.plainEmail).toBe("Contact support@example.com for https://tracker.example/help");
    expect(res.jsonWithEmail).toBe('{"url":"https://tracker.example","email":"admin@example.com"}');
    expect(res.dataUrl).toBe("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk");
  });

  it("F0002: rejects unvalidated searchEntry fields in getSiteSearchResult and projects allowed fields", async () => {
    vi.resetModules();
    const h = setupNativeHarness({ permission: true, enabled: true });
    const { validateBridgeParams } = await import("@/background/utils/nativeMessaging.ts");
    await flushAsync(4);

    // Valid shapes
    expect(validateBridgeParams("getSiteSearchResult", { siteId: "mteam" })).toBeUndefined();
    expect(
      validateBridgeParams("getSiteSearchResult", {
        siteId: "mteam",
        keyword: "matrix",
        autoDetectOfficialGroupFromTitle: false,
        searchEntry: { id: "movie" },
      }),
    ).toBeUndefined();
    expect(validateBridgeParams("getSiteSearchResult", { siteId: "mteam", searchEntry: {} })).toBeUndefined();

    // Attack vectors must be rejected
    expect(
      validateBridgeParams("getSiteSearchResult", {
        siteId: "mteam",
        searchEntry: { requestConfig: { url: "/usercp.php", method: "POST", data: { reset: 1 } } },
      }),
    ).toMatch(/may only specify 'id'/);
    expect(
      validateBridgeParams("getSiteSearchResult", {
        siteId: "mteam",
        searchEntry: { id: "default", selectors: { title: { selector: "#passkey" } } },
      }),
    ).toMatch(/may only specify 'id'/);
    expect(
      validateBridgeParams("getSiteSearchResult", {
        siteId: "mteam",
        searchEntry: { keywordPath: "data.action", merge: false, advanceKeywordParams: {} },
      }),
    ).toMatch(/may only specify 'id'/);
    expect(
      validateBridgeParams("getSiteSearchResult", {
        siteId: "mteam",
        searchEntry: { id: "constructor" },
      }),
    ).toMatch(/valid non-empty string/);
    expect(validateBridgeParams("getSiteSearchResult", { siteId: "mteam", extra: 1 })).toMatch(/unsupported field/);
    expect(validateBridgeParams("getSiteSearchResult", {})).toMatch(/siteId/);

    // End-to-end bridge message enforcement
    const port = h.createdPorts[0]!;
    await port.onMessageHandler({
      type: "request",
      id: "attack-1",
      method: "getSiteSearchResult",
      params: {
        siteId: "mteam",
        searchEntry: { requestConfig: { url: "/usercp.php" }, selectors: { title: { selector: "#key" } } },
      },
    });
    expect(h.sendMessage).not.toHaveBeenCalled();
    expect(port.posted).toContainEqual(
      expect.objectContaining({
        type: "response",
        id: "attack-1",
        error: expect.objectContaining({ code: "INVALID_PARAMS" }),
      }),
    );

    // Valid request with predefined searchEntry id forwards cleanly
    h.sendMessage.mockResolvedValueOnce({ status: 0, data: [] });
    await port.onMessageHandler({
      type: "request",
      id: "ok-1",
      method: "getSiteSearchResult",
      params: { siteId: "mteam", keyword: "test", searchEntry: { id: "movie" } },
    });
    expect(h.sendMessage).toHaveBeenCalledWith("getSiteSearchResult", {
      siteId: "mteam",
      keyword: "test",
      searchEntry: { id: "movie" },
    });
  });

  it("F0004: clears stale port and schedules reconnect on hello postMessage failure", async () => {
    vi.resetModules();
    vi.useFakeTimers();
    const h = setupNativeHarness({ permission: true, enabled: true, postMessageThrowOnce: true });
    await import("@/background/utils/nativeMessaging.ts");
    await vi.advanceTimersByTimeAsync(0);

    expect(h.connectNative).toHaveBeenCalledTimes(1);
    expect(h.createdPorts[0]!.disconnect).toHaveBeenCalledTimes(1);
    expect(h.lastSavedState()).toMatchObject({
      state: "retrying",
      reconnectAttempt: 1,
      lastError: "Attempting to use a disconnected port object",
    });

    // Advance backoff timer (2000ms for attempt 1): reconnect must NOT be blocked by stale port
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.connectNative).toHaveBeenCalledTimes(2);
    expect(h.lastSavedState()).toMatchObject({ state: "connected" });
  });

  it("F0004: clears stale port and schedules reconnect on getOrCreateInstanceId failure", async () => {
    vi.resetModules();
    vi.useFakeTimers();
    let failInstanceId = true;
    const h = setupNativeHarness({
      permission: true,
      enabled: true,
      localGetImpl: async (key: string) => {
        if (key === "ptd_native_bridge_enabled") return { ptd_native_bridge_enabled: true };
        if (key === "ptd_native_instance_id" && failInstanceId) {
          failInstanceId = false;
          throw new Error("storage transient error");
        }
        return { ptd_native_instance_id: "inst-1" };
      },
    });

    await import("@/background/utils/nativeMessaging.ts");
    await vi.advanceTimersByTimeAsync(0);

    expect(h.connectNative).toHaveBeenCalledTimes(1);
    expect(h.createdPorts[0]!.disconnect).toHaveBeenCalledTimes(1);
    expect(h.lastSavedState()).toMatchObject({
      state: "retrying",
      reconnectAttempt: 1,
      lastError: "storage transient error",
    });

    await vi.advanceTimersByTimeAsync(2000);
    expect(h.connectNative).toHaveBeenCalledTimes(2);
    expect(h.lastSavedState()).toMatchObject({ state: "connected" });
  });

  it("F0004: persists disabled, connected, and fatal error states to session storage", async () => {
    // 1. disabled state persisted
    vi.resetModules();
    const hDisabled = setupNativeHarness({ permission: true, enabled: false });
    await import("@/background/utils/nativeMessaging.ts");
    await flushAsync(4);
    expect(hDisabled.lastSavedState()).toMatchObject({ state: "disabled", enabled: false });

    // 2. fatal connectNative error persisted
    vi.resetModules();
    const hFatalConnect = setupNativeHarness({
      permission: true,
      enabled: true,
      connectNativeError: new Error("Specified native messaging host not found."),
    });
    await import("@/background/utils/nativeMessaging.ts");
    await flushAsync(4);
    expect(hFatalConnect.lastSavedState()).toMatchObject({
      state: "error",
      lastError: "Specified native messaging host not found.",
    });

    // 3. connected and then fatal onDisconnect error persisted
    vi.resetModules();
    const hFatalDisconnect = setupNativeHarness({ permission: true, enabled: true });
    await import("@/background/utils/nativeMessaging.ts");
    await flushAsync(4);
    expect(hFatalDisconnect.lastSavedState()).toMatchObject({ state: "connected" });

    hFatalDisconnect.runtimeMock.lastError = { message: "Access to the specified native messaging host is forbidden." };
    hFatalDisconnect.createdPorts[0]!.onDisconnectHandler();
    await flushAsync(2);
    expect(hFatalDisconnect.lastSavedState()).toMatchObject({
      state: "error",
      lastError: "Access to the specified native messaging host is forbidden.",
    });
  });
});
