/**
 * 搜索解析的相对链接补全回归测试（真实站点「all N rows failed to parse」的根因）。
 *
 * 现场：所有 NexusPHP 站点搜索都返回 `解析错误！site 'x': all N rows failed to parse`。
 * 根因链：
 * 1. `getSearchResult` 生成的 requestConfig 是 `{ url: "/torrents.php" }`；
 * 2. E12 之后 `request()` 只修补自己的配置拷贝、不再把 `baseURL` 原地写回调用方对象；
 * 3. `transformSearchPage` → `parseWholeTorrentFromRow` → `fixLink` 对相对下载链接执行
 *    `axios.getUri(requestConfig)` 只得到 "/torrents.php"，随后
 *    `new URL("download.php?id=..", "/torrents.php")` 抛 `TypeError: Invalid URL`；
 * 4. 每行都抛 → 逐行容错循环把它汇总成 `all N rows failed to parse`。
 *
 * 本文件守两点：
 * - `fixLink` 必须能在 requestConfig 没有 baseURL 时仍按站点地址补全（不抛错）；
 * - 生产路径（getSearchResult 把实际请求配置交给解析）也必须转出绝对链接。
 */
import { describe, expect, it, vi } from "vitest";
import { toMerged } from "es-toolkit";

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

const { default: NexusPHP, SchemaMetadata: NexusPHPSchema } = await import("@ptd/site/schemas/NexusPHP.ts");
const { EResultParseStatus } = await import("@ptd/site/types");

const SITE_URL = "https://test.example/";

const LIST_HTML = `<html><body>
<table class="torrents"><tbody>
  <tr>
    <td>类型</td>
    <td>标题</td>
    <td><img class="comments" src="t.gif" alt="评论"></td>
    <td><img class="time" src="t.gif" alt="时间"></td>
    <td><img class="size" src="t.gif" alt="大小"></td>
    <td>下载</td>
    <td><img class="seeders" src="t.gif" alt="种子"></td>
    <td><img class="leechers" src="t.gif" alt="下载中"></td>
    <td><img class="snatched" src="t.gif" alt="完成"></td>
  </tr>
  <tr>
    <td><a href="?cat=401"><img title="Movies" alt="Movies" src="x.gif"></a></td>
    <td><a href="details.php?id=1&amp;hit=1" title="Some.Movie.2024.1080p"><b>Some.Movie.2024.1080p</b></a></td>
    <td><a href="comment.php?action=add&amp;pid=1"><img class="comments" title="0"></a></td>
    <td><span title="2024-03-01 10:00:00">2024-03-01 10:00:00</span></td>
    <td>1.5 GB</td>
    <td><a href="download.php?id=1&amp;passkey=abc"><img alt="download" src="dl.gif"></a></td>
    <td><b>3</b></td>
    <td><b>1</b></td>
    <td>10</td>
  </tr>
</tbody></table>
</body></html>`;

function makeDoc(): Document {
  return new DOMParser().parseFromString(LIST_HTML, "text/html");
}

function makeSite(): InstanceType<typeof NexusPHP> {
  const metadata = toMerged(
    {
      id: "test-site",
      name: "Test Site",
      type: "private",
      schema: "NexusPHP",
      version: 1,
      urls: [SITE_URL],
      timezoneOffset: "+0800",
    } as any,
    NexusPHPSchema as any,
  );
  metadata.search = toMerged(metadata.search, { requestConfig: { url: "/torrents.php", responseType: "document" } });
  return new NexusPHP(metadata, {});
}

/** 与 getSearchResult 生成的配置完全一致：只有相对 url，没有 baseURL */
function productionRequestConfig() {
  return { url: "/torrents.php", params: { search: "x" }, responseType: "document" as const };
}

describe("搜索解析的相对链接补全", () => {
  it("requestConfig 没有 baseURL 时，下载链接按站点地址补全而不是抛 Invalid URL", async () => {
    const site = makeSite();
    const searchEntry = toMerged(site.metadata.search!, {});

    const torrents = await site.transformSearchPage(makeDoc(), {
      keywords: "x",
      searchEntry,
      requestConfig: productionRequestConfig(),
    } as any);

    expect(torrents).toHaveLength(1);
    expect(torrents[0]).toMatchObject({
      site: "test-site",
      id: 1,
      title: "Some.Movie.2024.1080p",
      link: `${SITE_URL}download.php?id=1&passkey=abc`,
      url: `${SITE_URL}details.php?id=1`,
      category: "Movies",
      size: 1610612736,
      seeders: 3,
      leechers: 1,
      completed: 10,
    });
  });

  it("getSearchResult 生产路径（request 不回写 baseURL）解析成功并返回绝对链接", async () => {
    const site = makeSite();
    const requestConfig = productionRequestConfig();
    const doc = makeDoc();

    // 模拟 request()：返回的 response.config 带 baseURL（真实 axios 行为）；原 requestConfig 保持不变
    const requestSpy = vi.spyOn(site as any, "request").mockImplementation(async (config: any) => ({
      data: doc,
      config: { ...config, baseURL: SITE_URL },
      headers: {},
      status: 200,
      statusText: "OK",
    }));

    const result = await site.getSearchResult("x");

    expect(result.status).toBe(EResultParseStatus.success);
    expect(result.data).toHaveLength(1);
    expect(result.data[0].link).toBe(`${SITE_URL}download.php?id=1&passkey=abc`);
    // 确认 request() 的入参没有被 fixLink/解析流程污染（没有原地补 baseURL）
    const passedConfig = requestSpy.mock.calls[0][0] as any;
    expect(passedConfig.baseURL).toBeUndefined();
    expect(passedConfig.url).toBe("/torrents.php");
  });

  it("request 的响应没有 config 时（旧 mock / 覆写实现）仍能按站点地址补全", async () => {
    const site = makeSite();

    vi.spyOn(site as any, "request").mockImplementation(async () => ({
      data: makeDoc(),
      headers: {},
      status: 200,
      statusText: "OK",
    }));

    const result = await site.getSearchResult("x");

    expect(result.status).toBe(EResultParseStatus.success);
    expect(result.data[0].link).toBe(`${SITE_URL}download.php?id=1&passkey=abc`);
  });
});
