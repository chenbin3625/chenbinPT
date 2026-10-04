/**
 * 「刷新数据」失败反馈回归测试。
 *
 * 原实现（修复前）：
 *   sendMessage("getSiteUserInfoResult", site).catch((e) => {
 *     if (!runtimeStore.userInfo.flushPlan[site]) { showSnakebar(...失败) }
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

// runtime store 的 showSnakebar 走 antd message
vi.mock("ant-design-vue", () => ({ message: { open: openMock } }));
// 只替换跨上下文消息通道，避免真实 chrome API
vi.mock("@/messages.ts", () => ({ sendMessage: sendMessageMock, onMessage: vi.fn() }));
// 站点元数据要动态 import 真实站点定义文件，这里替换为桩，专注刷新反馈逻辑
vi.mock("@/options/views/Overview/MyData/utils/siteMetadata.ts", () => ({
  loadAllAddedSiteMetadata: vi.fn(async (siteIds: string[]) =>
    Object.fromEntries(siteIds.map((id) => [id, { id, combinedSiteName: id, type: "private" }])),
  ),
}));
vi.mock("@/options/views/Overview/MyData/utils/format.ts", () => ({
  fixUserInfo: (v: unknown) => v,
}));

async function loadFlushFn() {
  vi.resetModules();
  setActivePinia(createPinia());
  const runtime = await import("@/options/stores/runtime.ts");
  const mod = await import("@/options/views/Overview/MyData/utils/lastUserData.ts");
  return { flushSiteLastUserInfo: mod.flushSiteLastUserInfo, runtimeStore: runtime.useRuntimeStore() };
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
