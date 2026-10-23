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

describe("N2：并发/重叠加载不能产生重复或孤儿轮询链", () => {
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

  it("加载在途时的重复刷新被重入保护拦下，同一记录每秒只轮询一次", async () => {
    const pendingLoads: Array<(value: any[]) => void> = [];
    sendMessageMock.mockImplementation((type: string) => {
      if (type === "getDownloadHistory") return new Promise((resolve) => pendingLoads.push(resolve as any));
      if (type === "getDownloadHistoryById")
        return Promise.resolve({ id: "task-1", downloadStatus: "pending", title: "t" });
      return Promise.resolve(undefined);
    });

    const { throttleLoadDownloadHistory } = await loadModule();

    throttleLoadDownloadHistory(); // 首屏加载（在途）
    await tick(1100); // 越过 throttle 的 1s 间隔，但第一次仍未返回
    throttleLoadDownloadHistory(); // 用户又点了一次刷新
    await tick(0);

    expect(pendingLoads, "加载在途时不应再发一次全量请求").toHaveLength(1);

    pendingLoads[0]!([{ id: "task-1", downloadStatus: "pending", title: "t" }]);
    await tick(0);
    await tick(1000);

    const pollOnce = sendMessageMock.mock.calls.filter((x) => x[0] === "getDownloadHistoryById").length;
    expect(pollOnce, "同一记录每秒只应轮询一次（不是两条链各一次）").toBe(1);

    await tick(1000);
    expect(sendMessageMock.mock.calls.filter((x) => x[0] === "getDownloadHistoryById").length).toBe(2);

    await clearAllPolls();
  });

  it("clearWatchingMap 之后，在途轮询的迟到响应也不会重新排链", async () => {
    const pendingPolls: Array<(value: any) => void> = [];
    sendMessageMock.mockImplementation((type: string) => {
      if (type === "getDownloadHistory") {
        return Promise.resolve([{ id: "task-1", downloadStatus: "pending", title: "t" }]);
      }
      if (type === "getDownloadHistoryById") return new Promise((resolve) => pendingPolls.push(resolve as any));
      return Promise.resolve(undefined);
    });

    const { throttleLoadDownloadHistory, clearWatchingMap } = await loadModule();

    throttleLoadDownloadHistory();
    await tick(0);
    await tick(1000); // 第一次轮询发出，处于在途
    expect(pendingPolls).toHaveLength(1);

    clearWatchingMap(); // 离开页面 / 重新加载
    pendingPolls[0]!({ id: "task-1", downloadStatus: "pending", title: "t" }); // 迟到的响应
    await tick(0);

    const callsAfterClear = sendMessageMock.mock.calls.filter((x) => x[0] === "getDownloadHistoryById").length;
    await tick(5000);
    expect(
      sendMessageMock.mock.calls.filter((x) => x[0] === "getDownloadHistoryById").length,
      "clearWatchingMap 必须能取消全部轮询链（含在途回调）",
    ).toBe(callsAfterClear);
  });
});

async function clearAllPolls() {
  // 用例结束主动清链，避免假计时器上的残留定时器影响后续用例
  const utils = await import("@/options/views/Overview/DownloadHistory/utils.ts");
  utils.clearWatchingMap();
}

describe("N3/N4：批量操作求交与整表加载失败提示", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    sendMessageMock.mockReset();
    buildAdvanceItemPropsFn.mockReset();
    showSnakebarMock.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("N3：批量删除/重下只保留当前可见的选中项", async () => {
    const { pickVisibleDownloadHistoryIds } = await import("@/options/views/Overview/DownloadHistory/utils.ts");
    const visible = [{ id: "keep-1" }, { id: "keep-2" }] as any;
    expect(pickVisibleDownloadHistoryIds([1, 3, 2], [{ id: 1 }, { id: 2 }] as any)).toEqual([1, 2]);
    expect(pickVisibleDownloadHistoryIds([3], [{ id: 1 }, { id: 2 }] as any)).toEqual([]);
  });

  it("N4：整表加载失败时提示用户、复位 loading 并保留旧数据", async () => {
    let shouldFail = false;
    sendMessageMock.mockImplementation(async (type: string) => {
      if (type === "getDownloadHistory") {
        if (shouldFail) throw new Error("offscreen 已回收");
        return [{ id: "task-1", downloadStatus: "completed", title: "t" }];
      }
      return undefined;
    });

    const { downloadHistoryList, throttleLoadDownloadHistory, isLoadingDownloadHistory } = await loadModule();

    throttleLoadDownloadHistory();
    await tick(0);
    expect(downloadHistoryList.value.map((x) => x.id)).toEqual(["task-1"]);

    shouldFail = true;
    throttleLoadDownloadHistory();
    await tick(1100); // 越过 throttle 间隔
    await tick(0);

    expect(isLoadingDownloadHistory.value, "失败后必须复位 loading").toBe(false);
    expect(
      downloadHistoryList.value.map((x) => x.id),
      "失败不应清空旧数据",
    ).toEqual(["task-1"]);
    expect(showSnakebarMock).toHaveBeenCalledTimes(1);
    expect(showSnakebarMock.mock.calls[0]![0]).toMatch(/加载.*失败/);
    expect(showSnakebarMock.mock.calls[0]![1]).toEqual({ color: "error" });
  });
});

describe("I1/I2：高级筛选的三态循环与日期滑块有限区间", () => {
  it("I1：站点/下载器复选框按 none → required → exclude → none 循环", async () => {
    const { cycleKeywordFilterState, keywordFilterStateOf } =
      await import("@/options/views/Overview/DownloadHistory/advanceFilter.ts");
    const dict: { required?: string[]; exclude?: string[] } = { required: [], exclude: [] };

    expect(keywordFilterStateOf(dict, "mteam")).toBe("none");
    expect(cycleKeywordFilterState(dict, "mteam"), "第一次点击 = 只保留").toBe("required");
    expect(dict).toMatchObject({ required: ["mteam"], exclude: [] });

    expect(cycleKeywordFilterState(dict, "mteam"), "第二次点击 = 排除").toBe("exclude");
    expect(dict, "required 与 exclude 必须互斥").toMatchObject({ required: [], exclude: ["mteam"] });

    expect(cycleKeywordFilterState(dict, "mteam"), "第三次点击 = 不参与筛选").toBe("none");
    expect(dict).toMatchObject({ required: [], exclude: [] });
  });

  it("I1：多个值互不影响，且可从 exclude 直接回到 none", async () => {
    const { cycleKeywordFilterState } = await import("@/options/views/Overview/DownloadHistory/advanceFilter.ts");
    const dict: { required?: string[]; exclude?: string[] } = { required: [], exclude: [] };

    cycleKeywordFilterState(dict, "a");
    cycleKeywordFilterState(dict, "b");
    cycleKeywordFilterState(dict, "b"); // b → exclude
    expect(dict).toMatchObject({ required: ["a"], exclude: ["b"] });

    cycleKeywordFilterState(dict, "b"); // b → none
    expect(dict).toMatchObject({ required: ["a"], exclude: [] });
  });

  it("I2：±Infinity 的空区间收敛成有限的「最近 30 天 ~ 现在」", async () => {
    const { resolveFiniteRangeDays } = await import("@/options/views/Overview/DownloadHistory/advanceFilter.ts");
    const now = new Date("2026-10-23T12:00:00Z").getTime();

    const emptyRange = resolveFiniteRangeDays([-Infinity, Infinity], now);
    expect(Number.isFinite(emptyRange[0])).toBe(true);
    expect(Number.isFinite(emptyRange[1])).toBe(true);
    expect(emptyRange[1]).toBe(now);
    expect(emptyRange[0]).toBe(now - 30 * 24 * 60 * 60 * 1000);

    // 已有数据时保持真实区间
    expect(resolveFiniteRangeDays([1000, 2000], now)).toEqual([1000, 2000]);
    // 单边无限时只替换无限的那一侧
    expect(resolveFiniteRangeDays([1000, Infinity], now)).toEqual([1000, now]);
    // 顺序保护
    expect(resolveFiniteRangeDays([2000, 1000], now)).toEqual([2000, 2000]);
  });
});
