/**
 * Schema 引擎解析回归测试（代码审查 2026-10-04 的 §4/§5.4）。
 *
 * 覆盖 4 条纯函数级、可定点复现的缺陷：
 * - B-2：NexusPHP 详情页标题的分隔符是 U+00A0（不是 ASCII 空格）——该结论经两次更正后定稿，
 *   见本文件 B-2 组内的说明；
 * - B-3：Avistaz 列表页 torrent id 只取一位数字（/torrent/12345 → "1"）；
 * - E-1：AbstractBittorrentSite 的 `data.*` 关键词回退插值了字面量 "data"，生成 input[name="data"]；
 * - E-5：Luminance 时魔按 "<br/>" split 永不生效，且丢掉扣款行的负号。
 * 另附 E-3（Gazelle JSON API 把 status: failure 当成功）与 E-10（Gazelle 标题单元格缺失）两条守卫。
 */
import { describe, expect, it, vi } from "vitest";

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
const { SchemaMetadata: LuminanceSchema } = await import("@ptd/site/schemas/Luminance.ts");
const { SchemaMetadata: GazelleSchema, GazelleBase } = await import("@ptd/site/schemas/Gazelle.ts");
const { listTorrentPageMetadata, listHistoryPageMetadata } = await import("@ptd/site/schemas/AvistazNetwork.ts");
const { default: BittorrentSite } = await import("@ptd/site/schemas/AbstractBittorrentSite.ts");
const { default: GazelleJSONAPI } = await import("@ptd/site/schemas/GazelleJSONAPI.ts");
const { siteMetadata: learnflakes } = await import("@ptd/site/definitions/learnflakes.ts");
const { siteMetadata: losslessclub } = await import("@ptd/site/definitions/losslessclub.ts");
const { siteMetadata: teamhd } = await import("@ptd/site/definitions/teamhd.ts");
const { siteMetadata: wihd } = await import("@ptd/site/definitions/wihd.ts");

function makeDoc(html: string, url: string = "https://example.com/torrents.php"): Document {
  const doc = new DOMParser().parseFromString(`<html><body>${html}</body></html>`, "text/html");
  // DOMParser 产出的 document.URL 为空，transformListPage 依赖它（回退到 location.href）
  Object.defineProperty(doc, "URL", { value: url, configurable: true });
  return doc;
}

describe("B-2：NexusPHP 详情页标题按 U+00A0 分隔符切分（结论经两次更正后的最终版）", () => {
  const titleFilters = (NexusPHPSchema as any).detail.selectors.title.switchFilters["h1#top"] as ((
    title: string,
  ) => string)[];

  // 事实基线（**按内容**定位该行并 hexdump 到 `c2 a0 2b` 确认；勿再按行号猜——曾因此误 dump 到注释行）：
  // NexusPHP 核心 details.php 用 `"&nbsp;&nbsp;&nbsp;"` 作分隔符，即 U+00A0；
  // 而原实现 `/^(.+?)\u00A0+.+$/` 的 `+` 是**量词**（一个或多个 U+00A0），本来就正确。
  // 它一度被"更正"为 `\s{3}`，那反而引入回归。本组测试守的是「U+00A0 分隔符语义」。

  it("ASCII 空格不构成分隔符（标题里的普通空格必须保留）", () => {
    expect(titleFilters[0]("A B C")).toBe("A B C");
    expect(titleFilters[0]("Interstellar 2014 2160p")).toBe("Interstellar 2014 2160p");
    expect(titleFilters[0]("1917 2019 1080p BluRay")).toBe("1917 2019 1080p BluRay");
  });

  it("单个 U+00A0 就切分（反回归：曾被改成 \\s{3} 后此处失效）", () => {
    expect(titleFilters[0]("Some.Torrent.Name\u00A0[Free]")).toBe("Some.Torrent.Name");
  });

  it("NexusPHP 核心的三连 U+00A0 正常切分", () => {
    expect(titleFilters[0]("Some.Torrent.Name\u00A0\u00A0\u00A0[Free]")).toBe("Some.Torrent.Name");
  });

  it("三个连续 ASCII 空格**不**触发切分（反回归：曾被改成 \\s{3} 后此处被误截断）", () => {
    expect(titleFilters[0]("Some   Release 1080p")).toBe("Some   Release 1080p");
    expect(titleFilters[0]("Some.Torrent.Name   [Free]")).toBe("Some.Torrent.Name   [Free]");
  });

  it("没有分隔符时原样返回", () => {
    expect(titleFilters[0]("Just A Plain Title")).toBe("Just A Plain Title");
  });

  // 同一组 title 过滤器里的 <title> 兜底分支：正则只有 1 个捕获组，
  // 早先判定写成 `length >= 3` + `[2]`，永远走空并返回带 "- Powered by NexusPHP" 的原始串。
  const documentTitleFilters = (NexusPHPSchema as any).detail.selectors.title.switchFilters["html > body > title"] as ((
    title: string,
  ) => string)[];

  it("从 <title> 兜底时正确取出引号里的种子名", () => {
    expect(documentTitleFilters[0]('Site :: 种子详情 "Interstellar 2014 2160p" - Powered by NexusPHP')).toBe(
      "Interstellar 2014 2160p",
    );
  });

  it("<title> 不含约定的引号结构时原样返回", () => {
    expect(documentTitleFilters[0]("Just A Plain Title")).toBe("Just A Plain Title");
  });
});

describe("B-3：Avistaz 列表页 torrent id 取完整数字", () => {
  const listIdFilter = listTorrentPageMetadata.selectors!.id!.filters![0] as (href: string) => string | undefined;
  const historyIdFilter = listHistoryPageMetadata.selectors!.id!.filters![0] as (href: string) => string | undefined;

  it("多位数 id 完整返回（修复前只返回首位数字）", () => {
    expect(listIdFilter("/torrent/12345/some-name")).toBe("12345");
    expect(listIdFilter("https://avistaz.to/torrent/987654/another")).toBe("987654");
    expect(historyIdFilter("/torrent/12345/some-name")).toBe("12345");
  });

  it("匹配不到时返回 undefined（两处风格一致）", () => {
    expect(listIdFilter("/download/12345")).toBeUndefined();
    expect(historyIdFilter("")).toBeUndefined();
  });
});

describe("E-1：data.* 关键词回退使用 keywordParams 而不是字面量 data", () => {
  class TestSite extends BittorrentSite {
    public async runTransformListPage(doc: Document) {
      return await this.transformListPage(doc);
    }

    public override async transformSearchPage(): Promise<any[]> {
      return [];
    }
  }

  function newSite(keywordPath: string) {
    return new TestSite({
      id: "e1-test",
      name: "E1 Test",
      type: "public",
      urls: ["https://example.com/"],
      search: { keywordPath },
    } as any);
  }

  it("keywordPath = data.keyword 时从 POST 表单的 input[name=keyword] 取到关键词", async () => {
    const doc = makeDoc(`
      <form method="post" action="torrents.php">
        <input type="text" name="keyword" value="dune part two">
      </form>
    `);

    const result = await newSite("data.keyword").runTransformListPage(doc);
    expect(result.keywords).toBe("dune part two");
  });

  it("keywordPath = data.searchstr 时同样按参数名匹配", async () => {
    // 注意：happy-dom 尚未支持 CSS4 的 `[attr="v" i]` 大小写不敏感标志，
    // 因此这里用站点真实的小写 method="post"（浏览器里 i 标志会额外兼容 method="POST"）。
    const doc = makeDoc(`
      <form method="post" action="torrents.php">
        <input type="text" name="searchstr" value="blade runner">
      </form>
    `);

    const result = await newSite("data.searchstr").runTransformListPage(doc);
    expect(result.keywords).toBe("blade runner");
  });

  it("params.* 分支行为不变，仍按 input[name=参数名] 取值", async () => {
    const doc = makeDoc(`<input type="text" name="keywords" value="arrival">`);
    const result = await newSite("params.keywords").runTransformListPage(doc);
    expect(result.keywords).toBe("arrival");
  });
});

describe("offscreen 下载链接：最终 URL 必须属于当前站点", () => {
  it("拒绝跨站绝对链接，允许当前站点及其子域", async () => {
    const site = new BittorrentSite({
      id: "host-check",
      name: "Host Check",
      type: "public",
      urls: ["https://pt.example.com/"],
      legacyUrls: ["https://legacy.example.com/"],
    } as any);

    expect(site.isTrustedDownloadLink("https://pt.example.com/download?id=1")).toBe(true);
    expect(site.isTrustedDownloadLink("https://cdn.pt.example.com/download?id=1")).toBe(true);
    expect(site.isTrustedDownloadLink("https://legacy.example.com/download?id=1")).toBe(true);
    expect(site.isTrustedDownloadLink("https://evil.example/download?id=1")).toBe(false);
    expect(site.isTrustedDownloadLink("https://pt.example.com.evil.test/download?id=1")).toBe(false);
    expect(site.isTrustedDownloadLink("javascript:alert(1)")).toBe(false);
  });

  it("下载链接缺失时，跨站详情 URL 在发请求之前被拒绝", async () => {
    const site = new BittorrentSite({
      id: "host-check",
      name: "Host Check",
      type: "public",
      urls: ["https://pt.example.com/"],
      detail: { selectors: { link: { selector: "a.download", attr: "href" } } },
    } as any);
    const request = vi.spyOn(site, "request");

    await expect(
      site.getTorrentDownloadLink({ site: "host-check", url: "https://evil.example/details?id=1" } as any),
    ).rejects.toThrow(/host/i);
    expect(request).not.toHaveBeenCalled();
  });
});

describe("站点时间过滤器", () => {
  class TimeSite extends BittorrentSite {
    parseTime(value: string, format?: string) {
      return this.runQueryFilters<number>(value, [{ name: "parseTime", args: format ? [format] : [] }]);
    }

    parseFuzzyTime(value: string, format: string) {
      return this.runQueryFilters<number>(value, [{ name: "parseFuzzyTime", args: [format] }]);
    }
  }

  it("无时区墙上时间按站点偏移解析，而不是按浏览器本地时区", () => {
    const site = new TimeSite({
      id: "time-site",
      name: "Time Site",
      type: "public",
      urls: ["https://example.com/"],
      timezoneOffset: "-0500",
    } as any);

    expect(site.parseTime("2024-03-01 10:00:00")).toBe(Date.parse("2024-03-01T10:00:00-05:00"));
    expect(site.parseFuzzyTime("01/03/2024 10:00", "dd/MM/yyyy HH:mm")).toBe(Date.parse("2024-03-01T10:00:00-05:00"));
    expect(site.parseTime("2024-03-01T10:00:00Z")).toBe(Date.parse("2024-03-01T10:00:00Z"));
    expect(site.parseTime("2024-03-01")).toBe(Date.parse("2024-03-01T00:00:00-05:00"));
    expect(site.parseTime("2024-03-10 02:30:00")).toBe(Date.parse("2024-03-10T02:30:00-05:00"));
  });

  it("四站格式串分别能解析搜索或用户信息日期", () => {
    const cases = [
      [learnflakes, "01-03-2024 10:00", "search"],
      [losslessclub, "03/01/24", "search"],
      [teamhd, "1 March 2024", "userInfo"],
      [wihd, "01/03/2024", "userInfo"],
    ] as const;

    for (const [metadata, input, section] of cases) {
      const selector =
        section === "search"
          ? metadata.search!.selectors!.time!
          : metadata.userInfo!.process!.find((process) => process.selectors?.joinTime)!.selectors!.joinTime!;
      const filter = selector.filters!.find((item) => typeof item !== "function" && item.name?.startsWith("parse"))!;
      const site = new TimeSite(metadata);
      expect(() => site.parseTime(input, (filter as { args: string[] }).args[0]), metadata.id).not.toThrow();
    }
  });
});

it("NexusPHP 从 URLSearchParams 精确读取 id，不被相邻参数值干扰", async () => {
  const site = new NexusPHP({
    id: "nexus-id",
    name: "Nexus",
    type: "private",
    urls: ["https://pt.example.com/"],
  } as any);
  const torrent = { site: "nexus-id", url: "https://pt.example.com/details.php?foo=1&id=12" } as any;

  expect(await site.getTorrentDownloadLink(torrent)).toBe("https://pt.example.com/download.php?id=12");
});

describe("E-5：Luminance 时魔按行解析并保留扣款符号", () => {
  const elementProcess = (LuminanceSchema as any).userInfo.selectors.bonusPerHour.elementProcess as (
    el: HTMLElement,
  ) => number;

  it("只取含 hrs 的那一行（修复前 split('<br/>') 永不生效，会取到任意一条记录）", () => {
    const el = document.createElement("div");
    // 第一行是 credits 变动但没有 hrs，第二行才是时魔结算行
    el.innerHTML = "2024-01-01 00:00:00 | -500.0 credits |<br>2024-01-02 00:00:00 | +240.0 credits | 24 hrs";

    expect(elementProcess(el)).toBeCloseTo(240 / 24);
  });

  it("扣款行必须保留负号（修复前 -240.0 会得到 +10）", () => {
    const el = document.createElement("div");
    el.innerHTML = "2024-01-02 00:00:00 | -240.0 credits | 24 hrs";

    expect(elementProcess(el)).toBeCloseTo(-240 / 24);
  });

  it("没有可用行时返回 0", () => {
    const el = document.createElement("div");
    el.innerHTML = "nothing to see here";
    expect(elementProcess(el)).toBe(0);
  });
});

describe("B-1：逐行解析的容错语义（部分失败跳过 / 全部失败仍报错）", () => {
  class TestSite extends BittorrentSite {
    public override async parseWholeTorrentFromRow(_torrent: any, row: any): Promise<any> {
      if (String(row.text).includes("bad")) {
        throw new RangeError("Invalid time value");
      }
      return { site: "b1-test", title: row.text, link: "https://example.com/download/1" };
    }
  }

  const site = new TestSite({
    id: "b1-test",
    name: "B1 Test",
    type: "public",
    urls: ["https://example.com/"],
  } as any);

  /**
   * 这里传入 JSON 上下文（而非 Document）：happy-dom 的 DOMParser 产物并不是测试环境全局
   * `Document` 的实例，会被 transformSearchPage 当作 JSON 处理。
   * 本用例只验证逐行循环的容错语义，用 JSON 上下文可以精确控制「坏行」。
   */
  function searchConfig() {
    return {
      searchEntry: { selectors: { rows: { selector: "rows" } } },
      requestConfig: { url: "https://example.com/torrents.php" },
    } as any;
  }

  it("部分行解析失败时跳过坏行，其余行照常返回", async () => {
    const doc = { rows: [{ text: "good one" }, { text: "bad row" }, { text: "good two" }] };

    const torrents = await site.transformSearchPage(doc, searchConfig());
    expect(torrents.map((t) => t.title)).toEqual(["good one", "good two"]);
  });

  it("全部行解析失败时抛出错误，避免上层记成「success + 0 结果」", async () => {
    const doc = { rows: [{ text: "bad one" }, { text: "bad two" }] };

    await expect(site.transformSearchPage(doc, searchConfig())).rejects.toThrow("all 2 rows failed to parse");
  });
});

describe("E-8：Gazelle 合成下载链接必须带上 authkey/torrent_pass", () => {
  class TestGazelle extends GazelleBase {
    public pageDoc: Document = makeDoc("");
    public requestCount = 0;
    public lastRequestUrl = "";

    public override async request<T>(config: any): Promise<any> {
      this.requestCount++;
      this.lastRequestUrl = config?.url ?? "";
      return { data: this.pageDoc, status: 200, headers: {}, config: {} } as any;
    }

    public async runDownloadLink(torrent: any) {
      return await this.getTorrentDownloadLinkFactory("torrentid")(torrent);
    }
  }

  function newSite(userConfig: any = {}) {
    return new TestGazelle(
      {
        id: "gazelle-e8-test",
        name: "Gazelle E8 Test",
        type: "private",
        urls: ["https://gz.example/"],
        search: {
          selectors: { link: { selector: "a[href*='action=download']:first", attr: "href" } },
        },
        userInfo: {},
      } as any,
      userConfig,
    );
  }

  it("详情页 URL 走合成时带上抓到的 authkey/torrent_pass，且凭据只在实例内抓一次", async () => {
    const site = newSite();
    site.pageDoc = makeDoc(
      `<a href="https://gz.example/torrents.php?action=download&id=999&authkey=AK&torrent_pass=PK">DL</a>`,
    );

    const url = await site.runDownloadLink({
      site: "gazelle-e8-test",
      id: 123,
      link: "https://gz.example/torrents.php?torrentid=123",
    });
    expect(url).toBe("https://gz.example/torrents.php?action=download&id=123&authkey=AK&torrent_pass=PK");

    // 第二次调用命中实例内缓存，不再请求页面
    await site.runDownloadLink({
      site: "gazelle-e8-test",
      id: 124,
      link: "https://gz.example/torrents.php?torrentid=124",
    });
    expect(site.requestCount).toBe(1);
  });

  it("M-9：页面上的真实下载链接是相对地址（上游 browse.php 的实际形态）时同样能取到凭据", async () => {
    const site = newSite();
    site.pageDoc = makeDoc(`<a href="torrents.php?action=download&id=999&authkey=AK&torrent_pass=PK">DL</a>`);

    const url = await site.runDownloadLink({
      site: "gazelle-e8-test",
      id: 123,
      link: "https://gz.example/torrents.php?torrentid=123",
    });
    expect(url).toBe("https://gz.example/torrents.php?action=download&id=123&authkey=AK&torrent_pass=PK");
  });

  it("已经是真实下载链接时原样返回，不再发请求", async () => {
    const site = newSite();
    const realLink = "https://gz.example/torrents.php?action=download&id=7&authkey=AK&torrent_pass=PK";

    expect(await site.runDownloadLink({ site: "gazelle-e8-test", id: 7, link: realLink })).toBe(realLink);
    expect(site.requestCount).toBe(0);
  });

  it("downloadLinkAppendix 在真实链接快路径与合成分支上都生效", async () => {
    const appendix = "&passkey=extra";

    // 快路径：base 已经把后缀追加在 torrent.link 上，这里不应重复追加
    const fastSite = newSite({ downloadLinkAppendix: appendix });
    const realLink = "https://gz.example/torrents.php?action=download&id=7&authkey=AK&torrent_pass=PK";
    expect(await fastSite.runDownloadLink({ site: "gazelle-e8-test", id: 7, link: realLink })).toBe(
      `${realLink}${appendix}`,
    );
    expect(fastSite.requestCount).toBe(0);

    // 合成分支：后缀必须补到新合成的 URL 上（早先会静默丢失），
    // 且抓取凭据用的是去掉后缀的页面 URL
    const synSite = newSite({ downloadLinkAppendix: appendix });
    synSite.pageDoc = makeDoc(
      `<a href="https://gz.example/torrents.php?action=download&id=999&authkey=AK&torrent_pass=PK">DL</a>`,
    );
    expect(
      await synSite.runDownloadLink({
        site: "gazelle-e8-test",
        id: 123,
        link: "https://gz.example/torrents.php?torrentid=123",
      }),
    ).toBe(`https://gz.example/torrents.php?action=download&id=123&authkey=AK&torrent_pass=PK${appendix}`);
    expect(synSite.requestCount).toBe(1);
    expect(synSite.lastRequestUrl).toBe("https://gz.example/torrents.php?torrentid=123");
  });
});

describe("S-2：fixLink 协议白名单", () => {
  class TestSite extends BittorrentSite {
    public runFixLink(uri: string) {
      return this.fixLink(uri, { baseURL: "https://site.example/", url: "/torrents.php" });
    }
  }

  const site = new TestSite({
    id: "s2-test",
    name: "S2 Test",
    type: "public",
    urls: ["https://site.example/"],
  } as any);

  it("危险 scheme 返回空串（而不是把 javascript:/data:/file: 放给下游）", () => {
    expect(site.runFixLink("javascript:alert(1)")).toBe("");
    expect(site.runFixLink("file:///etc/passwd")).toBe("");
    expect(site.runFixLink("data:text/html,<script>1</script>")).toBe("");
    expect(site.runFixLink("vbscript:msgbox(1)")).toBe("");
    expect(site.runFixLink("blob:https://ok.example/abc")).toBe("");
  });

  it("magnet / 相对路径 / // 开头 / http(s) 的既有行为逐字不变", () => {
    expect(site.runFixLink("magnet:?xt=urn:btih:abc")).toBe("magnet:?xt=urn:btih:abc");
    expect(site.runFixLink("./rel")).toBe("https://site.example/rel");
    expect(site.runFixLink("/abs/path")).toBe("https://site.example/abs/path");
    expect(site.runFixLink("//host/path")).toBe("https:://host/path"); // 既有实现即如此（浏览器可容错）
    expect(site.runFixLink("https://ok.example/x")).toBe("https://ok.example/x");
    expect(site.runFixLink("")).toBe("");
  });
});

describe("E-9：缺链接时明确失败，而不是拼出 undefined<后缀>", () => {
  class TestSite extends BittorrentSite {
    public async runGetLink(torrent: any) {
      return await this.getTorrentDownloadLink(torrent);
    }
  }

  const metadata = {
    id: "e9-test",
    name: "E9 Test",
    type: "public",
    urls: ["https://site.example/"],
  } as any;

  it("链接缺失时抛出可诊断的错误", async () => {
    const site = new TestSite(metadata, { downloadLinkAppendix: "&passkey=abc" } as any);
    await expect(
      site.runGetLink({ site: "e9-test", id: 7, url: "https://site.example/details.php?id=7&passkey=secret" }),
    ).rejects.toThrow("cannot parse torrent download link");
  });

  it("有链接时仍按既有语义追加 downloadLinkAppendix", async () => {
    const site = new TestSite(metadata, { downloadLinkAppendix: "&passkey=abc" } as any);
    await expect(site.runGetLink({ site: "e9-test", id: 7, link: "https://site.example/dl?id=7" })).resolves.toBe(
      "https://site.example/dl?id=7&passkey=abc",
    );
  });
});

describe("E-10：Gazelle 标题单元格缺失时按空标题降级", () => {
  const titleElementProcess = (GazelleSchema as any).search.selectors.title.elementProcess as (
    row: HTMLElement,
  ) => string;

  it("行内没有标题单元格（colspan / 结构异常）时返回空串而不是抛 TypeError", () => {
    const row = document.createElement("tr");
    row.innerHTML = `<td class="unrelated">no torrent link here</td>`;
    expect(titleElementProcess(row)).toBe("");
  });
});

describe("E-3：Gazelle JSON API 的失败响应不再被当成搜索成功", () => {
  function newSite() {
    return new GazelleJSONAPI(
      {
        id: "gazelle-json-test",
        name: "Gazelle JSON Test",
        type: "private",
        urls: ["https://example.com/"],
        userInfo: { selectors: {} },
      } as any,
      {},
    );
  }

  it("status: failure 时抛出带 error 的异常（由 getSearchResult 归类为失败）", async () => {
    await expect(
      newSite().transformSearchPage({ status: "failure", error: "Your account is disabled" }, {} as any),
    ).rejects.toThrow("Your account is disabled");
  });

  it("status: success 但缺少 response 时返回空数组而不是 TypeError", async () => {
    await expect(newSite().transformSearchPage({ status: "success" }, {} as any)).resolves.toEqual([]);
  });
});
