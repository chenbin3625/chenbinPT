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
});
