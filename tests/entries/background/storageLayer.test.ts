/**
 * service worker 存储层行为测试（见 docs/performance-audit.md P0-2 / P0-3）。
 *
 * 这是本轮修复里最"地基"的一块：所有跨上下文的读取都经过读缓存 + 路径取值，
 * 所有局部写入都经过串行写队列。它的正确性无法靠类型检查保证，因此这里用假的
 * `chrome.storage` 做真实行为验证：
 * - 读缓存命中/失效（外部写入必须能让缓存失效，否则会读到脏数据）；
 * - 路径取值与局部写入（含删除、嵌套创建）；
 * - 并发写入串行化（若不串行，读改写会互相覆盖 —— 这是修复前真实存在的丢失更新）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type StorageChange = Record<string, { oldValue?: unknown; newValue?: unknown }>;

const backing = new Map<string, unknown>();
const changeListeners: Array<(changes: StorageChange, areaName: string) => void> = [];
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

describe("service worker 存储层（读缓存 + 路径读写）", () => {
  /** 种入数据时必须走 chrome.storage（触发 onChanged 让读缓存失效），否则会读到上一个用例的缓存 */
  async function seed(key: string, value: unknown) {
    await storageLocal.set({ [key]: value });
  }

  beforeEach(async () => {
    backing.clear();
    getCallCount = 0;
    // 注意：不能清空 changeListeners —— base.ts 的缓存失效监听器是模块加载时注册一次的
    // （清掉它会让缓存永远不失效，测试就会读到上一个用例的脏数据）。
    // 这里改为主动触发一次"存储被清空"的变更通知，让被测模块的缓存失效。
    emitChanges({ metadata: { oldValue: undefined, newValue: undefined } });
    emitChanges({ userInfo: { oldValue: undefined, newValue: undefined } });
    emitChanges({ config: { oldValue: undefined, newValue: undefined } });
  });

  it("读缓存：同一 key 连续读取只反序列化一次", async () => {
    await seed("metadata", { sites: { mteam: { url: "https://mteam.example" } } });

    const first = await getExtStorageCached("metadata");
    const second = await getExtStorageCached("metadata");

    expect(getCallCount).toBe(1);
    expect(second).toBe(first);
  });

  it("读缓存：外部写入触发 onChanged 后必须失效（不能读到脏数据）", async () => {
    await seed("config", { lang: "zh_CN" });
    expect(await getExtStoragePathCached("config", "lang")).toBe("zh_CN");

    // 模拟其它上下文（options / offscreen）写入了同一个 key
    await storageLocal.set({ config: { lang: "en" } });

    const afterExternalWrite = await getExtStoragePathCached("config", "lang");
    expect(afterExternalWrite).toBe("en");
    expect(getCallCount).toBe(2);
  });

  it("路径取值：支持嵌套键、数组下标与默认值", async () => {
    await seed("metadata", {
      sites: { mteam: { merge: { name: "M-Team" } } },
      order: [{ id: 1 }, { id: 2 }],
    });

    expect(await getExtStoragePathCached("metadata", ["sites", "mteam", "merge", "name"])).toBe("M-Team");
    expect(await getExtStoragePathCached("metadata", "order.1.id")).toBe(2);
    expect(await getExtStoragePathCached("metadata", ["sites", "nope", "x"], "fallback")).toBe("fallback");
  });

  it("局部写入：只改目标路径并整份写回，其它字段保持不变", async () => {
    await seed("metadata", { sites: { mteam: { url: "https://old.example" } }, lastUserInfoAutoFlushAt: 1 });

    await patchExtStoragePathLocal("metadata", ["sites", "mteam", "url"], "https://new.example");

    const stored = backing.get("metadata") as any;
    expect(stored.sites.mteam.url).toBe("https://new.example");
    expect(stored.lastUserInfoAutoFlushAt).toBe(1);
  });

  it("局部写入：remove 删除指定路径（用于 removeSiteUserInfo / 快照删除）", async () => {
    await seed("userInfo", { mteam: { "2026-10-01": { ratio: 1 }, "2026-10-02": { ratio: 2 } } });

    await patchExtStoragePathLocal("userInfo", ["mteam", "2026-10-01"], undefined, { remove: true });

    const stored = backing.get("userInfo") as any;
    expect(stored.mteam["2026-10-01"]).toBeUndefined();
    expect(stored.mteam["2026-10-02"]).toEqual({ ratio: 2 });
  });

  it("并发局部写入被串行化：不会互相覆盖（修复前的丢失更新）", async () => {
    await seed("metadata", { lastUserInfo: {} });

    // 不 await，模拟多个站点同时回写（修复前会读同一份旧值再整份写回 → 丢更新）
    await Promise.all([
      patchExtStoragePathLocal("metadata", ["lastUserInfo", "siteA"], { ratio: 1 }),
      patchExtStoragePathLocal("metadata", ["lastUserInfo", "siteB"], { ratio: 2 }),
      patchExtStoragePathLocal("metadata", ["lastUserInfo", "siteC"], { ratio: 3 }),
    ]);

    const stored = backing.get("metadata") as any;
    expect(Object.keys(stored.lastUserInfo).sort()).toEqual(["siteA", "siteB", "siteC"]);
    expect(stored.lastUserInfo.siteB).toEqual({ ratio: 2 });
  });
});
