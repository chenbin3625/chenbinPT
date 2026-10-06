/**
 * GazelleBase.getSeedingSize() 的空行健壮性测试。
 *
 * 早期实现里收集做种体积的判定是 `sizeAnother.length >= 0`：
 * 对空数组恒为真，随后 `sizeAnother[0].innerText` 抛
 * `TypeError: Cannot read properties of undefined (reading 'innerText')`。
 * 该异常会冒泡到 getUserInfoResult 的 catch，使整次用户信息刷新失败
 * （而不仅仅是没有 seedingSize），影响 Gazelle / GazelleJSONAPI / Luminance 等站点。
 *
 * 这里用子类覆写 getUserTorrentList 直接注入 Document，验证：
 * 1. 缺少 size 列的行被跳过而不是抛错；
 * 2. 正常行的体积仍然被正确累加。
 */
import { describe, expect, it, vi } from "vitest";

// Gazelle schema 会连带引入平台适配层（messages.ts 用到 __BROWSER__ 与 chrome API）
vi.stubGlobal("__BROWSER__", "chrome");
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

const { GazelleBase } = await import("@ptd/site/schemas/Gazelle.ts");
const { parseSizeString } = await import("@ptd/site/utils/filesize.ts");
const { default: GazelleJSONAPI } = await import("@ptd/site/schemas/GazelleJSONAPI.ts");
const { EResultParseStatus } = await import("@ptd/site/types.ts");

const metadata = {
  id: "gazelle-test",
  name: "Gazelle Test",
  type: "private",
  urls: ["https://example.com/"],
  userInfo: { requestDelay: 0 },
} as any;

function makeDoc(html: string): Document {
  return new DOMParser().parseFromString(`<html><body>${html}</body></html>`, "text/html");
}

class TestGazelle extends GazelleBase {
  public pages: Document[] = [];

  public override async getUserTorrentList(_userId: number, page: number): Promise<Document> {
    return this.pages[page - 1] ?? makeDoc("");
  }

  public async run(userId: number, sizeIndex: number) {
    return await this.getSeedingSize(userId, sizeIndex);
  }
}

describe("GazelleBase.getSeedingSize", () => {
  it("行缺少 size 列（空数组）时跳过，不再抛 TypeError，正常行仍累加", async () => {
    const site = new TestGazelle(metadata, {});
    site.pages = [
      makeDoc(`
        <table>
          <tr class="torrent"><td>a</td><td>1 GB</td></tr>
          <tr class="torrent"><td colspan="2">结构异常，只有一个单元格</td></tr>
          <tr class="torrent"><td>c</td><td>2 GB</td></tr>
        </table>
      `),
    ];

    const result = await site.run(1, 1); // sizeIndex = 1 -> 取第 2 列
    expect(result.seedingSize).toBe(parseSizeString("1 GB") + parseSizeString("2 GB"));
  });

  it("所有行都缺少 size 列时返回 seedingSize: 0（旧实现直接崩溃）", async () => {
    const site = new TestGazelle(metadata, {});
    site.pages = [makeDoc(`<table><tr class="torrent"><td>only</td></tr></table>`)];

    const result = await site.run(1, 3);
    expect(result.seedingSize).toBe(0);
  });

  it("sizeIndex = 0 时按表头自动定位 Size 列并累加", async () => {
    const site = new TestGazelle(metadata, {});
    site.pages = [
      makeDoc(`
        <table>
          <tr class="colhead"><td>Name</td><td><a href="torrents.php?order=size">Size</a></td></tr>
          <tr class="torrent"><td>x</td><td>3 GB</td></tr>
          <tr class="torrent"><td>broken</td></tr>
        </table>
      `),
    ];

    const result = await site.run(1, 0);
    expect(result.seedingSize).toBe(parseSizeString("3 GB"));
  });
});

describe("GazelleJSONAPI 用户信息（H-7 / M-8）", () => {
  const jsonMetadata = {
    id: "gazelle-json-test",
    name: "Gazelle JSON Test",
    type: "private",
    urls: ["https://example.com/"],
    userInfo: {
      requestDelay: 0,
      selectors: {
        id: { selector: "response.id" },
        name: { selector: "response.username" },
        uploaded: { selector: "response.userstats.uploaded" },
        joinTime: { selector: "response.stats.joinedDate" },
      },
    },
  } as any;

  class TestJSON extends GazelleJSONAPI {
    public responses: Record<string, any> = {};
    public seedingSizeError?: Error;
    protected override async requestApi<T>(action: string): Promise<any> {
      return { data: this.responses[action] as T };
    }
    protected override async getSeedingSize(): Promise<any> {
      if (this.seedingSizeError) throw this.seedingSizeError;
      return { seedingSize: 42 };
    }
  }

  it("index 返回 status: failure（账号停用 / 限流）时不写成 success", async () => {
    const site = new TestJSON(jsonMetadata, {});
    site.responses.index = { status: "failure", error: "Your account has been disabled", response: [] };

    const result = await site.getUserInfoResult({ uploaded: 123 });
    expect(result.status).not.toBe(EResultParseStatus.success);
    expect(result.statusMsg).toContain("disabled");
  });

  it("user 接口 failure 同样判失败", async () => {
    const site = new TestJSON(jsonMetadata, {});
    site.responses.index = { status: "success", response: { id: 7, username: "u", userstats: { uploaded: 9 } } };
    site.responses.user = { status: "failure", error: "rate limited", response: [] };

    const result = await site.getUserInfoResult({});
    expect(result.status).not.toBe(EResultParseStatus.success);
    expect(result.statusMsg).toContain("rate limited");
  });

  it("仅做种体积兜底失败时保留已解析字段并标记 success（M-8）", async () => {
    const site = new TestJSON(jsonMetadata, {});
    site.responses.index = { status: "success", response: { id: 7, username: "u", userstats: { uploaded: 9 } } };
    site.responses.user = { status: "success", response: { stats: { joinedDate: "2020-01-01 00:00:00" } } };
    site.seedingSizeError = new Error("torrents page timeout");

    const result = await site.getUserInfoResult({});
    expect(result.status).toBe(EResultParseStatus.success);
    expect(result.name).toBe("u");
    expect(result.uploaded).toBe(9);
  });
});
