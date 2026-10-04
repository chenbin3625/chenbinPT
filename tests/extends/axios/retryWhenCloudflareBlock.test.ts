/**
 * Cloudflare 重试必须保留 DNR 注入的请求头（缺陷清单 B-17）。
 *
 * 事实前提（用真实 axios + mock adapter 验证，而不是读代码推断）：
 * - axios 的 request 拦截器用 `unshift` 注册（执行时**逆序**），response 拦截器用 `push`（执行时**正序**）；
 * - `packages/site/utils/adapter.ts` 先 `setupReplaceUnsafeHeader` 再 `setupRetryWhenCloudflareBlock`，
 *   因此被 Cloudflare 拦截时，**先**跑 `replaceUnsafeHeader` 的 response 错误拦截器（`releaseDnrRule` 删除规则），
 *   **后**跑 `retryWhenCloudflareBlock` 的重试逻辑；
 * - 请求拦截器在首次尝试时已经把 `Referer`/`Origin`/`User-Agent` 从 `config.headers` 里剥掉（改由 DNR 注入），
 *   而重试复用同一个 config（`mergeConfig` 从已剥离的 headers 重建）。
 *
 * 于是旧实现重试时提取到的请求头为空 ⇒ 不装任何 DNR 规则 ⇒ **重试请求不带这些头**，与首次请求不是同一个请求。
 * 修复后：首次尝试提取出的 `ModifyHeaderInfo` 列表被保留在 config 上，每次尝试（含重试）都重新安装规则。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/messages.ts", () => ({
  sendMessage: vi.fn(),
  onMessage: vi.fn(),
}));

type AnyMock = ReturnType<typeof vi.fn>;

const { sendMessage } = await import("@/messages.ts");
const { AxiosError } = await import("axios");
const axios = (await import("axios")).default;
const { setupReplaceUnsafeHeader } = await import("~/extends/axios/replaceUnsafeHeader.ts");
const { setupRetryWhenCloudflareBlock } = await import("~/extends/axios/retryWhenCloudflareBlock.ts");

const sendMessageMock = sendMessage as unknown as AnyMock;

/** 扩展自己设置的 cf_clearance（重试的前提：能从 cookie 库里取到它） */
const cfClearanceCookie = {
  domain: ".pt.example.com",
  name: "cf_clearance",
  path: "/",
  secure: true,
  value: "cf-token",
} as chrome.cookies.Cookie;

function installSendMessageMock() {
  sendMessageMock.mockImplementation((type: string) => {
    switch (type) {
      case "getAllCookies":
        return Promise.resolve([cfClearanceCookie]);
      case "updateDNRSessionRules":
      case "removeDNRSessionRuleById":
      case "setCookie":
      case "removeCookie":
        return Promise.resolve(undefined);
      default:
        return Promise.reject(new Error(`unexpected message: ${type}`));
    }
  });
}

function callsOf(type: string): any[][] {
  return sendMessageMock.mock.calls.filter(([callType]) => callType === type);
}

/** DNR 规则的 requestHeaders → 便于断言的 { header: operation } 映射 */
function headerOps(rule: any): Record<string, string> {
  return Object.fromEntries(rule.action.requestHeaders.map((item: any) => [item.header, item.operation]));
}

interface IAttempt {
  config: any;
  /** 这一尝试在 axios 层面真实带上的请求头（不安全头已被请求拦截器剥离） */
  axiosHeaders: Record<string, string>;
}

function createCfRetryHarness() {
  const attempts: IAttempt[] = [];

  const adapter = async (config: any) => {
    attempts.push({
      config,
      axiosHeaders: Object.fromEntries(Array.from(config.headers as any) as Array<[string, any]>),
    });

    if (attempts.length === 1) {
      // 第一次尝试：Cloudflare 挑战（cf-mitigated: challenge）
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

    return { data: "ok", status: 200, statusText: "OK", headers: {}, config };
  };

  const instance = axios.create({ baseURL: "https://pt.example.com", adapter: adapter as any });
  setupReplaceUnsafeHeader(instance);
  setupRetryWhenCloudflareBlock(instance);

  return { instance, attempts };
}

describe("Cloudflare 重试与 DNR 注入头（B-17）", () => {
  beforeEach(() => {
    sendMessageMock.mockReset();
    installSendMessageMock();
  });

  it("重试请求会重新安装 DNR 规则：Referer / Origin / User-Agent 在重试尝试上依然被注入", async () => {
    const { instance, attempts } = createCfRetryHarness();

    const response = await instance.get("/api/thing", {
      headers: {
        "user-agent": "PTD-Test/1.0",
        referer: "https://pt.example.com/list",
        origin: "https://pt.example.com",
        "x-custom": "keep-me",
      },
    });

    expect(response.data).toBe("ok");
    // 确实发生了一次重试（而不是首请求就成功）
    expect(attempts).toHaveLength(2);

    const installs = callsOf("updateDNRSessionRules");
    expect(installs).toHaveLength(2); // 每次尝试各装一次：修复前只有 1 次（重试那次没有规则）
    expect(headerOps(installs[0][1].rule)).toEqual({
      "user-agent": "set",
      referer: "set",
      origin: "set",
    });
    // 关键断言：重试尝试也装了同一份头（修复前这里是 undefined/缺失）
    expect(headerOps(installs[1][1].rule)).toEqual(headerOps(installs[0][1].rule));
    expect(installs[1][1].rule.action.requestHeaders).toEqual(
      expect.arrayContaining([
        { header: "user-agent", operation: "set", value: "PTD-Test/1.0" },
        { header: "referer", operation: "set", value: "https://pt.example.com/list" },
        { header: "origin", operation: "set", value: "https://pt.example.com" },
      ]),
    );
    // 两次安装的规则 id 由 cacheKey 确定性派生（重装 = 按 id 覆盖同一条规则）
    expect(installs[1][1].rule.id).toBe(installs[0][1].rule.id);

    // 每次尝试结束都释放自己装的规则（首尝试的释放在重试之前，见文件头说明）
    expect(callsOf("removeDNRSessionRuleById").length).toBeGreaterThanOrEqual(2);
  });

  it("重试复用同一个 config：axios 层面仍然只有非不安全头，安全头只能靠 DNR 注入", async () => {
    const { instance, attempts } = createCfRetryHarness();

    await instance.post("/api/thing?page=2", { body: 1 }, { headers: { "user-agent": "PTD-Test/1.0" } });

    expect(attempts).toHaveLength(2);
    for (const attempt of attempts) {
      expect(Object.keys(attempt.axiosHeaders)).not.toContain("user-agent");
    }
    // 同一份 config 被复用（url / params / 业务头都在），说明"重试请求丢头"不是因为换了个 config
    expect(attempts[1].config.url).toBe("/api/thing?page=2");
    expect(attempts[1].config.method).toBe("post");
    // 两次尝试的 URL/method 一致 ⇒ cacheKey 一致 ⇒ 规则 id 一致（重装安全）
    expect(headerOps(callsOf("updateDNRSessionRules")[0][1].rule)).toEqual({ "user-agent": "set" });
  });

  it("值为空字符串的不安全头在重试时仍重建为 remove 操作（语义不被重试改变）", async () => {
    const { instance } = createCfRetryHarness();

    await instance.get("/api/thing", { headers: { origin: "" } });

    const installs = callsOf("updateDNRSessionRules");
    expect(installs).toHaveLength(2);
    for (const [, payload] of installs) {
      expect(payload.rule.action.requestHeaders).toEqual([{ header: "origin", operation: "remove" }]);
    }
  });

  it("没有不安全头的请求不会被重试逻辑带上任何 DNR 规则（不引入额外副作用）", async () => {
    const { instance, attempts } = createCfRetryHarness();

    await instance.get("/api/thing", { headers: { "x-custom": "1", accept: "application/json" } });

    expect(attempts).toHaveLength(2);
    expect(callsOf("updateDNRSessionRules")).toHaveLength(0);
  });
});
