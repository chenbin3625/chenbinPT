/**
 * offscreen-a 包（第三轮审查）的回归测试：
 *
 * - **OFFSCREEN-1**：`saveDownloadHistory=false` 时 `setDownloadHistory` 返回 0，
 *   所有延迟下载共用 `reDownloadTorrent-0` 而互相覆盖；修复后仍给出唯一且不复用的负数投递 id。
 * - **OFFSCREEN-3**：offscreen 自建下载器实例缓存的 key 漏掉 `feature` / `advanceAddTorrentOptions`，
 *   只改「绕过 CSRF」等开关不会重建实例；修复后 key 与 `@ptd/downloader` 对齐。
 * - **OFFSCREEN-6**：`prepareDownloadTorrent` 抛错时刚落库的 `pending` 记录永久停在 pending；
 *   修复后会被标为 failed 并写入 errorMessage。
 * - **OFFSCREEN-7**：配置变化时旧实例被丢弃但从不 dispose（Aria2 的 WebSocket 泄漏）；
 *   修复后替换缓存条目前调用 `releaseDownloaderInstance`。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const store = new Map<number, any>();
  const state = { nextId: 0 };
  const db = {
    put: vi.fn(async (_table: string, item: any) => {
      const id = item.id ?? ++state.nextId;
      store.set(id, structuredClone({ ...item, id }));
      return id;
    }),
    get: vi.fn(async (_table: string, id: number) => (store.has(id) ? structuredClone(store.get(id)) : undefined)),
    delete: vi.fn(async () => undefined),
    clear: vi.fn(async () => undefined),
  };
  return {
    db,
    store,
    state,
    onMessage: vi.fn(),
    sendMessage: vi.fn(),
    logger: vi.fn(),
    getSiteInstance: vi.fn(),
    getDownloader: vi.fn(),
    getDownloaderMetaData: vi.fn(),
    releaseDownloaderInstance: vi.fn(),
    getRemoteTorrentFile: vi.fn(),
    sessionStore: new Map<string, unknown>(),
    saveDownloadHistory: true,
    downloaders: {} as Record<string, any>,
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

vi.stubGlobal("chrome", {
  storage: {
    session: {
      get: async (key: string) => (mocks.sessionStore.has(key) ? { [key]: mocks.sessionStore.get(key) } : {}),
      set: async (items: Record<string, unknown>) => {
        for (const [key, value] of Object.entries(items)) {
          mocks.sessionStore.set(key, structuredClone(value));
        }
      },
      remove: async (key: string) => {
        mocks.sessionStore.delete(key);
      },
    },
  },
  downloads: {
    search: vi.fn(async () => [{ state: "in_progress" }]),
    onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
  },
  runtime: { id: "test", getURL: (path: string) => `chrome-extension://test/${path}` },
} as any);
vi.stubGlobal("__BROWSER__", "chrome");

(window as any).open = vi.fn(() => ({ closed: false }));
(URL as any).createObjectURL = vi.fn(() => "blob:test/torrent");
(URL as any).revokeObjectURL = vi.fn();

type DownloadHandler = (args: { data: any; sender?: chrome.runtime.MessageSender }) => Promise<any>;
type DownloadModule = typeof import("@/offscreen/utils/download.ts");

let downloaderInstanceSeq = 0;

async function loadDownloadModule(): Promise<{ handler: DownloadHandler; mod: DownloadModule }> {
  vi.resetModules();
  mocks.onMessage.mockClear();
  mocks.sendMessage.mockClear();
  mocks.logger.mockClear();
  mocks.getSiteInstance.mockReset();
  mocks.getDownloader.mockReset();
  mocks.releaseDownloaderInstance.mockClear();
  mocks.db.put.mockClear();
  mocks.db.get.mockClear();
  mocks.store.clear();
  mocks.state.nextId = 0;
  mocks.saveDownloadHistory = true;
  mocks.downloaders = {};
  downloaderInstanceSeq = 0;

  mocks.sendMessage.mockImplementation(async (name: string, payload: any) => {
    if (name === "getExtStoragePath") {
      if (payload?.path === "download.saveDownloadHistory") {
        return mocks.saveDownloadHistory;
      }
      if (payload?.path === "download") {
        return { ignoreSiteDownloadIntervalWhenLocalDownload: false };
      }
      if (Array.isArray(payload?.path) && payload.path[0] === "downloaders") {
        return mocks.downloaders[payload.path[1]] ?? {};
      }
      return payload?.defaultValue;
    }
    return undefined;
  });

  // 每次都返回新对象：模拟「配置变化 → 库级缓存未命中 → new 一个实例」
  mocks.getDownloader.mockImplementation(async () => ({ tag: `downloader-${++downloaderInstanceSeq}` }));

  const mod = await import("@/offscreen/utils/download.ts");
  const handler = mocks.onMessage.mock.calls.find(([name]) => name === "downloadTorrent")?.[1] as DownloadHandler;
  expect(handler, "downloadTorrent handler should be registered").toBeTypeOf("function");
  return { handler, mod };
}

function makeOption(torrentOverrides: Record<string, any> = {}) {
  return {
    torrent: {
      site: "testsite",
      id: "t1",
      title: "title",
      link: "https://example.com/download/1",
      ...torrentOverrides,
    },
    downloaderId: "local",
    addTorrentOptions: {},
  };
}

function makeSiteInstance(downloadInterval = 0) {
  return {
    downloadInterval,
    userConfig: { uploadSpeedLimit: 0 },
    isTrustedDownloadLink: vi.fn(() => true),
    getTorrentDownloadRequestConfig: vi.fn(async () => ({})),
  };
}

describe("offscreen-a 审查修复（OFFSCREEN-1 / 3 / 6 / 7）", () => {
  beforeEach(() => {
    mocks.sessionStore.clear();
    mocks.downloaders = {};
    mocks.saveDownloadHistory = true;
  });

  describe("OFFSCREEN-1：关闭下载历史时的投递 id 必须唯一", () => {
    it("saveDownloadHistory=false 时多个延迟下载拿到互不相同的负数 id，且不写 IndexedDB", async () => {
      const { handler } = await loadDownloadModule();
      mocks.saveDownloadHistory = false;
      mocks.getSiteInstance.mockResolvedValue(makeSiteInstance(60));

      // 第一次下载：间隔尚未消耗，正常执行并预留站点下载时间戳
      const first = await handler({ data: makeOption({ link: "https://example.com/download/1" }) });
      expect(first.downloadStatus).toBe("completed");

      // 之后两次都被站点下载间隔挡住 → 走 reDownloadTorrent 投递分支（修复前都会是 downloadId=0）
      const second = await handler({ data: makeOption({ link: "https://example.com/download/2" }) });
      const third = await handler({ data: makeOption({ link: "https://example.com/download/3" }) });
      expect(second.downloadStatus).toBe("pending");
      expect(third.downloadStatus).toBe("pending");

      expect(mocks.db.put, "关闭历史时不应写 IndexedDB").not.toHaveBeenCalled();
      expect(second.downloadId).toBeLessThan(0);
      expect(third.downloadId).toBeLessThan(0);
      expect(second.downloadId, "两次投递不得复用同一个 id").not.toBe(third.downloadId);

      const reDownloadCalls = mocks.sendMessage.mock.calls.filter(([name]) => name === "reDownloadTorrent");
      expect(reDownloadCalls).toHaveLength(2);
      expect(reDownloadCalls.map(([, payload]) => payload.downloadId)).toEqual([second.downloadId, third.downloadId]);
    });

    it("saveDownloadHistory=true 时仍然使用 IndexedDB 的自增正数 id（行为不变）", async () => {
      const { handler } = await loadDownloadModule();
      mocks.getSiteInstance.mockResolvedValue(makeSiteInstance(60));

      const first = await handler({ data: makeOption({ link: "https://example.com/download/1" }) });
      const second = await handler({ data: makeOption({ link: "https://example.com/download/2" }) });

      expect(first.downloadId).toBeGreaterThan(0);
      expect(second.downloadId).toBeGreaterThan(0);
      expect(second.downloadId).not.toBe(first.downloadId);
    });
  });

  describe("M-1：右键菜单显式推送的无站点链接", () => {
    it("扩展页 sender 携带 allowSiteLessLink 时，无站点 http(s) 链接可以下载", async () => {
      const { handler } = await loadDownloadModule();

      const result = await handler({
        data: {
          ...makeOption({ site: undefined, link: "https://public.example/file.torrent" }),
          allowSiteLessLink: true,
        },
        sender: { id: "test", url: "chrome-extension://test/options.html" } as any,
      });

      expect(result.downloadStatus).toBe("completed");
      expect(mocks.getSiteInstance).not.toHaveBeenCalled();
    });

    it("content script 伪造 allowSiteLessLink 仍被记录为失败", async () => {
      const { handler } = await loadDownloadModule();

      const result = await handler({
        data: {
          ...makeOption({ site: undefined, link: "https://public.example/file.torrent" }),
          allowSiteLessLink: true,
        },
        sender: { id: "test", url: "https://pt.example/torrents.php" } as any,
      });

      expect(result.downloadStatus).toBe("failed");
      expect(result.errorMessage).toMatch(/trusted site/);
    });
  });

  describe("OFFSCREEN-3：实例缓存键必须覆盖 feature / advanceAddTorrentOptions", () => {
    it("只改 config.feature.BypassCSRF 也会重建下载器实例", async () => {
      const { mod } = await loadDownloadModule();
      mocks.downloaders.d1 = {
        id: "d1",
        type: "qBittorrent",
        address: "http://127.0.0.1:8080",
        feature: { BypassCSRF: false },
      };

      const first = await mod.getDownloaderInstance("d1");
      await mod.getDownloaderInstance("d1");
      expect(mocks.getDownloader, "同一配置应命中 offscreen 缓存").toHaveBeenCalledTimes(1);

      mocks.downloaders.d1 = { ...mocks.downloaders.d1, feature: { BypassCSRF: true } };
      const rebuilt = await mod.getDownloaderInstance("d1");

      expect(mocks.getDownloader, "feature 变化必须重建实例，否则「绕过 CSRF」开关不生效").toHaveBeenCalledTimes(2);
      expect(rebuilt).not.toBe(first);
    });

    it("只改 advanceAddTorrentOptions 也会重建下载器实例", async () => {
      const { mod } = await loadDownloadModule();
      mocks.downloaders.d1 = { id: "d1", type: "qBittorrent", address: "http://127.0.0.1:8080" };

      await mod.getDownloaderInstance("d1");
      mocks.downloaders.d1 = { ...mocks.downloaders.d1, advanceAddTorrentOptions: { tags: ["ptd"] } };
      await mod.getDownloaderInstance("d1");

      expect(mocks.getDownloader).toHaveBeenCalledTimes(2);
    });

    it("仅 UI 字段（name）变化不重建实例", async () => {
      const { mod } = await loadDownloadModule();
      mocks.downloaders.d1 = { id: "d1", type: "qBittorrent", address: "http://127.0.0.1:8080", name: "旧名字" };

      await mod.getDownloaderInstance("d1");
      mocks.downloaders.d1 = { ...mocks.downloaders.d1, name: "新名字" };
      await mod.getDownloaderInstance("d1");

      expect(mocks.getDownloader, "UI 字段不影响实例行为，不该引起重建").toHaveBeenCalledTimes(1);
      expect(mocks.releaseDownloaderInstance).not.toHaveBeenCalled();
    });
  });

  describe("OFFSCREEN-7：替换缓存条目前释放旧实例", () => {
    it("配置变化时对旧实例调用 releaseDownloaderInstance（关闭 Aria2 的长连接）", async () => {
      const { mod } = await loadDownloadModule();
      mocks.downloaders.d1 = { id: "d1", type: "Aria2", address: "http://127.0.0.1:6800" };
      const first = await mod.getDownloaderInstance("d1");

      mocks.downloaders.d1 = { ...mocks.downloaders.d1, address: "http://127.0.0.1:6801" };
      const second = await mod.getDownloaderInstance("d1");

      expect(second).not.toBe(first);
      expect(mocks.releaseDownloaderInstance).toHaveBeenCalledTimes(1);
      expect(mocks.releaseDownloaderInstance).toHaveBeenCalledWith(first);
    });

    it("库级缓存返回同一个实例时不 dispose（避免关掉正在使用的连接）", async () => {
      const { mod } = await loadDownloadModule();
      const shared = { tag: "shared" };
      mocks.getDownloader.mockResolvedValue(shared);
      mocks.downloaders.d1 = { id: "d1", type: "Aria2", address: "http://127.0.0.1:6800" };

      await mod.getDownloaderInstance("d1");
      // 库级稳定 key 相同 → getDownloader 仍返回同一个实例；只有 offscreen 的 JSON key 变了
      mocks.downloaders.d1 = {
        id: "d1",
        type: "Aria2",
        address: "http://127.0.0.1:6800",
        feature: { BypassCSRF: true },
      };
      const again = await mod.getDownloaderInstance("d1");

      expect(again).toBe(shared);
      expect(mocks.releaseDownloaderInstance).not.toHaveBeenCalled();
    });
  });

  describe("OFFSCREEN-6：prepareDownloadTorrent 失败不能留下永久 pending", () => {
    it("站点实例化失败时把刚落库的 pending 记录标为 failed 并写入 errorMessage", async () => {
      const { handler } = await loadDownloadModule();
      mocks.getSiteInstance.mockRejectedValue(new Error("site not found in this build"));

      await expect(handler({ data: makeOption() })).rejects.toThrow("site not found in this build");

      const record = mocks.store.get(1);
      expect(record, "preparation 阶段应已落过一条历史").toBeTruthy();
      expect(record.downloadStatus).toBe("failed");
      expect(record.errorMessage).toBe("site not found in this build");
    });

    it("调用方显式传入的 downloadId（延迟重下）不被本次失败改写", async () => {
      const { handler } = await loadDownloadModule();
      mocks.store.set(42, { id: 42, downloadStatus: "completed" });
      mocks.getSiteInstance.mockRejectedValue(new Error("site not found in this build"));

      await expect(handler({ data: { ...makeOption(), downloadId: 42 } })).rejects.toThrow("site not found");

      expect(mocks.store.get(42).downloadStatus, "既有记录由 background 的对账逻辑负责").toBe("completed");
    });
  });
});
