/**
 * 下载历史凭据持久化（OS-1）与延迟重下 payload 脱敏（B1-4）回归测试。
 *
 * - OS-1：`downloadTorrent` 落库的 `downloadRequestConfig` 只能是「method + 脱敏 URL + timeout」，
 *   不得包含 headers/params/data 等可能带 Authorization/passkey 的内容。
 * - B1-4：站点下载间隔未到时投递给 background 的 `reDownloadTorrent` payload 会被写进
 *   chrome.storage.local 最长 24h；可重新解析下载链接的站点必须丢掉 `torrent.link`，
 *   且任何情况下都要剥离 `addTorrentOptions.localDownloadOption`。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const history = new Map<number, any>();
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
  const state = { nextId: 0 };
  const sessionStore = new Map<string, unknown>();
  return {
    db,
    history,
    state,
    sessionStore,
    onMessage: vi.fn(),
    sendMessage: vi.fn(),
    logger: vi.fn(),
    getSiteInstance: vi.fn(),
    getDownloader: vi.fn(),
    getDownloaderMetaData: vi.fn(),
    releaseDownloaderInstance: vi.fn(),
    getRemoteTorrentFile: vi.fn(),
    downloadStateListeners: [] as Array<(delta: any) => void>,
    searchDownload: vi.fn(async () => [{ state: "in_progress" }]),
    createObjectURL: vi.fn(() => "blob:test/torrent"),
    revokeObjectURL: vi.fn(),
    windowOpen: vi.fn(() => ({ closed: false }) as any),
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
      remove: async (key: string) => mocks.sessionStore.delete(key),
    },
  },
  downloads: {
    search: mocks.searchDownload,
    onChanged: {
      addListener: (fn: (delta: any) => void) => mocks.downloadStateListeners.push(fn),
      removeListener: (fn: (delta: any) => void) => {
        const index = mocks.downloadStateListeners.indexOf(fn);
        if (index >= 0) mocks.downloadStateListeners.splice(index, 1);
      },
    },
  },
  runtime: { id: "test" },
} as any);
vi.stubGlobal("__BROWSER__", "chrome");

URL.createObjectURL = mocks.createObjectURL as any;
URL.revokeObjectURL = mocks.revokeObjectURL as any;
(window as any).open = mocks.windowOpen;

type DownloadHandler = (args: { data: any; sender?: chrome.runtime.MessageSender }) => Promise<any>;

async function loadDownloadModule(): Promise<DownloadHandler> {
  vi.resetModules();
  mocks.onMessage.mockClear();
  mocks.sendMessage.mockClear();
  mocks.logger.mockClear();
  mocks.getSiteInstance.mockReset();
  mocks.getRemoteTorrentFile.mockReset();
  mocks.history.clear();
  mocks.state.nextId = 0;
  mocks.sessionStore.clear();
  mocks.downloadStateListeners.length = 0;

  mocks.sendMessage.mockImplementation(async (name: string, payload: any) => {
    if (name === "getExtStoragePath") {
      if (payload?.path === "download") {
        return { ignoreSiteDownloadIntervalWhenLocalDownload: false };
      }
      return payload?.defaultValue;
    }
    if (name === "downloadFile") {
      return 4242;
    }
    return undefined;
  });

  await import("@/offscreen/utils/download.ts");
  const handler = mocks.onMessage.mock.calls.find(([name]) => name === "downloadTorrent")?.[1] as DownloadHandler;
  expect(handler, "downloadTorrent handler should be registered").toBeTypeOf("function");
  return handler;
}

let torrentSeq = 0;
function makeOption(torrentOverrides: Record<string, any> = {}, optionOverrides: Record<string, any> = {}) {
  return {
    torrent: {
      site: "testsite",
      id: `t${++torrentSeq}`,
      title: "title",
      link: "https://example.com/download/1",
      ...torrentOverrides,
    },
    downloaderId: "local",
    addTorrentOptions: {},
    ...optionOverrides,
  };
}

function makeSiteInstance(
  downloadInterval = 0,
  overrides: { requestConfig?: Record<string, any>; withDetailLink?: boolean } = {},
) {
  return {
    downloadInterval,
    userConfig: { uploadSpeedLimit: 0 },
    metadata: {
      detail: overrides.withDetailLink ? { selectors: { link: { selector: "a#dl", attr: "href" } } } : undefined,
    },
    isTrustedDownloadLink: vi.fn((url: string) => new URL(url, "https://example.com").hostname === "example.com"),
    getTorrentDownloadRequestConfig: vi.fn(async () => overrides.requestConfig ?? {}),
  };
}

describe("OS-1：下载历史不落明文请求配置", () => {
  beforeEach(() => {
    mocks.getSiteInstance.mockReset();
    mocks.windowOpen.mockReturnValue({ closed: false });
  });

  it("落库的 downloadRequestConfig 只有脱敏摘要（无 headers/params，query 值被打码）", async () => {
    const handler = await loadDownloadModule();
    mocks.getSiteInstance.mockResolvedValue(
      makeSiteInstance(0, {
        requestConfig: {
          url: "https://example.com/download.php?id=1&passkey=SECRET",
          method: "GET",
          headers: { Authorization: "Bearer SECRET", Cookie: "sid=SECRET" },
          params: { token: "SECRET" },
          timeout: 30000,
        },
      }),
    );

    // browser 方法避免 window.open/blob，直接走 chrome.downloads
    const result = await handler({ data: { ...makeOption(), localDownloadMethod: "browser" } });
    expect(result.downloadStatus).toBe("pending");

    const record = mocks.history.get(result.downloadId);
    expect(record).toBeTruthy();
    expect(record.downloadRequestConfig).toEqual({
      method: "GET",
      // axios.getUri 会把 params 拼进 URL，随后统一按 query 值脱敏；headers/params 本身不落库。
      url: "https://example.com/download.php?id=***&passkey=***&token=***",
      timeout: 30000,
    });
    expect(JSON.stringify(record)).not.toContain("SECRET");
    // 不保存调用方展开的额外字段（白名单生成）
    expect(record.allowSiteLessLink).toBeUndefined();
  });
});

describe("B1-4：延迟重下 payload 不携带可重新解析的凭据链接", () => {
  beforeEach(() => {
    mocks.getSiteInstance.mockReset();
    mocks.windowOpen.mockReturnValue({ closed: false });
  });

  it("站点声明了 detail.selectors.link 时，payload 丢弃 torrent.link 并剥离 localDownloadOption", async () => {
    const handler = await loadDownloadModule();
    mocks.getSiteInstance.mockResolvedValue(makeSiteInstance(60, { withDetailLink: true }));

    // 第一次下载消耗掉间隔（window.open 成功 → completed）
    await handler({ data: makeOption({ link: "https://example.com/download/1" }) });

    const second = await handler({
      data: makeOption(
        { link: "https://example.com/download.php?id=2&passkey=SECRET", url: "https://example.com/details.php?id=2" },
        { addTorrentOptions: { savePath: "/x", localDownloadOption: { url: "https://example.com/dl?token=SECRET" } } },
      ),
    });
    expect(second.downloadStatus).toBe("pending");

    const call = mocks.sendMessage.mock.calls.find(([name]) => name === "reDownloadTorrent");
    expect(call).toBeTruthy();
    const payload = call![1];
    expect(payload.torrent.link).toBeUndefined();
    expect(payload.torrent.url).toBe("https://example.com/details.php?id=2");
    expect(payload.addTorrentOptions.localDownloadOption).toBeUndefined();
    expect(payload.addTorrentOptions.savePath).toBe("/x");
    expect(payload.allowSiteLessLink).toBe(false);
    expect(payload.leftInterval).toBeGreaterThan(0);
  });

  it("站点没有 detail.selectors.link 时保留 torrent.link（否则重放必然失败）", async () => {
    const handler = await loadDownloadModule();
    mocks.getSiteInstance.mockResolvedValue(makeSiteInstance(60, { withDetailLink: false }));

    await handler({ data: makeOption({ link: "https://example.com/download/1" }) });
    await handler({ data: makeOption({ link: "https://example.com/download.php?id=2&passkey=SECRET" }) });

    const payload = mocks.sendMessage.mock.calls.find(([name]) => name === "reDownloadTorrent")![1];
    expect(payload.torrent.link).toBe("https://example.com/download.php?id=2&passkey=SECRET");
  });
});
