/**
 * 存储读缓存的「写入隔离」测试（见 L-8 / B-10）。
 *
 * 缺陷：`patchExtStoragePathLocal` 先从读缓存拿到**对象引用**，再在上面就地 `setValueByPath`，
 * 最后才 `setItem`。于是：
 * - 若 `setItem` 失败（配额、SW 被回收），缓存已经被改成「从未落盘的值」，后续读路径全都拿到假数据；
 * - 读改写用的是可能已过期的缓存快照，会把第二个写者（options 侧 pinia 的整份 `$save()`）
 *   刚写入的字段整份覆盖掉。
 *
 * 修复：按路径写入时**重新从 storage 读取**，只在路径上的容器副本上改值，
 * `setItem` 成功后才换入缓存、失败则失效缓存（下一次读取重新拉取）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type StorageChange = Record<string, { oldValue?: unknown; newValue?: unknown }>;

const backing = new Map<string, unknown>();
const changeListeners: Array<(changes: StorageChange, areaName: string) => void> = [];
let setItemShouldFail = false;
let getCallCount = 0;

function emitChanges(changes: StorageChange) {
  for (const listener of changeListeners) {
    listener(changes, "local");
  }
}

const storageLocal = {
  get: (key: string) => {
    getCallCount++;
    return Promise.resolve(backing.has(key) ? { [key]: backing.get(key) } : {});
  },
  set: (items: Record<string, unknown>) => {
    if (setItemShouldFail) {
      return Promise.reject(new Error("QUOTA_BYTES quota exceeded"));
    }
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

const chromeMock = {
  storage: {
    local: storageLocal,
    onChanged: storageLocal.onChanged,
    session: {
      get: () => Promise.resolve({}),
      set: () => Promise.resolve(),
      remove: () => Promise.resolve(),
    },
  },
  runtime: {
    id: "test-extension-id",
    onMessage: { addListener: () => undefined, removeListener: () => undefined },
    sendMessage: () => Promise.resolve(undefined),
    getURL: (path: string) => `chrome-extension://test/${path}`,
  },
  tabs: { create: () => Promise.resolve(), query: () => Promise.resolve([]) },
  downloads: { download: () => Promise.resolve(1) },
};

vi.stubGlobal("chrome", chromeMock);
vi.stubGlobal("__BROWSER__", "chrome");

const { getExtStorageCached, getExtStoragePathCached, patchExtStoragePathLocal } =
  await import("@/background/utils/base.ts");

describe("存储读缓存：写入失败不得污染缓存（L-8）", () => {
  /** 种入数据时必须走 chrome.storage（触发 onChanged 让读缓存失效） */
  async function seed(key: string, value: unknown) {
    await storageLocal.set({ [key]: value });
  }

  beforeEach(async () => {
    backing.clear();
    getCallCount = 0;
    setItemShouldFail = false;
    emitChanges({ userInfo: { oldValue: undefined, newValue: undefined } });
    emitChanges({ metadata: { oldValue: undefined, newValue: undefined } });
    emitChanges({ config: { oldValue: undefined, newValue: undefined } });
  });

  it("setItem 失败后：缓存里不能出现从未落盘的值", async () => {
    await seed("userInfo", { mteam: { "2026-10-01": { ratio: 1 } } });

    // 先读一次，让缓存持有这份对象（旧实现会在这份对象上就地改值）
    const cached = await getExtStorageCached("userInfo");
    expect(cached).toEqual({ mteam: { "2026-10-01": { ratio: 1 } } });

    setItemShouldFail = true;
    await expect(patchExtStoragePathLocal("userInfo", ["mteam", "2026-10-02"], { ratio: 2 })).rejects.toThrow(
      /quota exceeded/i,
    );
    setItemShouldFail = false;

    // storage 里没有新值
    expect(backing.get("userInfo")).toEqual({ mteam: { "2026-10-01": { ratio: 1 } } });

    // 关键断言 1：早先拿到的缓存对象没有被就地改脏
    expect(cached).toEqual({ mteam: { "2026-10-01": { ratio: 1 } } });

    // 关键断言 2：后续读路径必须拿到「确实落过盘」的值
    const afterFailure = await getExtStorageCached("userInfo");
    expect(afterFailure).toEqual({ mteam: { "2026-10-01": { ratio: 1 } } });
    expect(Object.keys((afterFailure as any).mteam)).toEqual(["2026-10-01"]);
  });

  it("setItem 成功后才换入缓存：写入后的读取命中新值且不再回源", async () => {
    await seed("userInfo", { mteam: { "2026-10-01": { ratio: 1 } } });
    await getExtStorageCached("userInfo");
    const readsBefore = getCallCount;

    await patchExtStoragePathLocal("userInfo", ["mteam", "2026-10-02"], { ratio: 2 });

    const afterPatch = await getExtStorageCached("userInfo");
    expect(afterPatch).toEqual({ mteam: { "2026-10-01": { ratio: 1 }, "2026-10-02": { ratio: 2 } } });
    // 写链内部回源读 1 次；patch 之后的读取不应再有新的回源（缓存已换成落盘值）
    expect(getCallCount).toBe(readsBefore + 1);
  });

  it("读改写从 storage 重新读取，不用过期缓存覆盖其它写者刚写入的字段（B-10）", async () => {
    await seed("metadata", { sites: { mteam: { url: "https://old.example" } }, solutionCount: 1 });
    await getExtStorageCached("metadata"); // 缓存旧快照

    // 模拟 options 侧 pinia 持久化写入同一个 key，但 onChanged 尚未送达（缓存仍是旧对象）
    backing.set("metadata", { sites: { mteam: { url: "https://old.example" } }, solutionCount: 1, addedByPinia: true });

    await patchExtStoragePathLocal("metadata", ["sites", "mteam", "url"], "https://new.example");

    const stored = backing.get("metadata") as any;
    expect(stored.sites.mteam.url).toBe("https://new.example");
    expect(stored.addedByPinia, "过期缓存快照不得覆盖其它写者刚写入的字段").toBe(true);
  });

  it("路径取值仍走缓存（读路径不受本次改动影响）", async () => {
    await seed("config", { userInfo: { queueConcurrency: 2 } });
    expect(await getExtStoragePathCached("config", "userInfo.queueConcurrency")).toBe(2);
    const readsBefore = getCallCount;
    expect(await getExtStoragePathCached("config", "userInfo.queueConcurrency")).toBe(2);
    expect(getCallCount).toBe(readsBefore);
  });
});
