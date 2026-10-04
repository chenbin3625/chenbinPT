/**
 * webExtPersistence 插件行为测试（见 docs/performance-audit.md P0-3 / P1-5）。
 *
 * 这个插件是 options 页所有 store（metadata / config）的持久化通道，本轮改了两处：
 * 1. `onChanged`：不再 `store.$patch(整份 newValue)`（整体替换 state 会让所有依赖
 *    `Object.entries(sites)` 的 effect 全部重算），改为**只下发真正变化的字段**；
 * 2. `$save`：写入进行中到达的多次调用合并成一次尾部写入（N 次调用 → 最多 2 次落盘），
 *    同时保持 `await $save()` 返回时数据已落盘的语义。
 *
 * 同时验证 `persistent()` 走的是解代理（toSerializable）而不是 JSON 往返：
 * 写进 storage 的必须是普通对象，不能带 Vue 的 `__v_raw`。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, defineStore } from "pinia";
import { createApp, h, reactive, ref } from "vue";

type StorageChange = Record<string, { oldValue?: unknown; newValue?: unknown }>;

const backing = new Map<string, unknown>();
const changeListeners: Array<(changes: StorageChange, areaName: string) => void> = [];
let setCallCount = 0;

function emitChanges(changes: StorageChange) {
  for (const listener of changeListeners) {
    listener(changes, "local");
  }
}

const storageLocal = {
  get: (key: string) => Promise.resolve(backing.has(key) ? { [key]: backing.get(key) } : {}),
  set: (items: Record<string, unknown>) => {
    setCallCount++;
    const changes: StorageChange = {};
    for (const [key, value] of Object.entries(items)) {
      changes[key] = { oldValue: backing.get(key), newValue: value };
      backing.set(key, value);
    }
    emitChanges(changes);
    return Promise.resolve();
  },
  remove: (key: string) => {
    backing.delete(key);
    emitChanges({ [key]: { oldValue: undefined, newValue: undefined } });
    return Promise.resolve();
  },
  onChanged: {
    addListener: (fn: (changes: StorageChange, areaName: string) => void) => changeListeners.push(fn),
    removeListener: (fn: (changes: StorageChange, areaName: string) => void) => {
      const index = changeListeners.indexOf(fn);
      if (index >= 0) changeListeners.splice(index, 1);
    },
  },
};

vi.stubGlobal("chrome", {
  storage: { local: storageLocal, onChanged: storageLocal.onChanged },
});

const { piniaWebExtPersistencePlugin, persistent } = await import("~/extends/pinia/webExtPersistence.ts");

const STORE_KEY = "testMetadata";

function createTestStore() {
  const pinia = createPinia();
  pinia.use(piniaWebExtPersistencePlugin);
  // 注意：Pinia v4 中，pinia 未安装到 app 之前 `use()` 只是把插件放进 toBeInstalled，
  // 只有 app.use(pinia) 之后插件才会进入 _p 并在 store 创建时执行。
  createApp({ render: () => h("div") }).use(pinia);

  const useStore = defineStore("testMetadata", {
    persistWebExt: true,
    state: () => ({
      sites: {
        siteA: { name: "A", sortIndex: 1 },
        siteB: { name: "B", sortIndex: 2 },
      },
      lastUserInfoAutoFlushAt: 0,
    }),
  });
  return useStore(pinia);
}

describe("webExtPersistence：最小字段 patch（P0-3）", () => {
  beforeEach(() => {
    backing.clear();
    changeListeners.length = 0;
    setCallCount = 0;
  });

  it("外部变更只 patch 变化的子项，未变化子项保持对象身份（不触发整体替换）", async () => {
    const store = createTestStore();
    await store.$onReady();

    const sitesBefore = store.sites;
    const siteBBefore = store.sites.siteB;
    const mutationTypes: string[] = [];
    store.$subscribe((mutation) => mutationTypes.push(mutation.type), { detached: true });

    // 模拟另一个上下文（offscreen 用户信息刷新）写回 metadata：只有 siteA 变了
    await storageLocal.set({
      [STORE_KEY]: {
        sites: { siteA: { name: "A-updated", sortIndex: 1 }, siteB: { name: "B", sortIndex: 2 } },
        lastUserInfoAutoFlushAt: 123,
      },
    });

    expect(store.sites.siteA.name).toBe("A-updated");
    expect(store.lastUserInfoAutoFlushAt).toBe(123);
    // 容器对象身份保持：说明不是整店替换（否则 Topbar/SetSite 的全量 effect 会被重算）
    expect(store.sites).toBe(sitesBefore);
    expect(store.sites.siteB).toBe(siteBBefore);
  });

  it("自身写入的回声被抑制：$save 后 onChanged 回传不会再次 patch（避免级联重算）", async () => {
    const store = createTestStore();
    await store.$onReady();

    store.sites.siteA.name = "changed";
    await store.$save();

    const mutationCount = { count: 0 };
    store.$subscribe(() => (mutationCount.count += 1), { detached: true });

    // 模拟 chrome.storage 把刚写入的内容原样回传（反序列化后是新对象，引用比较无法识别）
    await storageLocal.set({ [STORE_KEY]: JSON.parse(JSON.stringify(store.$state)) });

    expect(mutationCount.count).toBe(0);
    expect(store.sites.siteA.name).toBe("changed");
  });

  it("回声窗口外到达的外部变更仍会被应用（窗口不能吞掉真实的外部更新）", async () => {
    const store = createTestStore();
    await store.$onReady();

    // 直接把"自写回声窗口"推回过去：模拟距离上次写入已过很久
    vi.setSystemTime(Date.now() + 5000);
    try {
      await storageLocal.set({
        [STORE_KEY]: { sites: { siteA: { name: "external", sortIndex: 1 } }, lastUserInfoAutoFlushAt: 9 },
      });
      expect(store.sites.siteA.name).toBe("external");
      expect(store.lastUserInfoAutoFlushAt).toBe(9);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("webExtPersistence：写入合并（P1-5）", () => {
  beforeEach(() => {
    backing.clear();
    changeListeners.length = 0;
    setCallCount = 0;
  });

  it("并发 $save 被合并：N 次调用最多落盘 2 次，且每个 await 都在落盘之后 resolve", async () => {
    const store = createTestStore();
    await store.$onReady();
    setCallCount = 0;

    store.sites.siteA.name = "first";
    const first = store.$save();
    store.sites.siteA.name = "second";
    const second = store.$save();
    store.sites.siteA.name = "third";
    const third = store.$save();

    await Promise.all([first, second, third]);

    // 第一次立即写 + 期间到达的两次合并成一次尾部写 = 2 次
    expect(setCallCount).toBe(2);
    const stored = backing.get(STORE_KEY) as any;
    expect(stored.sites.siteA.name).toBe("third");
  });

  it("persistent() 写入的是解代理后的普通对象（不含 __v_raw）", async () => {
    const state = reactive({ sites: { siteA: { name: "A" } }, count: 1 });
    await persistent("reactiveKey", state);

    const stored = backing.get("reactiveKey") as any;
    expect(JSON.stringify(stored)).toBe(JSON.stringify({ sites: { siteA: { name: "A" } }, count: 1 }));
    expect(stored.sites.__v_raw).toBeUndefined();

    // Vue ref 也会被解成其 value
    await persistent("refKey", { value: ref(42) } as any);
    const storedRef = backing.get("refKey") as any;
    expect(storedRef.value).toBe(42);
  });
});
