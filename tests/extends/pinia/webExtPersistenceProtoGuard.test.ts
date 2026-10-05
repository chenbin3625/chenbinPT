/**
 * 落盘前合并（三方合并）的原型污染防护（缺陷清单 C-2）。
 *
 * 场景：`chrome.storage` 里的数据带有**自有的** `__proto__` 键（JSON / 结构化克隆语义下它是普通
 * 数据属性，被篡改的备份或 Sync 数据都可能带来）。`mergeBeforeWrite` 会用
 * `collectPathChanges` 算出「本地相对基线改了什么」，再把这些路径重放到**刚从 storage 读回的现值**
 * 上；若本地改动落在 `["__proto__", ...]` 这样的路径上，而现值里没有自有 `__proto__`，
 * `cursor = cursor["__proto__"]` 取到的就是 `Object.prototype` —— 后续赋值即全局原型污染。
 *
 * 本用例构造出这条路径：基线（restore 读到的值）含自有 `__proto__ = {}`，本地把它改成
 * `{ polluted: "yes" }`，而 storage 现值不含 `__proto__`（模拟外部删除）⇒ 合并路径被触发。
 * 断言：合并写完 storage 后 `Object.prototype` 没有被写入。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, defineStore } from "pinia";
import { createApp, h } from "vue";

type StorageChange = Record<string, { oldValue?: unknown; newValue?: unknown }>;

const backing = new Map<string, unknown>();
const changeListeners: Array<(changes: StorageChange, areaName: string) => void> = [];

function emitChanges(changes: StorageChange) {
  for (const listener of changeListeners) {
    listener(changes, "local");
  }
}

const storageLocal = {
  get: (key: string) => Promise.resolve(backing.has(key) ? { [key]: backing.get(key) } : {}),
  set: (items: Record<string, unknown>) => {
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

const { piniaWebExtPersistencePlugin } = await import("~/extends/pinia/webExtPersistence.ts");

const STORE_KEY = "testMetadata";

function createTestStore() {
  const pinia = createPinia();
  pinia.use(piniaWebExtPersistencePlugin);
  createApp({ render: () => h("div") }).use(pinia);

  const useStore = defineStore("testMetadata", {
    persistWebExt: true,
    state: () => ({
      sites: { siteA: { name: "A", sortIndex: 1 } },
    }),
  });
  return useStore(pinia);
}

/** 构造带自有 `__proto__` 数据属性的对象（等价于 JSON.parse 出来的形状） */
function withOwnProto<T extends Record<string, any>>(value: T, proto: Record<string, any>): T {
  Object.defineProperty(value, "__proto__", {
    value: proto,
    writable: true,
    enumerable: true,
    configurable: true,
  });
  return value;
}

describe("webExtPersistence 落盘前合并：__proto__ 路径不写穿全局原型（C-2）", () => {
  beforeEach(() => {
    backing.clear();
    changeListeners.length = 0;
  });

  it("storage 中自有的 __proto__ 键不会污染 Object.prototype", async () => {
    // 篡改后的 storage：合法字段 + 自有 __proto__（空对象）
    backing.set(STORE_KEY, withOwnProto({ sites: { siteA: { name: "A", sortIndex: 1 } } }, {}));

    const store = createTestStore();
    await store.$onReady(); // 基线 = storage 现值（含自有 __proto__）

    // 本地把 __proto__ 子对象改成非空 ⇒ 产生 ["__proto__", "polluted"] 这条本地变更路径
    Object.defineProperty(store.$state, "__proto__", {
      value: { polluted: "yes" },
      writable: true,
      enumerable: true,
      configurable: true,
    });

    // storage 现值与基线不同（外部删掉了 __proto__）⇒ mergeBeforeWrite 会走「重放本地改动」分支，
    // 而重放目标（现值）没有自有 __proto__，正是污染成立的唯一条件
    backing.set(STORE_KEY, { sites: { siteA: { name: "A", sortIndex: 1 } } });

    await store.$save();

    expect(Object.prototype.hasOwnProperty.call(Object.prototype, "polluted")).toBe(false);
    expect(({} as any).polluted).toBeUndefined();
    expect(Object.keys(Object.prototype)).toHaveLength(0);
  });

  it("对照组：同场景下的普通字段改动仍会合并落盘", async () => {
    backing.set(STORE_KEY, withOwnProto({ sites: { siteA: { name: "A", sortIndex: 1 } } }, {}));

    const store = createTestStore();
    await store.$onReady();

    store.sites.siteA.name = "A-renamed";
    // 外部同时改了另一个字段（现值与基线不同 ⇒ 走合并分支）
    backing.set(
      STORE_KEY,
      withOwnProto({ sites: { siteA: { name: "A", sortIndex: 1 } }, lastUserInfoAutoFlushAt: 42 }, {}),
    );

    await store.$save();

    const stored = backing.get(STORE_KEY) as any;
    expect(stored.sites.siteA.name).toBe("A-renamed"); // 本地改动被重放
    expect(stored.lastUserInfoAutoFlushAt).toBe(42); // 外部改动被保留
  });
});
