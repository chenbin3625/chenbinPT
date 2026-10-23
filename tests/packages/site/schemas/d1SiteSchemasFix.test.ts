/**
 * D1（site schemas/types）修复轮回归测试（2026-10-23）。
 *
 * 覆盖：
 * - E12：request() 不再原地修改调用方传入的 axios 配置（Rartracker statusRequestConfig 跨站串用）；
 * - E3-1：request() 拒绝非本站绝对 URL / 协议相对 URL / 外部 baseURL；hdbits/huno 只对本站 URL 注入凭据；
 * - E13/E14：默认登录判据只看 pathname 登录端点 + returnto，不再被搜索关键词/用户名误判；502/504 不再判未登录；
 * - E17：GazelleJSONAPI 用 URL 解析生成链接（用户自定义地址无尾斜杠时不再拼坏主机名）；
 * - E18/E19：getFieldData 不对 name/title 等文本字段做数字强转、保留前导零标识；
 * - E20：NexusPHP 相对时间（5小时前 / 1周前 / 3 hours ago）能换算成时间戳；
 * - E22：getTorrentDownloadLink 不写回 torrent.link（重复调用不会重复追加 downloadLinkAppendix）；
 * - D1-2：GazelleJSONAPI.loadAuthKey 校验 status/response，失败时给出站点真实原因而不是 TypeError；
 * - D1-3：NexusPHP 可选 ajax 空响应不再把 seeding/seedingSize/uploads 写成 0；
 * - D1-4：Gazelle group 行不再被当作种子行解析；
 * - D1-1：AvistazNetwork 搜索 API 的网络错误重新归类为 unknownError（可重试）并执行退避重试。
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  isCloudflareBlocked: vi.fn(() => false),
  sleep: vi.fn(async (_ms?: number) => {}),
  logMessage: vi.fn(),
}));

vi.mock("@ptd/site/utils/adapter.ts", () => ({
  axios: {
    request: mocks.request,
    // fixLink / prepareRequestConfig 会用到 getUri：按 axios 语义拼出最终 URL（无 params 时足够）
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

const makeDoc = (html: string, url = "https://example.com/torrents.php") => {
  const doc = new DOMParser().parseFromString(`<html><body>${html}</body></html>`, "text/html");
  Object.defineProperty(doc, "URL", { value: url, configurable: true });
  return doc;
};

// 冷启动时动态 import 整个 @ptd/site 图可能超过默认 5s 用例超时；先集中预热，避免首个用例偶发超时。
beforeAll(async () => {
  await Promise.all([
    import("@ptd/site/schemas/AbstractBittorrentSite.ts"),
    import("@ptd/site/schemas/AbstractPrivateSite.ts"),
    import("@ptd/site/schemas/NexusPHP.ts"),
    import("@ptd/site/schemas/Gazelle.ts"),
    import("@ptd/site/schemas/GazelleJSONAPI.ts"),
    import("@ptd/site/schemas/AvistazNetwork.ts"),
    import("@ptd/site/schemas/Rartracker.ts"),
    import("@ptd/site/definitions/hdbits.ts"),
    import("@ptd/site/definitions/huno.ts"),
  ]);
}, 60_000);

function okResponse(config: any, data: any = "ok", status = 200) {
  return {
    data,
    status,
    statusText: status === 200 ? "OK" : String(status),
    headers: {},
    config,
    request: {
      responseURL: config?.url
        ? new URL(String(config.url), config.baseURL ?? "https://example.com/").toString()
        : String(config?.baseURL ?? "https://example.com/"),
    },
  };
}

describe("request() 不再原地修改入参 + 同源校验（E12 / E3-1）", () => {
  beforeEach(() => {
    mocks.request.mockReset();
    mocks.sleep.mockReset();
    mocks.sleep.mockResolvedValue(undefined);
    mocks.logMessage.mockReset();
  });

  it("默认值写进拷贝：调用方共享配置的 baseURL/url 保持不变", async () => {
    const { default: BittorrentSite } = await import("@ptd/site/schemas/AbstractBittorrentSite.ts");
    const site = new BittorrentSite({
      id: "clone-test",
      name: "Clone Test",
      type: "public",
      urls: ["https://site.example/"],
    } as any);

    const shared: any = { url: "/torrents.php" };
    mocks.request.mockImplementation(async (config: any) => okResponse(config));

    await site.request(shared, false);

    expect(shared.baseURL).toBeUndefined();
    expect(shared.url).toBe("/torrents.php");
    expect(shared.timeout).toBeUndefined();
  });

  it("Rartracker 两个实例不再共享 statusRequestConfig 的 baseURL / passkey", async () => {
    const { default: Rartracker, statusRequestConfig } = await import("@ptd/site/schemas/Rartracker.ts");

    mocks.request.mockImplementation(async (config: any) => {
      const passkey = String(config.baseURL).includes("superbits") ? "PASSKEY-A" : "PASSKEY-B";
      return okResponse(config, { user: { passkey } });
    });

    class NoStoreRartracker extends Rartracker {
      protected override async retrieveRuntimeSettings<T>(): Promise<T | null> {
        return null;
      }
      protected override async storeRuntimeSettings<T>(_key: string, value: T): Promise<T> {
        return value;
      }
      public load(): Promise<string> {
        return (this as any).loadPassKey();
      }
    }

    const siteA = new NoStoreRartracker({
      id: "superbits",
      name: "Superbits",
      type: "private",
      urls: ["https://superbits.example/"],
    } as any);
    const siteB = new NoStoreRartracker({
      id: "digitalcore",
      name: "DigitalCore",
      type: "private",
      urls: ["https://digitalcore.example/"],
    } as any);

    expect(await siteA.load()).toBe("PASSKEY-A");
    expect(await siteB.load()).toBe("PASSKEY-B");

    // 共享常量必须保持原样（旧实现会被写成第一个站点的 baseURL）
    expect(statusRequestConfig.baseURL).toBeUndefined();
    expect(mocks.request.mock.calls.slice(-2).map((call) => call[0].baseURL)).toEqual([
      "https://superbits.example/",
      "https://digitalcore.example/",
    ]);
  });

  it("拒绝发往站外的绝对 URL（凭据不能带出去）", async () => {
    const { default: BittorrentSite } = await import("@ptd/site/schemas/AbstractBittorrentSite.ts");
    const site = new BittorrentSite({
      id: "guard-test",
      name: "Guard Test",
      type: "private",
      urls: ["https://site.example/"],
    } as any);
    mocks.request.mockImplementation(async (config: any) => okResponse(config));

    await expect(site.request({ url: "https://attacker.example/api/collect" }, false)).rejects.toThrow(
      /untrusted host/,
    );
    await expect(site.request({ url: "//attacker.example/collect" }, false)).rejects.toThrow(/untrusted host/);
    await expect(site.request({ baseURL: "https://attacker.example/", url: "/api/collect" }, false)).rejects.toThrow(
      /untrusted host/,
    );
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("允许本站子域（CDN / api 子域）的绝对 URL", async () => {
    const { default: BittorrentSite } = await import("@ptd/site/schemas/AbstractBittorrentSite.ts");
    const site = new BittorrentSite({
      id: "subdomain-test",
      name: "Subdomain Test",
      type: "private",
      urls: ["https://site.example/"],
    } as any);
    mocks.request.mockImplementation(async (config: any) => okResponse(config));

    await site.request({ url: "https://cdn.site.example/download?id=1" }, false);
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });

  it("兄弟 API 主机默认不放行（避免共享托管域被连带信任），由站点类显式覆写声明", async () => {
    const { default: BittorrentSite } = await import("@ptd/site/schemas/AbstractBittorrentSite.ts");
    const metadata = {
      id: "sibling-test",
      name: "Sibling Test",
      type: "private",
      urls: ["https://kp.example.com/"],
    } as any;
    mocks.request.mockImplementation(async (config: any) => okResponse(config));

    const baseSite = new BittorrentSite(metadata);
    await expect(baseSite.request({ url: "https://api.example.com/x" }, false)).rejects.toThrow(/untrusted host/);

    // 站点声明式兼容（与 definitions/mteam.ts 的覆写同构）：只追加自己推导的 API 主机
    class ApiHostSite extends BittorrentSite {
      protected override get trustedHostnames(): string[] {
        return [...super.trustedHostnames, "api.example.com"];
      }
    }
    const apiSite = new ApiHostSite(metadata);
    await apiSite.request({ url: "https://api.example.com/x" }, false);
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });
});

describe("登录判据（E13 / E14）", () => {
  beforeEach(() => {
    mocks.request.mockReset();
    mocks.sleep.mockReset();
    mocks.sleep.mockResolvedValue(undefined);
    mocks.logMessage.mockReset();
  });

  class CheckSite {
    public site: any;
    constructor(site: any) {
      this.site = site;
    }
    check(res: any) {
      return this.site.loggedCheck(res);
    }
  }

  async function newPrivateSite(metadata: any = {}) {
    const { default: PrivateSite } = await import("@ptd/site/schemas/AbstractPrivateSite.ts");
    return new PrivateSite({
      id: "login-test",
      name: "Login Test",
      type: "private",
      urls: ["https://site.example/"],
      ...metadata,
    } as any);
  }

  function resWith(responseURL: string, status = 200, headers: Record<string, string> = {}) {
    return { status, headers, data: "", request: { responseURL } };
  }

  it("搜索关键词含 Checkpoint / login 不再被判为需要登录", async () => {
    const site = await newPrivateSite();
    const check = new CheckSite(site);

    expect(check.check(resWith("https://site.example/torrents.php?search=Checkpoint&notnewword=1"))).toBe(true);
    expect(check.check(resWith("https://site.example/torrents.php?search=The%20Login"))).toBe(true);
    expect(check.check(resWith("https://site.example/torrents.php?search=verify"))).toBe(true);
  });

  it("Unit3D/Avistaz 用户名恰好叫 verify / login 时不误判", async () => {
    const site = await newPrivateSite();
    const check = new CheckSite(site);

    expect(check.check(resWith("https://site.example/users/verify"))).toBe(true);
    expect(check.check(resWith("https://site.example/profile/login"))).toBe(true);
  });

  it("真正的登录端点仍判为需要登录", async () => {
    const site = await newPrivateSite();
    const check = new CheckSite(site);

    expect(check.check(resWith("https://site.example/login.php"))).toBe(false);
    expect(check.check(resWith("https://site.example/login.php?returnto=%2Ftorrents.php"))).toBe(false);
    expect(check.check(resWith("https://site.example/takelogin.php"))).toBe(false);
    expect(check.check(resWith("https://site.example/userdetails.php?returnto=%2Flogin.php"))).toBe(false);
  });

  it("自定义 urlPatterns 仍按完整 URL 正则匹配（兼容定义）", async () => {
    const site = await newPrivateSite({ noLoginAssert: { urlPatterns: [/takelogin/] } });
    const check = new CheckSite(site);

    expect(check.check(resWith("https://site.example/custom/takelogin-step2"))).toBe(false);
    expect(check.check(resWith("https://site.example/torrents.php"))).toBe(true);
  });

  it("Refresh 头指向登录页时仍判未登录", async () => {
    const site = await newPrivateSite();
    const check = new CheckSite(site);
    expect(
      check.check(resWith("https://site.example/torrents.php", 200, { refresh: "0;url=login.php?returnto=/" })),
    ).toBe(false);
    expect(check.check(resWith("https://site.example/torrents.php", 200, { refresh: "0;url=/torrents.php" }))).toBe(
      true,
    );
  });

  it("502/504 不再判为需要登录，而是可重试的 ServerError", async () => {
    const { ServerError } = await import("@ptd/site/utils/error.ts");
    const { NeedLoginError } = await import("@ptd/site/types.ts");
    const site = await newPrivateSite();
    mocks.request.mockImplementation(async (config: any) => okResponse(config, "", 502));

    await expect(site.request({ url: "/torrents.php" }, true)).rejects.toBeInstanceOf(ServerError);
    await expect(site.request({ url: "/torrents.php" }, true)).rejects.not.toBeInstanceOf(NeedLoginError);

    // 401/403 仍是需要登录
    mocks.request.mockReset();
    mocks.request.mockImplementation(async (config: any) => okResponse(config, "", 401));
    await expect(site.request({ url: "/torrents.php" }, true)).rejects.toBeInstanceOf(NeedLoginError);
  });
});

describe("getFieldData 数字强转（E18 / E19）", () => {
  class ProbeSite {
    public site: any;
    constructor(site: any) {
      this.site = site;
    }
    field(element: any, query: any, key?: string) {
      return key ? this.site.getFieldData(element, query, key) : this.site.getFieldData(element, query);
    }
  }

  async function newProbe() {
    const { default: BittorrentSite } = await import("@ptd/site/schemas/AbstractBittorrentSite.ts");
    const site = new BittorrentSite({
      id: "field-test",
      name: "Field Test",
      type: "public",
      urls: ["https://site.example/"],
    } as any);
    return new ProbeSite(site);
  }

  it("name/title/url 等文本字段即使解析结果是纯数字也保持字符串", async () => {
    const probe = await newProbe();
    const doc = makeDoc(
      `<a class="name" href="/users/123456">123456</a><span class="title">1917</span><span class="link">/download.php?id=1</span>`,
    );

    expect(probe.field(doc, { selector: ["a.name"] }, "name")).toBe("123456");
    expect(probe.field(doc, { selector: ["span.title"] }, "title")).toBe("1917");
    expect(probe.field(doc, { selector: ["span.link"] }, "link")).toBe("/download.php?id=1");
  });

  it("数字字段仍转 number，但带前导零的标识保持字符串", async () => {
    const probe = await newProbe();
    const doc = makeDoc(`<span class="seeders">12</span><span class="id">007</span>`);

    expect(probe.field(doc, { selector: ["span.seeders"] }, "seeders")).toBe(12);
    expect(probe.field(doc, { selector: ["span.id"] }, "id")).toBe("007");
  });

  it("列表页计数类字段（seeders/leechers/completed/comments）零命中在种子对象里归 0，不再是空串", async () => {
    const { default: BittorrentSite } = await import("@ptd/site/schemas/AbstractBittorrentSite.ts");
    class RowSite extends BittorrentSite {
      public async runRow(row: Element, selectors: Record<string, any>) {
        return await this.parseWholeTorrentFromRow({}, row, {
          searchEntry: { selectors: { rows: { selector: ":self" }, ...selectors } },
          requestConfig: { url: "https://site.example/torrents.php" },
        } as any);
      }
    }
    const site = new (RowSite as any)({
      id: "count-fields",
      name: "Count Fields",
      type: "public",
      urls: ["https://site.example/"],
    });
    const row = document.createElement("tr");
    row.innerHTML = `<td class="other">x</td>`;

    const torrent: any = await site.runRow(row, {
      title: { selector: [".missing"], text: "" },
      seeders: { selector: [".missing"] },
      leechers: { selector: [".missing"] },
      completed: { selector: [".missing"] },
      comments: { selector: [".missing"] },
    });

    for (const field of ["seeders", "leechers", "completed", "comments"]) {
      expect(torrent[field], field).toBe(0);
    }
    // 文本字段保持空串（由调用方决定如何降级），引擎 getFieldData 的「零命中 = ""」契约不变
    expect(torrent.title).toBe("");
  });

  it("两参数调用（站点定义历史写法）保持原有数字转换兼容", async () => {
    const probe = await newProbe();
    const doc = makeDoc(`<span class="count">42</span>`);
    expect(probe.field(doc, { selector: ["span.count"] })).toBe(42);
  });

  it("getFieldsData({dropEmptyMisses}) 不写入零命中的空串", async () => {
    const { default: BittorrentSite } = await import("@ptd/site/schemas/AbstractBittorrentSite.ts");
    class FieldsSite extends BittorrentSite {
      public fields(doc: Document, selectors: any) {
        return this.getFieldsData(doc, selectors, undefined, { dropEmptyMisses: true });
      }
    }
    const site = new FieldsSite({
      id: "fields-test",
      name: "Fields Test",
      type: "public",
      urls: ["https://site.example/"],
    } as any);
    const doc = makeDoc(`<span class="uploaded">1 GiB</span>`);

    const data: any = site.fields(doc, {
      uploaded: { selector: [".uploaded"], filters: [{ name: "parseSize" }] },
      downloaded: { selector: [".downloaded"], filters: [{ name: "parseSize" }] },
      bonus: { text: 0 },
    });

    expect(data.uploaded).toBeGreaterThan(0);
    expect(data.downloaded).toBeUndefined();
    (expect(data.bonus) as any).toBe(0);
  });
});

describe("NexusPHP 相对时间（E20）", () => {
  it("5小时前 / 1周前 / 3 hours ago 换算成时间戳；绝对日期保持原串", async () => {
    const { SchemaMetadata } = await import("@ptd/site/schemas/NexusPHP.ts");
    const timeQuery: any = SchemaMetadata.search!.selectors!.time;
    const td = document.createElement("td");

    for (const text of ["5分钟前", "5小时前", "1周前", "3 hours ago", "2 days ago"]) {
      td.textContent = text;
      const value = timeQuery.elementProcess(td);
      expect(typeof value, text).toBe("number");
      expect(value as number, text).toBeGreaterThan(Date.now() - 20 * 24 * 60 * 60 * 1000);
    }

    td.textContent = "2024-03-01 10:00:00";
    expect(timeQuery.elementProcess(td)).toBe("2024-03-01 10:00:00");
  });
});

describe("getTorrentDownloadLink 不再写回 torrent.link（E22）", () => {
  it("带 downloadLinkAppendix 的对象重复调用不会重复追加后缀", async () => {
    const { default: BittorrentSite } = await import("@ptd/site/schemas/AbstractBittorrentSite.ts");
    const site = new BittorrentSite(
      { id: "e22", name: "E22", type: "public", urls: ["https://site.example/"] } as any,
      { downloadLinkAppendix: "&passkey=abc" } as any,
    );
    const torrent: any = { site: "e22", id: 7, link: "https://site.example/dl?id=7" };

    const first = await site.getTorrentDownloadLink(torrent);
    const second = await site.getTorrentDownloadLink(torrent);
    const requestConfig = await site.getTorrentDownloadRequestConfig(torrent);

    const appendix = "&passkey=abc";
    expect(first).toBe(`https://site.example/dl?id=7${appendix}`);
    expect(second).toBe(first);
    expect(requestConfig.url).toBe(first);
    expect(torrent.link).toBe("https://site.example/dl?id=7");
  });
});

describe("GazelleJSONAPI（E17 / D1-2 / E07）", () => {
  class ReqJsonGazelle {
    public static async create(userConfig: any, apiResponse: any = { status: "success" }, captured?: any[]) {
      const { default: GazelleJSONAPI } = await import("@ptd/site/schemas/GazelleJSONAPI.ts");
      class TestGazelleJSONAPI extends GazelleJSONAPI {
        protected override async getAuthKey(): Promise<{ authkey: string; passkey: string }> {
          return { authkey: "AK", passkey: "PK" };
        }
        protected override async requestApiInfo(): Promise<any> {
          return apiResponse;
        }
        protected override async retrieveRuntimeSettings<T>(): Promise<T | null> {
          return null;
        }
        protected override async storeRuntimeSettings<T>(_key: string, value: T): Promise<T> {
          return value;
        }
        public async runTransformUnGroup(group: any) {
          return await (this as any).transformUnGroupTorrent(group);
        }
        public async runGetAuthKey() {
          return await (this as any).getAuthKey();
        }
        public async runLoadAuthKey() {
          return await (this as any).loadAuthKey();
        }
      }

      const site = new (TestGazelleJSONAPI as any)(
        {
          id: "gazelle-json",
          name: "Gazelle JSON",
          type: "private",
          urls: ["https://redacted.example/"],
          userInfo: { selectors: {} },
        },
        userConfig,
      );
      return site;
    }
  }

  const groupTorrent = {
    torrentId: 7,
    groupId: 3,
    groupName: "<b>A</b> &amp; B",
    tags: [],
    groupTime: "2024-03-01 10:00:00",
    size: 100,
    seeders: 1,
    leechers: 2,
    snatches: 3,
    category: "Music",
    isFreeleech: false,
    isPersonalFreeleech: false,
    isNeutralLeech: false,
  };

  it("自定义站点地址没有尾斜杠时仍生成正确主机名的下载/详情链接", async () => {
    const site: any = await ReqJsonGazelle.create({ url: "https://redacted.example" });
    const torrent: any = await site.runTransformUnGroup(groupTorrent);

    expect(torrent.url).toBe("https://redacted.example/torrents.php?id=3&torrentid=7");
    expect(torrent.link).toBe("https://redacted.example/torrents.php?action=download&id=7&authkey=AK&torrent_pass=PK");
    expect(site.isTrustedDownloadLink(torrent.link)).toBe(true);
  });

  it("标题里的 HTML 只是被解码为文本（不会被写进活动文档）", async () => {
    const site: any = await ReqJsonGazelle.create({ url: "https://redacted.example/" });
    const torrent: any = await site.runTransformUnGroup(groupTorrent);
    expect(torrent.title).toBe("A & B");
  });

  it("index 返回 status: failure 时抛出站点真实错误，而不是 TypeError", async () => {
    const site: any = await ReqJsonGazelle.create(
      { url: "https://redacted.example/" },
      { status: "failure", error: "Your account is disabled" },
    );

    // 直接测 loadAuthKey（getAuthKey 在该测试子类里被覆写为返回固定凭据）
    await expect(site.runLoadAuthKey()).rejects.toThrow("Your account is disabled");
    await expect(site.runLoadAuthKey()).rejects.not.toThrow(/Cannot read properties/);
  });
});

describe("NexusPHP 可选 ajax 空响应（D1-3）", () => {
  class ProbeNexus {
    public static async create(body: string | null) {
      const { default: NexusPHP } = await import("@ptd/site/schemas/NexusPHP.ts");
      class TestNexus extends NexusPHP {
        public override async request<T>(): Promise<any> {
          return { data: body, status: 200, statusText: "OK", headers: {}, config: {}, request: {} };
        }
        public runSeeding(id = 1) {
          return (this as any).parseUserInfoForSeedingStatus({ id });
        }
        public runUploads(id = 1) {
          return (this as any).parseUserInfoForUploads({ id });
        }
      }
      return new (TestNexus as any)({
        id: "nexus-empty",
        name: "Nexus Empty",
        type: "private",
        urls: ["https://pt.example.com/"],
        timezoneOffset: "+0800",
        userInfo: { process: [] },
        search: {},
      });
    }
  }

  it("空响应 → 明确失败（交给可选步骤守卫），不把 seeding/seedingSize 写成 0", async () => {
    const site: any = await ProbeNexus.create("");
    await expect(site.runSeeding()).rejects.toThrow(/empty response/);
    await expect(site.runUploads()).rejects.toThrow(/empty response/);
  });

  it("明确的「没有记录」仍然得到真实的 0", async () => {
    const seedingSite: any = await ProbeNexus.create("No record.");
    await expect(seedingSite.runSeeding()).resolves.toEqual({ id: 1, seeding: 0, seedingSize: 0 });

    const uploadsSite: any = await ProbeNexus.create("No record.");
    await expect(uploadsSite.runUploads()).resolves.toEqual({ id: 1, uploads: 0 });
  });

  it("正常表格响应仍按原逻辑解析", async () => {
    const site: any = await ProbeNexus.create(
      `<table><tr><td>head</td></tr><tr><td>a</td><td>b</td><td>1 GB</td></tr><tr><td>c</td><td>d</td><td>2 GB</td></tr></table>`,
    );
    const result: any = await site.runSeeding();
    expect(result.seeding).toBe(2);
    expect(result.seedingSize).toBe(3 * 1024 ** 3);
  });
});

describe("Gazelle group 行不再被当作种子行（D1-4）", () => {
  it("每个 group 只解析其子行，失败计数不再被 group 行抬高", async () => {
    const { default: Gazelle, SchemaMetadata } = await import("@ptd/site/schemas/Gazelle.ts");
    {
      const doc = makeDoc(`
        <table class="torrent_table">
          <tr><td>head</td></tr>
          <tr class="group"><td><a href="torrents.php?id=1&torrentid=11">Group Name</a></td></tr>
          <tr class="group_torrent groupid_1"><td><a href="torrents.php?action=download&id=11&authkey=AK&torrent_pass=PK">DL</a></td></tr>
          <tr class="group_torrent groupid_1"><td><a href="torrents.php?action=download&id=12&authkey=AK&torrent_pass=PK">DL</a></td></tr>
        </table>
      `);

      class TestGazelle extends Gazelle {
        public get failures() {
          return (this as any)._searchRowFailures as number;
        }
      }
      const site = new (TestGazelle as any)(
        {
          ...(SchemaMetadata as any),
          id: "gazelle-group",
          name: "Gazelle Group",
          type: "private",
          urls: ["https://gz.example/"],
          timezoneOffset: "+0000",
          userInfo: {},
        },
        {},
      );

      const torrents = await site.transformSearchPage(doc, {
        keywords: "",
        searchEntry: { selectors: SchemaMetadata.search!.selectors! },
        requestConfig: { url: "https://gz.example/torrents.php" },
      });

      expect(torrents).toHaveLength(2);
      expect(torrents.map((t: any) => String(t.id)).sort()).toEqual(["11", "12"]);
      expect(site.failures).toBe(0);
    }
  });
});

describe("Avistaz 搜索 API 的错误分类与重试（D1-1）", () => {
  beforeEach(() => {
    mocks.request.mockReset();
    mocks.sleep.mockReset();
    mocks.sleep.mockResolvedValue(undefined);
    mocks.logMessage.mockReset();
  });

  it("网络错误 → unknownError（可重试），并执行 1+2 次退避重试", async () => {
    const { default: AvistazNetwork } = await import("@ptd/site/schemas/AvistazNetwork.ts");
    const { EResultParseStatus } = await import("@ptd/site/types.ts");

    class TokenAvz extends AvistazNetwork {
      protected override async retrieveRuntimeSettings<T>(key: string): Promise<T | null> {
        if (key === "authToken") return "TOKEN" as any;
        if (key === "authExpiry") return (Math.floor(Date.now() / 1000) + 3600) as any;
        return null;
      }
      protected override async storeRuntimeSettings<T>(_key: string, value: T): Promise<T> {
        return value;
      }
    }

    const site = new (TokenAvz as any)(
      {
        id: "avz",
        name: "AvistaZ",
        type: "private",
        urls: ["https://avz.example/"],
        timezoneOffset: "-0400",
        search: {
          keywordPath: "params.search",
          requestConfig: { url: "/api/v1/jackett/torrents", responseType: "json" },
        },
      },
      {},
    );

    mocks.request.mockRejectedValue(Object.assign(new Error("Network Error"), { isAxiosError: true }));

    const result = await site.getSearchResult("dune");

    expect(result.status).toBe(EResultParseStatus.unknownError);
    expect(result.statusMsg).toBe("Network Error: Network Error");
    expect(mocks.request).toHaveBeenCalledTimes(3);
    // 指数退避：500ms、1000ms
    expect(mocks.sleep.mock.calls.map((c: any) => c[0])).toEqual([500, 1000]);
  });
});

describe("hdbits / huno 只对本站 URL 注入凭据（E3-1）", () => {
  beforeEach(() => {
    mocks.request.mockReset();
    mocks.sleep.mockReset();
    mocks.sleep.mockResolvedValue(undefined);
    mocks.logMessage.mockReset();
  });

  it("hdbits：外站绝对 URL 被拒绝且不注入 username/passkey", async () => {
    const { default: HDBits } = await import("@ptd/site/definitions/hdbits.ts");
    const site = new (HDBits as any)(
      {
        id: "hdbits",
        name: "HDBits",
        type: "private",
        urls: ["https://hdbits.org/"],
        timezoneOffset: "+0000",
        userInfo: {},
      },
      { inputSetting: { username: "user", passkey: "secret-passkey" } },
    );
    mocks.request.mockImplementation(async (config: any) => okResponse(config, { status: 0 }));

    await expect(site.request({ url: "https://attacker.example/api/collect" }, false)).rejects.toThrow(
      /untrusted host/,
    );
    expect(mocks.request).not.toHaveBeenCalled();

    // 本站 /api/ 路径才注入凭据
    await site.request({ url: "/api/torrents" }, false);
    const sentConfig = mocks.request.mock.calls[0][0];
    expect(sentConfig.data).toMatchObject({ username: "user", passkey: "secret-passkey" });
    expect(sentConfig.method).toBe("POST");
  });

  it("hdbits：站内非 /api/ 路径不注入凭据", async () => {
    const { default: HDBits } = await import("@ptd/site/definitions/hdbits.ts");
    const site = new (HDBits as any)(
      {
        id: "hdbits",
        name: "HDBits",
        type: "private",
        urls: ["https://hdbits.org/"],
        timezoneOffset: "+0000",
        userInfo: {},
      },
      { inputSetting: { username: "user", passkey: "secret-passkey" } },
    );
    mocks.request.mockImplementation(async (config: any) => okResponse(config, "<html></html>"));

    await site.request({ url: "/details.php?id=1" }, false);
    const sentConfig = mocks.request.mock.calls[0][0];
    expect(sentConfig.data).toBeUndefined();
  });

  it("huno：外站绝对 URL 被拒绝且不发送 X-Api-Token", async () => {
    const { default: HUNO } = await import("@ptd/site/definitions/huno.ts");
    const site = new (HUNO as any)(
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
    mocks.request.mockImplementation(async (config: any) => okResponse(config, { status: "success" }));

    await expect(site.request({ url: "https://attacker.example/api/x" }, false)).rejects.toThrow(/untrusted host/);
    expect(mocks.request).not.toHaveBeenCalled();

    await site.request({ url: "/api/profile" }, false);
    const sentConfig = mocks.request.mock.calls[0][0];
    expect(sentConfig.headers["X-Api-Token"]).toBe("secret-token");
    // fix2 并发变更（task-14 huno E3b I-4）：Origin 是浏览器禁止脚本设置的请求头，
    // huno 定义已删除该字段；这里改为断言「不再设置 origin」，凭据注入本身不变。
    expect(sentConfig.headers.origin).toBeUndefined();
  });
});

describe("torrent.id 空串兜底（DEF1/DEF5 根因）", () => {
  it("id selector 命中但取到空串时，回落到 url/link 作为 id（旧 `??=` 会让 uniqueId 塌缩）", async () => {
    const { default: BittorrentSite } = await import("@ptd/site/schemas/AbstractBittorrentSite.ts");
    class RowSite extends BittorrentSite {
      public async runRow(row: Element, selectors: Record<string, any>) {
        return await this.parseWholeTorrentFromRow({}, row, {
          searchEntry: { selectors: { rows: { selector: ":self" }, ...selectors } },
          requestConfig: { url: "https://site.example/torrents.php" },
        } as any);
      }
    }
    const site = new (RowSite as any)({
      id: "id-fallback",
      name: "Id Fallback",
      type: "public",
      urls: ["https://site.example/"],
    });
    const row = document.createElement("tr");
    row.innerHTML = `<td><a class="empty-id"></a></td>`;

    const torrent: any = await site.runRow(row, {
      id: { selector: ["a.empty-id"], text: "" },
      url: { text: "https://site.example/details.php?id=9" },
    });

    expect(torrent.id).toBe("https://site.example/details.php?id=9");
  });
});

describe("huno 等级与未读数（E3b-B3 / E3-17）", () => {
  it("等级名全等命中已知等级；未命中返回 -1 而不是被兜底成最高级", async () => {
    const { default: Huno, siteMetadata } = await import("@ptd/site/definitions/huno.ts");
    const site = new (Huno as any)(siteMetadata, { inputSetting: { token: "t" } });

    expect((site as any).guessUserLevelId({ levelName: "Targaryen" })).toBe(6);
    expect((site as any).guessUserLevelId({ levelName: "Iron Fleet" })).toBe(2);
    expect((site as any).guessUserLevelId({ levelName: "Iron Fleet (New)" })).toBe(-1);
    expect((site as any).guessUserLevelId({ levelName: "" })).toBe(-1);
  });

  it("messageCount 不再用魔数 11：0-9 取数字、plus 形态记 10、认不出回落文本/0", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/huno.ts");
    const elementProcess = (siteMetadata.userInfo as any).selectors.messageCount.elementProcess as (
      el: Element,
    ) => number;

    const make = (html: string) => {
      const span = document.createElement("span");
      span.innerHTML = html;
      return span;
    };

    expect(elementProcess(make(`<i class="fa-square-7"></i>`))).toBe(7);
    expect(elementProcess(make(`<i class="fa-square-plus"></i>`))).toBe(10);
    expect(elementProcess(make(`<i class="fa-square"></i>`))).toBe(10);
    expect(elementProcess(make(`<i class="fa-bell"></i>12`))).toBe(12);
    expect(elementProcess(make(`<i class="fa-bell"></i>`))).toBe(0);
  });
});
