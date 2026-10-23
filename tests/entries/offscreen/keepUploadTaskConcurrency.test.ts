/**
 * B1-6：辅种任务写入串行化（修复「读存在 → 写」的 TOCTOU）。
 *
 * 修复前：`updateKeepUploadTask` 读完「任务存在」后、写回之前，若并发的删除（或清空）
 * 已完成，更新会把已删除的任务整条写回（「任务不存在时不写入」失效）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  onMessage: vi.fn(),
  sendMessage: vi.fn(),
  store: new Map<string, unknown>(),
  readGate: null as Promise<void> | null,
  patchCalls: [] as Array<{ key: string; path: any[]; remove?: boolean; value?: any }>,
  /** 写操作实际执行顺序：`write:<id>` / `remove:<id>` / `replace`（整表替换） */
  mutations: [] as string[],
}));

vi.mock("@/messages.ts", () => ({ onMessage: mocks.onMessage, sendMessage: mocks.sendMessage }));

async function loadModule() {
  vi.resetModules();
  mocks.onMessage.mockClear();
  mocks.sendMessage.mockReset();
  mocks.store.clear();
  mocks.readGate = null;
  mocks.patchCalls = [];
  mocks.mutations = [];

  mocks.sendMessage.mockImplementation(async (name: string, payload: any) => {
    if (name === "getExtStoragePath") {
      if (mocks.readGate) {
        await mocks.readGate;
      }
      const path = Array.isArray(payload?.path) ? payload.path : [];
      return mocks.store.get(path[0]);
    }
    if (name === "patchExtStoragePath") {
      mocks.patchCalls.push(payload);
      const key = String(payload.path[0]);
      mocks.mutations.push(payload.remove ? `remove:${key}` : `write:${key}`);
      if (payload.remove) {
        mocks.store.delete(key);
      } else {
        mocks.store.set(key, payload.value);
      }
      return undefined;
    }
    if (name === "setExtStorage") {
      mocks.mutations.push("replace");
      mocks.store.clear();
      for (const [key, value] of Object.entries(payload.value ?? {})) {
        mocks.store.set(key, value);
      }
      return undefined;
    }
    return undefined;
  });

  return await import("@/offscreen/utils/keepUploadTask.ts");
}

describe("B1-6：辅种任务更新与删除串行化", () => {
  beforeEach(() => {
    mocks.store.clear();
  });

  it("更新读到「存在」后并发删除：更新不得把任务写回", async () => {
    const { createKeepUploadTask, updateKeepUploadTask, deleteKeepUploadTask } = await loadModule();
    await createKeepUploadTask({ id: "t1", status: "pending" } as any);
    expect(mocks.store.has("t1")).toBe(true);
    mocks.patchCalls = [];

    // 让更新卡在「读存在」这一步，模拟跨上下文往返窗口
    let releaseRead!: () => void;
    mocks.readGate = new Promise<void>((resolve) => (releaseRead = resolve));

    const updating = updateKeepUploadTask({ id: "t1", status: "completed" } as any);
    const deleting = deleteKeepUploadTask("t1");
    // 删除必须排在更新之后（串行链），此时不应已执行
    expect(mocks.patchCalls).toHaveLength(0);

    releaseRead();
    await Promise.all([updating, deleting]);

    // 删除是最后一步 → 任务最终被删除，没有被更新写回
    expect(mocks.store.has("t1")).toBe(false);
    expect(mocks.patchCalls.map((call) => (call.remove ? "remove" : "write"))).toEqual(["write", "remove"]);
  });

  it("clearKeepUploadTasks 排在进行中的更新之后，不会留下复活的任务", async () => {
    const { createKeepUploadTask, updateKeepUploadTask, clearKeepUploadTasks } = await loadModule();
    await createKeepUploadTask({ id: "t1", status: "pending" } as any);
    await createKeepUploadTask({ id: "t2", status: "pending" } as any);
    mocks.patchCalls = [];

    let releaseRead!: () => void;
    mocks.readGate = new Promise<void>((resolve) => (releaseRead = resolve));

    const updating = updateKeepUploadTask({ id: "t1", status: "completed" } as any);
    const clearing = clearKeepUploadTasks();
    releaseRead();
    await Promise.all([updating, clearing]);

    expect(mocks.store.size).toBe(0);
  });

  it("更新一个不存在的任务仍然不写入（既有语义）", async () => {
    const { updateKeepUploadTask } = await loadModule();
    await updateKeepUploadTask({ id: "missing", status: "completed" } as any);
    expect(mocks.patchCalls).toHaveLength(0);
    expect(mocks.store.has("missing")).toBe(false);
  });

  it("备份恢复式整表替换（replaceKeepUploadTasks）同样进入串行链，不抢在途更新之前执行", async () => {
    const { createKeepUploadTask, updateKeepUploadTask, replaceKeepUploadTasks } = await loadModule();
    await createKeepUploadTask({ id: "t1", status: "pending" } as any);
    mocks.mutations = [];

    // 让更新卡在「读存在」这一步，模拟跨上下文往返窗口
    let releaseRead!: () => void;
    mocks.readGate = new Promise<void>((resolve) => (releaseRead = resolve));

    const updating = updateKeepUploadTask({ id: "t1", status: "completed" } as any);
    const restoring = replaceKeepUploadTasks({ t2: { id: "t2", status: "pending" } } as any);

    // 恢复的整表覆盖必须排在在途更新之后：此刻整表替换不得已执行
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.mutations, "整表替换不得抢在在途更新的读取之前执行").toEqual([]);
    expect(mocks.store.has("t1"), "整表替换不得提前抹掉现有任务").toBe(true);

    releaseRead();
    await Promise.all([updating, restoring]);

    // 顺序：更新写回 t1 → 恢复整表替换为 t2；最终只保留恢复结果
    expect(mocks.mutations).toEqual(["write:t1", "replace"]);
    expect(mocks.store.has("t2")).toBe(true);
    expect(mocks.store.has("t1")).toBe(false);
  });
});
