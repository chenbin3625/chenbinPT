/**
 * AvistaZ 系用户信息：
 * - M-11：profile 页零命中（改版 / 受限账号）不得报 success + 全 0；
 * - M-28：做种列表翻页在未配置 requestDelay 时也必须有请求间隔、不能 4 并发零间隔连发。
 */
import { describe, expect, it, vi } from "vitest";

vi.stubGlobal("__BROWSER__", "chrome");
// 用户信息抓取默认由构建开关关闭（应站点要求）；这里打开它才能走到被测逻辑
vi.stubEnv("VITE_ENABLE_AVISTAZ_USER_INFO_FETCHING", "true");
vi.stubGlobal("chrome", {
  storage: {
    local: {
      get: () => Promise.resolve({}),
      set: () => Promise.resolve(),
      remove: () => Promise.resolve(),
      onChanged: { addListener: () => {}, removeListener: () => {} },
    },
    onChanged: { addListener: () => {}, removeListener: () => {} },
  },
  runtime: {
    id: "test",
    onMessage: { addListener: () => undefined, removeListener: () => undefined },
    sendMessage: () => Promise.resolve(undefined),
    getURL: (path: string) => `chrome-extension://test/${path}`,
  },
  cookies: { get: () => Promise.resolve(null), set: () => Promise.resolve(), getAll: () => Promise.resolve([]) },
});

const { default: AvistazNetwork } = await import("@ptd/site/schemas/AvistazNetwork.ts");
const { EResultParseStatus } = await import("@ptd/site/types.ts");

const makeDoc = (html: string) => new DOMParser().parseFromString(`<html><body>${html}</body></html>`, "text/html");

// 与真实 avistaz/privatehd 等定义一致：直接用 schema 自带的 userInfo 选择器（`:self` + elementProcess 按表格标签取值）
const { SchemaMetadata } = await import("@ptd/site/schemas/AvistazNetwork.ts");
const metadata = {
  ...SchemaMetadata,
  id: "avz-test",
  name: "AvistaZ Test",
  type: "private",
  urls: ["https://avz.example/"],
} as any;

class TestAvz extends AvistazNetwork {
  public pages: Record<string, Document> = {};
  public requestLog: Array<{ url: string; at: number }> = [];
  public inFlight = 0;
  public maxInFlight = 0;

  public override async request<T>(config: any): Promise<any> {
    const key = config.params?.page ? `${config.url}?page=${config.params.page}` : config.url;
    this.requestLog.push({ url: key, at: Date.now() });
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    this.inFlight--;
    return { data: (this.pages[key] ?? makeDoc("")) as T, status: 200, headers: {}, config };
  }

  public async runSeeding(userName: string) {
    return await this.getUserSeedingTorrents(userName);
  }
}

describe("AvistaZ：profile 页零命中（M-11）", () => {
  it("profile 页结构不认识时判 parseError，而不是 success + 0 上传/下载", async () => {
    const site = new TestAvz(metadata, { inputSetting: { username: "me" } });
    site.pages["/profile/me"] = makeDoc("<div class='maintenance'>We'll be back soon</div>");

    const result = await site.getUserInfoResult({ name: "me" });
    expect(result.status).toBe(EResultParseStatus.parseError);
  });

  it("profile 页命中时照常 success（真实的 0 不受影响）", async () => {
    const site = new TestAvz(metadata, { inputSetting: { username: "me" } });
    site.pages["/profile/me"] = makeDoc(
      "<table><tr><td>Username</td><td>me</td></tr><tr><td>Uploaded</td><td>0 B</td></tr>" +
        "<tr><td>Downloaded</td><td>0 B</td></tr><tr><td>Ratio</td><td>0</td></tr></table>",
    );

    const result = await site.getUserInfoResult({ name: "me" });
    expect(result.status).toBe(EResultParseStatus.success);
    expect(result.uploaded).toBe(0);
  });
});

describe("AvistaZ：做种列表翻页节流（M-28）", () => {
  it("未配置 requestDelay 时翻页请求之间仍有间隔，在途不超过 2", async () => {
    const site = new TestAvz(metadata, { inputSetting: { username: "me" } });
    const pager = Array.from({ length: 6 }, (_, i) => `<a href="?page=${i + 1}">${i + 1}</a>`).join("");
    site.pages["/profile/me/active"] = makeDoc(pager);

    await site.runSeeding("me");

    const pageRequests = site.requestLog.filter((entry) => entry.url.includes("?page="));
    expect(pageRequests).toHaveLength(5);
    expect(site.maxInFlight).toBeLessThanOrEqual(2);
    const gaps = pageRequests.slice(1).map((entry, i) => entry.at - pageRequests[i]!.at);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(400);
  }, 20_000);
});
