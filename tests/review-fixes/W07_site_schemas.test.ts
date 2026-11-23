import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  isCloudflareBlocked: vi.fn(() => false),
  sleep: vi.fn(async (_ms?: number) => {}),
  logMessage: vi.fn(),
  retrieve: vi.fn(async () => null),
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
const { default: AvistazNetwork, SchemaMetadata: AvistazSchema } = await import("@ptd/site/schemas/AvistazNetwork.ts");
const { default: FluxTorrent, SchemaMetadata: FluxSchema } = await import("@ptd/site/schemas/FluxTorrent.ts");
const { default: Gazelle, SchemaMetadata: GazelleSchema } = await import("@ptd/site/schemas/Gazelle.ts");
const { default: GazelleJSONAPI, SchemaMetadata: GazelleJsonSchema } =
  await import("@ptd/site/schemas/GazelleJSONAPI.ts");
const { default: Luminance, SchemaMetadata: LuminanceSchema } = await import("@ptd/site/schemas/Luminance.ts");
const {
  default: NexusPHP,
  subTitleRemoveExtraElement,
  defaultUserLevelRequirements,
  xiaomloveDefaultUserLevelRequirements,
} = await import("@ptd/site/schemas/NexusPHP.ts");
const { default: Rartracker, SchemaMetadata: RartrackerSchema } = await import("@ptd/site/schemas/Rartracker.ts");
const { default: Torznab, SchemaMetadata: TorznabSchema } = await import("@ptd/site/schemas/Torznab.ts");
const { default: Unit3D, SchemaMetadata: Unit3DSchema } = await import("@ptd/site/schemas/Unit3D.ts");
const { EResultParseStatus, NeedLoginError } = await import("@ptd/site/types.ts");

function makeDoc(html: string, url: string = "https://site.example/"): Document {
  const doc = new DOMParser().parseFromString(`<html><body>${html}</body></html>`, "text/html");
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

beforeEach(() => {
  mocks.request.mockReset();
  mocks.isCloudflareBlocked.mockReset();
  mocks.isCloudflareBlocked.mockReturnValue(false);
  mocks.sleep.mockReset();
  mocks.sleep.mockResolvedValue(undefined);
  mocks.logMessage.mockReset();
  mocks.retrieve.mockReset();
  mocks.retrieve.mockResolvedValue(null);
  mocks.store.mockReset();
  mocks.store.mockResolvedValue(undefined);
});

describe("F0077: AbstractBittorrentSite.getTorrentDownloadLink detail fallback runs fixLink", () => {
  it("normalizes relative and protocol-relative links from detail page and caches normalized URL", async () => {
    const site = new BittorrentSite({
      id: "detail-site",
      name: "Detail Site",
      type: "public",
      urls: ["https://site.example/"],
      detail: {
        selectors: {
          link: { selector: "a.dl", attr: "href" },
        },
      },
    } as any);

    mocks.request.mockImplementationOnce(async (config: any) =>
      okResponse(
        config,
        makeDoc(`<a class="dl" href="download.php?id=42">DL</a>`, "https://site.example/sub/details.php?id=42"),
      ),
    );

    const torrent: any = { site: "detail-site", id: "42", url: "https://site.example/sub/details.php?id=42" };
    const first = await site.getTorrentDownloadLink(torrent);
    const second = await site.getTorrentDownloadLink(torrent);

    expect(first).toBe("https://site.example/sub/download.php?id=42");
    expect(second).toBe(first);
    expect(mocks.request).toHaveBeenCalledTimes(1);

    // Protocol-relative link
    mocks.request.mockImplementationOnce(async (config: any) =>
      okResponse(config, makeDoc(`<a class="dl" href="//cdn.site.example/42.torrent">DL</a>`)),
    );
    const torrent2: any = { site: "detail-site", id: "43", url: "https://site.example/details.php?id=43" };
    expect(await site.getTorrentDownloadLink(torrent2)).toBe("https://cdn.site.example/42.torrent");
  });

  it("rejects disallowed protocols such as javascript: and data: from detail page", async () => {
    const site = new BittorrentSite({
      id: "detail-site",
      name: "Detail Site",
      type: "public",
      urls: ["https://site.example/"],
      detail: {
        selectors: {
          link: { selector: "a.dl", attr: "href" },
        },
      },
    } as any);

    for (const badHref of ["javascript:alert(1)", "data:text/html,<script>alert(1)</script>"]) {
      mocks.request.mockImplementationOnce(async (config: any) =>
        okResponse(config, makeDoc(`<a class="dl" href="${badHref}">DL</a>`)),
      );
      const torrent: any = { site: "detail-site", id: "99", url: "https://site.example/details.php?id=99" };
      await expect(site.getTorrentDownloadLink(torrent)).rejects.toThrow(/cannot parse torrent download link/);
    }
  });
});

describe("F0078: AbstractBittorrentSite missing time is deleted instead of coerced to 0", () => {
  it("leaves torrent.time undefined when time selector misses, while still coercing counts to 0", async () => {
    class RowSite extends BittorrentSite {
      public async runRow(row: Element, selectors: Record<string, any>) {
        return await this.parseWholeTorrentFromRow({}, row, {
          searchEntry: { selectors: { rows: { selector: ":self" }, ...selectors } },
          requestConfig: { url: "https://site.example/torrents.php" },
        } as any);
      }
    }

    const site = new RowSite({
      id: "time-miss",
      name: "Time Miss",
      type: "public",
      urls: ["https://site.example/"],
      timezoneOffset: "+0800",
    } as any);

    const row = document.createElement("tr");
    row.innerHTML = `<td class="title">Movie</td>`;

    const torrent = await site.runRow(row, {
      title: { selector: ".title" },
      time: { selector: ".missing-time" },
      seeders: { selector: ".missing-seeders" },
    });

    expect(torrent.time).toBeUndefined();
    expect(torrent.seeders).toBe(0);
  });
});

describe("F0079: getFieldsData({ dropEmptyMisses: true }) preserves labeled/unit zeros and drops empty filter results", () => {
  class FieldsSite extends BittorrentSite {
    public fields(doc: Document, selectors: any) {
      return this.getFieldsData(doc, selectors, undefined, { dropEmptyMisses: true });
    }
  }

  const site = new FieldsSite({
    id: "fields-site",
    name: "Fields Site",
    type: "public",
    urls: ["https://site.example/"],
  } as any);

  it("preserves legitimate zero values with labels, units, commas, or percent", () => {
    const doc = makeDoc(`
      <div class="up">Uploaded: 0 B</div>
      <div class="ratio">Ratio: 0.00</div>
      <div class="comma">0,00</div>
      <div class="pct">0%</div>
      <div class="bph">0.00 BP/hr</div>
      <div class="pph">0 points per hour</div>
      <div class="hr">Hit &amp; Run: 0</div>
    `);

    const data: any = site.fields(doc, {
      uploaded: { selector: ".up", filters: [{ name: "parseSize" }] },
      ratio: { selector: ".ratio", filters: [{ name: "parseNumber" }] },
      comma: { selector: ".comma", filters: [{ name: "parseNumber" }] },
      pct: { selector: ".pct", filters: [{ name: "parseNumber" }] },
      bph: { selector: ".bph", filters: [{ name: "parseNumber" }] },
      pph: { selector: ".pph", filters: [{ name: "parseNumber" }] },
      hr: { selector: ".hr", filters: [{ name: "parseNumber" }] },
    });

    expect(data.uploaded).toBe(0);
    expect(data.ratio).toBe(0);
    expect(data.comma).toBe(0);
    expect(data.pct).toBe(0);
    expect(data.bph).toBe(0);
    expect(data.pph).toBe(0);
    expect(data.hr).toBe(0);
  });

  it("drops 0 coerced from non-zero/unparseable text and drops empty string from matched selector", () => {
    const doc = makeDoc(`
      <div class="na">N/A</div>
      <div class="dash">---</div>
      <div class="empty-after-filter">Some text</div>
    `);

    const data: any = site.fields(doc, {
      na: { selector: ".na", filters: [{ name: "parseNumber" }] },
      dash: { selector: ".dash", filters: [{ name: "parseSize" }] },
      emptyAfter: { selector: ".empty-after-filter", filters: [() => ""] },
    });

    expect(data.na).toBeUndefined();
    expect(data.dash).toBeUndefined();
    expect(data.emptyAfter).toBeUndefined();
  });
});

describe("F0080 & F0081: AvistazNetwork auth error classification and concurrent userInfo isolation", () => {
  const baseMeta = {
    ...AvistazSchema,
    id: "avz-test",
    name: "AvistaZ Test",
    urls: ["https://avz.example/"],
  } as any;

  it("F0080: throws NeedLoginError on 401/403 and auth-fail responses and classifies as needLogin", async () => {
    const site = new AvistazNetwork(baseMeta, {
      inputSetting: { username: "u", password: "p", pid: "pid123" },
    });

    // 401 on /api/v1/jackett/auth
    mocks.request.mockImplementationOnce(async (config: any) =>
      okResponse(config, { message: "Invalid credentials" }, 401),
    );
    await expect(site.getAuthToken()).rejects.toBeInstanceOf(NeedLoginError);

    // 200 with { message } auth failure
    mocks.request.mockImplementationOnce(async (config: any) =>
      okResponse(config, { message: "Account disabled" }, 200),
    );
    await expect(site.getAuthToken()).rejects.toBeInstanceOf(NeedLoginError);

    // Search failing with 403 after token refresh -> needLogin
    mocks.request.mockImplementation(async (config: any) => {
      if (config.url === "/api/v1/jackett/auth") {
        return okResponse(config, { token: "tok", expiry: 3600 }, 200);
      }
      return okResponse(config, { message: "Forbidden" }, 403);
    });
    const res = await site.getSearchResult("test");
    expect(res.status).toBe(EResultParseStatus.needLogin);
  });

  it("F0081: isolates profileFieldHits across concurrent getUserInfoResult calls", async () => {
    const validProfile = makeDoc(
      `<table><tr><td>Username</td><td>alice</td></tr><tr><td>Uploaded</td><td>10 GiB</td></tr></table>`,
    );
    const emptyProfile = makeDoc(`<div class="maintenance">Maintenance</div>`);

    let releaseAliceBase!: () => void;
    const aliceBaseGate = new Promise<void>((r) => {
      releaseAliceBase = r;
    });

    class ConcurrentAvz extends AvistazNetwork {
      public override async request<T>(config: any): Promise<any> {
        if (config.url === "/profile/alice") {
          await aliceBaseGate;
          return okResponse(config, validProfile as T);
        }
        if (config.url === "/profile/bob") {
          return okResponse(config, emptyProfile as T);
        }
        return okResponse(config, makeDoc("") as T);
      }
    }

    const site = new ConcurrentAvz(baseMeta, { inputSetting: { username: "alice" } });
    const alicePromise = site.getUserInfoResult({ name: "alice" });
    const bobPromise = site.getUserInfoResult({ name: "bob" });

    // Let bob finish first while alice is mid-flight, then release alice
    const bobResult = await bobPromise;
    releaseAliceBase();
    const aliceResult = await alicePromise;

    expect(bobResult.status).toBe(EResultParseStatus.parseError);
    expect(aliceResult.status).toBe(EResultParseStatus.success);
  });
});

describe("F0082 & F0083: FluxTorrent request safety and infinite ratio normalization", () => {
  const fluxMeta = {
    ...FluxSchema,
    id: "flux-test",
    name: "Flux Test",
    urls: ["https://flux.example/"],
  } as any;

  it("F0082: rejects untrusted external URL before attaching token and never mutates caller config", async () => {
    const site = new FluxTorrent(fluxMeta, { inputSetting: { token: "super-secret" } });
    const badConfig: any = { url: "https://attacker.example/steal", headers: { "X-Custom": "1" } };

    await expect(site.request(badConfig, false)).rejects.toThrow(/untrusted host/);
    expect(mocks.request).not.toHaveBeenCalled();
    expect(badConfig.headers.Authorization).toBeUndefined();

    // Trusted request attaches token on cloned config only
    mocks.request.mockImplementationOnce(async (config: any) =>
      okResponse(config, { code: 0, message: "ok", data: { ok: true } }),
    );
    const goodConfig: any = { url: "/api/v1/user", headers: { "X-Custom": "1" } };
    const resp = await site.request(goodConfig, false);

    expect(resp.data).toEqual({ ok: true });
    expect(mocks.request).toHaveBeenCalledTimes(1);
    expect(mocks.request.mock.calls[0][0].headers.Authorization).toBe("Token super-secret");
    expect(goodConfig.headers.Authorization).toBeUndefined();
  });

  it("F0083: maps infinite ratio to -1 without emitting unread ratioInfinite/ratioDisplay", async () => {
    class FluxProbe extends FluxTorrent {
      public async runRatio(dataDocument: any) {
        return await this.parseUserInfoForRatio({}, dataDocument);
      }
    }

    const site = new FluxProbe(fluxMeta, { inputSetting: { token: "tok" } });
    const infRes: any = await site.runRatio({ ratio: 0, ratio_infinite: true, ratio_display: "∞" });
    expect(infRes).toEqual({ ratio: -1 });
    expect("ratioInfinite" in infRes).toBe(false);
    expect("ratioDisplay" in infRes).toBe(false);

    expect(await site.runRatio({ ratio: 3.14, ratio_infinite: false })).toEqual({ ratio: 3.14 });
    expect(await site.runRatio({ ratio: Number.NaN, ratio_infinite: false })).toEqual({ ratio: 0 });
  });
});

describe("F0084: Gazelle timezoneOffset default and raw time string fallback", () => {
  it("sets SchemaMetadata.timezoneOffset to +0000 and converts string time even when metadata omits timezoneOffset", async () => {
    expect(GazelleSchema.timezoneOffset).toBe("+0000");

    class GazelleProbe extends Gazelle {
      public async runRow(row: Element) {
        return await this.parseWholeTorrentFromRow({}, row, {
          searchEntry: {
            selectors: {
              rows: { selector: ":self" },
              time: { ...GazelleSchema.search.selectors!.time, selector: ":self" },
            },
          },
          requestConfig: { url: "https://gz.example/torrents.php" },
        } as any);
      }
    }

    // Explicitly omit timezoneOffset
    const site = new GazelleProbe({
      id: "gz-no-tz",
      name: "GZ No TZ",
      type: "private",
      urls: ["https://gz.example/"],
    } as any);

    const td = document.createElement("td");
    td.innerHTML = `<span title="2024-03-01 10:00:00">1 hour ago</span>`;
    const torrent = await site.runRow(td);

    expect(torrent.time).toBe(Date.parse("2024-03-01T10:00:00Z"));
  });
});

describe("F0085, F0088, F0095: Unit3D list pattern, uploads parsing, and bonusPerHour isolation", () => {
  it("F0085: list urlPattern matches parameterized /torrents URLs and excludes detail URLs", () => {
    const patterns = Unit3DSchema.list![0].urlPattern!.map((p) => new RegExp(p, "i"));
    const matches = (u: string) => patterns.some((re) => re.test(u));

    expect(matches("https://u3d.example/torrents")).toBe(true);
    expect(matches("https://u3d.example/torrents/")).toBe(true);
    expect(matches("https://u3d.example/torrents?name=dune&page=2")).toBe(true);
    expect(matches("https://u3d.example/torrents/12345")).toBe(false);
  });

  it("F0088: uploads selector parses comma-formatted counts and supports .badge-user fallback", () => {
    class Unit3DProbe extends Unit3D {
      public readUploads(doc: Document) {
        return this.getFieldData(doc, Unit3DSchema.userInfo!.selectors!.uploads!);
      }
    }
    const site = new Unit3DProbe({
      ...Unit3DSchema,
      id: "u3d-test",
      name: "U3D Test",
      type: "private",
      urls: ["https://u3d.example/"],
    } as any);

    const dlDoc = makeDoc(`
      <dl class="key-value">
        <dt><a href="/users/me/uploads">Uploads</a></dt><dd>1,234</dd>
        <dt><a href="/users/me/uploads?type=2">Other</a></dt><dd>56</dd>
      </dl>
    `);
    expect(site.readUploads(dlDoc)).toBe(1290);

    const badgeDoc = makeDoc(`
      <span class="badge-user"><i class="fa-upload"></i><span>2,500</span></span>
    `);
    expect(site.readUploads(badgeDoc)).toBe(2500);
  });

  it("F0095: details page excludes bonusPerHour and missing bonus selector yields undefined instead of empty string", async () => {
    class TestUnit3D extends Unit3D {
      public pages: Record<string, Document> = {};
      public override async request<T>(config: any): Promise<any> {
        return okResponse(config, (this.pages[config.url] ?? makeDoc("")) as T);
      }
    }

    const site = new TestUnit3D({
      ...Unit3DSchema,
      id: "u3d-bph",
      name: "U3D BPH",
      type: "private",
      urls: ["https://u3d.example/"],
      userInfo: { ...Unit3DSchema.userInfo, requestDelay: 0 },
    } as any);

    // Include a decoy .panelV2 dl.key-value on the details page to confirm bonusPerHour is not parsed from /users/alice
    site.pages["/users/alice"] = makeDoc(`
      <div class="profile"><span class="badge-user"><i class="fa-upload"></i><span>10</span></span></div>
      <li class="ratio-bar__uploaded"><a href="#"><i class="fa-arrow-up"></i>10 GiB</a></li>
      <li class="ratio-bar__downloaded"><a href="#"><i class="fa-arrow-down"></i>2 GiB</a></li>
      <div class="panelV2"><dl class="key-value"><dt>A</dt><dd>111</dd><dt>B</dt><dd>222</dd><dt>C</dt><dd>999</dd></dl></div>
    `);
    site.pages["/users/alice/earnings"] = makeDoc(`<div class="empty-earnings">Nothing here</div>`);

    const info = await site.getUserInfoResult({ name: "alice" });
    expect(info.status).toBe(EResultParseStatus.success);
    expect(info.uploads).toBe(10);
    expect(info.bonusPerHour).toBeUndefined();

    // Legitimate numeric 0 on earnings page is preserved
    site.pages["/users/alice/earnings"] = makeDoc(
      `<div class="panelV2"><dl class="key-value"><dt>A</dt><dd>1</dd><dt>B</dt><dd>2</dd><dt>Total</dt><dd>0</dd></dl></div>`,
    );
    const infoZero = await site.getUserInfoResult({ name: "alice" });
    expect(infoZero.status).toBe(EResultParseStatus.success);
    expect(infoZero.bonusPerHour).toBe(0);
  });
});

describe("F0086, F0089, F0091, F0094: NexusPHP inert subtitle, level requirements, uploads, and seeding size column", () => {
  it("F0086: subTitleRemoveExtraElement uses inert document without calling active document.createElement and guards self=false", () => {
    const inertDoc = new DOMParser().parseFromString(
      `<table><tr><td><a href="details.php?id=1">Title</a><br><img src="https://evil.example/track.png"><span>Tag</span> Clean Subtitle</td></tr></table>`,
      "text/html",
    );
    const titleEl = inertDoc.querySelector("a") as HTMLElement;

    const createElSpy = vi.spyOn(document, "createElement");
    try {
      const result = subTitleRemoveExtraElement(["a, span, img"], true)(titleEl);
      expect(result).toBe("Clean Subtitle");
      expect(createElSpy).not.toHaveBeenCalled();

      // self = false with direct child matched should not remove container or throw
      const resultParentMode = subTitleRemoveExtraElement(["span"], false)(titleEl);
      expect(resultParentMode).toContain("Clean Subtitle");
    } finally {
      createElSpy.mockRestore();
    }
  });

  it("F0089: defaultUserLevelRequirements omits seedingBonus while xiaomloveDefaultUserLevelRequirements keeps it", () => {
    expect(xiaomloveDefaultUserLevelRequirements.some((l) => typeof l.seedingBonus === "number")).toBe(true);
    for (const level of defaultUserLevelRequirements) {
      expect("seedingBonus" in level).toBe(false);
      expect("bonus" in level).toBe(false);
    }
  });

  it("F0091: parseUserInfoForUploads handles case-insensitive Records and table containing 'No Record' text", async () => {
    class NphpProbe extends NexusPHP {
      public payload = "";
      protected override async requestUserSeedingPage(): Promise<string | null> {
        return this.payload;
      }
      public async runUploads() {
        return await this.parseUserInfoForUploads({ id: 1 });
      }
    }

    const site = new NphpProbe({
      id: "nphp-uploads",
      name: "NPHP Uploads",
      type: "private",
      urls: ["https://nphp.example/"],
    } as any);

    site.payload = "<div><b>15</b> Records</div>";
    expect((await site.runUploads()).uploads).toBe(15);

    site.payload = `<table><tr><th>Name</th></tr><tr><td>No Record Found 2024</td></tr><tr><td>Movie 2</td></tr></table>`;
    expect((await site.runUploads()).uploads).toBe(2);

    site.payload = "No record.";
    expect((await site.runUploads()).uploads).toBe(0);
  });

  it("F0094: parseUserInfoForSeedingStatus trims cell whitespace when detecting size column", async () => {
    class NphpProbe extends NexusPHP {
      public payload = "";
      protected override async requestUserSeedingPage(): Promise<string | null> {
        return this.payload;
      }
      public async runSeeding() {
        return await this.parseUserInfoForSeedingStatus({ id: 1 });
      }
    }

    const site = new NphpProbe({
      id: "nphp-seed",
      name: "NPHP Seed",
      type: "private",
      urls: ["https://nphp.example/"],
    } as any);

    // Size is in column index 3 (not default index 2) with leading/trailing whitespace
    site.payload = `
      <table>
        <tr><td>Cat</td><td>Title</td><td>Comments</td><td>Size</td></tr>
        <tr><td>Movie</td><td>Test 1</td><td>0</td><td>\n  2.00 GiB  \n</td></tr>
        <tr><td>Movie</td><td>Test 2</td><td>1</td><td>  1.00 GiB </td></tr>
      </table>
    `;
    const res = await site.runSeeding();
    expect(res.seeding).toBe(2);
    expect(res.seedingSize).toBe(3 * 1024 ** 3);
  });
});

describe("F0087: Rartracker resolves passkey once per search and safely handles missing user", () => {
  const rarMeta = {
    ...RartrackerSchema,
    id: "rar-test",
    name: "Rar Test",
    urls: ["https://rar.example/"],
  } as any;

  it("aborts immediately on /api/v1/status NeedLoginError with 1 request instead of N-row storm", async () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({
      id: i + 1,
      name: `Release ${i + 1}`,
      size: 1024,
      added: "2024-03-01 10:00:00",
      seeders: 5,
      leechers: 1,
      times_completed: 10,
      comments: 0,
      category: 1,
      frileech: 0,
      reqid: 0,
      p2p: 0,
      swesub: 0,
      pack: 0,
      "3d": 0,
      imdbid2: "",
    }));

    let statusCalls = 0;
    class FailingStatusRar extends Rartracker {
      public override async request<T>(config: any): Promise<any> {
        if (config.url === "/api/v1/status") {
          statusCalls++;
          throw new NeedLoginError("session expired");
        }
        return okResponse(config, rows as T);
      }
    }

    const site = new FailingStatusRar(rarMeta, {});
    const result = await site.getSearchResult("test");

    expect(statusCalls).toBe(1);
    expect(result.status).toBe(EResultParseStatus.needLogin);
  });

  it("does not throw TypeError when /api/v1/status returns { user: null }", async () => {
    class NullUserRar extends Rartracker {
      public override async request<T>(config: any): Promise<any> {
        if (config.url === "/api/v1/status") {
          return okResponse(config, { user: null } as T);
        }
        return okResponse(config, [
          {
            id: 7,
            name: "Item 7",
            size: 1024,
            added: "2024-03-01 10:00:00",
            seeders: 1,
            leechers: 0,
            times_completed: 2,
            comments: 0,
            category: 1,
            frileech: 0,
            reqid: 0,
            p2p: 0,
            swesub: 0,
            pack: 0,
            "3d": 0,
            imdbid2: "",
          },
        ] as T);
      }
    }

    const site = new NullUserRar(rarMeta, {});
    const result = await site.getSearchResult("test");
    expect(result.status).toBe(EResultParseStatus.success);
    expect(result.data).toHaveLength(1);
    expect(result.data[0].link).toBe("https://rar.example/api/v1/torrents/download/7/");
  });
});

describe("F0090, F0096, F0098: Luminance list urlPattern, colonless bonus filter, and seedingSize failure handling", () => {
  it("F0090: list urlPattern matches listing pages and rejects detail pages with id/torrentid", () => {
    const patterns = LuminanceSchema.list![0].urlPattern!.map((p) => new RegExp(p, "i"));
    const matches = (u: string) => patterns.some((re) => re.test(u));

    expect(matches("https://lum.example/torrents.php")).toBe(true);
    expect(matches("https://lum.example/torrents.php?searchstr=foo")).toBe(true);
    expect(matches("https://lum.example/torrents.php?groupid=5")).toBe(true);
    expect(matches("https://lum.example/torrents.php?id=123")).toBe(false);
    expect(matches("https://lum.example/torrents.php?page=1&id=123")).toBe(false);
    expect(matches("https://lum.example/torrents.php?torrentid=456")).toBe(false);
  });

  it("F0096: bonus selector handles both colon-prefixed and colonless values without TypeError", () => {
    const bonusFilter = LuminanceSchema.userInfo!.selectors!.bonus!.filters![0] as (q: string) => number;
    expect(bonusFilter("Credits: 1,234.5")).toBe(1234.5);
    expect(bonusFilter("1,234.5")).toBe(1234.5);
    expect(bonusFilter("0")).toBe(0);
  });

  it("F0098: parseUserInfoForSeedingSize does not leave seedingSize as empty string when mergeSeedingSizeSafely fails", async () => {
    class FailingLum extends Luminance {
      protected override async getSeedingSize(): Promise<any> {
        throw new Error("network down");
      }
      public async runSeedingFallback(info: any) {
        return await this.parseUserInfoForSeedingSize(info, undefined as any);
      }
    }

    const site = new FailingLum({
      ...LuminanceSchema,
      id: "lum-test",
      name: "Lum Test",
      urls: ["https://lum.example/"],
    } as any);

    const res = await site.runSeedingFallback({ id: 42 });
    expect(res.seedingSize).toBeUndefined();
  });
});

describe("F0092: Torznab link and category selectors fall through on empty attributes", () => {
  it("falls through to subsequent selectors when primary attribute/value is empty", () => {
    class TorznabProbe extends Torznab {
      public readField(el: Element, query: any) {
        return this.getFieldData(el, query);
      }
    }

    const site = new TorznabProbe({
      ...TorznabSchema,
      id: "tz-test",
      name: "TZ Test",
      urls: ["https://tz.example/"],
    } as any);

    const xml = new DOMParser().parseFromString(
      `<rss><channel><item>
        <enclosure url="" type="application/x-bittorrent" />
        <link>https://tz.example/download/123</link>
        <attr name="category" value="" />
        <category>2000</category>
      </item></channel></rss>`,
      "text/xml",
    );
    const item = xml.querySelector("item")!;

    expect(site.readField(item, TorznabSchema.search!.selectors!.link)).toBe("https://tz.example/download/123");
    expect(site.readField(item, TorznabSchema.search!.selectors!.category)).toBe(2000);
  });
});

describe("F0093 & F0097: GazelleJSONAPI zero preservation, dropEmptyMisses, and null releaseType", () => {
  const gzJsonMeta = {
    ...GazelleJsonSchema,
    id: "gzjson-test",
    name: "GZ JSON Test",
    urls: ["https://gzjson.example/"],
  } as any;

  it("F0093: preserves numeric 0 in cleanupUserInfo and drops empty misses in base/extend info", async () => {
    class GzJsonProbe extends GazelleJSONAPI {
      public clean(info: any) {
        return this.cleanupUserInfo(info);
      }
      public async runBase() {
        return await this.getUserBaseInfo();
      }
      public override async request<T>(config: any): Promise<any> {
        return okResponse(config, {
          status: "success",
          response: {
            id: 1,
            username: "alice",
            userstats: {
              uploaded: 0,
              downloaded: 0,
              ratio: 0,
              class: "User",
            },
          },
        } as T);
      }
    }

    const site = new GzJsonProbe(gzJsonMeta, {});
    const cleaned = site.clean({
      status: EResultParseStatus.success,
      updateAt: Date.now(),
      site: "gzjson-test",
      bonus: 0,
      bonusPerHour: 0,
      perfectFlacs: 0,
    });
    expect(cleaned.bonus).toBe(0);
    expect(cleaned.bonusPerHour).toBe(0);
    expect(cleaned.perfectFlacs).toBe(0);

    const cleanedEmpty = site.clean({
      status: EResultParseStatus.success,
      updateAt: Date.now(),
      site: "gzjson-test",
      bonus: "" as any,
      bonusPerHour: "" as any,
      perfectFlacs: "" as any,
    });
    expect(cleanedEmpty.bonus).toBeUndefined();
    expect(cleanedEmpty.bonusPerHour).toBeUndefined();
    expect(cleanedEmpty.perfectFlacs).toBeUndefined();

    const baseInfo = await site.runBase();
    expect(baseInfo.id).toBe(1);
    expect(baseInfo.uploaded).toBe(0);
    expect(baseInfo.bonus).toBeUndefined();
  });

  it("F0097: omits [null] from title when group.releaseType is null or empty", async () => {
    class GzJsonProbe extends GazelleJSONAPI {
      public async runTransform(group: any, torrent: any) {
        return await this.transformGroupTorrent(group, torrent);
      }
      protected override async getAuthKey(): Promise<{ authkey: string; passkey: string }> {
        return { authkey: "ak", passkey: "pk" };
      }
    }

    const site = new GzJsonProbe(gzJsonMeta, {});
    const baseTorrent = {
      torrentId: 10,
      format: "FLAC",
      encoding: "Lossless",
      media: "WEB",
      hasLog: false,
      logScore: 0,
      hasCue: false,
      scene: false,
      remastered: false,
      remasterYear: 0,
      remasterTitle: "",
      time: "2024-03-01 10:00:00",
      size: 1000,
      seeders: 2,
      leechers: 0,
      snatches: 5,
      isFreeleech: false,
      isNeutralLeech: false,
      isPersonalFreeleech: false,
    };

    const withoutReleaseType = await site.runTransform(
      {
        groupId: 1,
        groupName: "Test Album",
        artist: "Test Artist",
        cover: "",
        tags: [],
        groupYear: 2024,
        releaseType: null,
        groupTime: "2024-03-01 10:00:00",
      },
      baseTorrent,
    );
    expect(withoutReleaseType.title).toBe("Test Artist - Test Album [2024]");
    expect(withoutReleaseType.title).not.toContain("[null]");

    const withReleaseType = await site.runTransform(
      {
        groupId: 1,
        groupName: "Test Album",
        artist: "Test Artist",
        cover: "",
        tags: [],
        groupYear: 2024,
        releaseType: "Album",
        groupTime: "2024-03-01 10:00:00",
      },
      baseTorrent,
    );
    expect(withReleaseType.title).toBe("Test Artist - Test Album [2024] [Album]");
  });
});
