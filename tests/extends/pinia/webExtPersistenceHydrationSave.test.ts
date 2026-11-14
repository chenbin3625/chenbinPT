/**
 * B-?（水合前保存）：`$save()` 必须等 restore 完成后再落盘。
 *
 * 缺陷：restore 未完成时 `syncedSnapshot === null`，`$save()` 走整份写，
 * 用 store 的默认值覆盖 storage 里已有的配置（App.vue 的缩放提示在水合前就可能被关闭）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, defineStore } from "pinia";
import { createApp, h } from "vue";

type StorageChange = Record<string, { oldValue?: unknown; newValue?: unknown }>;

const backing = new Map<string, unknown>();
const changeListeners: Array<(changes: StorageChange, areaName: string) => void> = [];
let setCallCount = 0;
let deferNextGet = false;
let resolveDeferredGet: (() => void) | null = null;

const clone = <T>(value: T): T => (value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T));

function emitChanges(changes: StorageChange) {
  for (const listener of changeListeners) listener(changes, "local");
}

const storageLocal = {
  get: (key: string) => {
    if (deferNextGet) {
      deferNextGet = false;
      return new Promise<Record<string, unknown>>((resolve) => {
        resolveDeferredGet = () => resolve(backing.has(key) ? { [key]: clone(backing.get(key)) } : {});
      });
    }
    return Promise.resolve(backing.has(key) ? { [key]: clone(backing.get(key)) } : {});
  },
  set: (items: Record<string, unknown>) => {
    setCallCount++;
    const changes: StorageChange = {};
    for (const [key, value] of Object.entries(items)) {
      const cloned = clone(value);
      changes[key] = { oldValue: clone(backing.get(key)), newValue: cloned };
      backing.set(key, cloned);
    }
    emitChanges(changes);
    return Promise.resolve();
  },
  remove: (key: string) => {
    backing.delete(key);
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

const { piniaWebExtPersistencePlugin } = await import("~/extends/pinia/webExtPersistence.ts");

const STORE_KEY = "testHydrationSave";

function createTestStore() {
  const pinia = createPinia();
  pinia.use(piniaWebExtPersistencePlugin);
  createApp({ render: () => h("div") }).use(pinia);
  const useStore = defineStore("testHydrationSave", {
    persistWebExt: true,
    state: () => ({
      sites: { siteA: { name: "DEFAULT", sortIndex: 0 } },
      lastSearchFilter: "",
    }),
  });
  return useStore(pinia);
}

async function flushMicrotasks() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

beforeEach(() => {
  backing.clear();
  changeListeners.length = 0;
  setCallCount = 0;
  deferNextGet = false;
  resolveDeferredGet = null;
});

describe("webExtPersistence：水合完成前的 $save 不得覆盖 storage", () => {
  it("restore 的 storage.get 未返回时，$save 不会先落盘默认值", async () => {
    backing.set(STORE_KEY, {
      sites: { siteA: { name: "FROM-STORAGE", sortIndex: 9 } },
      lastSearchFilter: "stored-filter",
    });

    deferNextGet = true;
    const store = createTestStore();
    await flushMicrotasks();
    expect(resolveDeferredGet, "restore 应停在 storage.get 上").toBeTypeOf("function");

    setCallCount = 0;
    const save = store.$save();
    await flushMicrotasks();

    // 关键：水合完成之前一次 set 都不能发生（旧实现会整份写默认值）
    expect(setCallCount).toBe(0);
    expect((backing.get(STORE_KEY) as any).sites.siteA.name).toBe("FROM-STORAGE");

    resolveDeferredGet!();
    await save;
    await flushMicrotasks();

    const persisted = backing.get(STORE_KEY) as any;
    expect(persisted.sites.siteA.name, "不得用默认值覆盖已有配置").toBe("FROM-STORAGE");
    expect(persisted.lastSearchFilter).toBe("stored-filter");
  });

  it("水合前排队的多次 $save：restore 完成后仍按「单飞 + 尾部合并」落盘", async () => {
    backing.set(STORE_KEY, {
      sites: { siteA: { name: "FROM-STORAGE", sortIndex: 9 } },
      lastSearchFilter: "stored-filter",
    });

    deferNextGet = true;
    const store = createTestStore();
    await flushMicrotasks();
    expect(resolveDeferredGet).toBeTypeOf("function");

    setCallCount = 0;
    const first = store.$save();
    const second = store.$save();
    await flushMicrotasks();
    expect(setCallCount).toBe(0);

    resolveDeferredGet!();
    await Promise.all([first, second]);
    await flushMicrotasks();

    const persisted = backing.get(STORE_KEY) as any;
    expect(persisted.sites.siteA.name).toBe("FROM-STORAGE");
    expect(persisted.lastSearchFilter).toBe("stored-filter");
    // 两次排队调用不会产生两次以上的写盘（原有合并语义保持不变）
    expect(setCallCount).toBeLessThanOrEqual(2);
  });
});
