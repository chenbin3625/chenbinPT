/**
 * 附录 A 站点定义修复的行为回归（选择器 / 过滤器层面，不发网络请求）。
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@ptd/site/utils/adapter.ts", () => ({ logMessage: vi.fn() }));
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

describe("ncore lastAccessAt（D-20）", () => {
  it("「3 hónapja」（3 个月前）解析为时间戳，而不是原样返回匈牙利文本", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/ncore.ts");
    const step = siteMetadata.userInfo!.process!.find((p: any) => p.selectors?.lastAccessAt)!;
    const filter = (step.selectors!.lastAccessAt as any).filters[0];
    const value = filter("3 hónapja");
    expect(typeof value).toBe("number");
    expect(Date.now() - value).toBeGreaterThan(80 * 24 * 3600 * 1000);
  });
});

describe("hdbits 详情标题兜底与 replace 正则（D-36 / D-37）", () => {
  it("h1 缺失时从 <title> 去掉 ' :: HDBits' 后缀", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/hdbits.ts");
    const titleQuery = siteMetadata.detail!.selectors!.title as any;
    const doc = makeDoc("");
    doc.title = "Some.Movie.2024.1080p :: HDBits";
    const matched = (titleQuery.selector as string[]).find((sel) => doc.querySelector(sel));
    expect(matched).toBe("head > title");
    expect(titleQuery.switchFilters[matched!][0](doc.title)).toBe("Some.Movie.2024.1080p");
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

describe("anirena 现布局解析（D-2）", () => {
  it("table.tl-table 的行能取到标题 / 下载链接 / 体积 / 做种数（旧选择器全部 0 命中）", async () => {
    // 注：本测试环境里 happy-dom 的文档不是全局 Document 的实例（transformSearchPage 会把它当 JSON），
    // 因此这里直接用引擎的选择器与 getFieldData 逐字段求值，覆盖的是定义本身
    const { default: BittorrentSite } = await import("@ptd/site/schemas/AbstractBittorrentSite.ts");
    const { selectElements } = await import("@ptd/site/utils/selector.ts");
    const { siteMetadata } = await import("@ptd/site/definitions/anirena.ts");
    const doc = makeDoc(
      `<table class="tl-table"><tbody>
        <tr><td class="col-cat" title="Anime"></td>
          <td><a class="tl-torrent-name" href="/torrent/123">[Group] Show - 01 [1080p]</a>
              <a title="Download Torrent" href="/download/123.torrent">dl</a></td>
          <td class="col-size">1.2 GiB</td><td class="col-date">2026-01-02 03:04</td>
          <td class="col-se">10</td><td class="col-le">2</td><td class="col-dl">300</td></tr>
        <tr><td><div class="tl-empty-state"></div></td></tr>
      </tbody></table>`,
    );
    const selectors = siteMetadata.search!.selectors as any;
    const rows = selectElements(selectors.rows.selector, doc);
    expect(rows).toHaveLength(1);

    class Probe extends BittorrentSite {
      field(row: Element, key: string) {
        return this.getFieldData(row, selectors[key]);
      }
    }
    const probe = new Probe(siteMetadata as any);
    const [row] = rows as Element[];
    expect(probe.field(row!, "title")).toBe("[Group] Show - 01 [1080p]");
    expect(probe.field(row!, "link")).toBe("/download/123.torrent");
    expect(probe.field(row!, "id")).toBe(123);
    expect(probe.field(row!, "seeders")).toBe(10);
    expect(probe.field(row!, "leechers")).toBe(2);
    expect(probe.field(row!, "completed")).toBe(300);
    expect(probe.field(row!, "category")).toBe("Anime");
    expect(probe.field(row!, "size")).toBeGreaterThan(1024 ** 3);
  });
});
