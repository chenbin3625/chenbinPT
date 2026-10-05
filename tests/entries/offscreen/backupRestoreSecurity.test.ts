/**
 * 恢复备份的「写入侧」测试（见 S-1 与 L-10）。
 *
 * S-1：恢复流程不校验备份内容 ⇒ 一份他人分享的 zip 可以植入指向攻击者 WebDAV/S3/Gist 的
 * `metadata.backupServers`（`enabled: true` + `backupInterval` + 攻击者挑选的 `backupFields`），
 * 随后自动备份会把站点 passkey / Cookie / 下载器凭据自动上传过去。
 * 这里钉住写入侧的三条防线：默认不恢复 backupServers、不采信备份里的 backupFields、metadata 形状校验。
 *
 * L-10：跨多个 storage key 的恢复必须「先全部校验入内存 → 快照旧值 → 顺序写入 → 失败回滚」，
 * 不能出现「一半备份一半现状」。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toSerializable } from "@/shared/messagesSerializable.ts";

const mocks = vi.hoisted(() => {
  const store = new Map<string, unknown>();
  return {
    store,
    onMessage: vi.fn(),
    sendMessage: vi.fn(),
    logger: vi.fn(),
    replaceDownloadHistory: vi.fn(async () => true),
    /** 让第 N 次 setExtStorage 失败（模拟写入中途出错），用于验证回滚 */
    failSetForKey: null as string | null,
    setCalls: [] as Array<{ key: string; value: any }>,
  };
});

vi.mock("@/messages.ts", () => ({ onMessage: mocks.onMessage, sendMessage: mocks.sendMessage }));
vi.mock("@/offscreen/utils/logger.ts", () => ({ logger: mocks.logger }));
vi.mock("@/offscreen/adapter/indexdb.ts", () => ({
  ptdIndexDb: Promise.resolve({ transaction: () => ({}) }),
}));
vi.mock("@ptd/backupServer/utils.ts", () => ({
  backupDataToJSZipBlob: vi.fn(),
  getBackupFilename: vi.fn(() => "PTD_backup_20261004T0000.zip"),
  hasBackupRetentionToApply: vi.fn(() => false),
  isBackupFilename: vi.fn(() => false),
  pruneBackupFiles: vi.fn(() => [[]]),
  replaceDownloadHistory: mocks.replaceDownloadHistory,
}));
vi.mock("@ptd/backupServer", () => ({
  getBackupServer: vi.fn(),
  entityList: ["WebDAV", "S3", "Gist", "CookieCloud"],
}));

type RestoreHandler = (args: { data: { restoreData: any; restoreOptions: any } }) => Promise<boolean>;

async function loadBackupModule() {
  vi.resetModules();
  mocks.onMessage.mockClear();
  mocks.sendMessage.mockClear();
  mocks.logger.mockClear();
  mocks.setCalls.length = 0;
  mocks.failSetForKey = null;

  mocks.sendMessage.mockImplementation(async (name: string, payload: any) => {
    if (name === "getExtStorage") {
      const key = typeof payload === "string" ? payload : payload?.key;
      return structuredClone(mocks.store.get(key) ?? null);
    }
    if (name === "setExtStorage") {
      mocks.setCalls.push({ key: payload.key, value: structuredClone(payload.value) });
      if (mocks.failSetForKey === payload.key) {
        throw new Error(`failed to write ${payload.key}`);
      }
      mocks.store.set(payload.key, structuredClone(payload.value));
      return undefined;
    }
    return undefined;
  });

  const mod = await import("@/offscreen/utils/backup.ts");
  const handler = mocks.onMessage.mock.calls.find(([name]) => name === "restoreBackupData")?.[1] as RestoreHandler;
  expect(handler, "restoreBackupData handler should be registered").toBeTypeOf("function");
  return { handler: handler!, restoreBackupData: mod.restoreBackupData, storageKey: mod.storageKey };
}

/** 一条指向攻击者端点的备份服务器记录 */
function makeEvilServer(overrides: Record<string, any> = {}) {
  return {
    id: "evil",
    name: "evil",
    type: "WebDAV",
    enabled: true,
    backupInterval: 1,
    backupFields: ["cookies", "config", "userInfo"],
    config: { url: "https://evil.example/dav", username: "a", password: "b" },
    ...overrides,
  };
}

function makeBackup(metadata: Record<string, any>, files: string[] = ["metadata", "config"]) {
  return {
    metadata,
    config: { lang: "zh_CN" },
    manifest: { time: Date.now(), version: "test", files: Object.fromEntries(files.map((f) => [f, "hash"])) },
  };
}

const localServer = {
  id: "local-server",
  name: "my webdav",
  type: "WebDAV",
  enabled: true,
  backupInterval: 24,
  backupFields: ["config"],
  config: { url: "https://mine.example/dav", username: "me", password: "pw" },
};

describe("restoreBackupData：S-1 写入侧防护 + L-10 事务性", () => {
  beforeEach(() => {
    mocks.store.clear();
  });

  it("S-1：默认不恢复备份里的 backupServers，且保留本机已有服务器", async () => {
    const { handler } = await loadBackupModule();
    mocks.store.set("metadata", { sites: { mine: {} }, backupServers: { "local-server": localServer } });

    const report = (await handler({
      data: {
        restoreData: makeBackup({
          sites: { evilSite: {} },
          siteHostMap: { "evil.example": "evilSite" },
          backupServers: { evil: makeEvilServer() },
        }),
        restoreOptions: { fields: ["metadata"] },
      },
    })) as any;

    expect(report.success).toBe(true);
    expect(report.restored).toContain("metadata");

    const restoredMetadata = mocks.store.get("metadata") as any;
    expect(Object.keys(restoredMetadata.backupServers)).toEqual(["local-server"]);
    expect(restoredMetadata.backupServers.evil).toBeUndefined();
    expect(restoredMetadata.backupServers["local-server"].backupInterval).toBe(24);

    // 站点数据本身仍按用户选择恢复
    expect(restoredMetadata.sites).toEqual({ evilSite: {} });

    // 恢复 metadata 后必须重建 siteIndex（按安全化后的 metadata 派生）
    expect(mocks.store.get("siteIndex")).toEqual({
      siteHostMap: { "evil.example": "evilSite" },
      siteNameMap: {},
    });
  });

  it("S-1：显式 restoreBackupServers 时也不采信备份里的 backupFields（含凭据的字段一律剔除并停用自动备份）", async () => {
    const { handler } = await loadBackupModule();
    mocks.store.set("metadata", { sites: {}, backupServers: { "local-server": localServer } });

    const report = (await handler({
      data: {
        restoreData: makeBackup({
          sites: {},
          backupServers: { evil: makeEvilServer() },
        }),
        restoreOptions: { fields: ["metadata"], restoreBackupServers: true },
      },
    })) as any;

    expect(report.success).toBe(true);
    expect(report.sanitized.some((item: string) => item.includes("backupFields"))).toBe(true);

    const restored: any = (mocks.store.get("metadata") as any).backupServers.evil;
    expect(restored, "显式开启时才允许写入该条目").toBeTruthy();
    expect(restored.backupFields).toEqual([]);
    expect(restored.backupFields).not.toContain("cookies");
    expect(restored.backupFields).not.toContain("config");
    expect(restored.backupFields).not.toContain("userInfo");
    expect(restored.enabled, "没有可安全自动上传的字段时必须停用自动备份").toBe(false);
    expect(restored.backupInterval).toBeUndefined();

    // 本机服务器不受影响
    expect((mocks.store.get("metadata") as any).backupServers["local-server"].backupInterval).toBe(24);
  });

  it("S-1：显式恢复时，安全子集内的字段按「本次恢复的字段集合」求交集保留", async () => {
    const { handler } = await loadBackupModule();
    mocks.store.set("metadata", { sites: {}, backupServers: {} });

    await handler({
      data: {
        restoreData: makeBackup(
          {
            sites: {},
            backupServers: {
              mine: makeEvilServer({
                id: "mine",
                backupFields: ["searchResultSnapshot", "keepUploadTask", "cookies"],
                backupInterval: 24,
              }),
            },
          },
          ["metadata", "searchResultSnapshot"],
        ),
        restoreOptions: { fields: ["metadata", "searchResultSnapshot"], restoreBackupServers: true },
      },
    });

    const restored: any = (mocks.store.get("metadata") as any).backupServers.mine;
    // keepUploadTask 不在本次恢复的字段集合里 → 剔除；cookies 不在安全子集里 → 剔除
    expect(restored.backupFields).toEqual(["searchResultSnapshot"]);
    expect(restored.enabled).toBe(true);
    expect(restored.backupInterval).toBe(24);
  });

  it("S-1：按 type + config 去重复用本机 id（保留 issue #1024 的原有语义）", async () => {
    const { handler } = await loadBackupModule();
    mocks.store.set("metadata", { sites: {}, backupServers: { "local-server": localServer } });

    await handler({
      data: {
        restoreData: makeBackup(
          {
            sites: {},
            backupServers: {
              "another-random-id": makeEvilServer({ id: "another-random-id", config: localServer.config }),
            },
          },
          ["metadata", "searchResultSnapshot"],
        ),
        restoreOptions: { fields: ["metadata", "searchResultSnapshot"], restoreBackupServers: true },
      },
    });

    const servers: any = (mocks.store.get("metadata") as any).backupServers;
    expect(Object.keys(servers)).toEqual(["local-server"]);
  });

  it("S-1：未知 type 的服务器条目被丢弃，但不影响同一份 metadata 的其余内容", async () => {
    const { handler } = await loadBackupModule();
    mocks.store.set("metadata", { sites: {}, backupServers: {} });

    const report = (await handler({
      data: {
        restoreData: makeBackup({
          sites: { kept: {} },
          backupServers: { weird: makeEvilServer({ id: "weird", type: "NotRegistered" }) },
        }),
        restoreOptions: { fields: ["metadata"], restoreBackupServers: true },
      },
    })) as any;

    expect(report.success).toBe(true);
    expect(report.sanitized.some((item: string) => item.includes("NotRegistered"))).toBe(true);
    const restored: any = mocks.store.get("metadata");
    expect(restored.sites).toEqual({ kept: {} });
    expect(restored.backupServers.weird).toBeUndefined();
  });

  it("S-1：畸形 metadata（sites 不是对象）整份跳过，不抛异常，其它字段照常恢复", async () => {
    const { handler } = await loadBackupModule();
    mocks.store.set("metadata", { sites: { mine: {} }, backupServers: {} });
    mocks.store.set("config", { lang: "zh_CN" });

    const report = (await handler({
      data: {
        restoreData: makeBackup({ sites: "not-an-object" }, ["metadata", "config"]),
        restoreOptions: { fields: ["metadata", "config"] },
      },
    })) as any;

    expect(report.success, "跳过字段不是失败：其它字段仍然恢复").toBe(true);
    expect(report.skipped).toEqual([{ field: "metadata", reason: '"sites" must be an object, got string' }]);
    expect(report.restored).toEqual(["config"]);
    // metadata 未被写入（保持本机原值），config 正常恢复
    expect(mocks.store.get("metadata")).toEqual({ sites: { mine: {} }, backupServers: {} });
    expect(mocks.setCalls.some((call) => call.key === "metadata")).toBe(false);
    expect(mocks.store.get("config")).toEqual({ lang: "zh_CN" });
  });

  it("L-10：写入中途失败时回滚已写入的 key，不留下「一半备份一半现状」", async () => {
    const { handler } = await loadBackupModule();
    mocks.store.set("userInfo", { mteam: { "2026-10-01": { ratio: 1 } } });
    mocks.store.set("config", { lang: "zh_CN" });

    mocks.failSetForKey = "config"; // 最后一个 key 失败 → 前面的 userInfo 必须回滚

    const backup = {
      userInfo: { mteam: { "2026-10-09": { ratio: 9 } } },
      config: { lang: "en" },
      manifest: {
        time: Date.now(),
        version: "test",
        files: { userInfo: "h", config: "h" },
      },
    };

    const report = (await handler({
      data: { restoreData: backup, restoreOptions: { fields: ["userInfo", "config"] } },
    })) as any;

    expect(report.success, "写入失败必须报告失败").toBe(false);
    expect(report.rolledBack, "回滚成功必须在报告里体现").toBe(true);
    expect(mocks.store.get("userInfo"), "已写入的 key 必须回滚到快照").toEqual({
      mteam: { "2026-10-01": { ratio: 1 } },
    });
    expect(mocks.store.get("config")).toEqual({ lang: "zh_CN" });

    // 回滚也是一次真实的 setExtStorage 写入
    expect(mocks.setCalls.map((call) => call.key)).toEqual(["userInfo", "config", "userInfo"]);
  });

  it("L-10：全部校验通过时按顺序写入，success 为 true", async () => {
    const { handler } = await loadBackupModule();
    mocks.store.set("userInfo", {});
    mocks.store.set("config", { lang: "zh_CN" });

    const report = (await handler({
      data: {
        restoreData: {
          userInfo: { mteam: { "2026-10-09": { ratio: 9 } } },
          config: { lang: "en" },
          manifest: { time: Date.now(), version: "test", files: { userInfo: "h", config: "h" } },
        },
        restoreOptions: { fields: ["userInfo", "config"] },
      },
    })) as any;

    expect(report.success).toBe(true);
    expect(report.restored.sort()).toEqual(["config", "userInfo"]);
    expect(mocks.store.get("config")).toEqual({ lang: "en" });
    expect(mocks.store.get("userInfo")).toEqual({ mteam: { "2026-10-09": { ratio: 9 } } });
  });

  it("L-10：manifest 声明 cookies 但条目缺失时跳过 Cookie 恢复，不在 storage 写入后抛错", async () => {
    const { handler } = await loadBackupModule();
    mocks.store.set("config", { lang: "zh_CN" });

    const report = (await handler({
      data: {
        restoreData: {
          config: { lang: "en" },
          manifest: { time: Date.now(), version: "test", files: { config: "h", cookies: "h" } },
        },
        restoreOptions: { fields: ["config", "cookies"] },
      },
    })) as any;

    expect(report.success).toBe(true);
    expect(report.restored).toEqual(["config"]);
    expect(report.skipped).toEqual([{ field: "cookies", reason: "invalid data in backup, local cookies kept" }]);
    expect(mocks.store.get("config")).toEqual({ lang: "en" });
  });

  it("报告可以跨消息回传：toSerializable + JSON 往返后结构完整（UI 依赖它展示安全提示）", async () => {
    const { handler } = await loadBackupModule();
    mocks.store.set("metadata", { sites: {}, backupServers: { "local-server": localServer } });

    // RestoreDialog 走的是 handler（即真实的跨上下文消息路径），这里直接调用 handler 拿「实际返回值」
    const report = (await handler({
      data: {
        restoreData: makeBackup({
          sites: { kept: {} },
          siteHostMap: { "kept.example": "kept" },
          backupServers: { evil: makeEvilServer() },
        }),
        // 未显式确认 restoreBackupServers（默认 false）
        restoreOptions: { fields: ["metadata"] },
      },
    })) as any;

    // 消息层序列化（写类消息不重试，但返回值仍要跨上下文结构化克隆）
    const serialized = toSerializable(report);
    const roundTripped = JSON.parse(JSON.stringify(serialized));

    expect(roundTripped).toEqual({
      success: true,
      restored: ["metadata", "siteIndex"],
      skipped: [],
      sanitized: ["backupServers: 默认不恢复（丢弃备份中的 1 个服务器配置，保留本机的 1 个）"],
      rolledBack: false,
    });

    // 供报告引用：这是「含 backupServers 且未显式确认」时实际返回的 JSON
    console.log("IRestoreReport JSON =", JSON.stringify(roundTripped));
  });

  it("保持既有行为：下载历史非法时不清空本机历史（replaceDownloadHistory 返回 false 时只记跳过）", async () => {
    const { handler } = await loadBackupModule();
    mocks.replaceDownloadHistory.mockResolvedValueOnce(false);

    const report = (await handler({
      data: {
        restoreData: {
          downloadHistory: "not-an-array",
          manifest: { time: Date.now(), version: "test", files: { downloadHistory: "h" } },
        },
        restoreOptions: { fields: ["downloadHistory"] },
      },
    })) as any;

    expect(report.success).toBe(true);
    expect(report.skipped).toEqual([
      { field: "downloadHistory", reason: "invalid data in backup, local history kept" },
    ]);
    expect(mocks.replaceDownloadHistory).toHaveBeenCalledTimes(1);
    const logMessages = mocks.logger.mock.calls.map(([item]) => item.msg).join("\n");
    expect(logMessages).toContain("Skip restoring download history");
  });
});
