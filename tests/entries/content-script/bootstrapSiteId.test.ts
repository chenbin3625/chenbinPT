/**
 * S-2（第 3 处入口）：`content-script/index.ts` 的 `siteHostMap[host]` 查找。
 *
 * 单标签 host（内网 / DNS 后缀名，例如 `http://constructor/`）会沿原型链命中
 * `Object.prototype.constructor`：得到的是一个**真值非字符串**的 siteId，会继续流入消息路径
 * （`["sites", siteId, "allowContentScript"]`）与 `createSiteInstance`。修复是改用
 * `Object.hasOwn` 只取自有属性。
 *
 * 这里直接跑引导入口本身（唯一改动点就在它的顶层逻辑里），用消息替身观察它到底做了哪些事：
 * - 反向用例：map 里没有自有属性 → 引导必须止步，绝不能去加载 app；
 * - 正向对照：map 里**确有**名为 `constructor` 的自有属性时，引导应当照常加载 app
 *   （证明上一条的「没加载」不是因为整个入口没跑起来）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ sendMessage: vi.fn() }));
vi.mock("@/messages.ts", () => ({ sendMessage: mocks.sendMessage, onMessage: vi.fn() }));

/** 是否走到了加载分支：loadApp 会请后台注入 UI（injectContentScriptApp） */
function injectRequests(): any[][] {
  return callsOf("injectContentScriptApp");
}

function callsOf(type: string): any[][] {
  return mocks.sendMessage.mock.calls.filter(([messageType]) => messageType === type);
}

async function flushAsync() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** 引导期间会发出的定路径读消息（顺序固定） */
function bootstrapReadPaths(): string[] {
  return callsOf("getExtStoragePath").map(([, data]) => `${data.key}:${data.path}`);
}

describe("S-2 · 引导入口不会从原型链上取 siteId", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.sendMessage.mockReset();
    delete (globalThis as any).__ptdContentScriptAppProps__;
    // 单标签 host：siteHostMap["constructor"] 会命中 Object.prototype.constructor
    (window as any).happyDOM?.setURL?.("http://constructor/");
    expect(location.host).toBe("constructor");
  });

  it("siteHostMap 没有自有属性时：引导止步，不会拿着原型链上的值去加载站点", async () => {
    mocks.sendMessage.mockImplementation(async (type: string, data: any) => {
      if (type === "getExtStoragePath") {
        if (data?.path === "contentScript") return { enabled: true, allowExceptionSites: true };
        if (data?.key === "siteIndex") return {}; // 空表 → 按设计回落到 metadata.siteHostMap
        if (data?.key === "metadata") return {}; // 空 map（没有任何自有 host）
      }
      return undefined;
    });

    await import("@/content-script/index.ts");
    await flushAsync();

    // 只做了「读配置 → 试配 social → 读 host 索引」；没有 ["sites", …] 这种以 siteId 为路径的读
    expect(bootstrapReadPaths()).toEqual(["config:contentScript", "siteIndex:siteHostMap", "metadata:siteHostMap"]);
    // 也没有走到 loadApp（旧实现在这里会带着 Object.prototype.constructor 继续往下走）
    expect(injectRequests()).toHaveLength(0);
    expect((globalThis as any).__ptdContentScriptAppProps__).toBeUndefined();

    // fixture 自证：这正是危险的取值场景
    expect(Object.hasOwn({}, "constructor")).toBe(false);
    expect(typeof ({} as any)["constructor"]).toBe("function");
  });

  it("正向对照：map 里确有同名自有属性时，引导照常加载该站点", async () => {
    const consoleSpies = [vi.spyOn(console, "debug").mockImplementation(() => {})];

    try {
      mocks.sendMessage.mockImplementation(async (type: string, data: any) => {
        if (type === "getExtStoragePath") {
          if (data?.path === "contentScript") return { enabled: true };
          if (data?.key === "siteIndex") return { constructor: "testsite" };
        }
        if (type === "getContentScriptBootstrapData") return { config: { a: 1 }, metadata: { b: 2 } };
        return undefined;
      });

      await import("@/content-script/index.ts");
      await flushAsync();

      // 走到了加载分支：先把挂载参数交给 isolated world，再请后台注入 UI（不带任何参数，目标只取自 sender）
      expect(injectRequests()).toEqual([["injectContentScriptApp", undefined]]);
      expect((globalThis as any).__ptdContentScriptAppProps__).toEqual({
        siteId: "testsite",
        config: { a: 1 },
        metadata: { b: 2 },
      });
    } finally {
      consoleSpies.forEach((spy) => spy.mockRestore());
    }
  });

  it("注入失败时重试一次，仍失败则由引导链兜底 catch 记录", async () => {
    const consoleSpies = [
      vi.spyOn(console, "debug").mockImplementation(() => {}),
      vi.spyOn(console, "warn").mockImplementation(() => {}),
      vi.spyOn(console, "error").mockImplementation(() => {}),
    ];

    try {
      mocks.sendMessage.mockImplementation(async (type: string, data: any) => {
        if (type === "getExtStoragePath") {
          if (data?.path === "contentScript") return { enabled: true };
          if (data?.key === "siteIndex") return { constructor: "testsite" };
        }
        if (type === "injectContentScriptApp") throw new Error("Could not establish connection");
        return undefined;
      });

      await import("@/content-script/index.ts");
      await flushAsync();
      await new Promise((resolve) => setTimeout(resolve, 400));

      expect(injectRequests()).toHaveLength(2);
      expect(consoleSpies[2]).toHaveBeenCalledWith(
        "[PTD] content script bootstrap failed, app will not be mounted:",
        expect.any(Error),
      );
    } finally {
      consoleSpies.forEach((spy) => spy.mockRestore());
    }
  });
});
