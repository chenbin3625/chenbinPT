/**
 * metadataStoreBridge 行为测试。
 *
 * 这是一个模块级的一次性注册表：metadata store 在模块求值结束时注册访问器，
 * config store 通过 `getMetadataStoreLazily()` 惰性获取，避免两者的 ESM 循环依赖。
 * 测试用假 accessor 即可，不需要初始化真实 metadata store。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type TBridgeModule = typeof import("@/options/stores/metadataStoreBridge.ts");

/** 动态 import 以拿到当前模块实例（配合 beforeEach 的 resetModules 隔离模块级状态）。 */
async function loadBridge(): Promise<TBridgeModule> {
  return await import("@/options/stores/metadataStoreBridge.ts");
}

describe("metadataStoreBridge", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("未注册时 getMetadataStoreLazily() 返回 null", async () => {
    const { getMetadataStoreLazily } = await loadBridge();

    expect(getMetadataStoreLazily()).toBeNull();
  });

  it("注册后返回 accessor 的结果", async () => {
    const { registerMetadataStoreAccessor, getMetadataStoreLazily } = await loadBridge();
    const fakeStore = { lastUserInfo: { username: "alice" } };

    registerMetadataStoreAccessor((() => fakeStore) as any);

    expect(getMetadataStoreLazily()).toBe(fakeStore);
  });

  it("重复注册时后注册的 accessor 覆盖前者", async () => {
    const { registerMetadataStoreAccessor, getMetadataStoreLazily } = await loadBridge();
    const firstStore = { marker: "first" };
    const secondStore = { marker: "second" };

    registerMetadataStoreAccessor((() => firstStore) as any);
    expect(getMetadataStoreLazily()).toBe(firstStore);

    registerMetadataStoreAccessor((() => secondStore) as any);
    expect(getMetadataStoreLazily()).toBe(secondStore);
  });

  it("注册是惰性的：getMetadataStoreLazily() 调用前不会执行 accessor", async () => {
    const { registerMetadataStoreAccessor, getMetadataStoreLazily } = await loadBridge();
    const accessor = vi.fn(() => ({ marker: "lazy" }));

    registerMetadataStoreAccessor(accessor as any);
    expect(accessor).not.toHaveBeenCalled();

    expect(getMetadataStoreLazily()).toEqual({ marker: "lazy" });
    expect(accessor).toHaveBeenCalledTimes(1);
  });

  it("每次 getMetadataStoreLazily() 都重新调用 accessor，而不是缓存首次结果", async () => {
    const { registerMetadataStoreAccessor, getMetadataStoreLazily } = await loadBridge();
    let calls = 0;
    const accessor = vi.fn(() => ({ call: (calls += 1) }));

    registerMetadataStoreAccessor(accessor as any);

    expect(getMetadataStoreLazily()).toEqual({ call: 1 });
    expect(getMetadataStoreLazily()).toEqual({ call: 2 });
    expect(accessor).toHaveBeenCalledTimes(2);
  });
});
