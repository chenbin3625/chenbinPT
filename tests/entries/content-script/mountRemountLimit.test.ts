/**
 * content-script 重挂载接线的端到端回归（缺陷清单 L-4）。
 *
 * 与 `remountGuard.test.ts`（只测判定逻辑）互补：这里跑真实的 `mountApp()` —— 真实的
 * MutationObserver、真实的递归挂载、真实的模块级预算 —— 用来钉死「预算必须是跨挂载状态」这一点。
 * 修复前的实现把计数器声明在 `mountApp()` 函数体内，每次递归调用都会归零，于是宿主持续删除
 * `contentRoot` 时会无限高频重挂载；本用例会在第 4 次移除后失败（root 会一直被重新插回 body）。
 *
 * 只写一个用例：`mountApp` 的预算按模块持有，一个测试文件里连做多次挂载会共享同一份预算。
 * App.vue 用替身（本用例验证的是重挂载机制，不是面板 UI），chrome API 全部替身化；
 * `getURL` 返回 data URL 是为了让 happy-dom 加载 `<link rel=stylesheet>` 时不产生噪声报错。
 */
import { describe, expect, it, vi } from "vitest";

vi.stubGlobal("__BROWSER__", "chrome");

const storage = new Map<string, any>();
vi.stubGlobal("chrome", {
  runtime: {
    id: "test",
    getURL: (path: string) => `data:text/css;base64,${Buffer.from("").toString("base64")}#${path}`,
    sendMessage: () => Promise.resolve(undefined),
    onMessage: { addListener: () => undefined, removeListener: () => undefined },
  },
  storage: {
    local: {
      get: (key: string) => Promise.resolve(storage.has(key) ? { [key]: storage.get(key) } : {}),
      set: (items: Record<string, any>) => {
        for (const [k, v] of Object.entries(items)) storage.set(k, v);
        return Promise.resolve();
      },
      remove: (key: string) => {
        storage.delete(key);
        return Promise.resolve();
      },
      onChanged: { addListener: () => undefined, removeListener: () => undefined },
    },
    onChanged: { addListener: () => undefined, removeListener: () => undefined },
  },
  cookies: { get: () => Promise.resolve(null), set: () => Promise.resolve(), getAll: () => Promise.resolve([]) },
});

vi.mock("@/content-script/app/App.vue", () => ({ default: { name: "App", render: () => null } }));

const { mountApp } = await import("@/content-script/app/init.ts");
const { REMOUNT_MAX_ATTEMPTS } = await import("@/content-script/app/remountGuard.ts");

/** 让 MutationObserver 回调与 Vue 挂载/卸载的微任务跑完 */
async function flushAsync() {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function currentRoot(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>(".ptd-content-script-root");
}

describe("mountApp：宿主反复删除 contentRoot 时的重挂载上限（L-4）", () => {
  it(`最多自动重挂载 ${REMOUNT_MAX_ATTEMPTS} 次，之后放弃（不会无限循环）`, async () => {
    const { contentRoot } = mountApp(document as unknown as Document);
    await flushAsync();
    expect(document.body.contains(contentRoot)).toBe(true);

    // 前 MAX 次移除：每次都会被重新挂载，body 里始终恰好一个面板根节点
    for (let i = 1; i <= REMOUNT_MAX_ATTEMPTS; i++) {
      const root = currentRoot();
      expect(root, `第 ${i} 次移除前应存在面板根节点`).not.toBeNull();
      root!.remove();
      await flushAsync();
      expect(document.body.querySelectorAll(".ptd-content-script-root").length, `第 ${i} 次移除后应重新挂载`).toBe(1);
    }

    // 第 MAX+1 次：预算耗尽，放弃重挂载（修复前这里会被再次插回，形成死循环）
    const lastRoot = currentRoot();
    expect(lastRoot).not.toBeNull();
    lastRoot!.remove();
    await flushAsync();

    expect(document.body.querySelectorAll(".ptd-content-script-root").length).toBe(0);
  });
});
