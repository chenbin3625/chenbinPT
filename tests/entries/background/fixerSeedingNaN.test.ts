/**
 * `fixStoredUserInfo` 的 seeding 分支回归测试（DEFS2-12 的跨包收口）。
 *
 * 缺陷：DEFS2-12 已把 nordicbytes 的 seeding 过滤器改成「取不到 (n) 计数时返回 undefined」，
 * 但该 undefined 在 `AbstractBittorrentSite.getFieldData` 里被 `query ??= elementQuery.text ?? ""`
 * 回落成空串 "" 落库；而本 fixer 的 seeding 分支对 parseInt 得到 NaN 的字符串执行
 * `fixed.seeding = 0`，于是每次 onInstalled 都把「没取到」重新塌回静默的 0 个做种。
 *
 * 期望：NaN 时删掉该字段（保持「无值」），可解析的字符串仍照旧转成数字，真正的 0 不受影响。
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
  get: (key: string) => Promise.resolve(backing.has(key) ? { [key]: structuredClone(backing.get(key)) } : {}),
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

/** 直接读落地数据：断言「写没写、写成什么」都以真实存下来的形状为准 */
function storedField(): Record<string, unknown> {
  return (backing.get("userInfo") as Record<string, Record<string, Record<string, unknown>>>).mteam["2026-10-01"]!;
}

/** 把一条用户信息放进存储、跑一次修复，然后返回修复后的那条记录 */
async function fixOne(value: Record<string, unknown>): Promise<Record<string, unknown>> {
  backing.clear();
  await storageLocal.set({ userInfo: { mteam: { "2026-10-01": value } } });

  await fixAllStoredUserInfo();

  return storedField();
}

describe("fixStoredUserInfo：seeding 取不到时不再塌成 0（DEFS2-12）", () => {
  beforeEach(() => {
    backing.clear();
  });

  it("空串（DEFS2-12 过滤器返回 undefined 后落库的形状）→ 删掉字段，而不是写 0", async () => {
    const fixed = await fixOne({ ratio: "1.5", seeding: "" });

    expect("seeding" in fixed, "「没取到」不能变成任何值（旧实现写 0）").toBe(false);
    expect(fixed.seeding).toBeUndefined();
    // 同一条记录里的其它字段仍照常修复
    expect(fixed.ratio).toBe(1.5);
  });

  it('取不到的非数字串（如 "N/A" / "-"）同样删字段而不是 0', async () => {
    expect("seeding" in (await fixOne({ seeding: "N/A" })), 'seeding: "N/A"').toBe(false);
    expect("seeding" in (await fixOne({ seeding: "-" })), 'seeding: "-"').toBe(false);
  });

  it("可解析的字符串仍照旧转成数字（不能因为防 0 而把有效值一起丢掉）", async () => {
    expect(await fixOne({ seeding: "3" })).toEqual({ seeding: 3 });
    expect(await fixOne({ seeding: "  42  " })).toEqual({ seeding: 42 });
  });

  it('字符串 "0" 与数字 0 都保持 0（真实 0 个做种不能被当成「没取到」删掉）', async () => {
    expect(await fixOne({ seeding: "0" })).toEqual({ seeding: 0 });
    expect(await fixOne({ seeding: 0 })).toEqual({ seeding: 0 });
  });

  it("修复是幂等的：同一份含空串 seeding 的数据连跑两次，结果一致且都无 seeding", async () => {
    const first = await fixOne({ ratio: "1.5", seeding: "" });
    await fixAllStoredUserInfo();
    const second = storedField();

    expect(second).toEqual(first);
    expect("seeding" in second).toBe(false);
    expect(second.ratio).toBe(1.5);
  });
});
