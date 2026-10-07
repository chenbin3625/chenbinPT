/**
 * webExtPersistence 两处外部数据同步修复的行为验证（缺陷清单 EXTENDSI18N-4 / EXTENDSI18N-5）。
 *
 * - EXTENDSI18N-4：storage 现值里的自有 `__proto__` 经 `mergeBeforeWrite` →
 *   `applyExternalChangesToStore` 回灌时，不得写成 store state 的原型（原先只有 applyPathChanges 有守卫）；
 * - EXTENDSI18N-5：外部整份写入缺少某个**顶层键**时，必须同步删除本地同名字段，
 *   且下一次 `$save()` 不得把它写回 storage（原先只递归删除子对象里的键）。
 *
 * 放置说明：这两个用例验证的是 `src/extends/pinia/webExtPersistence.ts`。本包（extends-i18n）
 * 的测试写权限只覆盖 tests/extends/axios/**（tests/extends/pinia/** 归 tests 包），
 * 因此用例暂时落在这里；tests 包可随时把本文件搬迁/合并到 tests/extends/pinia/ 下（内容等价，无 repo 依赖）。
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
      lastUserInfoAutoFlushAt: 0,
      lastSearchFilter: "",
    }),
  });
  return useStore(pinia);
}

function withOwnProto<T extends Record<string, any>>(value: T, proto: Record<string, any>): T {
  Object.defineProperty(value, "__proto__", {
    value: proto,
    writable: true,
    enumerable: true,
    configurable: true,
  });
  return value;
}

describe("EXTENDSI18N-4：storage 现值里的自有 __proto__ 不得写成 store state 的原型", () => {
  beforeEach(() => {
    backing.clear();
    changeListeners.length = 0;
  });

  it("外部并发写入带自有 __proto__ 时，$save 的 mergeBeforeWrite 回灌不改 state 原型", async () => {
    backing.set(STORE_KEY, { sites: { siteA: { name: "A", sortIndex: 1 } }, lastSearchFilter: "" });

    const store = createTestStore();
    await store.$onReady();

    store.sites.siteA.name = "local-edit";

    // 直接改 backing 模拟「另一个上下文/被篡改的备份写进了 storage，但 onChanged 还没送达」
    backing.set(
      STORE_KEY,
      withOwnProto({ sites: { siteA: { name: "A", sortIndex: 1 } }, lastSearchFilter: "" }, { evil: "injected" }),
    );

    await store.$save();

    expect(Object.getPrototypeOf(store.$state)).toBe(Object.prototype);
    expect((store.$state as any).evil).toBeUndefined();
    expect(store.sites.siteA.name).toBe("local-edit");
    // 未污染全局
    expect(({} as any).evil).toBeUndefined();
  });
});

describe("EXTENDSI18N-5：外部删除顶层键必须同步到本地 store 且不被 $save 写回", () => {
  beforeEach(() => {
    backing.clear();
    changeListeners.length = 0;
  });

  it("外部快照缺少顶层键 lastUserInfoAutoFlushAt：本地删除，下一次 $save 不写回", async () => {
    backing.set(STORE_KEY, {
      sites: { siteA: { name: "A", sortIndex: 1 } },
      lastUserInfoAutoFlushAt: 123,
      lastSearchFilter: "",
    });

    const store = createTestStore();
    await store.$onReady();
    expect(store.lastUserInfoAutoFlushAt).toBe(123);

    // 模拟旧版本备份恢复：备份里没有 lastUserInfoAutoFlushAt 这个顶层键
    await storageLocal.set({
      [STORE_KEY]: { sites: { siteA: { name: "A", sortIndex: 1 } }, lastSearchFilter: "restored" },
    });

    expect(Object.hasOwn(store.$state as any, "lastUserInfoAutoFlushAt")).toBe(false);
    expect(store.lastSearchFilter).toBe("restored");

    await store.$save();
    const persisted = backing.get(STORE_KEY) as any;
    expect(Object.hasOwn(persisted, "lastUserInfoAutoFlushAt")).toBe(false);
    expect(persisted.lastSearchFilter).toBe("restored");
  });
});
