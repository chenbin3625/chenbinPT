/**
 * 下载队列并发回归测试（见 docs/performance-audit.md P1-22）。
 *
 * 缺陷：`downloadQueue`（concurrency 3）包住了整个 downloadTorrent，
 * 站点下载间隔未到的任务虽然只投递 `reDownloadTorrent` 就 return pending，
 * 但「站点实例化 + 间隔判断」期间仍然占用并发槽；3 个这样的任务就会堵满队列，
 * 真正要下载的任务被饿死。
 *
 * 修复：把生成下载历史 + 站点间隔判断/调度移到入队之前（prepareDownloadTorrent），
 * 站点请求配置与真正的下载动作仍留在队列内。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const db = {
    put: vi.fn(async () => 1),
    get: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    clear: vi.fn(async () => undefined),
  };
  return {
    db,
    onMessage: vi.fn(),
    sendMessage: vi.fn(),
    logger: vi.fn(),
    getSiteInstance: vi.fn(),
    getDownloader: vi.fn(),
    getDownloaderMetaData: vi.fn(),
    getRemoteTorrentFile: vi.fn(),
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

type DownloadHandler = (args: { data: any }) => Promise<any>;

async function loadDownloadModule(): Promise<{ handler: DownloadHandler }> {
  vi.resetModules();
  mocks.onMessage.mockClear();
  mocks.sendMessage.mockClear();
  mocks.logger.mockClear();
  mocks.getSiteInstance.mockReset();
  mocks.db.put.mockClear();
  mocks.db.get.mockClear();

  mocks.sendMessage.mockImplementation(async (name: string, payload: any) => {
    if (name === "getExtStoragePath") {
      if (payload?.path === "download") {
        return { ignoreSiteDownloadIntervalWhenLocalDownload: false };
      }
      return payload?.defaultValue;
    }
    return undefined;
  });

  await import("@/offscreen/utils/download.ts");
  const handler = mocks.onMessage.mock.calls.find(([name]) => name === "downloadTorrent")?.[1] as DownloadHandler;
  expect(handler, "downloadTorrent handler should be registered").toBeTypeOf("function");
  return { handler };
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

describe("offscreen 下载队列：等待站点间隔的任务不占用并发槽", () => {
  beforeEach(() => {
    // L-6 起 window.open 的返回值会被检查：offscreen 没有用户激活，被拦截时返回 null 并回退到 extension。
    // 这里的用例走的是 "web 方法成功打开" 路径，因此必须返回一个真值（模拟弹窗未被拦截）。
    (window as any).open = vi.fn(() => ({ closed: false }));
  });

  it("站点下载间隔未到时投递 reDownloadTorrent，payload 结构保持不变且返回 pending", async () => {
    const { handler } = await loadDownloadModule();
    mocks.getSiteInstance.mockResolvedValue(makeSiteInstance(60));

    let nextId = 0;
    mocks.db.put.mockImplementation(async () => ++nextId);

    const first = await handler({ data: makeOption({ link: "https://example.com/download/1" }) });
    expect(first.downloadStatus).toBe("completed");

    const secondOption = makeOption({ link: "https://example.com/download/2" });
    const second = await handler({ data: secondOption });
    expect(second.downloadStatus).toBe("pending");
    expect(second.downloadId).toBe(2);

    const reDownloadCall = mocks.sendMessage.mock.calls.find(([name]) => name === "reDownloadTorrent");
    expect(reDownloadCall).toBeTruthy();

    const payload = reDownloadCall![1];
    expect(payload).toMatchObject({
      downloadId: 2,
      downloaderId: "local",
      torrent: secondOption.torrent,
      addTorrentOptions: {},
    });
    expect(payload.leftInterval).toBeGreaterThan(0);
  });

  it("站点实例化耗时/等待间隔的任务不再堵住队列，其它站点仍能正常下载", async () => {
    const { handler } = await loadDownloadModule();

    let releaseSlow: () => void = () => {};
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });

    mocks.getSiteInstance.mockImplementation(async (siteId: string) => {
      if (siteId === "slow") {
        await slowGate;
        return makeSiteInstance();
      }
      return makeSiteInstance();
    });

    // 3 个站点实例化被挂起的任务（修复前它们会占满全部 3 个并发槽）
    const slowTasks = [1, 2, 3].map((index) =>
      handler({ data: makeOption({ site: "slow", link: `https://slow.example.com/${index}` }) }),
    );

    const fastResult = await Promise.race([
      handler({ data: makeOption({ site: "fast", link: "https://fast.example.com/1" }) }),
      new Promise((resolve) => setTimeout(() => resolve("timeout"), 500)),
    ]);

    expect(fastResult).toMatchObject({ downloadStatus: "completed" });

    releaseSlow();
    await Promise.all(slowTasks);
  });
});
