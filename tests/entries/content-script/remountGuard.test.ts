/**
 * content-script 重挂载预算（缺陷清单 L-4）单元测试。
 *
 * 原缺陷：预算计数器声明在 `mountApp()` 函数体内，而重挂载是**递归调用** `mountApp()` ——
 * 每次进入函数体计数器都被重新初始化为 0，上限永远触发不到；宿主页面持续删除 contentRoot 时
 * 依然是无限高频重挂载（`app.unmount()` → `mountApp()` → 被删 → 再挂载…）。
 *
 * 这里直接测抽出来的判定逻辑（`remountGuard.ts`），并用可控时钟覆盖「稳定存活后预算重置」，
 * 避免测试依赖真实时间。
 */
import { describe, expect, it } from "vitest";

import { createRemountGuard, REMOUNT_MAX_ATTEMPTS, REMOUNT_STABILITY_MS } from "@/content-script/app/remountGuard.ts";

/** 可控时钟：手动推进 */
function createClock(start = 1_000_000) {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

describe("createRemountGuard：连续重挂载上限", () => {
  it(`连续被移除时最多允许 ${REMOUNT_MAX_ATTEMPTS} 次重挂载，之后拒绝`, () => {
    const clock = createClock();
    const guard = createRemountGuard({ now: clock.now });
    guard.noteMounted();

    for (let i = 1; i <= REMOUNT_MAX_ATTEMPTS; i++) {
      expect(guard.allowRemount(), `第 ${i} 次重挂载应被允许`).toBe(true);
      guard.noteMounted(); // 重挂载成功
    }

    // 第 MAX+1 次：拒绝，且拒绝是稳定的（不会因为多问几次又变成允许）
    expect(guard.allowRemount()).toBe(false);
    expect(guard.allowRemount()).toBe(false);
  });

  it("间隔小于稳定阈值时仍算「连续」：宿主每 9s 删一次也会被上限拦住", () => {
    const clock = createClock();
    const guard = createRemountGuard({ now: clock.now });
    guard.noteMounted();

    for (let i = 1; i <= REMOUNT_MAX_ATTEMPTS; i++) {
      clock.advance(REMOUNT_STABILITY_MS - 1_000);
      expect(guard.allowRemount()).toBe(true);
      guard.noteMounted();
    }

    clock.advance(REMOUNT_STABILITY_MS - 1_000);
    expect(guard.allowRemount()).toBe(false);
  });

  it("没有 noteMounted 过也不会抛错（防御性边界）", () => {
    const clock = createClock();
    const guard = createRemountGuard({ now: clock.now });
    expect(() => guard.allowRemount()).not.toThrow();
  });
});

describe("createRemountGuard：稳定存活后预算重置", () => {
  it("上次挂载稳定存活 ≥ 阈值后，视为新的首次挂载（长期 SPA 不会永久失效）", () => {
    const clock = createClock();
    const guard = createRemountGuard({ now: clock.now });
    guard.noteMounted();

    for (let i = 0; i < REMOUNT_MAX_ATTEMPTS; i++) {
      expect(guard.allowRemount()).toBe(true);
      guard.noteMounted();
    }
    expect(guard.allowRemount()).toBe(false);

    // 面板稳定存活足够久之后宿主才再次改写 body：这是正常场景，必须仍能恢复
    clock.advance(REMOUNT_STABILITY_MS);
    expect(guard.allowRemount()).toBe(true);
  });

  it("自定义 maxAttempts / stabilityMs 生效", () => {
    const clock = createClock();
    const guard = createRemountGuard({ maxAttempts: 1, stabilityMs: 100, now: clock.now });
    guard.noteMounted();

    expect(guard.allowRemount()).toBe(true);
    guard.noteMounted();
    expect(guard.allowRemount()).toBe(false);

    clock.advance(100);
    expect(guard.allowRemount()).toBe(true);
  });
});
