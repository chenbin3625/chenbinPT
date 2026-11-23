import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, defineStore } from "pinia";
import { createApp, h } from "vue";

import { redactSensitiveUrls } from "@/shared/redact.ts";
import { isTorrentFavoriteItem } from "@/shared/types/storages/torrentFavorite.ts";

const messagingMocks = vi.hoisted(() => ({
  originalSendMessage: vi.fn(),
  originalOnMessage: vi.fn(),
}));

vi.mock("@webext-core/messaging", () => ({
  defineExtensionMessaging: () => ({
    sendMessage: messagingMocks.originalSendMessage,
    onMessage: messagingMocks.originalOnMessage,
  }),
}));

vi.stubGlobal("__BROWSER__", "chrome");

/* -------------------------------------------------------------------------- */
/*                                   F0016                                    */
/* -------------------------------------------------------------------------- */

describe("F0016: messages ensureOffscreenReady does not cache stale readiness indefinitely", () => {
  beforeEach(() => {
    messagingMocks.originalSendMessage.mockReset();
    messagingMocks.originalOnMessage.mockReset();
  });

  async function loadMessagesModule() {
    vi.resetModules();
    return await import("@/messages.ts");
  }

  it("re-checks ensureOffscreenDocument before subsequent non-retryable writes after idle reclamation", async () => {
    messagingMocks.originalSendMessage
      .mockResolvedValueOnce(undefined) // ensure #1
      .mockResolvedValueOnce({ site: "pt", status: 0 }) // read #1
      .mockResolvedValueOnce(undefined) // ensure #2 (fresh check before write)
      .mockResolvedValueOnce({ downloadId: 1, downloadStatus: "completed" }); // downloadTorrent

    const { sendMessage } = await loadMessagesModule();

    await sendMessage("getSiteUserInfoResult", "pt");
    await expect(sendMessage("downloadTorrent", { torrent: { site: "pt" } } as any)).resolves.toMatchObject({
      downloadId: 1,
    });

    expect(messagingMocks.originalSendMessage.mock.calls.map(([type]) => type)).toEqual([
      "ensureOffscreenDocument",
      "getSiteUserInfoResult",
      "ensureOffscreenDocument",
      "downloadTorrent",
    ]);
  });

  it("deduplicates concurrent in-flight ensureOffscreenDocument calls, then checks again once settled", async () => {
    let resolveEnsure!: () => void;
    messagingMocks.originalSendMessage
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveEnsure = resolve;
          }),
      )
      .mockResolvedValueOnce({ site: "a" })
      .mockResolvedValueOnce({ site: "b" })
      .mockResolvedValueOnce(undefined) // ensure #2 after first batch settles
      .mockResolvedValueOnce(undefined); // settleBrowserDownload

    const { sendMessage } = await loadMessagesModule();

    const p1 = sendMessage("getSiteUserInfoResult", "a");
    const p2 = sendMessage("getSiteUserInfoResult", "b");
    await vi.waitFor(() => expect(resolveEnsure).toBeTypeOf("function"));
    resolveEnsure();

    await Promise.all([p1, p2]);
    await sendMessage("settleBrowserDownload", { downloadId: 1, state: "complete" });

    expect(messagingMocks.originalSendMessage.mock.calls.map(([type]) => type)).toEqual([
      "ensureOffscreenDocument",
      "getSiteUserInfoResult",
      "getSiteUserInfoResult",
      "ensureOffscreenDocument",
      "settleBrowserDownload",
    ]);
  });

  it("re-runs local ensureOffscreenDocument handler in Service Worker on sequential writes", async () => {
    const localEnsure = vi.fn(async () => undefined);
    messagingMocks.originalSendMessage.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined);

    const { onMessage, sendMessage } = await loadMessagesModule();
    onMessage("ensureOffscreenDocument", localEnsure);

    await sendMessage("settleBrowserDownload", { downloadId: 1, state: "complete" });
    await sendMessage("releaseBrowserDownloadBlob", {
      chromeDownloadId: 2,
      state: "complete",
      blobUrl: "blob:test",
    });

    expect(localEnsure).toHaveBeenCalledTimes(2);
    expect(messagingMocks.originalSendMessage.mock.calls.map(([type]) => type)).toEqual([
      "settleBrowserDownload",
      "releaseBrowserDownloadBlob",
    ]);
  });

  it("does not leave readiness wedged after Error('No response') and still does not auto-retry writes", async () => {
    const noResponseError = new Error("No response");
    messagingMocks.originalSendMessage
      .mockResolvedValueOnce(undefined) // ensure #1
      .mockRejectedValueOnce(noResponseError) // write #1 fails with No response
      .mockResolvedValueOnce(undefined) // ensure #2
      .mockResolvedValueOnce(true); // write #2 succeeds

    const { sendMessage } = await loadMessagesModule();

    await expect(sendMessage("pauseClientTorrent", { downloaderId: "qb", id: "1" })).rejects.toBe(noResponseError);
    await expect(sendMessage("pauseClientTorrent", { downloaderId: "qb", id: "2" })).resolves.toBe(true);

    expect(messagingMocks.originalSendMessage.mock.calls.map(([type]) => type)).toEqual([
      "ensureOffscreenDocument",
      "pauseClientTorrent",
      "ensureOffscreenDocument",
      "pauseClientTorrent",
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/*                             F0017 & F0018                                  */
/* -------------------------------------------------------------------------- */

describe("F0017: redactSensitiveUrls splits #fragment before redacting path passkeys", () => {
  const passkey = "0a1b2c3d4e5f60718293a4b5c6d7e8f9";

  it("redacts path-embedded passkey when followed by #fragment without query", () => {
    const input = `https://r.example/api/v1/torrents/download/123/${passkey}#section-2`;
    const output = redactSensitiveUrls(input);
    expect(output).toBe("https://r.example/api/v1/torrents/download/123/***#section-2");
    expect(output).not.toContain(passkey);
  });

  it("redacts both path-embedded passkey and k=v fragment pairs", () => {
    const input = `https://r.example/api/v1/torrents/download/123/${passkey}#access_token=s3cr3t&mode=fast`;
    const output = redactSensitiveUrls(input);
    expect(output).toBe("https://r.example/api/v1/torrents/download/123/***#access_token=***&mode=***");
    expect(output).not.toContain(passkey);
    expect(output).not.toContain("s3cr3t");
  });

  it("redacts path-embedded passkey when # appears before ?", () => {
    const input = `https://r.example/api/v1/torrents/download/123/${passkey}#route?token=secret`;
    const output = redactSensitiveUrls(input);
    expect(output).toBe("https://r.example/api/v1/torrents/download/123/***#route?token=***");
    expect(output).not.toContain(passkey);
    expect(output).not.toContain("secret");
  });

  it("redacts relative path passkey followed by #fragment", () => {
    const input = `/api/v1/torrents/download/123/${passkey}#top`;
    const output = redactSensitiveUrls(input);
    expect(output).toBe("/api/v1/torrents/download/123/***#top");
    expect(output).not.toContain(passkey);
  });
});

describe("F0018: redactSensitiveUrls redacts magnet:? URIs while preserving xt infoHash", () => {
  it("redacts percent-encoded tracker and webseed passkeys in magnet URIs", () => {
    const magnet =
      "Download: magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567" +
      "&dn=Movie.Name" +
      "&tr=https%3A%2F%2Ftracker.example.com%2Fannounce%3Fpasskey%3Dmysecretpasskey99" +
      "&ws=https%3A%2F%2Fseed.example.com%2Fdl%3Ftoken%3Dwssecret88.";

    const output = redactSensitiveUrls(magnet);
    expect(output).toBe("Download: magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=***&tr=***&ws=***.");
    expect(output).not.toContain("mysecretpasskey99");
    expect(output).not.toContain("wssecret88");
  });

  it("handles uppercase MAGNET:?, indexed xt.1/tr.1, unencoded tracker URLs, and fragments", () => {
    const input =
      "MAGNET:?XT.1=urn:btmh:1220abcdef0123456789" +
      "&TR.1=https://tracker.example/announce?passkey=rawsecret" +
      "&as=https%3A%2F%2Fas.example%2Ffile%3Fkey%3D1" +
      "&xs=https%3A%2F%2Fxs.example%2Fmeta%3Fkey%3D2#token=fragsecret";

    const output = redactSensitiveUrls(input);
    expect(output).toBe("MAGNET:?XT.1=urn:btmh:1220abcdef0123456789&TR.1=***&as=***&xs=***#token=***");
    expect(output).not.toContain("rawsecret");
    expect(output).not.toContain("fragsecret");
  });

  it("redacts non-URN xt values instead of trusting them", () => {
    const input = "magnet:?xt=https://evil.example/dl?token=leak123&tr=udp%3A%2F%2Ftracker";
    const output = redactSensitiveUrls(input);
    expect(output).toBe("magnet:?xt=***&tr=***");
    expect(output).not.toContain("leak123");
  });
});

/* -------------------------------------------------------------------------- */
/*                                   F0019                                    */
/* -------------------------------------------------------------------------- */

describe("F0019: isTorrentFavoriteItem validates optional favCategories and comment", () => {
  const validBase = {
    key: "pt-1",
    site: "pt",
    createdAt: 1700000000000,
    title: "Example",
  };

  it("accepts valid favorite items with omitted or properly typed optional fields", () => {
    expect(isTorrentFavoriteItem(validBase)).toBe(true);
    expect(isTorrentFavoriteItem({ ...validBase, favCategories: [], comment: "" })).toBe(true);
    expect(isTorrentFavoriteItem({ ...validBase, favCategories: ["movies", "4k"], comment: "good" })).toBe(true);
  });

  it("rejects malformed favCategories or comment values", () => {
    expect(isTorrentFavoriteItem({ ...validBase, favCategories: 123 })).toBe(false);
    expect(isTorrentFavoriteItem({ ...validBase, favCategories: {} })).toBe(false);
    expect(isTorrentFavoriteItem({ ...validBase, favCategories: "movies" })).toBe(false);
    expect(isTorrentFavoriteItem({ ...validBase, favCategories: null })).toBe(false);
    expect(isTorrentFavoriteItem({ ...validBase, favCategories: ["movies", 42] })).toBe(false);
    expect(isTorrentFavoriteItem({ ...validBase, comment: 123 })).toBe(false);
    expect(isTorrentFavoriteItem({ ...validBase, comment: null })).toBe(false);
    expect(isTorrentFavoriteItem({ ...validBase, comment: { text: "bad" } })).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*                             F0020 & F0021                                  */
/* -------------------------------------------------------------------------- */

describe("F0020 & F0021: webExtPersistence prototype guard and mergeBeforeWrite concurrency", () => {
  type StorageChange = Record<string, { oldValue?: unknown; newValue?: unknown }>;

  const backing = new Map<string, unknown>();
  const listeners: Array<(changes: StorageChange, areaName: string) => void> = [];
  let deferGet = false;
  const pendingGets: Array<() => void> = [];

  function clonePreservingProto<T>(value: T): T {
    if (value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map((item) => clonePreservingProto(item)) as unknown as T;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>)) {
      const cloned = clonePreservingProto((value as Record<string, unknown>)[key]);
      Object.defineProperty(out, key, { value: cloned, writable: true, enumerable: true, configurable: true });
    }
    return out as T;
  }

  function emitChanges(changes: StorageChange) {
    for (const listener of listeners) {
      listener(changes, "local");
    }
  }

  const storageLocal = {
    get: (key: string) => {
      const read = () => (backing.has(key) ? { [key]: clonePreservingProto(backing.get(key)) } : {});
      if (deferGet) {
        return new Promise<Record<string, unknown>>((resolve) => {
          pendingGets.push(() => resolve(read()));
        });
      }
      return Promise.resolve(read());
    },
    set: (items: Record<string, unknown>) => {
      const changes: StorageChange = {};
      for (const [key, value] of Object.entries(items)) {
        const cloned = clonePreservingProto(value);
        changes[key] = {
          oldValue: backing.has(key) ? clonePreservingProto(backing.get(key)) : undefined,
          newValue: cloned,
        };
        backing.set(key, cloned);
      }
      emitChanges(changes);
      return Promise.resolve();
    },
    remove: (key: string) => {
      backing.delete(key);
      emitChanges({ [key]: { oldValue: undefined, newValue: undefined } });
      return Promise.resolve();
    },
    onChanged: {
      addListener: (fn: (changes: StorageChange, areaName: string) => void) => listeners.push(fn),
      removeListener: (fn: (changes: StorageChange, areaName: string) => void) => {
        const index = listeners.indexOf(fn);
        if (index >= 0) listeners.splice(index, 1);
      },
    },
  };

  async function flushMicrotasks() {
    for (let i = 0; i < 20; i++) {
      await Promise.resolve();
    }
  }

  function withOwnKey<T extends Record<string, any>>(target: T, key: string, value: unknown): T {
    Object.defineProperty(target, key, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
    return target;
  }

  async function createStore(id = "testReviewFixStore") {
    vi.stubGlobal("chrome", {
      storage: { local: storageLocal, onChanged: storageLocal.onChanged },
    });
    const { piniaWebExtPersistencePlugin } = await import("~/extends/pinia/webExtPersistence.ts");
    const pinia = createPinia();
    pinia.use(piniaWebExtPersistencePlugin);
    createApp({ render: () => h("div") }).use(pinia);

    const useStore = defineStore(id, {
      persistWebExt: true,
      state: () => ({
        sites: {
          siteA: { name: "A", sortIndex: 1 } as Record<string, any>,
        } as Record<string, any>,
        fieldX: "initX",
        fieldY: "initY",
      }),
    });
    return useStore(pinia);
  }

  beforeEach(() => {
    backing.clear();
    listeners.length = 0;
    pendingGets.length = 0;
    deferGet = false;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("F0020: strips own __proto__/constructor/prototype during initial hydration", async () => {
    const key = "f0020Hydration";
    const maliciousSite = withOwnKey(
      withOwnKey({ name: "Hydrated", sortIndex: 2 }, "__proto__", { nestedEvil: "yes" }),
      "constructor",
      { fake: true },
    );
    const maliciousRoot = withOwnKey(
      withOwnKey(
        withOwnKey({ sites: { siteA: maliciousSite }, fieldX: "x", fieldY: "y" }, "__proto__", { rootEvil: "yes" }),
        "constructor",
        { hacked: true },
      ),
      "prototype",
      { hackedProto: true },
    );
    backing.set(key, maliciousRoot);

    const store = await createStore(key);
    await store.$onReady();

    expect(store.sites.siteA.name).toBe("Hydrated");
    expect(Object.getPrototypeOf(store.$state)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(store.sites.siteA)).toBe(Object.prototype);
    expect((store.$state as any).rootEvil).toBeUndefined();
    expect((store.sites.siteA as any).nestedEvil).toBeUndefined();
    expect(Object.hasOwn(store.$state as any, "constructor")).toBe(false);
    expect(Object.hasOwn(store.$state as any, "prototype")).toBe(false);
    expect(Object.hasOwn(store.sites.siteA, "constructor")).toBe(false);
    expect(({} as any).rootEvil).toBeUndefined();
    expect(({} as any).nestedEvil).toBeUndefined();
  });

  it("F0020: cloneForStore strips nested __proto__/constructor/prototype in newly added external subtrees", async () => {
    const key = "f0020CloneForStore";
    const store = await createStore(key);
    await store.$onReady();

    const evilSubtree = withOwnKey(
      withOwnKey({ name: "NewSite", items: [withOwnKey({ id: 1 }, "__proto__", { arrayEvil: "yes" })] }, "__proto__", {
        subEvil: "yes",
      }),
      "constructor",
      { bad: true },
    );

    await storageLocal.set({
      [key]: {
        ...(backing.get(key) as any),
        sites: {
          siteA: { name: "A", sortIndex: 1 },
          siteNew: evilSubtree,
        },
      },
    });

    expect(store.sites.siteNew.name).toBe("NewSite");
    expect(Object.getPrototypeOf(store.sites.siteNew)).toBe(Object.prototype);
    expect((store.sites.siteNew as any).subEvil).toBeUndefined();
    expect(Object.hasOwn(store.sites.siteNew, "constructor")).toBe(false);
    expect(Object.getPrototypeOf(store.sites.siteNew.items[0])).toBe(Object.prototype);
    expect((store.sites.siteNew.items[0] as any).arrayEvil).toBeUndefined();
  });

  it("F0020: applyMinimalPatch and buildMinimalPatch ignore __proto__/constructor/prototype", async () => {
    const key = "f0020MinimalPatch";
    // Delay restore so syncedSnapshot stays null and onChanged enters applyMinimalPatch / buildMinimalPatch
    deferGet = true;
    const store = await createStore(key);

    const maliciousSiteA = withOwnKey(
      withOwnKey({ name: "PatchedA", sortIndex: 1 }, "__proto__", { deepEvil: "yes" }),
      "prototype",
      { deepProto: true },
    );
    const payload = withOwnKey(
      withOwnKey(
        {
          sites: { siteA: maliciousSiteA },
          fieldX: "patchedX",
          fieldY: "initY",
        },
        "__proto__",
        { topEvil: "yes" },
      ),
      "constructor",
      { topCtor: true },
    );

    void storageLocal.set({ [key]: payload });

    expect(store.sites.siteA.name).toBe("PatchedA");
    expect(store.fieldX).toBe("patchedX");
    expect(Object.getPrototypeOf(store.$state)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(store.sites.siteA)).toBe(Object.prototype);
    expect((store.$state as any).topEvil).toBeUndefined();
    expect((store.sites.siteA as any).deepEvil).toBeUndefined();
    expect(Object.hasOwn(store.$state as any, "constructor")).toBe(false);
    expect(Object.hasOwn(store.sites.siteA, "prototype")).toBe(false);

    // Clean up deferred restore get
    pendingGets.shift()?.();
    await flushMicrotasks();
  });

  it("F0021: mergeBeforeWrite preserves newer local edits made while storage.get is in flight", async () => {
    const key = "f0021ConcurrentEdit";
    const store = await createStore(key);
    await store.$onReady();

    // Another context wrote fieldX and fieldY to storage before our save reads storage
    backing.set(key, {
      sites: { siteA: { name: "A", sortIndex: 1 } },
      fieldX: "externalX",
      fieldY: "externalY",
    });

    // Local edits siteA.name and starts $save(); storage.get is in flight
    deferGet = true;
    store.sites.siteA.name = "localA";
    const firstSave = store.$save();
    await flushMicrotasks();
    expect(pendingGets).toHaveLength(1);

    // While storage.get is in flight, user edits fieldX locally and queues a second $save()
    store.fieldX = "newerLocalX";
    const secondSave = store.$save();

    // First save's storage.get resolves; second save should not stay deferred
    deferGet = false;
    pendingGets.shift()!();

    await Promise.all([firstSave, secondSave]);

    // Newer local edit on fieldX must NOT be overwritten by externalX, while unrelated externalY IS kept
    expect(store.fieldX).toBe("newerLocalX");
    expect(store.fieldY).toBe("externalY");
    expect(store.sites.siteA.name).toBe("localA");

    const persisted = backing.get(key) as any;
    expect(persisted.fieldX).toBe("newerLocalX");
    expect(persisted.fieldY).toBe("externalY");
    expect(persisted.sites.siteA.name).toBe("localA");
  });

  it("F0021: timed-out stale write generation does not mutate live store.$state when storage.get resolves late", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const key = "f0021StaleGen";
    const store = await createStore(key);
    await store.$onReady();

    // Simulate external change on fieldY already in storage when gen 1 reads it
    backing.set(key, {
      sites: { siteA: { name: "A", sortIndex: 1 } },
      fieldX: "initX",
      fieldY: "staleExternalY",
    });

    deferGet = true;
    store.fieldX = "gen1X";
    const gen1Save = store.$save();
    await flushMicrotasks();
    expect(pendingGets).toHaveLength(1);

    // Gen 1 times out during storage.get
    await vi.advanceTimersByTimeAsync(10_001);
    await expect(gen1Save).rejects.toThrow(/timed out/i);
    await flushMicrotasks();

    // Gen 2 runs and saves fresh values for both fieldX and fieldY
    deferGet = false;
    store.fieldX = "gen2X";
    store.fieldY = "gen2Y";
    await store.$save();
    expect(store.fieldY).toBe("gen2Y");
    expect((backing.get(key) as any).fieldY).toBe("gen2Y");

    // Stale Gen 1's storage.get finally resolves: must NOT overwrite live store.$state or storage
    pendingGets.shift()!();
    await flushMicrotasks();

    expect(store.fieldX).toBe("gen2X");
    expect(store.fieldY).toBe("gen2Y");
    expect((backing.get(key) as any).fieldX).toBe("gen2X");
    expect((backing.get(key) as any).fieldY).toBe("gen2Y");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("stale persistence write discarded"));
    expect(errorSpy).toHaveBeenCalled();
  });
});
