/**
 * IPC 路径写入的原型污染防护（缺陷清单 C-1）。
 *
 * `patchExtStoragePath` 的 `path` 完全来自消息发送方（内容脚本可被页面影响），
 * 而 `patchExtStoragePathLocal` 会沿路径克隆容器后写回 storage。若路径段是 `__proto__`，
 * `cloneCursor["__proto__"] = childClone` 会改写克隆对象／全局原型 —— 这条用例把攻击向量钉死：
 * 1. `["__proto__", "polluted"]`：cloneAlongPath 直接拒绝（reject），且 `Object.prototype` 不被写入；
 * 2. 叶子段是 `__proto__` 时由 `setValueByPath` 兜底拒绝（静默忽略，同样不污染）；
 * 3. 对照组：正常嵌套路径仍然照常写入（防护不能误伤）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

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
  storage: {
    local: storageLocal,
    onChanged: storageLocal.onChanged,
    session: { get: () => Promise.resolve({}), set: () => Promise.resolve(), remove: () => Promise.resolve() },
  },
  runtime: {
    id: "test-extension-id",
    onMessage: { addListener: () => undefined, removeListener: () => undefined },
    sendMessage: () => Promise.resolve(undefined),
    getURL: (path: string) => `chrome-extension://test/${path}`,
  },
  tabs: { create: () => Promise.resolve(), query: () => Promise.resolve([]) },
  downloads: { download: () => Promise.resolve(1) },
});
vi.stubGlobal("__BROWSER__", "chrome");

const { patchExtStoragePathLocal } = await import("@/background/utils/base.ts");

function hasGlobalPollution(key: string): boolean {
  return Object.prototype.hasOwnProperty.call(Object.prototype, key) || Object.keys(Object.prototype).includes(key);
}

describe("patchExtStoragePathLocal：原型污染防护（C-1）", () => {
  beforeEach(() => {
    backing.clear();
    // 不重建 changeListeners（模块加载时注册的缓存失效监听器只有一份），只发一次清空通知
    emitChanges({ metadata: { oldValue: undefined, newValue: undefined } });
  });

  it("path = ['__proto__', 'polluted'] 被拒绝，且不污染全局原型", async () => {
    await expect(patchExtStoragePathLocal("metadata", ["__proto__", "polluted"], "yes")).rejects.toThrow();
    expect(hasGlobalPollution("polluted")).toBe(false);
    expect(({} as any).polluted).toBeUndefined();
  });

  it("path = ['a', '__proto__']（危险段在叶子）同样不污染", async () => {
    backing.set("metadata", { a: 1 });
    await patchExtStoragePathLocal("metadata", ["a", "__proto__"], { polluted2: 1 }).catch(() => undefined);

    expect(hasGlobalPollution("polluted2")).toBe(false);
    expect(({} as any).polluted2).toBeUndefined();
    // 危险段被整条拒绝：storage 内容保持原样，没有被写到其它位置
    expect(backing.get("metadata")).toEqual({ a: 1 });
  });

  it("constructor / prototype 段被拒绝且不污染", async () => {
    backing.set("metadata", { a: 1 });
    await patchExtStoragePathLocal("metadata", ["constructor", "prototype", "bad"], 1).catch(() => undefined);

    expect(hasGlobalPollution("bad")).toBe(false);
    expect((backing.get("metadata") as any).a).toBe(1);
  });

  it("对照组：正常嵌套路径仍照常写入", async () => {
    backing.set("metadata", { sites: { mteam: { url: "https://old.example" } } });

    await patchExtStoragePathLocal("metadata", ["sites", "mteam", "url"], "https://new.example");

    expect((backing.get("metadata") as any).sites.mteam.url).toBe("https://new.example");
  });
});
