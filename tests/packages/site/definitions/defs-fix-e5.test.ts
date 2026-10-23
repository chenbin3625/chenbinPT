/**
 * defs-fix-e5：E5 / E5b（站点定义第 5 组）审查问题的行为回归（不发真实网络请求）。
 *
 * 断言对象是**真实站点定义 + 真实引擎/生成器**，不是「源码里存在某个字符串」：
 * - pttime / qingwa / skyeysnow / pornolab / rousipro / speedapp / sjtu 走真实引擎方法，
 *   只把 `request`（或受保护的可选请求方法）换成可控桩；
 * - rutracker 用真实的 `requestConfigTransformer`；
 * - soulvoice / rastastugan 用真实的 `buildSearchSolutionFromCategories` 生成请求参数；
 * - 其余为元数据断言（等级名 / legacyUrls / collaborator / tags / isDonor 字段）。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// 站点模块会连带引入平台适配层（messages.ts 用到 __BROWSER__ 与 chrome API），
// 因此必须在 import 之前把全局桩准备好 —— vi.hoisted 的回调先于所有 import 执行。
vi.hoisted(() => {
  (globalThis as any).__BROWSER__ ??= "chrome";
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
    downloads: { download: () => Promise.resolve(1) },
    tabs: { create: () => Promise.resolve(), query: () => Promise.resolve([]) },
  };
});

const mocks = vi.hoisted(() => ({ logMessage: vi.fn() }));

// 统一日志出口换成 spy，既避免真实 sendMessage，也让「失败要留痕」可断言。
vi.mock("@ptd/site/utils/adapter.ts", () => ({
  // fixLink 会用 axios.getUri(requestConfig) 还原相对链接的基点，这里给出与生产一致的形态
  axios: {
    request: vi.fn(),
    getUri: vi.fn((config: any) => `${config?.baseURL ?? "https://example.test"}${config?.url ?? "/"}`),
  },
  isCloudflareBlocked: vi.fn(() => false),
  retrieve: vi.fn(async () => null),
  retrieveStore: vi.fn(async () => null),
  cookie: vi.fn(async () => null),
  sleep: vi.fn(async () => {}),
  store: vi.fn(async () => {}),
  logMessage: mocks.logMessage,
}));

import PrivateSite from "@ptd/site/schemas/AbstractPrivateSite.ts";
import { EResultParseStatus } from "@ptd/site/types.ts";
import { parseSizeString } from "@ptd/site/utils.ts";

import Pttime, { siteMetadata as pttimeMetadata } from "@ptd/site/definitions/pttime.ts";
import QingWa, { siteMetadata as qingwaMetadata } from "@ptd/site/definitions/qingwa.ts";
import Skyeysnow, { siteMetadata as skyeysnowMetadata } from "@ptd/site/definitions/skyeysnow.ts";
import RousiPro, { siteMetadata as rousiproMetadata } from "@ptd/site/definitions/rousipro.ts";
import SpeedApp, { siteMetadata as speedappMetadata } from "@ptd/site/definitions/speedapp.ts";
import Sjtu, { siteMetadata as sjtuMetadata } from "@ptd/site/definitions/sjtu.ts";
import { siteMetadata as pornolabMetadata } from "@ptd/site/definitions/pornolab.ts";
import { siteMetadata as rutrackerMetadata } from "@ptd/site/definitions/rutracker.ts";
import { siteMetadata as redleavesMetadata } from "@ptd/site/definitions/redleaves.ts";
import { siteMetadata as soulvoiceMetadata } from "@ptd/site/definitions/soulvoice.ts";
import { siteMetadata as rastastuganMetadata } from "@ptd/site/definitions/rastastugan.ts";
import { siteMetadata as retroflixMetadata } from "@ptd/site/definitions/retroflix.ts";
import { siteMetadata as ptfansMetadata } from "@ptd/site/definitions/ptfans.ts";
import { siteMetadata as ptgtkMetadata } from "@ptd/site/definitions/ptgtk.ts";
import { siteMetadata as ptlspMetadata } from "@ptd/site/definitions/ptlsp.ts";
import { siteMetadata as pt99Metadata } from "@ptd/site/definitions/pt99.ts";

import { buildSearchSolutionFromCategories } from "@/options/utils/searchSolutionConfig.ts";

const makeDoc = (html: string) => new DOMParser().parseFromString(`<html><body>${html}</body></html>`, "text/html");

const createSite = (SiteClass: unknown, metadata: unknown, userConfig: Record<string, unknown> = {}) =>
  new (SiteClass as any)({ ...(metadata as any) }, userConfig);

const BASE_URL = "https://example.test";

// happy-dom 的 DOMParser 产物不是 vitest 全局 Document 的实例，而 transformSearchPage 用
// `doc instanceof Document` 决定走 DOM 还是 JSON 分支（否则会当成 JSON 上下文取不到行）。
// 把全局 Document 指向 happy-dom 实际使用的构造函数，才能覆盖真实的列表解析路径。
beforeAll(() => {
  vi.stubGlobal("Document", (document as any).constructor);
});

afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  mocks.logMessage.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// E5-1 / E5b-1：pttime 的 id 必须是从 download.php?id= 派生的数字
// ---------------------------------------------------------------------------
describe("E5-1：pttime 种子 id（回归：attr:'data' 取不到 → 空串 → 整页被去重成 1 条）", () => {
  const torrentRow = (id: number, name: string) => `
    <tr>
      <td><span class="category" title="Movies">Movies</span></td>
      <td>
        <a href="/details.php?id=${id}&amp;hit=1" title="${name}">${name}</a>
        <a href="/download.php?id=${id}">dl</a>
      </td>
    </tr>`;

  it("两行结果得到两个不同的数字 id（而不是同一个空串）", async () => {
    const doc = makeDoc(`
      <table class="torrents"><tbody>
        <tr><td>header</td></tr>
        ${torrentRow(101, "Movie A")}
        ${torrentRow(102, "Movie B")}
      </tbody></table>`);

    const site = createSite(Pttime, pttimeMetadata);
    const torrents = await site.transformSearchPage(doc, {
      searchEntry: pttimeMetadata.search,
      requestConfig: { url: "/torrents.php", baseURL: BASE_URL },
      keywords: "",
    });

    expect(torrents).toHaveLength(2);
    expect(torrents.map((torrent: any) => torrent.id)).toEqual([101, 102]);
    expect(torrents.every((torrent: any) => typeof torrent.id === "number")).toBe(true);
    // 回归探针：唯一键是 `${site}-${id}`，id 相同就会被上层静默去重
    expect(new Set(torrents.map((torrent: any) => torrent.id)).size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// E5-8：pttime / qingwa 的 seeding 零命中不能把 "" 当数值写进 IUserInfo
// ---------------------------------------------------------------------------
describe("E5-8：做种数/做种体积的零命中回落", () => {
  it("pttime：零命中时 seeding / seedingSize 是数字 0（旧实现得到空串）", async () => {
    const site = createSite(Pttime, pttimeMetadata);
    (site as any).requestUserSeedingPage = vi.fn(async () => "<table></table>");

    const info = await (site as any).parseUserInfoForSeedingStatus({ id: 1 });

    expect(info.seeding).toBe(0);
    expect(info.seedingSize).toBe(0);
    expect(typeof info.seeding).toBe("number");
    expect(typeof info.seedingSize).toBe("number");
  });

  it("pttime：正常页面仍解析出数字做种数与体积", async () => {
    const site = createSite(Pttime, pttimeMetadata);
    (site as any).requestUserSeedingPage = vi.fn(
      async () =>
        '<table><tr><td id="outer"><span>a</span><span>b</span><span><b>7</b></span><span>1.5 GB</span></td></tr></table>',
    );

    const info = await (site as any).parseUserInfoForSeedingStatus({ id: 1 });

    expect(info.seeding).toBe(7);
    expect(info.seedingSize).toBe(1.5 * 1024 ** 3);
  });

  it("qingwa：零命中时 seeding / seedingSize 是数字 0（旧实现得到空串）", async () => {
    const site = createSite(QingWa, qingwaMetadata);
    (site as any).requestUserSeedingPage = vi.fn(async () => "<table></table>");

    const info = await (site as any).parseUserInfoForSeedingStatus({ id: 2 });

    expect(info.seeding).toBe(0);
    expect(info.seedingSize).toBe(0);
    expect(typeof info.seeding).toBe("number");
    expect(typeof info.seedingSize).toBe("number");
  });

  it("qingwa：正常页面仍解析出数字做种数与体积", async () => {
    const site = createSite(QingWa, qingwaMetadata);
    (site as any).requestUserSeedingPage = vi.fn(
      async () => '<table><tr><td><span id="total_count">5</span><span id="total_size">1.5 GB</span></td></tr></table>',
    );

    const info = await (site as any).parseUserInfoForSeedingStatus({ id: 2 });

    expect(info.seeding).toBe(5);
    expect(info.seedingSize).toBe(1.5 * 1024 ** 3);
  });
});

// ---------------------------------------------------------------------------
// E5-2：pornolab 的做种体积必须按带单位文本解析，而不是 parseInt
// ---------------------------------------------------------------------------
describe("E5-2：pornolab 做种体积（回归：parseInt('1.5 GB') === 1）", () => {
  it("两行 '1.5 GB' + '742 MB' 得到字节数，而不是 1+742", () => {
    const doc = makeDoc(`
      <table id="t-seed"><tbody>
        <tr><td>1</td><td>2</td><td>3</td><td>4</td><td>5</td><td><u>1.5 GB</u></td></tr>
        <tr><td>1</td><td>2</td><td>3</td><td>4</td><td>5</td><td><u>742 MB</u></td></tr>
      </tbody></table>`);
    const tbody = doc.querySelector("#t-seed > tbody")!;
    const seedingSizeQuery = pornolabMetadata.userInfo!.process![1].selectors!.seedingSize as any;

    const seedingSize = seedingSizeQuery.elementProcess(tbody);

    expect(seedingSize).toBe(parseSizeString("1.5 GB") + parseSizeString("742 MB"));
    expect(seedingSize).toBe(1.5 * 1024 ** 3 + 742 * 1024 ** 2);
    // 回归探针：旧实现的 parseInt 会得到 1 + 742
    expect(seedingSize).not.toBe(743);
  });
});

// ---------------------------------------------------------------------------
// E5-3 / E5-4 / E5b-2 / E5b-4：skyeysnow 的 uploads 与追加请求健壮性
// ---------------------------------------------------------------------------
const skyeTorrentRow = (tid: number, size: string) => `
  <tr>
    <td>Movie</td>
    <td>
      <a title="Torrent ${tid}" href="/forum.php?mod=viewthread&tid=${tid}">Torrent ${tid}</a>
      <a href="/download.php?id=${tid}">dl</a>
    </td>
    <td>2024-01-01 00:00:00</td>
    <td>${size}</td>
    <td>5</td>
    <td>2</td>
    <td>3</td>
    <td>author</td>
  </tr>`;

const skyeTorrentPage = (rows: string, extra = "") =>
  makeDoc(`
  ${extra}
  <table class="torrents"><tbody>
    <tr><td>header</td></tr>
    ${rows}
  </tbody></table>`);

/** 构造 skyeysnow 实例，并把追加请求的关键两步（super 解析 / request）替换成可控桩 */
function createSkyeInstance() {
  const metadata = {
    ...(skyeysnowMetadata as any),
    userInfo: { ...skyeysnowMetadata.userInfo!, requestDelay: 0 },
  };
  const site = new Skyeysnow(metadata, {}) as any;
  vi.spyOn(PrivateSite.prototype, "getUserInfoResult").mockResolvedValue({
    site: "skyeysnow",
    id: 123,
    name: "tester",
    uploaded: 100,
    status: EResultParseStatus.success,
  } as any);
  return site;
}

/** 模拟 request() 在生产环境的行为：补 baseURL（fixLink 依赖它构造绝对地址） */
function stubSkyeRequest(site: any, respond: (config: any, callIndex: number) => Document | Promise<Document>) {
  let callIndex = 0;
  const request = vi.fn(async (config: any) => {
    config.baseURL ??= BASE_URL;
    return { data: await respond(config, callIndex++) };
  });
  site.request = request;
  return request;
}

describe("E5-3 / E5b-2：skyeysnow 的 uploads", () => {
  it("只有一页（页面上没有分页控件）时按列表行数得到发布数，而不是 0", async () => {
    const seedingPage = skyeTorrentPage(skyeTorrentRow(11, "1 GB"));
    const uploadsPage = skyeTorrentPage(skyeTorrentRow(21, "2 GB") + skyeTorrentRow(22, "3 GB"));

    const site = createSkyeInstance();
    const request = stubSkyeRequest(site, (_config, callIndex) => (callIndex === 0 ? seedingPage : uploadsPage));

    const info = await site.getUserInfoResult({});

    expect(info.status).toBe(EResultParseStatus.success);
    expect(info.uploaded).toBe(100); // super 已解析的字段必须保留
    expect(info.seeding).toBe(1);
    expect(info.seedingSize).toBe(1024 ** 3);
    expect(info.uploads).toBe(2);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("多页时保留分页区间末端的语义（21-30 → 30）", async () => {
    const seedingPage = skyeTorrentPage(skyeTorrentRow(11, "1 GB"));
    const uploadsPage = makeDoc(
      `<a onclick="javascript:ajax_refreash('/torrents_list_ajax.php?mod=torrents&diy=&page=2',)">21-30</a>`,
    );

    const site = createSkyeInstance();
    stubSkyeRequest(site, (_config, callIndex) => (callIndex === 0 ? seedingPage : uploadsPage));

    const info = await site.getUserInfoResult({});

    expect(info.uploads).toBe(30);
  });
});

describe("E5-4 / E5b-4：skyeysnow 追加请求的失败隔离与翻页边界", () => {
  it("uploads 请求失败时只记 warn，保留已解析的用户信息（不 reject、不写假 0）", async () => {
    const seedingPage = skyeTorrentPage(skyeTorrentRow(11, "1 GB"));

    const site = createSkyeInstance();
    stubSkyeRequest(site, (_config, callIndex) => {
      if (callIndex === 0) return seedingPage;
      throw new Error("boom");
    });

    const info = await site.getUserInfoResult({});

    expect(info.status).toBe(EResultParseStatus.success);
    expect(info.uploaded).toBe(100);
    expect(info.seeding).toBe(1);
    expect(info.uploads).toBeUndefined();

    expect(mocks.logMessage).toHaveBeenCalledTimes(1);
    const [msg, data, level] = mocks.logMessage.mock.calls[0];
    expect(String(msg)).toContain("parseUserInfoForUploads failed");
    expect(data.site).toBe("skyeysnow");
    expect(data.error.message).toBe("boom");
    expect(level).toBe("warn");
  });

  it("seeding 请求失败时同样只记 warn，且不把 seeding/seedingSize 伪造成 0", async () => {
    const uploadsPage = skyeTorrentPage(skyeTorrentRow(21, "2 GB"));

    const site = createSkyeInstance();
    stubSkyeRequest(site, (_config, callIndex) => {
      if (callIndex === 0) throw new Error("network down");
      return uploadsPage;
    });

    const info = await site.getUserInfoResult({});

    expect(info.status).toBe(EResultParseStatus.success);
    expect(info.uploaded).toBe(100);
    expect(info.seeding).toBeUndefined();
    expect(info.seedingSize).toBeUndefined();
    expect(info.uploads).toBe(1);

    const [msg, , level] = mocks.logMessage.mock.calls[0];
    expect(String(msg)).toContain("parseUserInfoForSeedingStatus failed");
    expect(level).toBe("warn");
  });

  it("页码从 1 开始，且异常大的页码被 maxPageCount 截断（不再无上限串行请求）", async () => {
    const pagerPage = skyeTorrentPage(
      skyeTorrentRow(11, "1 GB"),
      `<a onclick="javascript:ajax_refreash('/torrents_list_ajax.php?mod=torrents&diy=&page=999',)">1-20</a>`,
    );
    const uploadsPage = skyeTorrentPage(skyeTorrentRow(21, "2 GB"));

    const site = createSkyeInstance();
    const request = stubSkyeRequest(site, (config) =>
      typeof config.params?.page !== "undefined" ? pagerPage : uploadsPage,
    );

    const info = await site.getUserInfoResult({});

    // 50 页 seeding + 1 次 uploads
    expect(request).toHaveBeenCalledTimes(51);
    expect(request.mock.calls[0][0].params.page).toBe(1);
    expect(info.seeding).toBe(50);
    expect(info.uploads).toBe(1);

    const truncationLog = mocks.logMessage.mock.calls.find(([msg]) => String(msg).includes("seeding pages truncated"));
    expect(truncationLog).toBeTruthy();
    expect(truncationLog![1]).toMatchObject({ site: "skyeysnow", pageCount: 999, maxPageCount: 50 });
  });
});

// ---------------------------------------------------------------------------
// E5-5：rousipro 的 download_url 为空必须抛错
// ---------------------------------------------------------------------------
describe("E5-5：rousipro download_url 为空时显式失败", () => {
  it("download_url 为空串（未购买/缺 scope）→ reject 并说明原因", async () => {
    const site = createSite(RousiPro, rousiproMetadata);
    (site as any).request = vi.fn(async () => ({
      data: { code: 0, message: "", data: { id: 42, download_url: "", is_purchased: false } },
    }));

    await expect((site as any).getTorrentDownloadLink({ id: 42, site: "rousipro" })).rejects.toThrow(
      /download_url unavailable/,
    );
    await expect((site as any).getTorrentDownloadLink({ id: 42, site: "rousipro" })).rejects.toThrow(/torrentId=42/);
  });

  it("download_url 正常时返回签名链接并按配置追加后缀", async () => {
    const site = createSite(RousiPro, rousiproMetadata, { downloadLinkAppendix: "&passkey=x" });
    (site as any).request = vi.fn(async () => ({
      data: { code: 0, message: "", data: { id: 42, download_url: "https://api.example/dl/abc" } },
    }));

    const link = await (site as any).getTorrentDownloadLink({ id: 42, site: "rousipro" });

    expect(link).toBe("https://api.example/dl/abc&passkey=x");
  });
});

// ---------------------------------------------------------------------------
// E5-12：speedapp 中间页取不到链接必须抛错
// ---------------------------------------------------------------------------
describe("E5-12：speedapp 中间页解析失败显式抛错", () => {
  it("中间页没有 `a.btn[href^='/torrents/']` 时 reject（不再返回空串）", async () => {
    const site = createSite(SpeedApp, speedappMetadata);
    (site as any).request = vi.fn(async () => ({ data: makeDoc("<p>nope</p>") }));

    await expect(
      (site as any).getTorrentDownloadLink({
        id: 7,
        site: "speedapp",
        link: `${BASE_URL}/download/abc`,
      }),
    ).rejects.toThrow(/cannot resolve torrent download link/);
  });

  it("中间页有真实链接时返回该链接", async () => {
    const site = createSite(SpeedApp, speedappMetadata);
    (site as any).request = vi.fn(async () => ({
      data: makeDoc(`<a class="btn" href="/torrents/123/download">download</a>`),
    }));

    const link = await (site as any).getTorrentDownloadLink({
      id: 7,
      site: "speedapp",
      link: `${BASE_URL}/download/abc`,
    });

    expect(link).toBe("/torrents/123/download");
  });
});

// ---------------------------------------------------------------------------
// E5-6：rutracker 关键词里的连字符要全部替换
// ---------------------------------------------------------------------------
describe("E5-6：rutracker 关键词连字符（回归：replace('-') 只替换第一处）", () => {
  const transform = (keywords: string) => {
    const requestConfig = { params: { keywords } as Record<string, unknown> };
    const out = (rutrackerMetadata.search as any).requestConfigTransformer({ keywords, requestConfig });
    return out.params as Record<string, any>;
  };

  it("Spider-Man-No-Way-Home 的连字符全部变成空格", () => {
    const params = transform("Spider-Man-No-Way-Home");

    expect(params.nm).toBe("Spider Man No Way Home");
    expect(params.nm).not.toContain("-");
    expect(params).not.toHaveProperty("keywords");
  });

  it("S01E02 季集信息在连字符归一化后仍被识别", () => {
    const params = transform("Show-S01E02");

    expect(params.nm).toContain("Сезон: 1");
    expect(params.nm).toContain("Серии: 2");
  });
});

// ---------------------------------------------------------------------------
// E5-7 / E5b-7：redleaves 等级名不得残留 PTer 的猫系命名
// ---------------------------------------------------------------------------
describe("E5-7：redleaves 等级名", () => {
  it("最高级为 Nexus Master（不含 PTer 的『四川简州猫』）", () => {
    const levels = redleavesMetadata.levelRequirements!;
    const top = levels.find((level) => level.id === 9)!;

    expect(top.name).toBe("Nexus Master");
    expect(levels.some((level) => /[\u4e00-\u9fa5]/.test(level.name ?? ""))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// E5-11：soulvoice 的 processing 组用 append 而不是 brackets
// ---------------------------------------------------------------------------
describe("E5-11：soulvoice 类别参数（回归：brackets → processing[]=13）", () => {
  it("勾选两个类别生成 processing13=1 & processing12=1（不是数组参数）", () => {
    const { requestConfig: entriesConfig } = buildSearchSolutionFromCategories(soulvoiceMetadata.category!, {
      processing: [13, 12],
    });
    const params = entriesConfig.requestConfig?.params ?? {};

    expect(params).toMatchObject({ processing13: 1, processing12: 1 });
    expect(params).not.toHaveProperty("processing[]");
    expect(Array.isArray((params as any).processing)).toBe(false);
  });

  it("processing 组的 cross 模式与同文件其它标准组一致为 append", () => {
    const group = soulvoiceMetadata.category!.find((category) => category.key === "processing")!;
    expect((group as any).cross).toEqual({ mode: "append" });
  });
});

// ---------------------------------------------------------------------------
// E5b-3：rastastugan 的 categoryIds 合并为单组，跨组多选不再互相覆盖
// ---------------------------------------------------------------------------
describe("E5b-3：rastastugan 分类多选（回归：两组共享 cross.key，后一组覆盖前一组）", () => {
  it("同时勾 Movies(1) 与 App(4) 时两个条件都进入参数", () => {
    const { requestConfig: entriesConfig } = buildSearchSolutionFromCategories(rastastuganMetadata.category!, {
      categoryIds: [1, 4],
    });
    const params = entriesConfig.requestConfig?.params ?? {};

    expect(params).toMatchObject({ categoryIds: [1, 4] });
  });

  it("categoryIds 只有一个分组，且包含全部 11 个分类", () => {
    const groups = rastastuganMetadata.category!.filter((category) => category.key === "categoryIds");

    expect(groups).toHaveLength(1);
    expect(groups[0].options).toHaveLength(11);
    expect(rastastuganMetadata.category!.some((category) => category.key === "categoryIds_other")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// E5b-5：retroflix 的 userInfo.process 必须取 isDonor
// ---------------------------------------------------------------------------
describe("E5b-5：retroflix 捐赠者字段", () => {
  it("userdetails 步骤的 fields 含 isDonor（否则 donorConfig 的 2 倍时魔永不生效）", () => {
    const process = retroflixMetadata.userInfo!.process!;
    const userDetailsStep = process.find((step) => (step.requestConfig as any)?.url?.includes("/userdetails.php"))!;

    expect((userDetailsStep as any).fields).toContain("isDonor");
    expect(retroflixMetadata.userInfo!.donorConfig?.bonusPerHourMultiplier).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// E5-13 / E5b-6：ptfans 的 H&R 计数用正则解析
// ---------------------------------------------------------------------------
describe("E5-13：ptfans H&R 计数（回归：split('/') + parseInt 得到 NaN）", () => {
  const runFilter = (field: "hnrPreWarning" | "hnrUnsatisfied", text: string) =>
    (ptfansMetadata.userInfo!.selectors![field] as any).filters[0](text);

  it("`H&R: 2/1/5` 解析出预警 2 与未满足 1，且没有 NaN", () => {
    expect(runFilter("hnrPreWarning", "H&R: 2/1/5")).toBe(2);
    expect(runFilter("hnrUnsatisfied", "H&R: 2/1/5")).toBe(1);
    expect(Number.isNaN(runFilter("hnrPreWarning", "H&R: 2/1/5"))).toBe(false);
    expect(Number.isNaN(runFilter("hnrUnsatisfied", "H&R: 2/1/5"))).toBe(false);
  });

  it("纯数字文本与空文本都有安全值", () => {
    expect(runFilter("hnrPreWarning", "3/0/0")).toBe(3);
    expect(runFilter("hnrUnsatisfied", "3/0/0")).toBe(0);
    expect(runFilter("hnrPreWarning", "")).toBe(0);
    expect(runFilter("hnrUnsatisfied", "")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// E5-14 / E5b-14：sjtu 的 uploads 必须是 number
// ---------------------------------------------------------------------------
describe("E5-14：sjtu uploads 类型", () => {
  it('从 `</a> N <div id="ka">` 片段取到数字而非字符串', async () => {
    const site = createSite(Sjtu, sjtuMetadata);
    (site as any).request = vi.fn(async () => ({ data: '<a href="#">x</a> 12 <div id="ka">' }));

    const info = await (site as any).parseUserInfoForUploads({ id: 1 });

    expect(info.uploads).toBe(12);
    expect(typeof info.uploads).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// E5-15：ptgtk 旧域名进 legacyUrls
// ---------------------------------------------------------------------------
describe("E5-15：ptgtk 域名归类", () => {
  it("当前域名只在 urls，旧域名只在 legacyUrls", () => {
    expect(ptgtkMetadata.urls).toEqual(["https://pt.gtkpw.xyz/"]);
    expect(ptgtkMetadata.legacyUrls).toEqual(["https://pt.gtk.pw/"]);
    expect(ptgtkMetadata.urls).not.toContain("https://pt.gtk.pw/");
  });
});

// ---------------------------------------------------------------------------
// E5b-8 / E5b-9 / I5：数据卫生
// ---------------------------------------------------------------------------
describe("E5b-8 / E5b-9 / I5：元数据卫生", () => {
  it("ptlsp 的 collaborator 不含字符串化的 null", () => {
    expect(ptlspMetadata.collaborator).toEqual(["CosmoGao"]);
    expect((ptlspMetadata.collaborator ?? []).includes("null" as any)).toBe(false);
  });

  it("pt99 的 tags 无重复项", () => {
    expect(pt99Metadata.tags).toEqual(["综合", "记录片", "影视"]);
  });

  it("ptfans 的搜索 tags 里只有一个 H&R（复用引擎默认，不重复追加）", () => {
    const tags = (ptfansMetadata.search!.selectors!.tags ?? []) as Array<{ name: string }>;
    expect(tags.filter((tag) => tag.name === "H&R")).toHaveLength(1);
  });
});
