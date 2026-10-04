/**
 * 下载历史恢复的原子性 / 数据校验测试（数据完整性回归）。
 *
 * 历史缺陷：`restoreBackupData` 先执行 `db.clear("download_history")`（独立事务，立即提交），
 * 之后才对 `restoreData.downloadHistory` 执行 `.map(...)`。而 zip 中缺少对应文件时
 * `jsZipBlobToBackupData` 只会跳过该 key（manifest 里却仍有它的名字），于是该值可能是 undefined：
 * 本机下载历史先被清空、随后抛错且不回滚，属于不可恢复的数据丢失。
 *
 * 回归要点：
 * 1. 数据非数组时直接放弃，绝不清空（连事务都不开启）；
 * 2. clear 与全部 put 必须在**同一个事务**内（mock 不提供 db 级 clear，只有事务内的 store.clear）；
 * 3. 任一条写入失败时整体回滚，本机历史保持原样。
 */
import { describe, expect, it } from "vitest";

import { replaceDownloadHistory, type IDownloadHistoryTransaction } from "@ptd/backupServer/utils.ts";

/**
 * 最小 IndexedDB 事务 mock：只有事务提交（done resolve）时才让 clear/put 生效，
 * 因此可以真实复现「写入失败 → 整体回滚」的语义。
 * 只提供事务工厂（没有 db 级 clear）：旧实现的 `db.clear()` 路径在这里会直接失败。
 */
function createMockDb(initial: any[]) {
  const state = { data: [...initial], transactions: 0 };
  const opLog: string[] = [];

  const openTransaction = (): IDownloadHistoryTransaction => {
    state.transactions += 1;
    opLog.push("transaction:download_history:readwrite");

    let cleared = false;
    let failure: unknown;
    const staged: any[] = [];

    const store = {
      async clear() {
        opLog.push("clear");
        cleared = true;
      },
      async put(value: any) {
        opLog.push(`put:${JSON.stringify(value)}`);
        if (failure) {
          throw failure;
        }
        if (value?.fail) {
          failure = new Error("put failed");
          throw failure;
        }
        staged.push(value);
      },
    };

    const done = Promise.resolve().then(() => {
      if (failure) {
        throw failure;
      }
      // 事务提交：clear + 全部 put 一次性生效
      state.data = cleared ? [...staged] : [...state.data, ...staged];
    });
    done.catch(() => undefined); // 失败由 put 的 rejection 表达，这里避免未处理的 rejection

    return { store, done };
  };

  return { openTransaction, state, opLog };
}

describe("replaceDownloadHistory：非法数据不清空本机历史", () => {
  it.each([
    ["undefined（zip 缺少 downloadHistory.json）", undefined],
    ["null", null],
    ["对象", { id: 1 }],
    ["字符串", "downloadHistory"],
    ["数字", 42],
  ])("%s → 返回 false，不开启事务也不清空", async (_name, invalid) => {
    const { openTransaction, state } = createMockDb([{ id: 1 }]);

    await expect(replaceDownloadHistory(openTransaction, invalid)).resolves.toBe(false);
    expect(state.transactions).toBe(0);
    expect(state.data).toEqual([{ id: 1 }]);
  });
});

describe("replaceDownloadHistory：clear 与 put 在同一事务内", () => {
  it("合法数据按「先 clear 再逐条 put」提交，旧记录被整体替换", async () => {
    const { openTransaction, state, opLog } = createMockDb([{ id: 1 }]);

    await expect(replaceDownloadHistory(openTransaction, [{ id: 2 }, { id: 3 }])).resolves.toBe(true);

    expect(state.transactions).toBe(1); // 只开一个事务（旧实现 clear 与写入是两个独立操作）
    expect(opLog).toEqual(["transaction:download_history:readwrite", "clear", 'put:{"id":2}', 'put:{"id":3}']);
    expect(state.data).toEqual([{ id: 2 }, { id: 3 }]);
  });

  it("空数组是合法输入：历史被清空（用户的显式恢复意图）", async () => {
    const { openTransaction, state } = createMockDb([{ id: 1 }]);

    await expect(replaceDownloadHistory(openTransaction, [])).resolves.toBe(true);
    expect(state.data).toEqual([]);
  });

  it("任一条写入失败时整体回滚，本机历史保持原样", async () => {
    const { openTransaction, state } = createMockDb([{ id: 1 }]);

    await expect(replaceDownloadHistory(openTransaction, [{ id: 2 }, { fail: true }])).rejects.toThrow("put failed");
    expect(state.transactions).toBe(1);
    expect(state.data).toEqual([{ id: 1 }]); // 没有被 clear 掉
  });
});
