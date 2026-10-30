/**
 * B-25 回归测试（CRITICAL）：`loadAllAddedSiteMetadata` 在任一站点元数据加载失败时**也必须 settle**。
 *
 * 修复前的写法：
 *   loadSites.map((siteId) => new Promise<void>(async (resolve) => { … }))
 * `new Promise` 会忽略 executor 的返回值；async executor 内部一旦抛错，返回的 rejected promise
 * 无人观察，而 `resolve()` 永不执行 —— 外层 promise **永不 settle**。
 * `Promise.allSettled` 只能防「reject」，防不了「永不 settle」，于是 MyData 表格、时间线、统计
 * 三个页面永久转圈（`lastUserData.ts` / `UserDataTimeline` / `UserDataStatistic` 的 finally 永不执行）。
 *
 * 站点元数据改由构建期轻量索引提供后（上游 8c6022c98c / #1611），失败来源变成两种：
 *  1. 索引里没有该站点（站点定义已从构建产物移除）；
 *  2. 索引里有，但 favicon 消息 / 站点名读取失败。
 * 两者都必须 settle、互不影响，并且聚合提示用户一次。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

const { sendMessageMock, indexState, metadataStoreStub, showSnackbarMock } = vi.hoisted(() => {
  const metadataStoreStub = {
    sites: {} as Record<string, unknown>,
    getSiteName: vi.fn(async (siteId: string) => siteId),
  };
  return {
    sendMessageMock: vi.fn(),
    indexState: { index: {} as Record<string, any> },
    metadataStoreStub,
    showSnackbarMock: vi.fn(),
  };
});

// 失败提示走 runtime store 的 showSnackbar（antd message），这里只记录调用
vi.mock("ant-design-vue", () => ({ message: { open: vi.fn() } }));
vi.mock("@/messages.ts", () => ({ sendMessage: sendMessageMock, onMessage: vi.fn() }));
vi.mock("@/options/stores/metadata.ts", () => ({ useMetadataStore: () => metadataStoreStub }));
/** 可控的站点轻量索引：key 存在 = 站点定义在当前构建产物里 */
vi.mock("@ptd/site/metadataIndex", () => ({
  get siteMetadataIndex() {
    return indexState.index;
  },
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
  vi.spyOn(runtime.useRuntimeStore(), "showSnackbar").mockImplementation(showSnackbarMock);
  return await import("@/options/views/Overview/MyData/utils/siteMetadata.ts");
}

const indexEntry = (siteId: string) => ({ name: siteId, type: "private", urls: [`https://${siteId}.example/`] });

describe("B-25：站点元数据加载失败时 loadAllAddedSiteMetadata 必须 settle", () => {
  beforeEach(() => {
    sendMessageMock.mockReset();
    metadataStoreStub.getSiteName.mockClear();
    showSnackbarMock.mockClear();
    indexState.index = {};
  });

  it("索引里没有该站点（站点定义已不在构建产物里）时仍然 settle，且不影响其它站点", async () => {
    indexState.index = { "ok-site": indexEntry("ok-site") };
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
    expect(showSnackbarMock).toHaveBeenCalledTimes(1);
    expect(showSnackbarMock.mock.calls[0]![0]).toContain("removed-site");
    expect(showSnackbarMock.mock.calls[0]![1]).toEqual({ color: "error" });
  });

  it("getSiteFavicon reject 时同样必须 settle", async () => {
    indexState.index = { "ok-site": indexEntry("ok-site"), "no-favicon-site": indexEntry("no-favicon-site") };
    sendMessageMock.mockImplementation(async (_type: string, params: { site: string }) => {
      if (params.site === "no-favicon-site") throw new Error("getSiteFavicon 失败");
      return `favicon://${params.site}`;
    });

    const { loadAllAddedSiteMetadata, allAddedSiteMetadata } = await loadModule();

    await Promise.race([loadAllAddedSiteMetadata(["ok-site", "no-favicon-site"]), settleTimeout(TIMEOUT_MS)]);

    expect(Object.keys(allAddedSiteMetadata)).toEqual(["ok-site"]);
    expect(showSnackbarMock).toHaveBeenCalledTimes(1);
    expect(showSnackbarMock.mock.calls[0]![0]).toContain("no-favicon-site");
  });

  it("全部站点都失败时也必须 settle（不是只有部分失败才 settle），且只提示一次", async () => {
    indexState.index = { a: indexEntry("a"), b: indexEntry("b"), c: indexEntry("c") };
    sendMessageMock.mockRejectedValue(new Error("boom"));

    const { loadAllAddedSiteMetadata, allAddedSiteMetadata } = await loadModule();

    await Promise.race([loadAllAddedSiteMetadata(["a", "b", "c"]), settleTimeout(TIMEOUT_MS)]);

    expect(Object.keys(allAddedSiteMetadata)).toEqual([]);
    expect(showSnackbarMock).toHaveBeenCalledTimes(1); // 聚合为一条提示，而不是逐站点刷屏
    expect(showSnackbarMock.mock.calls[0]![0]).toContain("a、b、c");
  });

  it("同一个失效站点重复加载时不会重复提示（避免每次刷新都弹）", async () => {
    sendMessageMock.mockResolvedValue("favicon://x");

    const { loadAllAddedSiteMetadata } = await loadModule();

    await loadAllAddedSiteMetadata(["a"]);
    await loadAllAddedSiteMetadata(["a"]);
    expect(showSnackbarMock).toHaveBeenCalledTimes(1);
  });

  it("已缓存的站点不会重复加载（保持原有的短路语义）", async () => {
    indexState.index = { "ok-site": indexEntry("ok-site") };
    sendMessageMock.mockImplementation(async (_type: string, params: { site: string }) => `favicon://${params.site}`);

    const { loadAllAddedSiteMetadata, allAddedSiteMetadata } = await loadModule();

    await loadAllAddedSiteMetadata(["ok-site"]);
    expect(sendMessageMock).toHaveBeenCalledTimes(1);

    const siteFaviconElement = allAddedSiteMetadata["ok-site"]!.faviconElement;
    await loadAllAddedSiteMetadata(["ok-site"]);
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(allAddedSiteMetadata["ok-site"]!.faviconElement).toBe(siteFaviconElement);
  });

  it("type / aka / hasUserInfo 取自轻量索引（不再解析完整站点定义）", async () => {
    indexState.index = {
      "ok-site": {
        ...indexEntry("ok-site"),
        type: "public",
        aka: ["OK"],
        hasUserInfo: true,
      },
    };
    sendMessageMock.mockResolvedValue("favicon://x");

    const { loadAllAddedSiteMetadata, allAddedSiteMetadata } = await loadModule();
    await loadAllAddedSiteMetadata(["ok-site"]);

    expect(allAddedSiteMetadata["ok-site"]!.type).toBe("public");
    expect(allAddedSiteMetadata["ok-site"]!.hasUserInfo).toBe(true);
    expect(allAddedSiteMetadata["ok-site"]!.combinedSiteName).toBe("ok-site|$|OK");
  });
});
