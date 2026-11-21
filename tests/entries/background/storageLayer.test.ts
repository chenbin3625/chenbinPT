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
/** N1：chrome.runtime.onStartup 监听器（storage.ts 顶层注册，浏览器启动时补一次 storage 访问级别收紧） */
const startupListeners: Array<() => void> = [];
let getCallCount = 0;
let setCallCount = 0;

function emitChanges(changes: StorageChange) {
  for (const listener of changeListeners) {
    listener(changes, "local");
  }
}

const storageLocal = {
  setAccessLevel: vi.fn(() => Promise.resolve()),
  get: (key: string) => {
    getCallCount++;
    return Promise.resolve(backing.has(key) ? { [key]: backing.get(key) } : {});
  },
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
    onStartup: { addListener: (fn: () => void) => startupListeners.push(fn) },
    sendMessage: () => Promise.resolve(undefined),
    getURL: (path: string) => `chrome-extension://test/${path}`,
  },
  tabs: { create: () => Promise.resolve(), query: () => Promise.resolve([]) },
  downloads: { download: () => Promise.resolve(1) },
};

vi.stubGlobal("chrome", chromeMock);
vi.stubGlobal("__BROWSER__", "chrome");

vi.resetModules();
const { getExtStorageCached, getExtStoragePathCached, patchExtStoragePathLocal, patchExtStoragePathsLocal } =
  await import("@/background/utils/base.ts");

describe("service worker 存储层（读缓存 + 路径读写）", () => {
  /** 种入数据时必须走 chrome.storage（触发 onChanged 让读缓存失效），否则会读到上一个用例的缓存 */
  async function seed(key: string, value: unknown) {
    await storageLocal.set({ [key]: value });
  }

  beforeEach(async () => {
    backing.clear();
    getCallCount = 0;
    setCallCount = 0;
    // 注意：不能清空 changeListeners —— base.ts 的缓存失效监听器是模块加载时注册一次的
    // （清掉它会让缓存永远不失效，测试就会读到上一个用例的脏数据）。
    // 这里改为主动触发一次"存储被清空"的变更通知，让被测模块的缓存失效。
    emitChanges({ metadata: { oldValue: undefined, newValue: undefined } });
    emitChanges({ userInfo: { oldValue: undefined, newValue: undefined } });
    emitChanges({ config: { oldValue: undefined, newValue: undefined } });
  });

  it("启动时限制 storage.local 只允许可信扩展上下文直接访问", async () => {
    storageLocal.setAccessLevel.mockClear();
    vi.resetModules();
    await import("@/storage.ts");
    expect(storageLocal.setAccessLevel).toHaveBeenCalledWith({ accessLevel: "TRUSTED_CONTEXTS" });
  });

  it("N1：runtime.onStartup 会再次收紧 storage.local（访问级别不保证跨浏览器重启保留）", async () => {
    startupListeners.length = 0;
    vi.resetModules();
    await import("@/storage.ts");

    expect(startupListeners.length, "storage.ts 必须在顶层注册 runtime.onStartup 兜底").toBeGreaterThan(0);

    storageLocal.setAccessLevel.mockClear();
    for (const listener of [...startupListeners]) {
      listener();
    }
    expect(storageLocal.setAccessLevel).toHaveBeenCalledWith({ accessLevel: "TRUSTED_CONTEXTS" });
  });

  it("N1：不支持 setAccessLevel 的浏览器必须告警，而不是静默降级", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const originalLocal = chromeMock.storage.local;
    const withoutSetAccessLevel: any = { ...originalLocal };
    delete withoutSetAccessLevel.setAccessLevel;
    (chromeMock.storage as any).local = withoutSetAccessLevel;
    try {
      vi.resetModules();
      await import("@/storage.ts");
      expect(warnSpy.mock.calls.some(([message]) => String(message).includes("setAccessLevel is unavailable"))).toBe(
        true,
      );
    } finally {
      (chromeMock.storage as any).local = originalLocal;
      warnSpy.mockRestore();
    }
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

  it("批量局部写入：删除多天历史只读一次、写一次（removeSiteUserInfo 的 O(1) 读改写）", async () => {
    await seed("userInfo", {
      mteam: { "2026-10-01": { ratio: 1 }, "2026-10-02": { ratio: 2 }, "2026-10-03": { ratio: 3 } },
      ptt: { "2026-10-01": { ratio: 9 } },
    });
    getCallCount = 0;
    setCallCount = 0;

    await patchExtStoragePathsLocal("userInfo", [
      { path: ["mteam", "2026-10-01"], remove: true },
      { path: ["mteam", "2026-10-02"], remove: true },
      { path: ["mteam", "2026-10-03"], remove: true },
    ]);

    // 若退化为逐条 patch，这里会是 3 次读 + 3 次写；大 key 下每天都要整份序列化
    expect(getCallCount).toBe(1);
    expect(setCallCount).toBe(1);

    const stored = backing.get("userInfo") as any;
    expect(stored.mteam).toEqual({});
    expect(stored.ptt["2026-10-01"]).toEqual({ ratio: 9 }); // 其它站点不受影响
  });

  it("批量局部写入：同批次内混合赋值与删除，且不就地修改读到的对象", async () => {
    const original = { mteam: { "2026-10-01": { ratio: 1 } }, lastUserInfo: { siteA: { ratio: 1 } } };
    await seed("userInfo", original);
    const snapshotBefore = await getExtStorageCached("userInfo");

    await patchExtStoragePathsLocal("userInfo", [
      { path: ["mteam", "2026-10-02"], value: { ratio: 2 } },
      { path: ["mteam", "2026-10-01"], remove: true },
    ]);

    const stored = backing.get("userInfo") as any;
    expect(stored.mteam["2026-10-01"]).toBeUndefined();
    expect(stored.mteam["2026-10-02"]).toEqual({ ratio: 2 });
    expect(stored.lastUserInfo).toEqual({ siteA: { ratio: 1 } });
    // 读缓存里的旧对象（可能仍被其它代码持有）必须保持原样
    expect(Object.keys((snapshotBefore as any).mteam)).toEqual(["2026-10-01"]);
  });

  it("批量局部写入：空操作列表直接返回，不触发任何读写", async () => {
    await seed("userInfo", { mteam: { "2026-10-01": { ratio: 1 } } });
    getCallCount = 0;
    setCallCount = 0;

    await patchExtStoragePathsLocal("userInfo", []);

    expect(getCallCount).toBe(0);
    expect(setCallCount).toBe(0);
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
