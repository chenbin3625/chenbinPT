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

/** loadApp 的第一步就是 chrome.runtime.getURL("assets/cs-app.js")，用它判断是否走到了加载分支 */
const getURL = vi.fn((path: string) => `chrome-extension://ptdtest/${path}`);
(globalThis as any).chrome = { runtime: { getURL } };

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
    getURL.mockClear();
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
    expect(getURL).not.toHaveBeenCalled();

    // fixture 自证：这正是危险的取值场景
    expect(Object.hasOwn({}, "constructor")).toBe(false);
    expect(typeof ({} as any)["constructor"]).toBe("function");
  });

  it("正向对照：map 里确有同名自有属性时，引导照常加载该站点", async () => {
    // 这条用例会真的走到「加载 app chunk」（vitest 里必然失败并触发既定的重试 + 兜底 catch），
    // 期间屏蔽控制台输出，避免这段预期内的噪音混进测试报告
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
        return undefined;
      });

      await import("@/content-script/index.ts");
      await flushAsync();

      // 走到了加载分支（app chunk 地址取自 chrome.runtime.getURL）
      expect(getURL).toHaveBeenCalledWith("assets/cs-app.js");

      // 等「首次失败 → 带 cache-busting 参数重试一次 → 引导链兜底 catch」跑完再恢复控制台
      await new Promise((resolve) => setTimeout(resolve, 500));
    } finally {
      consoleSpies.forEach((spy) => spy.mockRestore());
    }
  });
});
