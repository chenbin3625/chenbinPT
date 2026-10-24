/**
 * WXT 迁移后的内容脚本 UI 注入链路：
 * 引导（content.js）→ `injectContentScriptApp` → 后台 `scripting.executeScript` → UI（cs-app.js）。
 *
 * 锁定三件事：
 * 1. 后台只按 `sender` 定位注入目标，非本扩展内容脚本的请求一律拒绝；
 * 2. 有 documentId 时锁定文档（引导到注入之间发生导航时不会注入到新页面），旧版 Firefox（<153）回落到 frameId；
 * 3. UI 侧只消费一次交接参数、同一 frame 只挂载一次。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (message: { data?: unknown; sender?: chrome.runtime.MessageSender }) => unknown>(),
  executeScript: vi.fn(async () => [] as unknown[]),
  mountApp: vi.fn(),
}));

vi.mock("@/messages.ts", () => ({
  onMessage: (type: string, handler: any) => mocks.handlers.set(type, handler),
  sendMessage: vi.fn(),
}));
vi.mock("@/content-script/app/init.ts", () => ({ mountApp: mocks.mountApp }));

vi.stubGlobal("chrome", {
  runtime: { id: "ptd-extension-id" },
  scripting: { executeScript: mocks.executeScript },
});

const { getContentScriptAppInjectionTarget } = await import("@/background/utils/contentScriptApp.ts");
const { CONTENT_SCRIPT_APP_FILE, setContentScriptAppProps, takeContentScriptAppProps } =
  await import("@/shared/contentScriptApp.ts");

const contentScriptSender = (extra: Partial<chrome.runtime.MessageSender> = {}): chrome.runtime.MessageSender => ({
  id: "ptd-extension-id",
  tab: { id: 42 } as chrome.tabs.Tab,
  frameId: 0,
  url: "https://pt.example/torrents.php",
  ...extra,
});

describe("后台：注入目标只取自 sender", () => {
  it("有 documentId（Chrome 106+ / Firefox 153+）时按文档注入", () => {
    expect(getContentScriptAppInjectionTarget(contentScriptSender({ documentId: "doc-1" }))).toEqual({
      tabId: 42,
      documentIds: ["doc-1"],
    });
  });

  it("旧版 Firefox（<153）：没有 documentId 时回落到发送方 frame", () => {
    expect(getContentScriptAppInjectionTarget(contentScriptSender({ frameId: 3 }))).toEqual({
      tabId: 42,
      frameIds: [3],
    });
    expect(getContentScriptAppInjectionTarget(contentScriptSender({ frameId: undefined }))).toEqual({
      tabId: 42,
      frameIds: [0],
    });
  });

  it.each([
    ["没有 sender", undefined],
    ["其它扩展", contentScriptSender({ id: "other-extension" })],
    ["扩展页（没有 tab）", { id: "ptd-extension-id", url: "chrome-extension://ptd-extension-id/options.html" }],
  ])("拒绝：%s", (_name, sender) => {
    expect(() => getContentScriptAppInjectionTarget(sender as chrome.runtime.MessageSender | undefined)).toThrow(
      /content script of this extension/,
    );
  });

  it("消息处理函数把 cs-app.js 注入发送方所在的文档", async () => {
    const handler = mocks.handlers.get("injectContentScriptApp");
    expect(handler).toBeTypeOf("function");

    await handler!({ data: undefined, sender: contentScriptSender({ documentId: "doc-9" }) });

    expect(CONTENT_SCRIPT_APP_FILE).toBe("content-scripts/cs-app.js");
    expect(mocks.executeScript).toHaveBeenCalledWith({
      target: { tabId: 42, documentIds: ["doc-9"] },
      files: ["content-scripts/cs-app.js"],
    });
  });
});

describe("UI 侧：交接参数只消费一次，同一 frame 只挂载一次", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.mountApp.mockReset();
    delete (globalThis as any).__ptdContentScriptAppProps__;
    delete (globalThis as any).__ptdContentScriptAppMounted__;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("take 之后参数被清除", () => {
    setContentScriptAppProps({ siteId: "a" });
    expect(takeContentScriptAppProps()).toEqual({ siteId: "a" });
    expect(takeContentScriptAppProps()).toBeUndefined();
  });

  it("有交接参数时挂载一次；重复注入不会再次挂载", async () => {
    vi.spyOn(console, "debug").mockImplementation(() => {});
    const { runContentScriptApp } = await import("@/content-script/app/entry.ts");

    setContentScriptAppProps({ siteId: "a", config: {} });
    runContentScriptApp();
    expect(mocks.mountApp).toHaveBeenCalledTimes(1);
    expect(mocks.mountApp).toHaveBeenCalledWith(document, { siteId: "a", config: {} });

    setContentScriptAppProps({ siteId: "a", config: {} });
    runContentScriptApp();
    expect(mocks.mountApp).toHaveBeenCalledTimes(1);
  });

  it("没有交接参数（不是经由引导链注入）时不挂载", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { runContentScriptApp } = await import("@/content-script/app/entry.ts");

    runContentScriptApp();

    expect(mocks.mountApp).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it("挂载抛错时在 UI 侧记录，不向外抛（executeScript 早已返回，没有调用方能接住）", async () => {
    vi.spyOn(console, "debug").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.mountApp.mockImplementation(() => {
      throw new Error("boom");
    });
    const { runContentScriptApp } = await import("@/content-script/app/entry.ts");

    setContentScriptAppProps({ siteId: "a" });
    expect(() => runContentScriptApp()).not.toThrow();
    expect(error).toHaveBeenCalledWith("[PTD] content script app failed to mount:", expect.any(Error));
  });
});
