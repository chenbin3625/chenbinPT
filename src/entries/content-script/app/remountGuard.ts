/**
 * content-script 重新挂载预算（缺陷清单 L-4）。
 *
 * 背景：宿主页面可能动态改写 body，把我们的 `contentRoot` 一并移除，因此 `init.ts` 用
 * MutationObserver 监听 body 并在发现 root 消失时重新挂载。若宿主页面**持续**删除未知 DOM
 * 元素，重挂载就会变成无限高频循环（`app.unmount()` → `mountApp()` → 被删 → 再挂载…）。
 *
 * 为什么单独成模块：预算必须是**跨挂载**的状态。早期实现在 `mountApp()` 内部声明
 * `let remountCount = 0`，而重挂载走的是 `mountApp()` 递归调用 —— 每次进入函数体都会把计数器
 * 重新初始化，上限永远触发不到（等于没有保护）。放在模块外既修掉这一点，也让这段判定
 * 可以脱离 Vue / DOM 单独单测（见 tests/entries/content-script/remountGuard.test.ts）。
 *
 * 判定规则：
 * - 连续被移除第 1..maxAttempts 次 → 允许重挂载；
 * - 超过预算 → 不再重挂载（宁可少一个面板，也不让页面陷入高频循环）；
 * - 上一次挂载已稳定存活 ≥ stabilityMs → 视为新的「首次挂载」，预算重置。
 *   否则一个长期运行的 SPA 里累计 3 次正常移除后，扩展面板将永久失效。
 */
export interface IRemountGuard {
  /** 每次挂载成功后调用（首次挂载与每次重挂载后都要调用） */
  noteMounted(): void;
  /** 发现 contentRoot 被移除时调用：返回是否允许再次挂载（允许时占用一次重试预算） */
  allowRemount(): boolean;
}

export interface IRemountGuardOptions {
  /** 连续重挂载次数上限，默认 3 */
  maxAttempts?: number;
  /** 「稳定存活」阈值（毫秒），默认 10s */
  stabilityMs?: number;
  /** 取当前时间，默认 `Date.now`（测试注入用） */
  now?: () => number;
}

export const REMOUNT_MAX_ATTEMPTS = 3;
export const REMOUNT_STABILITY_MS = 10_000;

export function createRemountGuard(options: IRemountGuardOptions = {}): IRemountGuard {
  const maxAttempts = options.maxAttempts ?? REMOUNT_MAX_ATTEMPTS;
  const stabilityMs = options.stabilityMs ?? REMOUNT_STABILITY_MS;
  const now = options.now ?? (() => Date.now());

  let attempts = 0;
  let mountedAt = 0;

  return {
    noteMounted() {
      mountedAt = now();
    },
    allowRemount() {
      // 上一次挂载已经稳定存活足够久：这是「页面某次正常改写」而不是死循环，重置预算
      if (mountedAt > 0 && now() - mountedAt >= stabilityMs) {
        attempts = 0;
      }
      if (attempts >= maxAttempts) {
        return false;
      }
      attempts += 1;
      return true;
    },
  };
}
