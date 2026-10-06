/**
 * offscreen 下载链路的三个回归测试：
 *
 * - **L-1**：站点下载间隔的时间戳必须持久化（`chrome.storage.session`），
 *   offscreen 被回收后不能绕过 `downloadInterval` 防轰炸保护；且**失败不消耗间隔**。
 * - **L-6**：`localDownloadMethod === "web"` 时 offscreen 里的 `window.open` 没有用户激活，
 *   弹窗被拦截会返回 `null`；必须检查返回值并回退到 extension 方法，而不是把拦截当成「已完成」。
 * - **L-5**：`URL.createObjectURL` 必须在下载读完（或失败）后释放，不能只在成功路径 revoke。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const history = new Map<number, any>();
  const db = {
    put: vi.fn(async (_store: string, _item: any) => 1),
    get: vi.fn(async (_store: string, id: number) => structuredClone(history.get(id))),
    delete: vi.fn(async () => undefined),
    clear: vi.fn(async () => undefined),
  };
  return {
    db,
    history,
    onMessage: vi.fn(),
    sendMessage: vi.fn(),
    logger: vi.fn(),
    getSiteInstance: vi.fn(),
    getDownloader: vi.fn(),
    getDownloaderMetaData: vi.fn(),
    getRemoteTorrentFile: vi.fn(),
    sessionStore: new Map<string, unknown>(),
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

type DownloadHandler = (args: { data: any }) => Promise<any>;

/** 每次调用都重新导入模块，用来模拟「offscreen 被回收后重建」（session storage 保留） */
async function loadDownloadModule(): Promise<DownloadHandler> {
  vi.resetModules();
  mocks.onMessage.mockClear();
  mocks.sendMessage.mockClear();
  mocks.logger.mockClear();
  mocks.getSiteInstance.mockReset();
  mocks.getRemoteTorrentFile.mockReset();
  mocks.db.put.mockClear();
  mocks.db.put.mockImplementation(async (_store: string, item: any) => {
    const id = item.id ?? ++nextDownloadId;
    mocks.history.set(id, structuredClone({ ...item, id }));
    return id;
  });

  mocks.sendMessage.mockImplementation(async (name: string, payload: any) => {
    if (name === "getExtStoragePath") {
      if (payload?.path === "download") {
        return { ignoreSiteDownloadIntervalWhenLocalDownload: false };
      }
      return payload?.defaultValue;
    }
    if (name === "downloadFile") {
      return payload?.__downloadId ?? 4242;
    }
    return undefined;
  });

  await import("@/offscreen/utils/download.ts");
  const handler = mocks.onMessage.mock.calls.find(([name]) => name === "downloadTorrent")?.[1] as DownloadHandler;
  expect(handler, "downloadTorrent handler should be registered").toBeTypeOf("function");
  return handler!;
}

let nextDownloadId = 1;

function makeOption(torrentOverrides: Record<string, any> = {}) {
  return {
    torrent: {
      site: "testsite",
      id: `t${nextDownloadId}`,
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
    isTrustedDownloadLink: vi.fn((url: string) => new URL(url, "https://example.com").hostname === "example.com"),
    getTorrentDownloadRequestConfig: vi.fn(async () => ({})),
  };
}

describe("offscreen 下载链路（L-1 / L-5 / L-6）", () => {
  beforeEach(() => {
    nextDownloadId = 1;
    mocks.sessionStore.clear();
    mocks.history.clear();
    mocks.downloadStateListeners.length = 0;
    mocks.searchDownload.mockReset();
    mocks.searchDownload.mockResolvedValue([{ state: "in_progress" }]);
    mocks.createObjectURL.mockClear();
    mocks.revokeObjectURL.mockClear();
    mocks.windowOpen.mockReset();
    mocks.windowOpen.mockReturnValue({ closed: false });
  });

  it("下载配置覆盖到异站 URL 时拒绝请求", async () => {
    const handler = await loadDownloadModule();
    const site = makeSiteInstance(0);
    site.getTorrentDownloadRequestConfig.mockResolvedValue({ url: "https://evil.example/collect" });
    mocks.getSiteInstance.mockResolvedValue(site);

    const result = await handler({ data: makeOption() });

    expect(result.downloadStatus).toBe("failed");
    expect(mocks.windowOpen).not.toHaveBeenCalled();
    expect(mocks.getRemoteTorrentFile).not.toHaveBeenCalled();
  });

  it("右键菜单传入未识别站点的 HTTP 链接时拒绝特权下载", async () => {
    const handler = await loadDownloadModule();
    const result = await handler({
      data: makeOption({ site: undefined, link: "http://127.0.0.1/private" }),
    });

    expect(result.downloadStatus).toBe("failed");
    expect(mocks.windowOpen).not.toHaveBeenCalled();
    expect(mocks.getRemoteTorrentFile).not.toHaveBeenCalled();
  });

  it("L-1：offscreen 重建后，站点下载间隔仍然生效（时间戳持久化到 session storage）", async () => {
    const handler = await loadDownloadModule();
    mocks.getSiteInstance.mockResolvedValue(makeSiteInstance(60));

    const first = await handler({ data: makeOption({ link: "https://example.com/download/1" }) });
    expect(first.downloadStatus).toBe("completed");

    // 模拟 offscreen 被回收：模块状态（含内存 Map）全部丢弃，但 chrome.storage.session 保留
    const reloadedHandler = await loadDownloadModule();
    mocks.getSiteInstance.mockResolvedValue(makeSiteInstance(60));
    const second = await reloadedHandler({ data: makeOption({ link: "https://example.com/download/2" }) });

    expect(second.downloadStatus, "重建后首次下载也不得绕过 downloadInterval").toBe("pending");
    const reDownloadCall = mocks.sendMessage.mock.calls.find(([name]) => name === "reDownloadTorrent");
    expect(reDownloadCall).toBeTruthy();
    expect(reDownloadCall![1].leftInterval).toBeGreaterThan(0);
  });

  it("L-1：下载失败不消耗站点下载间隔（预留的时间戳被回滚）", async () => {
    const handler = await loadDownloadModule();
    mocks.getSiteInstance.mockResolvedValue(makeSiteInstance(60));
    mocks.windowOpen.mockReturnValue(null as any); // web 方法被弹窗拦截 → 回退到 extension
    mocks.getRemoteTorrentFile.mockRejectedValueOnce(new Error("network down")); // 第一次真正失败
    mocks.getRemoteTorrentFile.mockResolvedValue({
      name: "1.torrent",
      metadata: { blob: () => new Blob(["x"]) },
    });

    const failed = await handler({ data: makeOption({ link: "https://example.com/download/1" }) });
    expect(failed.downloadStatus).toBe("failed");

    // 失败没有消耗间隔：紧接着的下载必须被真正执行，而不是被间隔挡住
    const second = await handler({ data: makeOption({ link: "https://example.com/download/2" }) });
    expect(second.downloadStatus, "失败的下载不应消耗站点下载间隔").toBe("pending");
  });

  it("L-6：window.open 被拦截（返回 null）时回退到 extension 方法，而不是标记 completed", async () => {
    const handler = await loadDownloadModule();
    mocks.getSiteInstance.mockResolvedValue(makeSiteInstance(0));
    mocks.windowOpen.mockReturnValue(null as any);
    mocks.getRemoteTorrentFile.mockResolvedValue({
      name: "1.torrent",
      metadata: { blob: () => new Blob(["x"]) },
    });

    const result = await handler({ data: makeOption({ link: "https://example.com/download/1" }) });

    expect(result.downloadStatus).toBe("pending");
    const downloadFileCall = mocks.sendMessage.mock.calls.find(([name]) => name === "downloadFile");
    expect(downloadFileCall, "被拦截时必须回退到 chrome.downloads 下载").toBeTruthy();
    expect(downloadFileCall![1].url).toBe("blob:test/torrent");
  });

  it("L-6：window.open 成功打开时直接返回 completed，且不再走 chrome.downloads", async () => {
    const handler = await loadDownloadModule();
    mocks.getSiteInstance.mockResolvedValue(makeSiteInstance(0));

    const result = await handler({ data: makeOption({ link: "https://example.com/download/1" }) });

    expect(result.downloadStatus).toBe("completed");
    expect(mocks.windowOpen).toHaveBeenCalledTimes(1);
    expect(mocks.sendMessage.mock.calls.some(([name]) => name === "downloadFile")).toBe(false);
  });

  it("L-5：blob URL 在下载进入终态后才释放（不在 downloadFile resolve 时立即释放）", async () => {
    const handler = await loadDownloadModule();
    mocks.getSiteInstance.mockResolvedValue(makeSiteInstance(0));
    mocks.windowOpen.mockReturnValue(null as any);
    mocks.getRemoteTorrentFile.mockResolvedValue({
      name: "1.torrent",
      metadata: { blob: () => new Blob(["x"]) },
    });

    await handler({ data: makeOption({ link: "https://example.com/download/1" }) });

    expect(mocks.createObjectURL).toHaveBeenCalledTimes(1);
    expect(mocks.revokeObjectURL, "downloads.download() resolve 只是「已接受」，不能立刻释放").not.toHaveBeenCalled();
    expect(mocks.downloadStateListeners).toHaveLength(1);

    // chrome.downloads 报告下载完成 → 此时才释放
    mocks.downloadStateListeners[0]!({ id: 4242, state: { current: "complete" } });
    expect(mocks.revokeObjectURL).toHaveBeenCalledWith("blob:test/torrent");
    expect(mocks.downloadStateListeners, "释放后应移除监听，避免监听器泄漏").toHaveLength(0);
  });

  it("browser 下载被接受后保持 pending，中断时标记 failed 并归还站点间隔", async () => {
    const handler = await loadDownloadModule();
    mocks.getSiteInstance.mockResolvedValue(makeSiteInstance(60));

    const result = await handler({ data: { ...makeOption(), localDownloadMethod: "browser" } });
    expect(result.downloadStatus).toBe("pending");
    expect(mocks.history.get(result.downloadId)?.downloadStatus).toBe("pending");

    mocks.downloadStateListeners[0]!({ id: 4242, state: { current: "interrupted" } });
    await vi.waitFor(() => expect(mocks.history.get(result.downloadId)?.downloadStatus).toBe("failed"));
    expect(mocks.sessionStore.get("ptd_siteDownloadAt")).toEqual({});
    expect(mocks.downloadStateListeners).toHaveLength(0);
  });

  it("extension 下载完成事件到达后才将历史标记 completed", async () => {
    const handler = await loadDownloadModule();
    mocks.getSiteInstance.mockResolvedValue(makeSiteInstance(0));
    mocks.windowOpen.mockReturnValue(null as any);
    mocks.getRemoteTorrentFile.mockResolvedValue({
      name: "1.torrent",
      metadata: { blob: () => new Blob(["x"]) },
    });

    const result = await handler({ data: makeOption() });
    expect(result.downloadStatus).toBe("pending");
    expect(mocks.history.get(result.downloadId)?.downloadStatus).toBe("pending");
    mocks.downloadStateListeners[0]!({ id: 4242, state: { current: "complete" } });

    await vi.waitFor(() => expect(mocks.history.get(result.downloadId)?.downloadStatus).toBe("completed"));
    expect(mocks.revokeObjectURL).toHaveBeenCalledWith("blob:test/torrent");
  });

  it("监听安装前就完成的下载也通过即时查询更新历史", async () => {
    const handler = await loadDownloadModule();
    mocks.getSiteInstance.mockResolvedValue(makeSiteInstance(0));
    mocks.searchDownload.mockResolvedValue([{ state: "complete" }]);

    const result = await handler({ data: { ...makeOption(), localDownloadMethod: "browser" } });

    await vi.waitFor(() => expect(mocks.history.get(result.downloadId)?.downloadStatus).toBe("completed"));
    expect(mocks.downloadStateListeners).toHaveLength(0);
  });

  it("L-5：下载未被接受（downloadFile 抛错）时立即释放 blob URL", async () => {
    const handler = await loadDownloadModule();
    mocks.getSiteInstance.mockResolvedValue(makeSiteInstance(0));
    mocks.windowOpen.mockReturnValue(null as any);
    mocks.getRemoteTorrentFile.mockResolvedValue({
      name: "1.torrent",
      metadata: { blob: () => new Blob(["x"]) },
    });
    mocks.sendMessage.mockImplementation(async (name: string, payload: any) => {
      if (name === "getExtStoragePath") {
        if (payload?.path === "download") {
          return { ignoreSiteDownloadIntervalWhenLocalDownload: false };
        }
        return payload?.defaultValue;
      }
      if (name === "downloadFile") {
        throw new Error("downloads.download rejected");
      }
      return undefined;
    });

    const result = await handler({ data: makeOption({ link: "https://example.com/download/1" }) });

    expect(result.downloadStatus).toBe("failed");
    expect(mocks.revokeObjectURL).toHaveBeenCalledWith("blob:test/torrent");
    expect(mocks.downloadStateListeners).toHaveLength(0);
  });
});
