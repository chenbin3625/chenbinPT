/**
 * offscreen-b 包（OFFSCREEN-2 / OFFSCREEN-4 / OFFSCREEN-5 / OFFSCREEN-8）的行为回归测试。
 *
 * - OFFSCREEN-2：站点刷新失败时不再把失败载荷整份覆盖进 metadata.lastUserInfo（成功快照被清空）；
 * - OFFSCREEN-4：恢复备份的 cookie 必须落在本机已配置站点（metadata.siteHostMap）的 host 上，
 *   且逐条校验形状 —— 他人分享/被篡改的 zip 不能在任意域名落地 cookie；
 * - OFFSCREEN-5：cookie 阶段单条失败不 reject，restoreBackupData 始终返回 IRestoreReport
 *   （配置已写入不回滚，报告与安全提示不能丢）；
 * - OFFSCREEN-8：日志脱敏的递归只在「当前路径」上判环，DAG 里被多处引用的同一对象不再变成 "[Circular]"。
 *
 * 说明：本文件不依赖真实 chrome API —— `@/messages.ts` 被 mock 成可控的 storage 路由，
 * 这样退出消息（patchExtStoragePath / setCookie）的落点可以被逐条断言。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EResultParseStatus } from "@ptd/site";

const mocks = vi.hoisted(() => ({
  onMessage: vi.fn(),
  sendMessage: vi.fn(),
  logger: vi.fn(),
  getSiteInstance: vi.fn(),
  replaceDownloadHistory: vi.fn(async (_openTransaction: unknown, data: unknown) => Array.isArray(data)),
}));

vi.mock("@/messages.ts", () => ({ onMessage: mocks.onMessage, sendMessage: mocks.sendMessage }));

type TStorageStore = Map<string, unknown>;
let storageStore: TStorageStore = new Map();
let setCookieCalls: Array<Record<string, any>> = [];
let failCookieNames = new Set<string>();

/** 最小化的消息路由：只实现本次涉及的 storage / cookie 消息 */
function installMessageRouter() {
  mocks.sendMessage.mockImplementation(async (name: string, payload: any) => {
    switch (name) {
      case "getExtStorage":
        return structuredClone(storageStore.get(typeof payload === "string" ? payload : payload?.key) ?? null);
      case "setExtStorage":
        storageStore.set(payload.key, structuredClone(payload.value));
        return undefined;
      case "getExtStoragePath": {
        const path = Array.isArray(payload.path) ? payload.path : [payload.path];
        let current: any = storageStore.get(payload.key);
        for (const segment of path) {
          if (current === null || typeof current === "undefined") {
            current = undefined;
            break;
          }
          current = current[segment];
        }
        return typeof current === "undefined" ? payload.defaultValue : structuredClone(current);
      }
      case "patchExtStoragePath": {
        const root = (storageStore.get(payload.key) ?? {}) as any;
        const path = Array.isArray(payload.path) ? payload.path : [payload.path];
        let current = root;
        for (let i = 0; i < path.length - 1; i++) {
          current[path[i]] ??= {};
          current = current[path[i]];
        }
        const last = path[path.length - 1];
        if (payload.remove) {
          delete current[last];
        } else {
          current[last] = structuredClone(payload.value);
        }
        storageStore.set(payload.key, root);
        return undefined;
      }
      case "setCookie":
        setCookieCalls.push(structuredClone(payload));
        if (failCookieNames.has(payload.name)) {
          return false;
        }
        return true;
      default:
        return undefined;
    }
  });
}

async function loadBackupModule() {
  vi.doMock("@/offscreen/utils/logger.ts", () => ({ logger: mocks.logger }));
  vi.doMock("@/offscreen/adapter/indexdb.ts", () => ({
    ptdIndexDb: Promise.resolve({ transaction: () => ({}), getAll: async () => [] }),
  }));
  vi.doMock("@ptd/backupServer/utils.ts", () => ({
    backupDataToJSZipBlob: vi.fn(),
    getBackupFilename: vi.fn(() => "PTD_backup_20261006T0000.zip"),
    hasBackupRetentionToApply: vi.fn(() => false),
    isBackupFilename: vi.fn(() => false),
    pruneBackupFiles: vi.fn(() => [[]]),
    replaceDownloadHistory: mocks.replaceDownloadHistory,
  }));
  vi.doMock("@ptd/backupServer", () => ({
    getBackupServer: vi.fn(),
    getBackupServerMetaData: vi.fn(async () => ({ requiredField: [] })),
    entityList: ["WebDAV", "S3", "Gist", "CookieCloud"],
  }));
  vi.resetModules();
  return await import("@/offscreen/utils/backup.ts");
}

async function loadUserInfoModule() {
  vi.doMock("@/offscreen/utils/logger.ts", () => ({ logger: mocks.logger }));
  vi.doMock("@/offscreen/utils/site.ts", () => ({ getSiteInstance: mocks.getSiteInstance }));
  vi.resetModules();
  return await import("@/offscreen/utils/userInfo.ts");
}

type TLoggerModule = typeof import("@/offscreen/utils/logger.ts");

/**
 * 当前用例加载的 logger 模块实例。
 *
 * logger 内部用「内存缓冲 + 500ms 节流定时器落盘」实现（见 src/entries/offscreen/utils/logger.ts），
 * 而 `vi.resetModules()` 只丢弃模块引用，**不会取消已排定的真实定时器**。
 * 若不在用例结束时把它 flush 掉，上一实例的定时器会在后续用例里异步写 sessionStorage，
 * 而下一个 logger 模块在 loadOnce() 时会把这些陈旧条目读回内存缓冲 —— 断言按下标取
 * `getLoggerItems()[0]` 时会拿到不属于本用例的日志（随机器负载时有时无）。
 */
let loadedLoggerModule: TLoggerModule | undefined;

async function loadLoggerModule(): Promise<TLoggerModule> {
  vi.doUnmock("@/offscreen/utils/logger.ts");
  vi.resetModules();
  // loadOnce() 会在首次使用时从 sessionStorage 回填；import 前再清一次，保证从空缓冲开始。
  sessionStorage.clear();
  loadedLoggerModule = await import("@/offscreen/utils/logger.ts");
  return loadedLoggerModule;
}

afterEach(() => {
  // clearLoggerItems() 内部会 clearTimeout 掉节流定时器并清空缓冲，确保没有悬挂的真实定时器。
  loadedLoggerModule?.clearLoggerItems();
  loadedLoggerModule = undefined;
});

// 测试数据刻意放宽为 any：备份条目本身是不可信输入，用例需要构造缺字段/类型错误的条目
function makeCookie(overrides: Record<string, any> = {}): any {
  return {
    name: "sid",
    value: "v",
    domain: "kp.m-team.cc",
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "lax",
    ...overrides,
  };
}

function makeManifest(files: Record<string, unknown>): any {
  return { time: Date.now(), version: "test", files };
}

beforeEach(() => {
  storageStore = new Map();
  setCookieCalls = [];
  failCookieNames = new Set();
  sessionStorage.clear();
  mocks.onMessage.mockClear();
  mocks.sendMessage.mockReset();
  mocks.logger.mockClear();
  mocks.replaceDownloadHistory.mockClear();
  mocks.getSiteInstance.mockReset();
});

describe("logger 脱敏递归（OFFSCREEN-8）", () => {
  it("被多处引用的同一对象不再被误判为 [Circular]，内容完整保留", async () => {
    const { logger, getLoggerItems } = await loadLoggerModule();

    const shared = { link: "https://pt.example/dl?passkey=secret", id: 7 };
    logger({ msg: "dag", data: { first: shared, second: shared } });

    const item = getLoggerItems()[0]! as any;
    expect(item.data.first).toEqual({ link: "https://pt.example/dl?passkey=***", id: 7 });
    expect(item.data.second, "DAG 的第二个引用应拿到同样的脱敏内容，而不是 [Circular]").toEqual(item.data.first);
    expect(JSON.stringify(item.data)).not.toContain("Circular");
  });

  it("数组里重复引用同一对象同样保留内容", async () => {
    const { logger, getLoggerItems } = await loadLoggerModule();

    const shared = { url: "https://pt.example/api/download?token=abc" };
    logger({ msg: "dag-array", data: [shared, shared, { nested: shared }] });

    const item = getLoggerItems()[0]! as any;
    expect(item.data[0]).toEqual({ url: "https://pt.example/api/download?token=***" });
    expect(item.data[1]).toEqual(item.data[0]);
    expect(item.data[2].nested).toEqual(item.data[0]);
  });

  it("真正的自引用仍然输出 [Circular]（保留防无限递归能力）", async () => {
    const { logger, getLoggerItems } = await loadLoggerModule();

    const cyclic: any = { name: "c" };
    cyclic.self = cyclic;
    logger({ msg: "cycle", data: cyclic });

    const item = getLoggerItems()[0]! as any;
    expect(item.data.name).toBe("c");
    expect(item.data.self).toBe("[Circular]");
  });
});

describe("setSiteLastUserInfo（OFFSCREEN-2）", () => {
  const lastSuccess = {
    site: "mteam",
    status: EResultParseStatus.success,
    updateAt: 111,
    uploaded: 1000,
    downloaded: 200,
    ratio: 5,
    levelName: "Elite",
  };

  it("刷新失败时不覆盖 metadata.lastUserInfo 里的上一次成功快照", async () => {
    const { getSiteUserInfoResult } = await loadUserInfoModule();
    installMessageRouter();
    storageStore.set("metadata", { lastUserInfo: { mteam: { ...lastSuccess } } });
    storageStore.set("config", { userInfo: { alwaysPickLastUserInfo: true } });

    mocks.getSiteInstance.mockResolvedValue({
      url: "https://kp.m-team.cc/",
      allowQueryUserInfo: true,
      isOnline: true,
      metadata: { type: "private" },
      getUserInfoResult: vi.fn(async () => ({
        site: "mteam",
        status: EResultParseStatus.needLogin,
        statusMsg: "需要登录",
        updateAt: 222,
      })),
    });

    const result = await getSiteUserInfoResult("mteam");
    expect(result.status, "失败状态仍由返回值交给调用方展示").toBe(EResultParseStatus.needLogin);

    const metadata = storageStore.get("metadata") as any;
    expect(metadata.lastUserInfo.mteam).toEqual(lastSuccess);
    // 失败也不应写入 userInfo 历史
    expect(storageStore.get("userInfo")).toBeUndefined();
  });

  it("刷新成功时正常覆盖 metadata.lastUserInfo 并写入当天历史", async () => {
    const { getSiteUserInfoResult } = await loadUserInfoModule();
    installMessageRouter();
    storageStore.set("metadata", { lastUserInfo: {} });
    storageStore.set("config", { userInfo: { alwaysPickLastUserInfo: true } });

    const snapshot = { site: "mteam", status: EResultParseStatus.success, updateAt: Date.now(), uploaded: 4321 };
    mocks.getSiteInstance.mockResolvedValue({
      url: "https://kp.m-team.cc/",
      allowQueryUserInfo: true,
      isOnline: true,
      metadata: { type: "private" },
      getUserInfoResult: vi.fn(async () => ({ ...snapshot })),
    });

    await getSiteUserInfoResult("mteam");

    const metadata = storageStore.get("metadata") as any;
    expect(metadata.lastUserInfo.mteam).toEqual(snapshot);
    const userInfoStore = storageStore.get("userInfo") as any;
    const dateKeys = Object.keys(userInfoStore.mteam);
    expect(dateKeys).toHaveLength(1);
    expect(dateKeys[0]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(userInfoStore.mteam[dateKeys[0]!]).toEqual(snapshot);
  });
});

describe("restoreBackupData 的 cookie 恢复（OFFSCREEN-4 / OFFSCREEN-5）", () => {
  it("OFFSCREEN-4：只恢复 siteHostMap 内 host（含子域、带端口的键）的 cookie，其它域全部跳过", async () => {
    const { restoreBackupData } = await loadBackupModule();
    installMessageRouter();
    storageStore.set("metadata", { siteHostMap: { "kp.m-team.cc": "mteam", "pt.example:8443": "other" } });

    const report = await restoreBackupData(
      {
        cookies: {
          "kp.m-team.cc": [makeCookie({ name: "ok", domain: "kp.m-team.cc" })],
          "sub.kp.m-team.cc": [makeCookie({ name: "sub", domain: ".sub.kp.m-team.cc" })],
          "evil.example": [makeCookie({ name: "evil", domain: "evil.example" })],
          "pt.example:8443": [makeCookie({ name: "port", domain: "pt.example" })],
        },
        manifest: makeManifest({ cookies: "h" }),
      },
      { fields: ["cookies"] },
    );

    expect(report.success).toBe(true);
    expect(setCookieCalls.map((cookie) => cookie.name).sort()).toEqual(["ok", "port", "sub"]);
    expect(setCookieCalls.some((cookie) => cookie.domain === "evil.example")).toBe(false);
    expect(report.restored).toContain("cookies");
    expect(
      report.skipped.some((item) => item.field === "cookies" && item.reason.includes("不属于本机已配置站点")),
    ).toBe(true);
  });

  it("OFFSCREEN-4：结构非法的 cookie 条目被逐条跳过而不是抛错", async () => {
    const { restoreBackupData } = await loadBackupModule();
    installMessageRouter();
    storageStore.set("metadata", { siteHostMap: { "kp.m-team.cc": "mteam" } });

    const report = await restoreBackupData(
      {
        cookies: {
          "kp.m-team.cc": [
            makeCookie({ name: "good" }),
            null,
            "not-an-object",
            { name: "no-domain", value: "v", path: "/" },
            { domain: "kp.m-team.cc", value: "v" },
            makeCookie({ name: "bad-samesite", sameSite: 42 }),
          ],
        },
        manifest: makeManifest({ cookies: "h" }),
      },
      { fields: ["cookies"] },
    );

    expect(report.success).toBe(true);
    expect(setCookieCalls.map((cookie) => cookie.name).sort()).toEqual(["bad-samesite", "good"]);
    // 非法 sameSite 被丢弃，而不是原样传给 background 的 toLowerCase 抛错
    expect(setCookieCalls.find((cookie) => cookie.name === "bad-samesite")!.sameSite).toBeUndefined();
    expect(report.skipped.some((item) => item.field === "cookies" && item.reason.includes("结构非法"))).toBe(true);
  });

  it("OFFSCREEN-5：单条 cookie 写入失败不 reject，报告与安全提示必须返回", async () => {
    const { restoreBackupData } = await loadBackupModule();
    installMessageRouter();
    failCookieNames.add("boom");
    storageStore.set("metadata", {
      sites: { mteam: {} },
      backupServers: {},
      siteHostMap: { "kp.m-team.cc": "mteam" },
    });

    const report = await restoreBackupData(
      {
        metadata: {
          sites: { mteam: {} },
          siteHostMap: { "kp.m-team.cc": "mteam" },
          backupServers: {
            evil: {
              id: "evil",
              name: "evil",
              type: "WebDAV",
              enabled: true,
              config: { url: "https://evil.example/dav" },
            },
          },
        },
        cookies: { "kp.m-team.cc": [makeCookie({ name: "boom" }), makeCookie({ name: "ok" })] },
        manifest: makeManifest({ metadata: "h", cookies: "h" }),
      },
      { fields: ["metadata", "cookies"] },
    );

    expect(report.success).toBe(true);
    expect(report.restored).toContain("cookies");
    // S-1 的安全化提示不能被 cookie 阶段的异常吞掉
    expect(report.sanitized.some((message) => message.includes("backupServers"))).toBe(true);
    expect(report.skipped.some((item) => item.field === "cookies" && item.reason.includes("写入失败"))).toBe(true);
  });

  it("OFFSCREEN-4：同一份备份不能先改 siteHostMap，再借新 host 写入 cookie", async () => {
    const { restoreBackupData } = await loadBackupModule();
    installMessageRouter();
    storageStore.set("metadata", {
      sites: { local: {} },
      backupServers: {},
      siteHostMap: { "local.example": "local" },
    });

    const report = await restoreBackupData(
      {
        metadata: {
          sites: { evil: {} },
          backupServers: {},
          siteHostMap: { "evil.example": "evil" },
        },
        cookies: {
          "evil.example": [makeCookie({ name: "attacker", domain: "evil.example" })],
        },
        manifest: makeManifest({ metadata: "h", cookies: "h" }),
      },
      { fields: ["metadata", "cookies"] },
    );

    expect(report.success).toBe(true); // metadata 本身已恢复
    expect(report.restored).toContain("metadata");
    expect(report.restored).not.toContain("cookies");
    expect(setCookieCalls).toEqual([]);
    expect(
      report.skipped.some((item) => item.field === "cookies" && item.reason.includes("不属于本机已配置站点")),
    ).toBe(true);
  });

  it("OFFSCREEN-4：没有任何可用 cookie 时不虚报「cookies 已恢复」", async () => {
    const { restoreBackupData } = await loadBackupModule();
    installMessageRouter();
    storageStore.set("metadata", { siteHostMap: {} });

    const report = await restoreBackupData(
      { cookies: {}, manifest: makeManifest({ cookies: "h" }) },
      { fields: ["cookies"] },
    );

    expect(report.success).toBe(false);
    expect(report.restored).not.toContain("cookies");
    expect(report.skipped).toEqual([{ field: "cookies", reason: "部分 cookie 未恢复：备份里没有 cookie 条目" }]);
  });
});
