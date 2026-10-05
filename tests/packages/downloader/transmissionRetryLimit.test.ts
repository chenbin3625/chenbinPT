/**
 * Transmission 409（session id 过期）重试上限回归（缺陷清单 H-4）。
 *
 * 缺陷：`request()` 捕获 409 后递归调用自己，没有重试计数。服务端持续返回 409 时
 * （地址指向非 Transmission 服务、反向代理配置错误等）会无限递归，最终栈溢出 / 页面卡死。
 *
 * 断言要点：
 * 1. 持续 409 → 抛出错误（拒绝），且只多发了一次请求；
 * 2. 409 后失败一次即成功 → 用服务端下发的新 session id 重试并返回结果（正常自愈路径不变）；
 * 3. 非 409 错误不重试，原样抛出。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { axiosMock } = vi.hoisted(() => ({
  axiosMock: {
    post: vi.fn(),
    // @ptd/downloader/utils/adapter 在模块加载期就会 `axios.create()` 并挂拦截器
    create: vi.fn(() => ({
      interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } },
    })),
  },
}));

vi.mock("axios", () => ({
  default: axiosMock,
  isAxiosError: (error: any) => Boolean(error?.isAxiosError),
}));
vi.mock("@ptd/site/utils/adapter.ts", () => ({ logMessage: vi.fn() }));

// 下载器实体经由 @ptd/downloader/utils → entries/messages.ts 引入平台适配层，
// 该模块在加载期就要读 __BROWSER__ 与 chrome API，因此必须先 stub 再 import。
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
});

const { default: Transmission } = await import("@ptd/downloader/entity/Transmission.ts");

function conflict(sessionId = "sid-from-server") {
  return Object.assign(new Error("Conflict"), {
    isAxiosError: true,
    response: { status: 409, headers: { "x-transmission-session-id": sessionId } },
  });
}

const createClient = () =>
  new Transmission({
    type: "Transmission",
    name: "Transmission",
    address: "http://tr.local:9091/transmission/rpc",
    username: "u",
    password: "p",
    timeout: 1000,
  } as any);

describe("Transmission.request：409 重试上限（H-4）", () => {
  beforeEach(() => {
    axiosMock.post.mockReset();
  });

  it("持续 409 时抛出错误，且只重试一次（修复前会无限递归）", async () => {
    axiosMock.post.mockRejectedValue(conflict());

    await expect(createClient().request("session-get")).rejects.toThrow("Conflict");
    expect(axiosMock.post).toHaveBeenCalledTimes(2); // 首次 + 1 次重试
  });

  it("409 → 成功：用服务端下发的 session id 重试并返回结果", async () => {
    axiosMock.post.mockRejectedValueOnce(conflict("sid-1")).mockResolvedValueOnce({ data: { result: "success" } });

    const response = await createClient().request<{ result: string }>("session-get");

    expect(response.data.result).toBe("success");
    expect(axiosMock.post).toHaveBeenCalledTimes(2);
    expect(axiosMock.post.mock.calls[1]![2].headers["X-Transmission-Session-Id"]).toBe("sid-1");
  });

  it("非 409 错误原样抛出，不重试", async () => {
    axiosMock.post.mockRejectedValue(
      Object.assign(new Error("Unauthorized"), { isAxiosError: true, response: { status: 401 } }),
    );

    await expect(createClient().request("session-get")).rejects.toThrow("Unauthorized");
    expect(axiosMock.post).toHaveBeenCalledTimes(1);
  });
});
