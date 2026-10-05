/**
 * AbstractBittorrentSite.request() 的重试语义测试。
 *
 * 背景（见性能/健壮性审计）：request() 的注释声称对 429 / 5xx 做 1~2 次指数退避重试，
 * 但需要验证该分支在 axios 默认 validateStatus（只接受 2xx，非 2xx 会 reject）下确实可达：
 * axios reject 时 error.response 携带真实状态码，必须能进入重试判定，而不是被当作
 * 「解析错误」直接抛出。
 *
 * 这里 mock 掉平台适配层 adapter.ts（唯一与浏览器平台耦合的部分），
 * 以便精确控制 axios.request 的返回/抛出。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  isCloudflareBlocked: vi.fn(() => false),
  sleep: vi.fn(async (_ms?: number) => {}),
}));

vi.mock("@ptd/site/utils/adapter.ts", () => ({
  axios: { request: mocks.request },
  isCloudflareBlocked: mocks.isCloudflareBlocked,
  retrieve: vi.fn(async () => null),
  sleep: mocks.sleep,
  store: vi.fn(async () => {}),
  logMessage: vi.fn(),
}));

// 站点 schema 会连带引入 @ptd/social 等运行时模块（messages.ts 用到 __BROWSER__ 与 chrome API），
// 这里给出最小桩，避免为一次纯请求逻辑测试去跑整个扩展环境。
vi.stubGlobal("__BROWSER__", "chrome");
vi.stubGlobal("chrome", {
  storage: {
    local: {
      get: () => Promise.resolve({}),
      set: () => Promise.resolve(),
      remove: () => Promise.resolve(),
      onChanged: { addListener: () => {}, removeListener: () => {} },
    },
    onChanged: { addListener: () => {}, removeListener: () => {} },
  },
  runtime: {
    id: "test",
    onMessage: { addListener: () => undefined, removeListener: () => undefined },
    sendMessage: () => Promise.resolve(undefined),
    getURL: (path: string) => `chrome-extension://test/${path}`,
  },
  cookies: { get: () => Promise.resolve(null), set: () => Promise.resolve(), getAll: () => Promise.resolve([]) },
  downloads: { download: () => Promise.resolve(1) },
  tabs: { create: () => Promise.resolve(), query: () => Promise.resolve([]) },
});

const { default: BittorrentSite } = await import("@ptd/site/schemas/AbstractBittorrentSite.ts");
const { default: PrivateSite } = await import("@ptd/site/schemas/AbstractPrivateSite.ts");
const { CFBlockedError, EResultParseStatus } = await import("@ptd/site/types.ts");
const { NetworkError, ServerError } = await import("@ptd/site/utils/error.ts");

const metadata = {
  id: "test",
  name: "Test Site",
  type: "private",
  urls: ["https://example.com/"],
} as any;

/** 构造一个「axios 拒绝并携带响应」的错误，模拟 429/5xx 在默认 validateStatus 下的表现 */
function axiosRejectedResponse(status: number, statusText = "") {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    isAxiosError: true,
    response: { status, statusText, data: null, headers: {}, config: {} },
  });
}

function newSite() {
  return new BittorrentSite(metadata, {});
}

describe("AbstractBittorrentSite.request 重试", () => {
  beforeEach(() => {
    mocks.request.mockReset();
    mocks.sleep.mockReset();
    mocks.sleep.mockResolvedValue(undefined);
    mocks.isCloudflareBlocked.mockReset();
    mocks.isCloudflareBlocked.mockReturnValue(false);
  });

  it("429 后重试成功：把 error.response 当作可重试状态码而不是直接失败", async () => {
    mocks.request
      .mockRejectedValueOnce(axiosRejectedResponse(429, "Too Many Requests"))
      .mockResolvedValueOnce({ status: 200, data: "ok", statusText: "OK", headers: {}, config: {} });

    const resp = await newSite().request({ url: "/" }, false);

    expect(resp.status).toBe(200);
    expect(mocks.request).toHaveBeenCalledTimes(2);
  });

  it("5xx 后重试成功（500/502/503/504 均属于可重试）", async () => {
    mocks.request
      .mockRejectedValueOnce(axiosRejectedResponse(503, "Service Unavailable"))
      .mockResolvedValueOnce({ status: 200, data: "ok", statusText: "OK", headers: {}, config: {} });

    const resp = await newSite().request({ url: "/" }, false);

    expect(resp.status).toBe(200);
    expect(mocks.request).toHaveBeenCalledTimes(2);
  });

  it("429 连续失败：达到上限（共 3 次尝试）后抛 ServerError", async () => {
    mocks.request.mockRejectedValue(axiosRejectedResponse(429, "Too Many Requests"));

    await expect(newSite().request({ url: "/" }, false)).rejects.toBeInstanceOf(ServerError);
    expect(mocks.request).toHaveBeenCalledTimes(3); // 1 次初始 + 2 次重试
    // 指数退避：500ms、1000ms
    expect(mocks.sleep.mock.calls.map((c) => c[0])).toEqual([500, 1000]);
  });

  it("非可重试的 4xx 不重试，直接抛 ServerError", async () => {
    mocks.request.mockRejectedValue(axiosRejectedResponse(404, "Not Found"));

    await expect(newSite().request({ url: "/" }, false)).rejects.toBeInstanceOf(ServerError);
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });

  it("网络错误（无 response）保持既有重试行为，最终抛 NetworkError", async () => {
    mocks.request.mockRejectedValue(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }));

    await expect(newSite().request({ url: "/" }, false)).rejects.toBeInstanceOf(NetworkError);
    expect(mocks.request).toHaveBeenCalledTimes(3);
  });

  it("网络错误后重试成功", async () => {
    mocks.request
      .mockRejectedValueOnce(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }))
      .mockResolvedValueOnce({ status: 200, data: "ok", statusText: "OK", headers: {}, config: {} });

    const resp = await newSite().request({ url: "/" }, false);
    expect(resp.status).toBe(200);
    expect(mocks.request).toHaveBeenCalledTimes(2);
  });

  it("ERR_CANCELED 取消不重试，抛 NetworkError", async () => {
    mocks.request.mockRejectedValue(Object.assign(new Error("canceled"), { code: "ERR_CANCELED" }));

    await expect(newSite().request({ url: "/" }, false)).rejects.toBeInstanceOf(NetworkError);
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });

  it("Cloudflare 拦截不重试，抛 CFBlockedError", async () => {
    mocks.request.mockRejectedValue(axiosRejectedResponse(403, "Forbidden"));
    mocks.isCloudflareBlocked.mockReturnValue(true);

    await expect(newSite().request({ url: "/" }, false)).rejects.toBeInstanceOf(CFBlockedError);
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });

  it("分类结果：ServerError 会被 classifySiteError 归为可重试的 unknownError", async () => {
    const { classifySiteError } = await import("@ptd/site/utils/error.ts");
    const classified = classifySiteError(new ServerError("Network Error: 429"));
    expect(classified.status).toBe(EResultParseStatus.unknownError);
    expect(classified.retryable).toBe(true);
  });
});

describe("站点登录检查和 Cloudflare 邮箱解码", () => {
  it("登录断言遇到不可读响应时拒绝将其视为已登录", () => {
    class CheckSite extends PrivateSite {
      check(response: any) {
        return this.loggedCheck(response);
      }
    }
    const site = new CheckSite(metadata);
    const request = {
      get responseURL() {
        throw new Error("invalid response");
      },
    };
    expect(site.check({ status: 200, request, headers: {}, data: "ok" })).toBe(false);
  });

  it("没有 Cloudflare 邮箱标记的文档不做 DOM 邮箱查询", async () => {
    const doc = document.implementation.createHTMLDocument("normal");
    const query = vi.spyOn(doc, "querySelectorAll");
    mocks.request.mockResolvedValue({ status: 200, headers: {}, data: doc, request: {} });

    await newSite().request({ url: "/", responseType: "document" }, false);

    expect(query).not.toHaveBeenCalled();
  });
});
