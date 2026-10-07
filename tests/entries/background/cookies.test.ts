/**
 * `setCookie` 覆盖判定回归测试（BACKGROUNDSHARED-3）。
 *
 * 缺陷：`setCookie(cookie, force)` 的消息契约（messages.ts:120）只声明 `chrome.cookies.SetDetails`，
 * 调用方（extends/axios/retryWhenCloudflareBlock.ts 的 CF 重试、offscreen/utils/backup.ts 的备份恢复）
 * 都无法表达 force，于是全部落到「已存在且未过期就跳过」的静默分支：
 * - CF 重试用不上新解出的 cf_clearance；
 * - 备份恢复不覆盖旧值、也不延长有效期，但报告仍无条件宣称 cookies 已恢复。
 *
 * 修复：同名未过期时，只要值不同、或新过期时间更晚就覆盖；值相同且不更晚时跳过（此时跳过是等价的）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  onMessage: vi.fn(),
  sendMessage: vi.fn(),
  logBackgroundError: vi.fn(),
  cookiesGet: vi.fn(),
  cookiesSet: vi.fn(),
  storageGetItem: vi.fn(),
}));

vi.mock("@/messages.ts", () => ({ onMessage: mocks.onMessage, sendMessage: mocks.sendMessage }));

vi.mock("@/background/utils/base.ts", () => ({ logBackgroundError: mocks.logBackgroundError }));

vi.mock("@/storage.ts", () => ({ extStorage: { getItem: mocks.storageGetItem, setItem: vi.fn() } }));

vi.stubGlobal("chrome", {
  cookies: {
    get: mocks.cookiesGet,
    set: mocks.cookiesSet,
  },
});
vi.stubGlobal("__BROWSER__", "chrome");

const { setCookie } = await import("@/background/utils/cookies.ts");

const nowSeconds = () => Math.floor(Date.now() / 1000);

/** 同域同名但值不同的新 cookie（CF 重试解出的新 cf_clearance / 备份里的 cookie） */
function newCookie(overrides: Partial<chrome.cookies.SetDetails> = {}): chrome.cookies.SetDetails {
  return {
    name: "cf_clearance",
    value: "new-value",
    domain: "site.example",
    path: "/",
    secure: true,
    // setCookie 内部会用 buildCookieUrl 重算 url，这里给一个合法值只为满足 SetDetails 类型
    url: "https://site.example/",
    ...overrides,
  };
}

describe("setCookie 覆盖判定（BACKGROUNDSHARED-3）", () => {
  beforeEach(() => {
    mocks.cookiesGet.mockReset();
    mocks.cookiesSet.mockReset();
    mocks.logBackgroundError.mockReset();
    mocks.cookiesSet.mockResolvedValue(undefined);
  });

  it("同名未过期但值不同 → 覆盖（CF 重试必须用上新解出的 cf_clearance）", async () => {
    mocks.cookiesGet.mockResolvedValue({ name: "cf_clearance", value: "stale", expirationDate: nowSeconds() + 3600 });

    await setCookie(newCookie());

    expect(mocks.cookiesSet).toHaveBeenCalledTimes(1);
    expect(mocks.cookiesSet.mock.calls[0]![0]).toMatchObject({ name: "cf_clearance", value: "new-value" });
  });

  it("同名未过期、值相同但新过期时间更晚 → 覆盖（备份恢复会延长有效期）", async () => {
    mocks.cookiesGet.mockResolvedValue({
      name: "cf_clearance",
      value: "new-value",
      expirationDate: nowSeconds() + 60,
    });

    await setCookie(newCookie({ value: "new-value", expirationDate: nowSeconds() + 86400 }));

    expect(mocks.cookiesSet).toHaveBeenCalledTimes(1);
  });

  it("同名未过期、值相同且有效期不更晚 → 跳过（此时写入与不写入等价，不影响既有调用方）", async () => {
    mocks.cookiesGet.mockResolvedValue({
      name: "cf_clearance",
      value: "new-value",
      expirationDate: nowSeconds() + 3600,
    });

    await setCookie(newCookie({ value: "new-value" }));

    expect(mocks.cookiesSet).not.toHaveBeenCalled();
  });

  it("force=true（checkAndExtendCookies 走这条路）即使值相同也覆盖", async () => {
    mocks.cookiesGet.mockResolvedValue({
      name: "cf_clearance",
      value: "new-value",
      expirationDate: nowSeconds() + 3600,
    });

    await setCookie(newCookie({ value: "new-value" }), true);

    expect(mocks.cookiesSet).toHaveBeenCalledTimes(1);
  });

  it("不存在的 cookie 与已过期的 cookie 仍然照常写入", async () => {
    mocks.cookiesGet.mockResolvedValue(null);
    await expect(setCookie(newCookie())).resolves.toBe(true);
    expect(mocks.cookiesSet).toHaveBeenCalledTimes(1);

    mocks.cookiesSet.mockClear();
    mocks.cookiesGet.mockResolvedValue({ name: "cf_clearance", value: "new-value", expirationDate: nowSeconds() - 10 });
    await expect(setCookie(newCookie({ value: "new-value" }))).resolves.toBe(true);
    expect(mocks.cookiesSet).toHaveBeenCalledTimes(1);
  });

  it("chrome.cookies.set 拒绝时返回 false，让恢复报告不能把失败写入计为成功", async () => {
    mocks.cookiesGet.mockResolvedValue(null);
    mocks.cookiesSet.mockRejectedValue(new Error("cookie rejected"));

    await expect(setCookie(newCookie())).resolves.toBe(false);

    expect(mocks.logBackgroundError).toHaveBeenCalledTimes(1);
  });

  it("chrome.cookies.set 以 null 表示未写入时同样返回 false", async () => {
    mocks.cookiesGet.mockResolvedValue(null);
    mocks.cookiesSet.mockResolvedValue(null);

    await expect(setCookie(newCookie())).resolves.toBe(false);
  });

  it("目标 cookie 已经等价存在时返回 true（无需重写也算达到目标状态）", async () => {
    mocks.cookiesGet.mockResolvedValue({
      name: "cf_clearance",
      value: "new-value",
      expirationDate: nowSeconds() + 3600,
    });

    await expect(setCookie(newCookie({ value: "new-value" }))).resolves.toBe(true);
    expect(mocks.cookiesSet).not.toHaveBeenCalled();
  });
});
