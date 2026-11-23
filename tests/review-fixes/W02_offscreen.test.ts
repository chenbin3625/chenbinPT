import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { format as formatDate } from "date-fns";

const mocks = vi.hoisted(() => {
  const downloadHistory = new Map<number, any>();
  const socialIdb = new Map<string, any>();
  const state = { nextDownloadId: 0 };
  const db = {
    put: vi.fn(async (store: string, item: any, key?: string) => {
      if (store === "social_information" && typeof key === "string") {
        socialIdb.set(key, structuredClone(item));
        return key;
      }
      const id = item.id ?? ++state.nextDownloadId;
      downloadHistory.set(id, structuredClone({ ...item, id }));
      return id;
    }),
    get: vi.fn(async (store: string, key: any) => {
      if (store === "social_information") {
        return socialIdb.has(key) ? structuredClone(socialIdb.get(key)) : undefined;
      }
      return downloadHistory.has(key) ? structuredClone(downloadHistory.get(key)) : undefined;
    }),
    getAll: vi.fn(async (store: string) => {
      if (store === "social_information") return [...socialIdb.values()].map((v) => structuredClone(v));
      return [...downloadHistory.values()].map((v) => structuredClone(v));
    }),
    getAllKeys: vi.fn(async (store: string) => {
      if (store === "social_information") return [...socialIdb.keys()];
      return [...downloadHistory.keys()];
    }),
    delete: vi.fn(async (store: string, key: any) => {
      if (store === "social_information") socialIdb.delete(key);
      else downloadHistory.delete(key);
    }),
    clear: vi.fn(async (store: string) => {
      if (store === "social_information") socialIdb.clear();
      else downloadHistory.clear();
    }),
    transaction: vi.fn((store: string) => ({
      store: {
        getAllKeys: async () => (store === "social_information" ? [...socialIdb.keys()] : [...downloadHistory.keys()]),
        getAll: async () =>
          store === "social_information"
            ? [...socialIdb.values()].map((v) => structuredClone(v))
            : [...downloadHistory.values()].map((v) => structuredClone(v)),
        delete: async (key: any) => {
          if (store === "social_information") socialIdb.delete(key);
          else downloadHistory.delete(key);
        },
      },
      done: Promise.resolve(),
    })),
  };

  return {
    db,
    downloadHistory,
    socialIdb,
    state,
    onMessage: vi.fn(),
    sendMessage: vi.fn(),
    logger: vi.fn(),
    getSiteInstance: vi.fn(),
    getDownloader: vi.fn(),
    getDownloaderMetaData: vi.fn(),
    releaseDownloaderInstance: vi.fn(),
    getRemoteTorrentFile: vi.fn(),
    getSocialSiteInformation: vi.fn(),
    matchSocialPageUrl: vi.fn(),
    replaceDownloadHistory: vi.fn(async () => true),
  };
});

vi.mock("@/messages.ts", () => ({ onMessage: mocks.onMessage, sendMessage: mocks.sendMessage }));
vi.mock("@/offscreen/utils/logger.ts", () => ({ logger: mocks.logger }));
vi.mock("@/offscreen/utils/site.ts", () => ({ getSiteInstance: mocks.getSiteInstance }));
vi.mock("@/offscreen/adapter/indexdb.ts", () => ({ ptdIndexDb: Promise.resolve(mocks.db) }));
vi.mock("@ptd/downloader", () => ({
  getDownloader: mocks.getDownloader,
  getDownloaderMetaData: mocks.getDownloaderMetaData,
  releaseDownloaderInstance: mocks.releaseDownloaderInstance,
}));
vi.mock("@ptd/downloader/utils.ts", () => ({ getRemoteTorrentFile: mocks.getRemoteTorrentFile }));
vi.mock("@ptd/social", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ptd/social")>();
  return {
    ...actual,
    getSocialSiteInformation: mocks.getSocialSiteInformation,
    matchSocialPageUrl: mocks.matchSocialPageUrl,
  };
});
vi.mock("@ptd/backupServer/utils.ts", () => ({
  backupDataToZipBlob: vi.fn(),
  getBackupFilename: vi.fn(() => "PTD_backup_test.zip"),
  hasBackupRetentionToApply: vi.fn(() => false),
  isBackupFilename: vi.fn(() => false),
  pruneBackupFiles: vi.fn(() => [[]]),
  replaceDownloadHistory: mocks.replaceDownloadHistory,
}));
vi.mock("@ptd/backupServer", () => ({
  entityList: ["WebDAV"],
  getBackupServer: vi.fn(),
  getBackupServerMetaData: vi.fn(async () => ({ requiredField: [] })),
}));

const originalChrome = (globalThis as any).chrome;
const originalWindowOpen = (window as any).open;
const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;

beforeEach(() => {
  vi.useRealTimers();
  mocks.onMessage.mockReset();
  mocks.sendMessage.mockReset();
  mocks.logger.mockReset();
  mocks.getSiteInstance.mockReset();
  mocks.getDownloader.mockReset();
  mocks.getDownloaderMetaData.mockReset();
  mocks.releaseDownloaderInstance.mockReset();
  mocks.getRemoteTorrentFile.mockReset();
  mocks.getSocialSiteInformation.mockReset();
  mocks.downloadHistory.clear();
  mocks.socialIdb.clear();
  mocks.state.nextDownloadId = 0;
  (globalThis as any).__BROWSER__ = "chrome";
  (globalThis as any).__EXT_VERSION__ = "test";
});

afterEach(() => {
  vi.useRealTimers();
  (globalThis as any).chrome = originalChrome;
  (window as any).open = originalWindowOpen;
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
});

describe("F0009: backup.ts cookie host allowlist hardening", () => {
  it("rejects delimiter-injected cookie.domain values even with hostOnly: true", async () => {
    vi.resetModules();
    const setCookieCalls: Array<Record<string, any>> = [];
    mocks.sendMessage.mockImplementation(async (name: string, payload: any) => {
      if (name === "getExtStoragePath" && payload?.path === "siteHostMap") {
        return { "trusted-pt.com": "trusted" };
      }
      if (name === "setCookie") {
        setCookieCalls.push(structuredClone(payload));
        return true;
      }
      return undefined;
    });

    const { restoreBackupData } = await import("@/offscreen/utils/backup.ts");
    const maliciousDomains = [
      "victim.example/.trusted-pt.com",
      "victim.example?.trusted-pt.com",
      "victim.example#.trusted-pt.com",
      "victim.example\\.trusted-pt.com",
      "trusted-pt.com@victim.example",
      "victim.example%2f.trusted-pt.com",
      "..trusted-pt.com",
      "trusted-pt.com:8443",
      "victim.example\r\n.trusted-pt.com",
    ];

    const report = await restoreBackupData(
      {
        cookies: {
          "trusted-pt.com": [
            ...maliciousDomains.map((domain, idx) => ({
              name: `evil_${idx}`,
              value: "x",
              domain,
              path: "/",
              secure: true,
              hostOnly: true,
            })),
            {
              name: "valid_host_only",
              value: "ok",
              domain: "trusted-pt.com",
              path: "/",
              secure: true,
              hostOnly: true,
            },
            {
              name: "valid_sub",
              value: "ok",
              domain: ".sub.trusted-pt.com",
              path: "/forum",
              secure: true,
            },
          ],
        } as any,
        manifest: { time: Date.now(), version: "test", files: { cookies: "h" } } as any,
      },
      { fields: ["cookies"] },
    );

    expect(report.success).toBe(true);
    expect(setCookieCalls.map((c) => c.name).sort()).toEqual(["valid_host_only", "valid_sub"]);
    for (const cookie of setCookieCalls) {
      const parsed = new URL(cookie.url);
      expect(parsed.hostname === "trusted-pt.com" || parsed.hostname.endsWith(".trusted-pt.com")).toBe(true);
    }
    expect(report.skipped.some((s) => s.field === "cookies" && s.reason.includes("结构非法"))).toBe(true);
  });
});

describe("F0010: download.ts content-script dynamic savePath template validation", () => {
  async function loadDownloadHandler(suggestFolders: string[], defaultFolder?: string) {
    vi.resetModules();
    (globalThis as any).chrome = {
      runtime: { id: "test", getURL: (path: string) => `chrome-extension://test/${path}` },
    };
    const addTorrent = vi.fn(async () => ({ success: true }));
    mocks.getDownloader.mockResolvedValue({ addTorrent });
    mocks.getSiteInstance.mockResolvedValue({
      downloadInterval: 0,
      userConfig: { uploadSpeedLimit: 0 },
      metadata: { id: "mteam", name: "M-Team" },
      isTrustedSiteUrl: (url: string) => new URL(url).hostname === "kp.m-team.cc",
      isTrustedDownloadLink: (url: string) => new URL(url).hostname === "kp.m-team.cc",
      getTorrentDownloadRequestConfig: vi.fn(async (torrent: any) => ({ url: torrent.link })),
    });
    mocks.sendMessage.mockImplementation(async (name: string, payload: any) => {
      if (name === "getExtStoragePath") {
        if (payload?.path === "download") return {};
        if (payload?.path === "download.saveDownloadHistory") return true;
        if (payload?.path === "defaultDownloader") return defaultFolder ? { id: "d1", folder: defaultFolder } : {};
        if (Array.isArray(payload?.path) && payload.path[0] === "downloaders") {
          return {
            id: "d1",
            type: "qBittorrent",
            address: "http://127.0.0.1:8080",
            enabled: true,
            suggestFolders,
          };
        }
        if (Array.isArray(payload?.path) && payload.path[0] === "siteNameMap") {
          return "M-Team";
        }
        return payload?.defaultValue;
      }
      return undefined;
    });

    await import("@/offscreen/utils/download.ts");
    const handler = mocks.onMessage.mock.calls.find(([name]) => name === "downloadTorrent")?.[1];
    return { handler: handler as (args: { data: any; sender?: any }) => Promise<any>, addTorrent };
  }

  const csSender = {
    id: "test",
    url: "https://kp.m-team.cc/browse",
    tab: { url: "https://kp.m-team.cc/browse" },
  };

  it("allows expanded $var$ templates and safe single-segment <...> expansions", async () => {
    const year = formatDate(new Date(), "yyyy");
    const { handler, addTorrent } = await loadDownloadHandler([
      "/downloads/$torrent.site$/$date:YYYY$/$torrent.category$",
      "/downloads/$torrent.siteName$/<...>",
    ]);

    const res1 = await handler({
      data: {
        torrent: {
          site: "mteam",
          id: "1",
          title: "Movie",
          category: "Movies",
          link: "https://kp.m-team.cc/dl/1",
        },
        downloaderId: "d1",
        addTorrentOptions: { savePath: `/downloads/mteam/${year}/Movies` },
      },
      sender: csSender,
    });
    expect(res1.downloadStatus).toBe("completed");
    expect(addTorrent).toHaveBeenLastCalledWith(
      "https://kp.m-team.cc/dl/1",
      expect.objectContaining({ savePath: `/downloads/mteam/${year}/Movies` }),
    );

    const res2 = await handler({
      data: {
        torrent: {
          site: "mteam",
          id: "2",
          title: "Show",
          link: "https://kp.m-team.cc/dl/2",
        },
        downloaderId: "d1",
        addTorrentOptions: { savePath: "/downloads/M-Team/Season 1" },
      },
      sender: csSender,
    });
    expect(res2.downloadStatus).toBe("completed");
    expect(addTorrent).toHaveBeenLastCalledWith(
      "https://kp.m-team.cc/dl/2",
      expect.objectContaining({ savePath: "/downloads/M-Team/Season 1" }),
    );

    // Empty <...> input is explicitly allowed by SentToDownloaderDialog
    const res3 = await handler({
      data: {
        torrent: { site: "mteam", id: "3", title: "Show", link: "https://kp.m-team.cc/dl/3" },
        downloaderId: "d1",
        addTorrentOptions: { savePath: "/downloads/M-Team/" },
      },
      sender: csSender,
    });
    expect(res3.downloadStatus).toBe("completed");
  });

  it("rejects path traversal, multi-segment, and unconfigured savePaths", async () => {
    const { handler } = await loadDownloadHandler(["/downloads/$torrent.site$/<...>"]);
    const badPaths = [
      "/downloads/mteam/../../etc",
      "/downloads/mteam/..",
      "/downloads/mteam/.",
      "/downloads/mteam/nested/sub",
      "/downloads/mteam/win\\sub",
      "/downloads/other-site/movies",
      "/etc/passwd",
    ];

    for (const savePath of badPaths) {
      await expect(
        handler({
          data: {
            torrent: { site: "mteam", id: "1", title: "T", link: "https://kp.m-team.cc/dl/1" },
            downloaderId: "d1",
            addTorrentOptions: { savePath },
          },
          sender: csSender,
        }),
      ).rejects.toThrow(/save path is not in the configured folders/);
    }
  });
});

describe("F0011 & F0012: download.ts filename sanitization and MV3 tracking failure cleanup", () => {
  it("sanitizes unsafe characters and path separators in local download filenames", async () => {
    vi.resetModules();
    (globalThis as any).chrome = {
      runtime: { id: "test" },
      downloads: {
        search: vi.fn(async () => [{ state: "in_progress" }]),
        onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
      },
    };
    (window as any).open = vi.fn(() => null);
    URL.createObjectURL = vi.fn(() => "blob:test/1");
    URL.revokeObjectURL = vi.fn();

    mocks.getSiteInstance.mockResolvedValue({
      downloadInterval: 0,
      userConfig: { uploadSpeedLimit: 0 },
      isTrustedDownloadLink: () => true,
      getTorrentDownloadRequestConfig: vi.fn(async () => ({ url: "https://example.com/dl/1" })),
    });
    mocks.sendMessage.mockImplementation(async (name: string, payload: any) => {
      if (name === "getExtStoragePath") return payload?.defaultValue;
      if (name === "downloadFile") return 101;
      return undefined;
    });

    await import("@/offscreen/utils/download.ts");
    const handler = mocks.onMessage.mock.calls.find(([name]) => name === "downloadTorrent")?.[1];

    // Case 1: torrentInstance.name contains path traversal and illegal chars
    mocks.getRemoteTorrentFile.mockResolvedValueOnce({
      name: '../../evil:dir/sub\\Movie*?<>|".torrent',
      metadata: { blob: () => new Blob(["x"]) },
    });
    await handler!({
      data: {
        torrent: { site: "pt", id: "1", title: "ignored", link: "https://example.com/dl/1" },
        downloaderId: "local",
      },
    });
    const firstFile = mocks.sendMessage.mock.calls.find(([name]) => name === "downloadFile")?.[1]?.filename as string;
    expect(firstFile).toMatch(/\.torrent$/);
    expect(firstFile).not.toMatch(/[\\/<>:"|?*]/);
    expect(firstFile).not.toContain("..");

    // Case 2: fallback "1.torrent" uses torrent.title containing illegal chars
    mocks.sendMessage.mockClear();
    mocks.getRemoteTorrentFile.mockResolvedValueOnce({
      name: "1.torrent",
      metadata: { blob: () => new Blob(["x"]) },
    });
    await handler!({
      data: {
        torrent: {
          site: "pt",
          id: "2",
          title: "The Matrix: Reloaded / Cut? *2003*",
          link: "https://example.com/dl/2",
        },
        downloaderId: "local",
      },
    });
    const secondFile = mocks.sendMessage.mock.calls.find(([name]) => name === "downloadFile")?.[1]?.filename as string;
    expect(secondFile).toMatch(/\.torrent$/);
    expect(secondFile).not.toMatch(/[\\/<>:"|?*]/);
    expect(secondFile).toContain("[pt]");

    // Case 3: Windows reserved name
    mocks.sendMessage.mockClear();
    mocks.getRemoteTorrentFile.mockResolvedValueOnce({
      name: "CON.torrent",
      metadata: { blob: () => new Blob(["x"]) },
    });
    await handler!({
      data: {
        torrent: { site: "pt", id: "3", title: "t", link: "https://example.com/dl/3" },
        downloaderId: "local",
      },
    });
    const thirdFile = mocks.sendMessage.mock.calls.find(([name]) => name === "downloadFile")?.[1]?.filename as string;
    expect(thirdFile).toBe("_CON.torrent");
  });

  it("F0012: cleans up remoteDownloadSettlements and revokes blobUrl on timeout when registerDownloadTracking fails in MV3", async () => {
    vi.useFakeTimers();
    vi.resetModules();
    // Simulate Chrome MV3 offscreen: chrome.downloads is unavailable
    (globalThis as any).chrome = { runtime: { id: "test" } };
    (window as any).open = vi.fn(() => null);
    URL.createObjectURL = vi.fn(() => "blob:mv3/leak-test");
    const revokeSpy = vi.fn();
    URL.revokeObjectURL = revokeSpy;

    mocks.getSiteInstance.mockResolvedValue({
      downloadInterval: 0,
      userConfig: { uploadSpeedLimit: 0 },
      isTrustedDownloadLink: () => true,
      getTorrentDownloadRequestConfig: vi.fn(async () => ({ url: "https://example.com/dl/1" })),
    });
    mocks.getRemoteTorrentFile.mockResolvedValue({
      name: "test.torrent",
      metadata: { blob: () => new Blob(["x"]) },
    });
    mocks.sendMessage.mockImplementation(async (name: string, payload: any) => {
      if (name === "getExtStoragePath") return payload?.defaultValue;
      if (name === "downloadFile") return 777;
      if (name === "registerDownloadTracking") throw new Error("SW disconnected");
      return undefined;
    });

    await import("@/offscreen/utils/download.ts");
    const downloadHandler = mocks.onMessage.mock.calls.find(([name]) => name === "downloadTorrent")?.[1];
    const settleHandler = mocks.onMessage.mock.calls.find(([name]) => name === "settleBrowserDownload")?.[1];

    const res = await downloadHandler!({
      data: {
        torrent: { site: "pt", id: "1", title: "t", link: "https://example.com/dl/1" },
        downloaderId: "local",
      },
    });
    expect(res.downloadStatus).toBe("pending");
    expect(revokeSpy).not.toHaveBeenCalled();

    // Advance past BLOB_URL_RELEASE_TIMEOUT (10 minutes)
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 50);
    expect(revokeSpy).toHaveBeenCalledTimes(1);
    expect(revokeSpy).toHaveBeenCalledWith("blob:mv3/leak-test");

    // Late settleBrowserDownload should find entry already cleaned up (no second revoke)
    await settleHandler!({ data: { downloadId: res.downloadId, state: "complete" } });
    expect(revokeSpy).toHaveBeenCalledTimes(1);
  });
});

describe("F0014: socialInformation.ts invalidates in-memory @ptd/social cache and enrichmentAttemptedKeys", () => {
  it("passes force: true after clearSocialInformation and deleteSocialInformation, and resets enrichmentAttemptedKeys", async () => {
    vi.resetModules();
    mocks.sendMessage.mockImplementation(async (name: string, payload: any) => {
      if (name === "getExtStoragePath") return { cacheDay: 3, preferPtGen: true };
      return payload?.defaultValue;
    });

    let fetchCount = 0;
    mocks.getSocialSiteInformation.mockImplementation(async (_site: string, sid: string, cfg: any) => {
      fetchCount += 1;
      return {
        site: "imdb",
        id: sid,
        title: `Title v${fetchCount}`,
        poster: "https://img.example/p.jpg",
        summary: fetchCount >= 2 ? "Enriched summary" : "",
        createAt: Date.now(),
        _forceUsed: cfg?.force,
      };
    });

    const { getSocialInformation, clearSocialInformation, deleteSocialInformation } =
      await import("@/offscreen/utils/socialInformation.ts");

    // 1. First fetch (force: false)
    const first = await getSocialInformation("imdb", "tt1");
    expect(first.title).toBe("Title v1");
    expect(mocks.getSocialSiteInformation).toHaveBeenLastCalledWith(
      "imdb",
      "tt1",
      expect.objectContaining({ force: false }),
    );

    // 2. Attempt enrichment once -> marks enrichmentAttemptedKeys
    const enriched = await getSocialInformation("imdb", "tt1", { requireSummary: true });
    expect(enriched.title).toBe("Title v2");

    // 3. Clear all social cache -> next lookup must pass force: true to bypass @ptd/social 10-min cache
    await clearSocialInformation();
    const afterClear = await getSocialInformation("imdb", "tt1");
    expect(afterClear.title).toBe("Title v3");
    expect(mocks.getSocialSiteInformation).toHaveBeenLastCalledWith(
      "imdb",
      "tt1",
      expect.objectContaining({ force: true }),
    );

    // 4. Delete a specific entry -> only that entry requires force: true
    await getSocialInformation("imdb", "tt2");
    await deleteSocialInformation("imdb", "tt1");
    await getSocialInformation("imdb", "tt1");
    expect(mocks.getSocialSiteInformation).toHaveBeenLastCalledWith(
      "imdb",
      "tt1",
      expect.objectContaining({ force: true }),
    );

    // tt2 stays cached in IDB (not re-fetched)
    const callsBeforeTt2 = mocks.getSocialSiteInformation.mock.calls.length;
    await getSocialInformation("imdb", "tt2");
    expect(mocks.getSocialSiteInformation).toHaveBeenCalledTimes(callsBeforeTt2);
  });
});

describe("F0015: torrentFavorite.ts guards malformed storage entries in getTorrentFavoriteStatus", () => {
  it("ignores null and malformed entries without throwing TypeError", async () => {
    vi.resetModules();
    mocks.sendMessage.mockImplementation(async (name: string) => {
      if (name === "getExtStorage") {
        return {
          "a-1": {
            key: "a-1",
            site: "a",
            id: "1",
            title: "Good",
            createdAt: 1000,
            favCategories: ["Movies"],
            comment: "nice",
          },
          "a-2": null,
          "a-3": "corrupt-string",
          "a-4": { key: "a-4", site: "a", createdAt: 2000, favCategories: "not-an-array", comment: 42 },
          "a-5": { key: "a-5", site: "a", id: "5", title: "Minimal", createdAt: 3000 },
        };
      }
      return undefined;
    });

    const { getTorrentFavoriteStatus } = await import("@/offscreen/utils/torrentFavorite.ts");
    const status = await getTorrentFavoriteStatus([
      { site: "a", id: "1" },
      { site: "a", id: "2" },
      { site: "a", id: "3" },
      { site: "a", id: "4" },
      { site: "a", id: "5" },
    ]);

    expect(status).toEqual({
      favorites: [
        { key: "a-1", favCategories: ["Movies"], comment: "nice" },
        { key: "a-5", favCategories: undefined, comment: undefined },
      ],
      favCategories: ["Movies"],
    });
  });
});

describe("F0013: userInfo.ts re-reads queueConcurrency on Chrome MV3 when chrome.storage is unavailable", () => {
  it("picks up updated config.userInfo.queueConcurrency without chrome.storage.onChanged", async () => {
    vi.resetModules();
    // Simulate Chrome MV3 offscreen: chrome.storage is undefined
    (globalThis as any).chrome = { runtime: { id: "test" } };

    let currentConcurrency = 1;
    mocks.sendMessage.mockImplementation(async (name: string, payload: any) => {
      if (name === "getExtStoragePath" && payload?.path === "userInfo.queueConcurrency") {
        return currentConcurrency;
      }
      if (name === "getExtStoragePath") {
        return payload?.defaultValue;
      }
      return undefined;
    });

    let running = 0;
    let maxRunning = 0;
    mocks.getSiteInstance.mockImplementation(async (siteId: string) => ({
      url: `https://${siteId}.example.test`,
      allowQueryUserInfo: true,
      metadata: { type: "private" },
      isOnline: true,
      getUserInfoResult: vi.fn(async () => {
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        await new Promise((resolve) => setTimeout(resolve, 25));
        running -= 1;
        return { site: siteId, status: 0, updateAt: Date.now() };
      }),
    }));

    const { getSiteUserInfoResult } = await import("@/offscreen/utils/userInfo.ts");

    // Batch 1 with concurrency=1
    await Promise.all([getSiteUserInfoResult("s1"), getSiteUserInfoResult("s2")]);
    expect(maxRunning).toBe(1);

    // User changes setting to concurrency=3 in Options
    currentConcurrency = 3;
    maxRunning = 0;

    // Batch 2 without explicit queueConcurrency must pick up 3 instead of stale 1
    await Promise.all([getSiteUserInfoResult("s3"), getSiteUserInfoResult("s4"), getSiteUserInfoResult("s5")]);
    expect(maxRunning).toBe(3);
  });
});
