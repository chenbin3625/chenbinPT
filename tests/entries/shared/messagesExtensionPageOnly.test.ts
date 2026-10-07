/**
 * `checkAndExtendCookies` 的发送方限制回归测试（TESTS-2 派生条目）。
 *
 * 缺陷：该消息在用户开启 autoExtendCookies 时会真的 `chrome.cookies.set`
 * （src/entries/background/utils/cookies.ts），却不在 `extensionPageOnlyMessages` 名单里，
 * 于是任意站点的内容脚本都能让扩展去改写 cookie。
 *
 * 本用例只做行为断言（不检查源码字符串）：名单漏登记时第一条会立刻变红；
 * 第二条同时证明 offscreen（扩展页）这条唯一真实调用路径不受登记影响。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { originalOnMessage } = vi.hoisted(() => ({ originalOnMessage: vi.fn() }));

vi.mock("@webext-core/messaging", () => ({
  defineExtensionMessaging: () => ({
    sendMessage: vi.fn(),
    onMessage: originalOnMessage,
  }),
}));

vi.stubGlobal("__BROWSER__", "chrome");
vi.stubGlobal("chrome", {
  runtime: {
    id: "extension-id",
    getURL: (path: string) => `chrome-extension://extension-id/${path}`,
  },
});

const contentScriptSender = { id: "extension-id", url: "https://pt.example.com/details.php", tab: { id: 1 } };
// offscreen document 的 sender.url 是扩展页 URL（src/entries/offscreen/utils/userInfo.ts 唯一的调用方）
const offscreenSender = { id: "extension-id", url: "chrome-extension://extension-id/offscreen.html" };

async function registerAndGetWrapped() {
  const { onMessage } = await import("@/messages.ts");
  const handler = vi.fn(async () => undefined);
  onMessage("checkAndExtendCookies", handler);
  return { handler, wrapped: originalOnMessage.mock.calls.at(-1)![1] };
}

describe("checkAndExtendCookies 的发送方限制", () => {
  beforeEach(() => {
    originalOnMessage.mockReset();
  });

  it("内容脚本发送方被拒绝（它会写 cookie），handler 不被调用", async () => {
    const { handler, wrapped } = await registerAndGetWrapped();

    expect(() => wrapped({ data: "https://pt.example.com/", sender: contentScriptSender })).toThrow(/permission/i);
    expect(handler).not.toHaveBeenCalled();
  });

  it("offscreen（扩展页）调用不受影响：放行并真的执行 handler", async () => {
    const { handler, wrapped } = await registerAndGetWrapped();

    await expect(wrapped({ data: "https://pt.example.com/", sender: offscreenSender })).resolves.toBeUndefined();
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ data: "https://pt.example.com/" }));
  });
});
