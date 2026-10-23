/**
 * DNR 会话规则生命周期测试（见 docs/performance-audit.md P1-9）。
 *
 * 本轮重构把「每请求 install + 响应后 remove」改成了 30s 空闲 TTL 复用，引入了三个回归：
 * - 安装失败也先写缓存：后续命中缓存直接返回，unsafe header 静默丢失；
 * - 并发请求不断把 expireAt 往后推，规则长期常驻并改写所有匹配的扩展请求；
 * - 规则 id 用 Math.random()，同上下文多实例（offscreen 的 axios 与 socialRecommendations）
 *   可能撞号，删除时误删别人的规则。
 *
 * 这里用假的 axios 实例 + 假 sendMessage 做行为验证：
 * - id 必须由 cacheKey 确定性派生且为正整数；
 * - URL 必须转义成 regexFilter（urlFilter 的 `|`/`*`/`^` 是保留语法且无法转义）；
 * - 并发同 key 请求只安装一次，最后一个请求结束/失败才按 id 删除规则；
 * - 安装失败不写缓存，后续请求会重试。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/messages.ts", () => ({
  sendMessage: vi.fn(),
  onMessage: vi.fn(),
}));

type AnyMock = ReturnType<typeof vi.fn>;

const { sendMessage } = await import("@/messages.ts");
const { dnrRuleIdForCacheKey, setupReplaceUnsafeHeader, toExactUrlRegexFilter } =
  await import("~/extends/axios/replaceUnsafeHeader.ts");

const sendMessageMock = sendMessage as unknown as AnyMock;

interface Interceptor {
  fulfilled: (value: any) => any;
  rejected?: (error: any) => any;
}

function createFakeAxios() {
  const requestInterceptors: Interceptor[] = [];
  const responseInterceptors: Interceptor[] = [];

  const instance: any = {
    interceptors: {
      request: {
        use: (fulfilled: Interceptor["fulfilled"], rejected?: Interceptor["rejected"]) =>
          requestInterceptors.push({ fulfilled, rejected }),
      },
      response: {
        use: (fulfilled: Interceptor["fulfilled"], rejected?: Interceptor["rejected"]) =>
          responseInterceptors.push({ fulfilled, rejected }),
      },
    },
    getUri: ({ baseURL, url, params }: any) => {
      const target = new URL(url, baseURL ?? "https://example.com/");
      for (const [key, value] of Object.entries(params ?? {})) {
        target.searchParams.set(key, String(value));
      }
      return target.href;
    },
  };

  return { instance, requestInterceptors, responseInterceptors };
}

function createHeaders(init: Record<string, string>) {
  const store = new Map(Object.entries(init));
  return {
    store,
    [Symbol.iterator]: () => store.entries(),
    delete: (key: string) => store.delete(key),
  };
}

let configSeq = 0;

function makeConfig(overrides: Record<string, unknown> = {}): any {
  configSeq++;
  return {
    baseURL: "https://api.example.com",
    // 默认每条请求用不同的 URL，避免用例之间通过模块级 dnrRuleCache 互相污染
    url: `/v1/thing-${configSeq}`,
    method: "post",
    headers: createHeaders({ "user-agent": "PTD", "content-type": "application/json" }),
    ...overrides,
  };
}

function callsOf(type: string): any[][] {
  return sendMessageMock.mock.calls.filter(([callType]) => callType === type);
}

describe("dnrRuleIdForCacheKey", () => {
  it("同一 key 稳定，不同 key 不同，且是正整数（DNR 要求 id >= 1）", () => {
    const id = dnrRuleIdForCacheKey('{"url":"https://a.example/x|y"}');
    expect(dnrRuleIdForCacheKey('{"url":"https://a.example/x|y"}')).toBe(id);
    expect(Number.isInteger(id)).toBe(true);
    expect(id).toBeGreaterThan(0);
    expect(dnrRuleIdForCacheKey('{"url":"https://a.example/other"}')).not.toBe(id);
  });
});

describe("toExactUrlRegexFilter", () => {
  it("转义 DNR/RE2 保留字符，只匹配整条 URL（不再把 `|`/`*`/`^` 当过滤器语法）", () => {
    const url = "https://api.example.com/v1/a|b*c^d?q=1+2";
    const filter = toExactUrlRegexFilter(url);
    const re = new RegExp(filter);

    expect(re.test(new URL(url).href)).toBe(true);
    expect(re.test("https://api.example.com/v1/a")).toBe(false);
    expect(filter).toContain("\\|");
    expect(filter).toContain("\\*");
    expect(filter).toContain("\\?");
    expect(filter.startsWith("^")).toBe(true);
    expect(filter.endsWith("$")).toBe(true);
  });

  it("允许 query/fragment 后缀（兼容旧 urlFilter 的子串匹配语义），但不匹配同前缀的其它路径", () => {
    const re = new RegExp(toExactUrlRegexFilter("https://api.example.com/v1/thing"));
    expect(re.test("https://api.example.com/v1/thing?x=1")).toBe(true);
    expect(re.test("https://api.example.com/v1/thing#frag")).toBe(true);
    expect(re.test("https://api.example.com/v1/thing-else")).toBe(false);
  });

  it("对非 ASCII URL 先做 URL 归一化，保证 regexFilter 只含 ASCII 字符", () => {
    const filter = toExactUrlRegexFilter("https://例子.com/路径?q=值");
    expect(/^[\x00-\x7F]*$/.test(filter)).toBe(true);
    expect(new RegExp(filter).test(new URL("https://例子.com/路径?q=值").href)).toBe(true);
  });

  it("输入 URL 自带 fragment 时仍匹配实际无 fragment 的网络请求", () => {
    const re = new RegExp(toExactUrlRegexFilter("https://api.example.com/v1/thing?q=1#details"));
    expect(re.test("https://api.example.com/v1/thing?q=1")).toBe(true);
    expect(re.test("https://api.example.com/v1/thing?q=1#details")).toBe(true);
    expect(re.test("https://api.example.com/v1/thing?q=2")).toBe(false);
  });
});

describe("DNR 规则生命周期", () => {
  beforeEach(() => {
    sendMessageMock.mockReset();
    sendMessageMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    // 个别用例用假时钟验证「等在途删除的上限」，失败/超时时也要还原
    vi.useRealTimers();
  });

  it("并发同 key 只安装一次，最后一个请求结束才按 id 删除规则", async () => {
    const { instance, requestInterceptors, responseInterceptors } = createFakeAxios();
    setupReplaceUnsafeHeader(instance);

    const first = makeConfig({ url: "/v1/same" });
    const second = makeConfig({ url: "/v1/same" });

    await Promise.all([requestInterceptors[0]!.fulfilled(first), requestInterceptors[0]!.fulfilled(second)]);

    const installCalls = callsOf("updateDNRSessionRules");
    expect(installCalls).toHaveLength(1);
    const rule = installCalls[0]![1].rule;
    expect(rule.condition.urlFilter).toBeUndefined();
    expect(rule.condition.regexFilter).toBeTruthy();
    expect(rule.condition.requestMethods).toEqual(["post"]);
    // 两个并发请求共享同一个确定性 id
    expect(first.dummyHeaderRequestId).toBe(rule.id);
    expect(second.dummyHeaderRequestId).toBe(rule.id);

    // 第一个请求结束：仍有一个在途请求，规则必须保留
    responseInterceptors[0]!.fulfilled({ config: first });
    expect(callsOf("removeDNRSessionRuleById")).toHaveLength(0);

    // 最后一个请求结束：按同一个 id 精确删除
    responseInterceptors[0]!.fulfilled({ config: second });
    const removeCalls = callsOf("removeDNRSessionRuleById");
    expect(removeCalls).toHaveLength(1);
    expect(removeCalls[0]![1]).toBe(rule.id);
  });

  it("安装失败不写缓存：同一 key 的下一个请求会重新安装（可重试）", async () => {
    const { instance, requestInterceptors } = createFakeAxios();
    setupReplaceUnsafeHeader(instance);

    // G13：必须复用**同一个 URL**。旧用例两次 makeConfig() 会自增出不同 URL，
    // 而 dnrRuleCache 的 key 含 URL —— 即使旧实现「失败也写缓存」，第二个请求也是新 key、
    // 照样会安装，用例抓不到回归。这里固定 url，让第二次请求真的命中同一个 key。
    const url = "/v1/fail-retry";

    sendMessageMock.mockRejectedValueOnce(new Error("install failed"));
    await expect(requestInterceptors[0]!.fulfilled(makeConfig({ url }))).rejects.toThrow("install failed");
    expect(callsOf("updateDNRSessionRules")).toHaveLength(1);

    // 旧实现会把失败的规则留在缓存里，第二个请求直接命中缓存不再安装 → header 丢失
    await requestInterceptors[0]!.fulfilled(makeConfig({ url }));
    expect(callsOf("updateDNRSessionRules")).toHaveLength(2);
  });

  it("请求失败同样释放规则，不退化成 TTL 常驻（同一 key 复验）", async () => {
    const { instance, requestInterceptors, responseInterceptors } = createFakeAxios();
    setupReplaceUnsafeHeader(instance);

    // G13：同上，第二次请求必须与第一次同 key，才能证明「规则真的被释放」
    const url = "/v1/release-retry";
    const config = makeConfig({ url });
    await requestInterceptors[0]!.fulfilled(config);

    const error = { config };
    await expect(responseInterceptors[0]!.rejected!(error)).rejects.toBe(error);
    expect(callsOf("removeDNRSessionRuleById")).toHaveLength(1);

    // 规则删除后，同 key 的新请求必须重新安装（旧 TTL 实现会命中残留缓存，不会安装）
    await requestInterceptors[0]!.fulfilled(makeConfig({ url }));
    expect(callsOf("updateDNRSessionRules")).toHaveLength(2);
  });

  it("删除与重装串行化：同 key 的下一次安装会等同 id 的删除完成（G2）", async () => {
    const { instance, requestInterceptors, responseInterceptors } = createFakeAxios();
    setupReplaceUnsafeHeader(instance);

    const url = "/v1/serialized-removal";
    let releaseRemoval!: () => void;
    sendMessageMock.mockImplementation((type: string) => {
      if (type === "removeDNRSessionRuleById") {
        // 删除消息在途（模拟 background 处理 remove 晚于 update 的乱序窗口）
        return new Promise<void>((resolve) => {
          releaseRemoval = resolve;
        });
      }
      return Promise.resolve(undefined);
    });

    // 第一次请求安装 → 结束 → 发出删除（此时删除 promise 挂起）
    const first = makeConfig({ url });
    await requestInterceptors[0]!.fulfilled(first);
    responseInterceptors[0]!.fulfilled({ config: first });
    expect(callsOf("removeDNRSessionRuleById")).toHaveLength(1);
    expect(callsOf("updateDNRSessionRules")).toHaveLength(1);

    // 同一内容的下一条请求：删除还没完成，安装必须排在它之后（不能出现 remove 覆盖 update）
    const second = makeConfig({ url });
    let secondSettled = false;
    const pendingSecond = requestInterceptors[0]!.fulfilled(second).then(() => {
      secondSettled = true;
    });
    // 多轮微任务后仍不应安装（说明在等删除完成，而不是依赖隐式的消息顺序）
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(callsOf("updateDNRSessionRules")).toHaveLength(1);
    expect(secondSettled).toBe(false);

    releaseRemoval();
    await pendingSecond;
    expect(callsOf("updateDNRSessionRules")).toHaveLength(2);
    expect(secondSettled).toBe(true);
  });

  it("删除消息卡住时安装最多等 5s，不会永久排队（G2 活性兜底）", async () => {
    vi.useFakeTimers();
    const { instance, requestInterceptors, responseInterceptors } = createFakeAxios();
    setupReplaceUnsafeHeader(instance);

    const url = "/v1/stuck-removal";
    // 删除消息永不 resolve（模拟 background 被杀/端口挂起）
    sendMessageMock.mockImplementation((type: string) => {
      if (type === "removeDNRSessionRuleById") return new Promise<void>(() => undefined);
      return Promise.resolve(undefined);
    });

    const first = makeConfig({ url });
    await requestInterceptors[0]!.fulfilled(first);
    responseInterceptors[0]!.fulfilled({ config: first });

    const second = makeConfig({ url });
    let secondSettled = false;
    const pendingSecond = requestInterceptors[0]!.fulfilled(second).then(() => {
      secondSettled = true;
    });
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(callsOf("updateDNRSessionRules")).toHaveLength(1);
    expect(secondSettled).toBe(false);

    // 超过 5s 的等待上限后排空安装（否则「安装」会被一条卡死的删除消息永久挂住）
    await vi.advanceTimersByTimeAsync(5_001);
    await pendingSecond;
    expect(secondSettled).toBe(true);
    expect(callsOf("updateDNRSessionRules")).toHaveLength(2);
  });

  it("带 params 的请求把查询串一起纳入匹配（regexFilter 是精确匹配）", async () => {
    const { instance, requestInterceptors } = createFakeAxios();
    setupReplaceUnsafeHeader(instance);

    await requestInterceptors[0]!.fulfilled(makeConfig({ url: "/v1/thing", params: { page: 2 } }));

    const rule = callsOf("updateDNRSessionRules")[0]![1].rule;
    const re = new RegExp(rule.condition.regexFilter);
    expect(re.test("https://api.example.com/v1/thing?page=2")).toBe(true);
  });
});
