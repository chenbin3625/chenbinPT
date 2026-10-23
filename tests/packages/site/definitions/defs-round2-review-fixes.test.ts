/**
 * 修复轮 2（REVIEW-FINDINGS 站点定义项）回归用例：
 * - P1-3 tokyotosho：列表页 urlPattern 必须仍然覆盖站点根路径（真实列表页），且不误判 /rules/ 等目录页；
 * - huno：request() 不再设置浏览器禁止的 Origin 头；
 * - hdroute：noLoginAssert 收窄后，登录端点仍判未登录、搜索词/普通路径不误判；
 * - animebytes / greatposterwall / secretcinema：详情/下载链接改用 URL join，站点地址无尾斜杠不再拼坏主机；
 * - kunlun 解耦：momentpt / haidan / dubhe 不再从死站 kunlun 导入共享 userInfo 对象；
 * - skyeysnow：0 发布用户（页面可解析但零行）uploads=0，软错误页/无列表页仍保持 undefined；
 * - pussytorrents：统计 POST 前的初始化 GET 遵守 requestDelay，失败时不阻断 POST（可选握手）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ logMessage: vi.fn() }));

vi.mock("@ptd/site/utils/adapter.ts", () => ({
  // 让 fixLink / prepareRequestConfig 的 getUri 行为接近生产（同源拼接）
  axios: {
    request: vi.fn(),
    getUri: (config: any = {}) => {
      const base = String(config.baseURL ?? "https://example.test/");
      const url = String(config.url ?? "/");
      if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
      return url.startsWith("/") ? `${base.replace(/\/+$/, "")}${url}` : `${base.replace(/\/+$/, "")}/${url}`;
    },
  },
  isCloudflareBlocked: vi.fn(() => false),
  retrieve: vi.fn(async () => null),
  retrieveStore: vi.fn(async () => null),
  cookie: vi.fn(async () => null),
  sleep: vi.fn(async () => {}),
  store: vi.fn(async () => {}),
  logMessage: mocks.logMessage,
}));
(globalThis as any).__BROWSER__ ??= "chrome";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import BittorrentSite from "@ptd/site/schemas/AbstractBittorrentSite.ts";
import PrivateSite from "@ptd/site/schemas/AbstractPrivateSite.ts";
import { EResultParseStatus, NoTorrentsError } from "@ptd/site/types.ts";

const makeDoc = (html: string) => new DOMParser().parseFromString(`<html><body>${html}</body></html>`, "text/html");

beforeEach(() => {
  mocks.logMessage.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// P1-3 tokyotosho：根路径必须仍被判为列表页
// ---------------------------------------------------------------------------
describe("P1-3 tokyotosho：列表页 urlPattern 覆盖根路径但不误判目录页", () => {
  const loadMatcher = async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/tokyotosho.ts");
    const patterns = (siteMetadata.list![0].urlPattern as any[]).map((pattern) =>
      typeof pattern === "string" ? new RegExp(pattern, "i") : pattern,
    );
    return (url: string) => patterns.some((pattern: RegExp) => pattern.test(url));
  };

  it("根路径 `/`、`/?query`、/index.php、/search.php 都识别为列表页", async () => {
    const matches = await loadMatcher();
    expect(matches("https://www.tokyotosho.info/")).toBe(true);
    expect(matches("https://www.tokyotosho.info/?cat=1")).toBe(true);
    expect(matches("https://www.tokyotosho.info/index.php")).toBe(true);
    expect(matches("https://www.tokyotosho.info/index.php?cat=1")).toBe(true);
    expect(matches("https://www.tokyotosho.info/search.php?terms=naruto")).toBe(true);
  });

  it("规则/帮助等目录页与详情页不被误判为列表页", async () => {
    const matches = await loadMatcher();
    expect(matches("https://www.tokyotosho.info/rules/")).toBe(false);
    expect(matches("https://www.tokyotosho.info/faq/")).toBe(false);
    expect(matches("https://www.tokyotosho.info/details.php?id=1")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// huno：不再设置无效 Origin 头
// ---------------------------------------------------------------------------
describe("huno：request() 不设置浏览器禁止的 Origin 头", () => {
  it("注入 X-Api-Token 时 headers 里没有 origin", async () => {
    const { default: HUNO } = await import("@ptd/site/definitions/huno.ts");
    const site: any = new (HUNO as any)(
      {
        id: "huno",
        name: "HUNO",
        type: "private",
        urls: ["https://hawke.uno/"],
        timezoneOffset: "+0000",
        userInfo: {},
      },
      { inputSetting: { token: "secret-token" } },
    );

    const requestSpy = vi.spyOn(BittorrentSite.prototype as any, "request").mockResolvedValue({ data: {} } as any);
    await site.request({ url: "/api/profile" }, false);

    const sentConfig = requestSpy.mock.calls[0][0] as any;
    expect(sentConfig.headers["X-Api-Token"]).toBe("secret-token");
    expect(sentConfig.headers).not.toHaveProperty("origin");
  });
});

// ---------------------------------------------------------------------------
// hdroute：noLoginAssert 收窄
// ---------------------------------------------------------------------------
describe("hdroute：noLoginAssert 只命中登录端点/登录参数，不误伤搜索词", () => {
  const logged = async (responseURL: string) => {
    const { default: HDRoute, siteMetadata } = await import("@ptd/site/definitions/hdroute.ts");
    const site: any = new HDRoute({ ...(siteMetadata as any), urls: ["https://hdroute.org/"] });
    return site.loggedCheck({
      status: 200,
      config: { url: responseURL },
      headers: {},
      data: makeDoc("<div>ok</div>"),
      request: { responseURL, responseType: "document" },
    });
  };

  it("登录端点（login.php?action=login / takelogin.php / returnto）仍判未登录", async () => {
    expect(await logged("https://hdroute.org/login.php?action=login")).toBe(false);
    expect(await logged("https://hdroute.org/takelogin.php")).toBe(false);
    expect(await logged("https://hdroute.org/index.php?returnto=forum.php")).toBe(false);
  });

  it("搜索词/普通路径含 login/auth/verify 不再误判为未登录", async () => {
    expect(await logged("https://hdroute.org/browse.php?search=login")).toBe(true);
    expect(await logged("https://hdroute.org/search.php?keywords=auth+verify")).toBe(true);
    expect(await logged("https://hdroute.org/userdetail.php?id=1")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// URL join：animebytes / greatposterwall / secretcinema
// ---------------------------------------------------------------------------
describe("E17 同型：无尾斜杠的站点地址不再拼坏 torrents.php 链接", () => {
  it("animebytes：JSON 搜索行的 url 用 URL join 生成", async () => {
    const { default: AnimeBytes, siteMetadata } = await import("@ptd/site/definitions/animebytes.ts");
    const site: any = new AnimeBytes({ ...(siteMetadata as any), urls: ["https://animebytes.test"] });

    const payload = {
      Groups: [
        {
          ID: 5,
          FullName: "Some Group",
          Comments: 0,
          CategoryName: "Anime",
          Links: {},
          Torrents: [
            {
              ID: 11,
              EditionData: {},
              Property: "",
              RawDownMultiplier: 1,
              Link: "https://animebytes.test/torrent/11",
              UploadTime: "2024-01-02 03:04:05",
              Size: 1024,
              Seeders: 1,
              Leechers: 2,
              Snatched: 3,
            },
          ],
        },
      ],
    };

    const torrents = await site.transformSearchPage(
      payload as any,
      {
        requestConfig: { params: { type: "anime" } },
      } as any,
    );
    expect(torrents[0].url).toBe("https://animebytes.test/torrents.php?id=5&torrentid=11");
  });

  it("greatposterwall / secretcinema：url 与带凭据的 link 都用 siteUrl() 生成并编码凭据", async () => {
    const { default: GreatPosterWall, siteMetadata: gpwMetadata } =
      await import("@ptd/site/definitions/greatposterwall.ts");
    const { default: SecretCinema, siteMetadata: scMetadata } = await import("@ptd/site/definitions/secretcinema.ts");

    const gpw: any = new GreatPosterWall({ ...(gpwMetadata as any), urls: ["https://greatposterwall.test"] });
    gpw.getAuthKey = vi.fn(async () => ({ authkey: "AK&", passkey: "PK/x" }));
    const gpwTorrent = await gpw.transformGroupTorrent(
      {
        groupId: 5,
        groupName: "Group",
        groupSubName: "Sub",
        groupYear: 2024,
        releaseType: "Movie",
        imdbId: "tt1",
        doubanId: "0",
      } as any,
      {
        torrentId: 11,
        resolution: "1080p",
        codec: "H.264",
        source: "WEB-DL",
        container: "MKV",
        scene: false,
        time: "2024-01-02 03:04:05",
        size: 1024,
        seeders: 1,
        leechers: 2,
        snatches: 3,
        isPersonalFreeleech: false,
        freeType: 0,
        jinzhuan: false,
        remasterTitle: "",
      } as any,
    );
    expect(gpwTorrent.url).toBe("https://greatposterwall.test/torrents.php?id=5&torrentid=11");
    expect(gpwTorrent.link).toBe(
      "https://greatposterwall.test/torrents.php?action=download&id=11&authkey=AK%26&torrent_pass=PK%2Fx",
    );

    const sc: any = new SecretCinema({ ...(scMetadata as any), urls: ["https://secretcinema.test"] });
    sc.getAuthKey = vi.fn(async () => ({ authkey: "AK&", passkey: "PK/x" }));
    const scTorrent = await sc.transformGroupTorrent(
      { groupId: 7, groupName: "Album", groupYear: 2024, releaseType: "Music", artist: "Artist" } as any,
      {
        torrentId: 12,
        media: "CD",
        hasLog: false,
        hasCue: false,
        remastered: false,
        remasterTitle: "",
        scene: false,
        time: "2024-01-02 03:04:05",
        size: 2048,
        seeders: 1,
        leechers: 2,
        snatches: 3,
      } as any,
    );
    expect(scTorrent.url).toBe("https://secretcinema.test/torrents.php?id=7&torrentid=12");
    expect(scTorrent.link).toBe(
      "https://secretcinema.test/torrents.php?action=download&id=12&authkey=AK%26&torrent_pass=PK%2Fx",
    );
  });
});

// ---------------------------------------------------------------------------
// kunlun 解耦
// ---------------------------------------------------------------------------
describe("REVIEW-FINDINGS site-defs #6：momentpt / haidan / dubhe 不再依赖死站 kunlun", () => {
  const definitionFile = (name: string) => join(process.cwd(), "src/packages/site/definitions", `${name}.ts`);

  for (const name of ["momentpt", "haidan", "dubhe"])
    it(`${name} 不再 import ./kunlun 且内联了等价 invites 定义`, async () => {
      expect(readFileSync(definitionFile(name), "utf8"), `${name} 仍从死站 kunlun 导入共享对象`).not.toMatch(
        /^import[^\n]*["']\.\/kunlun(\.ts)?["']/m,
      );

      const mod: any = await import(`@ptd/site/definitions/${name}.ts`);
      const userInfo = mod.siteMetadata.userInfo;
      expect(userInfo?.selectors?.invites, `${name} 缺少 invites 选择器`).toBeTruthy();
      expect(
        (userInfo?.process ?? []).some((step: any) => (step.fields ?? []).includes("invites")),
        `${name} 的 userdetails 步骤未追加 invites 字段`,
      ).toBe(true);

      // 内联对象不能与 kunlun 的模块级导出是同一个引用（共享可变对象会跨站串改）
      const { userInfoWithInvitesInUserDetailsPage } = await import("@ptd/site/definitions/kunlun.ts");
      expect(userInfo).not.toBe(userInfoWithInvitesInUserDetailsPage);
    });
});

// ---------------------------------------------------------------------------
// skyeysnow：0 发布用户 uploads = 0
// ---------------------------------------------------------------------------
describe("skyeysnow：0 发布用户 uploads=0，无法确认列表页时保持 undefined", () => {
  const createSite = async (uploadsPage: Document) => {
    const { default: Skyeysnow, siteMetadata } = await import("@ptd/site/definitions/skyeysnow.ts");
    const site: any = new Skyeysnow({
      ...(siteMetadata as any),
      userInfo: { ...siteMetadata.userInfo!, requestDelay: 0 },
    });
    vi.spyOn(PrivateSite.prototype, "getUserInfoResult").mockResolvedValue({
      site: "skyeysnow",
      id: 123,
      status: EResultParseStatus.success,
    } as any);

    const seedingPage = makeDoc(
      `<table class="torrents"><tbody><tr><td>header</td></tr><tr><td>1 GB</td></tr></tbody></table>`,
    );
    site.request = vi.fn(async (config: any) => ({
      data: typeof config.params?.page !== "undefined" ? seedingPage : uploadsPage,
    }));
    site.transformSearchPage = vi.fn(async (doc: Document) => {
      if (doc === uploadsPage) throw new NoTorrentsError();
      return [{ size: 1024 }];
    });
    return site;
  };

  it("uploads 页是空的种子表（表在、0 行）时 uploads = 0（不再丢成 undefined）", async () => {
    const uploadsPage = makeDoc(`<table class="torrents"><tbody><tr><td>header</td></tr></tbody></table>`);
    const site = await createSite(uploadsPage);
    const info = await site.getUserInfoResult({});
    expect(info.uploads).toBe(0);
  });

  it("uploads 响应不是种子列表页（软错误/登录页）时保持 undefined，不伪装成 0", async () => {
    const loginPage = makeDoc(`<div id="loginContainer">please login</div>`);
    const site = await createSite(loginPage);
    const info = await site.getUserInfoResult({});
    expect(info.uploads).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// pussytorrents：初始化 GET 是可选手握
// ---------------------------------------------------------------------------
describe("pussytorrents：统计 POST 前的初始化 GET", () => {
  it("GET 的 userID 与 POST 一致，且两请求之间遵守 requestDelay", async () => {
    const { default: PussyTorrents, siteMetadata } = await import("@ptd/site/definitions/pussytorrents.ts");
    const site: any = new PussyTorrents({
      ...(siteMetadata as any),
      userInfo: { ...siteMetadata.userInfo!, requestDelay: 50 },
    });
    const requestSpy = vi
      .spyOn(BittorrentSite.prototype as any, "request")
      .mockResolvedValueOnce({ data: makeDoc("<p>init</p>") } as any)
      .mockResolvedValueOnce({ data: { iTotalRecords: 7 } } as any);

    const { sleep } = await import("@ptd/site/utils/adapter.ts");
    await site.request({ url: "/user/account/snatchlist", method: "POST", data: { userID: 123 } });

    expect(requestSpy).toHaveBeenCalledTimes(2);
    const [getConfig, postConfig] = requestSpy.mock.calls.map((call) => call[0] as any);
    expect(getConfig.params.userID).toBe(123);
    expect(postConfig.data.userID).toBe(123);
    expect(vi.mocked(sleep)).toHaveBeenCalledWith(50);
  });

  it("初始化 GET 失败只记 warn，不阻断后续统计 POST", async () => {
    const { default: PussyTorrents, siteMetadata } = await import("@ptd/site/definitions/pussytorrents.ts");
    const site: any = new PussyTorrents(siteMetadata);
    const requestSpy = vi
      .spyOn(BittorrentSite.prototype as any, "request")
      .mockRejectedValueOnce(new Error("init failed"))
      .mockResolvedValueOnce({ data: { iTotalRecords: 7 } } as any);

    const result = await site.request({ url: "/user/account/uploadedtorrents", method: "POST", data: { userID: 123 } });

    expect(requestSpy).toHaveBeenCalledTimes(2);
    expect((result as any).data.iTotalRecords).toBe(7);
    expect(mocks.logMessage).toHaveBeenCalledWith(
      expect.stringContaining("init GET failed"),
      expect.objectContaining({ site: "pussytorrents" }),
      "warn",
    );
  });
});
