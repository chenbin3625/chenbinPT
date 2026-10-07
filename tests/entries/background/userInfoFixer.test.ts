/**
 * `fixAllStoredUserInfo` 写入链回归测试（见 B-18）。
 *
 * 缺陷：它直接 `extStorage.setItem("userInfo", …)`，既绕过 `enqueueWrite`、也不同步失效 `storageReadCache`：
 * - 与同一 SW 启动里并发执行的 `patchExtStoragePathLocal("userInfo", …)`（用户信息刷新）互相整份覆盖；
 * - 在 `setItem` 到 `onChanged` 到达的窗口里，SW 内的读路径仍会拿到修复前的旧对象。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type StorageChange = Record<string, { oldValue?: unknown; newValue?: unknown }>;

const backing = new Map<string, unknown>();
const changeListeners: Array<(changes: StorageChange, areaName: string) => void> = [];
let getCallCount = 0;
/**
 * 是否广播 onChanged。
 *
 * 真实 chrome.storage 的 onChanged 是**异步广播**，`setItem` resolve 之后才到达；
 * 测试里把「不广播」当作最坏情况（写入完成但 onChanged 尚未送达），
 * 这样「写入方自己有没有同步失效读缓存」才会被真正验证到。
 */
let emitOnChange = true;

function emitChanges(changes: StorageChange) {
  if (!emitOnChange) {
    return;
  }
  for (const listener of changeListeners) {
    listener(changes, "local");
  }
}

const storageLocal = {
  get: (key: string) => {
    getCallCount++;
    return Promise.resolve(backing.has(key) ? { [key]: structuredClone(backing.get(key)) } : {});
  },
  set: (items: Record<string, unknown>) => {
    const changes: StorageChange = {};
    for (const [key, value] of Object.entries(items)) {
      changes[key] = { oldValue: backing.get(key), newValue: value };
      backing.set(key, structuredClone(value));
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

const { fixAllStoredUserInfo } = await import("@/background/utils/fixer.ts");
const { getExtStorageCached, patchExtStoragePathLocal } = await import("@/background/utils/base.ts");

describe("fixAllStoredUserInfo（B-18）", () => {
  beforeEach(async () => {
    backing.clear();
    getCallCount = 0;
    emitOnChange = true;
    emitChanges({ userInfo: { oldValue: undefined, newValue: undefined } });
  });

  it("修复后读路径立刻看到修复结果（不能返回缓存里的旧对象）", async () => {
    await storageLocal.set({ userInfo: { mteam: { "2026-10-01": { ratio: "1.5", seeding: "3" } } } });

    // 先读一次让缓存持有修复前的对象
    const beforeFix = (await getExtStorageCached("userInfo")) as any;
    expect(beforeFix.mteam["2026-10-01"].ratio).toBe("1.5");

    // 最坏情况：写入完成但 onChanged 还没送达（不能靠事件来失效缓存）
    emitOnChange = false;
    await fixAllStoredUserInfo();
    emitOnChange = true;

    expect((backing.get("userInfo") as any).mteam["2026-10-01"]).toEqual({ ratio: 1.5, seeding: 3 });
    const afterFix = (await getExtStorageCached("userInfo")) as any;
    expect(afterFix.mteam["2026-10-01"], "修复写必须同步失效读缓存").toEqual({ ratio: 1.5, seeding: 3 });
  });

  it("修复与并发的局部写入互不覆盖（都进同一个写链）", async () => {
    await storageLocal.set({ userInfo: { mteam: { "2026-10-01": { ratio: "1.5" } } } });

    // 先发起一次局部写入（进写链），再执行修复：修复必须在它之后读改写，不能拿旧快照整份覆盖
    const patch = patchExtStoragePathLocal("userInfo", ["mteam", "2026-10-02"], { ratio: 2 });
    const fix = fixAllStoredUserInfo();
    await Promise.all([patch, fix]);

    const stored = backing.get("userInfo") as any;
    expect(stored.mteam["2026-10-01"]).toEqual({ ratio: 1.5 });
    expect(stored.mteam["2026-10-02"], "并发局部写入不能被修复流程整份覆盖").toEqual({ ratio: 2 });
  });

  it("没有坏数据时不写存储", async () => {
    await storageLocal.set({ userInfo: { mteam: { "2026-10-01": { ratio: 1.5, seeding: 3 } } } });
    const writesBefore = getCallCount;

    await fixAllStoredUserInfo();

    expect((backing.get("userInfo") as any).mteam["2026-10-01"]).toEqual({ ratio: 1.5, seeding: 3 });
    expect(getCallCount).toBe(writesBefore + 1); // 只多了一次链内读取
  });

  it("BACKGROUNDSHARED-6：null / 非对象条目不再击穿整轮修复，且不再静默", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await storageLocal.set({
        userInfo: {
          brokenSite: null, // 站点值本身是坏数据
          mteam: { "2026-10-01": null }, // 某天的记录是坏数据
          btsite: { "2026-10-02": { ratio: "2.5" } }, // 同批数据里的正常站点
        },
      });

      await fixAllStoredUserInfo();

      const stored = backing.get("userInfo") as any;
      // 修复前：第一个坏条目就抛 TypeError，整轮所有站点/日期的修复全部作废。
      // 现在同一批数据里的正常站点仍被修好：
      expect(stored.btsite["2026-10-02"]).toEqual({ ratio: 2.5 });
      // 坏条目原样保留（直接丢弃等于静默删用户历史）
      expect(stored.brokenSite).toBeNull();
      expect(stored.mteam["2026-10-01"]).toBeNull();
      // 跳过必须可见（本仓库约定走 logBackgroundError → console.warn + logger 消息）
      expect(warnSpy.mock.calls.some(([message]) => String(message).includes("skipped"))).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("BACKGROUNDSHARED-6：只有坏条目、没有任何可修复项时不写存储", async () => {
    await storageLocal.set({ userInfo: { brokenSite: null } });
    const writesBefore = getCallCount;

    await fixAllStoredUserInfo();

    expect((backing.get("userInfo") as any).brokenSite).toBeNull();
    expect(getCallCount).toBe(writesBefore + 1); // 只有链内读取，没有多余的整份写回
  });
});
