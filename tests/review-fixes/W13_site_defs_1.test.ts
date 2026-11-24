import { beforeEach, describe, expect, it, vi } from "vitest";

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

vi.stubEnv("VITE_ENABLE_AVISTAZ_USER_INFO_FETCHING", "true");

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
const { EResultParseStatus, NoUserInputError } = await import("@ptd/site/types.ts");
const { NetworkError } = await import("@ptd/site/utils/error.ts");
const { restoreSecureLink } = await import("@ptd/site/utils/html.ts");
const { convertIsoDurationToSeconds } = await import("@ptd/site/utils/datetime.ts");
const { guessUserLevelId } = await import("@ptd/site/utils/level.ts");

const { siteMetadata: x1337Meta } = await import("@ptd/site/definitions/1337x.ts");
const { default: ABTorrents, siteMetadata: abtorrentsMeta } = await import("@ptd/site/definitions/abtorrents.ts");
const { siteMetadata: acgripMeta } = await import("@ptd/site/definitions/acgrip.ts");
const { default: AlphaRatio, siteMetadata: alpharatioMeta } = await import("@ptd/site/definitions/alpharatio.ts");
const { siteMetadata: anibtMeta } = await import("@ptd/site/definitions/anibt.ts");
const { default: AnimeBytes, siteMetadata: animebytesMeta } = await import("@ptd/site/definitions/animebytes.ts");
const { siteMetadata: animetoshoMeta } = await import("@ptd/site/definitions/animetosho.ts");
const { default: AnimeZ, siteMetadata: animezMeta } = await import("@ptd/site/definitions/animez.ts");
const { default: Anthelion, siteMetadata: anthelionMeta } = await import("@ptd/site/definitions/anthelion.ts");
const { default: AudioBookBay, siteMetadata: audiobookbayMeta } = await import("@ptd/site/definitions/audiobookbay.ts");
const { siteMetadata: bakabtMeta } = await import("@ptd/site/definitions/bakabt.ts");
const { default: BeyondHD, siteMetadata: beyondhdMeta } = await import("@ptd/site/definitions/beyondhd.ts");
const { default: Bibliotik, siteMetadata: bibliotikMeta } = await import("@ptd/site/definitions/bibliotik.ts");
const { default: BlueRoms, siteMetadata: blueromsMeta } = await import("@ptd/site/definitions/blueroms.ts");
const { siteMetadata: btnMeta } = await import("@ptd/site/definitions/broadcasthenet.ts");
const { siteMetadata: byrutorMeta } = await import("@ptd/site/definitions/byrutor.ts");
const { default: C411, siteMetadata: c411Meta } = await import("@ptd/site/definitions/c411.ts");
const { default: ColaPT, siteMetadata: colaptMeta } = await import("@ptd/site/definitions/colapt.ts");
const { default: Concertos, siteMetadata: concertosMeta } = await import("@ptd/site/definitions/concertos.ts");
const { default: DesiTorrents, siteMetadata: desitorrentsMeta } = await import("@ptd/site/definitions/desitorrents.ts");
const { default: DICMusic, siteMetadata: dicmusicMeta } = await import("@ptd/site/definitions/dicmusic.ts");
const { siteMetadata: digitalcoreMeta } = await import("@ptd/site/definitions/digitalcore.ts");
const { default: DirtyBytes, siteMetadata: dirtybytesMeta } = await import("@ptd/site/definitions/dirtybytes.ts");

function decodeMeta<T extends { urls: string[]; legacyUrls?: string[]; trackerUrls?: string[] }>(meta: T): T {
  return {
    ...meta,
    urls: meta.urls.map(restoreSecureLink),
    ...(meta.legacyUrls ? { legacyUrls: meta.legacyUrls.map(restoreSecureLink) } : {}),
    ...(meta.trackerUrls ? { trackerUrls: meta.trackerUrls.map(restoreSecureLink) } : {}),
  };
}

function makeDoc(html: string, url: string = "https://site.example/"): Document {
  const doc = new DOMParser().parseFromString(`<html><head></head><body>${html}</body></html>`, "text/html");
  Object.defineProperty(doc, "URL", { value: url, configurable: true });
  return doc;
}

function makeFullDoc(html: string, url: string = "https://site.example/"): Document {
  const doc = new DOMParser().parseFromString(html, "text/html");
  Object.defineProperty(doc, "URL", { value: url, configurable: true });
  return doc;
}

function okResponse<T>(config: any, data: T, status: number = 200) {
  return {
    data,
    status,
    statusText: status === 200 ? "OK" : "ERR",
    headers: {},
    config,
    request: { responseURL: config?.baseURL ? new URL(config.url ?? "/", config.baseURL).toString() : config?.url },
  };
}

function matchesAnyPattern(patterns: Array<string | RegExp> | undefined, url: string): boolean {
  return (patterns ?? []).some((p) => (typeof p === "string" ? new RegExp(p, "i").test(url) : p.test(url)));
}

beforeEach(() => {
  mocks.request.mockReset();
  mocks.isCloudflareBlocked.mockReset();
  mocks.isCloudflareBlocked.mockReturnValue(false);
  mocks.sleep.mockReset();
  mocks.logMessage.mockReset();
  mocks.retrieve.mockReset();
  mocks.retrieve.mockResolvedValue(null);
  mocks.store.mockReset();
});

describe("W13_site_defs_1 High findings", () => {
  it("F0198 (anibt): extracts namespaced anibt:* elements from application/xml RSS feed", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <rss version="2.0" xmlns:anibt="https://anibt.net/ns/1.0">
        <channel>
          <item>
            <guid>anibt-42</guid>
            <title>[SubsPlease] Sample Anime - 01 (1080p)</title>
            <pubDate>Mon, 01 Jan 2024 12:00:00 +0800</pubDate>
            <enclosure url="magnet:?xt=urn:btih:abcdef1234567890" type="application/x-bittorrent" />
            <anibt:animeTitle>示例动画</anibt:animeTitle>
            <anibt:releasePageUrl>https://anibt.net/release/42</anibt:releasePageUrl>
            <anibt:fileSize>1073741824</anibt:fileSize>
            <anibt:type>Anime</anibt:type>
          </item>
        </channel>
      </rss>`;
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    const site = new BittorrentSite(decodeMeta(anibtMeta));
    const torrents = await site.transformSearchPage(doc, { searchEntry: anibtMeta.search! });

    expect(torrents).toHaveLength(1);
    expect(torrents[0].id).toBe("anibt-42");
    expect(torrents[0].subTitle).toBe("示例动画");
    expect(torrents[0].url).toBe("https://anibt.net/release/42");
    expect(torrents[0].size).toBe(1073741824);
    expect(torrents[0].category).toBe("Anime");
  });

  it("F0208 (beyondhd): parses mixed-case Y/M/D/h/m/s and sub-day durations accurately", () => {
    const site = new BeyondHD(decodeMeta(beyondhdMeta));
    const selectors = beyondhdMeta.userInfo!.selectors!;

    const cases: Array<[string, number | undefined]> = [
      ["1Y 2M 3D 1h 7m 1s", convertIsoDurationToSeconds("P1Y2M3DT1H7M1S")],
      ["1h 7m 1s", convertIsoDurationToSeconds("PT1H7M1S")],
      ["5m 10s", convertIsoDurationToSeconds("PT5M10S")],
      ["2M 10D", convertIsoDurationToSeconds("P2M10D")],
      ["", undefined],
    ];

    for (const [raw, expected] of cases) {
      const doc = makeDoc(`
        <table>
          <tr>
            <td class="bhd-user-left">Total Seedtime</td>
            <td><span class="badge-user">${raw}</span></td>
          </tr>
          <tr>
            <td class="bhd-user-left">Average Seedtime</td>
            <td><span class="badge-user">${raw}</span></td>
          </tr>
        </table>
      `);
      const parsed = (site as any).getFieldsData(doc, selectors, ["seedingTime", "averageSeedingTime"], {
        dropEmptyMisses: true,
      });
      expect(parsed.seedingTime).toBe(expected);
      expect(parsed.averageSeedingTime).toBe(expected);
    }
  });

  it("F0223 (concertos): /torrents list page uses HTML selectors instead of JSON API selectors", async () => {
    const html = `
      <table>
        <tbody>
          <tr class="c-torrent-row" data-torrent-id="9001">
            <td><a class="c-torrent-row__name" href="/torrents/9001">Live Concert 2025 1080p</a></td>
            <td><a class="c-torrent-row__action--download" href="/torrents/download/9001">DL</a></td>
            <td><span class="c-format-cell__category">Concert</span></td>
            <td class="c-torrent-row__size">4.5 GiB</td>
            <td><a class="user-tag__link">uploader1</a></td>
            <td>
              <span class="c-stat-triple__item--seeders"><span class="c-stat-triple__value">12</span></span>
              <span class="c-stat-triple__item--leechers"><span class="c-stat-triple__value">3</span></span>
              <span class="c-stat-triple__item--completed"><span class="c-stat-triple__value">45</span></span>
            </td>
          </tr>
        </tbody>
      </table>`;
    const doc = makeDoc(html, "https://concertos.live/torrents?page=1");
    const site = new Concertos(decodeMeta(concertosMeta));
    const { torrents } = await site.transformListPage(doc);

    expect(torrents).toHaveLength(1);
    expect(String(torrents[0].id)).toBe("9001");
    expect(torrents[0].title).toBe("Live Concert 2025 1080p");
    expect(torrents[0].url).toBe("https://concertos.live/torrents/9001");
    expect(torrents[0].link).toBe("https://concertos.live/torrents/download/9001");
    expect(torrents[0].seeders).toBe(12);
    expect(torrents[0].leechers).toBe(3);
    expect(torrents[0].completed).toBe(45);
  });

  it("F0228 (desitorrents): enforces API token auth, parses JSON promotions, and keeps HTML /torrents list working", async () => {
    const meta = decodeMeta(desitorrentsMeta);
    const siteNoToken = new DesiTorrents(meta);
    await expect(siteNoToken.request({ url: "/api/v1/torrents/filter" })).rejects.toBeInstanceOf(NoUserInputError);

    // Non-API requests do not require API token
    mocks.request.mockImplementation(async (cfg: any) => okResponse(cfg, "<html></html>"));
    await expect(siteNoToken.request({ url: "/users/alice" }, false)).resolves.toBeDefined();

    // API requests attach Bearer token
    const siteWithToken = new DesiTorrents(meta, { inputSetting: { token: "secret-key" } });
    await siteWithToken.request({ url: "/api/v1/torrents/filter" }, false);
    const apiCallCfg = mocks.request.mock.calls.at(-1)![0];
    expect(apiCallCfg.headers.Authorization).toBe("Bearer secret-key");
    expect(apiCallCfg.headers.Accept).toBe("application/json");

    // JSON API search rows parse featured, freeleech, double_upload, internal, and external IDs
    const apiPayload = {
      data: [
        {
          id: 101,
          attributes: {
            name: "Featured Internal Release",
            download_link: "https://torrent.desi/torrents/download/101",
            category_id: 1,
            size: 2147483648,
            created_at: "2025-01-10T10:00:00Z",
            uploader: { username: "desi_up" },
            seeders: 20,
            leechers: 2,
            times_completed: 80,
            imdb_id: "1234567",
            tmdb_id: 9876,
            featured: true,
            freeleech: "0%",
            double_upload: false,
            internal: true,
          },
        },
        {
          id: 102,
          name: "Half Free Double Upload",
          download_link: "https://torrent.desi/torrents/download/102",
          category_id: 2,
          size: 1073741824,
          created_at: "2025-01-11T10:00:00Z",
          seeders: 5,
          leechers: 1,
          times_completed: 10,
          featured: false,
          freeleech: 50,
          double_upload: true,
          internal: false,
        },
      ],
    };
    const apiTorrents = await siteWithToken.transformSearchPage(apiPayload, {
      searchEntry: meta.search!,
    });
    expect(apiTorrents).toHaveLength(2);
    expect(apiTorrents[0].category).toBe("电影");
    expect(apiTorrents[0].ext_imdb).toBe("tt1234567");
    expect(apiTorrents[0].ext_tmdb).toBe(9876);
    // featured 仅首页精选徽章，不覆盖计费系数（计费只看 freeleech 与 double_upload）
    expect(apiTorrents[0].downloadVolumeFactor).toBe(1);
    expect(apiTorrents[0].uploadVolumeFactor).toBe(1);
    expect(apiTorrents[0].tags?.map((t) => t.name)).toEqual(expect.arrayContaining(["精选", "官方"]));
    expect(apiTorrents[0].tags?.map((t) => t.name)).not.toContain("2xFree");

    expect(apiTorrents[1].category).toBe("剧集");
    expect(apiTorrents[1].downloadVolumeFactor).toBe(0.5);
    expect(apiTorrents[1].uploadVolumeFactor).toBe(2);
    expect(apiTorrents[1].tags?.map((t) => t.name)).toEqual(expect.arrayContaining(["2x50%"]));

    // /api/v1/user 获取核心用户信息，资料页失败时优雅降级不报错
    mocks.request.mockImplementation(async (cfg: any) => {
      if (cfg.url === "/api/v1/user") {
        return okResponse(cfg, {
          username: "desi_user",
          group: "PowerUser",
          uploaded: "2.5 TiB",
          downloaded: "500 GiB",
          ratio: "5.12",
          buffer: "2 TiB",
          seeding: 42,
          leeching: 1,
          seedbonus: "1234.5",
          hit_and_runs: 0,
        });
      }
      throw new Error("profile page 500");
    });
    const userInfo = await siteWithToken.getUserInfoResult();
    expect(userInfo.status).toBe(EResultParseStatus.success);
    expect(userInfo.name).toBe("desi_user");
    expect(userInfo.levelName).toBe("PowerUser");
    expect(userInfo.levelId).toBe(2);
    expect(userInfo.bonus).toBe(1234.5);
    expect(userInfo.seeding).toBe(42);
    expect(userInfo.leeching).toBe(1);

    // HTML /torrents list page still uses Unit3D HTML selectors
    const htmlList = `
      <div class="torrent-search--list__results">
        <table>
          <tbody>
            <tr class="torrent-search--list__row">
              <td><a class="torrent-search--list__name" href="/torrents/555">HTML Row Movie</a></td>
              <td><a href="/torrents/download/555">DL</a></td>
              <td class="torrent-search--list__size"><span>1.5 GiB</span></td>
              <td class="torrent-search--list__seeders"><a href="#">9</a></td>
              <td class="torrent-search--list__leechers"><a href="#">1</a></td>
              <td class="torrent-search--list__completed"><a href="#">30</a></td>
            </tr>
          </tbody>
        </table>
      </div>`;
    const listDoc = makeDoc(htmlList, "https://torrent.desi/torrents");
    const { torrents: htmlTorrents } = await siteWithToken.transformListPage(listDoc);
    expect(htmlTorrents).toHaveLength(1);
    expect(htmlTorrents[0].title).toBe("HTML Row Movie");
    expect(htmlTorrents[0].url).toBe("https://torrent.desi/torrents/555");
  });
});

describe("W13_site_defs_1 Verified Medium findings", () => {
  it("F0197 & F0205 (animez): increments hitCounter on valid profile HTML, rejects empty page, and fixes Member OR requirement", async () => {
    const meta = decodeMeta(animezMeta);
    const profileHtml = `<!doctype html><html><head><title>alice - AnimeZ</title></head><body>
      <main><div><div><div><div><div><div><div>
        <div>alice</div>
        <div><span class="badge badge-sm">Member</span></div>
      </div></div></div></div></div></div></div></main>
      <div class="datagrid-item"><div class="datagrid-title">Uploaded</div><div class="datagrid-content">10 GiB</div></div>
      <div class="datagrid-item"><div class="datagrid-title">Downloaded</div><div class="datagrid-content">2 GiB</div></div>
      <div class="datagrid-item"><div class="datagrid-title">Ratio</div><div class="datagrid-content">5.00</div></div>
      <div class="datagrid-item"><div class="datagrid-title">Bonus Points</div><div class="datagrid-content">123.4</div></div>
      <div class="datagrid-item"><div class="datagrid-title">Seeding</div><div class="datagrid-content">0</div></div>
      <div class="datagrid-item"><div class="datagrid-title">Leeching</div><div class="datagrid-content">0</div></div>
      <div class="datagrid-item"><div class="datagrid-title">Uploads</div><div class="datagrid-content">1</div></div>
      <div class="datagrid-item"><div class="datagrid-title">Member Since</div><div class="datagrid-content">January 01, 2024</div></div>
    </body></html>`;

    mocks.request.mockImplementation(async (cfg: any) => {
      if (String(cfg.url).includes("/profile/alice")) {
        return okResponse(cfg, makeFullDoc(profileHtml, "https://animez.to/profile/alice"));
      }
      return okResponse(cfg, makeDoc("<div></div>", "https://animez.to/"));
    });

    const site = new AnimeZ(meta, { inputSetting: { username: "alice" } });
    const info = await site.getUserInfoResult();
    expect(info.status).toBe(EResultParseStatus.success);
    expect(info.name).toBe("alice");
    expect(info.levelName).toBe("Member");
    expect(info.bonus).toBe(123.4);

    // Non-profile / error HTML without " - " in title must not fabricate hits
    mocks.request.mockImplementation(async (cfg: any) =>
      okResponse(cfg, makeFullDoc("<html><head><title>404 Not Found</title></head><body>Oops</body></html>")),
    );
    const badInfo = await site.getUserInfoResult();
    expect(badInfo.status).toBe(EResultParseStatus.parseError);

    // F0205: Member requires (uploaded >= 5GB AND ratio >= 1) OR (interval >= P1W)
    const now = Date.now();
    const tenDaysAgo = now - 10 * 24 * 3600 * 1000;
    const oneDayAgo = now - 1 * 24 * 3600 * 1000;
    // Satisfied by tenure alone (0 upload, 10 days tenure)
    expect(
      guessUserLevelId(
        { uploaded: 0, downloaded: 0, ratio: 0, joinTime: tenDaysAgo, updateAt: now } as any,
        meta.levelRequirements!,
      ),
    ).toBe(3);
    // Satisfied by upload+ratio alone (10GB upload, ratio 2, 1 day tenure)
    expect(
      guessUserLevelId(
        { uploaded: 10 * 1024 ** 3, downloaded: 5 * 1024 ** 3, ratio: 2, joinTime: oneDayAgo, updateAt: now } as any,
        meta.levelRequirements!,
      ),
    ).toBe(3);
    // Fails both branches (1GB upload, ratio 0.5, 1 day tenure)
    expect(
      guessUserLevelId(
        { uploaded: 1 * 1024 ** 3, downloaded: 2 * 1024 ** 3, ratio: 0.5, joinTime: oneDayAgo, updateAt: now } as any,
        meta.levelRequirements!,
      ),
    ).toBeLessThan(3);
  });

  it("F0222 (c411): maps 401/403 ServerError to noUserInput and 500/NetworkError via classifySiteError with statusMsg", async () => {
    const site = new C411(decodeMeta(c411Meta), { inputSetting: { apikey: "test-key" } });

    // HTTP 401 -> AbstractBittorrentSite.request wraps into ServerError("Network Error: 401 ...")
    mocks.request.mockImplementationOnce(async (cfg: any) => okResponse(cfg, { error: "unauthorized" }, 401));
    const res401 = await site.getUserInfoResult();
    expect(res401.status).toBe(EResultParseStatus.noUserInput);
    expect(res401.statusMsg).toBeTruthy();

    // HTTP 403 -> noUserInput
    mocks.request.mockImplementationOnce(async (cfg: any) => okResponse(cfg, { error: "forbidden" }, 403));
    const res403 = await site.getUserInfoResult();
    expect(res403.status).toBe(EResultParseStatus.noUserInput);
    expect(res403.statusMsg).toBeTruthy();

    // HTTP 500 -> unknownError (not noUserInput) with statusMsg
    mocks.request.mockImplementationOnce(async (cfg: any) => okResponse(cfg, { error: "boom" }, 500));
    const res500 = await site.getUserInfoResult();
    expect(res500.status).toBe(EResultParseStatus.unknownError);
    expect(res500.statusMsg).toBeTruthy();

    // NetworkError -> unknownError with statusMsg
    mocks.request.mockRejectedValueOnce(new NetworkError("ECONNRESET"));
    const resNet = await site.getUserInfoResult();
    expect(resNet.status).toBe(EResultParseStatus.unknownError);
    expect(resNet.statusMsg).toBeTruthy();
  });
});

describe("W13_site_defs_1 Medium_Secondary & Low findings", () => {
  it("F0199 & F0200 (abtorrents): tags tr.freeleech_color as Free and preserves downloadLinkAppendix without mutating torrent", async () => {
    const meta = decodeMeta(abtorrentsMeta);
    const site = new ABTorrents(meta, {
      url: "https://usefultrash.net/",
      downloadLinkAppendix: "&passkey=xyz",
    });

    const doc = makeDoc(`
      <table class="browse table striped">
        <tbody>
          <tr class="freeleech_color">
            <td><a href="details.php?id=77">Book Title</a></td>
            <td><a href="download.php?torrent=77">DL</a></td>
          </tr>
        </tbody>
      </table>`);
    const torrents = await site.transformSearchPage(doc, { searchEntry: meta.search! });
    expect(torrents).toHaveLength(1);
    expect(torrents[0].tags?.some((t) => t.name === "Free")).toBe(true);

    const inputTorrent: any = { id: 77, link: undefined };
    const dlLink = await site.getTorrentDownloadLink(inputTorrent);
    expect(dlLink).toBe("https://usefultrash.net/download.php?torrent=77&passkey=xyz");
    expect(inputTorrent.link).toBeUndefined();
  });

  it("F0202, F0203, F0204 (acgrip, animetosho, 1337x): list urlPatterns match expected query/path URLs", () => {
    expect(matchesAnyPattern(acgripMeta.list![0].urlPattern, "https://acg.rip/?term=frieren")).toBe(true);
    expect(matchesAnyPattern(animetoshoMeta.list![0].urlPattern, "https://animetosho.org/?filter=1")).toBe(true);
    expect(
      matchesAnyPattern(
        x1337Meta.list![0].urlPattern,
        "https://example.invalid/sort-category-search/matrix/Movies/seeders/desc/1/",
      ),
    ).toBe(true);
  });

  it("F0201 (alpharatio): only matches tvmaze.<digits> and ignores bare numeric tags", async () => {
    const meta = decodeMeta(alpharatioMeta);
    mocks.request.mockImplementation(async (cfg: any) =>
      okResponse(cfg, { status: "success", response: { authkey: "ak", passkey: "pk" } }),
    );
    const site = new AlphaRatio(meta);
    // AlphaRatio overrides transformUnGroupTorrent (ungrouped browse results without `torrents` array)
    const payload = {
      status: "success",
      response: {
        results: [
          {
            groupId: 1,
            torrentId: 11,
            groupName: "Show A",
            tags: ["2024", "1080p", "tvmaze.12345"],
            groupTime: "2024-01-01 00:00:00",
            size: 1000,
            seeders: 1,
            leechers: 0,
            snatches: 2,
          },
          {
            groupId: 2,
            torrentId: 22,
            groupName: "Movie B",
            tags: ["2024", "720p"],
            groupTime: "2024-01-01 00:00:00",
            size: 1000,
            seeders: 1,
            leechers: 0,
            snatches: 2,
          },
        ],
      },
    };
    const torrents = await site.transformSearchPage(payload as any, { searchEntry: meta.search! });
    expect(torrents).toHaveLength(2);
    expect(torrents[0].ext_tvmaze).toBe("12345");
    expect(torrents[1].ext_tvmaze).toBeUndefined();
  });

  it("F0206 & F0207 (animebytes): reuses cached passkey with empty username and guards null Groups/Torrents/EditionData", async () => {
    const meta = decodeMeta(animebytesMeta);
    const site = new AnimeBytes(meta);
    mocks.retrieve.mockResolvedValueOnce({
      username: "",
      passkey: "cached-pk",
      expiry: Date.now() + 60_000,
    });

    const base = await (site as any).getBaseUserInfo();
    expect(base.passkey).toBe("cached-pk");
    expect(mocks.request).not.toHaveBeenCalled();

    // F0207: null/missing Groups and Torrents / EditionData do not throw
    expect(await site.transformSearchPage({ Groups: null } as any, { searchEntry: meta.search! })).toEqual([]);
    const partial = await site.transformSearchPage(
      {
        Groups: [
          { ID: 1, FullName: "Test Anime", Torrents: null },
          {
            ID: 2,
            FullName: "Valid Anime",
            CategoryName: "Anime",
            Torrents: [
              {
                ID: 201,
                Link: "https://animebytes.tv/dl/201",
                Property: "BD | 1080p",
                UploadTime: "2024-01-01 00:00:00",
                Size: 5000,
                Seeders: 3,
                Leechers: 1,
                Snatched: 10,
                EditionData: undefined,
              },
            ],
          },
        ],
      } as any,
      { searchEntry: meta.search! },
    );
    expect(partial).toHaveLength(1);
    expect(partial[0].id).toBe(201);
  });

  it("F0209, F0210, F0211, F0212 (beyondhd): prefers fresh id/name, parses numeric fields, omits bonusPerHour on details, drops comments N/A", async () => {
    const meta = decodeMeta(beyondhdMeta);
    expect(meta.search!.selectors!.comments).toBeUndefined();

    const homeHtml = `<!doctype html><html><head><meta name="secret-id" content="fresh123" /></head><body>
      <img class="beta-image-avatar" title="freshUser" />
    </body></html>`;
    const detailsHtml = `
      <ul id="beta-stats">
        <li><a href="#"><i class="fas fa-arrow-up"></i> 100 GiB</a></li>
        <li><a href="#"><i class="fas fa-arrow-down"></i> 25 GiB</a></li>
      </ul>
      <div class="button-right">
        <div class="bhd-block"></div>
        <div class="bhd-block"><span class="bhd-tidbit-icon">1,234</span></div>
        <div class="bhd-block"></div>
        <div class="bhd-block"><span class="bhd-tidbit-icon">5,678</span></div>
      </div>
      <table>
        <tr><td class="bhd-user-left">Real Ratio</td><td><span class="badge-user">2.75</span></td></tr>
      </table>
      <div class="panel-body no-padding"><div class="hd-table"><div><span class="class-bold">999</span></div></div></div>`;
    const bpHtml = `<div class="panel-body no-padding"><div class="hd-table"><div><span class="class-bold">42.5</span></div></div></div>`;

    mocks.request.mockImplementation(async (cfg: any) => {
      if (cfg.url === "/") return okResponse(cfg, makeFullDoc(homeHtml, "https://beyond-hd.me/"));
      if (String(cfg.url).includes("freshUser.fresh123")) {
        return okResponse(cfg, makeDoc(detailsHtml, "https://beyond-hd.me/users/freshUser.fresh123"));
      }
      if (cfg.url === "/bp") return okResponse(cfg, makeDoc(bpHtml, "https://beyond-hd.me/bp"));
      return okResponse(cfg, makeDoc(""));
    });

    const site = new BeyondHD(meta);
    const info = await site.getUserInfoResult({ name: "staleUser", id: "staleId" });
    expect(info.status).toBe(EResultParseStatus.success);
    expect(info.name).toBe("freshUser");
    expect(info.id).toBe("fresh123");
    expect(info.leeching).toBe(1234);
    expect(info.snatches).toBe(5678);
    expect(info.trueRatio).toBe(2.75);
    expect(info.bonusPerHour).toBe(42.5);
    // Unmatched fields on detailsHtml must be dropped (not empty string)
    expect(info.seedingSize).toBeUndefined();
  });

  it("F0213, F0214, F0215 (anthelion): parses UTC joinTime regardless of host TZ, handles numeric usernames, and classifies API errors", async () => {
    const meta = decodeMeta(anthelionMeta);
    const site = new Anthelion(meta, { inputSetting: { apiKey: "ant-key" } });

    // F0213: UTC parsing
    const joinTimeDoc = makeDoc(
      `<ul class="stats"><li>Joined: <span class="time" title="Apr 12 2022, 15:30 UTC">2 years ago</span></li></ul>`,
    );
    const parsedJoinTime = (site as any).getFieldData(joinTimeDoc, meta.userInfo!.selectors!.joinTime!);
    expect(parsedJoinTime).toBe(Date.UTC(2022, 3, 12, 15, 30));

    // F0214: numeric username preserved as string and sent to API
    mocks.request.mockImplementationOnce(async (cfg: any) =>
      okResponse(cfg, {
        status: "success",
        response: {
          Username: "12345",
          ID: 99,
          Uploaded: "1000",
          Downloaded: "500",
          Class: "Member",
        },
      }),
    );
    const okInfo = await site.getUserInfoResult({ name: 12345 as any });
    expect(okInfo.status).toBe(EResultParseStatus.success);
    expect(mocks.request.mock.calls[0][0].params.user).toBe("12345");

    // F0215: API network failure -> unknownError + statusMsg
    mocks.request.mockRejectedValueOnce(new NetworkError("timeout"));
    const errInfo = await site.getUserInfoResult({ name: "12345" });
    expect(errInfo.status).toBe(EResultParseStatus.unknownError);
    expect(errInfo.statusMsg).toBeTruthy();
  });

  it("F0216 (audiobookbay): skips recursive page 2 fetch on /page/2/ and preserves query string from page 1", async () => {
    const meta = decodeMeta(audiobookbayMeta);
    const site = new AudioBookBay(meta);
    const postHtml = `
      <div class="post">
        <div class="postTitle"><h2><a href="/abss/book-1/">Book One</a></h2></div>
        <div class="postContent"><p>File Size: 500 MBs</p></div>
      </div>
      <div class="navigation"><a href="/page/2/?s=dune">Next</a></div>`;

    // Already on /page/2/ -> must not fetch again
    const page2Doc = makeDoc(postHtml, "https://audiobookbay.lu/page/2/?s=dune");
    const resPage2 = await site.transformSearchPage(page2Doc, { searchEntry: meta.search! });
    expect(resPage2).toHaveLength(1);
    expect(mocks.request).not.toHaveBeenCalled();

    // On page 1 with undefined requestConfig.params -> preserves ?s=dune when fetching page 2
    mocks.request.mockImplementationOnce(async (cfg: any) =>
      okResponse(
        cfg,
        makeDoc(
          `<div class="post"><div class="postTitle"><h2><a href="/abss/book-2/">Book Two</a></h2></div></div>`,
          "https://audiobookbay.lu/page/2/?s=dune",
        ),
      ),
    );
    const page1Doc = makeDoc(postHtml, "https://audiobookbay.lu/?s=dune");
    const resPage1 = await site.transformSearchPage(page1Doc, {
      searchEntry: { ...meta.search!, requestConfig: { url: "/" } },
    });
    expect(resPage1).toHaveLength(2);
    expect(mocks.request).toHaveBeenCalledTimes(1);
    expect(mocks.request.mock.calls[0][0].url).toBe("/page/2/?s=dune");
  });

  it("F0217, F0218, F0219 (bibliotik): keeps readable category, drops bonus N/A, and guards invalid data-bytecount", async () => {
    const meta = decodeMeta(bibliotikMeta);
    // F0218
    expect((meta.userInfo!.process![1].selectors as any).bonus).toBeUndefined();

    const site = new Bibliotik(meta);
    // F0217 + F0219 (search)
    const searchDoc = makeDoc(`
      <table id="torrents_table">
        <tbody>
          <tr class="torrent">
            <td><div title="Ebooks"></div></td>
            <td class="title"><a href="/torrents/123">Sample Book</a></td>
            <td><a href="/torrents/123/download">DL</a></td>
            <td class="t_files_size_added"><span data-bytecount="">2 MiB</span></td>
          </tr>
        </tbody>
      </table>`);
    const torrents = await site.transformSearchPage(searchDoc, { searchEntry: meta.search! });
    expect(torrents).toHaveLength(1);
    expect(torrents[0].category).toBe("Ebooks");
    expect(torrents[0].size).toBe(2 * 1024 * 1024);

    // F0219 (seedingSize)
    mocks.request.mockImplementationOnce(async (cfg: any) =>
      okResponse(
        cfg,
        makeDoc(`
          <table id="torrents_table">
            <tbody>
              <tr class="torrent"><td class="title">A</td><td class="t_files_size_added"><span data-bytecount="1000">1000 B</span></td></tr>
              <tr class="torrent"><td class="title">B</td><td class="t_files_size_added"><span data-bytecount="">1 KiB</span></td></tr>
              <tr class="torrent"><td class="title">C</td><td class="t_files_size_added"><span data-bytecount="abc">bad</span></td></tr>
            </tbody>
          </table>`),
      ),
    );
    const seedInfo = await (site as any).parseUserInfoForSeedingStatus({ id: 42 });
    expect(Number.isFinite(seedInfo.seedingSize)).toBe(true);
    expect(seedInfo.seedingSize).toBe(1000 + 1024);
  });

  it("F0220 (bakabt): handles missing .added, invalid timestamp, and case-insensitive Yesterday cleanly", () => {
    const meta = decodeMeta(bakabtMeta);
    const site = new BittorrentSite(meta);
    const timeSelectors = { time: meta.search!.selectors!.time! };

    const missingDoc = makeDoc(`<table><tr class="torrent"><td>no date cell</td></tr></table>`);
    const missingRes = (site as any).getFieldsData(missingDoc.querySelector("tr")!, timeSelectors, ["time"], {
      dropEmptyMisses: true,
    });
    expect(missingRes.time).toBeUndefined();

    const yesterdayDoc = makeDoc(
      `<table><tr class="torrent"><td class="added" data-timestamp="invalid">Yesterday</td></tr></table>`,
    );
    const yVal = (site as any).getFieldData(yesterdayDoc.querySelector("tr")!, timeSelectors.time);
    expect(typeof yVal).toBe("number");
    expect(Number.isFinite(yVal)).toBe(true);

    const garbageDoc = makeDoc(`<table><tr class="torrent"><td class="added">Not A Date</td></tr></table>`);
    const garbageRes = (site as any).getFieldsData(garbageDoc.querySelector("tr")!, timeSelectors, ["time"], {
      dropEmptyMisses: true,
    });
    expect(garbageRes.time).toBeUndefined();
  });

  it("F0221 (blueroms): allows safe magnet/http links and rejects javascript: or invalid base64", async () => {
    const meta = decodeMeta(blueromsMeta);
    const site = new BlueRoms(meta);
    const magnet = "magnet:?xt=urn:btih:1234567890abcdef";

    mocks.request.mockImplementationOnce(async (cfg: any) =>
      okResponse(cfg, makeDoc(`<button id="magnet-button" data-link="${btoa(magnet)}"></button>`)),
    );
    const ok = await site.getTorrentDownloadLink({ link: "/download/tok1" } as any);
    expect(ok).toBe(magnet);

    mocks.request.mockImplementationOnce(async (cfg: any) =>
      okResponse(cfg, makeDoc(`<button id="magnet-button" data-link="${btoa("javascript:alert(1)")}"></button>`)),
    );
    await expect(site.getTorrentDownloadLink({ link: "/download/tok2" } as any)).rejects.toThrow();

    mocks.request.mockImplementationOnce(async (cfg: any) =>
      okResponse(cfg, makeDoc(`<button id="magnet-button" data-link="!!!not-base64!!!"></button>`)),
    );
    await expect(site.getTorrentDownloadLink({ link: "/download/tok3" } as any)).rejects.toThrow();
  });

  it("F0224 (concertos): merges partial searchEntry.requestConfig with htmlSearch when apikey is unset", async () => {
    mocks.request.mockImplementationOnce(async (cfg: any) => okResponse(cfg, makeDoc("<table></table>")));
    const site = new Concertos(decodeMeta(concertosMeta));
    await site.getSearchResult("rock", { requestConfig: { params: { page: 2 } } });
    const reqCfg = mocks.request.mock.calls[0][0];
    expect(reqCfg.url).toBe("/torrents/");
    expect(reqCfg.params.page).toBe(2);
    expect(reqCfg.params.name).toBe("rock");
  });

  it("F0225 (colapt): guards empty versions and zero denominator while preserving WIP /api/v1/me/stats selectors", async () => {
    const meta = decodeMeta(colaptMeta);
    const site = new ColaPT(meta);

    // Direct guard check on empty versions array
    const emptyRes = (site as any).parseTorrentRowForTags({}, { versions: [] }, { searchEntry: meta.search! });
    expect(emptyRes.downloadVolumeFactor).toBeUndefined();

    const apiPayload = {
      items: [
        {
          media: { category: "movie" },
          versions: [
            {
              id: 2,
              release_name: "Zero Denom",
              published_at: "2025-01-01T00:00:00Z",
              size_bytes: 1000,
              seeders: 1,
              leechers: 0,
              completions: 5,
              promotion: { download: { num: 1, den: 0 }, upload: { num: 2, den: 0 } },
            },
          ],
        },
        {
          media: { category: "movie" },
          versions: [
            {
              id: 3,
              release_name: "Free Version",
              published_at: "2025-01-01T00:00:00Z",
              size_bytes: 2000,
              seeders: 3,
              leechers: 1,
              completions: 10,
              promotion: { download: { num: 0, den: 1 }, upload: { num: 2, den: 1 } },
            },
          ],
        },
      ],
    };
    const torrents = await site.transformSearchPage(apiPayload as any, { searchEntry: meta.search! });
    expect(torrents).toHaveLength(2);
    expect(torrents[0].downloadVolumeFactor).toBeUndefined();
    expect(torrents[1].downloadVolumeFactor).toBe(0);
    expect(torrents[1].uploadVolumeFactor).toBe(2);

    // Pre-existing WIP selectors preserved
    const statsProcess = meta.userInfo!.process!.find((p) => p.requestConfig?.url === "/api/v1/me/stats");
    expect(statsProcess?.selectors?.uploaded).toEqual({ selector: "billed_uploaded_bytes" });
    expect(statsProcess?.selectors?.downloaded).toEqual({ selector: "billed_downloaded_bytes" });
    expect(statsProcess?.selectors?.trueUploaded).toEqual({ selector: "raw_uploaded_bytes" });
    expect(statsProcess?.selectors?.trueDownloaded).toEqual({ selector: "raw_downloaded_bytes" });
  });

  it("F0226 (byrutor): parses Cyrillic detail size into numeric bytes", () => {
    const site = new BittorrentSite(decodeMeta(byrutorMeta));
    const doc = makeDoc(`<a class="itemdown_nottorent1" data-size="12.5 ГБ">Download</a>`);
    const size = (site as any).getFieldData(doc, byrutorMeta.detail!.selectors!.size!);
    expect(size).toBe(12.5 * 1024 ** 3);
  });

  it("F0227 (broadcasthenet): parses comma-formatted snatches count", () => {
    const site = new BittorrentSite(decodeMeta(btnMeta));
    const doc = makeDoc(`<ul class="nobullet"><li>Snatched: 1,234</li></ul>`);
    const snatches = (site as any).getFieldData(doc, btnMeta.userInfo!.selectors!.snatches!);
    expect(snatches).toBe(1234);
  });

  it("F0234 (dirtybytes): extracts id from absolute download URL and resolves link without mutating torrent", async () => {
    const meta = decodeMeta(dirtybytesMeta);
    const site = new DirtyBytes(meta);

    const detailDoc = makeDoc(`<a href="https://example.invalid/api/v1/torrents/download/98765">DL</a>`);
    expect(String((site as any).getFieldData(detailDoc, meta.detail!.selectors!.id!))).toBe("98765");

    // Successful link resolution with passkey (no mutation of input torrent)
    mocks.request.mockImplementationOnce(async (cfg: any) => okResponse(cfg, { user: { passkey: "pk999" } }));
    const inputTorrent: any = { id: 98765, url: `${site.url}torrent/98765` };
    const dl = await site.getTorrentDownloadLink(inputTorrent);
    expect(dl).toContain("/api/v1/torrents/download/98765/pk999");
    expect(inputTorrent.link).toBeUndefined();

    // Missing passkey on fresh instance rejects cleanly
    const freshSite = new DirtyBytes(meta);
    mocks.request.mockImplementationOnce(async (cfg: any) => okResponse(cfg, { user: {} }));
    await expect(freshSite.getTorrentDownloadLink({ id: 98765 } as any)).rejects.toThrow(/passkey/i);
  });

  it("F0235 (digitalcore): handles non-array bonusLog without throwing", () => {
    const meta = decodeMeta(digitalcoreMeta);
    const site = new BittorrentSite(meta);
    const query = meta.userInfo!.process![2].selectors!.bonusPerHour!;
    expect((site as any).getFieldData(null, query)).toBe(0);
    expect((site as any).getFieldData({}, query)).toBe(0);
    expect((site as any).getFieldData([{ msg: "You earned [b]240p[/b] hourly bonus" }], query)).toBe(10);
  });

  it("F0238 & F0239 (dicmusic): preserves seedingSize when bprates fails and removes encoding values from format category", async () => {
    const meta = decodeMeta(dicmusicMeta);
    // F0239
    const formatCat = meta.category!.find((c) => c.key === "format");
    expect(formatCat).toBeDefined();
    const formatValues = formatCat!.options.map((o) => o.value);
    expect(formatValues).not.toContain("Lossless");
    expect(formatValues).not.toContain("24bit Lossless");

    // F0238
    mocks.request.mockImplementation(async (cfg: any) => {
      if (String(cfg.url).includes("/torrents.php")) {
        return okResponse(
          cfg,
          makeDoc(`
            <table class="torrent_table">
              <tr class="colhead"><td>Title</td><td><a href="?order=size">Size</a></td></tr>
              <tr class="torrent"><td>Album</td><td>1.5 GiB</td></tr>
            </table>`),
        );
      }
      if (String(cfg.url).includes("/bonus.php")) {
        throw new NetworkError("bprates down");
      }
      return okResponse(cfg, makeDoc(""));
    });

    const site = new DICMusic(meta);
    const seedInfo = await (site as any).getSeedingSize(42, 0);
    expect(seedInfo.seedingSize).toBe(1.5 * 1024 ** 3);
  });
});
