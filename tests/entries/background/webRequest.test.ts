/**
 * DNR 会话规则处理器的防御性校验测试（见 docs/performance-audit.md P1-9）。
 *
 * 调用方用确定性哈希生成规则 id；这里在 background 侧再校验一次：
 * - id 必须是正整数（否则无法按 id 精确删除）；
 * - urlFilter 与 regexFilter 只能二选一；
 * - 非法规则必须 reject（让调用方观察到安装失败），而不是静默地把「没装上的规则」写进缓存。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/messages.ts", () => ({ onMessage: vi.fn(), sendMessage: vi.fn() }));

vi.stubGlobal("__BROWSER__", "chrome");

const updateSessionRules = vi.fn((_options: any) => Promise.resolve());

vi.stubGlobal("chrome", {
  runtime: { id: "test-extension-id", getURL: (path: string) => `chrome-extension://test-extension-id/${path}` },
  declarativeNetRequest: { updateSessionRules },
});

type AnyMock = ReturnType<typeof vi.fn>;

const { onMessage } = await import("@/messages.ts");
await import("@/background/utils/webRequest.ts");

const handlers = new Map<string, (args: any) => any>();
for (const [type, handler] of (onMessage as unknown as AnyMock).mock.calls) {
  handlers.set(type, handler);
}

function makeRule(overrides: Record<string, unknown> = {}): any {
  return {
    id: 12345,
    priority: 1,
    action: { type: "modifyHeaders", requestHeaders: [{ header: "origin", operation: "set", value: "x" }] },
    condition: { regexFilter: "^https://api\\.example\\.com/v1/thing$", resourceTypes: ["xmlhttprequest"] },
    ...overrides,
  };
}

describe("updateDNRSessionRules", () => {
  beforeEach(() => {
    updateSessionRules.mockReset();
    updateSessionRules.mockResolvedValue(undefined);
  });

  it("合法规则：先按 id 移除再安装（幂等重装），并把规则圈定到扩展自身发起的请求", async () => {
    const rule = makeRule({ condition: { regexFilter: "^https://x$", excludedTabIds: [1, 2] } });

    await handlers.get("updateDNRSessionRules")!({ data: { rule } });

    expect(updateSessionRules).toHaveBeenCalledTimes(1);
    const call = updateSessionRules.mock.calls[0]![0];
    expect(call.removeRuleIds).toEqual([12345]);
    expect(call.addRules).toHaveLength(1);
    expect(call.addRules[0].condition.initiatorDomains).toEqual(["test-extension-id"]);
    expect(call.addRules[0].condition.excludedTabIds).toBeUndefined();
  });

  it("id 非法时 reject 且不调用 updateSessionRules（避免把无效规则当成安装成功）", async () => {
    for (const id of [0, -1, 1.5, Number.NaN]) {
      await expect(handlers.get("updateDNRSessionRules")!({ data: { rule: makeRule({ id }) } })).rejects.toThrow(
        /invalid DNR session rule id/,
      );
    }
    expect(updateSessionRules).not.toHaveBeenCalled();
  });

  it("urlFilter 与 regexFilter 同时存在时 reject（Chrome 会直接拒绝安装）", async () => {
    const rule = makeRule({ condition: { regexFilter: "^https://x$", urlFilter: "https://x" } });

    await expect(handlers.get("updateDNRSessionRules")!({ data: { rule } })).rejects.toThrow(
      /both urlFilter and regexFilter/,
    );
    expect(updateSessionRules).not.toHaveBeenCalled();
  });

  it("extOnly=false 时不注入 initiatorDomains", async () => {
    const rule = makeRule();

    await handlers.get("updateDNRSessionRules")!({ data: { rule, extOnly: false } });

    expect(updateSessionRules.mock.calls[0]![0].addRules[0].condition.initiatorDomains).toBeUndefined();
  });
});

describe("removeDNRSessionRuleById", () => {
  it("按 id 删除规则", async () => {
    await handlers.get("removeDNRSessionRuleById")!({ data: 999 });

    expect(updateSessionRules).toHaveBeenCalledWith({ removeRuleIds: [999] });
  });
});
