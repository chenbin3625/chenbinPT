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
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/messages.ts", () => ({
  onMessage: vi.fn(),
  sendMessage: vi.fn(),
}));

vi.mock("@/background/utils/offscreen.ts", () => ({
  setupOffscreenDocument: vi.fn(() => Promise.resolve()),
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
    onMessage: { addListener: vi.fn() },
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
  await import("@/background/utils/nativeMessaging.ts");
  await flushAsync();
}

describe("nativeMessaging 启动流程", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("冷启动在顶层注册 alarm 监听、恢复 session 状态并连接一次（不依赖 onAdded）", async () => {
    installChromeMock({
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

  it("长延迟退避的 alarm 到点后会重新 connect（修复前没有监听者）", async () => {
    installChromeMock({ permission: true });
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
    installChromeMock({ permission: true });
    await importNativeMessaging();
    expect(connectNative).toHaveBeenCalledTimes(1);

    permsOnAdded.mock.calls[0]![0]({ permissions: ["nativeMessaging"] });
    await flushAsync();

    expect(alarmsOnAlarm).toHaveBeenCalledTimes(1);
    expect(connectNative).toHaveBeenCalledTimes(1);
  });
});
