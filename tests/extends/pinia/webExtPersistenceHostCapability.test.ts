/**
 * webExtPersistence 插件的**宿主能力探测**回归测试。
 *
 * 背景（真实故障）：本地 localhost 预览页只 mock 了 `chrome.storage.local/session/sync`，
 * 没有 `chrome.storage.onChanged`；普通网页里的 `window.chrome` 更是浏览器原生的
 * `{loadTimes, csi, app}`。旧实现无条件执行
 * `chrome.storage.onChanged.addListener(...)`，抛出的 TypeError 发生在 pinia 插件
 * （= store 创建 = 根组件 setup）阶段，于是 **整个组件树挂载失败** ——
 * 用户看到的症状是「所有按钮都失效」，而不是某个按钮坏了。
 *
 * 因此这里锁死契约：宿主缺 storage / 缺 onChanged 时，
 * 1. 创建 store 不得抛错；
 * 2. state 照常可读写（内存态降级）；
 * 3. `$save()` 正常 resolve，但不会尝试写盘；
 * 4. 绝不注册监听（否则内部会再抛一次）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, defineStore } from "pinia";
import { createApp, h } from "vue";
import { message } from "ant-design-vue";

const { piniaWebExtPersistencePlugin } = await import("~/extends/pinia/webExtPersistence.ts");

function createStoreWithId(id: string) {
  const pinia = createPinia();
  pinia.use(piniaWebExtPersistencePlugin);
  // Pinia v4：app.use(pinia) 之后插件才进入 _p，并在 store 创建时执行
  createApp({ render: () => h("div") }).use(pinia);

  const useStore = defineStore(id, {
    persistWebExt: true,
    state: () => ({ sites: { siteA: { name: "A" } } }),
  });
  return useStore(pinia);
}

describe("webExtPersistence：非扩展宿主的降级（按钮全失效故障的回归守卫）", () => {
  let warningSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warningSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    warningSpy.mockRestore();
  });

  it("chrome 完全不存在时：store 可创建、state 可改、$save 不抛错", async () => {
    vi.stubGlobal("chrome", undefined);

    expect(() => createStoreWithId("degradedNoChrome")).not.toThrow();
    const store = createStoreWithId("degradedNoChrome");
    await store.$onReady();

    store.sites.siteA.name = "changed-in-memory";
    await expect(store.$save()).resolves.toBeUndefined();
    expect(store.sites.siteA.name).toBe("changed-in-memory");
  });

  it("chrome.storage 存在但没有 onChanged 时：不得抛错、不得注册监听", async () => {
    const setSpy = vi.fn(() => Promise.resolve());
    const addListenerSpy = vi.fn();
    vi.stubGlobal("chrome", {
      storage: {
        local: {
          get: () => Promise.resolve({}),
          set: setSpy,
          remove: () => Promise.resolve(),
        },
        onChanged: { addListener: addListenerSpy, removeListener: vi.fn() },
      },
    });

    // 本用例的关键：宿主把 onChanged 抹掉（模拟只 mock 了 local/session/sync 的预览页）
    (globalThis.chrome.storage as any).onChanged = undefined;

    const store = createStoreWithId("degradedNoOnChanged");
    await store.$onReady();
    expect(store.sites.siteA.name).toBe("A");
    // 创建 store 时 restore() 会写入一次默认值（storage.local 本身可用）
    expect(setSpy).toHaveBeenCalledTimes(1);
    // 关键：绝不注册 onChanged 监听（旧实现就是在这里抛 TypeError 崩掉整个挂载）
    expect(addListenerSpy).not.toHaveBeenCalled();

    store.sites.siteA.name = "changed-in-memory";
    await expect(store.$save()).resolves.toBeUndefined();
    expect(store.sites.siteA.name).toBe("changed-in-memory");
    // $save 仍然正常落盘（只是外部变更无法回灌）
    expect(setSpy).toHaveBeenCalledTimes(2);
  });

  it("onChanged 存在但 addListener 缺失时：同样降级，不抛错", async () => {
    const setSpy = vi.fn(() => Promise.resolve());
    vi.stubGlobal("chrome", {
      storage: {
        local: { get: () => Promise.resolve({}), set: setSpy, remove: () => Promise.resolve() },
        // 有 onChanged 对象，但没有可调用的 addListener
        onChanged: {},
      },
    });

    const store = createStoreWithId("degradedNoAddListener");
    await store.$onReady();
    store.sites.siteA.name = "changed-in-memory";
    await expect(store.$save()).resolves.toBeUndefined();
    // 同前：restore 写默认值 1 次 + $save 1 次；关键是没有任何同步崩溃
    expect(setSpy).toHaveBeenCalledTimes(2);
  });

  it("读取 chrome.storage 时宿主 getter 抛错：store 创建仍应降级", async () => {
    vi.stubGlobal("chrome", {
      get storage() {
        throw new Error("storage access denied");
      },
    });

    expect(() => createStoreWithId("degradedThrowingStorageGetter")).not.toThrow();
    const store = createStoreWithId("degradedThrowingStorageGetter");
    await expect(store.$onReady()).resolves.toBeUndefined();
    await expect(store.$save()).resolves.toBeUndefined();
  });

  it("onChanged.addListener 自身抛错：不得中断 store 创建", async () => {
    const setSpy = vi.fn(() => Promise.resolve());
    vi.stubGlobal("chrome", {
      storage: {
        local: { get: () => Promise.resolve({}), set: setSpy, remove: () => Promise.resolve() },
        onChanged: {
          addListener: vi.fn(() => {
            throw new Error("listener registration denied");
          }),
          removeListener: vi.fn(),
        },
      },
    });

    expect(() => createStoreWithId("degradedThrowingAddListener")).not.toThrow();
    const store = createStoreWithId("degradedThrowingAddListener");
    await expect(store.$onReady()).resolves.toBeUndefined();
    await expect(store.$save()).resolves.toBeUndefined();
  });

  it("宿主只有 addListener、没有 removeListener：释放持久化资源不得抛错", async () => {
    vi.stubGlobal("chrome", {
      storage: {
        local: {
          get: () => Promise.resolve({}),
          set: () => Promise.resolve(),
          remove: () => Promise.resolve(),
        },
        onChanged: {
          addListener: vi.fn(),
        },
      },
    });

    const store = createStoreWithId("degradedNoRemoveListener");
    await store.$onReady();
    expect(() => store.$disposePersist()).not.toThrow();
  });

  it("storage.local.set 失败时 $save 拒绝，让调用方知道配置未落盘", async () => {
    const notice = vi.spyOn(message, "open").mockImplementation(() => ({}) as any);
    const setSpy = vi.fn(() => Promise.reject(new Error("quota exceeded")));
    vi.stubGlobal("chrome", {
      storage: {
        local: { get: () => Promise.resolve({}), set: setSpy, remove: () => Promise.resolve() },
        onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
      },
    });

    const store = createStoreWithId("saveFailure");
    await store.$onReady();
    store.sites.siteA.name = "changed";
    await expect(store.$save()).rejects.toThrow("quota exceeded");
    expect(setSpy).toHaveBeenCalled();
    expect(notice).toHaveBeenCalledWith(expect.objectContaining({ type: "error" }));
    notice.mockRestore();
  });

  it("错误提示不可用时仍抛出原始写盘错误", async () => {
    const notice = vi.spyOn(message, "open").mockImplementation(() => {
      throw new Error("message UI unavailable");
    });
    vi.stubGlobal("chrome", {
      storage: {
        local: {
          get: () => Promise.resolve({ saveFailure: { sites: { siteA: { name: "A" } } } }),
          set: () => Promise.reject(new Error("quota exceeded")),
        },
      },
    });
    const store = createStoreWithId("saveFailure");
    await store.$onReady();

    await expect(store.$save()).rejects.toThrow("quota exceeded");
    notice.mockRestore();
  });
});
