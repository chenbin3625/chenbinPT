/**
 * 第二轮复检（fix2）site-core 修复回归测试：2026-10-24。
 *
 * 覆盖 task-10 的修复：
 * - H-M1：默认登录判据补「查询串登录端点」（Discuz `member.php?mod=logging&action=login`、
 *   phpBB `?mode=login`、vBulletin `?do=login`、`?page=login`），且不重新引入搜索词/用户名的误判；
 * - L-1：详情页 `<title>` 兜底在构造 `ITorrent` 时保持字符串（纯数字标题不再变 number）；
 * - L-5：仅详情页 selector 提供下载链接时，同一 torrent 对象的连续调用复用解析结果（不重复抓详情页）；
 * - P2-B：`userInfo.criticalFields` 作为关键字段硬失败的 metadata 级逃生口（默认语义不变）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  getUri: vi.fn((config: any = {}) => {
    const base = String(config.baseURL ?? "");
    const url = String(config.url ?? "");
    if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
    if (!url) return base;
    return url.startsWith("/") ? `${base.replace(/\/+$/, "")}${url}` : `${base.replace(/\/?$/, "/")}${url}`;
  }),
  sleep: vi.fn(async () => {}),
  logMessage: vi.fn(),
}));

vi.mock("@ptd/site/utils/adapter.ts", () => ({
  axios: { request: mocks.request, getUri: mocks.getUri },
  isCloudflareBlocked: vi.fn(() => false),
  retrieve: vi.fn(async () => null),
  sleep: mocks.sleep,
  store: vi.fn(async () => {}),
  logMessage: mocks.logMessage,
}));

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

const { default: PrivateSite } = await import("@ptd/site/schemas/AbstractPrivateSite.ts");
const { default: BittorrentSite } = await import("@ptd/site/schemas/AbstractBittorrentSite.ts");
const { EResultParseStatus } = await import("@ptd/site/types.ts");

const SITE_URL = "https://site.example/";

function makeDoc(html: string, url: string = "https://site.example/torrents.php"): Document {
  const doc = new DOMParser().parseFromString(`<html><head>${html}</head><body>${html}</body></html>`, "text/html");
  Object.defineProperty(doc, "URL", { value: url, configurable: true });
  return doc;
}

function okResponse(config: any, data: any = "ok", status = 200) {
  return {
    data,
    status,
    statusText: status === 200 ? "OK" : String(status),
    headers: {},
    config,
    request: { responseURL: String(config?.url ?? SITE_URL) },
  };
}

beforeEach(() => {
  mocks.request.mockReset();
  mocks.sleep.mockReset();
  mocks.sleep.mockResolvedValue(undefined);
  mocks.logMessage.mockReset();
});

class LoginCheckSite extends PrivateSite {
  public check(responseURL: string, status = 200, headers: Record<string, string> = {}): boolean {
    return this.loggedCheck({ status, headers, data: "", request: { responseURL } } as any);
  }
}

describe("H-M1：默认登录判据补查询串登录端点", () => {
  const site = new LoginCheckSite({ id: "login", name: "Login", type: "private", urls: [SITE_URL] } as any);

  it("Discuz/phpBB/vBulletin 的查询串登录端点判为未登录", () => {
    expect(site.check("https://site.example/member.php?mod=logging&action=login")).toBe(false);
    expect(site.check("https://site.example/member.php?mod=logging&action=login&referer=forum.php")).toBe(false);
    expect(site.check("https://site.example/ucp.php?mode=login")).toBe(false);
    expect(site.check("https://site.example/index.php?do=login")).toBe(false);
    expect(site.check("https://site.example/index.php?page=login")).toBe(false);
  });

  it("不重新引入「整串裸子串」误判：搜索词/用户名/动作参数仍视为已登录", () => {
    expect(site.check("https://site.example/torrents.php?search=Checkpoint")).toBe(true);
    expect(site.check("https://site.example/torrents.php?search=login")).toBe(true);
    expect(site.check("https://site.example/torrents.php?search=login&action=search")).toBe(true);
    expect(site.check("https://site.example/users/login")).toBe(true);
    expect(site.check("https://site.example/profile/verify")).toBe(true);
    // 登出页不是「未登录」判据
    expect(site.check("https://site.example/member.php?mod=logging&action=logout")).toBe(true);
  });

  it("Refresh 头里的查询串登录端点同样识别", () => {
    expect(site.check(SITE_URL, 200, { refresh: "0; url=member.php?mod=logging&action=login" })).toBe(false);
    expect(site.check(SITE_URL, 200, { refresh: "0; url=/torrents.php?page=2" })).toBe(true);
  });

  it("pathname 登录端点保持原有行为", () => {
    expect(site.check("https://site.example/login.php?returnto=%2Ftorrents.php")).toBe(false);
    expect(site.check("https://site.example/takelogin.php")).toBe(false);
  });
});

class DetailSite extends BittorrentSite {
  public async detail(doc: Document) {
    return this.transformDetailPage(doc);
  }
}

describe("L-1：详情页 title 兜底保持字符串", () => {
  const site = new DetailSite({
    id: "detail",
    name: "Detail",
    type: "public",
    urls: [SITE_URL],
    detail: { selectors: {} },
  } as any);

  it("纯数字 <title> 不再被 getFieldData 转成 number", async () => {
    const doc = makeDoc("<title>1917</title>", "https://site.example/details.php?id=1");
    const torrent = await site.detail(doc);
    expect(typeof torrent.title).toBe("string");
    expect(torrent.title).toBe("1917");
  });

  it("普通标题保持原样；无 title 选择器时仍能兜底", async () => {
    const doc = makeDoc("<title>Some.Movie.2024</title>", "https://site.example/details.php?id=2");
    const torrent = await site.detail(doc);
    expect(torrent.title).toBe("Some.Movie.2024");
  });
});

class DownloadSite extends BittorrentSite {
  public async link(torrent: any) {
    return this.getTorrentDownloadLink(torrent);
  }
  public async config(torrent: any) {
    return this.getTorrentDownloadRequestConfig(torrent);
  }
}

describe("L-5：仅详情页 selector 提供下载链接时不重复抓详情页", () => {
  function newSite() {
    return new DownloadSite({
      id: "dl",
      name: "DL",
      type: "public",
      urls: [SITE_URL],
      detail: { selectors: { link: { selector: "a.download", attr: "href" } } },
    } as any);
  }

  it("同一个 torrent 对象：link / config / 再次 link 只请求一次详情页", async () => {
    const site = newSite();
    const detailDoc = makeDoc(`<a class="download" href="${SITE_URL}download.php?id=1">dl</a>`);
    mocks.request.mockImplementation(async (config: any) => okResponse(config, detailDoc));

    const torrent: any = { site: "x", id: 1, url: `${SITE_URL}details.php?id=1` };
    const first = await site.link(torrent);
    expect(first).toBe(`${SITE_URL}download.php?id=1`);
    expect(mocks.request).toHaveBeenCalledTimes(1);

    expect(await site.link(torrent)).toBe(first);
    const config = await site.config(torrent);
    expect(config.url).toBe(first);
    expect(mocks.request).toHaveBeenCalledTimes(1); // 复用短期缓存，不重复抓详情页
  });

  it("不同 torrent 对象不共享缓存", async () => {
    const site = newSite();
    const detailDoc = makeDoc(`<a class="download" href="${SITE_URL}download.php?id=1">dl</a>`);
    mocks.request.mockImplementation(async (config: any) => okResponse(config, detailDoc));

    await site.link({ site: "x", id: 1, url: `${SITE_URL}details.php?id=1` });
    await site.link({ site: "x", id: 1, url: `${SITE_URL}details.php?id=1` });
    expect(mocks.request).toHaveBeenCalledTimes(2);
  });

  it("torrent.link 已存在时不会请求详情页", async () => {
    const site = newSite();
    const link = await site.link({ site: "x", id: 1, link: `${SITE_URL}download.php?id=9` } as any);
    expect(link).toBe(`${SITE_URL}download.php?id=9`);
    expect(mocks.request).not.toHaveBeenCalled();
  });
});

class UserInfoSite extends PrivateSite {
  public doc: Document = makeDoc("");
  public override async request<T>(config?: any): Promise<any> {
    return okResponse(config, this.doc, 200);
  }
}

describe("P2-B：userInfo.criticalFields metadata 逃生口", () => {
  function newSite(userInfo: Record<string, any>) {
    return new UserInfoSite({
      id: "private",
      name: "Private",
      type: "private",
      urls: [SITE_URL],
      userInfo: {
        process: [
          {
            requestConfig: { url: "/" },
            selectors: { uploaded: { selector: ".up" }, downloaded: { selector: ".down" } },
          },
        ],
        ...userInfo,
      },
    } as any);
  }

  it("默认语义不变：downloaded 部分失配仍报 parseError", async () => {
    const site = newSite({});
    site.doc = makeDoc(`<span class="up">42</span>`);
    const result = await site.getUserInfoResult({});
    expect(result.status).toBe(EResultParseStatus.parseError);
    expect(result.statusMsg).toMatch(/关键字段 downloaded 未命中/);
    expect(result.uploaded).toBeUndefined();
  });

  it("定义覆写 criticalFields 后，可排除该站确实缺失的字段并保留已解析值", async () => {
    const site = newSite({ criticalFields: ["uploaded"] });
    site.doc = makeDoc(`<span class="up">42</span>`);
    const result = await site.getUserInfoResult({});
    expect(result.status).toBe(EResultParseStatus.success);
    expect(result.uploaded).toBe(42);
    expect(result.downloaded).toBeUndefined();
  });

  it("criticalFields 仍会对列表中的字段硬失败", async () => {
    const site = newSite({ criticalFields: ["uploaded"] });
    site.doc = makeDoc(`<span class="down">7</span>`);
    const result = await site.getUserInfoResult({});
    expect(result.status).toBe(EResultParseStatus.parseError);
    expect(result.statusMsg).toMatch(/关键字段 uploaded 未命中/);
  });
});
