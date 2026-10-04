/**
 * B-25 回归测试（CRITICAL）：`loadAllAddedSiteMetadata` 在任一站点元数据加载失败时**也必须 settle**。
 *
 * 修复前的写法：
 *   loadSites.map((siteId) => new Promise<void>(async (resolve) => { … }))
 * `new Promise` 会忽略 executor 的返回值；async executor 内部一旦抛错（站点 id 已不在构建产物里、
 * `getCachedSiteMetadata` / `getSiteFavicon` reject），返回的 rejected promise 无人观察，
 * 而 `resolve()` 永不执行 —— 外层 promise **永不 settle**。
 * `Promise.allSettled` 只能防「reject」，防不了「永不 settle」，于是 MyData 表格、时间线、统计
 * 三个页面永久转圈（`lastUserData.ts` / `UserDataTimeline` / `UserDataStatistic` 的 finally 永不执行）。
 *
 * 这里让 `getCachedSiteMetadata`（以及 `getSiteFavicon`）对被测站点 reject，
 * 断言 loader 在合理时间内 resolve，失败的站点不影响其它站点，且失败会聚合提示用户一次。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

const { sendMessageMock, getCachedSiteMetadataMock, metadataStoreStub, showSnakebarMock } = vi.hoisted(() => {
  const metadataStoreStub = {
    sites: {} as Record<string, unknown>,
    getSiteName: vi.fn(async (siteId: string) => siteId),
  };
  return {
    sendMessageMock: vi.fn(),
    getCachedSiteMetadataMock: vi.fn(),
    metadataStoreStub,
    showSnakebarMock: vi.fn(),
  };
});

// 失败提示走 runtime store 的 showSnakebar（antd message），这里只记录调用
vi.mock("ant-design-vue", () => ({ message: { open: vi.fn() } }));
vi.mock("@/messages.ts", () => ({ sendMessage: sendMessageMock, onMessage: vi.fn() }));
vi.mock("@/options/stores/metadata.ts", () => ({ useMetadataStore: () => metadataStoreStub }));
vi.mock("@/options/views/Overview/MyData/utils/siteMetadataCache.ts", () => ({
  getCachedSiteMetadata: getCachedSiteMetadataMock,
}));

const TIMEOUT_MS = 1000;

/** 修复前这里会超时（永不 settle），从而让测试以「B-25 复发」失败，而不是永远挂住 */
function settleTimeout(ms: number) {
  return new Promise<never>((_resolve, reject) => {
    setTimeout(() => reject(new Error(`loadAllAddedSiteMetadata 在 ${ms}ms 内未 settle（B-25 复发）`)), ms);
  });
}

async function loadModule() {
  vi.resetModules();
  setActivePinia(createPinia());
  const runtime = await import("@/options/stores/runtime.ts");
  vi.spyOn(runtime.useRuntimeStore(), "showSnakebar").mockImplementation(showSnakebarMock);
  return await import("@/options/views/Overview/MyData/utils/siteMetadata.ts");
}

describe("B-25：站点元数据加载失败时 loadAllAddedSiteMetadata 必须 settle", () => {
  beforeEach(() => {
    sendMessageMock.mockReset();
    getCachedSiteMetadataMock.mockReset();
    metadataStoreStub.getSiteName.mockClear();
    showSnakebarMock.mockClear();
  });

  it("getCachedSiteMetadata reject（站点 id 已不在构建产物里）时仍然 settle，且不影响其它站点", async () => {
    getCachedSiteMetadataMock.mockImplementation(async (siteId: string) => {
      if (siteId === "removed-site") throw new TypeError(`站点定义 [${siteId}] 不存在`);
      return { id: siteId, name: siteId, type: "private" };
    });
    sendMessageMock.mockImplementation(async (_type: string, params: { site: string }) => `favicon://${params.site}`);

    const { loadAllAddedSiteMetadata, allAddedSiteMetadata } = await loadModule();

    const result = await Promise.race([
      loadAllAddedSiteMetadata(["ok-site", "removed-site"]),
      settleTimeout(TIMEOUT_MS),
    ]);

    expect(result).toBe(allAddedSiteMetadata);
    // 失败站点被跳过（不写入缓存，下次调用可重试），正常站点照常填充
    expect(Object.keys(allAddedSiteMetadata)).toEqual(["ok-site"]);
    expect(allAddedSiteMetadata["ok-site"]!.siteName).toBe("ok-site");
    // 失败会聚合提示用户一次（该站点会静默从表格里消失）
    expect(showSnakebarMock).toHaveBeenCalledTimes(1);
    expect(showSnakebarMock.mock.calls[0]![0]).toContain("removed-site");
    expect(showSnakebarMock.mock.calls[0]![1]).toEqual({ color: "error" });
  });

  it("getSiteFavicon reject 时同样必须 settle", async () => {
    getCachedSiteMetadataMock.mockImplementation(async (siteId: string) => ({
      id: siteId,
      name: siteId,
      type: "private",
    }));
    sendMessageMock.mockImplementation(async (_type: string, params: { site: string }) => {
      if (params.site === "no-favicon-site") throw new Error("getSiteFavicon 失败");
      return `favicon://${params.site}`;
    });

    const { loadAllAddedSiteMetadata, allAddedSiteMetadata } = await loadModule();

    await Promise.race([loadAllAddedSiteMetadata(["ok-site", "no-favicon-site"]), settleTimeout(TIMEOUT_MS)]);

    expect(Object.keys(allAddedSiteMetadata)).toEqual(["ok-site"]);
    expect(showSnakebarMock).toHaveBeenCalledTimes(1);
    expect(showSnakebarMock.mock.calls[0]![0]).toContain("no-favicon-site");
  });

  it("全部站点都失败时也必须 settle（不是只有部分失败才 settle），且只提示一次", async () => {
    getCachedSiteMetadataMock.mockRejectedValue(new Error("boom"));
    sendMessageMock.mockResolvedValue("favicon://x");

    const { loadAllAddedSiteMetadata, allAddedSiteMetadata } = await loadModule();

    await Promise.race([loadAllAddedSiteMetadata(["a", "b", "c"]), settleTimeout(TIMEOUT_MS)]);

    expect(Object.keys(allAddedSiteMetadata)).toEqual([]);
    expect(showSnakebarMock).toHaveBeenCalledTimes(1); // 聚合为一条提示，而不是逐站点刷屏
    expect(showSnakebarMock.mock.calls[0]![0]).toContain("a、b、c");
  });

  it("同一个失效站点重复加载时不会重复提示（避免每次刷新都弹）", async () => {
    getCachedSiteMetadataMock.mockRejectedValue(new Error("boom"));
    sendMessageMock.mockResolvedValue("favicon://x");

    const { loadAllAddedSiteMetadata } = await loadModule();

    await loadAllAddedSiteMetadata(["a"]);
    await loadAllAddedSiteMetadata(["a"]);
    expect(showSnakebarMock).toHaveBeenCalledTimes(1);
  });

  it("已缓存的站点不会重复加载（保持原有的短路语义）", async () => {
    getCachedSiteMetadataMock.mockImplementation(async (siteId: string) => ({
      id: siteId,
      name: siteId,
      type: "private",
    }));
    sendMessageMock.mockImplementation(async (_type: string, params: { site: string }) => `favicon://${params.site}`);

    const { loadAllAddedSiteMetadata, allAddedSiteMetadata } = await loadModule();

    await loadAllAddedSiteMetadata(["ok-site"]);
    expect(getCachedSiteMetadataMock).toHaveBeenCalledTimes(1);

    const siteFaviconElement = allAddedSiteMetadata["ok-site"]!.faviconElement;
    await loadAllAddedSiteMetadata(["ok-site"]);
    expect(getCachedSiteMetadataMock).toHaveBeenCalledTimes(1);
    expect(allAddedSiteMetadata["ok-site"]!.faviconElement).toBe(siteFaviconElement);
  });
});
