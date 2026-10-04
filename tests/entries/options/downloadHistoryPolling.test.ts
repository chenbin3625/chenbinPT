/**
 * V-14 / A-21 回归测试：下载历史的轮询必须能真正刷新表格，并且能承受「记录已被删除」。
 *
 * V-14（修复前）：`downloadHistory` 是 `shallowRef({})`，而轮询用
 * `downloadHistory.value[id] = history` **就地改内层对象** —— shallowRef 只在 `.value`
 * 重新赋值时触发，于是 `downloadHistoryList`（computed）既不失效也不重算，表格一直持有旧记录，
 * 「下载中/等待中」永远不会翻成「已完成/错误」，尽管每秒都在发请求。
 *
 * A-21（修复前）：`getDownloadHistoryById` 返回的是 IndexedDB 的原始 get，键不存在时是 `undefined`；
 * 定时器内直接读 `history.downloadStatus` 会抛 TypeError，轮询链静默死掉，且 `undefined` 残留破坏列表行。
 */
import { computed, shallowRef, triggerRef } from "vue";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

const { sendMessageMock, buildAdvanceItemPropsFn, showSnakebarMock, messageOpenMock } = vi.hoisted(() => ({
  sendMessageMock: vi.fn(),
  buildAdvanceItemPropsFn: vi.fn(),
  showSnakebarMock: vi.fn(),
  messageOpenMock: vi.fn(),
}));

vi.mock("ant-design-vue", () => ({ message: { open: messageOpenMock } }));
vi.mock("@/messages.ts", () => ({ sendMessage: sendMessageMock, onMessage: vi.fn() }));
// 只关心轮询行为，不加载筛选指令（该模块归另一个代理维护）
vi.mock("@/options/directives/useAdvanceFilter.ts", () => ({
  useTableCustomFilter: () => ({ buildAdvanceItemPropsFn }),
}));

async function loadModule() {
  vi.resetModules();
  setActivePinia(createPinia());
  const runtime = await import("@/options/stores/runtime.ts");
  vi.spyOn(runtime.useRuntimeStore(), "showSnakebar").mockImplementation(showSnakebarMock);
  return await import("@/options/views/Overview/DownloadHistory/utils.ts");
}

/** 轮询定时器间隔为 1s；这里推进假计时器并让 await 链跑完 */
async function tick(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
}

describe("V-14：下载状态轮询必须刷新列表", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    sendMessageMock.mockReset();
    buildAdvanceItemPropsFn.mockReset();
    showSnakebarMock.mockClear();
    messageOpenMock.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shallowRef 的就地写不会使 computed 失效（修复前的失效模式）", () => {
    const state = shallowRef<Record<string, { downloadStatus: string }>>({
      id1: { downloadStatus: "downloading" },
    });
    const list = computed(() => Object.values(state.value));
    const before = list.value;

    // 修复前的轮询写法
    state.value["id1"] = { downloadStatus: "completed" };

    expect(list.value).toBe(before); // computed 没有失效
    expect(list.value[0]!.downloadStatus).toBe("downloading"); // 表格仍是旧状态

    // 修复后的写法：整体替换（或 triggerRef）
    state.value = { ...state.value, id1: { downloadStatus: "completed" } };
    expect(list.value[0]!.downloadStatus).toBe("completed");

    state.value["id1"] = { downloadStatus: "failed" };
    triggerRef(state);
    expect(list.value[0]!.downloadStatus).toBe("failed");
  });

  it("轮询到终态后列表反映新状态，并停止继续轮询", async () => {
    sendMessageMock.mockImplementation(async (type: string) => {
      if (type === "getDownloadHistory") {
        return [{ id: "task-1", downloadStatus: "downloading", title: "t" }];
      }
      if (type === "getDownloadHistoryById") {
        return { id: "task-1", downloadStatus: "completed", title: "t" };
      }
      return undefined;
    });

    const { downloadHistoryList, throttleLoadDownloadHistory } = await loadModule();

    throttleLoadDownloadHistory();
    await tick(0);
    expect(downloadHistoryList.value.map((x) => x.downloadStatus)).toEqual(["downloading"]);

    await tick(1000);
    expect(downloadHistoryList.value.map((x) => x.downloadStatus)).toEqual(["completed"]);

    const callsAfterCompleted = sendMessageMock.mock.calls.filter((x) => x[0] === "getDownloadHistoryById").length;
    await tick(5000);
    expect(sendMessageMock.mock.calls.filter((x) => x[0] === "getDownloadHistoryById").length).toBe(
      callsAfterCompleted,
    ); // 终态后不再轮询
  });

  it("A-21：轮询期间记录被删除（返回 undefined）时不得抛错，并清掉该行", async () => {
    let pollCount = 0;
    sendMessageMock.mockImplementation(async (type: string) => {
      if (type === "getDownloadHistory") {
        return [{ id: "task-1", downloadStatus: "downloading", title: "t" }];
      }
      if (type === "getDownloadHistoryById") {
        pollCount++;
        return undefined; // 记录已被删除
      }
      return undefined;
    });

    const { downloadHistoryList, throttleLoadDownloadHistory } = await loadModule();

    throttleLoadDownloadHistory();
    await tick(0);
    expect(downloadHistoryList.value).toHaveLength(1);

    await tick(1000);
    expect(pollCount).toBe(1);
    expect(downloadHistoryList.value).toHaveLength(0); // undefined 不再残留在列表里（修复前是 [undefined]）
    expect(showSnakebarMock).not.toHaveBeenCalled(); // 「记录已被删除」不是错误，不打扰用户

    await tick(5000);
    expect(pollCount).toBe(1); // 轮询链已干净停止
  });

  it("A-21：轮询请求 reject 时提示一次并停止轮询，不产生 unhandled rejection", async () => {
    sendMessageMock.mockImplementation(async (type: string) => {
      if (type === "getDownloadHistory") {
        return [
          { id: "task-1", downloadStatus: "pending", title: "t" },
          { id: "task-2", downloadStatus: "pending", title: "t2" },
        ];
      }
      if (type === "getDownloadHistoryById") {
        throw new Error("offscreen 已回收");
      }
      return undefined;
    });

    const { downloadHistoryList, throttleLoadDownloadHistory } = await loadModule();

    throttleLoadDownloadHistory();
    await tick(0);

    await tick(1000);
    // 只提示一次（多行同时失败时不刷屏），且行仍留在表格里（下载可能仍在进行）
    expect(showSnakebarMock).toHaveBeenCalledTimes(1);
    expect(showSnakebarMock.mock.calls[0]![0]).toContain("刷新下载状态失败");
    expect(showSnakebarMock.mock.calls[0]![1]).toEqual({ color: "error" });
    expect(downloadHistoryList.value.map((x) => x.downloadStatus)).toEqual(["pending", "pending"]);

    const pollCalls = sendMessageMock.mock.calls.filter((x) => x[0] === "getDownloadHistoryById").length;
    await tick(5000);
    expect(sendMessageMock.mock.calls.filter((x) => x[0] === "getDownloadHistoryById").length).toBe(pollCalls); // 已停止轮询
  });
});
