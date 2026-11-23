import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ISiteMetadata } from "@ptd/site/types.ts";

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  isCloudflareBlocked: vi.fn(() => false),
  sleep: vi.fn(async (_ms?: number) => {}),
  logMessage: vi.fn(),
  retrieve: vi.fn(async () => null as any),
  store: vi.fn(async () => {}),
}));

vi.mock("@ptd/site/utils/adapter.ts", () => ({
  axios: {
    request: mocks.request,
    getUri: (config: any = {}) => {
      const base = String(config.baseURL ?? "");
      const url = String(config.url ?? "");
      if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
      if (!url) return base;
      const combined = url.startsWith("/") ? `${base.replace(/\/+$/, "")}${url}` : `${base.replace(/\/?$/, "/")}${url}`;
      const params = config.params ?? {};
      const search = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null) search.append(key, String(value));
      }
      const query = search.toString();
      return query ? `${combined}${combined.includes("?") ? "&" : "?"}${query}` : combined;
    },
  },
  isCloudflareBlocked: mocks.isCloudflareBlocked,
  retrieve: mocks.retrieve,
  sleep: mocks.sleep,
  store: mocks.store,
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

const { default: BittorrentSite } = await import("@ptd/site/schemas/AbstractBittorrentSite.ts");
const { default: PrivateSite } = await import("@ptd/site/schemas/AbstractPrivateSite.ts");
const { default: NexusPHP } = await import("@ptd/site/schemas/NexusPHP.ts");
const { default: Torznab } = await import("@ptd/site/schemas/Torznab.ts");
const { EResultParseStatus, NeedLoginError, NoUserInputError } = await import("@ptd/site/types.ts");
const { createDocument, restoreSecureLink } = await import("@ptd/site/utils.ts");

const { siteMetadata: skidrowMeta } = await import("@ptd/site/definitions/skidrowrepack.ts");
const { siteMetadata: sosulkiMeta } = await import("@ptd/site/definitions/sosulki.ts");
const { siteMetadata: wihdMeta } = await import("@ptd/site/definitions/wihd.ts");
const { default: SeedCore, siteMetadata: seedcoreMeta } = await import("@ptd/site/definitions/seedcore.ts");
const { default: SpeedApp, siteMetadata: speedappMeta } = await import("@ptd/site/definitions/speedapp.ts");
const { default: ThePirateBay, siteMetadata: tpbMeta } = await import("@ptd/site/definitions/thepiratebay.ts");
const { siteMetadata: retroflixMeta } = await import("@ptd/site/definitions/retroflix.ts");
const { default: RetroMoviesClub, siteMetadata: rmcMeta } = await import("@ptd/site/definitions/retromoviesclub.ts");
const { default: RousiPro, siteMetadata: rousiMeta } = await import("@ptd/site/definitions/rousipro.ts");
const { siteMetadata: sexypicsMeta } = await import("@ptd/site/definitions/sexypics.ts");
const { default: SJTU, siteMetadata: sjtuMeta } = await import("@ptd/site/definitions/sjtu.ts");
const { siteMetadata: soulvoiceMeta } = await import("@ptd/site/definitions/soulvoice.ts");
const { siteMetadata: springsundayMeta } = await import("@ptd/site/definitions/springsunday.ts");
const { default: SunnyPT, siteMetadata: sunnyptMeta } = await import("@ptd/site/definitions/sunnypt.ts");
const { siteMetadata: tangptMeta } = await import("@ptd/site/definitions/tangpt.ts");
const { siteMetadata: tlMeta } = await import("@ptd/site/definitions/torrentleech.ts");
const { siteMetadata: tr4kerMeta } = await import("@ptd/site/definitions/tr4ker.ts");
const { default: TVVault, siteMetadata: tvvaultMeta } = await import("@ptd/site/definitions/tvvault.ts");
const { default: U3C3, siteMetadata: u3c3Meta } = await import("@ptd/site/definitions/u3c3.ts");
const { siteMetadata: xdyptMeta } = await import("@ptd/site/definitions/xdypt.ts");
const { default: Zenith, siteMetadata: zenithMeta } = await import("@ptd/site/definitions/zenith.ts");
const { siteMetadata: zhixingMeta } = await import("@ptd/site/definitions/zhixing.ts");
const { siteMetadata: zrptMeta } = await import("@ptd/site/definitions/zrpt.ts");

function decodeMeta(meta: ISiteMetadata): ISiteMetadata {
  return {
    ...meta,
    urls: meta.urls.map(restoreSecureLink),
    ...(meta.legacyUrls ? { legacyUrls: meta.legacyUrls.map(restoreSecureLink) } : {}),
  };
}

function makeDoc(html: string, url: string = "https://site.example/"): Document {
  const doc = createDocument(html, "text/html");
  try {
    Object.defineProperty(doc, "URL", { value: url, configurable: true });
  } catch {
    // ignore if already defined as non-configurable
  }
  return doc;
}

function okRes(data: any, responseURL: string, status: number = 200) {
  return {
    status,
    headers: {},
    data,
    request: { responseURL },
    config: { url: responseURL },
  };
}

describe("W16_site_defs_4 regression tests", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.isCloudflareBlocked.mockReturnValue(false);
    mocks.sleep.mockResolvedValue(undefined);
    mocks.retrieve.mockResolvedValue(null);
    mocks.store.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("F0298 skidrowrepack: writes search keyword to POST body data.story instead of params.story", async () => {
    expect(skidrowMeta.search?.keywordPath).toBe("data.story");
    const site = new BittorrentSite(decodeMeta(skidrowMeta), { allowSearch: true });
    mocks.request.mockResolvedValueOnce(
      okRes(
        makeDoc(
          `<div class="mov"><a class="mov-t" href="https://skidrowrepack.com/28-hitman-2.html">Hitman 2</a></div>`,
          "https://skidrowrepack.com/index.php",
        ),
        "https://skidrowrepack.com/index.php",
      ),
    );

    const result = await site.getSearchResult("hitman");
    expect(result.status).toBe(EResultParseStatus.success);
    expect(result.data).toHaveLength(1);
    const reqConfig = mocks.request.mock.calls[0][0];
    expect(reqConfig.method).toBe("POST");
    expect(reqConfig.data.story).toBe("hitman");
    expect(reqConfig.params?.story).toBeUndefined();
  });

  it("F0301 & F0302 sosulki: prefers .torrent link over broken magnet and separates list/detail URL patterns", async () => {
    const site = new BittorrentSite(decodeMeta(sosulkiMeta));
    const detailHtmlWithBoth = `<html><body>
      <h1>Sample Title</h1>
      <a href="magnet:?xt=urn:btih:\uFFFDbroken">Magnet</a>
      <a href="/engine/download.php?id=12345">Download torrent</a>
    </body></html>`;

    mocks.request.mockResolvedValueOnce(
      okRes(
        makeDoc(detailHtmlWithBoth, "https://sosulki.bosk.cc/porno/474998-sample.html"),
        "https://sosulki.bosk.cc/porno/474998-sample.html",
      ),
    );
    const dlLink = await site.getTorrentDownloadLink({
      site: "sosulki",
      id: "474998",
      title: "Sample Title",
      url: "https://sosulki.bosk.cc/porno/474998-sample.html",
    });
    expect(dlLink).toBe("https://sosulki.bosk.cc/engine/download.php?id=12345");

    const detailMagnetOnly = makeDoc(
      `<html><body><h1>Sample</h1><a href="magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567">Magnet</a></body></html>`,
      "https://sosulki.bosk.cc/porno/474998-sample.html",
    );
    const parsedMagnet = await site.transformDetailPage(detailMagnetOnly);
    expect(parsedMagnet.link).toBe("magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567");

    // URL pattern verification
    const listEntry = sosulkiMeta.list![0];
    const listInclude = listEntry.urlPattern!.map((p) => new RegExp(p));
    const listExclude = listEntry.excludeUrlPattern!.map((p) => new RegExp(p));
    const detailPatterns = sosulkiMeta.detail!.urlPattern!.map((p) => new RegExp(p));

    const detailUrl = "https://sosulki.bosk.cc/porno/474998-fragmenty-lyubvi.html";
    const listUrl = "https://sosulki.bosk.cc/porno/";
    expect(listInclude.some((r) => r.test(listUrl))).toBe(true);
    expect(listExclude.some((r) => r.test(listUrl))).toBe(false);
    expect(listExclude.some((r) => r.test(detailUrl))).toBe(true);
    expect(detailPatterns.some((r) => r.test(detailUrl))).toBe(true);
    expect(detailPatterns.some((r) => r.test(listUrl))).toBe(false);
  });

  it("F0318 wihd: substitutes $name$ and URI-encodes username segment in profile URL", async () => {
    const site = new PrivateSite(decodeMeta(wihdMeta), { allowQueryUserInfo: true });
    mocks.request
      .mockResolvedValueOnce(
        okRes(
          makeDoc(`<span class="username">Jean Luc#1</span><i class="fa-upload"></i><strong>7</strong>`),
          "https://world-in-hd.net/",
        ),
      )
      .mockResolvedValueOnce(
        okRes(
          makeDoc(`
            <div class="stats">
              <a class="btn">Upload 500 Go</a>
              <a class="btn">Download 100 Go</a>
            </div>
            <span class="class">1080i</span>
            <div class="user-block-content">15/06/2023</div>
          `),
          "https://world-in-hd.net/profils/user/Jean%20Luc%231",
        ),
      );

    const userInfo = await site.getUserInfoResult();
    expect(mocks.request).toHaveBeenCalledTimes(2);
    expect(mocks.request.mock.calls[1][0].url).toBe("/profils/user/Jean%20Luc%231");
    expect(userInfo.status).toBe(EResultParseStatus.success);
    expect(userInfo.name).toBe("Jean Luc#1");
    expect(userInfo.levelName).toBe("1080i");
    expect(userInfo.uploaded).toBeGreaterThan(0);
    expect(userInfo.downloaded).toBeGreaterThan(0);
  });

  it("F0287 & F0288 seedcore: parses JSON promotions/IMDb IDs, strips tt in imdbId query, and preserves Unit3D HTML list selectors", async () => {
    const site = new SeedCore(decodeMeta(seedcoreMeta), {
      allowSearch: true,
      inputSetting: { apikey: "test-key" },
    });

    // 1. JSON API search with IMDb keyword
    mocks.request.mockResolvedValueOnce(
      okRes(
        {
          data: [
            {
              id: 101,
              attributes: {
                name: "Matrix 1999",
                download_link: "https://seedcore.net/torrents/download/101.key",
                category: { name: "Movies" },
                size: 1024 * 1024 * 1024,
                created_at: "2026-01-01T00:00:00Z",
                seeders: 10,
                leechers: 2,
                times_completed: 50,
                imdb_id: "0133093",
                freeleech: "100%",
                double_upload: true,
                internal: true,
                featured: false,
              },
            },
          ],
        },
        "https://seedcore.net/api/torrents/filter",
      ),
    );

    const searchRes = await site.getSearchResult("imdb|tt0133093");
    expect(searchRes.status).toBe(EResultParseStatus.success);
    const reqConfig = mocks.request.mock.calls[0][0];
    expect(reqConfig.params.imdbId).toBe("0133093");
    expect(reqConfig.params.name).toBeUndefined();
    expect(searchRes.data).toHaveLength(1);
    expect(searchRes.data[0].ext_imdb).toBe("tt0133093");
    expect(searchRes.data[0].downloadVolumeFactor).toBe(0);
    expect(searchRes.data[0].uploadVolumeFactor).toBe(2);
    expect(searchRes.data[0].tags?.map((t) => t.name)).toContain("官方");

    // 2. HTML list page keeps Unit3D DOM selectors (mergeSearchSelectors: false)
    expect(seedcoreMeta.list?.[0]?.mergeSearchSelectors).toBe(false);
    const listDoc = makeDoc(
      `<div class="torrent-search--list__results"><table><tbody><tr class="torrent-search--list__row">
        <td><a class="torrent-search--list__name" href="/torrents/202">DOM Movie</a></td>
        <td><a href="/torrents/download/202">DL</a></td>
        <td><i class="torrent-icons__freeleech fa-star" title="100% Freeleech"></i></td>
      </tr></tbody></table></div>`,
      "https://seedcore.net/torrents",
    );
    const { torrents: listTorrents } = await site.transformListPage(listDoc);
    expect(listTorrents).toHaveLength(1);
    expect(listTorrents[0].title).toBe("DOM Movie");
    expect(listTorrents[0].tags?.map((t) => t.name)).toContain("Free");
  });

  it("F0300 & F0309 speedapp: handles middle-page download links with appendix/fixLink and preserves non-array search params without mutation", async () => {
    const site = new SpeedApp(decodeMeta(speedappMeta), {
      allowSearch: true,
      downloadLinkAppendix: "&passkey=abc",
    });

    // F0300: middle page resolution
    mocks.request.mockResolvedValueOnce(
      okRes(
        makeDoc(
          `<html><body><a href="/torrents/999/download">Download</a></body></html>`,
          "https://speedapp.io/browse/999/t/sample",
        ),
        "https://speedapp.io/browse/999/t/sample",
      ),
    );

    const dl = await site.getTorrentDownloadLink({
      site: "speedapp",
      id: "999",
      title: "Sample",
      url: "https://speedapp.io/browse/999/t/sample",
      link: "https://speedapp.io/browse/999/t/sample",
    });
    expect(mocks.request.mock.calls[0][0].url).toBe("https://speedapp.io/browse/999/t/sample");
    expect(dl).toBe("https://speedapp.io/torrents/999/download&passkey=abc");

    // F0309: non-mutating search param merging
    const originalParams: Record<string, any> = {
      categories: [8],
      resolution: [4],
      codec: [9],
      page: 2,
      sort: "seeders",
    };
    const searchEntry = { requestConfig: { params: originalParams } };
    mocks.request.mockResolvedValueOnce(
      okRes(makeDoc(`<div></div>`, "https://speedapp.io/browse"), "https://speedapp.io/browse"),
    );

    await site.getSearchResult("matrix", searchEntry);
    expect(originalParams).toEqual({
      categories: [8],
      resolution: [4],
      codec: [9],
      page: 2,
      sort: "seeders",
    });
    const sentParams = mocks.request.mock.calls[1][0].params;
    expect(sentParams.categories).toEqual([8]);
    expect(sentParams.tags).toEqual([4, 9]);
    expect(sentParams.page).toBe(2);
    expect(sentParams.sort).toBe("seeders");
    expect(sentParams.resolution).toBeUndefined();
    expect(sentParams.codec).toBeUndefined();
  });

  it("F0299 thepiratebay: filters out apibay all-zero/id=0 sentinel row", async () => {
    const site = new ThePirateBay(decodeMeta(tpbMeta), { allowSearch: true });
    mocks.request.mockResolvedValueOnce(
      okRes(
        [
          {
            id: "0",
            name: "No results returned",
            info_hash: "0000000000000000000000000000000000000000",
            leechers: "0",
            seeders: "0",
            size: "0",
            added: "0",
            category: "0",
          },
        ],
        "https://apibay.org/q.php",
      ),
    );

    const res = await site.getSearchResult("nonexistent_query_xyz");
    expect(res.status).toBe(EResultParseStatus.noResults);
    expect(res.data).toEqual([]);
  });

  it("F0292 retroflix: includes averageSeedingTime in userInfo.process[1].fields", () => {
    const detailsStep = retroflixMeta.userInfo!.process![1];
    expect(detailsStep.fields).toContain("averageSeedingTime");
  });

  it("F0289 retromoviesclub: preserves Unit3D HTML list selectors and delegates DOM rows in parseTorrentRowForTags", async () => {
    expect(rmcMeta.list?.[0]?.mergeSearchSelectors).toBe(false);
    const site = new RetroMoviesClub(decodeMeta(rmcMeta), { inputSetting: { token: "rmc-token" } });
    const listDoc = makeDoc(
      `<div class="torrent-search--list__results"><table><tbody><tr class="torrent-search--list__row">
        <td><a class="torrent-search--list__name" href="/torrents/55">Classic Film 1995</a></td>
        <td><a href="/torrents/download/55">DL</a></td>
        <td><i class="torrent-icons__freeleech fa-star" title="100% Freeleech"></i></td>
      </tr></tbody></table></div>`,
      "https://retro-movies.club/torrents",
    );
    const { torrents } = await site.transformListPage(listDoc);
    expect(torrents).toHaveLength(1);
    expect(torrents[0].title).toBe("Classic Film 1995");
    expect(torrents[0].tags?.map((t) => t.name)).toContain("Free");
  });

  it("F0296 & F0297 rousipro: guards auth/responseType, validates numeric ID without mutating torrent, and returns undefined on unmatched detail URL", async () => {
    const decodedRousi = decodeMeta(rousiMeta);
    // Blank passkey throws NoUserInputError on trusted requests
    const noKeySite = new RousiPro(decodedRousi, { inputSetting: { passkey: "   " } });
    await expect(noKeySite.request({ url: "/api/v1/profile" })).rejects.toThrow(NoUserInputError);

    const site = new RousiPro(decodedRousi, { inputSetting: { passkey: "  pgk_secret  " } });
    // Preserves caller responseType without mutating caller config on trusted download request
    const callerConfig: any = { url: "https://rousi.pro/dl/file.torrent", responseType: "blob" };
    mocks.request.mockResolvedValueOnce(okRes(new Blob([]), "https://rousi.pro/dl/file.torrent"));
    await site.request(callerConfig, false);
    const sentBlobConfig = mocks.request.mock.calls[0][0];
    expect(sentBlobConfig.responseType).toBe("blob");
    expect(sentBlobConfig.headers?.Authorization).toBe("Bearer pgk_secret");
    expect(callerConfig.headers).toBeUndefined();

    // Untrusted external URL is blocked without injecting Authorization or throwing NoUserInputError
    await expect(
      noKeySite.request({ url: "https://cdn.example.net/file.torrent", responseType: "blob" }, false),
    ).rejects.toThrow(/untrusted host/);

    // F0297: unmatched detail URL returns undefined (not full URL)
    const nonMatchingDoc = makeDoc("<html><body><h1>Other</h1></body></html>", "https://rousi.pro/other/page");
    const idQuery = rousiMeta.detail!.selectors!.id!;
    expect(idQuery.elementProcess!(nonMatchingDoc as any)).toBeUndefined();

    // F0297: extracts numeric ID without mutating torrent.id, rejects invalid IDs
    const badTorrent: any = { site: "rousipro", id: "https://rousi.pro/not-a-torrent", title: "Bad" };
    await expect(site.getTorrentDownloadLink(badTorrent)).rejects.toThrow(/numeric torrent id/);

    const fallbackTorrent: any = {
      site: "rousipro",
      id: "",
      url: "https://rousi.pro/torrents/4567",
      title: "Good",
    };
    mocks.request.mockResolvedValueOnce(
      okRes(
        { code: 0, message: "ok", data: { download_url: "https://rousi.pro/dl/4567?sig=1" } },
        "https://rousi.pro/api/v1/torrents/4567",
      ),
    );
    const dlUrl = await site.getTorrentDownloadLink(fallbackTorrent);
    expect(dlUrl).toBe("https://rousi.pro/dl/4567?sig=1");
    expect(fallbackTorrent.id).toBe("");
    expect(mocks.request.mock.calls[1][0].headers.Authorization).toBe("Bearer pgk_secret");
  });

  it("F0304 sexypics: cleans params.keywords and trims/collapses/encodes URL segments", () => {
    const transformer = sexypicsMeta.search!.requestConfigTransformer!;
    const config1 = transformer({
      keywords: "  Foo   Bar/Baz?  ",
      searchEntry: sexypicsMeta.search!,
      requestConfig: { url: "/browse/all/age/desc/", params: { keywords: "  Foo   Bar/Baz?  " } },
    });
    expect(config1.url).toBe("/f/foo-bar%2Fbaz%3F/age/desc/");
    expect(config1.params?.keywords).toBeUndefined();

    const config2 = transformer({
      keywords: "   ",
      searchEntry: sexypicsMeta.search!,
      requestConfig: { url: "/browse/all/age/desc/", params: { keywords: "   " } },
    });
    expect(config2.url).toBe("/browse/all/age/desc/");
    expect(config2.params?.keywords).toBeUndefined();
  });

  it("F0306 sjtu: rejects unrecognized seeding page responses instead of zeroing and guards non-string uploads response", async () => {
    const site = new SJTU(decodeMeta(sjtuMeta));
    mocks.request.mockResolvedValueOnce(
      okRes(
        "<html><body>Permission denied</body></html>",
        "https://pt.sjtu.edu.cn/viewusertorrents.php?id=1&show=seeding",
      ),
    );
    await expect((site as any).parseUserInfoForSeedingStatus({ id: 1, seeding: 12 })).rejects.toThrow(/unrecognized/);

    mocks.request.mockResolvedValueOnce(
      okRes("No record.", "https://pt.sjtu.edu.cn/viewusertorrents.php?id=1&show=seeding"),
    );
    const zeroed = await (site as any).parseUserInfoForSeedingStatus({ id: 1 });
    expect(zeroed.seeding).toBe(0);
    expect(zeroed.seedingSize).toBe(0);

    mocks.request.mockResolvedValueOnce(
      okRes(null, "https://pt.sjtu.edu.cn/getusertorrentlistajax.php?userid=1&type=uploaded"),
    );
    const uploadsRes = await (site as any).parseUserInfoForUploads({ id: 1 });
    expect(uploadsRes.uploads).toBeUndefined();
  });

  it("F0307 & F0308 soulvoice / tangpt: team category specifies cross append mode", () => {
    expect(soulvoiceMeta.category?.find((c) => c.key === "team")?.cross).toEqual({ mode: "append" });
    expect(tangptMeta.category?.find((c) => c.key === "team")?.cross).toEqual({ mode: "append" });
  });

  it("F0303 springsunday: progress parser handles single-digit widths and preceding CSS numbers", () => {
    const doc = makeDoc(`
      <div>
        <div style="height: 10px; width: 5%"></div>
        <div class="p_downloading"></div>
      </div>
      <div>
        <div style="height: 10px; width: 45.5%"></div>
        <div class="p_downloading"></div>
      </div>
    `);
    const els = doc.querySelectorAll<HTMLElement>(".p_downloading");
    const process = springsundayMeta.search!.selectors!.progress!.elementProcess!;
    expect(process(els[0])).toBe(5);
    expect(process(els[1])).toBe(45.5);
  });

  it("F0305 sunnypt: validates API response code and download_url and appends downloadLinkAppendix", async () => {
    const site = new SunnyPT(decodeMeta(sunnyptMeta), {
      inputSetting: { apiKey: "sunny-key" },
      downloadLinkAppendix: "&x=1",
    });

    mocks.request.mockResolvedValueOnce(
      okRes(
        { code: 401, msg: "Unauthorized", data: {} },
        "https://api.sunnypt.top/api/v1/mp/torrents/10/download-token",
      ),
    );
    await expect(site.getTorrentDownloadLink({ site: "sunnypt", id: 10, title: "A" })).rejects.toThrow(NeedLoginError);

    mocks.request.mockResolvedValueOnce(
      okRes(
        { code: 500, msg: "Server error", data: {} },
        "https://api.sunnypt.top/api/v1/mp/torrents/10/download-token",
      ),
    );
    await expect(site.getTorrentDownloadLink({ site: "sunnypt", id: 10, title: "A" })).rejects.toThrow(/code=500/);

    mocks.request.mockResolvedValueOnce(
      okRes(
        { code: 0, data: { download_url: "https://sunnypt.top/dl/10?token=abc" } },
        "https://api.sunnypt.top/api/v1/mp/torrents/10/download-token",
      ),
    );
    const url = await site.getTorrentDownloadLink({ site: "sunnypt", id: 10, title: "A" });
    expect(url).toBe("https://api.sunnypt.top/dl/10?token=abc&x=1");
  });

  it("F0311 & F0310 torrentleech: strips all leading dashes while preserving spaces and guards null ext_tvmaze", () => {
    const transformer = tlMeta.search!.requestConfigTransformer!;
    const req = transformer({
      keywords: "-foo --bar -baz",
      searchEntry: tlMeta.search!,
      requestConfig: { url: "/torrents/browse/list/query", params: { keywords: "-foo --bar -baz" } },
    });
    expect(req.url).toBe("/torrents/browse/list/query/foo%20bar%20baz");

    const tvmazeFilter = tlMeta.search!.selectors!.ext_tvmaze!.filters![0] as (q: any) => any;
    expect(tvmazeFilter(null)).toBeNull();
    expect(tvmazeFilter("")).toBeNull();
    expect(tvmazeFilter("e12345")).toBeNull();
    expect(tvmazeFilter("s9876")).toBe("9876");
  });

  it("F0315 tr4ker: normalizes numeric Torznab imdbid via extImdbId filter", async () => {
    const site = new Torznab(decodeMeta(tr4kerMeta), { allowSearch: true, inputSetting: { apikey: "k" } });
    const xml = createDocument(
      `<rss xmlns:torznab="http://torznab.com/schemas/2015/feed"><channel><item>
        <title>Test Movie</title>
        <guid>123</guid>
        <comments>https://tr4ker.net/torrents/123</comments>
        <enclosure url="https://tr4ker.net/dl/123" length="1024" type="application/x-bittorrent" />
        <torznab:attr name="imdbid" value="0133093" />
        <torznab:attr name="category" value="2040" />
      </item></channel></rss>`,
      "text/xml",
    );
    const torrents = await site.transformSearchPage(xml, {
      searchEntry: tr4kerMeta.search!,
      requestConfig: { baseURL: "https://tr4ker.net/", url: "/api/torznab/all" },
      keywords: "test",
    });
    expect(torrents).toHaveLength(1);
    expect(torrents[0].ext_imdb).toBe("tt0133093");
  });

  it("F0312 & F0316 tvvault: does not extend cooldown on persisted rejection/storage failure and parses relative XML details URL", async () => {
    vi.useFakeTimers();
    const baseMs = 1_800_000_000_000;
    vi.setSystemTime(baseMs);

    const site = new TVVault(decodeMeta(tvvaultMeta), {
      allowSearch: true,
      inputSetting: { authkey: "secret-auth" },
    });

    // Persisted saved timestamp 200s ago (101s left in 301s cooldown)
    const savedSec = Math.floor(baseMs / 1000) - 200;
    mocks.retrieve.mockResolvedValueOnce(savedSec);
    const rateLimited = await site.getSearchResult("doctor who");
    expect(rateLimited.status).toBe(EResultParseStatus.passParse);
    expect(rateLimited.statusMsg).toContain("101");

    // Advance 105s -> saved cooldown has expired; should NOT have been extended to baseMs!
    vi.setSystemTime(baseMs + 105_000);
    mocks.retrieve.mockResolvedValueOnce(savedSec);
    mocks.request.mockResolvedValueOnce(
      okRes(
        `<searchresults>
          <show id="10" name="Doctor Who">
            <item>
              <details>torrents.php?id=10&amp;torrentid=20</details>
              <title>S01E01</title>
              <size>500000000</size>
            </item>
          </show>
        </searchresults>`,
        "https://tv-vault.me/xmlsearch.php",
      ),
    );

    const res = await site.getSearchResult("doctor who");
    expect(res.status).toBe(EResultParseStatus.success);
    expect(res.data).toHaveLength(1);
    expect(res.data[0].id).toBe("20");
    expect(res.data[0].url).toBe("https://tv-vault.me/torrents.php?id=10&torrentid=20");
  });

  it("F0313 & F0314 u3c3: respects allowSearch/enabled guards, classifies token failures, and refreshes token after TTL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);

    const decodedU3c3 = decodeMeta(u3c3Meta);
    // Disabled site makes zero network calls
    const disabledSite = new U3C3(decodedU3c3, { allowSearch: false });
    const disabledRes = await disabledSite.getSearchResult("test");
    expect(disabledRes.status).toBe(EResultParseStatus.passParse);
    expect(mocks.request).not.toHaveBeenCalled();

    // Token fetch error returns classified ISearchResult instead of throwing
    const site = new U3C3(decodedU3c3, { allowSearch: true });
    mocks.request.mockResolvedValueOnce(okRes("<html><body>no token here</body></html>", "https://u3c3.com/"));
    const failedRes = await site.getSearchResult("test");
    expect(failedRes.status).toBe(EResultParseStatus.parseError);
    expect(failedRes.data).toEqual([]);

    // Valid token fetch + TTL expiry refresh
    const htmlWithToken = (tok: string) =>
      `<html><body><script>\nvar k = "${tok}"; url = "?search2=" + k;\n</script>
        <table class="torrent-list"><tbody><tr>
          <td><a href="/?type=Video" title="Video">V</a></td>
          <td><a href="/view?id=abc123" title="Clip">Clip</a></td>
          <td><a href="magnet:?xt=urn:btih:1234">M</a></td>
          <td>1 GB</td>
          <td>2026-01-01 00:00:00</td>
        </tr></tbody></table></body></html>`;

    mocks.request
      .mockResolvedValueOnce(okRes(htmlWithToken("tok1"), "https://u3c3.com/"))
      .mockResolvedValueOnce(okRes(makeDoc(htmlWithToken("tok1"), "https://u3c3.com/"), "https://u3c3.com/"));

    const firstOk = await site.getSearchResult("clip");
    expect(firstOk.status).toBe(EResultParseStatus.success);
    expect(mocks.request.mock.calls[2][0].params.search2).toBe("tok1");

    // Advance past 15-minute TTL -> token should re-fetch
    vi.setSystemTime(1_800_000_000_000 + 16 * 60 * 1000);
    mocks.request
      .mockResolvedValueOnce(okRes(htmlWithToken("tok2"), "https://u3c3.com/"))
      .mockResolvedValueOnce(okRes(makeDoc(htmlWithToken("tok2"), "https://u3c3.com/"), "https://u3c3.com/"));

    const secondOk = await site.getSearchResult("clip");
    expect(secondOk.status).toBe(EResultParseStatus.success);
    expect(mocks.request.mock.calls[4][0].params.search2).toBe("tok2");
  });

  it("F0320 xdypt: team category options have unique values and append mode", () => {
    const teamCat = xdyptMeta.category!.find((c) => c.key === "team")!;
    const values = teamCat.options.map((o) => o.value);
    expect(new Set(values).size).toBe(values.length);
    expect(teamCat.cross).toEqual({ mode: "append" });
  });

  it("F0319 zenith: overrides list[0] with mergeSearchSelectors=false and Unit3D HTML selectors", async () => {
    expect(zenithMeta.list?.[0]?.mergeSearchSelectors).toBe(false);
    const site = new Zenith(decodeMeta(zenithMeta), { inputSetting: { token: "z-token" } });
    const listDoc = makeDoc(
      `<div class="torrent-search--list__results"><table><tbody><tr class="torrent-search--list__row">
        <td><a class="torrent-search--list__name" href="/torrents/77">Zenith Release</a></td>
        <td><a href="/torrents/download/77">DL</a></td>
      </tr></tbody></table></div>`,
      "https://znth.cx/torrents",
    );
    const { torrents } = await site.transformListPage(listDoc);
    expect(torrents).toHaveLength(1);
    expect(torrents[0].title).toBe("Zenith Release");
  });

  it("F0321 zhixing: strips ratio label and parenthetical 20G note completely", () => {
    const site = new PrivateSite(decodeMeta(zhixingMeta));
    const ratioSelector = zhixingMeta.userInfo!.process![1].selectors!.ratio!;

    const docNormal = makeDoc(`<p>共享率: 1.85 (下载-虚拟下载小于20G则共享率为0)</p>`);
    expect((site as any).getFieldData(docNormal, ratioSelector, "ratio")).toBe(1.85);

    const docZero = makeDoc(`<p>共享率: 0 (下载-虚拟下载小于20G则共享率为0)</p>`);
    expect((site as any).getFieldData(docZero, ratioSelector, "ratio")).toBe(0);
  });

  it("F0322 zrpt: search title reads full title attribute instead of truncated text and falls back when absent", () => {
    const site = new NexusPHP(decodeMeta(zrptMeta));
    const titleSelector = zrptMeta.search!.selectors!.title!;

    const rowWithTitle = makeDoc(
      `<table><tr><td><a href="details.php?id=1" title="Full Documentary Title 2026 4K">Full Documentary...</a></td></tr></table>`,
    );
    expect((site as any).getFieldData(rowWithTitle, titleSelector, "title")).toBe("Full Documentary Title 2026 4K");

    const rowWithoutTitle = makeDoc(
      `<table><tr><td><a href="details.php?id=2">Fallback Plain Title</a></td></tr></table>`,
    );
    expect((site as any).getFieldData(rowWithoutTitle, titleSelector, "title")).toBe("Fallback Plain Title");
  });
});
