/**
 * offscreen-cross 包（第三轮审查第二波）的回归测试：
 *
 * - **DOWNLOADER-8**：下载器「成功但降级」（uTorrent 直发 http 链接拿不到 infoHash →
 *   暂停/标签/上传限速被跳过）时，`downloadTorrentToRemote` 只写普通日志，用户永远看不到。
 *   修复后降级为 `warn` 并把 message 通过返回值/下载历史的 **warningMessage** 字段透出，
 *   同时 `downloadStatus` 仍为 completed（第五波起不再借用 errorMessage，避免 UI 渲染成失败）。
 * - **OPTIONSSETTINGS-6**：`restoreBackupData` 在「一个 key 都没写成」时无条件 `success = true`，
 *   UI 即便封住零勾选，字段与备份无交集/字段值为空时仍会提示「恢复成功」。
 * - **TESTS 门禁红灯**：`createBackupData.test.ts` 的 `addFile` mock 元组长度问题在
 *   `tests/entries/offscreen/createBackupData.test.ts` 内修复，由该文件自身与 `vue-tsc` 覆盖。
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
    transaction: vi.fn(() => ({})),
    getAll: vi.fn(async () => []),
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
    replaceDownloadHistory: vi.fn(async () => true),
    downloaders: {} as Record<string, any>,
    storageStore: new Map<string, unknown>(),
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
vi.mock("@ptd/backupServer/utils.ts", () => ({
  backupDataToJSZipBlob: vi.fn(),
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

vi.stubGlobal("chrome", {
  storage: {
    session: {
      get: async (key: string) => (mocks.storageStore.has(key) ? { [key]: mocks.storageStore.get(key) } : {}),
      set: async (items: Record<string, unknown>) => {
        for (const [key, value] of Object.entries(items)) mocks.storageStore.set(key, structuredClone(value));
      },
      remove: async (key: string) => mocks.storageStore.delete(key),
    },
  },
  downloads: { search: vi.fn(async () => []), onChanged: { addListener: vi.fn(), removeListener: vi.fn() } },
  runtime: { id: "test" },
} as any);
// 显式赋值而不是 `??=`：避免同名全局（同一 worker 内其它文件留下的值）让本文件的启动版本不确定。
(globalThis as any).__EXT_VERSION__ = "test-version";

function resetDb() {
  mocks.store.clear();
  mocks.state.nextId = 0;
  mocks.db.put.mockClear();
  mocks.db.get.mockClear();
}

function makeSiteInstance(downloadInterval = 0) {
  return {
    downloadInterval,
    userConfig: { uploadSpeedLimit: 0 },
    isTrustedDownloadLink: vi.fn(() => true),
    getTorrentDownloadRequestConfig: vi.fn(async () => ({})),
  };
}

type DownloadHandler = (args: { data: any }) => Promise<any>;

async function loadDownloadModule(): Promise<DownloadHandler> {
  vi.resetModules();
  resetDb();
  mocks.onMessage.mockClear();
  mocks.sendMessage.mockClear();
  mocks.logger.mockClear();
  mocks.getSiteInstance.mockReset();
  mocks.getDownloader.mockReset();
  // 被测模块（offscreen/utils/download.ts）会用到的其余 mock 也必须逐用例复位：
  // 它们都是 hoisted 的模块级 vi.fn()，`vi.resetModules()` 不会清理它们的调用记录/返回值/once 队列，
  // 任何一个用例给过它们实现，后面的用例都会带着这份状态跑。
  mocks.getDownloaderMetaData.mockReset();
  mocks.releaseDownloaderInstance.mockReset();
  mocks.getRemoteTorrentFile.mockReset();
  mocks.replaceDownloadHistory.mockReset();
  mocks.replaceDownloadHistory.mockResolvedValue(true);
  mocks.storageStore.clear();
  mocks.downloaders = {};

  mocks.sendMessage.mockImplementation(async (name: string, payload: any) => {
    if (name === "getExtStoragePath") {
      if (payload?.path === "download.saveDownloadHistory") return true;
      if (payload?.path === "download") return {};
      if (Array.isArray(payload?.path) && payload.path[0] === "downloaders") {
        return mocks.downloaders[payload.path[1]] ?? {};
      }
      return payload?.defaultValue;
    }
    return undefined;
  });

  await import("@/offscreen/utils/download.ts");
  const handler = mocks.onMessage.mock.calls.find(([name]) => name === "downloadTorrent")?.[1] as DownloadHandler;
  expect(handler, "downloadTorrent handler should be registered").toBeTypeOf("function");
  return handler;
}

type RestoreHandler = (args: { data: { restoreData: any; restoreOptions: any } }) => Promise<any>;

async function loadBackupModule(): Promise<RestoreHandler> {
  vi.resetModules();
  resetDb();
  mocks.onMessage.mockClear();
  mocks.sendMessage.mockClear();
  mocks.logger.mockClear();
  mocks.storageStore.clear();
  // 与 loadDownloadModule 同理：hoisted 的模块级 vi.fn() 必须逐用例复位，
  // 否则前一个 describe 设过的 mockResolvedValue/mockImplementation 会被后面的用例继承。
  mocks.getSiteInstance.mockReset();
  mocks.getDownloader.mockReset();
  mocks.getDownloaderMetaData.mockReset();
  mocks.releaseDownloaderInstance.mockReset();
  mocks.getRemoteTorrentFile.mockReset();
  mocks.replaceDownloadHistory.mockReset();
  mocks.replaceDownloadHistory.mockResolvedValue(true);

  mocks.sendMessage.mockImplementation(async (name: string, payload: any) => {
    if (name === "getExtStorage") {
      const key = typeof payload === "string" ? payload : payload?.key;
      return structuredClone(mocks.storageStore.get(key) ?? null);
    }
    if (name === "setExtStorage") {
      mocks.storageStore.set(payload.key, structuredClone(payload.value));
      return undefined;
    }
    if (name === "getExtStoragePath") {
      const metadata = (mocks.storageStore.get("metadata") ?? {}) as any;
      return structuredClone(metadata[payload?.path] ?? payload?.defaultValue ?? null);
    }
    return undefined;
  });

  await import("@/offscreen/utils/backup.ts");
  const handler = mocks.onMessage.mock.calls.find(([name]) => name === "restoreBackupData")?.[1] as RestoreHandler;
  expect(handler, "restoreBackupData handler should be registered").toBeTypeOf("function");
  return handler;
}

function makeBackup(files: string[], data: Record<string, any> = {}) {
  return {
    ...data,
    manifest: { time: Date.now(), version: "test", files: Object.fromEntries(files.map((f) => [f, "hash"])) },
  };
}

describe("DOWNLOADER-8：下载器「成功但降级」的告警必须透出（offscreen 侧收口）", () => {
  beforeEach(() => {
    resetDb();
    mocks.downloaders = {};
  });

  function makeRemoteOption() {
    return {
      torrent: { site: "testsite", id: "t1", title: "title", link: "https://example.com/download/1" },
      downloaderId: "d1",
      addTorrentOptions: {},
    };
  }

  it("success=true 但 message 非空时：downloadStatus 仍为 completed，message 以 warn 日志 + warningMessage 透出", async () => {
    const handler = await loadDownloadModule();
    mocks.downloaders.d1 = { id: "d1", type: "uTorrent", address: "http://127.0.0.1:8080", enabled: true };
    mocks.getSiteInstance.mockResolvedValue(makeSiteInstance(0));
    const warning =
      "uTorrent add-url 未返回 infoHash，添加后暂停 / 标签 / 上传限速设置未生效（可改用「本地中转」推送以避免）";
    mocks.getDownloader.mockResolvedValue({
      addTorrent: vi.fn(async () => ({ success: true, message: warning })),
    });

    const result = await handler({ data: makeRemoteOption() });

    // 成功语义不变
    expect(result.downloadStatus).toBe("completed");
    // 但降级信息必须透出给调用方，且必须落在**告警**字段上
    expect(result.warningMessage).toContain("infoHash");
    // 判别力：若把告警写回 errorMessage（修复前行为），下面两条会红 —— UI 会把成功记录渲染成红色「失败原因」
    expect(result.errorMessage, "告警不能混进失败原因字段").toBeUndefined();

    // 必须是 warn 级别的留痕，而不是普通日志
    const warnCall = mocks.logger.mock.calls
      .map(([item]) => item as any)
      .find((item) => item.level === "warn" && String(item.msg).includes("with warnings"));
    expect(warnCall, "降级必须记 warn 级日志").toBeTruthy();
    expect(warnCall.data.message).toContain("infoHash");

    // 下载历史同时留痕，用户在下载历史列表/详情里能看到
    const record = mocks.store.get(result.downloadId);
    expect(record.downloadStatus).toBe("completed");
    expect(record.warningMessage).toContain("infoHash");
    expect(record.errorMessage, "告警不能混进失败原因字段").toBeUndefined();
  });

  it("success=true 且没有 message 时保持原样（无 warn、无告警）", async () => {
    const handler = await loadDownloadModule();
    mocks.downloaders.d1 = { id: "d1", type: "qBittorrent", address: "http://127.0.0.1:8080", enabled: true };
    mocks.getSiteInstance.mockResolvedValue(makeSiteInstance(0));
    mocks.getDownloader.mockResolvedValue({ addTorrent: vi.fn(async () => ({ success: true })) });

    const result = await handler({ data: makeRemoteOption() });

    expect(result.downloadStatus).toBe("completed");
    expect(result.errorMessage).toBeUndefined();
    expect(result.warningMessage).toBeUndefined();
    const logs = mocks.logger.mock.calls.map(([item]) => item as any);
    expect(logs.some((item) => item.level === "warn" && String(item.msg).includes("with warnings"))).toBe(false);
    expect(logs.some((item) => item.msg === "Successfully added torrent to downloader")).toBe(true);
    expect(mocks.store.get(result.downloadId).errorMessage).toBeUndefined();
    expect(mocks.store.get(result.downloadId).warningMessage).toBeUndefined();
  });

  it("success=false 时仍按失败处理（message 是失败原因）", async () => {
    const handler = await loadDownloadModule();
    mocks.downloaders.d1 = { id: "d1", type: "qBittorrent", address: "http://127.0.0.1:8080", enabled: true };
    mocks.getSiteInstance.mockResolvedValue(makeSiteInstance(0));
    mocks.getDownloader.mockResolvedValue({ addTorrent: vi.fn(async () => ({ success: false, message: "rejected" })) });

    const result = await handler({ data: makeRemoteOption() });

    expect(result.downloadStatus).toBe("failed");
    expect(result.errorMessage).toBe("rejected");
  });
});

describe("OPTIONSSETTINGS-6：restoreBackupData 在什么都没写成时不得声称成功（offscreen 纵深防御）", () => {
  beforeEach(() => {
    mocks.storageStore.clear();
    resetDb();
  });

  it("所选字段与备份 manifest 没有交集（零勾选/未知字段）时 success=false 并给出 skipped 原因", async () => {
    const handler = await loadBackupModule();
    mocks.storageStore.set("config", { lang: "zh_CN" });

    const report = await handler({
      data: {
        // 备份里只有 config，但调用方点名恢复 userInfo
        restoreData: makeBackup(["config"], { config: { lang: "en" } }),
        restoreOptions: { fields: ["userInfo"] },
      },
    });

    expect(report.success, "一个 key 都没写时不能提示恢复成功").toBe(false);
    expect(report.restored).toEqual([]);
    expect(report.skipped.some((item: any) => item.field === "restore")).toBe(true);
    // 本机 config 未被改动（调用方没勾选它）
    expect(mocks.storageStore.get("config")).toEqual({ lang: "zh_CN" });
  });

  it("勾了字段但备份里该字段为空时同样 success=false（不虚报成功）", async () => {
    const handler = await loadBackupModule();

    const report = await handler({
      data: {
        // manifest 声明了 metadata，但没有实际内容 → 阶段 1 记为 empty value，pendingWrites 为空
        restoreData: makeBackup(["metadata"]),
        restoreOptions: { fields: ["metadata"] },
      },
    });

    expect(report.success).toBe(false);
    expect(report.restored).toEqual([]);
    expect(
      report.skipped.some((item: any) => item.field === "metadata" && item.reason === "empty value in backup"),
    ).toBe(true);
    expect(report.skipped.some((item: any) => item.field === "restore")).toBe(true);
  });

  it("兼容既有语义：仅请求 downloadHistory 但数据非法时仍是 success=true（跳过不算失败）", async () => {
    const handler = await loadBackupModule();
    mocks.replaceDownloadHistory.mockResolvedValueOnce(false);

    const report = await handler({
      data: {
        restoreData: {
          downloadHistory: "not-an-array",
          manifest: { time: 1, version: "t", files: { downloadHistory: "h" } },
        },
        restoreOptions: { fields: ["downloadHistory"] },
      },
    });

    expect(report.success).toBe(true);
    expect(report.restored).toEqual([]);
    expect(report.skipped).toEqual([
      { field: "downloadHistory", reason: "invalid data in backup, local history kept" },
    ]);
  });

  it("仅请求 cookies 但备份为空时 success=false，不能把零写入报告为整体成功", async () => {
    const handler = await loadBackupModule();
    mocks.storageStore.set("metadata", { siteHostMap: {} });

    const report = await handler({
      data: {
        restoreData: makeBackup(["cookies"], { cookies: {} }),
        restoreOptions: { fields: ["cookies"] },
      },
    });

    expect(report.success).toBe(false);
    expect(report.restored).not.toContain("cookies");
    expect(report.skipped).toEqual([{ field: "cookies", reason: "部分 cookie 未恢复：备份里没有 cookie 条目" }]);
  });

  it("正常恢复仍然 success=true 且 restored 有值（没有把成功路径改坏）", async () => {
    const handler = await loadBackupModule();
    mocks.storageStore.set("config", { lang: "zh_CN" });

    const report = await handler({
      data: {
        restoreData: makeBackup(["config"], { config: { lang: "en" } }),
        restoreOptions: { fields: ["config"] },
      },
    });

    expect(report.success).toBe(true);
    expect(report.restored).toEqual(["config"]);
    expect(mocks.storageStore.get("config")).toEqual({ lang: "en" });
  });
});
