/**
 * site-core 第三轮审查（2026-10-06）的定向回归测试：
 *
 * - SITECORE-1：elementProcess / 匿名 filter 路径的站点墙上时间必须按 timezoneOffset 解析，
 *   不能按运行主机的时区解释（宿主时区 ≠ 站点时区时整体位移）；
 * - SITECORE-2：Unit3D 自定义用户信息路径在 selector 全落空时必须报 parseError，而不是 success + 全 0；
 * - SITECORE-3：NexusPHP 的两个可选用户信息步骤失败时不得 reject 整次刷新、不得丢弃已解析字段；
 * - SITECORE-4：Gazelle 覆写的 transformSearchPage 必须保留「有行但一条都没产出 → 报错」的判据；
 * - SITECORE-5：Rartracker 的 passkey（含空值）要有实例级记忆，且失败不记忆；
 * - SITECORE-6：详情页 title 的兜底选择器在标准 HTML 下要真正命中（<title> 在 <head>）。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// 站点 schema 会连带引入平台适配层（messages.ts 用到 __BROWSER__ 与 chrome API）
(globalThis as any).__BROWSER__ = "chrome";
(globalThis as any).chrome ??= {
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
};

const { SchemaMetadata: NexusPHPSchema } = await import("@ptd/site/schemas/NexusPHP.ts");
const { default: NexusPHP } = await import("@ptd/site/schemas/NexusPHP.ts");
const { SchemaMetadata: GazelleSchema } = await import("@ptd/site/schemas/Gazelle.ts");
const { default: Gazelle } = await import("@ptd/site/schemas/Gazelle.ts");
const { SchemaMetadata: Unit3DSchema } = await import("@ptd/site/schemas/Unit3D.ts");
const { default: Unit3D } = await import("@ptd/site/schemas/Unit3D.ts");
const { default: Rartracker } = await import("@ptd/site/schemas/Rartracker.ts");
const { default: BittorrentSite } = await import("@ptd/site/schemas/AbstractBittorrentSite.ts");
const { EResultParseStatus } = await import("@ptd/site/types.ts");
const { NetworkError } = await import("@ptd/site/utils/error.ts");

function makeDoc(html: string, url: string = "https://site.example/torrents.php"): Document {
  const doc = new DOMParser().parseFromString(`<html><body>${html}</body></html>`, "text/html");
  Object.defineProperty(doc, "URL", { value: url, configurable: true });
  return doc;
}

class RowParseSite extends BittorrentSite {
  public async runRow(row: Element, selectors: Record<string, any>) {
    return await this.parseWholeTorrentFromRow({}, row, {
      searchEntry: { selectors: { rows: { selector: ":self" }, ...selectors } },
      requestConfig: { url: "https://site.example/torrents.php" },
    } as any);
  }
}

function rowSite(offset: string) {
  return new RowParseSite({
    id: `tz-${offset}`,
    name: `TZ ${offset}`,
    type: "public",
    urls: ["https://site.example/"],
    timezoneOffset: offset,
  } as any);
}

class FilterSite extends BittorrentSite {
  public runFilters(query: any, filters: any) {
    return this.runQueryFilters(query, filters);
  }
}

function filterSite(offset: string) {
  return new FilterSite({
    id: `filter-${offset}`,
    name: `Filter ${offset}`,
    type: "public",
    urls: ["https://site.example/"],
    timezoneOffset: offset,
    userInfo: { selectors: {} },
  } as any);
}

describe("SITECORE-1：绝对时间字符串按站点时区解析，而不是宿主时区", () => {
  const nphpTime = (NexusPHPSchema as any).search.selectors.time;
  const gazelleTime = (GazelleSchema as any).search.selectors.time;
  const unit3dTime = (Unit3DSchema as any).search.selectors.time;

  it("NexusPHP 行时间：+0800 与 -0500 两个站点解析同一墙上时间得到不同的绝对时间戳", async () => {
    const row = document.createElement("td");
    row.innerHTML = `<span title="2024-03-01 10:00:00">2024-03-01 10:00:00</span>`;
    const selectors = { time: { ...nphpTime, selector: ":self" } };

    const east = await rowSite("+0800").runRow(row, selectors);
    const west = await rowSite("-0500").runRow(row, selectors);

    expect(east.time).toBe(Date.parse("2024-03-01T10:00:00+08:00"));
    expect(west.time).toBe(Date.parse("2024-03-01T10:00:00-05:00"));
    // 若退回「宿主时区解析」，两个站点会得到同一个（宿主时区）时间戳，这条断言就会失败
    expect(east.time).not.toBe(west.time);
  });

  it("NexusPHP 的相对时间（N 分钟前）仍换算成绝对时间戳", async () => {
    const row = document.createElement("td");
    row.innerHTML = `3分钟前`;

    const result = await rowSite("+0800").runRow(row, { time: { ...nphpTime, selector: ":self" } });
    expect(typeof result.time).toBe("number");
    expect(result.time as number).toBeGreaterThan(Date.now() - 10 * 60 * 1000);
    expect(result.time as number).toBeLessThanOrEqual(Date.now());
  });

  it("Gazelle 行时间（title 属性）按站点时区解析", async () => {
    const row = document.createElement("td");
    row.setAttribute("title", "2024-03-01 10:00:00");

    const result = await rowSite("+0800").runRow(row, { time: { ...gazelleTime, selector: ":self" } });
    expect(result.time).toBe(Date.parse("2024-03-01T10:00:00+08:00"));
  });

  it("Unit3D 列表时间（time[title]）按站点时区解析", async () => {
    const row = document.createElement("tr");
    row.innerHTML = `<td><time title="2024-03-01 10:00:00">1 hour ago</time></td>`;

    const result = await rowSite("+0800").runRow(row, { time: unit3dTime });
    expect(result.time).toBe(Date.parse("2024-03-01T10:00:00+08:00"));
  });

  it("用户信息侧的时间 filter 也走站点时区：NexusPHP joinTime / Unit3D joinTime+lastAccessAt", () => {
    const nphpJoinFilters = (NexusPHPSchema as any).userInfo.selectors.joinTime.filters;
    expect(filterSite("+0800").runFilters("2024-03-01 10:00:00 (2 hours ago)", nphpJoinFilters)).toBe(
      Date.parse("2024-03-01T10:00:00+08:00"),
    );

    const unit3dJoinFilters = (Unit3DSchema as any).userInfo.selectors.joinTime.filters;
    expect(filterSite("+0800").runFilters("Mar 01 2024, 10:00:00", unit3dJoinFilters)).toBe(
      Date.parse("2024-03-01T10:00:00+08:00"),
    );

    const unit3dLastAccessFilters = (Unit3DSchema as any).userInfo.selectors.lastAccessAt.filters;
    expect(filterSite("-0500").runFilters("2024-03-01 10:00:00", unit3dLastAccessFilters)).toBe(
      Date.parse("2024-03-01T10:00:00-05:00"),
    );
  });
});

describe("SITECORE-2：Unit3D 用户信息页零命中不得报 success", () => {
  class TestUnit3D extends Unit3D {
    public doc: Document = makeDoc("");
    public requestCount = 0;

    public override async request<T>(config?: any): Promise<any> {
      this.requestCount++;
      return {
        data: this.doc,
        status: 200,
        headers: {},
        config,
        request: { responseURL: "https://unit3d.example/users/tester" },
      };
    }
  }

  function newSite() {
    return new TestUnit3D({
      id: "unit3d-guard",
      name: "Unit3D Guard",
      type: "private",
      urls: ["https://unit3d.example/"],
      timezoneOffset: "+0000",
      userInfo: (Unit3DSchema as any).userInfo,
    } as any);
  }

  it("全部 selector 零命中（改版页 / 软错误页）→ parseError + statusMsg，而不是 success + 全 0", async () => {
    const site = newSite();
    site.doc = makeDoc(`<div class="maintenance">Site upgrading</div>`);

    const result = await site.getUserInfoResult({ name: "tester", uploaded: 123 });

    expect(result.status).toBe(EResultParseStatus.parseError);
    expect(result.statusMsg).toMatch(/未命中任何字段/);
  });

  it("至少命中一个字段时仍判 success（不能把有效页面误杀）", async () => {
    const site = newSite();
    site.doc = makeDoc(`<a href="/mail"><span class="point">1</span></a>`);

    const result = await site.getUserInfoResult({ name: "tester" });

    expect(result.status).toBe(EResultParseStatus.success);
    expect(result.messageCount).toBe(11);
  });
});

describe("SITECORE-3：NexusPHP 可选用户信息步骤失败不得作废整次刷新", () => {
  class TestNexusPHP extends NexusPHP {
    public doc: Document = makeDoc(
      `<div id="info"><span class="username">tester</span><span class="uploaded">1 TiB</span></div>`,
      "https://pt.example.com/userdetails.php",
    );

    public override async request<T>(config?: any): Promise<any> {
      return {
        data: this.doc,
        status: 200,
        headers: {},
        config,
        request: { responseURL: "https://pt.example.com/userdetails.php" },
      };
    }

    protected override async parseUserInfoForSeedingStatus(): Promise<any> {
      throw new NetworkError("Network Error: /getusertorrentlistajax.php unreachable");
    }

    protected override async parseUserInfoForUploads(): Promise<any> {
      throw new NetworkError("Network Error: /getusertorrentlistajax.php unreachable");
    }
  }

  it("两个可选步骤都抛网络错误时仍 resolve，保留已解析字段且 status 保持 success", async () => {
    const site = new TestNexusPHP({
      id: "nexus-optional",
      name: "Nexus Optional",
      type: "private",
      urls: ["https://pt.example.com/"],
      timezoneOffset: "+0800",
      userInfo: {
        requestDelay: 0,
        process: [{ requestConfig: { url: "/userdetails.php" }, fields: ["name", "uploaded"] }],
        selectors: {
          name: { selector: "#info .username" },
          uploaded: { selector: "#info .uploaded", filters: [{ name: "parseSize" }] },
        },
      },
    } as any);

    const result = await site.getUserInfoResult({});

    // 核心断言：修复前这里会 reject（异常逃出 getUserInfoResult 的契约）
    expect(result.status).toBe(EResultParseStatus.success);
    expect(result.name).toBe("tester");
    expect(result.uploaded).toBeGreaterThan(0);
    expect(result.seeding).toBeUndefined();
    expect(result.uploads).toBeUndefined();
  });
});

describe("SITECORE-4：Gazelle transformSearchPage 保留「全部行失败」判据", () => {
  // happy-dom + vitest 环境下 DOMParser 产物不是全局 Document 的实例，Gazelle.transformSearchPage
  // 会把它当 JSON 上下文（get(doc, "table.torrent_table tr:gt(0)") 取不到行）；把全局 Document
  // 指向 happy-dom 实际使用的构造函数，才能走真正的 DOM 解析分支。
  beforeAll(() => {
    vi.stubGlobal("Document", (document as any).constructor);
  });
  afterAll(() => {
    vi.unstubAllGlobals();
  });

  const metadata = {
    id: "gazelle-search-failures",
    name: "Gazelle Search Failures",
    type: "private",
    urls: ["https://gz.example/"],
    timezoneOffset: "+0000",
    search: { selectors: {} },
    userInfo: {},
  } as any;

  function searchConfig() {
    return {
      keywords: "",
      searchEntry: {
        selectors: { link: { selector: "a[href*='torrents.php?action=download']:first", attr: "href" } },
      },
      requestConfig: { url: "https://gz.example/torrents.php" },
    } as any;
  }

  it("页面有种子行但全部取不到下载链接 → 抛错，而不是 success + data: []", async () => {
    const doc = makeDoc(
      `<table class="torrent_table">
        <tr><td>head</td></tr>
        <tr class="torrent"><td>no link</td></tr>
        <tr class="torrent"><td>still no link</td></tr>
      </table>`,
    );

    await expect(new Gazelle(metadata, {}).transformSearchPage(doc, searchConfig())).rejects.toThrow(
      /rows failed to parse/,
    );
  });

  it("部分行可用时仍返回可用结果（部分失败不整页作废）", async () => {
    const doc = makeDoc(
      `<table class="torrent_table">
        <tr><td>head</td></tr>
        <tr class="torrent"><td><a href="torrents.php?action=download&id=1">DL</a></td></tr>
        <tr class="torrent"><td>no link</td></tr>
      </table>`,
    );

    const torrents = await new Gazelle(metadata, {}).transformSearchPage(doc, searchConfig());
    expect(torrents).toHaveLength(1);
    expect(torrents[0].link).toContain("action=download");
  });
});

describe("SITECORE-5：Rartracker passkey 的实例级记忆", () => {
  class TestRartracker extends Rartracker {
    public requestCount = 0;

    protected override async retrieveRuntimeSettings<T>(): Promise<T | null> {
      return null;
    }

    protected override async storeRuntimeSettings<T>(_key: string, value: T): Promise<T> {
      return value;
    }

    public override async request<T>(config?: any): Promise<any> {
      this.requestCount++;
      return { data: { user: { passkey: "" } }, status: 200, headers: {}, config };
    }

    public async runParseLink(id: string) {
      return await this.parseTorrentRowForLink({ id } as any);
    }
  }

  const metadata = {
    id: "rartracker-memo",
    name: "Rartracker Memo",
    type: "private",
    urls: ["https://rar.example/"],
    userInfo: {},
  } as any;

  it("空 passkey 也只在实例内请求一次 /api/v1/status", async () => {
    const site = new TestRartracker(metadata, {});
    await site.runParseLink("1");
    await site.runParseLink("2");
    const torrent = await site.runParseLink("3");

    expect(site.requestCount).toBe(1);
    expect(torrent.link).toBe("/api/v1/torrents/download/3/");
  });

  it("请求失败不记忆，下一次调用会重试", async () => {
    class FlakyRartracker extends TestRartracker {
      public failures = 1;

      public override async request<T>(config?: any): Promise<any> {
        if (this.failures-- > 0) {
          this.requestCount++;
          throw new NetworkError("Network Error: /api/v1/status timeout");
        }
        return await super.request(config);
      }
    }

    const site = new FlakyRartracker(metadata, {});
    await expect(site.runParseLink("1")).rejects.toThrow(/timeout/);

    const torrent = await site.runParseLink("2");
    expect(torrent.link).toBe("/api/v1/torrents/download/2/");
    expect(site.requestCount).toBe(2);
  });
});

describe("SITECORE-6：详情页 title 的兜底选择器必须真正命中", () => {
  function headTitleDoc(title: string, url: string): Document {
    const doc = new DOMParser().parseFromString(
      `<html><head><title>${title}</title></head><body><p>body</p></body></html>`,
      "text/html",
    );
    Object.defineProperty(doc, "URL", { value: url, configurable: true });
    return doc;
  }

  it("未声明 detail.title 时从 head > title 取标题（原选择器 html > body > title 恒不命中）", async () => {
    const site = new BittorrentSite({
      id: "title-fallback",
      name: "Title Fallback",
      type: "public",
      urls: ["https://site.example/"],
    } as any);

    const torrent = await site.transformDetailPage(
      headTitleDoc("Fallback Title", "https://site.example/details.php?id=1"),
    );
    expect(torrent.title).toBe("Fallback Title");
  });

  it("NexusPHP 的 <title> 兜底分支能命中并过滤出种子名", async () => {
    const site = new NexusPHP({
      ...(NexusPHPSchema as any),
      id: "nexus-title",
      name: "Nexus Title",
      type: "private",
      urls: ["https://pt.example.com/"],
    } as any);

    const torrent = await site.transformDetailPage(
      headTitleDoc(
        'Site :: 种子详情 "Interstellar 2014 2160p" - Powered by NexusPHP',
        "https://pt.example.com/details.php?id=12",
      ),
    );
    expect(torrent.title).toBe("Interstellar 2014 2160p");
  });

  it("Unit3D 的 <title> 兜底分支能命中并过滤出种子名", async () => {
    const site = new Unit3D({
      ...(Unit3DSchema as any),
      id: "unit3d-title",
      name: "Unit3D Title",
      type: "private",
      urls: ["https://unit3d.example/"],
    } as any);

    const torrent = await site.transformDetailPage(
      headTitleDoc("Interstellar 2014 2160p - Torrents - Unit3D", "https://unit3d.example/torrents/12"),
    );
    expect(torrent.title).toBe("Interstellar 2014 2160p");
  });
});
