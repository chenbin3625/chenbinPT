/**
 * webExtPersistence 的两条低风险正确性兜底：
 *
 * - G4：`isDeepEqual` 曾把 Date / Map / Set / RegExp 当成 plain 对象（`Object.keys()` 都是 `[]`），
 *   于是两个不同时间的 Date 会被判为相等，`onChanged` 的最小 patch 直接漏掉这些字段的外部变更。
 *   这里用「restore 未完成（基线还是 null）时到达的外部写入」走到 `applyMinimalPatch`，
 *   断言这些类型的变更都能落到 store 上。
 * - G5：`$save()` 曾没有超时，一次永久挂起的 `storage.set` 会让其后所有 `$save()`（含 pagehide
 *   紧急保存）永久 pending。这里用假时钟验证「超时 reject + 后续写盘仍可重试」。
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
    // 与 chrome.storage 一致：onChanged 在 set 返回前同步派发
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
      sites: { siteA: { name: "A" } },
      lastSyncAt: new Date(1000),
      pattern: /a/g,
      tags: new Set<string>(["x"]),
      scores: new Map<string, number>([["a", 1]]),
    }),
  });
  return useStore(pinia);
}

describe("webExtPersistence：非 plain 值（Date/Map/Set/RegExp）的结构比较（G4）", () => {
  beforeEach(() => {
    backing.clear();
    changeListeners.length = 0;
  });

  it("Date/Map/Set/RegExp 字段的外部变更都能落到 store（而不是被判成「没变」）", () => {
    // 不 await $onReady：restore 还停在第一个 await 上，syncedSnapshot 仍是 null，
    // onChanged 因此走 applyMinimalPatch 路径 —— 正是旧实现漏掉这些类型的那条路径。
    const store = createTestStore();

    // set 内部同步派发 onChanged → 同步 patch
    void storageLocal.set({
      [STORE_KEY]: {
        sites: { siteA: { name: "A" } },
        lastSyncAt: new Date(2000),
        pattern: /changed/gi,
        tags: new Set(["y"]),
        scores: new Map([["a", 2]]),
      },
    });

    // 修复前：Object.keys(Date/Map/Set/RegExp) 都是 [] ⇒ 全部被判成相等、一个字段都不会更新
    expect(store.lastSyncAt).toBeInstanceOf(Date);
    expect(store.lastSyncAt.getTime()).toBe(2000);
    expect(store.pattern.source).toBe("changed");
    expect(store.pattern.flags).toBe("gi");
    expect([...store.tags]).toEqual(["y"]);
    expect(store.scores.get("a")).toBe(2);
  });
});

describe("webExtPersistence：$save 写盘超时（G5）", () => {
  beforeEach(() => {
    backing.clear();
    changeListeners.length = 0;
  });

  it("storage.set 永久挂起时 $save 超时 reject，且后续 $save 仍可成功", async () => {
    vi.useFakeTimers();
    const setSpy = vi.spyOn(storageLocal, "set");
    try {
      const store = createTestStore();
      await store.$onReady();

      // 第一次写盘：永不 resolve（模拟配额/浏览器 bug 导致的 storage.set 卡死）
      setSpy.mockImplementationOnce(() => new Promise<void>(() => undefined));
      store.sites.siteA.name = "hung";
      const hungSave = store.$save();
      const hungAssertion = expect(hungSave).rejects.toThrow(/timed out after 10000ms/);

      await vi.advanceTimersByTimeAsync(10_001);
      await hungAssertion;

      // inFlight 已被释放：下一次 $save 不会被挂起的写永久阻塞
      store.sites.siteA.name = "recovered";
      await store.$save();
      expect((backing.get(STORE_KEY) as any).sites.siteA.name).toBe("recovered");
    } finally {
      setSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});
