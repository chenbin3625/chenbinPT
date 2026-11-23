import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EResultParseStatus,
  ETorrentStatus,
  NoUserInputError,
  type ISiteMetadata,
  type ITorrent,
} from "@ptd/site/types";
import { rot13 } from "@ptd/site/utils/html.ts";

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

const makeDoc = (html: string, title = "w14-site-defs-2"): Document => {
  const doc = document.implementation.createHTMLDocument(title);
  doc.title = title;
  doc.body.innerHTML = html;
  return doc;
};

/** Decode rot13-obfuscated URLs just like the production site loader does */
const decodeMeta = (meta: ISiteMetadata): ISiteMetadata => ({
  ...meta,
  urls: meta.urls.map((u) => (/^https?:\/\//i.test(u) ? u : rot13(u))) as ISiteMetadata["urls"],
});

describe("W14_site_defs_2 regression fixes", () => {
  beforeEach(() => {
    mocks.request.mockReset();
    mocks.isCloudflareBlocked.mockReturnValue(false);
    mocks.sleep.mockClear();
    mocks.logMessage.mockClear();
    mocks.retrieve.mockReset().mockResolvedValue(null);
    mocks.store.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("F0229 & F0233: fappaizuri.ts", () => {
    it("strips downloadLinkAppendix on detail request, normalizes relative link, re-applies appendix, and throws on empty link", async () => {
      const { default: Fappaizuri, siteMetadata } = await import("@ptd/site/definitions/fappaizuri.ts");
      const site = new Fappaizuri(decodeMeta(siteMetadata), { downloadLinkAppendix: "&ssl=1" } as any);
      const requestedConfigs: any[] = [];
      site.request = vi.fn(async (cfg: any) => {
        requestedConfigs.push(cfg);
        return {
          data: makeDoc(`<a href="download.php?id=99&key=abc">Download</a>`),
          config: cfg,
        } as any;
      });

      const torrent = {
        site: "fappaizuri",
        id: "99",
        title: "Sample",
        url: `${site.url}torrents-details.php?id=99`,
        link: `${site.url}torrents-details.php?id=99`,
      } as ITorrent;

      const resolved = await site.getTorrentDownloadLink(torrent);
      expect(requestedConfigs[0].url).toBe(`${site.url}torrents-details.php?id=99`);
      expect(resolved).toBe(`${site.url}download.php?id=99&key=abc&ssl=1`);
      expect(torrent.link).toBe(`${site.url}torrents-details.php?id=99`);

      // Empty detail link must throw instead of returning ""
      site.request = vi.fn(async (cfg: any) => ({ data: makeDoc(`<div>no link</div>`), config: cfg }) as any);
      await expect(site.getTorrentDownloadLink(torrent)).rejects.toThrow(/cannot parse torrent download link/i);
    });

    it("honors pickLast, extracts id, and preserves prior values on empty misses in getUserInfoResult", async () => {
      const { default: Fappaizuri, siteMetadata } = await import("@ptd/site/definitions/fappaizuri.ts");
      const site = new Fappaizuri(decodeMeta(siteMetadata), {} as any);
      site.request = vi.fn(
        async (cfg: any) =>
          ({
            data: makeDoc(
              `
            <table>
              <tr><td class="prof-lbl">Uploaded:</td><td>10.00 GB</td></tr>
              <tr><td class="prof-lbl">Downloaded:</td><td>2.00 GB</td></tr>
            </table>
          `,
              "Account Details",
            ),
            config: cfg,
          }) as any,
      );

      // Page omits id and name — pickLast must preserve lastUserInfo.id and lastUserInfo.name without empty overwrite
      const info = await site.getUserInfoResult({ id: 1234, name: "alice" } as any);
      expect(info.status).toBe(EResultParseStatus.success);
      expect(info.id).toBe(1234);
      expect(info.name).toBe("alice");
      expect(info.uploaded).toBeGreaterThan(0);
      expect(info.downloaded).toBeGreaterThan(0);
    });
  });

  describe("F0243 & F0244: gazellegames.ts", () => {
    it("scopes X-API-Key and responseType=json to /api.php, preserves HTML document requests, and blocks untrusted hosts", async () => {
      const { default: GazelleGames, siteMetadata } = await import("@ptd/site/definitions/gazellegames.ts");
      const site = new GazelleGames(decodeMeta(siteMetadata), { inputSetting: { token: "gg-secret" } } as any);

      mocks.request.mockImplementation(async (cfg: any) => ({
        status: 200,
        data: cfg.responseType === "json" ? { status: "success", response: {} } : makeDoc(`<html></html>`),
        config: cfg,
        headers: {},
        request: { responseURL: `${site.url}${String(cfg.url ?? "").replace(/^\//, "")}` },
      }));

      // HTML request should keep responseType: "document" and NOT inject X-API-Key
      const htmlCfg = {
        url: "/torrents.php",
        params: { type: "seeding", userid: 1 },
        responseType: "document" as const,
      };
      await site.request(htmlCfg, false);
      const sentHtml = mocks.request.mock.calls[0][0];
      expect(sentHtml.responseType).toBe("document");
      expect(sentHtml.headers?.["X-API-Key"]).toBeUndefined();

      // API request should inject X-API-Key and responseType: "json" without mutating caller config
      const apiCfg = { url: "/api.php", params: { request: "user" } };
      await site.request(apiCfg, false);
      const sentApi = mocks.request.mock.calls[1][0];
      expect(sentApi.responseType).toBe("json");
      expect(sentApi.headers?.["X-API-Key"]).toBe("gg-secret");
      expect((apiCfg as any).headers).toBeUndefined();

      // Missing token on /api.php throws NoUserInputError
      const noTokenSite = new GazelleGames(decodeMeta(siteMetadata), { inputSetting: {} } as any);
      await expect(noTokenSite.request({ url: "/api.php", params: { request: "user" } }, false)).rejects.toBeInstanceOf(
        NoUserInputError,
      );

      // Untrusted host is blocked
      await expect(site.request({ url: "https://evil.example/api.php" }, false)).rejects.toThrow(
        /untrusted|outside site host/i,
      );
    });

    it("handles missing or empty group.Artists without throwing in transformSearchPage", async () => {
      const { default: GazelleGames, siteMetadata } = await import("@ptd/site/definitions/gazellegames.ts");
      const site = new GazelleGames(decodeMeta(siteMetadata), { inputSetting: { token: "gg-secret" } } as any);
      (site as any).requestApiInfo = vi.fn(async () => ({
        status: "success",
        response: { authkey: "ak", passkey: "pk", id: 1, username: "u" },
      }));

      const doc = {
        status: "success",
        response: {
          "100": {
            ID: 100,
            Name: "No Artist Game",
            Year: 2024,
            Artists: null,
            Torrents: {
              "200": {
                ID: 200,
                ReleaseTitle: "No Artist Game",
                ReleaseType: "Full Game",
                Format: "ISO",
                Encoding: "Lossless",
                Region: "USA",
                Language: "English",
                Size: 1024,
                Snatched: 5,
                Seeders: 3,
                Leechers: 1,
                Time: "2024-01-01 00:00:00",
                FreeTorrent: "0",
                NeutralTorrent: "0",
              },
            },
          },
        },
      };

      const torrents = await site.transformSearchPage(doc as any, {
        searchEntry: siteMetadata.search,
        requestConfig: siteMetadata.search!.requestConfig,
      });
      expect(torrents).toHaveLength(1);
      expect(torrents[0].title).toContain("No Artist Game");
      expect(torrents[0].title.startsWith(" -")).toBe(false);
    });
  });

  describe("F0241 & F0242: generationfree.ts", () => {
    it("scopes Bearer/Accept headers and NoUserInputError to /api/ routes and delegates DOM tag parsing", async () => {
      const { default: GenerationFree, siteMetadata } = await import("@ptd/site/definitions/generationfree.ts");
      const site = new GenerationFree(decodeMeta(siteMetadata), { inputSetting: { token: "gf-key" } } as any);

      mocks.request.mockImplementation(async (cfg: any) => ({
        status: 200,
        data: makeDoc(`<html></html>`),
        config: cfg,
        headers: {},
        request: { responseURL: `${site.url}${String(cfg.url ?? "").replace(/^\//, "")}` },
      }));

      // HTML page request must NOT get Bearer token or Accept: application/json
      await site.request({ url: "/users/alice", responseType: "document" }, false);
      const htmlReq = mocks.request.mock.calls[0][0];
      expect(htmlReq.headers?.Authorization).toBeUndefined();
      expect(htmlReq.headers?.Accept).toBeUndefined();

      // API request gets Bearer + Accept without mutating original config
      const apiCfg = { url: "/api/torrents/filter", responseType: "json" as const };
      await site.request(apiCfg, false);
      const apiReq = mocks.request.mock.calls[1][0];
      expect(apiReq.headers?.Authorization).toBe("Bearer gf-key");
      expect(apiReq.headers?.Accept).toBe("application/json");
      expect((apiCfg as any).headers).toBeUndefined();

      // Missing API key throws NoUserInputError on /api/
      const noKeySite = new GenerationFree(decodeMeta(siteMetadata), { inputSetting: {} } as any);
      await expect(noKeySite.request({ url: "/api/torrents/filter" }, false)).rejects.toBeInstanceOf(NoUserInputError);

      // Untrusted host is blocked
      await expect(site.request({ url: "https://evil.example/api/torrents/filter" }, false)).rejects.toThrow(
        /untrusted|outside site host/i,
      );

      // F0242: list[0] disables mergeSearchSelectors and uses DOM selectors
      expect(siteMetadata.list?.[0]?.mergeSearchSelectors).toBe(false);
      const domRow = makeDoc(
        `<table><tr class="torrent-search--list__row"><td><i class="fa-star" title="100% Freeleech"></i></td></tr></table>`,
      ).querySelector("tr")!;
      const tagged = (site as any).parseTorrentRowForTags({ tags: [] }, domRow, {
        searchEntry: siteMetadata.list![0],
      });
      expect(Array.isArray(tagged.tags)).toBe(true);
    });
  });

  describe("F0230 & F0231: dreadvault.ts", () => {
    it("scopes API headers, blocks untrusted hosts, and preserves DOM list + H&R tag", async () => {
      const { default: DreadVault, siteMetadata } = await import("@ptd/site/definitions/dreadvault.ts");
      const site = new DreadVault(decodeMeta(siteMetadata), { inputSetting: { token: "dv-key" } } as any);

      mocks.request.mockImplementation(async (cfg: any) => ({
        status: 200,
        data: makeDoc(`<html></html>`),
        config: cfg,
        headers: {},
        request: { responseURL: `${site.url}${String(cfg.url ?? "").replace(/^\//, "")}` },
      }));

      await site.request({ url: "/", responseType: "document" }, false);
      expect(mocks.request.mock.calls[0][0].headers?.Authorization).toBeUndefined();

      await site.request({ url: "/api/torrents/filter", responseType: "json" }, false);
      expect(mocks.request.mock.calls[1][0].headers?.Authorization).toBe("Bearer dv-key");
      expect(mocks.request.mock.calls[1][0].headers?.Accept).toBe("application/json");

      const noKeySite = new DreadVault(decodeMeta(siteMetadata), { inputSetting: {} } as any);
      await expect(noKeySite.request({ url: "/api/torrents/filter" }, false)).rejects.toBeInstanceOf(NoUserInputError);
      await expect(site.request({ url: "https://evil.example/api/torrents/filter" }, false)).rejects.toThrow(
        /untrusted|outside site host/i,
      );

      expect(siteMetadata.list?.[0]?.mergeSearchSelectors).toBe(false);
      const domRow = makeDoc(`<table><tr><td>Row</td></tr></table>`).querySelector("tr")!;
      const tagged = (site as any).parseTorrentRowForTags({ tags: [] }, domRow, {
        searchEntry: siteMetadata.list![0],
      });
      expect(tagged.tags?.some((t: any) => t.name === "H&R")).toBe(true);
    });
  });

  describe("F0237: dstudio.ts, F0236: dubhe.ts, F0232: eztv.ts, F0247: haidan.ts, F0240: happyfappy.ts, F0256: hdcity.ts, F0259: hdhome.ts", () => {
    it("dstudio team category enables cross append mode (F0237)", async () => {
      const { siteMetadata } = await import("@ptd/site/definitions/dstudio.ts");
      const teamCat = siteMetadata.category?.find((c) => c.key === "team");
      expect(teamCat?.cross).toEqual({ mode: "append" });
    });

    it("dubhe invites selector matches adjacent value cell for both 邀请/邀請 without outer td false match (F0236)", async () => {
      const { siteMetadata } = await import("@ptd/site/definitions/dubhe.ts");
      const { default: NexusPHP } = await import("@ptd/site/schemas/NexusPHP.ts");
      const site = new NexusPHP(decodeMeta(siteMetadata), {} as any);
      const doc = makeDoc(`
        <table>
          <tr><td>Outer 邀请 wrapper <table><tr><td class="rowhead">邀請</td><td>7</td></tr></table></td></tr>
        </table>
      `);
      const invites = (site as any).getFieldData(doc, siteMetadata.userInfo!.selectors!.invites);
      expect(invites).toBe(7);
    });

    it("eztv title filter strips trailing size suffix while keeping earlier parenthesized disambiguators (F0232)", async () => {
      const { siteMetadata } = await import("@ptd/site/definitions/eztv.ts");
      const { default: BittorrentSite } = await import("@ptd/site/schemas/AbstractBittorrentSite.ts");
      const site = new BittorrentSite(decodeMeta(siteMetadata), {} as any);
      const row = makeDoc(
        `<table><tr><td>icon</td><td><a class="epinfo" title="The Office (US) S01E01 1080p [eztv] (1.25 GB)">The Office</a></td></tr></table>`,
      ).querySelector("tr")!;
      const title = (site as any).getFieldData(row, siteMetadata.search!.selectors!.title);
      expect(title).toBe("The Office (US) S01E01 1080p");
    });

    it("haidan userdetails process includes levelId (F0247)", async () => {
      const { siteMetadata } = await import("@ptd/site/definitions/haidan.ts");
      const userDetailsStep = siteMetadata.userInfo?.process?.find((p) => p.requestConfig.url === "/userdetails.php");
      expect(userDetailsStep?.fields).toContain("levelId");
    });

    it("happyfappy preserves Luminance action=advanced alongside perPage=100 (F0240)", async () => {
      const { siteMetadata } = await import("@ptd/site/definitions/happyfappy.ts");
      expect(siteMetadata.search?.requestConfig?.params).toMatchObject({
        action: "advanced",
        perPage: 100,
      });
    });

    it("hdcity bonus selector parses comma-formatted numbers (F0256)", async () => {
      const { siteMetadata } = await import("@ptd/site/definitions/hdcity.ts");
      const { default: NexusPHP } = await import("@ptd/site/schemas/NexusPHP.ts");
      const site = new NexusPHP(decodeMeta(siteMetadata), {} as any);
      const bonusSelector = siteMetadata.userInfo!.process![0].selectors!.bonus;
      const docZh = makeDoc(`
        <div class="text_alt"></div><br />
        <div>
          <span class="text">1</span>
          <span class="text">2</span>
          <span class="text">3</span>
          <span class="text">魅力值 12,345.67</span>
        </div>
      `);
      const docEn = makeDoc(`
        <div class="text_alt"></div><br />
        <div>
          <span class="text">1</span>
          <span class="text">2</span>
          <span class="text">3</span>
          <span class="text">Karma Points 9,876.5</span>
        </div>
      `);
      expect((site as any).getFieldData(docZh, bonusSelector)).toBe(12345.67);
      expect((site as any).getFieldData(docEn, bonusSelector)).toBe(9876.5);
    });

    it("hdhome Nexus Master (id 9) has isKept: true (F0259)", async () => {
      const { siteMetadata } = await import("@ptd/site/definitions/hdhome.ts");
      const nexusMaster = siteMetadata.levelRequirements?.find((l) => l.id === 9);
      expect(nexusMaster?.name).toBe("Nexus Master");
      expect(nexusMaster?.isKept).toBe(true);
    });
  });

  describe("F0250: filelist.ts", () => {
    it("uses FileList-specific list/detail/noLoginAssert instead of NexusPHP defaults", async () => {
      const { siteMetadata } = await import("@ptd/site/definitions/filelist.ts");
      expect(siteMetadata.search?.requestConfig?.responseType).toBe("document");
      expect(siteMetadata.list?.[0]?.urlPattern).toContain("/browse\\.php");
      expect(siteMetadata.detail?.urlPattern).toContain("/details\\.php");
      const urlPatterns = siteMetadata.noLoginAssert?.urlPatterns;
      expect(Array.isArray(urlPatterns) ? urlPatterns.length : 0).toBeGreaterThan(0);
    });
  });

  describe("F0246: freejavtorrent.ts", () => {
    it("resolves relay download link without mutating torrent, blocks untrusted hosts, and appends appendix", async () => {
      const { default: FreeJAVTorrent, siteMetadata } = await import("@ptd/site/definitions/freejavtorrent.ts");
      const site = new FreeJAVTorrent(decodeMeta(siteMetadata), { downloadLinkAppendix: "&tag=1" } as any);
      const detailUrl = `${site.url}sample-123.html`;
      const torrent = { site: "freejavtorrent", id: "1", title: "Test", url: detailUrl } as ITorrent;

      site.request = vi.fn(async (cfg: any) => {
        if (cfg.url === detailUrl) {
          return { data: makeDoc(`<a class="download-button" href="/dl.php?t=1">dl</a>`), config: cfg } as any;
        }
        return {
          data: makeDoc(`<a class="download-button" href="/files/sample.torrent">file</a>`),
          config: cfg,
        } as any;
      });

      const resolved = await site.getTorrentDownloadLink(torrent);
      expect(resolved).toBe(`${site.url}files/sample.torrent&tag=1`);
      expect(torrent.link).toBeUndefined();

      // Untrusted relay link must throw
      site.request = vi.fn(
        async (cfg: any) =>
          ({
            data: makeDoc(`<a class="download-button" href="https://evil.example/steal.torrent">bad</a>`),
            config: cfg,
          }) as any,
      );
      await expect(site.getTorrentDownloadLink(torrent)).rejects.toThrow(/allowlist|outside site host/i);
    });
  });

  describe("F0249: gtnet.ts & F0248: gtru.ts & F0245: hdbits.ts", () => {
    it("gtnet clones searchEntry with securitytoken (including empty) and URL-encodes download POST config (F0249)", async () => {
      const { default: GTNet, siteMetadata } = await import("@ptd/site/definitions/gtnet.ts");
      const site = new GTNet(decodeMeta(siteMetadata), {} as any);
      const originalData = { ...siteMetadata.search!.requestConfig!.data };

      let capturedSearchConfig: any = null;
      const superProto = Object.getPrototypeOf(Object.getPrototypeOf(site));
      vi.spyOn(superProto, "getSearchResult").mockImplementation(async function (this: any, _kw: any, entry: any) {
        capturedSearchConfig = entry;
        return { status: 0, data: [] };
      });
      site.request = vi.fn(async () => ({ data: makeDoc(`<html></html>`) }) as any);

      await site.getSearchResult("test", {});
      expect(capturedSearchConfig.requestConfig.data.securitytoken).toBe("");
      expect(siteMetadata.search!.requestConfig!.data).toEqual(originalData);

      const reqCfg = await site.getTorrentDownloadRequestConfig({
        site: "gtnet",
        id: "123&extra=1",
        title: "t",
      } as ITorrent);
      expect(reqCfg.headers?.Referer).toBe(`${site.url}torrentdetails.php?torrentid=123%26extra%3D1`);
      expect(reqCfg.data).toContain("torrentid=123%26extra%3D1");
    });

    it("gtru validates torrent.id, builds encoded URL, and appends downloadLinkAppendix (F0248)", async () => {
      const { default: GTRu, siteMetadata } = await import("@ptd/site/definitions/gtru.ts");
      const site = new GTRu(decodeMeta(siteMetadata), { downloadLinkAppendix: "&ref=ptd" } as any);
      const link = await site.getTorrentDownloadLink({
        site: "gtru",
        id: "42&bad=1",
        title: "t",
      } as ITorrent);
      expect(link).toBe(`${site.url}download.php?id=42%26bad%3D1&rss=1&n=t.torrent&ref=ptd`);

      await expect(site.getTorrentDownloadLink({ site: "gtru", id: "", title: "t" } as ITorrent)).rejects.toThrow(
        /without torrent\.id/i,
      );
    });

    it("hdbits URL-encodes filename, id, and passkey in parseTorrentRowForLink (F0245)", async () => {
      const { default: HDBits, siteMetadata } = await import("@ptd/site/definitions/hdbits.ts");
      const site = new HDBits(decodeMeta(siteMetadata), { inputSetting: { passkey: "pk+a/b=c" } } as any);
      const result = (site as any).parseTorrentRowForLink({}, { id: 101, filename: "Movie #1 & [2024].torrent" }, {});
      expect(result.link).toBe(
        `/download.php/${encodeURIComponent("Movie #1 & [2024].torrent")}?id=101&passkey=${encodeURIComponent("pk+a/b=c")}`,
      );
    });
  });

  describe("F0252, F0254, F0255: hdchina.ts", () => {
    it("resolves signed download link from detail page for download.php links without mutating torrent, and throws on miss (F0252)", async () => {
      const { default: HDChina, siteMetadata } = await import("@ptd/site/definitions/hdchina.ts");
      const site = new HDChina(decodeMeta(siteMetadata), { downloadLinkAppendix: "&https=1" } as any);
      const reqUrls: string[] = [];
      site.request = vi.fn(async (cfg: any) => {
        reqUrls.push(cfg.url);
        return {
          data: makeDoc(`<a href="download.php?hash=signedhash123">Download</a>`),
          config: cfg,
        } as any;
      });

      const torrent = {
        site: "hdchina",
        id: "555",
        title: "HDC",
        link: `${site.url}download.php?id=555`,
      } as ITorrent;

      const resolved = await site.getTorrentDownloadLink(torrent);
      expect(reqUrls[0]).toBe(`${site.url}details.php?id=555`);
      expect(resolved).toBe(`${site.url}download.php?hash=signedhash123&https=1`);
      expect(torrent.link).toBe(`${site.url}download.php?id=555`);

      site.request = vi.fn(async (cfg: any) => ({ data: makeDoc(`<div>missing</div>`), config: cfg }) as any);
      await expect(site.getTorrentDownloadLink(torrent)).rejects.toThrow(/cannot parse signed torrent download link/i);
    });

    it("handles document node in transformSearchPage and retries once with refreshed CSRF on empty response (F0254 & F0255)", async () => {
      const { default: HDChina, siteMetadata } = await import("@ptd/site/definitions/hdchina.ts");
      const site = new HDChina(decodeMeta(siteMetadata), {} as any);

      // F0254: transformSearchPage uses isDocumentNode(doc) to trigger /ajax_promotion.php
      let promoRequested = false;
      site.request = vi.fn(async (cfg: any) => {
        if (cfg.url === "/ajax_promotion.php") {
          promoRequested = true;
          expect(cfg.data.csrf).toBe("csrf-search");
          return {
            data: { status: 200, message: { "123": { sp_state: '<img class="pro_free" />' } } },
            config: cfg,
          } as any;
        }
        return { data: "", config: cfg } as any;
      });

      const searchDoc = makeDoc(`
        <meta name="x-csrf" content="csrf-search" />
        <table class="torrent_list">
          <tr class="tab_header"><td>header</td></tr>
          <tr>
            <td class="t_cat"><img class="catchs" alt="Movie" /></td>
            <td class="t_name">
              <h3><a href="details.php?id=123" title="Sample Movie">Sample Movie</a></h3>
              <h4>Subtitle</h4>
            </td>
            <td class="t_time"><span title="2024-01-01 00:00:00">1d</span></td>
            <td class="t_size">10 GB</td>
            <td class="t_torrents">5</td>
            <td class="t_leech">1</td>
            <td class="t_completed">20</td>
            <td class="t_uploader">alice</td>
            <td class="discount"></td>
            <td class="act"><a href="download.php?hash=abc123">DL</a></td>
          </tr>
        </table>
      `);
      const torrents = await site.transformSearchPage(searchDoc, {
        searchEntry: siteMetadata.search,
        requestConfig: siteMetadata.search!.requestConfig,
      });
      expect(torrents).toHaveLength(1);
      expect(promoRequested).toBe(true);
      expect(torrents[0].tags?.some((t) => t.name === "Free")).toBe(true);

      // F0255: requestUserSeedingPage caches CSRF with TTL and refreshes/retries once on empty response
      let indexCalls = 0;
      let ajaxCalls = 0;
      site.request = vi.fn(async (cfg: any) => {
        if (cfg.url === "/index.php") {
          indexCalls++;
          return { data: `<meta name="x-csrf" content="csrf-v${indexCalls}" />`, config: cfg } as any;
        }
        ajaxCalls++;
        if (ajaxCalls === 1) {
          expect(cfg.data.csrf).toBe("csrf-v1");
          return { data: { status: 200, message: "" }, config: cfg } as any;
        }
        expect(cfg.data.csrf).toBe("csrf-v2");
        return { data: { status: 200, message: "<table><tr><td>ok</td></tr></table>" }, config: cfg } as any;
      });

      const html = await (site as any).requestUserSeedingPage(100, "seeding");
      expect(html).toContain("ok");
      expect(indexCalls).toBe(2);
      expect(ajaxCalls).toBe(2);
    });
  });

  describe("F0251 & F0258: hdsky.ts", () => {
    it("refreshes expired/dragged links from detail page without mutating torrent and preserves valid passkey links (F0251)", async () => {
      const { default: HDSky, siteMetadata } = await import("@ptd/site/definitions/hdsky.ts");
      const site = new HDSky(decodeMeta(siteMetadata), { downloadLinkAppendix: "&https=1" } as any);

      // Permanent passkey link is preserved and normalized without detail request
      const validTorrent = {
        site: "hdsky",
        id: "10",
        title: "Valid",
        link: `download.php?id=10&passkey=abc&sign=sig`,
      } as ITorrent;
      const validResolved = await site.getTorrentDownloadLink(validTorrent);
      expect(validResolved).toBe(`${site.url}download.php?id=10&passkey=abc&sign=sig&https=1`);
      expect(validTorrent.link).toBe(`download.php?id=10&passkey=abc&sign=sig`);

      // Expired time-limited link (t=<past>) refreshes via detail page without mutating torrent
      const expiredTs = Math.floor(Date.now() / 1000) - 3600;
      const futureTs = Math.floor(Date.now() / 1000) + 3600;
      const expiredTorrent = {
        site: "hdsky",
        id: "11",
        title: "Expired",
        url: `${site.url}details.php?id=11`,
        link: `${site.url}download.php?id=11&t=${expiredTs}&sign=old`,
      } as ITorrent;

      site.request = vi.fn(
        async (cfg: any) =>
          ({
            data: makeDoc(`<form action="download.php?id=11&t=${futureTs}&sign=fresh"></form>`),
            config: cfg,
          }) as any,
      );

      const refreshed = await site.getTorrentDownloadLink(expiredTorrent);
      expect(refreshed).toBe(`${site.url}download.php?id=11&t=${futureTs}&sign=fresh&https=1`);
      expect(expiredTorrent.link).toBe(`${site.url}download.php?id=11&t=${expiredTs}&sign=old`);
    });

    it("strips only promotion countdown brackets in subTitle without eating subsequent brackets (F0258)", async () => {
      const { siteMetadata } = await import("@ptd/site/definitions/hdsky.ts");
      const { default: NexusPHP } = await import("@ptd/site/schemas/NexusPHP.ts");
      const site = new NexusPHP(decodeMeta(siteMetadata), {} as any);
      const row = makeDoc(
        `<table><tr><td class="embedded"><a href="details.php?id=1&hit=1" title="Title"><b>Title</b></a><br />[优惠剩余时间：1时20分] [国语中字] 正片字幕</td></tr></table>`,
      ).querySelector("tr")!;
      const subTitle = (site as any).getFieldData(row, siteMetadata.search!.selectors!.subTitle);
      expect(subTitle).toContain("[国语中字]");
      expect(subTitle).not.toContain("优惠剩余时间");
    });
  });

  describe("F0253: hdf.ts", () => {
    it("detail page list rule filters non-torrent rows and extracts page h2 title & +tr time", async () => {
      const { default: HDF, siteMetadata } = await import("@ptd/site/definitions/hdf.ts");
      const site = new HDF(decodeMeta(siteMetadata), {} as any);
      const detailListRule = siteMetadata.list![1];
      const mergedEntry = {
        ...siteMetadata.search,
        selectors: {
          ...siteMetadata.search!.selectors,
          ...detailListRule.selectors,
        },
      };

      const doc = makeDoc(`
        <div><h2>Inception [2010]</h2></div>
        <table id="torrent_table" class="torrent_table">
          <tr class="colhead"><td>Torrents</td></tr>
          <tr class="edition"><td>Blu-ray</td></tr>
          <tr class="group_torrent edition_1">
            <td>
              <a href="torrents.php?action=download&id=777">DL</a>
              <a href="torrents.php?id=10&torrentid=777">1080p</a>
              <span class="torrent_info">1080p / Remux</span>
            </td>
            <td class="number_column nobr">25.00 GiB</td>
            <td class="number_column">10</td>
            <td class="number_column">5</td>
            <td class="number_column">1</td>
          </tr>
          <tr class="torrentdetails">
            <td colspan="5">Uploaded <span class="time" title="15-05-2024, 12:30:00">2 days ago</span></td>
          </tr>
          <tr class="torrent_filename_row"><td>Inception.2010.mkv</td></tr>
        </table>
      `);

      const torrents = await site.transformSearchPage(doc, {
        searchEntry: mergedEntry,
        requestConfig: { url: "/torrents.php?id=10" },
      });
      expect(torrents).toHaveLength(1);
      expect(String(torrents[0].id)).toBe("777");
      expect(torrents[0].title).toContain("Inception [2010]");
      expect(torrents[0].time).toBeTypeOf("number");
      expect(torrents[0].time).toBeGreaterThan(0);
    });
  });

  describe("F0257: hdroute.ts", () => {
    it("normalizes relative and :COOKIE: download links via fixLink and blocks unsafe schemes", async () => {
      const { default: HDRoute, siteMetadata } = await import("@ptd/site/definitions/hdroute.ts");
      const site = new HDRoute(decodeMeta(siteMetadata), {} as any);

      const doc = makeDoc(`
        <input name="tId" value="888" />
        <h1 class="details-title-chs">Movie</h1>
        <textarea id="details-download-link">/download.php?id=888:COOKIE:uid=1</textarea>
      `);
      const detail = await site.transformDetailPage(doc);
      expect(detail.link).toBe(`${site.url}download.php?id=888:COOKIE:uid=1`);

      const resolved = await site.getTorrentDownloadLink({
        site: "hdroute",
        id: "888",
        title: "Movie",
        link: "/download.php?id=888:COOKIE:uid=1",
      } as ITorrent);
      expect(resolved).toBe(`${site.url}download.php?id=888:COOKIE:uid=1`);

      await expect(
        site.getTorrentDownloadLink({
          site: "hdroute",
          id: "888",
          title: "Movie",
          link: "javascript:alert(1):COOKIE:x",
        } as ITorrent),
      ).rejects.toThrow(/blocked invalid download link/i);
    });
  });

  describe("F0266: huno.ts", () => {
    it("does not falsely tag 中字 when English subtitles co-occur with Chinese audio/title", async () => {
      const { default: Huno, siteMetadata } = await import("@ptd/site/definitions/huno.ts");
      const site = new Huno(decodeMeta(siteMetadata), { inputSetting: { token: "huno-tok" } } as any);

      const row = {
        id: 1,
        name: "Some.Movie.2024.Mandarin.1080p",
        subtitles: ["English"],
        audio: ["Mandarin"],
      };
      const parsed = (site as any).parseTorrentRowForTags({ tags: [] }, row, {
        searchEntry: siteMetadata.search,
      });
      const tagNames = (parsed.tags ?? []).map((t: any) => t.name);
      expect(tagNames).toContain("国语");
      expect(tagNames).not.toContain("中字");

      const rowWithZhSub = {
        id: 2,
        name: "Some.Movie.2024.1080p",
        subtitles: ["Chinese"],
      };
      const parsedZhSub = (site as any).parseTorrentRowForTags({ tags: [] }, rowWithZhSub, {
        searchEntry: siteMetadata.search,
      });
      expect((parsedZhSub.tags ?? []).map((t: any) => t.name)).toContain("中字");
    });
  });

  describe("F0265: hxpt.ts", () => {
    it("extracts seedingTime in seconds from seedingPoints and removes unsupported downloadCount", async () => {
      const { siteMetadata } = await import("@ptd/site/definitions/hxpt.ts");
      const { default: FluxTorrent } = await import("@ptd/site/schemas/FluxTorrent.ts");
      const site = new FluxTorrent(decodeMeta(siteMetadata), { inputSetting: { token: "hx-tok" } } as any);

      expect(siteMetadata.userInfo?.process?.[0]?.fields).toContain("seedingTime");
      const seedingTime = (site as any).getFieldData(
        { seedingPoints: 240 },
        siteMetadata.userInfo!.selectors!.seedingTime,
      );
      expect(seedingTime).toBe(240 * 3600);

      const powerUser = siteMetadata.levelRequirements?.find((l) => l.id === 2);
      expect((powerUser as any)?.downloadCount).toBeUndefined();
      expect(powerUser?.seedingTime).toBe(240 * 3600);
    });
  });

  describe("F0260 & F0261: infinityhd.ts", () => {
    it("uses ETorrentStatus.unknown and scopes Bearer auth to trusted /api/ routes without origin header", async () => {
      const { default: InfinityHD, siteMetadata } = await import("@ptd/site/definitions/infinityhd.ts");
      expect(siteMetadata.search?.selectors?.status).toEqual({ text: ETorrentStatus.unknown });

      const site = new InfinityHD(decodeMeta(siteMetadata), { inputSetting: { token: "ihd-secret" } } as any);
      mocks.request.mockImplementation(async (cfg: any) => ({
        status: 200,
        data: {},
        config: cfg,
        headers: {},
        request: { responseURL: `${site.url}${String(cfg.url ?? "").replace(/^\//, "")}` },
      }));

      // Non-API path does not get Authorization
      await site.request({ url: "/users/alice", responseType: "document" }, false);
      expect(mocks.request.mock.calls[0][0].headers?.Authorization).toBeUndefined();

      // API path gets Authorization on cloned headers without origin
      const apiCfg = { url: "/api/torrents/filter", responseType: "json" as const };
      await site.request(apiCfg, false);
      const sentApi = mocks.request.mock.calls[1][0];
      expect(sentApi.headers?.Authorization).toBe("Bearer ihd-secret");
      expect(sentApi.headers?.origin).toBeUndefined();
      expect((apiCfg as any).headers).toBeUndefined();

      // Untrusted host with /api/ in URL must be blocked
      await expect(site.request({ url: "https://evil.example/api/torrents/filter" }, false)).rejects.toThrow(
        /untrusted host/i,
      );

      // Missing token on /api/ throws NoUserInputError
      const noKeySite = new InfinityHD(decodeMeta(siteMetadata), { inputSetting: {} } as any);
      await expect(noKeySite.request({ url: "/api/torrents/filter" }, false)).rejects.toBeInstanceOf(NoUserInputError);
    });
  });
});
