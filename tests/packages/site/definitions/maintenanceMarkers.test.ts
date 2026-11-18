import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  (globalThis as any).__BROWSER__ = "chrome";
});
const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  store: vi.fn(),
  retrieveStore: vi.fn(),
  retrieve: vi.fn(),
  blocked: vi.fn(),
}));
vi.mock("@ptd/site/utils/adapter.ts", () => ({
  axios: {
    request: mocks.request,
    getUri: (config: any) => new URL(config.url ?? "/", config.baseURL).href,
  },
  store: mocks.store,
  retrieve: mocks.retrieve,
  retrieveStore: mocks.retrieveStore,
  sleep: vi.fn(async () => {}),
  cookie: vi.fn(async () => null),
  logMessage: vi.fn(),
  isCloudflareBlocked: mocks.blocked,
}));

import BaseSite from "@ptd/site/schemas/AbstractBittorrentSite.ts";
import { CFBlockedError, ETorrentStatus, NeedLoginError, NoUserInputError } from "@ptd/site/types.ts";
import Gazelle, { SchemaMetadata as gazelleMetadata } from "@ptd/site/schemas/Gazelle.ts";
import { siteMetadata as pterMetadata } from "@ptd/site/definitions/pter.ts";
import { siteMetadata as csptMetadata } from "@ptd/site/definitions/cspt.ts";
import { siteMetadata as hudbtMetadata } from "@ptd/site/definitions/hudbt.ts";
import { siteMetadata as iptMetadata } from "@ptd/site/definitions/iptorrents.ts";
import { siteMetadata as springMetadata } from "@ptd/site/definitions/springsunday.ts";
import BeyondHD, { siteMetadata as beyondMetadata } from "@ptd/site/definitions/beyondhd.ts";
import Zhuque, { siteMetadata as zhuqueMetadata } from "@ptd/site/definitions/zhuque.ts";
import MTeam, { siteMetadata as mteamMetadata } from "@ptd/site/definitions/mteam.ts";
import Aidoru, { siteMetadata as aidoruMetadata } from "@ptd/site/definitions/aidoruonline.ts";
import { buildSearchSolutionFromCategories } from "@/options/utils/searchSolutionConfig.ts";
import { resolveColor } from "@/shared/colors.ts";

const documentOf = (html: string) =>
  new DOMParser().parseFromString(`<html><head><title>Account</title></head><body>${html}</body></html>`, "text/html");
class Probe extends BaseSite {
  field(row: Element | object, query: any, field?: any) {
    return this.getFieldData(row, query, field);
  }
}

beforeEach(() => {
  mocks.request.mockReset();
  mocks.store.mockReset();
  mocks.retrieve.mockReset().mockResolvedValue(null);
  mocks.retrieveStore.mockReset().mockResolvedValue(null);
  mocks.blocked.mockReset().mockReturnValue(false);
  mocks.request.mockImplementation(async (config) => ({
    data: {},
    status: 200,
    statusText: "OK",
    headers: {},
    config,
    request: { responseURL: new URL(config.url, config.baseURL).href },
  }));
});

describe("accurate torrent states", () => {
  it.each([
    ["progbargreen", "width:98%", 100, ETorrentStatus.seeding],
    ["progbarred", "width:98%", 100, ETorrentStatus.completed],
    ["progbarred", "width:100%", 100, ETorrentStatus.completed],
    ["progbarred", "width:49%", 50, ETorrentStatus.unknown],
    ["progbarrest", "width:49%", 50, ETorrentStatus.unknown],
    ["progbarrest", "", 0, ETorrentStatus.unknown],
    ["progbarrest", "width:bad%", 0, ETorrentStatus.unknown],
    ["progbarrest", "width:120%", 0, ETorrentStatus.unknown],
    ["progbarred", "width:-5%", 0, ETorrentStatus.unknown],
    ["progbarred", "width:.5%", (0.5 / 98) * 100, ETorrentStatus.unknown],
    ["progbarred", "width:-.5%", 0, ETorrentStatus.unknown],
  ])("pter %s %s", (className, style, progress, status) => {
    const image = documentOf(`<img class="${className}" style="${style}">`).querySelector("img")!;
    const selectors = pterMetadata.search!.selectors!;
    expect(selectors.progress!.elementProcess!(image)).toBe(progress);
    expect(selectors.status!.elementProcess!(image)).toBe(status);
  });

  it.each([
    ["leeching 3 peers 42%", 42, ETorrentStatus.downloading],
    ["SEEDING 100%", 100, ETorrentStatus.seeding],
    ["inactivity 100%", 100, ETorrentStatus.completed],
    ["inactivity 5%", 5, ETorrentStatus.inactive],
    ["leeching 2 peers", 0, ETorrentStatus.downloading],
    ["leeching -5%", 0, ETorrentStatus.downloading],
    ["leeching 101%", 0, ETorrentStatus.downloading],
    ["leeching 1,5%", 1.5, ETorrentStatus.downloading],
    ["leeching .5%", 0.5, ETorrentStatus.downloading],
    ["leeching -.5%", 0, ETorrentStatus.downloading],
    ["not seeding 12%", 12, ETorrentStatus.unknown],
  ])("cspt %s", (title, progress, status) => {
    const probe = new Probe(csptMetadata);
    const doc = documentOf(`<div title="${title}"></div>`);
    expect(probe.field(doc, csptMetadata.search!.selectors!.progress)).toBe(progress);
    expect(probe.field(doc, csptMetadata.search!.selectors!.status)).toBe(status);
  });
});

describe("category parsing and generation", () => {
  it.each([undefined, "Custom category"])(
    "Gazelle group categories reach child torrents with override %s",
    async (override) => {
      const categoryQuery = override ? { text: override } : gazelleMetadata.search!.selectors!.category;
      class GazelleProbe extends Gazelle {
        group(group: HTMLElement, child: HTMLTableRowElement) {
          return this.transformGroupTorrents(group, [child], {
            requestConfig: { baseURL: "https://fixture.example/" },
            searchEntry: {
              selectors: {
                title: { selector: "a.title" },
                category: categoryQuery,
                link: { selector: "a.download", attr: "href" },
              },
            },
          } as any);
        }
      }
      const doc = documentOf(
        '<table><tr class="group"><td class="cats_col"><div class="cats_music" title="rock"></div></td><td><a class="title">Album</a></td></tr><tr class="torrent"><td><a class="download" href="/torrents.php?action=download&id=42">download</a></td></tr></table>',
      );
      const site = new GazelleProbe({ ...gazelleMetadata, urls: ["https://fixture.example/"] } as any);
      const torrents = await site.group(
        doc.querySelector<HTMLElement>("tr.group")!,
        doc.querySelector<HTMLTableRowElement>("tr.torrent")!,
      );
      expect(torrents).toHaveLength(1);
      expect(torrents[0]!.category).toBe(override ?? "Music");
      expect(torrents[0]!.title).toBe("Album");
    },
  );

  it.each([
    ["music", "Music"],
    ["applications", "Applications"],
    ["ebooks", "E-Books"],
    ["audiobooks", "Audiobooks"],
    ["elearningvideos", "E-Learning Videos"],
    ["comedy", "Comedy"],
    ["comics", "Comics"],
    ["custom", "custom"],
    ["constructor", "constructor"],
    ["__proto__", "__proto__"],
  ])("Gazelle cats_%s is %s rather than the tag tooltip", (token, category) => {
    const probe = new Probe(gazelleMetadata as any);
    const doc = documentOf(
      `<table><tr><td class="cats_col"><div class="tooltip cats_${token} tags_rock" title="rock"></div></td></tr></table>`,
    );
    expect(probe.field(doc, gazelleMetadata.search!.selectors!.category)).toBe(category);
  });

  it.each([
    ["48", "Movie/HD/Bluray"],
    ["101", "Movie/4K"],
    ["999", 999],
    ["TV", "TV"],
  ])("IPT maps %s without losing unknown categories", (value, expected) => {
    const query = iptMetadata.list!.find((entry) => entry.urlPattern?.includes("/indexipt\\.php"))!.selectors!.category;
    const doc = documentOf(`<table><tr><td><img alt="${value}"></td></tr></table>`);
    expect(new Probe(iptMetadata).field(doc.querySelector("tr")!, query, "category")).toBe(expected);
  });

  it("IPT can read an existing numeric category query without an image", () => {
    const query = iptMetadata.list!.find((entry) => entry.urlPattern?.includes("/indexipt\\.php"))!.selectors!.category;
    const doc = documentOf('<table><tr><td><a href="?48">Movies</a></td></tr></table>');
    expect(new Probe(iptMetadata).field(doc.querySelector("tr")!, query)).toBe("Movie/HD/Bluray");
  });

  it("HUDBT combines main groups with existing leaf categories", () => {
    const result = buildSearchSolutionFromCategories(hudbtMetadata.category!, {
      catGroup: ["401,413,414,415,430,433", "402,417,416,418"],
      cat: [404, 401],
    });
    expect(result.requestConfig.requestConfig!.params).toEqual({
      cat401: 1,
      cat413: 1,
      cat414: 1,
      cat415: 1,
      cat430: 1,
      cat433: 1,
      cat402: 1,
      cat417: 1,
      cat416: 1,
      cat418: 1,
      cat404: 1,
    });
    expect(buildSearchSolutionFromCategories(hudbtMetadata.category!, {}).requestConfig).toEqual({});
  });
});

describe("BeyondHD labels", () => {
  class BeyondProbe extends BeyondHD {
    tags(row: any) {
      return this.parseTorrentRowForTags({}, row, {} as any).tags;
    }
  }
  it.each([1, true, "1"])("accepts explicit positive flags %s", (flag) => {
    const site = new BeyondProbe(beyondMetadata);
    expect(site.tags({ internal: flag, dv: flag, hdr10: flag, "hdr10+": flag, hlg: flag, commentary: flag })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "官方" }),
        expect.objectContaining({ name: "DoVi" }),
        expect.objectContaining({ name: "HDR10" }),
        expect.objectContaining({ name: "HDR10+" }),
        expect.objectContaining({ name: "HLG" }),
        expect.objectContaining({ name: "评论音轨" }),
      ]),
    );
  });
  it.each([0, false, "0", null, undefined])("does not treat %s as an enabled flag", (flag) => {
    expect(new BeyondProbe(beyondMetadata).tags({ internal: flag, freeleech: flag })).toEqual([
      { name: "H&R", color: "red" },
    ]);
  });
  it("recognizes comma-separated Chinese audio and subtitles", () => {
    expect(new BeyondProbe(beyondMetadata).tags({ audios: "English,Chinese", subtitles: "English,Cantonese" })).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "中配" }), expect.objectContaining({ name: "中字" })]),
    );
  });
});

describe("existing SpringSunday colors", () => {
  class SpringProbe extends BaseSite {
    tags(row: Element) {
      return this.parseTorrentRowForTags({}, row, {
        searchEntry: { selectors: springMetadata.search!.selectors },
      } as any).tags;
    }
  }
  it("retains distinct labels and valid palette values", () => {
    const doc = documentOf(
      '<div id="row"><span class="torrent-internal"></span><span class="torrent-dovi"></span><span class="torrent-hdr10plus"></span></div>',
    );
    const tags = new SpringProbe(springMetadata).tags(doc.querySelector("#row")!)!;
    expect(tags).toEqual(
      expect.arrayContaining([
        { name: "官方", color: "teal" },
        { name: "DoVi", color: "indigo" },
        { name: "HDR10+", color: "red" },
      ]),
    );
    for (const tag of tags) expect(resolveColor(tag.color)).toBeTruthy();
  });
});

describe("SkidrowRepack assembled timezone", () => {
  it.each([
    ["2020-07-27T17:31:25", Date.UTC(2020, 6, 27, 17, 31, 25)],
    ["2020-07-27T17:31:25Z", Date.UTC(2020, 6, 27, 17, 31, 25)],
    ["2020-07-27T17:31:25+02:00", Date.UTC(2020, 6, 27, 15, 31, 25)],
  ])("parses %s through actual default metadata", async (value, expected) => {
    const { getDefinedSiteMetadata } = await import("@ptd/site/index.ts");
    const metadata = await getDefinedSiteMetadata("skidrowrepack");
    expect(metadata.timezoneOffset).toBe("+0000");
    const doc = documentOf(`<time datetime="${value}"></time>`);
    expect(new Probe(metadata).field(doc, metadata.detail!.selectors!.time)).toBe(expected);
  });
});

describe("M-Team token validation", () => {
  it.each([undefined, "", "  "])("rejects missing tokens before network IO", async (token) => {
    const site = new MTeam(mteamMetadata, { inputSetting: { token } } as any);
    await expect(site.request({ url: "/api/member/profile" })).rejects.toBeInstanceOf(NoUserInputError);
    expect(mocks.request).not.toHaveBeenCalled();
  });
});

describe("Zhuque CSRF lifecycle", () => {
  const makeSite = (token?: string) =>
    new Zhuque(zhuqueMetadata, {
      url: "https://zhuque.in/",
      runtimeSettings: token ? { csrfToken: token } : {},
    });
  const respond = (config: any, data: any = {}, status = 200) => ({
    data,
    status,
    statusText: "",
    headers: {},
    config,
    request: { responseURL: new URL(config.url, config.baseURL).href },
  });

  it("reuses a cached token without mutating the caller headers", async () => {
    const config = { url: "/api/torrent/advancedSearch", headers: { custom: "yes" } };
    await makeSite("cached").request(config);
    expect(mocks.request).toHaveBeenCalledTimes(1);
    expect(mocks.request.mock.calls[0]![0].headers).toMatchObject({ "x-csrf-token": "cached", custom: "yes" });
    expect(config.headers).toEqual({ custom: "yes" });
  });

  it("migrates a legacy token", async () => {
    mocks.retrieveStore.mockResolvedValue("legacy");
    await makeSite().request({ url: "/api/torrent/advancedSearch" });
    expect(mocks.store).toHaveBeenCalledWith("zhuque", "csrfToken", "legacy");
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent first-time token acquisition", async () => {
    mocks.request.mockImplementation(async (config) =>
      respond(config, config.url === "/api/plugins/ptppUserInfo" ? { data: { csrfToken: "fresh" } } : {}),
    );
    const site = makeSite();
    await Promise.all([site.request({ url: "/api/torrent/a" }), site.request({ url: "/api/torrent/b" })]);
    expect(mocks.request.mock.calls.filter(([config]) => config.url === "/api/plugins/ptppUserInfo")).toHaveLength(1);
    expect(mocks.request).toHaveBeenCalledTimes(3);
  });

  it("refreshes explicit CSRF rejection once", async () => {
    mocks.request.mockImplementation(async (config) => {
      if (config.url === "/api/plugins/ptppUserInfo") return respond(config, { data: { csrfToken: "fresh" } });
      return config.headers["x-csrf-token"] === "cached"
        ? respond(config, { message: "CSRF token mismatch" }, 403)
        : respond(config);
    });
    await makeSite("cached").request({ url: "/api/torrent/advancedSearch" });
    expect(mocks.request).toHaveBeenCalledTimes(3);
    expect(mocks.store).toHaveBeenCalledWith("zhuque", "csrfToken", "fresh");
  });

  it("does not loop if the refreshed token is still rejected", async () => {
    mocks.request.mockImplementation(async (config) =>
      config.url === "/api/plugins/ptppUserInfo"
        ? respond(config, { data: { csrfToken: "fresh" } })
        : respond(config, { message: "CSRF token mismatch" }, 403),
    );
    await expect(makeSite("cached").request({ url: "/api/torrent/advancedSearch" })).rejects.toBeInstanceOf(
      NeedLoginError,
    );
    expect(mocks.request).toHaveBeenCalledTimes(3);
  });

  it("reuses a refreshed token when a concurrent old-token rejection arrives late", async () => {
    let rejectLate!: () => void;
    mocks.request.mockImplementation(async (config) => {
      if (config.url === "/api/plugins/ptppUserInfo") return respond(config, { data: { csrfToken: "fresh" } });
      if (config.headers["x-csrf-token"] === "cached") {
        if (config.url === "/api/torrent/late") {
          return new Promise((resolve) => {
            rejectLate = () => resolve(respond(config, { message: "CSRF mismatch" }, 403));
          });
        }
        return respond(config, { message: "CSRF mismatch" }, 403);
      }
      return respond(config);
    });
    const site = makeSite("cached");
    const first = site.request({ url: "/api/torrent/first" });
    const late = site.request({ url: "/api/torrent/late" });
    await first;
    rejectLate();
    await late;
    expect(mocks.request.mock.calls.filter(([config]) => config.url === "/api/plugins/ptppUserInfo")).toHaveLength(1);
    expect(mocks.request).toHaveBeenCalledTimes(5);
  });

  it("does not refresh on Cloudflare rejection", async () => {
    mocks.blocked.mockReturnValue(true);
    await expect(makeSite("cached").request({ url: "/api/torrent/advancedSearch" })).rejects.toBeInstanceOf(
      CFBlockedError,
    );
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403])("does not refresh a generic authentication failure (%s)", async (status) => {
    mocks.request.mockImplementation(async (config) => respond(config, { message: "Please log in" }, status));
    await expect(makeSite("cached").request({ url: "/api/torrent/advancedSearch" })).rejects.toBeInstanceOf(
      NeedLoginError,
    );
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });

  it("does not cache missing tokens and permits a later retry", async () => {
    const site = makeSite();
    await expect(site.request({ url: "/api/torrent/advancedSearch" })).rejects.toBeInstanceOf(NeedLoginError);
    expect(mocks.store).not.toHaveBeenCalled();
    mocks.request.mockImplementation(async (config) => respond(config, { data: { csrfToken: "fresh" } }));
    await expect(site.request({ url: "/api/torrent/advancedSearch" })).resolves.toMatchObject({ status: 200 });
  });
});

describe("Aidoru optional message counts", () => {
  class AidoruProbe extends Aidoru {
    details() {
      return this.getUserInfoFromDetailsPage();
    }
  }
  it.each([
    ["Private Messages (7)", 7],
    ["Private Messages (0)", 0],
    [undefined, undefined],
    ["Private Messages", undefined],
    ["Private Messages (1.5)", undefined],
    ["Private Messages (-1)", undefined],
    ["Private Messages (1,234)", 1234],
  ])("preserves %s without fabricating a missing count", async (text, count) => {
    const nav = text === undefined ? "" : `<a href="/forum/private.php">${text}</a>`;
    const doc = documentOf(
      `<table><tr><td class="prof-lbl">Uploaded:</td><td>1 GB</td></tr><tr><td class="prof-lbl">Downloaded:</td><td>2 GB</td></tr></table>${nav}`,
    );
    const site = new AidoruProbe(aidoruMetadata);
    vi.spyOn(site, "request").mockResolvedValue({ data: doc } as any);
    const result = await site.details();
    expect(result.messageCount).toBe(count);
    expect(result.uploaded).toBe(1024 ** 3);
    expect(result.downloaded).toBe(2 * 1024 ** 3);
  });
});
