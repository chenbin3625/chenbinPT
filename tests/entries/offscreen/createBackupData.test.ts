/**
 * TESTS-3：备份导出 / 自动上传的**写入侧**字段装配（H-1 所在链路）。
 *
 * tests/entries/offscreen/backupRestoreSecurity.test.ts 覆盖的是恢复侧（sanitize / 回滚），
 * 并把 @ptd/backupServer/utils 整体 mock 掉；而「哪些字段会被打包并上传到远端」由
 * src/entries/offscreen/utils/backup.ts 的 createBackupData 决定，此前零覆盖：
 * 放宽 storageKey 白名单、或让 backupFields 里的任意名字直接进 backupData，
 * 都不会让任何用例变红（恢复侧用例反而会给出「H-1 已守住」的错觉）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  onMessage: vi.fn(),
  sendMessage: vi.fn(),
  logger: vi.fn(),
  getAll: vi.fn(),
  getBackupServer: vi.fn(),
}));

vi.mock("@/messages.ts", () => ({ onMessage: mocks.onMessage, sendMessage: mocks.sendMessage }));
vi.mock("@/offscreen/utils/logger.ts", () => ({ logger: mocks.logger }));
// 只为了不把整条下载队列依赖拖进来（本文件不测 blob 释放）
vi.mock("@/offscreen/utils/download.ts", () => ({ releaseBlobUrlWhenDownloadSettled: vi.fn() }));
vi.mock("@/offscreen/adapter/indexdb.ts", () => ({ ptdIndexDb: Promise.resolve({ getAll: mocks.getAll }) }));
vi.mock("@ptd/backupServer/utils.ts", () => ({
  backupDataToJSZipBlob: vi.fn(),
  getBackupFilename: vi.fn(() => "PTD_backup_test.zip"),
  hasBackupRetentionToApply: vi.fn(() => false),
  isBackupFilename: vi.fn(() => false),
  pruneBackupFiles: vi.fn(() => [[]]),
  replaceDownloadHistory: vi.fn(),
}));
vi.mock("@ptd/backupServer", () => ({
  entityList: [],
  getBackupServer: mocks.getBackupServer,
  getBackupServerMetaData: vi.fn(),
}));

(globalThis as any).__EXT_VERSION__ ??= "test-version";

const storage = new Map<string, unknown>();

/** getAllCookies 的调用记录与并发峰值 */
let cookieCalls: string[] = [];
let cookieInFlight = 0;
let cookieMaxInFlight = 0;
/** 什么内容都不返回的 host（用来验证空 cookie 的站点不会被写进备份） */
let emptyCookieHosts = new Set<string>();

async function loadBackupModule() {
  vi.resetModules();
  storage.clear();
  cookieCalls = [];
  cookieInFlight = 0;
  cookieMaxInFlight = 0;
  emptyCookieHosts = new Set();
  mocks.sendMessage.mockReset();
  mocks.logger.mockReset();
  mocks.getAll.mockReset();

  mocks.sendMessage.mockImplementation(async (name: string, payload: any) => {
    if (name === "getExtStorage") {
      const key = typeof payload === "string" ? payload : payload?.key;
      return structuredClone(storage.get(key) ?? null);
    }
    if (name === "getExtStoragePath") {
      // createBackupData 只按 "metadata" + "siteHostMap" 取站点 host 列表
      const metadata = (storage.get("metadata") ?? {}) as any;
      return structuredClone(metadata[payload?.path] ?? payload?.defaultValue ?? null);
    }
    if (name === "getAllCookies") {
      cookieCalls.push(payload.domain);
      cookieInFlight++;
      cookieMaxInFlight = Math.max(cookieMaxInFlight, cookieInFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      cookieInFlight--;
      return emptyCookieHosts.has(payload.domain)
        ? []
        : [{ name: `${payload.domain}-session`, value: "SECRET", domain: payload.domain }];
    }
    return undefined;
  });

  return await import("@/offscreen/utils/backup.ts");
}

describe("createBackupData：只打包被点名且在白名单内的字段（TESTS-3 / H-1 写入侧）", () => {
  beforeEach(() => {
    storage.clear();
  });

  it('backupFields=["config"] 时只打包 config，其余 storage key 一律不读', async () => {
    const { createBackupData } = await loadBackupModule();
    storage.set("config", { lang: "zh_CN" });
    storage.set("metadata", { sites: { evil: {} } });
    storage.set("userInfo", { mteam: { "2026-10-01": { ratio: 1 } } });

    const backupData = await createBackupData(["config"]);

    expect(Object.keys(backupData).sort()).toEqual(["config", "manifest"]);
    expect(backupData.config).toEqual({ lang: "zh_CN" });
    expect(backupData.metadata).toBeUndefined();
    expect(backupData.userInfo).toBeUndefined();

    // 只对 config 发生了一次读取，没有「顺手把整份 storage 打包」
    expect(mocks.sendMessage.mock.calls.filter(([name]) => name === "getExtStorage").map(([, key]) => key)).toEqual([
      "config",
    ]);
    expect(mocks.sendMessage.mock.calls.some(([name]) => name === "getAllCookies")).toBe(false);
    expect(mocks.getAll).not.toHaveBeenCalled();
    expect(backupData.manifest!.version).toContain("test-version");
  });

  it("storageKey 白名单之外的字段名（含 __proto__）不会成为备份字段", async () => {
    const { createBackupData, storageKey } = await loadBackupModule();
    storage.set("metadata", { sites: {} });

    const backupData = await createBackupData(["metadata", "__proto__", "constructor", "notAStorageKey"] as any);

    expect(Object.keys(backupData).sort()).toEqual(["manifest", "metadata"]);
    // 原型没有被污染（`backupData[field] = ...` 只对 storageKey 里的字段执行）
    expect(({} as any).sites).toBeUndefined();
    expect(Object.getPrototypeOf(backupData)).toBe(Object.prototype);
    // 白名单本身必须仍是显式声明的 storage key 列表
    expect(storageKey).toContain("config");
    expect(storageKey).toContain("searchResultSnapshot");
    expect(storageKey).toContain("keepUploadTask");
  });

  it("backupFields 为空（或不传）时只产出 manifest", async () => {
    const { createBackupData } = await loadBackupModule();
    storage.set("config", { lang: "zh_CN" });

    expect(Object.keys(await createBackupData([])).sort()).toEqual(["manifest"]);
    expect(Object.keys(await createBackupData()).sort()).toEqual(["manifest"]);
    expect(mocks.sendMessage.mock.calls.some(([name]) => name === "getExtStorage")).toBe(false);
  });

  it("搜索快照 / 辅种任务只有被点名时才读取（与恢复侧的白名单判定一致）", async () => {
    const { createBackupData } = await loadBackupModule();
    storage.set("searchResultSnapshot", { s1: { keyword: "a" } });
    storage.set("keepUploadTask", { t1: {} });

    const backupData = await createBackupData(["searchResultSnapshot"] as any);

    expect(Object.keys(backupData).sort()).toEqual(["manifest", "searchResultSnapshot"]);
    expect(backupData.keepUploadTask).toBeUndefined();
    expect(mocks.sendMessage.mock.calls.filter(([name]) => name === "getExtStorage").map(([, key]) => key)).toEqual([
      "searchResultSnapshot",
    ]);
  });

  it("cookies：按 siteHostMap 有界并发抓取，空 cookie 的站点不写入，且不整份拷贝 storage", async () => {
    const { createBackupData } = await loadBackupModule();
    const siteHostMap: Record<string, string> = {};
    for (let i = 0; i < 7; i++) siteHostMap[`host${i}.example`] = `site${i}`;
    storage.set("metadata", { sites: {}, siteHostMap });
    emptyCookieHosts.add("host3.example");

    const backupData = await createBackupData(["cookies"]);

    expect(Object.keys(backupData).sort()).toEqual(["cookies", "manifest"]);
    expect(cookieCalls.sort()).toEqual(Object.keys(siteHostMap).sort());
    expect(cookieMaxInFlight).toBeGreaterThan(1); // 确实是并发，不是串行
    expect(cookieMaxInFlight).toBeLessThanOrEqual(5); // 但有界（COOKIE_CONCURRENCY）
    expect(Object.keys(backupData.cookies!)).toHaveLength(6);
    expect(backupData.cookies!["host3.example"]).toBeUndefined();
    expect(backupData.cookies!["host0.example"]![0]!.value).toBe("SECRET");
    // metadata 本身没有被当成备份字段打包（只用了它的 siteHostMap）
    expect(backupData.metadata).toBeUndefined();
  });

  it("downloadHistory 只在被点名时读 IndexedDB", async () => {
    const { createBackupData } = await loadBackupModule();
    storage.set("config", { lang: "zh_CN" });
    mocks.getAll.mockResolvedValue([{ id: 1, title: "t" }]);

    const without = await createBackupData(["config"]);
    expect(without.downloadHistory).toBeUndefined();
    expect(mocks.getAll).not.toHaveBeenCalled();

    const withHistory = await createBackupData(["downloadHistory"] as any);
    expect(withHistory.downloadHistory).toEqual([{ id: 1, title: "t" }]);
    expect(mocks.getAll).toHaveBeenCalledWith("download_history");
  });
});

describe("exportBackupData：自动备份链路的字段装配不被放宽（TESTS-3）", () => {
  beforeEach(() => {
    storage.clear();
  });

  it("远端备份只上传调用方点名的字段（服务器配置里的 backupFields 不能顺带多传）", async () => {
    const { exportBackupData } = await loadBackupModule();
    storage.set("metadata", { backupServers: { srv: { id: "srv", type: "WebDAV", enabled: true } } });
    storage.set("config", { lang: "zh_CN", backup: { encryptionKey: "k" } });
    storage.set("userInfo", { mteam: { "2026-10-01": { ratio: 1 } } });
    storage.set("searchResultSnapshot", { s1: {} });

    // 显式声明参数：`mock.calls[0]` 的元组类型才会带上 (filename, backupData)，
    // 否则解构 `const [, uploaded] = ...` 取不到第二个元素（TS2493 / TS2352）。
    const addFile = vi.fn(async (_filename: string, _backupData: Record<string, unknown>) => true);
    mocks.getBackupServer.mockResolvedValue({ setEncryptionKey: vi.fn(), addFile });

    await expect(exportBackupData("srv", ["config"])).resolves.toBe(true);

    expect(addFile).toHaveBeenCalledTimes(1);
    const [, uploaded] = addFile.mock.calls[0]!;
    expect(Object.keys(uploaded as object).sort()).toEqual(["config", "manifest"]);
    expect((uploaded as any).userInfo).toBeUndefined();
    expect((uploaded as any).searchResultSnapshot).toBeUndefined();
    // lastBackupAt 走 SW 内的路径写（不是整份 metadata 回写）
    expect(mocks.sendMessage).toHaveBeenCalledWith("patchExtStoragePath", {
      key: "metadata",
      path: ["backupServers", "srv", "lastBackupAt"],
      value: expect.any(Number),
    });
  });
});
