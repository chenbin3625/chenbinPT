/**
 * Cloudflare 重试租约的超时兜底（缺陷清单 G1）。
 *
 * 背景：`withCookieRetryLease` 按 cf_clearance 的 `storeId|domain|path|name` 串行化
 * 「临时 cookie set → 重试请求 → 复原」。旧实现是裸 `await previous`，只有 task 的 `finally`
 * 会 release —— 一次重试请求永久挂起（站点 hang / 消息通道卡住 / 代理不返回）就会让
 * **同站点后续所有 CF 重试**永久停在排队上，且 Map 里留下一条永不 resolve 的 entry。
 *
 * 这里用真实 axios + 受控 adapter + 假时钟验证两件事：
 * 1. 排队超过 `COOKIE_RETRY_LEASE_WAIT_TIMEOUT` 后，排队者以明确错误失败（而不是永久 pending）；
 * 2. 重试请求在 `config.timeout` 缺失/为 0 时会被补一个有限超时（不改变已有超时的语义）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/messages.ts", () => ({
  sendMessage: vi.fn(),
  onMessage: vi.fn(),
}));

type AnyMock = ReturnType<typeof vi.fn>;

const { sendMessage } = await import("@/messages.ts");
const { AxiosError } = await import("axios");
const axios = (await import("axios")).default;
const { setupRetryWhenCloudflareBlock } = await import("~/extends/axios/retryWhenCloudflareBlock.ts");

const sendMessageMock = sendMessage as unknown as AnyMock;

/**
 * 每个 harness 用不同 cookie domain：模块级租约 Map 以 `storeId|domain|path|name` 为 key，
 * 用例之间共用 domain 会让「上一个用例留下的挂死租约」影响下一个用例。
 */
function cfCookie(domain: string) {
  return {
    domain,
    name: "cf_clearance",
    path: "/",
    secure: true,
    value: "cf-token",
  } as chrome.cookies.Cookie;
}

function installSendMessageMock(domain: string) {
  sendMessageMock.mockImplementation((type: string) => {
    switch (type) {
      case "getAllCookies":
        return Promise.resolve([cfCookie(domain)]);
      case "getCookie":
        return Promise.resolve(null);
      case "setCookie":
        return Promise.resolve(true);
      case "removeCookie":
      case "removeDNRSessionRuleById":
      case "updateDNRSessionRules":
        return Promise.resolve(undefined);
      default:
        return Promise.reject(new Error(`unexpected message: ${type}`));
    }
  });
}

interface IRecordedAttempt {
  url: string;
  /** 该次尝试真正传递给 adapter 的 timeout（用于断言兜底超时） */
  timeoutAtCall: number | undefined;
}

/**
 * @param options.hangAfterFirstAttempt 第二次尝试（重试）返回一个永不 resolve 的 promise
 */
function createCfHarness(options: { domain: string; hangAfterFirstAttempt?: boolean; timeout?: number }) {
  installSendMessageMock(options.domain);
  const attempts: IRecordedAttempt[] = [];

  const adapter = async (config: any) => {
    attempts.push({ url: config.url, timeoutAtCall: config.timeout });

    // 每个请求的「首次尝试」都是 isCfBlockedRetry !== true；不能用全局 attempts.length 判断，
    // 否则第二个请求的首次尝试会被误当成「重试」而挂住（测试自身的坑）。
    if (config?.isCfBlockedRetry !== true) {
      const failedResponse = {
        status: 403,
        statusText: "Forbidden",
        headers: { "cf-mitigated": "challenge" },
        data: "Enable JavaScript and cookies to continue",
        config,
        request: {},
      };
      throw new AxiosError(
        "Request failed with status code 403",
        AxiosError.ERR_BAD_REQUEST,
        config,
        {},
        failedResponse as any,
      );
    }

    if (options.hangAfterFirstAttempt) {
      // 重试请求永久挂起（模拟站点 hang / 消息通道卡死）
      return new Promise(() => undefined);
    }

    return { data: "ok", status: 200, statusText: "OK", headers: {}, config };
  };

  const instance = axios.create({
    baseURL: "https://pt.example.com",
    adapter: adapter as any,
    timeout: options.timeout,
  });
  setupRetryWhenCloudflareBlock(instance);

  return { instance, attempts };
}

describe("Cloudflare 重试租约超时（G1）", () => {
  beforeEach(() => {
    sendMessageMock.mockReset();
  });

  afterEach(() => {
    // 用例失败/超时时也保证不把假时钟泄漏给下一个用例
    vi.useRealTimers();
  });

  /** 连续让出微任务，等纯 promise 链（axios 分发 → 响应拦截器 → 读取 cookie）走到排队处 */
  async function flushMicrotasks(times = 50) {
    for (let i = 0; i < times; i++) {
      await Promise.resolve();
    }
  }

  it("前一个重试永久挂起时，后续同站点请求排队超时并失败（不再永久 pending）", async () => {
    vi.useFakeTimers();
    try {
      const { instance } = createCfHarness({ domain: ".stuck.example.com", hangAfterFirstAttempt: true });

      // 1) 第一个请求：首次尝试被 CF 拦截 → set 临时 cookie → 重试（永久挂起，占住租约）
      const stuck = instance.get("/api/slow");
      void stuck.catch(() => undefined); // 该请求永远不会 settle，测试不 await 它
      await vi.advanceTimersByTimeAsync(1000); // 越过重试前的 800ms 等待

      // 2) 第二个请求：同站点（同 cf_clearance key）→ 必须先排队
      //    注意：必须先让它的纯 promise 链真正走到 `waitForCookieRetryLease`（注册 35s 超时定时器），
      //    否则后面推进时钟时它还没开始排队（这条链里没有定时器，只有微任务）。
      const queued = instance.get("/api/slow");
      let queuedSettled = false;
      queued.catch(() => {
        queuedSettled = true;
      });
      await flushMicrotasks();
      expect(queuedSettled).toBe(false);

      // 3) 排队超过 35s 的租约等待上限 → 明确失败，而不是永远等待
      await vi.advanceTimersByTimeAsync(36_000);
      await expect(queued).rejects.toThrow(/timed out waiting for the CF retry lease/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("重试请求在 config.timeout 缺失/为 0 时补有限超时；已有正数超时保持不变", async () => {
    // 默认 timeout（axios.create 默认 0 = 不限时）→ 重试补 30s
    const zeroTimeout = createCfHarness({ domain: ".zero.example.com" });
    await zeroTimeout.instance.get("/api/fast", { headers: {} });
    // 上一次调用会 set 临时 cookie；第二次尝试的 timeout 应为兜底值
    expect(zeroTimeout.attempts).toHaveLength(2);
    expect(zeroTimeout.attempts[1].timeoutAtCall).toBe(30_000);

    // 已有正数 timeout（站点默认 30s 或用户自定义）→ 不被覆盖
    const customTimeout = createCfHarness({ domain: ".custom.example.com", timeout: 45_000 });
    await customTimeout.instance.get("/api/fast", { headers: {} });
    expect(customTimeout.attempts).toHaveLength(2);
    expect(customTimeout.attempts[1].timeoutAtCall).toBe(45_000);
  });
});
