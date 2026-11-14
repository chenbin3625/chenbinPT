/**
 * 持久化回灌别名回归：写入 store 的值不得与 `syncedSnapshot` / 合并结果共享可变子树。
 *
 * 缺陷：`onChanged` 把 storage 反序列化对象的子树直接塞进 store，下一轮 `syncedSnapshot`
 * 又指向同一对象；用户随后对 store 的**就地修改**会同步改掉基线，`$save()` 计算
 * 「基线 → 本地」差异时看不到变化，改动被回退。
 *
 * 两个来源都要覆盖：
 * 1. `onChanged` 的最小 path 回灌；
 * 2. `mergeBeforeWrite` 的「外部新增字段」回灌（merged 会成为新的落盘内容/基线）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, defineStore } from "pinia";
import { createApp, h } from "vue";

type StorageChange = Record<string, { oldValue?: unknown; newValue?: unknown }>;

const backing = new Map<string, unknown>();
const changeListeners: Array<(changes: StorageChange, areaName: string) => void> = [];

const clone = <T>(value: T): T => (value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T));

function emitChanges(changes: StorageChange) {
  for (const listener of changeListeners) listener(changes, "local");
}

const storageLocal = {
  get: (key: string) => Promise.resolve(backing.has(key) ? { [key]: clone(backing.get(key)) } : {}),
  set: (items: Record<string, unknown>) => {
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

const STORE_KEY = "testAliasing";

function createTestStore() {
  const pinia = createPinia();
  pinia.use(piniaWebExtPersistencePlugin);
  createApp({ render: () => h("div") }).use(pinia);
  const useStore = defineStore("testAliasing", {
    persistWebExt: true,
    state: () => ({
      sites: { siteA: { name: "A", sortIndex: 1 } },
      lastSearchFilter: "",
      // 顶层已声明，才能通过 store.externalOnly 读取；外部写入会把 null 换成对象
      externalOnly: null as { a: number } | null,
    }),
  });
  return useStore(pinia) as ReturnType<typeof useStore> & Record<string, any>;
}

describe("webExtPersistence：回灌值不与基线共享可变子树", () => {
  beforeEach(() => {
    backing.clear();
    changeListeners.length = 0;
  });

  it("onChanged 回灌后就地修改再保存，不会被回退", async () => {
    const store = createTestStore();
    await store.$onReady();

    // 外部上下文写入；onChanged 回灌到 store
    await storageLocal.set({
      [STORE_KEY]: {
        sites: { siteA: { name: "external", sortIndex: 1 } },
        lastSearchFilter: "external-filter",
      },
    });
    expect(store.sites.siteA.name).toBe("external");

    // 就地修改回灌进来的子树
    store.sites.siteA.name = "local-after-restore";

    await store.$save();

    expect((backing.get(STORE_KEY) as any).sites.siteA.name).toBe("local-after-restore");
  });

  it("落盘前合并回灌的外部新增字段：就地修改后再保存同样能落盘", async () => {
    const store = createTestStore();
    await store.$onReady();

    store.lastSearchFilter = "local-filter";
    // 模拟「另一个上下文写入但 onChanged 还没送达」（直接改 backing）
    backing.set(STORE_KEY, {
      ...(backing.get(STORE_KEY) as any),
      externalOnly: { a: 1 },
    });

    await store.$save();
    expect(store.externalOnly).toEqual({ a: 1 });

    // 外部新增字段由 mergeBeforeWrite 回灌；直接改它
    (store.externalOnly as { a: number }).a = 2;
    await store.$save();

    expect((backing.get(STORE_KEY) as any).externalOnly).toEqual({ a: 2 });
  });
});
