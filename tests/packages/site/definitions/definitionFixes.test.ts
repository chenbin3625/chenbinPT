/**
 * 附录 A 站点定义修复的行为回归（选择器 / 过滤器层面，不发网络请求）。
 */
import { describe, expect, it, vi } from "vitest";

import { installHappyDomDocumentClass } from "../../../helpers/happyDomDocument.ts";

vi.mock("@ptd/site/utils/adapter.ts", () => ({
  logMessage: vi.fn(),
  // transformSearchPage → parseWholeTorrentFromRow → fixLink 会用 axios.getUri 补全相对链接；
  // 这里只提供 getUri（对已是绝对 URL 的入参等价），避免为解析用例拉起整个平台适配层。
  axios: { getUri: (config: { url?: string }) => config.url ?? "" },
}));
(globalThis as any).__BROWSER__ ??= "chrome";

const makeDoc = (html: string) => new DOMParser().parseFromString(`<html><body>${html}</body></html>`, "text/html");

describe("losslessclub seedingSize（D-22）", () => {
  it("累加做种列表所有数据行的体积（原先只取到首行的原始文本）", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/losslessclub.ts");
    const { parseSizeString } = await import("@ptd/site/utils/filesize.ts");
    const step = siteMetadata.userInfo!.process!.find((p: any) => p.selectors?.seedingSize)!;
    const query = step.selectors!.seedingSize as any;

    const doc = makeDoc(
      "<table><tr><th>a</th><th>b</th><th>size</th></tr>" +
        "<tr><td>x</td><td>y</td><td>1 GB</td></tr><tr><td>x</td><td>y</td><td>512 MB</td></tr></table>",
    );
    expect(query.elementProcess(doc)).toBe(parseSizeString("1 GB") + parseSizeString("512 MB"));
  });
});

describe("ncore lastAccessAt（D-20 / H-L3）", () => {
  /**
   * H-L3：原用例只有「比 80 天更早」这一条单边断言 —— 把 `hónapja` 误映射成 `years`
   * （≈1095 天）甚至返回 0 都能通过。这里改成「以固定 now 为基准的窗口断言」，
   * 并覆盖全部六个匈牙利语相对单位与 `épp itt van`（当前在线）分支。
   */
  const DAY = 24 * 3600 * 1000;
  const FIXED_NOW = new Date("2024-06-15T12:00:00Z");

  const loadFilter = async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/ncore.ts");
    const step = siteMetadata.userInfo!.process!.find((p: any) => p.selectors?.lastAccessAt)!;
    return (step.selectors!.lastAccessAt as any).filters[0] as (query: string) => number | string;
  };

  const within = (value: number, minDays: number, maxDays: number) => {
    const ago = FIXED_NOW.getTime() - value;
    expect(ago).toBeGreaterThanOrEqual(minDays * DAY);
    expect(ago).toBeLessThanOrEqual(maxDays * DAY);
  };

  it("「3 hónapja」落在 3 个月窗口（~90 天），既不是 3 年也不是 0", async () => {
    vi.useFakeTimers({ now: FIXED_NOW });
    try {
      const filter = await loadFilter();
      const value = filter("3 hónapja");
      expect(typeof value).toBe("number");
      within(value as number, 89, 91);

      // 区分力：3 年 ≈ 1095 天，绝不在 3 个月窗口内（旧用例的「>80 天」无法区分这两者）
      const threeYears = FIXED_NOW.getTime() - 1095 * DAY;
      expect(value as number).toBeGreaterThan(threeYears);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["1 hónapja", 29, 31],
    ["2 hónapja", 59, 61],
    ["1 éve", 364, 366],
    ["3 éve", 1094, 1096],
    ["2 hete", 13, 15],
    ["5 napja", 4, 6],
    ["3 órája", 3 / 24 - 0.01, 3 / 24 + 0.01],
    ["10 perce", 10 / 1440 - 0.001, 10 / 1440 + 0.001],
  ])("「%s」换算为 %s~%s 天前", async (raw, minDays, maxDays) => {
    vi.useFakeTimers({ now: FIXED_NOW });
    try {
      const filter = await loadFilter();
      const value = filter(raw as string);
      expect(typeof value).toBe("number");
      within(value as number, minDays as number, maxDays as number);
    } finally {
      vi.useRealTimers();
    }
  });

  it("「épp itt van」（当前在线）返回 now，而不是文本/0", async () => {
    vi.useFakeTimers({ now: FIXED_NOW });
    try {
      const filter = await loadFilter();
      expect(filter("épp itt van")).toBe(FIXED_NOW.getTime());
    } finally {
      vi.useRealTimers();
    }
  });

  it("无法识别的匈牙利语文本保持原样返回（不伪造时间戳）", async () => {
    vi.useFakeTimers({ now: FIXED_NOW });
    try {
      const filter = await loadFilter();
      expect(filter("ismeretlen")).toBe("ismeretlen");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("hdbits 详情标题兜底与 replace 正则（D-36 / D-37 / H-L6）", () => {
  /**
   * H-L6：原用例断言的是「定义里存在 `head > title` 这个字符串」，且只覆盖 <title> 分支 ——
   * h1 分支（含去掉 `\u00A0\u00A0\u00A0` 之后的附加信息）完全没有回归。
   * 这里改用真实管线 `parseWholeTorrentFromRow` + `detail.selectors`，只断言最终的 `torrent.title`。
   */
  const loadSite = async () => {
    const mod = await import("@ptd/site/definitions/hdbits.ts");
    const site: any = new mod.default(mod.siteMetadata as any);
    return { site, siteMetadata: mod.siteMetadata };
  };

  /** 详情页整页解析：head 放 `<title>`，body 放 `<h1>`（makeDoc 会把片段塞进 body，<title> 必须自己写进 head） */
  const parseTitle = async ({ head = "", body = "" }: { head?: string; body?: string }) => {
    const { site, siteMetadata } = await loadSite();
    const doc = new DOMParser().parseFromString(`<html><head>${head}</head><body>${body}</body></html>`, "text/html");
    const torrent = await site.parseWholeTorrentFromRow({}, doc, {
      searchEntry: siteMetadata.detail,
      requestConfig: { url: "https://hdbits.org/details.php?id=1" },
    } as any);
    return torrent.title as string;
  };

  it("有 h1 时用 h1 的标题，并去掉三段 NBSP 之后的附加信息", async () => {
    // 真实 h1 形如 `{torrentName}\u00A0\u00A0\u00A0{附加信息}`（NexusPHP/HDBits 都用 U+00A0 分隔）
    const title = await parseTitle({
      head: "<title>Some.Movie.2024.1080p :: HDBits</title>",
      body: "<h1>Some.Movie.2024.1080p\u00A0\u00A0\u00A0Some.Release.Info</h1>",
    });
    expect(title).toBe("Some.Movie.2024.1080p");
  });

  it("h1 缺失时回落到 <title>，并去掉 ' :: HDBits' 后缀", async () => {
    const title = await parseTitle({ head: "<title>Some.Movie.2024.1080p :: HDBits</title>" });
    expect(title).toBe("Some.Movie.2024.1080p");
  });

  it("两个分支对同一部影片给出相同标题（h1 分支写坏时标题会带上附加信息）", async () => {
    const fromH1 = await parseTitle({
      head: "<title>Some.Movie.2024.1080p :: HDBits</title>",
      body: "<h1>Some.Movie.2024.1080p\u00A0\u00A0\u00A0Some.Release.Info</h1>",
    });
    const fromTitle = await parseTitle({ head: "<title>Some.Movie.2024.1080p :: HDBits</title>" });
    expect(fromH1).toBe(fromTitle);
  });

  it("lastAccessAt 的 replace 真的去掉括号里的相对时间", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/hdbits.ts");
    const { definedFilters } = await import("@ptd/site/utils/filter.ts");
    const step = siteMetadata.userInfo!.process!.find((p: any) => p.selectors?.lastAccessAt)!;
    const [replace] = (step.selectors!.lastAccessAt as any).filters;
    expect((definedFilters as any)[replace.name]("2026-01-02 03:04:05 (1 hour ago)", replace.args)).toBe(
      "2026-01-02 03:04:05",
    );
  });
});

describe("anirena 现布局解析（D-2 / H-M1）", () => {
  it("table.tl-table 的行经真实 transformSearchPage 取到标题 / 下载链接 / 体积 / 做种数", async () => {
    // H-M1：原用例因为「happy-dom 下 Document 判据为假」而绕开 transformSearchPage，
    // 只逐个字段调用 getFieldData；Document 判据修好后（见 tests/helpers/happyDomDocument.ts）
    // 这里改回真实入口，rows 选择器也一并受测。
    installHappyDomDocumentClass();

    const { default: BittorrentSite } = await import("@ptd/site/schemas/AbstractBittorrentSite.ts");
    const { siteMetadata } = await import("@ptd/site/definitions/anirena.ts");
    // 按上游 #1605 真机核对过的布局：种子行带 data-torrent-id（页面另有一张搜索语法帮助表与空状态行），
    // 时间是 data-utc 的 UTC 时间，做种/下载数包在 .tl-se / .tl-le 里，完成数可能带括号里的备用数字
    const doc = makeDoc(
      `<table class="help"><tbody><tr><td>q=</td><td>search syntax</td></tr></tbody></table>
      <table class="tl-table"><tbody>
        <tr data-torrent-id="123"><td class="col-cat" title="Anime"></td>
          <td><a class="tl-torrent-name" href="/torrent/123">[Group] Show - 01 [1080p]</a>
              <a title="Download Torrent" href="/download/123.torrent">dl</a></td>
          <td class="col-size">1.2 GiB</td>
          <td class="col-date"><span data-utc="2026-01-02 03:04">2026-01-02 03:04</span></td>
          <td class="col-se"><span class="tl-se">10</span></td><td class="col-le"><span class="tl-le">2</span></td>
          <td class="col-dl">300(5)</td><td class="col-uploader"><a href="/?q=user%3Aalice">alice</a></td></tr>
        <tr><td><div class="tl-empty-state"></div></td></tr>
      </tbody></table>`,
    );

    const site: any = new BittorrentSite(siteMetadata as any);
    const torrents = await site.transformSearchPage(doc, {
      searchEntry: siteMetadata.search,
      requestConfig: { url: "https://anirena.invalid/" },
    });

    // 空状态行必须在 rows 选择器/filter 阶段就被排除
    expect(torrents).toHaveLength(1);
    const [torrent] = torrents as any[];

    expect(torrent.title).toBe("[Group] Show - 01 [1080p]");
    // fixLink 会把相对下载链接按 requestConfig.url 补成绝对地址
    expect(torrent.link).toBe("https://anirena.invalid/download/123.torrent");
    expect(torrent.id).toBe(123);
    expect(torrent.seeders).toBe(10);
    expect(torrent.leechers).toBe(2);
    expect(torrent.completed).toBe(300);
    expect(torrent.category).toBe("Anime");
    expect(torrent.size).toBeGreaterThan(1024 ** 3);
    // data-utc 按 UTC 解析，与运行主机时区无关
    expect(torrent.time).toBe(Date.UTC(2026, 0, 2, 3, 4));
    expect(torrent.author).toBe("alice");
  });
});
