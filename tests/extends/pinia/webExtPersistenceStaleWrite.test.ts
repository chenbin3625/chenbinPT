/**
 * M（REVIEW-FINDINGS stores-1）：写盘超时后的「迟到写入」必须被丢弃。
 *
 * G5 的超时只让 `$save()` 的 promise 及时 reject，底层写盘任务仍在继续；超时后下一次
 * `$save()` 会立刻开始新的一代写入。若旧任务随后完成，旧内容会覆盖新内容、并把
 * `syncedSnapshot` 基线回退。修复后每次写盘带代际号，迟到的旧代在真正 `storage.set` 之前
 * 与完成之后都校验代际，过期即丢弃。
 *
 * 另一个修复（stores-2）是「迟到的自身回声不得把基线回退」：`onChanged` 只在匹配到
 * **最新一次**自身写入快照时刷新基线，更早写入的迟到回声只被忽略。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, defineStore } from "pinia";
import { createApp, h } from "vue";

type StorageChange = Record<string, { oldValue?: unknown; newValue?: unknown }>;

const state = vi.hoisted(() => ({
  backing: new Map<string, unknown>(),
  listeners: [] as Array<(changes: StorageChange, areaName: string) => void>,
  setCalls: [] as Array<Record<string, unknown>>,
  /** 置 true 后 storage.set 正常落盘；置 false 时挂起，由测试手动 resolve */
  autoWrite: true,
  pendingWrites: [] as Array<() => void>,
  deferGet: false,
  pendingGets: [] as Array<() => void>,
}));

/** chrome.storage 语义：读/写都会经过结构化克隆（这里用 JSON 克隆近似），对象不共享引用 */
const clone = <T>(value: T): T => (value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T));

function emitChanges(changes: StorageChange) {
  for (const listener of state.listeners) listener(changes, "local");
}

const storageLocal = {
  get: (key: string) => {
    if (state.deferGet) {
      return new Promise<Record<string, unknown>>((resolve) => {
        state.pendingGets.push(() => resolve(clone(state.backing.has(key) ? { [key]: state.backing.get(key) } : {})));
      });
    }
    return Promise.resolve(clone(state.backing.has(key) ? { [key]: state.backing.get(key) } : {}));
  },
  set: (items: Record<string, unknown>) => {
    state.setCalls.push(items);
    const apply = () => {
      const changes: StorageChange = {};
      for (const [key, value] of Object.entries(items)) {
        const cloned = clone(value);
        changes[key] = { oldValue: clone(state.backing.get(key)), newValue: cloned };
        state.backing.set(key, cloned);
      }
      emitChanges(changes);
    };
    if (state.autoWrite) {
      apply();
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      state.pendingWrites.push(() => {
        apply();
        resolve();
      });
    });
  },
  remove: (key: string) => {
    state.backing.delete(key);
    return Promise.resolve();
  },
  onChanged: {
    addListener: (fn: (changes: StorageChange, areaName: string) => void) => state.listeners.push(fn),
    removeListener: (fn: (changes: StorageChange, areaName: string) => void) => {
      const index = state.listeners.indexOf(fn);
      if (index >= 0) state.listeners.splice(index, 1);
    },
  },
};

vi.stubGlobal("chrome", {
  storage: { local: storageLocal, onChanged: storageLocal.onChanged },
});

const { piniaWebExtPersistencePlugin } = await import("~/extends/pinia/webExtPersistence.ts");

const STORE_KEY = "testStaleWrite";

function createTestStore() {
  const pinia = createPinia();
  pinia.use(piniaWebExtPersistencePlugin);
  createApp({ render: () => h("div") }).use(pinia);
  const useStore = defineStore("testStaleWrite", {
    persistWebExt: true,
    state: () => ({ value: 0, other: "x" }),
  });
  return useStore(pinia);
}

async function flushMicrotasks() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

beforeEach(() => {
  state.backing.clear();
  state.listeners.length = 0;
  state.setCalls.length = 0;
  state.pendingWrites.length = 0;
  state.pendingGets.length = 0;
  state.autoWrite = true;
  state.deferGet = false;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("M：写盘超时后的迟到写入不得覆盖新基线", () => {
  it("超时后新一轮写入已完成时，旧一代在 set 之前被丢弃（storage 保留新内容）", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const store = createTestStore();
    await store.$onReady();

    // 第一代：卡在 mergeBeforeWrite 的 storage.get 上（模拟极慢的读），随后超时
    state.deferGet = true;
    const firstSave = store.$save({ value: 1, other: "x" });
    await flushMicrotasks();
    expect(state.pendingGets.length, "第一代应停在读取 storage 现值").toBe(1);

    await vi.advanceTimersByTimeAsync(10_001);
    await expect(firstSave).rejects.toThrow(/timed out/i);
    // 让 inFlight 的 finally（清空 + 空 flushQueued）先执行，确保第二次 $save 真正开启新的一代
    await flushMicrotasks();

    // 第二代：读立即返回，正常完成并落盘 value=2
    state.deferGet = false;
    const secondSave = store.$save({ value: 2, other: "x" });
    await flushMicrotasks();
    await secondSave;
    expect((state.backing.get(STORE_KEY) as any)?.value).toBe(2);

    const setsBeforeStale = state.setCalls.length;

    // 现在第一代的 storage.get 才返回旧内容（value=0/1 的基线）：它必须发现代际已过期并放弃 set
    state.pendingGets.shift()!();
    await flushMicrotasks();

    expect(state.setCalls.length, "过期代的写入不得再落到 storage").toBe(setsBeforeStale);
    expect((state.backing.get(STORE_KEY) as any)?.value, "storage 必须保留新代写入的内容").toBe(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("stale persistence write discarded"));
  });

  it("正常（未超时）写入仍会落盘并等待完成", async () => {
    const store = createTestStore();
    await store.$onReady();

    store.value = 7;
    await store.$save();
    expect((state.backing.get(STORE_KEY) as any)?.value).toBe(7);
  });
});
