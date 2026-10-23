/**
 * H-M1：真正执行 `transformSearchPage` / `loggedCheck` 的 **DOM 分支**（审查 2026-10-23）。
 *
 * 背景：本仓库 happy-dom 会让 `new DOMParser().parseFromString(...) instanceof Document` 为 false，
 * 于是 `AbstractBittorrentSite.transformSearchPage` 的 DOM 分支、`NexusPHP` 的表头推断、
 * `AbstractPrivateSite.loggedCheck` 的 `matchSelectors` 判定在测试里全部走 false 分支 ——
 * 341 个定义最核心的「搜索页 → 种子列表」链路此前零覆盖，只能靠直接调 `getFieldData` 绕开。
 *
 * 本文件先用 `tests/helpers/happyDomDocument.ts` 把 `globalThis.Document` 重绑到文档对象
 * 真实原型链上的 Document 类，再对三条 DOM 分支各跑一次端到端：
 *
 * 1. `NexusPHP.transformSearchPage`：无 `thead` 的合成搜索结果页 → 自动生成 rows 选择器，
 *    并按表头图标（img.time / img.size / img.seeders / img.leechers / img.snatched）推断字段列；
 * 2. `Unit3D` 的 rows 列表 + `rows.filter`：表头行/无 `/torrents/<id>` 链接的行必须被过滤掉；
 * 3. `AbstractPrivateSite.loggedCheck` 的 `noLoginAssert.matchSelectors`：登录页表单命中 → 判定未登录。
 *
 * 反证方式：把 `globalThis.Document` 恢复成 happy-dom 注入的那个类（本文件最后一条自证用例），
 * 前两条用例就会因为「取不到行」而失败 —— 说明这些用例确实在守 DOM 分支。
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

import { isDocumentNode } from "@ptd/site/schemas/AbstractBittorrentSite.ts";
import { installHappyDomDocumentClass, makeHtmlDocument } from "../../../helpers/happyDomDocument.ts";

vi.mock("@ptd/site/utils/adapter.ts", () => ({
  logMessage: vi.fn(),
  // transformSearchPage → parseWholeTorrentFromRow → fixLink 会用 axios.getUri 把相对下载链接补成绝对地址。
  // 这里只提供 getUri（与 axios 对「已是绝对 URL」的入参等价），避免为一条解析用例拉起整个平台适配层。
  axios: { getUri: (config: { url?: string }) => config.url ?? "" },
}));
(globalThis as any).__BROWSER__ ??= "chrome";

const HOUR = 3600 * 1000;

beforeAll(() => {
  // 自证：重绑必须成功，否则下面的端到端用例测的仍然是 JSON 分支
  expect(installHappyDomDocumentClass(), "happy-dom 的 Document 重绑失败，DOM 分支用例会退化为空跑").toBe(true);
});

describe("DOM 判据自证（H-M1 根因）", () => {
  it("DOMParser / createHTMLDocument / window.document 三者都满足 instanceof Document", () => {
    const parsed = makeHtmlDocument("<table></table>");
    expect(parsed instanceof Document).toBe(true);
    expect(document instanceof Document).toBe(true);
    expect(document.implementation.createHTMLDocument("x") instanceof Document).toBe(true);
    // 这才是源码里 DOM / JSON 分派的依据（AbstractBittorrentSite.ts / NexusPHP.ts / AbstractPrivateSite.ts）
    expect(parsed.nodeType).toBe(9);
  });

  it("跨 realm 文档对象（nodeType === 9 但非当前 realm 的 Document）被 isDocumentNode 正确识别", () => {
    const fakeCrossRealmDoc = { nodeType: 9, querySelector: vi.fn(), querySelectorAll: vi.fn() };
    expect(isDocumentNode(fakeCrossRealmDoc)).toBe(true);
    expect(fakeCrossRealmDoc instanceof Document).toBe(false);
  });
});

describe("NexusPHP 搜索结果页：无 thead 时自动生成 rows + 按表头推断字段列", () => {
  /** 无 thead 的 NexusPHP 布局：`table.torrents:last > tbody > tr`，第 1 行是表头 */
  const searchPage = () =>
    makeHtmlDocument(`
      <table class="torrents">
        <tbody>
          <tr>
            <td class="rowhead">类型</td>
            <td class="rowhead">标题</td>
            <td class="rowhead"><img class="time" src="pic/trans.gif" alt="Time" title="发布时间"></td>
            <td class="rowhead"><img class="size" src="pic/trans.gif" alt="Size" title="大小"></td>
            <td class="rowhead"><img class="seeders" src="pic/trans.gif" alt="Seeders" title="种子数"></td>
            <td class="rowhead"><img class="leechers" src="pic/trans.gif" alt="Leechers" title="下载数"></td>
            <td class="rowhead"><img class="snatched" src="pic/trans.gif" alt="Snatched" title="完成数"></td>
          </tr>
          <tr>
            <td class="rowfollow"><a href="index.php?cat=401">电影/Movies</a></td>
            <td class="rowfollow"><table class="torrentname"><tbody><tr><td class="embedded">
              <a href="details.php?id=123&amp;hit=1" title="Some.Movie.2024.1080p">Some.Movie.2024.1080p</a>
            </td></tr></tbody></table></td>
            <td class="rowfollow">2024-01-02 03:04:05</td>
            <td class="rowfollow">1.5 GB</td>
            <td class="rowfollow"><b>10</b></td>
            <td class="rowfollow"><b>2</b></td>
            <td class="rowfollow">300</td>
          </tr>
          <tr>
            <td class="rowfollow"><a href="index.php?cat=402">连续剧/TV Series</a></td>
            <td class="rowfollow"><table class="torrentname"><tbody><tr><td class="embedded">
              <a href="details.php?id=124&amp;hit=1" title="Another.Show.S01.1080p">Another.Show.S01.1080p</a>
            </td></tr></tbody></table></td>
            <td class="rowfollow">2024-01-03 04:05:06</td>
            <td class="rowfollow">2 GB</td>
            <td class="rowfollow"><b>7</b></td>
            <td class="rowfollow"><b>1</b></td>
            <td class="rowfollow">42</td>
          </tr>
        </tbody>
      </table>
      <a href="download.php?id=123&amp;passkey=probe"><img alt="download" src="pic/trans.gif"></a>
    `);

  const parse = async (doc: Document) => {
    const { default: NexusPHP, SchemaMetadata } = await import("@ptd/site/schemas/NexusPHP.ts");
    const site: any = new NexusPHP({ ...(SchemaMetadata as any), id: "probe", urls: ["https://probe.invalid/"] });
    return (await site.transformSearchPage(doc, {
      searchEntry: (SchemaMetadata as any).search,
      requestConfig: { url: "https://probe.invalid/torrents.php" },
    })) as any[];
  };

  it("生成 `:gt(0)` 的 rows 选择器（跳过表头行），两行数据都能解析出来", async () => {
    const torrents = await parse(searchPage());

    // 旧行为（Document 判据恒 false）下这里是 0 条：findElementsBySelectors 会把 Document 当 JSON 对象取属性
    expect(torrents).toHaveLength(2);
    expect(torrents.map((torrent) => torrent.title)).toEqual(["Some.Movie.2024.1080p", "Another.Show.S01.1080p"]);
  });

  it("表头推断把 size / seeders / leechers / completed / time 指到正确的列", async () => {
    const [first, second] = await parse(searchPage());

    // 这 5 个字段在 NexusPHP.SchemaMetadata.search.selectors 里没有 selector（只有 elementProcess/text），
    // 能取到值只可能来自 transformSearchPage 的表头推断；列号错位会立刻体现为下面的数值不同。
    expect(first.seeders).toBe(10);
    expect(first.leechers).toBe(2);
    expect(first.completed).toBe(300);
    expect(first.size).toBe(1.5 * 1024 ** 3);
    // 站点时区取 metadata.timezoneOffset（NexusPHP 默认 +0800）
    expect(first.time).toBe(Date.parse("2024-01-02T03:04:05+08:00"));

    expect(second.seeders).toBe(7);
    expect(second.leechers).toBe(1);
    expect(second.completed).toBe(42);
    expect(second.size).toBe(2 * 1024 ** 3);
    expect(second.time).toBe(Date.parse("2024-01-03T04:05:06+08:00"));

    // 分类走定义里已有的 `a:first`（不参与表头推断），确认两条路径不打架
    expect(first.category).toBe("电影/Movies");
    expect(second.category).toBe("连续剧/TV Series");
  });

  it("有 thead 时表头在 thead、rows 不加 :gt(0)，tbody 的每一行都是种子", async () => {
    const doc = makeHtmlDocument(`
      <table class="torrents">
        <thead>
          <tr>
            <th>类型</th>
            <th><img class="seeders" src="pic/trans.gif" alt="Seeders"></th>
            <th><img class="leechers" src="pic/trans.gif" alt="Leechers"></th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td class="rowfollow"><a href="index.php?cat=401">电影</a></td>
            <td class="rowfollow"><b>5</b></td>
            <td class="rowfollow"><b>6</b></td>
          </tr>
          <tr>
            <td class="rowfollow"><a href="index.php?cat=402">剧集</a></td>
            <td class="rowfollow"><b>8</b></td>
            <td class="rowfollow"><b>9</b></td>
          </tr>
        </tbody>
      </table>
    `);

    const torrents = await parse(doc);
    // 若 rows 仍然带上 :gt(0)（或表头被当成数据行），条数就不对
    expect(torrents).toHaveLength(2);
    expect(torrents.map((torrent: any) => [torrent.seeders, torrent.leechers])).toEqual([
      [5, 6],
      [8, 9],
    ]);
  });
});

describe("Unit3D 搜索结果页：rows 选择器 + rows.filter 的 DOM 分支", () => {
  /**
   * Unit3D 的 rows 选择器带 `filter`：只保留「含 /torrents/<id> 链接且不是下载链接」的行。
   * 该 filter 只在 `doc instanceof Document` 分支里执行（AbstractBittorrentSite.ts），
   * 因此这条用例同时守住 rows 选择与 filter 两条 DOM 逻辑。
   */
  const searchPage = () =>
    makeHtmlDocument(`
      <div class="torrent-search--list__results">
        <table>
          <tbody>
            <tr class="table-head">
              <td>Name</td><td>Size</td><td>Seeders</td><td>Leechers</td>
            </tr>
            <tr>
              <td>
                <a class="view-torrent" href="/torrents/123">Some.Movie.2024.1080p</a>
                <a href="/torrents/download/123">download</a>
                <time title="2024-01-02 03:04:05">2 days ago</time>
                <span class="text-blue">1.5 GB</span>
              </td>
              <td><a href="/torrents/123/peers"><span class="text-green">10</span></a></td>
              <td><a href="/torrents/123/peers"><span class="text-red">2</span></a></td>
              <td><a href="/torrents/123/history"><span class="text-orange">300</span></a></td>
            </tr>
            <tr>
              <td>
                <a class="view-torrent" href="/torrents/456">Another.Show.S01.1080p</a>
                <a href="/torrents/download_check/456">download</a>
                <time title="2024-01-03 04:05:06">1 day ago</time>
                <span class="text-blue">2 GB</span>
              </td>
              <td><a href="/torrents/456/peers"><span class="text-green">7</span></a></td>
              <td><a href="/torrents/456/peers"><span class="text-red">1</span></a></td>
              <td><a href="/torrents/456/history"><span class="text-orange">42</span></a></td>
            </tr>
          </tbody>
        </table>
      </div>
    `);

  it("表头行被 filter 过滤掉，两条数据行的字段都按定义取到", async () => {
    const { default: Unit3D, SchemaMetadata } = await import("@ptd/site/schemas/Unit3D.ts");
    const site: any = new Unit3D({ ...(SchemaMetadata as any), id: "probe", urls: ["https://probe.invalid/"] });

    const torrents = (await site.transformSearchPage(searchPage(), {
      searchEntry: (SchemaMetadata as any).search,
      requestConfig: { url: "https://probe.invalid/torrents/" },
    })) as any[];

    // 3 行里只有 2 行有 /torrents/<id> 链接；filter 未执行（或 Document 判据失效）时这里会是 0 或 3
    expect(torrents).toHaveLength(2);
    const [first, second] = torrents;

    expect(first.title).toBe("Some.Movie.2024.1080p");
    // id 经 parseWholeTorrentFromRow 的 tryToNumber 归一化（Unit3D 的定义里是字符串）
    expect(first.id).toBe(123);
    expect(first.link).toBe("https://probe.invalid/torrents/download/123");
    expect(first.size).toBe(1.5 * 1024 ** 3);
    expect(first.seeders).toBe(10);
    expect(first.leechers).toBe(2);
    expect(first.completed).toBe(300);
    // Unit3D 的时间在 <time title> 里，绝对时间串由 parseWholeTorrentFromRow 按 +0000 换算
    expect(first.time).toBe(Date.parse("2024-01-02T03:04:05Z"));

    expect(second.title).toBe("Another.Show.S01.1080p");
    // download_check → download 的归一化同样在行解析管线里
    expect(second.link).toBe("https://probe.invalid/torrents/download/456");
    expect(second.seeders).toBe(7);
  });
});

describe("登录页判定：noLoginAssert.matchSelectors 的 Document 分支", () => {
  const loggedCheckArgs = (doc: Document) => ({
    status: 200,
    headers: {},
    data: doc,
    request: { responseURL: "https://karagarga.net/torrents.php", responseType: "document" },
  });

  it("结果页里出现登录表单选择器时判为未登录；正常结果页判为已登录", async () => {
    const { default: Karagarga, siteMetadata } = await import("@ptd/site/definitions/karagarga.ts");
    const site: any = new Karagarga(siteMetadata as any);

    // matchSelectors: ["form[action='takelogin.php']"]（src/packages/site/definitions/karagarga.ts）
    expect((site.metadata.noLoginAssert?.matchSelectors ?? []).length).toBeGreaterThan(0);

    const loginPage = makeHtmlDocument(
      `<form action="takelogin.php" method="post"><input name="username"><input name="password"></form>`,
    );
    // 旧行为：res.data instanceof Document 为 false → 走 has(doc, "form[action='takelogin.php']") → 恒 false
    // → 登录页被当成正常页（返回 true），用户信息抓取会静默解析出空值
    expect(site.loggedCheck(loggedCheckArgs(loginPage))).toBe(false);

    const resultPage = makeHtmlDocument(
      `<table class="torrents"><tbody><tr><td><a href="details.php?id=1">x</a></td></tr></tbody></table>`,
    );
    expect(site.loggedCheck(loggedCheckArgs(resultPage))).toBe(true);
  });

  it("重定向 URL 命中 urlPatterns 时同样判为未登录（与 matchSelectors 互不遮挡）", async () => {
    const { default: Karagarga, siteMetadata } = await import("@ptd/site/definitions/karagarga.ts");
    const site: any = new Karagarga(siteMetadata as any);

    const res = loggedCheckArgs(makeHtmlDocument(""));
    res.request.responseURL = "https://karagarga.net/login.php?returnto=%2Ftorrents.php";
    expect(site.loggedCheck(res)).toBe(false);
  });
});
