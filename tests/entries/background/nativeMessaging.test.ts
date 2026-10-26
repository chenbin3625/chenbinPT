/**
 * native messaging 启动流程测试（见 docs/performance-audit.md P1-8）。
 *
 * 回归点：alarm 监听注册与 session 状态恢复被误嵌进 `chrome.permissions.onAdded` 回调，
 * 于是 SW 每次冷启动都没有 alarm 监听者（30s 档长延迟退避永久停住），也不恢复
 * reconnectAttempt/state/lastError；而用户之后授予权限时又会把「恢复 + init」跑一遍，
 * 与顶层启动流程并发连接。
 *
 * 这里用假的 chrome API 行为验证：顶层就注册 alarm 监听、冷启动恢复并只连接一次、
 * onAdded 只做 init 且对已有 port 幂等。
 *
 * A4（2026-10-23 审查）：额外覆盖「桥接默认关闭」「白名单收缩」「params 校验」「返回值脱敏」——
 * 这些是原生宿主能触达的权限面，原测试完全没覆盖。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  onMessage: vi.fn(),
  sendMessage: vi.fn(),
  setupOffscreenDocument: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/messages.ts", () => ({
  onMessage: mocks.onMessage,
  sendMessage: mocks.sendMessage,
}));

vi.mock("@/background/utils/offscreen.ts", () => ({
  setupOffscreenDocument: mocks.setupOffscreenDocument,
}));

// vite define 注入的编译期常量
vi.stubGlobal("__BROWSER__", "chrome");
vi.stubGlobal("__EXT_VERSION__", "0.0.0-test");

type AnyFn = ReturnType<typeof vi.fn>;

let alarmsOnAlarm: AnyFn;
let permsOnAdded: AnyFn;
let permsOnRemoved: AnyFn;
let connectNative: AnyFn;
let sessionGet: AnyFn;
let localGet: AnyFn;
let runtimeMock: any;
let createdPorts: any[];

function createPort() {
  const port: any = {
    posted: [] as any[],
    disconnect: vi.fn(),
    postMessage: vi.fn((message: any) => port.posted.push(message)),
    onMessage: {
      addListener: vi.fn((fn: (msg: any) => unknown) => {
        port.onMessageHandler = fn;
      }),
    },
    onDisconnect: {
      addListener: vi.fn((fn: () => void) => {
        port.onDisconnectHandler = fn;
      }),
    },
  };
  createdPorts.push(port);
  return port;
}

function installChromeMock(options: { sessionState?: any; permission?: boolean; enabled?: boolean } = {}) {
  createdPorts = [];
  connectNative = vi.fn(() => createPort());
  sessionGet = vi.fn(() => Promise.resolve(options.sessionState ? { nativeBridgeState: options.sessionState } : {}));
  localGet = vi.fn(() =>
    Promise.resolve(options.enabled === undefined ? {} : { ptd_native_bridge_enabled: options.enabled }),
  );
  alarmsOnAlarm = vi.fn();
  permsOnAdded = vi.fn();
  permsOnRemoved = vi.fn();

  runtimeMock = {
    id: "test-extension-id",
    lastError: undefined,
    connectNative,
    getURL: (path: string) => `chrome-extension://test/${path}`,
    onMessage: { addListener: vi.fn() },
  };

  vi.stubGlobal("chrome", {
    alarms: { onAlarm: { addListener: alarmsOnAlarm }, create: vi.fn(), clear: vi.fn() },
    permissions: {
      contains: vi.fn(() => Promise.resolve(options.permission ?? true)),
      onAdded: { addListener: permsOnAdded },
      onRemoved: { addListener: permsOnRemoved },
    },
    storage: {
      local: { get: localGet, set: vi.fn(() => Promise.resolve()) },
      session: { get: sessionGet, set: vi.fn(() => Promise.resolve()) },
    },
    runtime: runtimeMock,
  });
}

async function flushAsync() {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
}

async function importNativeMessaging() {
  vi.resetModules();
  const module = await import("@/background/utils/nativeMessaging.ts");
  await flushAsync();
  return module;
}

describe("nativeMessaging 启动流程", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.onMessage.mockReset();
    mocks.sendMessage.mockReset();
    mocks.setupOffscreenDocument.mockReset();
    mocks.setupOffscreenDocument.mockResolvedValue(undefined);
  });

  it("冷启动在顶层注册 alarm 监听、恢复 session 状态并连接一次（不依赖 onAdded）", async () => {
    installChromeMock({
      enabled: true,
      sessionState: { reconnectAttempt: 3, enabled: true, state: "retrying", lastError: "previous" },
    });

    await importNativeMessaging();

    // 核心回归：alarm 监听必须在 SW 冷启动时就有，而不是等用户授予权限
    expect(alarmsOnAlarm).toHaveBeenCalledTimes(1);
    expect(permsOnAdded).toHaveBeenCalledTimes(1);
    // 顶层 startup 恢复了 session 状态
    expect(sessionGet).toHaveBeenCalledWith("nativeBridgeState");
    // 只连接一次
    expect(connectNative).toHaveBeenCalledTimes(1);
    expect(createdPorts[0]!.posted[0]).toMatchObject({ type: "hello" });
  });

  it("A4：桥接默认关闭 —— 仅授予权限但从未显式开启时不连接", async () => {
    installChromeMock({ permission: true }); // 没有 ptd_native_bridge_enabled → 默认 false

    const { ALLOWED_METHODS } = await importNativeMessaging();

    expect(connectNative).not.toHaveBeenCalled();
    expect(ALLOWED_METHODS.size).toBeGreaterThan(0);
  });

  it("长延迟退避的 alarm 到点后会重新 connect（修复前没有监听者）", async () => {
    installChromeMock({ permission: true, enabled: true });
    await importNativeMessaging();
    expect(connectNative).toHaveBeenCalledTimes(1);

    // 模拟 native host 以致命错误断开（不排程 setTimeout，port 被置空）
    runtimeMock.lastError = { message: "Specified native messaging host not found." };
    createdPorts[0]!.onDisconnectHandler();
    runtimeMock.lastError = undefined;

    const alarmHandler = alarmsOnAlarm.mock.calls[0]![0];
    alarmHandler({ name: "nativeBridgeReconnect" });

    expect(connectNative).toHaveBeenCalledTimes(2);
  });

  it("onAdded 只做 init：不重复注册 alarm，也不在已有 port 时重复 connect", async () => {
    installChromeMock({ permission: true, enabled: true });
    await importNativeMessaging();
    expect(connectNative).toHaveBeenCalledTimes(1);

    permsOnAdded.mock.calls[0]![0]({ permissions: ["nativeMessaging"] });
    await flushAsync();

    expect(alarmsOnAlarm).toHaveBeenCalledTimes(1);
    expect(connectNative).toHaveBeenCalledTimes(1);
  });
});

describe("nativeMessaging 桥接权限面（A4）", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.onMessage.mockReset();
    mocks.sendMessage.mockReset();
    mocks.setupOffscreenDocument.mockReset();
    mocks.setupOffscreenDocument.mockResolvedValue(undefined);
  });

  it("白名单已移除凭据读取与破坏性写操作，只保留只读查询", async () => {
    installChromeMock({ permission: true, enabled: true });
    const { ALLOWED_METHODS } = await importNativeMessaging();

    for (const removed of [
      "getSiteUserConfig",
      "getDownloaderConfig",
      "getTorrentDownloadLink",
      "getTorrentInfoForVerification",
      "downloadTorrent",
      "deleteDownloadHistoryById",
      "clearDownloadHistory",
      "removeSiteUserInfo",
      "cancelUserInfoQueue",
      "createKeepUploadTask",
      "updateKeepUploadTask",
      "deleteKeepUploadTask",
      "clearKeepUploadTasks",
      "clearSiteFaviconCache",
      // 整库遍历需用户在设置页显式确认，不能经桥接静默触发
      "getMediaServerOverview",
      "createTorrentFavorites",
      "deleteTorrentFavorites",
    ]) {
      expect(ALLOWED_METHODS.has(removed), `${removed} 不应再开放给原生宿主`).toBe(false);
    }

    for (const kept of [
      "getSiteList",
      "getDownloaderList",
      "getSiteFavicon",
      "getSiteSearchResult",
      "getMediaServerSearchResult",
      "getMediaServerItemDetail",
      "getDownloaderVersion",
      "getDownloaderStatus",
      "getDownloadHistory",
      "getDownloadHistoryById",
      "getSiteUserInfoResult",
      "getSiteUserInfo",
      "getKeepUploadTasks",
      "getKeepUploadTaskById",
      "getTorrentFavorites",
    ]) {
      expect(ALLOWED_METHODS.has(kept), `${kept} 应保留（只读）`).toBe(true);
    }
  });

  it("宿主请求：未登记方法返回 METHOD_NOT_ALLOWED（不会转发给扩展）", async () => {
    installChromeMock({ permission: true, enabled: true });
    await importNativeMessaging();
    const port = createdPorts[0]!;

    port.onMessageHandler({ type: "request", id: 1, method: "getSiteUserConfig", params: { siteId: "mteam" } });
    await flushAsync();

    expect(mocks.sendMessage).not.toHaveBeenCalled();
    expect(port.posted).toContainEqual({
      type: "response",
      id: 1,
      error: { code: "METHOD_NOT_ALLOWED", message: "Method 'getSiteUserConfig' is not allowed" },
    });
  });

  it("宿主请求：params 形状不合法时返回 INVALID_PARAMS（不再原样塞进业务路径）", async () => {
    installChromeMock({ permission: true, enabled: true });
    await importNativeMessaging();
    const port = createdPorts[0]!;

    // 标量类型错误
    port.onMessageHandler({ type: "request", id: 2, method: "getDownloadHistoryById", params: {} });
    // 非普通对象（函数）
    port.onMessageHandler({ type: "request", id: 3, method: "getSiteList", params: { cb: () => 1 } });
    await flushAsync();

    expect(mocks.sendMessage).not.toHaveBeenCalled();
    expect(port.posted.filter((m: any) => m.type === "response").map((m: any) => m.error?.code)).toEqual([
      "INVALID_PARAMS",
      "INVALID_PARAMS",
    ]);
  });

  it("宿主请求：合法方法仍转发并返回**脱敏后**的结果", async () => {
    installChromeMock({ permission: true, enabled: true });
    await importNativeMessaging();
    const port = createdPorts[0]!;
    mocks.sendMessage.mockResolvedValue({
      torrents: [
        {
          title: "t",
          link: "https://tracker.example/torrents.php?action=download&id=1&authkey=SECRET&torrent_pass=PASS",
        },
      ],
      inputSetting: { token: "SECRET" },
      downloadRequestConfig: { headers: { Cookie: "session=SECRET" } },
    });

    port.onMessageHandler({ type: "request", id: 4, method: "getSiteSearchResult", params: { siteId: "mteam" } });
    await flushAsync();

    expect(mocks.sendMessage).toHaveBeenCalledWith("getSiteSearchResult", { siteId: "mteam" });
    const response = port.posted.find((m: any) => m.id === 4);
    expect(response.error).toBeUndefined();
    expect(response.result.torrents[0].link).toBe(
      "https://tracker.example/torrents.php?action=download&id=1&authkey=***&torrent_pass=***",
    );
    expect(response.result.inputSetting).toBeUndefined();
    expect(response.result.downloadRequestConfig).toBeUndefined();
  });

  it("sanitizeBridgeResult：敏感键名整项剔除、URL 凭据参数打码、循环引用不崩溃", async () => {
    installChromeMock({ permission: true, enabled: true });
    const { sanitizeBridgeResult } = await importNativeMessaging();

    const cyclic: any = { passkey: "SECRET", ok: 1 };
    cyclic.self = cyclic;

    const shared = { title: "shared", link: "https://example.com/download.php?id=1&downhash=MYDOWNHASH" };

    const result = sanitizeBridgeResult({
      passkey: "SECRET",
      authKey: { authkey: "SECRET" },
      ok: 1,
      nested: { authorization: "Bearer SECRET", normal: "keep" },
      link: "https://x/download?torrent_pass=SECRET&id=1",
      downhashLink: "https://x/download.php?id=10&downhash=ABCDEF123456",
      rartrackerPath: "/api/v1/torrents/download/42/0123456789abcdef0123456789abcdef",
      dagA: shared,
      dagB: shared,
      cyclic,
    }) as any;

    expect(result.passkey).toBeUndefined();
    expect(result.authKey).toBeUndefined();
    expect(result.ok).toBe(1);
    expect(result.nested.authorization).toBeUndefined();
    expect(result.nested.normal).toBe("keep");
    expect(result.link).toBe("https://x/download?torrent_pass=***&id=1");
    // NexusPHP downhash 与 Rartracker path passkey 均脱敏
    expect(result.downhashLink).toBe("https://x/download.php?id=10&downhash=***");
    expect(result.rartrackerPath).toBe("/api/v1/torrents/download/42/***");
    // DAG 共享引用不被误杀
    expect(result.dagA.title).toBe("shared");
    expect(result.dagA.link).toBe("https://example.com/download.php?id=1&downhash=***");
    expect(result.dagB.title).toBe("shared");
    expect(result.dagB.link).toBe("https://example.com/download.php?id=1&downhash=***");
    // 循环引用安全（第二次出现时被裁掉）
    expect(result.cyclic.ok).toBe(1);
    expect(result.cyclic.self).toBeUndefined();
  });

  it("validateBridgeParams：无参方法允许 undefined，普通对象/数组/标量允许，类实例与超深嵌套拒绝", async () => {
    installChromeMock({ permission: true, enabled: true });
    const { validateBridgeParams } = await importNativeMessaging();

    expect(validateBridgeParams("getSiteList", undefined)).toBeUndefined();
    expect(validateBridgeParams("getSiteSearchResult", { siteId: "mteam" })).toBeUndefined();
    expect(validateBridgeParams("getSiteList", [1, "a"])).toBeUndefined();
    expect(validateBridgeParams("getDownloadHistoryById", 1)).toBeUndefined();
    expect(validateBridgeParams("getDownloadHistoryById", "1")).toMatch(/must be a number/);
    expect(validateBridgeParams("getSiteList", new Map())).toMatch(/JSON-serializable/);

    let deep: any = 1;
    for (let i = 0; i < 12; i++) deep = { deep };
    expect(validateBridgeParams("getSiteList", deep)).toMatch(/JSON-serializable/);
  });
});
