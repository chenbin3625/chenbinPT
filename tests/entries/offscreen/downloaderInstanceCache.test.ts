/**
 * B1-2：下载器实例并发首次访问必须 in-flight 去重。
 *
 * 修复前：两个并发消息都读到缓存为空、都 `await getDownloader()`；库级缓存只在构造后写入，
 * 于是会各构造一个实例（Aria2 构造函数立即建 WebSocket），后写入者覆盖缓存，
 * 先构造的实例既不在缓存也不会被 `releaseDownloaderInstance` 释放。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  let instanceSeq = 0;
  return {
    nextInstance: () => ({ tag: `instance-${++instanceSeq}` }),
    resetInstanceSeq: () => {
      instanceSeq = 0;
    },
    onMessage: vi.fn(),
    sendMessage: vi.fn(),
    logger: vi.fn(),
    getDownloader: vi.fn(),
    getDownloaderMetaData: vi.fn(),
    releaseDownloaderInstance: vi.fn(),
    downloaders: {} as Record<string, any>,
  };
});

vi.mock("@/messages.ts", () => ({ onMessage: mocks.onMessage, sendMessage: mocks.sendMessage }));
vi.mock("@/offscreen/utils/logger.ts", () => ({ logger: mocks.logger }));
vi.mock("@/offscreen/utils/site.ts", () => ({ getSiteInstance: vi.fn() }));
vi.mock("@/offscreen/adapter/indexdb.ts", () => ({ ptdIndexDb: Promise.resolve({}) }));
vi.mock("@ptd/downloader", () => ({
  getDownloader: mocks.getDownloader,
  getDownloaderMetaData: mocks.getDownloaderMetaData,
  releaseDownloaderInstance: mocks.releaseDownloaderInstance,
}));
vi.mock("@ptd/downloader/utils.ts", () => ({ getRemoteTorrentFile: vi.fn() }));

vi.stubGlobal("chrome", { runtime: { id: "test" } } as any);
vi.stubGlobal("__BROWSER__", "chrome");

async function loadDownloadModule() {
  vi.resetModules();
  mocks.onMessage.mockClear();
  mocks.sendMessage.mockClear();
  mocks.logger.mockClear();
  mocks.getDownloader.mockReset();
  mocks.releaseDownloaderInstance.mockReset();
  mocks.downloaders = {};
  mocks.resetInstanceSeq();

  mocks.sendMessage.mockImplementation(async (name: string, payload: any) => {
    if (name === "getExtStoragePath" && Array.isArray(payload?.path) && payload.path[0] === "downloaders") {
      return mocks.downloaders[payload.path[1]] ?? {};
    }
    return payload?.defaultValue;
  });

  return await import("@/offscreen/utils/download.ts");
}

function makeSlowDownloaderFactory() {
  // 模拟 getDownloaderModule 的动态 import：两个并发调用都会先拿到同一个未完成 promise，
  // 之后再各自构造实例（正是修复前会泄漏实例的时序）。
  return vi.fn(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    return mocks.nextInstance();
  });
}

describe("B1-2：下载器实例并发创建去重", () => {
  beforeEach(() => {
    mocks.downloaders = {};
  });

  it("两个并发首次访问同一下载器只构造一个实例，且两次拿到同一个对象", async () => {
    const { getDownloaderInstance } = await loadDownloadModule();
    mocks.downloaders.d1 = { id: "d1", type: "Aria2", address: "http://127.0.0.1:6800" };
    mocks.getDownloader.mockImplementation(makeSlowDownloaderFactory());

    const [first, second] = await Promise.all([getDownloaderInstance("d1"), getDownloaderInstance("d1")]);

    expect(mocks.getDownloader).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
    expect(mocks.releaseDownloaderInstance).not.toHaveBeenCalled();
  });

  it("未命中缓存时仍按配置变化重建并释放旧实例（OFFSCREEN-7 不回归）", async () => {
    const { getDownloaderInstance } = await loadDownloadModule();
    mocks.downloaders.d1 = { id: "d1", type: "Aria2", address: "http://127.0.0.1:6800" };
    mocks.getDownloader.mockImplementation(async () => mocks.nextInstance());

    const first = await getDownloaderInstance("d1");
    await getDownloaderInstance("d1");
    expect(mocks.getDownloader, "同配置命中 offscreen 缓存").toHaveBeenCalledTimes(1);

    mocks.downloaders.d1 = { ...mocks.downloaders.d1, address: "http://127.0.0.1:6801" };
    const second = await getDownloaderInstance("d1");

    expect(second).not.toBe(first);
    expect(mocks.getDownloader).toHaveBeenCalledTimes(2);
    expect(mocks.releaseDownloaderInstance).toHaveBeenCalledWith(first);
  });

  it("in-flight 创建失败后不留下毒化的 Promise（下次调用会重试）", async () => {
    const { getDownloaderInstance } = await loadDownloadModule();
    mocks.downloaders.d1 = { id: "d1", type: "Aria2", address: "http://127.0.0.1:6800" };
    mocks.getDownloader.mockRejectedValueOnce(new Error("boom")).mockImplementation(async () => mocks.nextInstance());

    await expect(getDownloaderInstance("d1")).rejects.toThrow("boom");
    const retried = await getDownloaderInstance("d1");
    expect(retried).toMatchObject({ tag: "instance-1" });
  });
});
