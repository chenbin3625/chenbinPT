/**
 * 用户信息刷新队列并发回归测试。
 *
 * 缺陷：offscreen 队列默认 concurrency=1，并且只在 active 事件里异步读取配置。
 * 这个异步读取不会阻塞 p-queue 调度，首批短任务容易先按串行执行，用户点击“刷新数据”时体感很慢。
 *
 * 修复后：options 发起刷新时把当前并发数随请求带到 offscreen，offscreen 在入队前同步应用，
 * 第一批任务也能立即并发启动。
 */
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  onMessage: vi.fn(),
  sendMessage: vi.fn(),
  logger: vi.fn(),
  getSiteInstance: vi.fn(),
}));

vi.mock("@/messages.ts", () => ({ onMessage: mocks.onMessage, sendMessage: mocks.sendMessage }));
vi.mock("@/offscreen/utils/logger.ts", () => ({ logger: mocks.logger }));
vi.mock("@/offscreen/utils/site.ts", () => ({ getSiteInstance: mocks.getSiteInstance }));

type UserInfoHandler = (args: { data: any }) => Promise<any>;

async function loadUserInfoHandler(): Promise<UserInfoHandler> {
  vi.resetModules();
  mocks.onMessage.mockClear();
  mocks.sendMessage.mockReset();
  mocks.logger.mockClear();
  mocks.getSiteInstance.mockReset();

  mocks.sendMessage.mockImplementation(async (name: string, payload: any) => {
    if (name === "getExtStoragePath") {
      return payload?.defaultValue;
    }
    return undefined;
  });

  await import("@/offscreen/utils/userInfo.ts");
  const handler = mocks.onMessage.mock.calls.find(([name]) => name === "getSiteUserInfoResult")?.[1] as
    UserInfoHandler | undefined;
  expect(handler, "getSiteUserInfoResult handler should be registered").toBeTypeOf("function");
  return handler!;
}

const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("offscreen 用户信息刷新队列：首批任务立即应用并发配置", () => {
  it("请求携带 queueConcurrency=2 时，两个站点应同时开始抓取用户信息", async () => {
    const handler = await loadUserInfoHandler();

    let started = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    mocks.getSiteInstance.mockImplementation(async (siteId: string) => ({
      url: `https://${siteId}.example.test`,
      allowQueryUserInfo: true,
      metadata: { type: "private" },
      isOnline: true,
      getUserInfoResult: vi.fn(async () => {
        started += 1;
        await gate;
        return { site: siteId, status: 0, updateAt: Date.now() };
      }),
    }));

    const first = handler({ data: { siteId: "site-a", queueConcurrency: 2 } });
    const second = handler({ data: { siteId: "site-b", queueConcurrency: 2 } });

    await flushMicrotasks();
    await flushMicrotasks();

    expect(started).toBe(2);

    release();
    await Promise.all([first, second]);
  });

  it("OS-4：调用方显式传入的并发度在后续批次仍生效，且不再逐任务读 config", async () => {
    const handler = await loadUserInfoHandler();

    let running = 0;
    let maxRunning = 0;
    mocks.getSiteInstance.mockImplementation(async (siteId: string) => ({
      url: `https://${siteId}.example.test`,
      allowQueryUserInfo: true,
      metadata: { type: "private" },
      isOnline: true,
      getUserInfoResult: vi.fn(async () => {
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        await new Promise((resolve) => setTimeout(resolve, 20));
        running -= 1;
        return { site: siteId, status: 0, updateAt: Date.now() };
      }),
    }));

    // 4 个站点、显式并发 2：两批都应保持 2 并发
    await Promise.all(["a", "b", "c", "d"].map((siteId) => handler({ data: { siteId, queueConcurrency: 2 } })));

    expect(maxRunning, "显式并发度不应被存储配置覆盖成 1").toBe(2);
    expect(
      mocks.sendMessage.mock.calls.filter(
        ([name, payload]: any[]) => name === "getExtStoragePath" && payload?.path === "userInfo.queueConcurrency",
      ),
      "调用方已显式传入并发度，不应再逐任务读取 config",
    ).toHaveLength(0);
  });

  it("OS-4：未显式传入时只读一次 config（并发首批共享一次 SW 往返）", async () => {
    const handler = await loadUserInfoHandler();

    let running = 0;
    let maxRunning = 0;
    mocks.sendMessage.mockImplementation(async (name: string, payload: any) => {
      if (name === "getExtStoragePath" && payload?.path === "userInfo.queueConcurrency") {
        return 2;
      }
      if (name === "getExtStoragePath") {
        return payload?.defaultValue;
      }
      return undefined;
    });
    mocks.getSiteInstance.mockImplementation(async (siteId: string) => ({
      url: `https://${siteId}.example.test`,
      allowQueryUserInfo: true,
      metadata: { type: "private" },
      isOnline: true,
      getUserInfoResult: vi.fn(async () => {
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        await new Promise((resolve) => setTimeout(resolve, 20));
        running -= 1;
        return { site: siteId, status: 0, updateAt: Date.now() };
      }),
    }));

    await Promise.all([handler({ data: { siteId: "a" } }), handler({ data: { siteId: "b" } })]);

    expect(maxRunning).toBe(2);
    expect(
      mocks.sendMessage.mock.calls.filter(
        ([name, payload]: any[]) => name === "getExtStoragePath" && payload?.path === "userInfo.queueConcurrency",
      ),
    ).toHaveLength(1);
  });

  it("storage.onChanged 发生 config 变更时清除记忆并发，后续请求重读新配置", async () => {
    let currentConcurrency = 2;
    let storageListener: any;
    (globalThis as any).chrome = {
      storage: {
        onChanged: {
          addListener: vi.fn((fn: any) => {
            storageListener = fn;
          }),
        },
      },
    };
    const handler = await loadUserInfoHandler();
    mocks.sendMessage.mockImplementation(async (name: string, payload: any) => {
      if (name === "getExtStoragePath" && payload?.path === "userInfo.queueConcurrency") {
        return currentConcurrency;
      }
      return payload?.defaultValue;
    });
    mocks.getSiteInstance.mockImplementation(async (siteId: string) => ({
      url: `https://${siteId}.example.test`,
      allowQueryUserInfo: true,
      metadata: { type: "private" },
      isOnline: true,
      getUserInfoResult: vi.fn(async () => ({ site: siteId, status: 0, updateAt: Date.now() })),
    }));

    await handler({ data: "site-1" });
    expect(
      mocks.sendMessage.mock.calls.filter(
        ([name, payload]: any[]) => name === "getExtStoragePath" && payload?.path === "userInfo.queueConcurrency",
      ),
    ).toHaveLength(1);

    currentConcurrency = 4;
    storageListener?.({ config: { newValue: {} } }, "local");

    await handler({ data: "site-2" });
    expect(
      mocks.sendMessage.mock.calls.filter(
        ([name, payload]: any[]) => name === "getExtStoragePath" && payload?.path === "userInfo.queueConcurrency",
      ),
    ).toHaveLength(2);
  });
});
