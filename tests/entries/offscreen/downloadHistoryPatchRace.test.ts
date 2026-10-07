/**
 * B-11 回归测试：`patchDownloadHistory` 的读改写竞态。
 *
 * 缺陷：`patchDownloadHistory` 是「读 IndexedDB → 合并 → 写回」，中间隔着跨上下文消息往返，
 * 窗口很宽；而调用方之间**存在未 await 的组合**——`download.ts:767` 存 `addTorrentResult` 是
 * fire-and-forget，紧接着 `setDownloadStatus` 写最终状态。两个并发的读改写会互相覆盖，
 * 后果是历史记录永久停在 `downloading`（最终状态丢失）或丢掉 `addTorrentResult`。
 *
 * 修复：按 `downloadId` 把调用串成链，后一个等前一个 settle 后**重新读取**再合并。
 *
 * 本文件用「带延迟的假 IndexedDB」放大竞态窗口——延迟是必要的，否则两次调用可能恰好
 * 顺序完成而掩盖缺陷。测试同时验证：链模式不改变单次调用的行为、前一次失败不阻塞后一次。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  /** 带延迟的内存 IndexedDB：延迟用于放大「读-改-写」的窗口。
   *  键类型是 number —— `TTorrentDownloadKey` 就是 number（types/common/download.ts:7）。 */
  const store = new Map<number, any>();
  const delay = () => new Promise((resolve) => setTimeout(resolve, 5));

  const db = {
    get: vi.fn(async (_table: string, key: number) => {
      await delay();
      return store.has(key) ? structuredClone(store.get(key)) : undefined;
    }),
    put: vi.fn(async (_table: string, value: any) => {
      await delay();
      store.set(value.id, structuredClone(value));
      return 1;
    }),
    delete: vi.fn(async () => undefined),
    clear: vi.fn(async () => undefined),
  };

  return {
    db,
    store,
    onMessage: vi.fn(),
    sendMessage: vi.fn(),
    logger: vi.fn(),
    getSiteInstance: vi.fn(),
    getDownloader: vi.fn(),
    getDownloaderMetaData: vi.fn(),
    releaseDownloaderInstance: vi.fn(),
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
  releaseDownloaderInstance: mocks.releaseDownloaderInstance,
}));
vi.mock("@ptd/downloader/utils.ts", () => ({ getRemoteTorrentFile: mocks.getRemoteTorrentFile }));

vi.stubGlobal("chrome", {
  storage: { session: { get: async () => ({}), set: async () => undefined, remove: async () => undefined } },
  downloads: { onChanged: { addListener: () => undefined, removeListener: () => undefined } },
  runtime: { id: "test" },
} as any);
vi.stubGlobal("__BROWSER__", "chrome");

async function loadModule() {
  vi.resetModules();
  mocks.store.clear();
  mocks.db.get.mockClear();
  mocks.db.put.mockClear();
  mocks.sendMessage.mockImplementation(async (_name: string, payload: any) => payload?.defaultValue);

  return await import("@/offscreen/utils/download.ts");
}

describe("B-11：下载历史读改写竞态", () => {
  beforeEach(() => {
    mocks.store.clear();
  });

  it("并发的两个 patch 都要保留（addTorrentResult 与最终状态不能互相覆盖）", async () => {
    const { patchDownloadHistory } = await loadModule();
    mocks.store.set(1, { id: 1, downloadStatus: "pending" });

    // 复刻真实次序：先 fire-and-forget 存 addTorrentResult，紧接着写最终状态
    const first = patchDownloadHistory(1, { addTorrentResult: { id: 7 } } as any);
    const second = patchDownloadHistory(1, { downloadStatus: "completed" });
    await Promise.all([first, second]);

    // 修复前：两次 get 都读到 pending 的旧值，后写者覆盖前写者 → 必丢一个字段
    expect(mocks.store.get(1)).toMatchObject({
      id: 1,
      downloadStatus: "completed",
      addTorrentResult: { id: 7 },
    });
  });

  it("错开到达的多个字段更新全部累积，不丢字段", async () => {
    const { patchDownloadHistory } = await loadModule();
    mocks.store.set(2, { id: 2, downloadStatus: "pending" });

    await Promise.all([
      patchDownloadHistory(2, { errorMessage: "e1" }),
      patchDownloadHistory(2, { downloadStatus: "failed" }),
      patchDownloadHistory(2, { addTorrentResult: { id: 9 } } as any),
      patchDownloadHistory(2, { downloadStatus: "completed" }),
    ]);

    const stored = mocks.store.get(2);
    expect(stored.errorMessage).toBe("e1");
    expect(stored.addTorrentResult).toEqual({ id: 9 });
    // 最后一个状态写入生效（串行化后次序 = 调用次序）
    expect(stored.downloadStatus).toBe("completed");
  });

  it("不同 downloadId 之间互不阻塞（链是按 key 的，不是全局的）", async () => {
    const { patchDownloadHistory } = await loadModule();
    mocks.store.set(11, { id: 11, downloadStatus: "pending" });
    mocks.store.set(12, { id: 12, downloadStatus: "pending" });

    await Promise.all([
      patchDownloadHistory(11, { downloadStatus: "completed" }),
      patchDownloadHistory(12, { downloadStatus: "failed" }),
    ]);

    expect(mocks.store.get(11).downloadStatus).toBe("completed");
    expect(mocks.store.get(12).downloadStatus).toBe("failed");
  });

  it("前一次失败不阻塞后一次（各自的失败由各自调用方处理）", async () => {
    const { patchDownloadHistory } = await loadModule();
    mocks.store.set(3, { id: 3, downloadStatus: "pending" });

    mocks.db.put.mockRejectedValueOnce(new Error("boom"));
    const failing = patchDownloadHistory(3, { errorMessage: "will fail" });
    const following = patchDownloadHistory(3, { downloadStatus: "completed" });

    await expect(failing).rejects.toThrow("boom");
    await expect(following).resolves.toBeUndefined();
    expect(mocks.store.get(3).downloadStatus).toBe("completed");
  });

  it("记录不存在时不写入（保持既有语义）", async () => {
    const { patchDownloadHistory } = await loadModule();

    await patchDownloadHistory(99, { downloadStatus: "completed" });

    expect(mocks.store.has(99)).toBe(false);
    expect(mocks.db.put).not.toHaveBeenCalled();
  });

  it("连续多次调用全部生效（链正确排空，不会因残留链头卡住）", async () => {
    const { patchDownloadHistory } = await loadModule();
    mocks.store.set(4, { id: 4, downloadStatus: "pending" });

    for (let i = 0; i < 20; i++) {
      await patchDownloadHistory(4, { errorMessage: `e${i}` });
    }

    expect(mocks.store.get(4).errorMessage).toBe("e19");
    // 链尾在排空后删除（实现里用 Map 按 downloadId 保存链尾），因此这里的 20 次串行调用
    // 每次都应恰好读一次、写一次——若链头泄漏或被复用，读次数会偏离。
    expect(mocks.db.get).toHaveBeenCalledTimes(20);
    expect(mocks.db.put).toHaveBeenCalledTimes(20);
  });
});
