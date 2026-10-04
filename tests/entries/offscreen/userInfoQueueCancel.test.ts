/**
 * 用户信息刷新队列「取消」回归测试（见 B-12）。
 *
 * 缺陷：`cancelUserInfoQueue` 调 `flushQueue.clear()`，而 p-queue@9 的 `clear()` 只是把内部队列
 * 换成一个新队列，**不 settle** 被丢弃任务的 promise（源码注释只承诺 empty/idle 事件）。
 * 于是 `await flushQueue.add(...)` 永不返回 → SW 侧 `await sendMessage("getSiteUserInfoResult", …)`
 * 永不返回 → `try/finally` 到不了 `releaseLock`，`userInfoAutoFlushLock` 被占到 TTL 过期。
 *
 * 修复：入队时带上批次 AbortSignal，取消时以 AbortError abort，保证每个 add() 的 promise 都有归宿。
 * 本文件第一条用例用真实 p-queue 复现「clear() 会让 add() 悬挂」作为对照，其余用例钉住修复后的行为。
 */
import { describe, expect, it, vi } from "vitest";
import PQueue from "p-queue";

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
type CancelHandler = () => void;

async function loadUserInfoModule(): Promise<{ handler: UserInfoHandler; cancel: CancelHandler }> {
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
  const cancel = mocks.onMessage.mock.calls.find(([name]) => name === "cancelUserInfoQueue")?.[1] as
    CancelHandler | undefined;

  expect(handler, "getSiteUserInfoResult handler should be registered").toBeTypeOf("function");
  expect(cancel, "cancelUserInfoQueue handler should be registered").toBeTypeOf("function");
  return { handler: handler!, cancel: cancel! };
}

const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0));

/** 让失败信息可读：断言「已 settle」而不是「悬挂」时不能直接 await，否则测试自己会挂死 */
function settleState(promise: Promise<unknown>): Promise<{ state: "fulfilled" | "rejected"; reason?: any }> {
  return promise.then(
    () => ({ state: "fulfilled" as const }),
    (reason) => ({ state: "rejected" as const, reason }),
  );
}

describe("cancelUserInfoQueue（B-12）", () => {
  it("对照：真实 p-queue 的 clear() 会让被丢弃任务的 add() promise 永久悬挂", async () => {
    const queue = new PQueue({ concurrency: 1 });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const running = queue.add(async () => gate); // 占住唯一的并发槽
    const discarded = queue.add(async () => "never"); // 排队中，即将被 clear() 丢弃

    await flushMicrotasks();
    queue.clear();

    const discardedState = await Promise.race([
      settleState(discarded),
      flushMicrotasks().then(() => "still-pending" as const),
    ]);
    expect(discardedState, "clear() 不会 settle 被丢弃的任务（这正是修复前锁被占死的根因）").toBe("still-pending");

    release();
    await running;
  });

  it("取消后，排队中与执行中的任务都以 AbortError settle（不再悬挂）", async () => {
    const { handler, cancel } = await loadUserInfoModule();

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

    // concurrency 默认 1：第一个任务在跑（被 gate 挂住），后两个排在队列里
    const first = handler({ data: { siteId: "site-a" } });
    const second = handler({ data: { siteId: "site-b" } });
    const third = handler({ data: { siteId: "site-c" } });

    await flushMicrotasks();
    expect(started).toBe(1);

    cancel();

    const results = await Promise.race([
      Promise.all([settleState(first), settleState(second), settleState(third)]),
      new Promise((resolve) => setTimeout(() => resolve("timeout"), 1000)),
    ]);

    expect(results, "取消后所有 add() 的 promise 都必须 settle（否则 SW 侧的锁会被占死）").not.toBe("timeout");

    for (const result of results as Array<{ state: string; reason?: any }>) {
      expect(result.state).toBe("rejected");
      expect(result.reason?.name).toBe("AbortError");
    }

    release();
  });

  it("取消只影响当前批次：之后新入队的任务仍能正常完成", async () => {
    const { handler, cancel } = await loadUserInfoModule();

    mocks.getSiteInstance.mockImplementation(async (siteId: string) => ({
      url: `https://${siteId}.example.test`,
      allowQueryUserInfo: true,
      metadata: { type: "private" },
      isOnline: true,
      getUserInfoResult: vi.fn(async () => ({ site: siteId, status: 0, updateAt: Date.now() })),
    }));

    cancel(); // 先取消一次（此时队列为空）

    const result = await handler({ data: { siteId: "site-after-cancel" } });
    expect(result).toMatchObject({ site: "site-after-cancel" });
  });
});
