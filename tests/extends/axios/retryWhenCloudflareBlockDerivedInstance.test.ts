/**
 * CF 重试的「已安装」标志必须挂在实例上（缺陷清单 EXTENDSI18N-6）。
 *
 * 事实前提（用真实 axios 验证）：
 * - `axios.create()` 通过 `mergeConfig` 继承 defaults：把标志写在 defaults 上，
 *   任何从已配置实例派生出来的新实例一出生就带标志位；
 * - `packages/downloader/utils/adapter.ts` 就是用 `axiosRaw.create()` 建实例的，
 *   而 `packages/site/utils/adapter.ts` 把 `setupRetryWhenCloudflareBlock` 套在全局 axios 上，
 *   于是全局 axios 的 defaults 上会留下标志 → 派生实例调用 setup 时被守卫静默跳过、拦截器不注册。
 *
 * 修复后：标志改成实例自身的属性（不会被 create() 继承），派生实例仍能正常注册重试拦截器。
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/messages.ts", () => ({
  sendMessage: vi.fn(),
  onMessage: vi.fn(),
}));

const axios = (await import("axios")).default;
const { setupRetryWhenCloudflareBlock } = await import("~/extends/axios/retryWhenCloudflareBlock.ts");

describe("CF 重试防重标志（EXTENDSI18N-6）", () => {
  it("从已配置实例 create() 出来的新实例仍能注册重试拦截器，且同一实例重复 setup 幂等", () => {
    const base = axios.create();
    setupRetryWhenCloudflareBlock(base);
    const registeredCount = (base.interceptors.response as any).handlers.length;
    expect(registeredCount).toBeGreaterThan(0);

    // 关键：不改写 defaults（否则会被 create() 继承，见文件头说明）
    expect((base.defaults as any).retryWhenCloudflareSetup).toBeUndefined();

    const derived = base.create();
    expect((derived.defaults as any).retryWhenCloudflareSetup).toBeUndefined();
    setupRetryWhenCloudflareBlock(derived);
    // 修复前：守卫命中 defaults 上的继承标志 ⇒ 拦截器不注册（0）
    expect((derived.interceptors.response as any).handlers.length).toBe(registeredCount);

    // 幂等：对同一实例重复调用不会重复注册
    setupRetryWhenCloudflareBlock(derived);
    expect((derived.interceptors.response as any).handlers.length).toBe(registeredCount);

    // 判别力证明：defaults 上的同名标志确实会被 create() 继承（旧实现正是挂在 defaults 上），
    // 所以本用例在旧实现下必然失败（派生实例被守卫跳过、handlers 为 0）
    const withDefaultsFlag: any = axios.create();
    withDefaultsFlag.defaults.retryWhenCloudflare = true;
    expect(withDefaultsFlag.create().defaults.retryWhenCloudflare).toBe(true);
  });
});
