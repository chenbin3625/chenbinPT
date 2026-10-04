/**
 * 站点搜索配置传递回归测试。
 *
 * 搜索页一次会并发请求多个站点；每个 offscreen handler 再去 storage 读同一个开关，
 * 会在并发搜索时制造一批额外跨上下文往返。前台应把当前配置随请求传过来。
 */
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  onMessage: vi.fn(),
  sendMessage: vi.fn(),
  logger: vi.fn(),
  getSiteInstance: vi.fn(),
}));

vi.mock("@/messages.ts", () => ({ onMessage: mocks.onMessage, sendMessage: mocks.sendMessage }));
vi.mock("@/offscreen/utils/logger.ts", () => ({ logger: mocks.logger }));
vi.mock("@/offscreen/utils/site.ts", () => ({ getSiteInstance: mocks.getSiteInstance }));

type SearchHandler = (args: { data: any }) => Promise<any>;

async function loadSearchHandler(): Promise<SearchHandler> {
  vi.resetModules();
  mocks.onMessage.mockClear();
  mocks.sendMessage.mockReset();
  mocks.logger.mockClear();
  mocks.getSiteInstance.mockReset();

  await import("@/offscreen/utils/search.ts");
  const handler = mocks.onMessage.mock.calls.find(([name]) => name === "getSiteSearchResult")?.[1] as
    SearchHandler | undefined;
  expect(handler, "getSiteSearchResult handler should be registered").toBeTypeOf("function");
  return handler!;
}

describe("offscreen 站点搜索：复用前台传入的搜索配置", () => {
  it("payload 已携带 autoDetectOfficialGroupFromTitle 时，不再额外读取 storage", async () => {
    const handler = await loadSearchHandler();
    mocks.getSiteInstance.mockResolvedValue({
      metadata: {},
      getSearchResult: vi.fn(async () => ({ status: 0, statusMsg: "", data: [] })),
    });

    await handler({
      data: {
        siteId: "site-a",
        keyword: "ubuntu",
        searchEntry: {},
        autoDetectOfficialGroupFromTitle: false,
      },
    });

    expect(mocks.sendMessage).not.toHaveBeenCalledWith(
      "getExtStoragePath",
      expect.objectContaining({ path: "searchEntity.autoDetectOfficialGroupFromTitle" }),
    );
  });
});
