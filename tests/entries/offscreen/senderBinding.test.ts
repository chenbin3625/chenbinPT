/**
 * A2 / B1-3：offscreen 处理方的「sender 页面 ↔ 站点」绑定回归测试。
 *
 * 覆盖：
 * - `getTorrentDownloadLink`：内容脚本只能为所在站点的种子取链接；
 * - `downloadTorrent`：内容脚本的站点必须与 sender host 匹配；无站点 magnet 只能存本地；
 * - `downloadTorrent`：内容脚本传入的 `downloadId` 被丢弃，不能按 id 改写既有下载历史。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const history = new Map<number, any>();
  const state = { nextId: 0 };
  const db = {
    put: vi.fn(async (_store: string, item: any) => {
      const id = item.id ?? ++state.nextId;
      history.set(id, structuredClone({ ...item, id }));
      return id;
    }),
    get: vi.fn(async (_store: string, id: number) => structuredClone(history.get(id))),
    getAll: vi.fn(async () => []),
    delete: vi.fn(async () => undefined),
    clear: vi.fn(async () => undefined),
  };
  return {
    db,
    history,
    state,
    sessionStore: new Map<string, unknown>(),
    onMessage: vi.fn(),
    sendMessage: vi.fn(),
    logger: vi.fn(),
    getSiteInstance: vi.fn(),
    createSiteInstance: vi.fn(),
    downloadStateListeners: [] as Array<(delta: any) => void>,
    windowOpen: vi.fn(() => ({ closed: false }) as any),
    getRemoteTorrentFile: vi.fn(),
  };
});

vi.mock("@/messages.ts", () => ({ onMessage: mocks.onMessage, sendMessage: mocks.sendMessage }));
vi.mock("@/offscreen/utils/logger.ts", () => ({ logger: mocks.logger }));
vi.mock("@/offscreen/utils/site.ts", () => ({ getSiteInstance: mocks.getSiteInstance }));
vi.mock("@/offscreen/adapter/indexdb.ts", () => ({ ptdIndexDb: Promise.resolve(mocks.db) }));
vi.mock("@ptd/downloader", () => ({
  getDownloader: vi.fn(),
  getDownloaderMetaData: vi.fn(),
  releaseDownloaderInstance: vi.fn(),
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
      remove: async (key: string) => mocks.sessionStore.delete(key),
    },
  },
  downloads: {
    search: vi.fn(async () => [{ state: "in_progress" }]),
    onChanged: {
      addListener: (fn: (delta: any) => void) => mocks.downloadStateListeners.push(fn),
      removeListener: (fn: (delta: any) => void) => {
        const index = mocks.downloadStateListeners.indexOf(fn);
        if (index >= 0) mocks.downloadStateListeners.splice(index, 1);
      },
    },
  },
  runtime: { id: "test", getURL: (path: string) => `chrome-extension://test/${path}` },
} as any);
vi.stubGlobal("__BROWSER__", "chrome");

(window as any).open = mocks.windowOpen;
URL.createObjectURL = vi.fn(() => "blob:test/torrent");
URL.revokeObjectURL = vi.fn();

type Handler = (args: { data: any; sender?: any }) => Promise<any>;

async function loadModule(): Promise<Record<string, Handler>> {
  vi.resetModules();
  mocks.onMessage.mockClear();
  mocks.sendMessage.mockReset();
  mocks.logger.mockClear();
  mocks.getSiteInstance.mockReset();
  mocks.history.clear();
  mocks.state.nextId = 0;
  mocks.sessionStore.clear();
  mocks.windowOpen.mockReturnValue({ closed: false });

  mocks.sendMessage.mockImplementation(async (name: string, payload: any) => {
    if (name === "getExtStoragePath") {
      if (payload?.path === "download") return { ignoreSiteDownloadIntervalWhenLocalDownload: false };
      return payload?.defaultValue;
    }
    if (name === "downloadFile") return 4242;
    return undefined;
  });

  mocks.getSiteInstance.mockResolvedValue({
    downloadInterval: 0,
    userConfig: { uploadSpeedLimit: 0 },
    metadata: { id: "a", urls: ["https://a.example.com/"] },
    isTrustedSiteUrl: (url: string) => ["a.example.com", "api.a.example.com"].includes(new URL(url).hostname),
    isTrustedDownloadLink: (url: string) => ["a.example.com", "api.a.example.com"].includes(new URL(url).hostname),
    getTorrentDownloadLink: vi.fn(async () => "https://a.example.com/download.php?id=1"),
    getTorrentDownloadRequestConfig: vi.fn(async () => ({ url: "https://a.example.com/download.php?id=1" })),
  });

  await import("@/offscreen/utils/download.ts");

  const handlers: Record<string, Handler> = {};
  for (const [name, handler] of mocks.onMessage.mock.calls) {
    handlers[name as string] = handler as Handler;
  }
  return handlers;
}

const contentScriptSender = (url: string) => ({ id: "test", url, tab: { url } });
const extensionSender = { id: "test", url: "chrome-extension://test/src/entries/options/index.html" };

function makeTorrent(overrides: Record<string, any> = {}) {
  return { site: "a", id: "1", title: "t", link: "https://a.example.com/download.php?id=1", ...overrides };
}

describe("A2：getTorrentDownloadLink 的 sender 绑定", () => {
  beforeEach(() => {
    mocks.downloadStateListeners.length = 0;
  });

  it("内容脚本在站点页面上取本站种子链接：允许", async () => {
    const handlers = await loadModule();
    const link = await handlers.getTorrentDownloadLink!({
      data: makeTorrent(),
      sender: contentScriptSender("https://a.example.com/torrents.php"),
    });
    expect(link).toBe("https://a.example.com/download.php?id=1");
  });

  it("内容脚本跨站取其它站点链接：拒绝", async () => {
    const handlers = await loadModule();
    await expect(
      handlers.getTorrentDownloadLink!({
        data: makeTorrent(),
        sender: contentScriptSender("https://evil.example/x"),
      }),
    ).rejects.toThrow(/Permission denied/);
  });

  it("内容脚本未提供 torrent.site：拒绝", async () => {
    const handlers = await loadModule();
    await expect(
      handlers.getTorrentDownloadLink!({
        data: makeTorrent({ site: undefined }),
        sender: contentScriptSender("https://a.example.com/"),
      }),
    ).rejects.toThrow(/must supply the torrent site/);
  });

  it("扩展页不受绑定限制（options 可预览任意站点链接）", async () => {
    const handlers = await loadModule();
    const link = await handlers.getTorrentDownloadLink!({ data: makeTorrent(), sender: extensionSender });
    expect(link).toBe("https://a.example.com/download.php?id=1");
  });

  it("外部扩展作为 sender（id 不匹配）必须受绑定限制，跨站直接拒绝（P1-1）", async () => {
    const handlers = await loadModule();
    const externalExtensionSender = {
      id: "other-evil-extension-id",
      url: "chrome-extension://other-evil-extension-id/page.html",
    };
    await expect(
      handlers.getTorrentDownloadLink!({
        data: makeTorrent(),
        sender: externalExtensionSender,
      }),
    ).rejects.toThrow(/Permission denied/);
  });
});

describe("A2 / B1-3：downloadTorrent 的 sender 绑定与 downloadId 校验", () => {
  beforeEach(() => {
    mocks.downloadStateListeners.length = 0;
  });

  it("内容脚本在站点页面上下载本站种子：允许", async () => {
    const handlers = await loadModule();
    const result = await handlers.downloadTorrent!({
      data: { torrent: makeTorrent(), downloaderId: "local", addTorrentOptions: {} },
      sender: contentScriptSender("https://a.example.com/torrents.php"),
    });
    expect(result.downloadStatus).toBe("completed");
  });

  it("内容脚本跨站下载其它站点种子：拒绝", async () => {
    const handlers = await loadModule();
    await expect(
      handlers.downloadTorrent!({
        data: { torrent: makeTorrent(), downloaderId: "local", addTorrentOptions: {} },
        sender: contentScriptSender("https://evil.example/x"),
      }),
    ).rejects.toThrow(/Permission denied/);
  });

  it("内容脚本无站点 magnet 只能存本地文件（不能推任意下载器）", async () => {
    const handlers = await loadModule();
    const magnet = "magnet:?xt=urn:btih:0123456789abcdef";

    await expect(
      handlers.downloadTorrent!({
        data: { torrent: { link: magnet }, downloaderId: "d1", addTorrentOptions: { savePath: "/tmp" } },
        sender: contentScriptSender("https://a.example.com/"),
      }),
    ).rejects.toThrow(/site-less magnet links to local file/);

    const local = await handlers.downloadTorrent!({
      data: { torrent: { link: magnet }, downloaderId: "local", addTorrentOptions: {} },
      sender: contentScriptSender("https://a.example.com/"),
    });
    expect(local.downloadStatus).toBe("completed");
  });

  it("内容脚本传入的 downloadId 被丢弃，不会改写既有下载历史（B1-3）", async () => {
    const handlers = await loadModule();
    mocks.history.set(42, { id: 42, downloadStatus: "completed", title: "victim" });

    const result = await handlers.downloadTorrent!({
      data: { downloadId: 42, torrent: makeTorrent(), downloaderId: "local", addTorrentOptions: {} },
      sender: contentScriptSender("https://a.example.com/torrents.php"),
    });

    expect(result.downloadId).not.toBe(42);
    expect(mocks.history.get(42)).toMatchObject({ downloadStatus: "completed", title: "victim" });
    expect(mocks.history.get(result.downloadId)).toBeTruthy();
  });
});
