/**
 * 「刷新数据」失败反馈回归测试。
 *
 * 原实现（修复前）：
 *   sendMessage("getSiteUserInfoResult", site).catch((e) => {
 *     if (!runtimeStore.userInfo.flushPlan[site]) { showSnackbar(...失败) }
 *   })
 * 条件取反 —— 正常失败时 `flushPlan[site]` 仍为 true（置 false 是在 `.finally` 里），
 * 于是**真实失败被静默吞掉**：用户点了「刷新数据」，站点请求失败却没有任何提示，
 * 表现就是「按钮点了没反应」；反而在队列被取消时才误报错误。
 *
 * 修复后：仍在刷新队列中（未被取消）才提示失败。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

const { openMock, sendMessageMock } = vi.hoisted(() => ({
  openMock: vi.fn(),
  sendMessageMock: vi.fn(),
}));

// runtime store 的 showSnackbar 走 antd message
vi.mock("ant-design-vue", () => ({ message: { open: openMock } }));
// 只替换跨上下文消息通道，避免真实 chrome API
vi.mock("@/messages.ts", () => ({ sendMessage: sendMessageMock, onMessage: vi.fn() }));
// 站点元数据要动态 import 真实站点定义文件，这里替换为桩，专注刷新反馈逻辑
vi.mock("@/options/views/Overview/MyData/utils/siteMetadata.ts", () => ({
  loadAllAddedSiteMetadata: vi.fn(async (siteIds: string[]) =>
    Object.fromEntries(siteIds.map((id) => [id, { id, combinedSiteName: id, type: "private" }])),
  ),
  isSiteOffline: () => false,
}));
vi.mock("@/options/views/Overview/MyData/utils/format.ts", () => ({
  fixUserInfo: (v: unknown) => v,
}));

async function loadFlushFn() {
  vi.resetModules();
  setActivePinia(createPinia());
  const runtime = await import("@/options/stores/runtime.ts");
  const mod = await import("@/options/views/Overview/MyData/utils/lastUserData.ts");
  return {
    flushSiteLastUserInfo: mod.flushSiteLastUserInfo,
    reconcileFlushPlan: mod.reconcileFlushPlan,
    perSiteLastUserData: mod.perSiteLastUserData,
    isFlushFailed: mod.isFlushFailed,
    runtimeStore: runtime.useRuntimeStore(),
  };
}

/** 等待 pending 的 promise 链（catch/finally）跑完 */
const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("刷新数据：失败必须给出用户反馈", () => {
  beforeEach(() => {
    openMock.mockReset();
    sendMessageMock.mockReset();
  });

  it("站点用户信息请求被拒绝时，必须弹出失败提示", async () => {
    sendMessageMock.mockRejectedValue(new Error("network down"));
    const { flushSiteLastUserInfo } = await loadFlushFn();

    flushSiteLastUserInfo(["testsite"]);
    await flushMicrotasks();
    await flushMicrotasks();

    expect(openMock).toHaveBeenCalledTimes(1);
    const arg = openMock.mock.calls[0]![0] as { type: string; content: string };
    expect(arg.type).toBe("error");
    expect(arg.content).toContain("testsite");
  });

  it("队列已取消后再失败，不应误报错误", async () => {
    let reject!: (e: unknown) => void;
    sendMessageMock.mockImplementation(() => new Promise((_resolve, rej) => (reject = rej)));
    const { flushSiteLastUserInfo, runtimeStore } = await loadFlushFn();

    flushSiteLastUserInfo(["testsite"]);
    await flushMicrotasks();

    // 模拟用户点击「取消刷新」：flushPlan 被置为 false 之后请求才失败
    runtimeStore.userInfo.flushPlan["testsite"] = false;
    reject(new Error("cancelled"));
    await flushMicrotasks();
    await flushMicrotasks();

    expect(openMock).not.toHaveBeenCalled();
  });

  it("刷新成功后 flushPlan 必须复位，避免按钮永久停留为「取消刷新」", async () => {
    sendMessageMock.mockResolvedValue({ site: "testsite", status: 0, updateAt: Date.now() });
    const { flushSiteLastUserInfo, runtimeStore } = await loadFlushFn();

    flushSiteLastUserInfo(["testsite"]);
    expect(runtimeStore.userInfo.flushPlan["testsite"]).toBe(true);

    await flushMicrotasks();
    await flushMicrotasks();
    expect(runtimeStore.userInfo.flushPlan["testsite"]).toBe(false);
  });

  it("刷新请求必须携带当前并发数，避免 offscreen 首批任务按默认串行启动", async () => {
    sendMessageMock.mockResolvedValue({ site: "testsite", status: 0, updateAt: Date.now() });
    const { flushSiteLastUserInfo } = await loadFlushFn();

    flushSiteLastUserInfo(["testsite"]);

    expect(sendMessageMock).toHaveBeenCalledWith("getSiteUserInfoResult", {
      siteId: "testsite",
      queueConcurrency: 5,
    });
  });
});

describe("刷新失败时保留上一次成功的数据", () => {
  beforeEach(() => {
    openMock.mockReset();
    sendMessageMock.mockReset();
  });

  it("失败只挂 lastFlushFailure，不清空行内已展示的数据", async () => {
    sendMessageMock.mockResolvedValue({ site: "testsite", status: 0, statusMsg: "timeout", updateAt: Date.now() });
    const { flushSiteLastUserInfo, perSiteLastUserData } = await loadFlushFn();

    // 模拟上一次成功刷新后的行
    perSiteLastUserData.value["testsite" as never] = {
      site: "testsite",
      status: 3, // EResultParseStatus.success
      statusMsg: "",
      updateAt: 1_700_000_000_000,
      uploaded: 100,
      downloaded: 20,
      seedingSize: 30,
      siteUserConfig: {},
      siteName: "testsite",
    } as never;

    flushSiteLastUserInfo(["testsite"]);
    await flushMicrotasks();
    await flushMicrotasks();

    const row = perSiteLastUserData.value["testsite" as never]!;
    expect(row.status, "保持 success，汇总与成功数据不受影响").toBe(3);
    expect(row.uploaded).toBe(100);
    expect(row.updateAt).toBe(1_700_000_000_000);
    expect(row.lastFlushFailure?.status).toBe(0);
    expect(row.lastFlushFailure?.statusMsg).toBe("timeout");
  });

  it("下一次成功刷新会清掉失败标记", async () => {
    const { flushSiteLastUserInfo, perSiteLastUserData } = await loadFlushFn();
    perSiteLastUserData.value["testsite" as never] = {
      site: "testsite",
      status: 3,
      updateAt: 1_700_000_000_000,
      uploaded: 100,
      siteUserConfig: {},
      siteName: "testsite",
      lastFlushFailure: { status: 0, statusMsg: "timeout", at: Date.now() },
    } as never;

    sendMessageMock.mockResolvedValue({
      site: "testsite",
      status: 3,
      updateAt: 1_700_000_100_000,
      uploaded: 200,
    });

    flushSiteLastUserInfo(["testsite"]);
    await flushMicrotasks();
    await flushMicrotasks();

    const row = perSiteLastUserData.value["testsite" as never]!;
    expect(row.uploaded).toBe(200);
    expect(row.lastFlushFailure).toBeUndefined();
  });

  it("同一站点已有在途请求时，重复刷新不会重复排队", async () => {
    let resolve!: (value: unknown) => void;
    sendMessageMock.mockImplementation(() => new Promise((res) => (resolve = res)));
    const { flushSiteLastUserInfo } = await loadFlushFn();

    flushSiteLastUserInfo(["testsite"]);
    flushSiteLastUserInfo(["testsite"]);
    await flushMicrotasks();

    expect(sendMessageMock).toHaveBeenCalledTimes(1);

    resolve({ site: "testsite", status: 3, updateAt: Date.now() });
    await flushMicrotasks();
    await flushMicrotasks();
  });

  it("isFlushFailed 同时识别失败状态与保留数据时的失败标记", async () => {
    const { isFlushFailed } = await loadFlushFn();

    expect(isFlushFailed({ status: 3 })).toBe(false);
    expect(isFlushFailed({ status: 3, lastFlushFailure: { status: 0, at: 1 } })).toBe(true);
    expect(isFlushFailed({ status: 7 })).toBe(true); // needLogin
    expect(isFlushFailed({ status: 3 })).toBe(false);
  });
});

describe("F17：恢复出来的「刷新中」残留必须对账", () => {
  beforeEach(() => {
    openMock.mockReset();
    sendMessageMock.mockReset();
  });

  it("没有在途请求的 flushPlan 在页面加载时复位（不再永久显示「取消刷新」）", async () => {
    const { reconcileFlushPlan, runtimeStore } = await loadFlushFn();
    runtimeStore.userInfo.flushPlan["stale-site"] = true;

    expect(reconcileFlushPlan()).toBe(true);
    expect(runtimeStore.userInfo.flushPlan["stale-site"]).toBe(false);
  });

  it("同一页面内确实仍在刷新的站点不会被误复位", async () => {
    let resolve!: (value: unknown) => void;
    sendMessageMock.mockImplementation(() => new Promise((res) => (resolve = res)));
    const { flushSiteLastUserInfo, reconcileFlushPlan, runtimeStore } = await loadFlushFn();

    flushSiteLastUserInfo(["testsite"]);
    await flushMicrotasks();

    expect(reconcileFlushPlan(), "在途请求仍存在，不应被当作恢复残留").toBe(false);
    expect(runtimeStore.userInfo.flushPlan["testsite"]).toBe(true);

    resolve({ site: "testsite", status: 0, updateAt: Date.now() });
    await flushMicrotasks();
    await flushMicrotasks();
    expect(runtimeStore.userInfo.flushPlan["testsite"]).toBe(false);
  });
});
