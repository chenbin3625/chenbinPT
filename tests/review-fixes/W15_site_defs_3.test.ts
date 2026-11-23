import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
const { default: NexusPHP } = await import("@ptd/site/schemas/NexusPHP.ts");
const { default: Unit3D } = await import("@ptd/site/schemas/Unit3D.ts");
const { EResultParseStatus, NoUserInputError } = await import("@ptd/site/types.ts");
const { createDocument, restoreSecureLink } = await import("@ptd/site/utils.ts");

const { siteMetadata: keluMeta } = await import("@ptd/site/definitions/kelu.ts");
const { siteMetadata: katToMeta } = await import("@ptd/site/definitions/kickasstorrentsto.ts");
const { siteMetadata: katWsMeta } = await import("@ptd/site/definitions/kickasstorrentsws.ts");
const { siteMetadata: lstMeta } = await import("@ptd/site/definitions/lst.ts");
const { default: MagnetDownload, siteMetadata: magnetDownloadMeta } =
  await import("@ptd/site/definitions/magnetdownload.ts");
const { default: Milkie, siteMetadata: milkieMeta } = await import("@ptd/site/definitions/milkie.ts");
const { default: MonikaDesign, siteMetadata: monikaDesignMeta } = await import("@ptd/site/definitions/monikadesign.ts");
const { default: MTeam, siteMetadata: mteamMeta } = await import("@ptd/site/definitions/mteam.ts");
const { default: MyAnonamouse, siteMetadata: mamMeta } = await import("@ptd/site/definitions/myanonamouse.ts");
const { default: MySpleen, siteMetadata: mySpleenMeta } = await import("@ptd/site/definitions/myspleen.ts");
const { default: Nebulance, siteMetadata: nebulanceMeta } = await import("@ptd/site/definitions/nebulance.ts");
const { siteMetadata: newStudioMeta } = await import("@ptd/site/definitions/newstudio.ts");
const { siteMetadata: nordicBytesMeta } = await import("@ptd/site/definitions/nordicbytes.ts");
const { siteMetadata: okptMeta } = await import("@ptd/site/definitions/okpt.ts");
const { default: OpenCD, siteMetadata: opencdMeta } = await import("@ptd/site/definitions/opencd.ts");
const { default: PassThePopcorn, siteMetadata: ptpMeta } = await import("@ptd/site/definitions/passthepopcorn.ts");
const { default: Piggo, siteMetadata: piggoMeta } = await import("@ptd/site/definitions/piggo.ts");
const { default: PornXLab, siteMetadata: pornXLabMeta } = await import("@ptd/site/definitions/pornxlab.ts");
const { default: Pter, siteMetadata: pterMeta } = await import("@ptd/site/definitions/pter.ts");
const { default: Pttime, siteMetadata: pttimeMeta } = await import("@ptd/site/definitions/pttime.ts");
const { siteMetadata: ptzoneMeta } = await import("@ptd/site/definitions/ptzone.ts");
const { default: PussyTorrents, siteMetadata: pussyTorrentsMeta } =
  await import("@ptd/site/definitions/pussytorrents.ts");
const { default: QingWa, siteMetadata: qingwaMeta } = await import("@ptd/site/definitions/qingwa.ts");

function decodeMeta<T extends { urls?: string[]; legacyUrls?: string[] }>(meta: T): T {
  return {
    ...meta,
    urls: meta.urls?.map((u) => restoreSecureLink(u)),
    legacyUrls: meta.legacyUrls?.map((u) => restoreSecureLink(u)),
  };
}

function makeDoc(html: string, url: string = "https://site.example/"): Document {
  const doc = createDocument(html, "text/html");
  try {
    Object.defineProperty(doc, "URL", { value: url, configurable: true });
  } catch {
    // ignore if non-configurable
  }
  return doc;
}

function mockRes(data: any, url: string, baseURL: string) {
  const responseURL = /^https?:/i.test(url) ? url : new URL(url, baseURL).toString();
  return {
    status: 200,
    headers: {},
    data,
    config: { baseURL, url },
    request: { responseURL },
  };
}

describe("W15_site_defs_3 regression tests", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.isCloudflareBlocked.mockReturnValue(false);
    mocks.retrieve.mockResolvedValue(null);
    mocks.store.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("F0268 milkie: explicitly sends responseType 'json' for search and userInfo requests", async () => {
    expect(milkieMeta.search?.requestConfig?.responseType).toBe("json");
    expect(milkieMeta.userInfo?.process?.[0]?.requestConfig?.responseType).toBe("json");

    const decoded = decodeMeta(milkieMeta);
    const baseUrl = decoded.urls![0];
    const site = new Milkie(decoded, {
      allowSearch: true,
      allowQueryUserInfo: true,
      inputSetting: { token: "test-api-key" },
    });

    mocks.request
      .mockResolvedValueOnce(
        mockRes(
          {
            torrents: [
              {
                id: "abc123",
                releaseName: "Sample.2026.1080p",
                category: 100,
                size: 1073741824,
                seeders: 10,
                leechers: 2,
                downloaded: 50,
                createdAt: "2026-01-01T00:00:00Z",
              },
            ],
          },
          "/api/v1/torrents",
          baseUrl,
        ),
      )
      .mockResolvedValueOnce(
        mockRes(
          {
            user: {
              displayName: "tester",
              uploaded: 1000,
              downloaded: 500,
              createdAt: "2024-01-01T00:00:00Z",
              role: "User",
            },
          },
          "/api/v1/auth",
          baseUrl,
        ),
      );

    const searchResult = await site.getSearchResult("sample");
    expect(searchResult.status).toBe(EResultParseStatus.success);
    expect(searchResult.data).toHaveLength(1);
    expect(mocks.request.mock.calls[0][0].responseType).toBe("json");

    const userInfo = await site.getUserInfoResult();
    expect(userInfo.status).toBe(EResultParseStatus.success);
    expect(userInfo.name).toBe("tester");
    expect(mocks.request.mock.calls[1][0].responseType).toBe("json");
  });

  it("F0282 pornxlab: avoids mutating torrent.link, normalizes relay/torrent hrefs, and throws on empty link", async () => {
    const decoded = decodeMeta(pornXLabMeta);
    const baseUrl = decoded.urls![0];
    const site = new PornXLab(decoded, {
      downloadLinkAppendix: "&tag=ptd",
    });

    const torrent: any = {
      id: "123",
      title: "Sample",
      url: `${baseUrl}video-123.html`,
    };

    const mockRelayChain = () => {
      mocks.request
        .mockResolvedValueOnce(
          mockRes(
            makeDoc(`<a class="download-button" href="/relay/123">Next</a>`, `${baseUrl}video-123.html`),
            `${baseUrl}video-123.html`,
            baseUrl,
          ),
        )
        .mockResolvedValueOnce(
          mockRes(
            makeDoc(`<a class="download-button" href="/files/123.torrent">Download</a>`, `${baseUrl}relay/123`),
            `${baseUrl}relay/123`,
            baseUrl,
          ),
        );
    };

    mockRelayChain();
    const link1 = await site.getTorrentDownloadLink(torrent);
    expect(link1).toBe(`${baseUrl}files/123.torrent&tag=ptd`);
    expect(torrent.link).toBeUndefined();

    // Calling again (e.g. verification -> download) must NOT duplicate downloadLinkAppendix
    mockRelayChain();
    const link2 = await site.getTorrentDownloadLink(torrent);
    expect(link2).toBe(`${baseUrl}files/123.torrent&tag=ptd`);
    expect(torrent.link).toBeUndefined();

    // Missing download button must throw cleanly rather than returning undefined or bare appendix
    mocks.request.mockResolvedValueOnce(
      mockRes(
        makeDoc(`<div>No download button</div>`, `${baseUrl}video-404.html`),
        `${baseUrl}video-404.html`,
        baseUrl,
      ),
    );
    const missingTorrent: any = { id: "404", title: "Missing", url: `${baseUrl}video-404.html` };
    await expect(site.getTorrentDownloadLink(missingTorrent)).rejects.toThrow(/cannot parse torrent download link/i);
    expect(missingTorrent.link).toBeUndefined();
  });

  it("F0262 kickasstorrentsto: strips '>', '|' and spaces from category via global RegExp", () => {
    const site = new BittorrentSite(katToMeta);
    const doc = makeDoc(
      `<table class="data">
        <tbody>
          <tr class="odd">
            <td class="torrentnamecell">
              <a class="cellMainLink" href="/sample-t123.html">Sample</a>
              <span><strong>Movies &gt; | HD Movies</strong></span>
            </td>
          </tr>
        </tbody>
      </table>`,
      "https://kickass.torrentbay.st/search/",
    );

    const parsed = (site as any).getFieldData(doc.querySelector("tr.odd")!, katToMeta.search!.selectors!.category!);
    expect(parsed).toBe("MoviesHDMovies");
  });

  it("F0263 & F0264 kickasstorrentsws: maps a.icommentjs to comments and routes blank keywords to /new/", () => {
    expect(katWsMeta.search?.selectors?.comments).toEqual({ selector: "a.icommentjs" });
    expect(katWsMeta.search?.selectors?.completed).toBeUndefined();

    const transformer = katWsMeta.search!.requestConfigTransformer!;
    const blankConfig = transformer({ requestConfig: { url: "/usearch/$keywords$/" }, keywords: "   " } as any);
    expect(blankConfig.url).toBe("/new/");

    const emptyConfig = transformer({ requestConfig: { url: "/usearch/$keywords$/" } } as any);
    expect(emptyConfig.url).toBe("/new/");

    const keywordConfig = transformer({
      requestConfig: { url: "/usearch/$keywords$/" },
      keywords: "  ubuntu iso  ",
    } as any);
    expect(keywordConfig.url).toBe("/usearch/ubuntu%20iso/");
  });

  it("F0267 kelu: includes entry-level id 0 'User' in levelRequirements", () => {
    expect(keluMeta.levelRequirements?.[0]).toMatchObject({ id: 0, name: "User" });
    const site = new NexusPHP(decodeMeta(keluMeta));
    expect((site as any).guessUserLevelId({ levelName: "User", uploaded: 0, downloaded: 0, ratio: 0 } as any)).toBe(0);
    expect((site as any).guessUserLevelId({ levelName: "魔法助手" } as any)).toBe(1);
  });

  it("F0269 lst: matches standalone freeleech and featured badge selectors", () => {
    const freeTag = lstMeta.search?.selectors?.tags?.find((t) => t.name === "Free");
    expect(freeTag?.selector).toBe(
      "span[title*='100%'], span.torrent-badges__item--freeleech, span.torrent-badges__item--featured",
    );

    const site = new Unit3D(decodeMeta(lstMeta));
    const rowFree = makeDoc(
      `<table><tr><td><span class="torrent-badges__item--freeleech">FL</span></td></tr></table>`,
    ).querySelector("tr")!;
    const rowFeatured = makeDoc(
      `<table><tr><td><span class="torrent-badges__item--featured">Featured</span></td></tr></table>`,
    ).querySelector("tr")!;

    expect((site as any).getFieldData(rowFree, { selector: freeTag!.selector })).toBe("FL");
    expect((site as any).getFieldData(rowFeatured, { selector: freeTag!.selector })).toBe("Featured");
  });

  it("F0270 magnetdownload: parses AP/full month names, hour-only times, noon, and midnight", async () => {
    const site = new MagnetDownload(magnetDownloadMeta);

    const testCases: Array<[string, number]> = [
      ["Oct. 13, 2026, 2:22 p.m.", Date.UTC(2026, 9, 13, 14, 22)],
      ["March 5, 2026, 2 p.m.", Date.UTC(2026, 2, 5, 14, 0)],
      ["April 1, 2026, 12 a.m.", Date.UTC(2026, 3, 1, 0, 0)],
      ["June 15, 2026, noon", Date.UTC(2026, 5, 15, 12, 0)],
      ["July 4, 2026, midnight", Date.UTC(2026, 6, 4, 0, 0)],
      ["Sept. 9, 2026, 9:05 a.m.", Date.UTC(2026, 8, 9, 9, 5)],
    ];

    for (const [dateText, expectedMs] of testCases) {
      const doc = makeDoc(
        `<html><body>
          <h4>Sample Torrent</h4>
          <table class="info">
            <tr><th>Creation Time</th><td>${dateText}</td></tr>
            <tr><th>File Size</th><td>1.0 GB</td></tr>
          </table>
          <script>var url = '/api/json_info?hashes=' + '25989821';</script>
        </body></html>`,
        "https://magnetdownload.com/info/25989821",
      );
      const parsed = await site.transformDetailPage(doc);
      expect(parsed.time).toBe(expectedMs);
    }
  });

  it("F0271 monikadesign: strips downloadLinkAppendix before fetching detail page, normalizes link, and throws on missing link", async () => {
    const decoded = decodeMeta(monikaDesignMeta);
    const baseUrl = decoded.urls![0];
    const site = new MonikaDesign(decoded, {
      downloadLinkAppendix: "&extra=1",
    });

    mocks.request.mockResolvedValueOnce(
      mockRes(
        makeDoc(`<a href="/torrents/download/777">Download</a>`, `${baseUrl}torrents/777`),
        `${baseUrl}torrents/777`,
        baseUrl,
      ),
    );

    const link = await site.getTorrentDownloadLink({
      id: "777",
      title: "Sample",
      url: `${baseUrl}torrents/777`,
      link: `${baseUrl}torrents/777`,
    } as any);

    expect(mocks.request).toHaveBeenCalledTimes(1);
    expect(mocks.request.mock.calls[0][0].url).toBe(`${baseUrl}torrents/777`);
    expect(link).toBe(`${baseUrl}torrents/download/777&extra=1`);

    mocks.request.mockResolvedValueOnce(
      mockRes(makeDoc(`<div>No link</div>`, `${baseUrl}torrents/778`), `${baseUrl}torrents/778`, baseUrl),
    );

    await expect(
      site.getTorrentDownloadLink({
        id: "778",
        title: "Missing",
        url: `${baseUrl}torrents/778`,
        link: `${baseUrl}torrents/778`,
      } as any),
    ).rejects.toThrow(/cannot parse torrent download link/i);
  });

  it("F0272 & F0273 mteam: extracts ext_douban/ext_imdb from href attr and maps VIP role '10' to levelId 100", () => {
    const site = new MTeam(decodeMeta(mteamMeta));

    // F0272: list[0] and list[1] both have attr: "href" on ext_douban and ext_imdb
    const list0Selectors = mteamMeta.list![0].selectors!;
    const list1Selectors = mteamMeta.list![1].selectors!;
    expect(list0Selectors.ext_douban?.attr).toBe("href");
    expect(list0Selectors.ext_imdb?.attr).toBe("href");
    expect(list1Selectors.ext_douban?.attr).toBe("href");
    expect(list1Selectors.ext_imdb?.attr).toBe("href");

    const row0 = makeDoc(
      `<table><tr><td>
        <a href="https://movie.douban.com/subject/1292052/">9.7</a>
        <a href="https://www.imdb.com/title/tt0111161/">9.3</a>
      </td></tr></table>`,
    ).querySelector("tr")!;
    expect(String((site as any).getFieldData(row0, list0Selectors.ext_douban!))).toBe("1292052");
    expect((site as any).getFieldData(row0, list0Selectors.ext_imdb!)).toBe("tt0111161");

    const row1 = makeDoc(
      `<table><tr><td>
        <a href="/mdb/title?douban=1292052">9.7</a>
        <a href="/mdb/title?imdb=tt0111161">9.3</a>
      </td></tr></table>`,
    ).querySelector("tr")!;
    expect(String((site as any).getFieldData(row1, list1Selectors.ext_douban!))).toBe("1292052");
    expect((site as any).getFieldData(row1, list1Selectors.ext_imdb!)).toBe("tt0111161");

    // F0273: VIP role "10" maps to levelRequirements id 100, while regular role "2" maps to 2
    const levelIdSelector = mteamMeta.userInfo!.process![0].selectors!.levelId!;
    const levelNameSelector = mteamMeta.userInfo!.process![0].selectors!.levelName!;
    expect((site as any).getFieldData({ data: { role: "10" } }, levelIdSelector)).toBe(100);
    expect((site as any).getFieldData({ data: { role: "10" } }, levelNameSelector)).toBe("VIP");
    expect((site as any).getFieldData({ data: { role: "2" } }, levelIdSelector)).toBe(2);

    // Preserve uncommitted WIP trackerUrls
    expect(mteamMeta.trackerUrls).toContain("uggcf://genpxre.z-grnz.pp/");
  });

  it("F0281 myanonamouse: updates messageCount from /jsonLoad.php?notif even when index.php initialized it to 0", async () => {
    const decoded = decodeMeta(mamMeta);
    const baseUrl = decoded.urls![0];
    const site = new MyAnonamouse(decoded, { allowQueryUserInfo: true });

    mocks.request
      .mockResolvedValueOnce(
        mockRes(
          {
            seedUnsat: { count: 2, size: 1024 },
            sSat: { count: 3, size: 2048 },
            seedHnr: { count: 0, size: 0 },
            upAct: { count: 1, size: 512 },
            upInact: { count: 0, size: 0 },
          },
          "/jsonLoad.php?snatch_summary",
          baseUrl,
        ),
      )
      .mockResolvedValueOnce(
        mockRes(
          {
            update: 1700000000,
            notifs: { pms: 2, tickets: 1, ignored: "not-a-number" },
          },
          "/jsonLoad.php?notif",
          baseUrl,
        ),
      );

    // index.php already initialized messageCount to 0; /jsonLoad.php?notif must still overwrite it
    const updated = await (site as any).parseUserInfoForSeedingAndUploadStatus({
      id: 42,
      messageCount: 0,
    });
    expect(updated.messageCount).toBe(3);
    expect(updated.lastAccessAt).toBe(1700000000 * 1000);
  });

  it("F0276 myspleen: applies Free tag and downloadVolumeFactor 0 when document-level sitewide freeleech banner is present", async () => {
    const decoded = decodeMeta(mySpleenMeta);
    const site = new MySpleen(decoded);
    const buildDoc = (withBanner: boolean) =>
      makeDoc(
        `<html><body>
          ${withBanner ? '<ul><li id="alert-fl" class="alert alert-info">Freeleech ends in 2 days</li></ul>' : ""}
          <table id="main-torrents">
            <tbody>
              <tr>
                <td class="cat-25"><a href="browse.php?cat=25">Cat</a></td>
                <td class="tor-name"><a href="details.php?id=999" title="Sample Release">Sample Release</a></td>
                <td class="tor-down"><a href="download.php?id=999">DL</a></td>
                <td>0</td>
                <td>0</td>
                <td>0</td>
                <td>2026-01-01 00:00:00</td>
                <td>1.0 GB</td>
                <td>10</td>
                <td>5</td>
                <td>1</td>
              </tr>
            </tbody>
          </table>
        </body></html>`,
        "https://www.myspleen.org/browse.php",
      );

    const searchConfig = { searchEntry: decoded.search, requestConfig: decoded.search?.requestConfig };
    const withBannerTorrents = await site.transformSearchPage(buildDoc(true), searchConfig);
    expect(withBannerTorrents).toHaveLength(1);
    expect(withBannerTorrents[0].tags?.some((t) => t.name === "Free")).toBe(true);
    expect(withBannerTorrents[0].downloadVolumeFactor).toBe(0);

    const withoutBannerTorrents = await site.transformSearchPage(buildDoc(false), searchConfig);
    expect(withoutBannerTorrents).toHaveLength(1);
    expect(withoutBannerTorrents[0].tags?.some((t) => t.name === "Free")).toBeFalsy();
  });

  it("F0279 nebulance: extracts numeric torrent id on show/group pages", async () => {
    const decoded = decodeMeta(nebulanceMeta);
    const site = new Nebulance(decoded);
    const overlayHtml =
      '<table class="overlay"><tr><td></td></tr><tr><td></td></tr><tr><td>Show.S01E01.1080p</td></tr><tr><td class="rightOverlay">Uploaded: 2025-05-01 12:00</td></tr></table>';
    const doc = makeDoc(
      `<table class="torrent_table">
        <tbody>
          <tr class="torrent">
            <td>
              <div class="showname">S01E01</div>
              <div class="tagssh"><script>var tip = ${JSON.stringify(overlayHtml)};</script></div>
              <a class="codecs" href="torrents.php?id=54321">1080p WEB-DL</a>
              <a href="torrents.php?action=download&id=54321">DL</a>
            </td>
            <td>2.5 GB</td>
            <td>10</td>
            <td>4</td>
            <td>1</td>
          </tr>
        </tbody>
      </table>`,
      "https://nebulance.io/torrents.php?showid=99",
    );

    const torrents = await site.transformSearchPage(doc, {
      searchEntry: decoded.search,
      requestConfig: decoded.search?.requestConfig,
    });
    expect(torrents).toHaveLength(1);
    expect(String(torrents[0].id)).toBe("54321");
    expect(torrents[0].title).toBe("Show.S01E01.1080p");
  });

  it("F0278 newstudio: resolves relative Today/Yesterday dates in MSK (+03:00) regardless of host timezone", async () => {
    vi.useFakeTimers();
    // 2026-06-15T22:30:00Z -> in MSK (+03:00) it is already 2026-06-16 01:30
    vi.setSystemTime(new Date("2026-06-15T22:30:00.000Z"));

    const site = new BittorrentSite(newStudioMeta);
    const doc = makeDoc(
      `<table class="well">
        <tr>
          <td>1</td><td>2</td>
          <td><a href="./viewtopic.php?t=1001"><b>Ep 1</b></a><a href="./download.php?id=2001">DL</a></td>
          <td>4</td>
          <td><a>1.0 GB</a></td>
          <td>Today 01:15</td>
        </tr>
        <tr>
          <td>1</td><td>2</td>
          <td><a href="./viewtopic.php?t=1002"><b>Ep 2</b></a><a href="./download.php?id=2002">DL</a></td>
          <td>4</td>
          <td><a>1.0 GB</a></td>
          <td>Вчера 23:45</td>
        </tr>
      </table>`,
      "https://newstudio.tv/tracker.php",
    );

    const torrents = await site.transformSearchPage(doc, {
      searchEntry: newStudioMeta.search,
      requestConfig: newStudioMeta.search?.requestConfig,
    });
    expect(torrents).toHaveLength(2);
    expect(torrents[0].time).toBe(Date.parse("2026-06-16T01:15:00+03:00"));
    expect(torrents[1].time).toBe(Date.parse("2026-06-15T23:45:00+03:00"));
  });

  it("F0275 nordicbytes: leaves seeding/leeching undefined when count '(n)' is absent and parses integer when present", async () => {
    const decoded = decodeMeta(nordicBytesMeta);
    const baseUrl = decoded.urls![0];
    const site = new Unit3D(decoded, { allowQueryUserInfo: true });

    const runWithNav = async (upText: string, downText: string) => {
      mocks.request
        .mockResolvedValueOnce(
          mockRes(
            makeDoc(
              `<nav class="__navbar-subnav"><a href="/u/alice"><strong>alice</strong></a></nav>
               <ul class="__navbar-stats">
                 <li><a><i class="fa-arrow-up"></i><span>${upText}</span></a></li>
                 <li><a><i class="fa-arrow-down"></i><span>${downText}</span></a></li>
                 <li><a><i class="fa-percent"></i><span>2.5</span></a></li>
               </ul>`,
              baseUrl,
            ),
            "/",
            baseUrl,
          ),
        )
        .mockResolvedValueOnce(
          mockRes(
            makeDoc(`<div class="__profile-badges"><span>User</span></div>`, `${baseUrl}u/alice`),
            "/u/alice",
            baseUrl,
          ),
        );
      return site.getUserInfoResult();
    };

    const withoutCounts = await runWithNav("100 GiB", "40 GiB");
    expect(withoutCounts.status).toBe(EResultParseStatus.success);
    expect(withoutCounts.seeding).toBeUndefined();
    expect(withoutCounts.leeching).toBeUndefined();

    const withCounts = await runWithNav("100 GiB (12)", "40 GiB (3)");
    expect(withCounts.status).toBe(EResultParseStatus.success);
    expect(withCounts.seeding).toBe(12);
    expect(withCounts.leeching).toBe(3);
  });

  it("F0277 okpt: sets tag_id category cross to false for single-valued query param", () => {
    const tagCat = okptMeta.category?.find((c) => c.key === "tag_id");
    expect(tagCat).toBeDefined();
    expect(tagCat?.cross).toBe(false);
  });

  it("F0280 opencd: rewrites /plugin_details.php link and delegates to super for downloadLinkAppendix without mutating torrent.link", async () => {
    const site = new OpenCD(decodeMeta(opencdMeta), { downloadLinkAppendix: "&https=1" });
    const torrent: any = {
      id: "888",
      title: "Album",
      link: "https://open.cd/plugin_details.php?id=888&hit=1",
    };

    const link1 = await site.getTorrentDownloadLink(torrent);
    const link2 = await site.getTorrentDownloadLink(torrent);

    expect(link1).toBe("https://open.cd/download.php?id=888&https=1");
    expect(link2).toBe("https://open.cd/download.php?id=888&https=1");
    expect(torrent.link).toBe("https://open.cd/plugin_details.php?id=888&hit=1");
  });

  it("F0285 passthepopcorn: parses PageData with embedded '});', extracts all qualities/torrents, and avoids invalid time", async () => {
    const site = new PassThePopcorn(decodeMeta(ptpMeta));
    const pageData = {
      AuthKey: "auth-xyz",
      TorrentPass: "pass-abc",
      Movies: [
        {
          GroupId: 101,
          Title: "Movie (with }); inside title)",
          Year: "2025",
          ImdbId: "1234567",
          CategoryName: "Feature Film",
          GroupingQualities: [
            {
              QualityName: "High Definition",
              Torrents: [
                {
                  TorrentId: 1001,
                  Title: '<a title="Info\nMovie.2025.1080p.BluRay">1080p / MKV</a>',
                  Size: "10 GiB",
                  Seeders: "20",
                  Leechers: "2",
                  Snatched: "50",
                  Time: '<span title="May 01 2025, 12:00">1 day ago</span>',
                },
                {
                  TorrentId: 1002,
                  Title: '<a title="Info\nMovie.2025.720p.BluRay">720p / MKV</a>',
                  Size: "5 GiB",
                  Seeders: "10",
                  Leechers: "1",
                  Snatched: "30",
                  Time: '<span title="not-a-valid-date">unknown</span>',
                },
              ],
            },
            {
              QualityName: "Ultra High Definition",
              Torrents: [
                {
                  TorrentId: 1003,
                  Title: '<a title="Info\nMovie.2025.2160p.REMUX">2160p / MKV</a>',
                  Size: "40 GiB",
                  Seeders: "8",
                  Leechers: "0",
                  Snatched: "15",
                  Time: '<span title="May 02 2025, 12:00">1 hour ago</span>',
                },
              ],
            },
          ],
        },
      ],
    };

    const doc = makeDoc(
      `<html><body><script>var PageData = ${JSON.stringify(pageData)}; var Other = 1;</script></body></html>`,
      "https://passthepopcorn.me/torrents.php",
    );

    const torrents = await site.transformSearchPage(doc, {});
    expect(torrents).toHaveLength(3);
    expect(torrents.map((t) => t.id)).toEqual([1001, 1002, 1003]);
    expect(torrents[0].title).toBe("Movie.2025.1080p.BluRay");
    expect(typeof torrents[0].time).toBe("number");
    expect(torrents[1].time).toBeUndefined();
    expect(torrents[2].link).toContain("id=1003");
  });

  it("F0284 piggo: rejects non-envelope HTTP 200 responses in loggedCheck and throws on empty download url", async () => {
    const decoded = decodeMeta(piggoMeta);
    const baseUrl = decoded.urls![0];
    const site = new Piggo(decoded, {
      inputSetting: { token: "piggo-token" },
    });

    // HTTP 200 HTML / non-object response must not pass loggedCheck
    expect(() => (site as any).loggedCheck({ status: 200, data: "<html>Login</html>" })).toThrow(/无效的响应格式/);
    expect(() => (site as any).loggedCheck({ status: 200, data: null })).toThrow(/无效的响应格式/);
    expect(() => (site as any).loggedCheck({ status: 200, data: { code: "0" } })).toThrow(/无效的响应格式/);
    expect(() => (site as any).loggedCheck({ status: 200, data: { code: 401, msg: "unauth" } })).toThrow(
      NoUserInputError,
    );
    expect((site as any).loggedCheck({ status: 200, data: { code: 0, data: {} } })).toBe(true);

    // Missing/blank url from download-link endpoint must throw
    mocks.request.mockResolvedValueOnce(mockRes({ code: 0, data: {} }, "/api/v1/torrents/55/download-link", baseUrl));
    await expect(site.getTorrentDownloadLink({ id: 55, title: "Test" } as any)).rejects.toThrow(/未返回有效的下载链接/);
  });

  it("F0286 pter: extracts game torrent id and clean /detailsgame.php?id=... url without leaking passkey/downhash", () => {
    const site = new Pter(decodeMeta(pterMeta));
    const gameListConfig = pterMeta.list![1];

    const doc = makeDoc(
      `<table class="torrents">
        <tr>
          <td>
            <a class="torrentname">Cool Game</a>
            <a href="https://pterclub.net/download.php?id=12345&passkey=SECRET_KEY&downhash=SECRET_HASH">DL</a>
          </td>
        </tr>
      </table>`,
      "https://pterclub.net/detailsgame.php?id=900",
    );

    const row = doc.querySelector("tr")!;
    expect(String((site as any).getFieldData(row, gameListConfig.selectors!.id!, "id"))).toBe("12345");
    expect((site as any).getFieldData(row, gameListConfig.selectors!.url!, "url")).toBe("/detailsgame.php?id=12345");
    expect(String((site as any).getFieldData(row, gameListConfig.selectors!.url!, "url"))).not.toContain("SECRET_KEY");
    expect(String((site as any).getFieldData(row, gameListConfig.selectors!.url!, "url"))).not.toContain("SECRET_HASH");

    // Preserve uncommitted WIP category
    const cat = pterMeta.category?.find((c) => c.key === "cat");
    expect(cat?.options.some((o) => o.value === 419)).toBe(true);
  });

  it("F0294 & F0295 pttime and qingwa: throw on empty/unrecognized seeding response and allow explicit no-record text", async () => {
    const pttime = new Pttime(decodeMeta(pttimeMeta));
    const qingwa = new QingWa(decodeMeta(qingwaMeta));

    vi.spyOn(pttime as any, "requestUserSeedingPage")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("<div>502 Bad Gateway</div>")
      .mockResolvedValueOnce("<div>没有记录</div>");

    await expect((pttime as any).parseUserInfoForSeedingStatus({ id: 1 })).rejects.toThrow(/empty response/i);
    await expect((pttime as any).parseUserInfoForSeedingStatus({ id: 1 })).rejects.toThrow(/unrecognized response/i);
    const pttimeNoRecord = await (pttime as any).parseUserInfoForSeedingStatus({ id: 1 });
    expect(pttimeNoRecord.seeding).toBe(0);
    expect(pttimeNoRecord.seedingSize).toBe(0);

    vi.spyOn(qingwa as any, "requestUserSeedingPage")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("<div>Cloudflare error</div>")
      .mockResolvedValueOnce("<div>No record.</div>");

    await expect((qingwa as any).parseUserInfoForSeedingStatus({ id: 2 })).rejects.toThrow(/empty response/i);
    await expect((qingwa as any).parseUserInfoForSeedingStatus({ id: 2 })).rejects.toThrow(/unrecognized response/i);
    const qingwaNoRecord = await (qingwa as any).parseUserInfoForSeedingStatus({ id: 2 });
    expect(qingwaNoRecord.seeding).toBe(0);
    expect(qingwaNoRecord.seedingSize).toBe(0);
  });

  it("F0293 ptzone: declares cross append mode on team category", () => {
    const teamCat = ptzoneMeta.category?.find((c) => c.key === "team");
    expect(teamCat).toBeDefined();
    expect(teamCat?.cross).toEqual({ mode: "append" });
  });

  it("F0290 & F0291 pussytorrents: strips all leading '-' negations preserving spaces and asserts numericId into data.userID", async () => {
    const decoded = decodeMeta(pussyTorrentsMeta);
    const baseUrl = decoded.urls![0];
    const transformer = pussyTorrentsMeta.search!.requestConfigTransformer!;
    const req = transformer({
      requestConfig: { url: "/torrents/browse", params: { keywords: "-alpha -beta -gamma" } },
      keywords: "-alpha -beta -gamma",
    } as any);
    expect(req.url).toBe("/torrents/browse?query=alpha%20beta%20gamma");

    // F0291: verify userInfo process steps 3 & 4 substitute numericId via assertion and fail if missing
    const steps = pussyTorrentsMeta.userInfo!.process!;
    expect(steps[2].assertion).toEqual({ numericId: "data.userID" });
    expect(steps[3].assertion).toEqual({ numericId: "data.userID" });
    expect((steps[2].requestConfig.data as any).userID).toBe("$numericId$");
    expect((steps[3].requestConfig.data as any).userID).toBe("$numericId$");

    const site = new PussyTorrents(decoded, { allowQueryUserInfo: true });
    mocks.request
      // Step 1: index page
      .mockResolvedValueOnce(
        mockRes(
          makeDoc(`<div id="memberBar"><div class="span8"><a href="/profile/alice">alice</a></div></div>`, baseUrl),
          "/",
          baseUrl,
        ),
      )
      // Step 2: profile page
      .mockResolvedValueOnce(
        mockRes(
          makeDoc(
            `<html><body>
              <div id="profile">
                <button><i class="icon-arrow-up"></i> 100 GB</button>
                <button><i class="icon-arrow-down"></i> 50 GB</button>
              </div>
              <table id="profileTable">
                <tr><td>Class</td><td>Power User</td></tr>
                <tr><td>Join Date</td><td>Mar 1st 2024</td></tr>
              </table>
              <a href="#snatchlist" data-ajax="/user/account/snatchlist" data-userid="98765">Snatches</a>
            </body></html>`,
            `${baseUrl}profile/alice`,
          ),
          "/profile/alice",
          baseUrl,
        ),
      )
      // Step 3a: init GET for snatchlist
      .mockResolvedValueOnce(
        mockRes(makeDoc("<div>ok</div>", `${baseUrl}user/account/snatchlist`), "/user/account/snatchlist", baseUrl),
      )
      // Step 3b: POST for snatchlist
      .mockResolvedValueOnce(
        mockRes(
          { iTotalRecords: 1, aaData: [["<a>T1</a>", "1.50 GB", "10", "1.50 GB", "3.00 GB", "2.0", 1, 1, "Yes"]] },
          "/user/account/snatchlist",
          baseUrl,
        ),
      )
      // Step 4a: init GET for uploadedtorrents
      .mockResolvedValueOnce(
        mockRes(
          makeDoc("<div>ok</div>", `${baseUrl}user/account/uploadedtorrents`),
          "/user/account/uploadedtorrents",
          baseUrl,
        ),
      )
      // Step 4b: POST for uploadedtorrents
      .mockResolvedValueOnce(mockRes({ iTotalRecords: 2, aaData: [] }, "/user/account/uploadedtorrents", baseUrl));

    const userInfo = await site.getUserInfoResult();
    expect(userInfo.status).toBe(EResultParseStatus.success);
    expect(mocks.request.mock.calls[2][0].params.userID).toBe("98765");
    expect(mocks.request.mock.calls[3][0].data.userID).toBe("98765");
    expect(mocks.request.mock.calls[4][0].params.userID).toBe("98765");
    expect(mocks.request.mock.calls[5][0].data.userID).toBe("98765");
    expect(userInfo.seeding).toBe(1);
    expect(userInfo.uploads).toBe(2);

    // Negative test: when numericId is missing from profile page, assertion stops before sending PLACEHOLDER
    vi.resetAllMocks();
    mocks.isCloudflareBlocked.mockReturnValue(false);
    mocks.request
      .mockResolvedValueOnce(
        mockRes(
          makeDoc(`<div id="memberBar"><div class="span8"><a href="/profile/bob">bob</a></div></div>`, baseUrl),
          "/",
          baseUrl,
        ),
      )
      .mockResolvedValueOnce(
        mockRes(
          makeDoc(
            `<html><body>
              <div id="profile">
                <button><i class="icon-arrow-up"></i> 10 GB</button>
                <button><i class="icon-arrow-down"></i> 5 GB</button>
              </div>
            </body></html>`,
            `${baseUrl}profile/bob`,
          ),
          "/profile/bob",
          baseUrl,
        ),
      );
    const failedInfo = await site.getUserInfoResult();
    expect(failedInfo.status).toBe(EResultParseStatus.parseError);
    expect(mocks.request).toHaveBeenCalledTimes(2);
  });
});
