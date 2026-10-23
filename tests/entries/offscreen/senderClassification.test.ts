/**
 * 发送方分类与 sender↔站点绑定的行为测试（2026-10-24 修复轮 2，task-9）。
 *
 * 对应问题：
 * - 复检 L2：`sender.url` 缺失的**扩展自身上下文**（MV3 service worker；Chrome < M140 不填 url）
 *   被当成不可信发送方拒绝 → 后台 → offscreen 的 logger / 下载结算 / 用户信息 / 原生桥全部静默失败；
 * - 并行审查 P1-1：三处 handler 用 `isContentScriptSender` 做绑定条件，外部扩展 sender（id 不匹配）
 *   两边都判 false → 跳过绑定（fail-open）。现在调用点改为 `!isExtensionPageSender`，且
 *   `assertSenderMatchesSite` 先校验 sender 属于本扩展；
 * - 并行审查 P2-3：`getSenderPageHttpUrls` 曾把 `sender.tab.url` 也作为候选，iframe 场景可能用
 *   顶层页 URL 放行 —— 现在只在 `sender.url` 缺失时才回落到 `tab.url`。
 */
import { describe, expect, it, vi } from "vitest";

vi.stubGlobal("__BROWSER__", "chrome");
vi.stubGlobal("chrome", {
  runtime: {
    id: "extension-id",
    getURL: (path: string) => `chrome-extension://extension-id/${path}`,
  },
});

const { assertSenderMatchesSite, getSenderPageHttpUrls, isContentScriptSender, isExtensionPageSender } =
  await import("@/offscreen/utils/sender.ts");

/** 只实现 assertSenderMatchesSite 需要的结构化能力 */
function makeSite(id: string, trustedHosts: string[] = ["a.example.com"]) {
  return {
    metadata: { id },
    isTrustedSiteUrl: (url: string) => {
      try {
        return trustedHosts.includes(new URL(url).hostname);
      } catch {
        return false;
      }
    },
  };
}

const contentScriptSender = (url: string): any => ({ id: "extension-id", url, tab: { id: 1, url } });
const extensionSender: any = { id: "extension-id", url: "chrome-extension://extension-id/offscreen.html" };
/** MV3 service worker 形态：无 url、无 tab（Chrome < M140 的真实取值） */
const serviceWorkerLikeSender: any = { id: "extension-id" };
/** 其它扩展：id 不匹配 */
const foreignExtensionSender: any = {
  id: "other-extension-id",
  url: "chrome-extension://other-extension-id/page.html",
};

describe("isExtensionPageSender：扩展自身上下文分类（fail-closed）", () => {
  it("扩展页 URL / 无 url 无 tab（SW）判定为可信扩展上下文", () => {
    expect(isExtensionPageSender(extensionSender)).toBe(true);
    expect(isExtensionPageSender(serviceWorkerLikeSender)).toBe(true);
  });

  it("内容脚本 / 无 url 但带 tab / 外部扩展 一律不是扩展上下文", () => {
    expect(isExtensionPageSender(contentScriptSender("https://a.example.com/x"))).toBe(false);
    expect(isExtensionPageSender({ id: "extension-id", tab: { id: 1 } } as any)).toBe(false);
    expect(isExtensionPageSender(foreignExtensionSender)).toBe(false);
    expect(isExtensionPageSender(undefined)).toBe(false);
  });

  it("扩展页即使在标签页里打开（带 tab）也仍然可信（按 url 判定）", () => {
    expect(
      isExtensionPageSender({
        id: "extension-id",
        url: "chrome-extension://extension-id/src/entries/options/index.html#/",
        tab: { id: 7 },
      } as any),
    ).toBe(true);
  });
});

describe("isContentScriptSender：仅表示「页面侧」，不用于权限判定", () => {
  it("内容脚本为 true；扩展自身上下文为 false", () => {
    expect(isContentScriptSender(contentScriptSender("https://a.example.com/x"))).toBe(true);
    expect(isContentScriptSender(serviceWorkerLikeSender)).toBe(false);
  });

  it("外部扩展不是「本扩展的内容脚本」（权限判定要配合 !isExtensionPageSender 使用）", () => {
    expect(isContentScriptSender(foreignExtensionSender)).toBe(false);
    // 但权限判定必须让它受绑定约束：
    expect(() => assertSenderMatchesSite(makeSite("a"), foreignExtensionSender)).toThrow(/Permission denied/);
  });
});

describe("getSenderPageHttpUrls：只信发送 frame 的 URL", () => {
  it("有 sender.url 时只用它，不混入 tab.url", () => {
    expect(
      getSenderPageHttpUrls({
        id: "extension-id",
        url: "https://a.example.com/details.php",
        tab: { id: 1, url: "https://other.example/" },
      } as any),
    ).toEqual(["https://a.example.com/details.php"]);
  });

  it("sender.url 存在但不是 http(s)（about:blank / sandboxed iframe）时不回落到 tab.url（P2-3）", () => {
    expect(
      getSenderPageHttpUrls({
        id: "extension-id",
        url: "about:blank",
        tab: { id: 1, url: "https://a.example.com/" },
      } as any),
    ).toEqual([]);
  });

  it("sender.url 完全缺失时才回落到 tab.url", () => {
    expect(getSenderPageHttpUrls({ id: "extension-id", tab: { id: 1, url: "https://a.example.com/" } } as any)).toEqual(
      ["https://a.example.com/"],
    );
  });

  it("非 http(s) 与非法 URL 被丢弃", () => {
    expect(getSenderPageHttpUrls({ id: "extension-id", url: "not-a-url" } as any)).toEqual([]);
    expect(getSenderPageHttpUrls(undefined)).toEqual([]);
  });
});

describe("assertSenderMatchesSite：sender 必须先属于本扩展（P1-1）", () => {
  it("扩展自身上下文（含无 url 的 SW 形态）直接放行", () => {
    expect(() => assertSenderMatchesSite(makeSite("a"), extensionSender)).not.toThrow();
    expect(() => assertSenderMatchesSite(makeSite("a"), serviceWorkerLikeSender)).not.toThrow();
  });

  it("内容脚本在站点可信 host 上放行，跨站拒绝", () => {
    expect(() => assertSenderMatchesSite(makeSite("a"), contentScriptSender("https://a.example.com/x"))).not.toThrow();
    expect(() => assertSenderMatchesSite(makeSite("a"), contentScriptSender("https://evil.example/x"))).toThrow(
      /Permission denied/,
    );
  });

  it("外部扩展 sender（id 不匹配）即使 url 指向可信站点页也拒绝", () => {
    expect(() =>
      assertSenderMatchesSite(makeSite("a"), {
        id: "other-extension-id",
        url: "https://a.example.com/details.php",
        tab: { id: 1 },
      } as any),
    ).toThrow(/not this extension/);
  });

  it("sender.url 为 about:blank 的 iframe 不能借 tab.url 的顶层可信页放行（P2-3）", () => {
    expect(() =>
      assertSenderMatchesSite(makeSite("a"), {
        id: "extension-id",
        url: "about:blank",
        tab: { id: 1, url: "https://a.example.com/" },
      } as any),
    ).toThrow(/not a verifiable site page/);
  });

  it("站点实例缺少可信 host 判据时 fail-closed", () => {
    expect(() =>
      assertSenderMatchesSite({ metadata: { id: "a" } }, contentScriptSender("https://a.example.com/x")),
    ).toThrow(/does not support sender host verification/);
  });
});

describe("isTrustedExtensionContext：本地同上下文调用（sender 缺失）视为可信", () => {
  it("undefined sender 是 messages.ts localHandler 快捷路径，不能当成页面侧拒绝", async () => {
    const { isTrustedExtensionContext } = await import("@/offscreen/utils/sender.ts");
    expect(isTrustedExtensionContext(undefined)).toBe(true);
    // 内容脚本 / 外部扩展仍然不可信
    expect(isTrustedExtensionContext(contentScriptSender("https://a.example.com/x"))).toBe(false);
    expect(isTrustedExtensionContext(foreignExtensionSender)).toBe(false);
    // 绑定时对本地调用直接放行
    expect(() => assertSenderMatchesSite(makeSite("a"), undefined)).not.toThrow();
  });
});
