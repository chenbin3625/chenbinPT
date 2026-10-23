/**
 * defs-e2 包审查修复的行为回归（E2-01 … E2-23 / E2b-01 … E2b-25 中可在本地验证的部分）。
 *
 * 断言对象是**真实站点定义 + 真实引擎实现**（不发网络请求）：
 * - 选择器/过滤器直接跑定义里的真实配置（时间用真实 `parseValidTimeStringInZone` 与时区换算）；
 * - 分类用真实的 `buildSearchSolutionFromCategories` 断言多选不再被后一组覆盖；
 * - 用户信息/下载链接用站点类 + 打桩的 `request()` 断言「可选页失败不作废主结果」「零命中明确失败」。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildSearchSolutionFromCategories } from "@/options/utils/searchSolutionConfig.ts";

// 站点模块会连带引入平台适配层（用到 __BROWSER__ 与 chrome API），
// 因此在任何 import 之前把全局桩准备好。
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

const adapterMock = vi.hoisted(() => ({ logMessage: vi.fn() }));

vi.mock("@ptd/site/utils/adapter.ts", () => ({
  axios: {
    request: vi.fn(async (config: any) => ({ data: {}, status: 200, statusText: "OK", headers: {}, config })),
    getUri: (config: any) => `${config?.baseURL ?? ""}${config?.url ?? ""}`,
  },
  isCloudflareBlocked: vi.fn(() => false),
  retrieve: vi.fn(async () => null),
  retrieveStore: vi.fn(async () => null),
  cookie: vi.fn(async () => null),
  sleep: vi.fn(async (_ms?: number) => {}),
  store: vi.fn(async () => {}),
  logMessage: adapterMock.logMessage,
}));

const makeDoc = (html: string) => new DOMParser().parseFromString(`<html><body>${html}</body></html>`, "text/html");

/**
 * `buildSearchSolutionFromCategories` 返回的请求配置把参数放在 `requestConfig` 下（构造器用
 * `set(requestConfig, "requestConfig.params.<key>")`），这里兼容取到真正的 params 对象。
 */
const paramsOf = (config: any): Record<string, any> => (config?.requestConfig ?? config)?.params ?? {};

const createSite = (SiteClass: unknown, metadata: unknown, userConfig: Record<string, unknown> = {}) =>
  new (SiteClass as any)({ ...(metadata as any) }, userConfig);

/** 用真实的抽象站引擎跑定义里的选择器 / 过滤器（与站点实际解析走同一条代码路径） */
const makeProbe = async (metadata: unknown) => {
  const { default: AbstractBittorrentSite } = await import("@ptd/site/schemas/AbstractBittorrentSite.ts");
  class Probe extends (AbstractBittorrentSite as any) {
    fieldData(row: any, query: any) {
      return (this as any).getFieldData(row, query);
    }
    runFilters(query: any, filters: any) {
      return (this as any).runQueryFilters(query, filters);
    }
  }
  return new (Probe as any)({ ...(metadata as any) });
};

beforeEach(() => {
  adapterMock.logMessage.mockReset();
});

// ---------------------------------------------------------------------------
// E2-01 bwtorrents：completed 与 leechers 取同一列
// ---------------------------------------------------------------------------
describe("E2-01：bwtorrents 的 completed 不再映射到 leechers 列", () => {
  it("leechers 仍是第 9 列，completed 不再声明（旧实现两者同列，完成数恒等于下载者数）", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/bwtorrents.ts");
    const selectors = siteMetadata.search!.selectors!;
    expect(selectors.leechers!.selector).toBe("td:nth-child(9)");
    expect(selectors.completed).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// E2-08 bwtorrents：时间格式串缺空格 → 原生 Date 回退把 dd-MM 当 MM-dd
// ---------------------------------------------------------------------------
describe("E2-08：bwtorrents 时间按 dd-MM-yyyy HH:mm:ss 与 +0530 解析", () => {
  it("带空格与不带空格的单元格都得到同一个月/日顺序正确的时间", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/bwtorrents.ts");
    const probe = await makeProbe(siteMetadata);
    const filters = (siteMetadata.search!.selectors!.time as any).filters;
    const expected = Date.UTC(2024, 2, 25, 6, 30); // 2024-03-25 12:00:00 +05:30

    expect(probe.runFilters("25-03-2024 12:00:00", filters)).toBe(expected);
    // 单元格可能是「日期<br>时间」，getFieldData 把换行归一成空格；这里也覆盖没有分隔符的写法
    expect(probe.runFilters("25-03-202412:00:00", filters)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// E2-16 bwtorrents：VIP 放在 user 组编号区间
// ---------------------------------------------------------------------------
describe("E2-16：bwtorrents 的 VIP 归入 vip 组（id >= 100）", () => {
  it("VIP 不再被算进 user 阶梯，按名字仍能判到 vip 组 id", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/bwtorrents.ts");
    const { getMaxUserLevelId, guessUserLevelId } = await import("@ptd/site/utils/level.ts");
    const levels = siteMetadata.levelRequirements!;
    const vip = levels.find((level) => level.name === "VIP")!;

    expect(vip.id).toBeGreaterThanOrEqual(100);
    expect(vip.groupType).toBe("vip");
    expect(getMaxUserLevelId(levels)).toBe(2);
    expect(guessUserLevelId({ site: "bwtorrents", levelName: "VIP" } as any, levels)).toBe(vip.id);
  });
});

// ---------------------------------------------------------------------------
// E2-02 / E2-15 cinemageddon：seedingSize 选择器与默认等级
// ---------------------------------------------------------------------------
describe("E2-02：cinemageddon 的 seedingSize 与 seeding 使用同一个 <table> 选择器", () => {
  const userInfoSelectors = async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/cinemageddon.ts");
    return siteMetadata.userInfo!.process!.find((step: any) => step.selectors?.seedingSize)!.selectors! as any;
  };

  it("seedingSize 选择器不再定位到 <tr>（旧实现 elementProcess 拿到 tr，做种体积恒 0）", async () => {
    const selectors = await userInfoSelectors();
    expect(selectors.seedingSize.selector).toEqual(selectors.seeding.selector);
    expect([].concat(selectors.seedingSize.selector).some((s: string) => /\btr\b/.test(s))).toBe(false);
  });

  it("对真实的做种表格累加第 3 列体积", async () => {
    const { parseSizeString } = await import("@ptd/site/utils/filesize.ts");
    const selectors = await userInfoSelectors();
    const doc = makeDoc(`
      <div id="ka2">
        <table>
          <tr><th>name</th><th>x</th><th>size</th></tr>
          <tr><td>a</td><td>x</td><td>1.5 GB</td></tr>
          <tr><td>b</td><td>x</td><td>512 MB</td></tr>
        </table>
      </div>`);
    const table = doc.querySelector("div#ka2 table")!;

    expect(selectors.seedingSize.elementProcess(table)).toBe(parseSizeString("1.5 GB") + parseSizeString("512 MB"));
  });
});

describe("E2-15：cinemageddon 补上默认等级，新用户不再被判成 -1", () => {
  it("id 0 是无门槛入口级；新用户与已知默认等级名都判到 0", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/cinemageddon.ts");
    const { guessUserLevelId } = await import("@ptd/site/utils/level.ts");
    const levels = siteMetadata.levelRequirements!;

    expect(levels[0].id).toBe(0);
    expect(levels[0].name).toBe("User");
    expect(guessUserLevelId({ site: "cinemageddon", levelName: "User" } as any, levels)).toBe(0);
    // 站点的默认等级名若不是 User，回落阶梯也应停在入口级而不是 -1
    expect(guessUserLevelId({ site: "cinemageddon", levelName: "未识别的头衔" } as any, levels)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// E2-34 / E2-08 cinemageddon：时区只由 timezoneOffset 提供
// ---------------------------------------------------------------------------
describe("E2-34：cinemageddon 的时间不再手工追加 -07:00 后缀", () => {
  it("格式串带空格、具名 parseTime 按 -0700 换算", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/cinemageddon.ts");
    const probe = await makeProbe(siteMetadata);
    const timeQuery = siteMetadata.search!.selectors!.time as any;
    const filters = timeQuery.filters;

    expect(filters.some((filter: any) => filter.name === "append")).toBe(false);
    expect(filters.some((filter: any) => String(filter.args?.[0] ?? "").includes("XXX"))).toBe(false);
    expect(probe.runFilters("2024-03-25 12:00:00", filters)).toBe(Date.UTC(2024, 2, 25, 19, 0, 0));
  });
});

// ---------------------------------------------------------------------------
// E2-03 / E2b-14 femdomcult：params 整体替换丢掉 action=advanced
// ---------------------------------------------------------------------------
describe("E2-03：femdomcult 的搜索参数保留 Luminance 的 action=advanced", () => {
  it("params 同时包含 action=advanced 与 order_by/order_way", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/femdomcult.ts");
    const params = siteMetadata.search!.requestConfig!.params!;
    expect(params).toMatchObject({ action: "advanced", order_by: "time", order_way: "desc" });
    expect(siteMetadata.search!.keywordPath).toBe("params.title");
  });
});

// ---------------------------------------------------------------------------
// E2-04 / E2b-17 exttorrents：一级分类发出 sub_cat=undefined
// ---------------------------------------------------------------------------
describe("E2-04：exttorrents 一级分类不再生成 sub_cat=undefined", () => {
  const load = async () => (await import("@ptd/site/definitions/exttorrents.ts")).siteMetadata;

  it("所有 option value 都不包含 undefined", async () => {
    const metadata = await load();
    const options = metadata.category!.find((group) => group.key === "cat")!.options as any[];
    expect(options.length).toBeGreaterThan(50);
    expect(options.filter((option) => String(option.value).includes("undefined"))).toEqual([]);
  });

  it("选一级分类只发 cat；选二级分类才带 sub_cat", async () => {
    const metadata = await load();
    const top = buildSearchSolutionFromCategories(metadata.category!, { cat: "1" } as any);
    expect(paramsOf(top.requestConfig)).toEqual({ cat: "1" });

    const sub = buildSearchSolutionFromCategories(metadata.category!, { cat: "1|1" } as any);
    expect(paramsOf(sub.requestConfig)).toEqual({ cat: "1", sub_cat: "1" });
  });
});

// ---------------------------------------------------------------------------
// E2b-16 exttorrents：details 兜底把字面量 "N/A" 当下载链接
// ---------------------------------------------------------------------------
describe("E2b-16：exttorrents 换不到磁力时明确失败", () => {
  it("不再声明 detail.selectors.link 常量（旧实现会让父类把 'N/A' 当链接返回）", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/exttorrents.ts");
    expect(siteMetadata.detail!.selectors!.link).toBeUndefined();
  });

  it("ajax 返回 success:false 时抛错，而不是返回空串（下游会请求站点根地址）", async () => {
    const { default: ExtTorrents, siteMetadata } = await import("@ptd/site/definitions/exttorrents.ts");
    const site: any = createSite(ExtTorrents, siteMetadata);
    site.request = vi.fn(async () => ({ data: { success: false } }));

    await expect(
      site.getTorrentDownloadLink({
        id: 123,
        link: "pageToken|csrfToken",
        url: "https://ext.to/movie/123/",
      }),
    ).rejects.toThrow(/cannot get magnet link/);
  });
});

// ---------------------------------------------------------------------------
// E2-05 / E2b-10 dicmusic：seedingSize 与 bonusPerHour 读同一单元格
// ---------------------------------------------------------------------------
describe("E2-05：dicmusic 的 seedingSize 不再取自 bprates 的速率单元格", () => {
  it("不再声明指向 td:eq(1) 的 seedingSize 选择器", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/dicmusic.ts");
    const selectors = siteMetadata.userInfo!.selectors! as any;
    // 继承自 GazelleJSONAPI 的 `response.userstats.seedingSize` 仍保留，但不再指向 bprates 单元格
    expect(JSON.stringify(selectors.seedingSize?.selector ?? "")).not.toContain("bprates_overview");
    // 时魔仍来自 bprates 页
    expect([].concat(selectors.bonusPerHour.selector)).toContain("table#bprates_overview > tbody > tr > td:eq(1)");
  });

  it("bonus 页只有速率时，seedingSize 保持 0（旧实现把它当 0.5 字节），bonusPerHour 正常", async () => {
    const { default: DICMusic, siteMetadata } = await import("@ptd/site/definitions/dicmusic.ts");
    const site = createSite(DICMusic, siteMetadata);
    const bonusHtml = `
      <div id="content"><div class="header"><h3>Bonus: 1,234</h3></div>
        <table id="bprates_overview"><tbody><tr><td>Seeding</td><td>0.5</td></tr></tbody></table>
      </div>`;

    site.request = vi.fn(async (config: any) =>
      String(config?.url ?? "").includes("bonus.php")
        ? { data: makeDoc(bonusHtml), config }
        : { data: makeDoc("<html><body></body></html>"), config },
    );

    const info = await (site as any).getSeedingSize(1);
    expect(info.bonusPerHour).toBe(0.5);
    expect(info.seedingSize).not.toBe(0.5);
    expect(typeof info.seedingSize).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// E2-06 darkland / datascene：同一 categoryIds 被拆成多组时跨组选择只剩最后一组
// ---------------------------------------------------------------------------
describe("E2-06：darkland / datascene 的 categoryIds 合并为单个分组", () => {
  it("跨组勾选（等同于全选）时所有分类都进入 categoryIds 数组", async () => {
    for (const file of ["darkland", "datascene"]) {
      const { siteMetadata } = await import(`@ptd/site/definitions/${file}.ts`);
      const groups = siteMetadata.category!;
      const bracketsGroups = groups.filter((group: any) => group.cross?.mode === "brackets");
      expect(bracketsGroups, file).toHaveLength(1);

      const group = bracketsGroups[0];
      expect(group.key, file).toBe("categoryIds");
      const values = (group.options as any[]).map((option) => option.value);
      const { requestConfig } = buildSearchSolutionFromCategories(groups, { categoryIds: values } as any);
      expect(paramsOf(requestConfig).categoryIds, file).toEqual(values);
    }
  });
});

// ---------------------------------------------------------------------------
// E2-07 / E2b-15 greatposterwall：可选页异常作废整份用户信息
// ---------------------------------------------------------------------------
describe("E2-07：greatposterwall 的可选 trueDownloaded 请求失败不影响主结果", () => {
  const makeSite = async () => {
    const { default: GreatPosterWall, siteMetadata } = await import("@ptd/site/definitions/greatposterwall.ts");
    const { EResultParseStatus } = await import("@ptd/site/types.ts");
    const site: any = createSite(GreatPosterWall, siteMetadata);
    const baseProto = Object.getPrototypeOf(GreatPosterWall.prototype);
    vi.spyOn(baseProto, "getUserInfoResult").mockResolvedValue({
      site: "greatposterwall",
      status: EResultParseStatus.success,
      updateAt: Date.now(),
      id: 9527,
      uploaded: 42,
      levelName: "Elite",
    });
    return { site, EResultParseStatus };
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("补充页网络错误时保留 super 的结果与 success 状态，且不写 0", async () => {
    const { site, EResultParseStatus } = await makeSite();
    site.request = vi.fn(async () => {
      throw new Error("Network Error: timeout of 30000ms exceeded");
    });

    const info = await site.getUserInfoResult({});
    expect(info.status).toBe(EResultParseStatus.success);
    expect(info.uploaded).toBe(42);
    expect(info.trueDownloaded).toBeUndefined();
    expect(adapterMock.logMessage).toHaveBeenCalled();
  });

  it("补充页命中时正常写入 trueDownloaded", async () => {
    const { parseSizeString } = await import("@ptd/site/utils/filesize.ts");
    const { site } = await makeSite();
    site.request = vi.fn(async () => ({
      data: makeDoc('<span id="downloaded-value"><span data-tooltip="Uploaded: 1 TB,2 TB">2 TB</span></span>'),
    }));

    const info = await site.getUserInfoResult({});
    expect(info.trueDownloaded).toBe(parseSizeString("2 TB"));
  });

  it("补充页零命中（如登录页/错误页）时保持 undefined，而不是写 0", async () => {
    const { site } = await makeSite();
    site.request = vi.fn(async () => ({ data: makeDoc("<html><body>login</body></html>") }));

    const info = await site.getUserInfoResult({});
    expect(info.trueDownloaded).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// E2b-22 greatposterwall：可选字段缺失时单行解析不再抛错
// ---------------------------------------------------------------------------
describe("E2b-22：greatposterwall 的行解析对缺失的可选字段有兜底", () => {
  it("remasterTitle / groupSubName 缺失时得到正常标题而不是 TypeError", async () => {
    const { default: GreatPosterWall, siteMetadata } = await import("@ptd/site/definitions/greatposterwall.ts");
    class Probe extends (GreatPosterWall as any) {
      run(group: any, torrent: any) {
        return (this as any).transformGroupTorrent(group, torrent);
      }
    }
    const site = new (Probe as any)({ ...(siteMetadata as any) });
    site.getAuthKey = vi.fn(async () => ({ authkey: "a", passkey: "p" }));

    const torrent = await site.run(
      {
        groupId: 1,
        groupName: "Movie Name",
        groupSubName: undefined,
        groupYear: 2024,
        releaseType: "Feature Film",
        imdbId: "",
        doubanId: "0",
      },
      {
        torrentId: 5,
        remasterTitle: undefined,
        isPersonalFreeleech: false,
        freeType: undefined,
        jinzhuan: false,
        remasterCustomTitle: undefined,
        resolution: "1080p",
        codec: "H.264",
        source: "Blu-ray",
        container: "mkv",
        remasterYear: 0,
        scene: false,
        time: "2024-01-01 00:00:00",
        size: 1024,
        seeders: 1,
        leechers: 2,
        snatches: 3,
      },
    );

    expect(torrent.id).toBe(5);
    expect(torrent.title).not.toContain("undefined");
    expect(torrent.title).toContain("Movie Name");
  });
});

// ---------------------------------------------------------------------------
// E2b-01 cspt：卡片行下 link / url / id 仍用 NexusPHP 的 img 假设
// ---------------------------------------------------------------------------
describe("E2b-01：cspt 卡片行能从 download.php 链接取到 link / url / id", () => {
  const cardRow = `
    <div class="torrent-table-sub-info">
      <div class="torrent-title"><span class="torrent-info-text-small_name">sub</span></div>
      <a href="download.php?id=123&amp;passkey=abc">下载</a>
    </div>`;

  it("link / url / id 都从 download.php?id= 派生（不再要求 a 内含 img[alt=download]）", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/cspt.ts");
    const selectors = siteMetadata.search!.selectors! as any;
    expect(JSON.stringify(selectors.link.selector)).not.toContain(":has(");

    const probe = await makeProbe(siteMetadata);
    const doc = makeDoc(cardRow);
    const row = doc.querySelector("div.torrent-table-sub-info")!;

    expect(probe.fieldData(row, selectors.link)).toBe("download.php?id=123&passkey=abc");
    expect(probe.fieldData(row, selectors.url)).toBe("/details.php?id=123");
    expect(probe.fieldData(row, selectors.id)).toBe(123);
  });
});

// ---------------------------------------------------------------------------
// E2b-02 cspt：tags 重复「综合」
// ---------------------------------------------------------------------------
describe("E2b-02：cspt 的 tags 不再重复", () => {
  it("tags 无重复项", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/cspt.ts");
    const tags = siteMetadata.tags!;
    expect(tags).toEqual(["中文", "综合", "影视"]);
    expect(new Set(tags).size).toBe(tags.length);
  });
});

// ---------------------------------------------------------------------------
// E2-11 / E2b-18 empornium：status 改了图标结构，progress 没跟着改
// ---------------------------------------------------------------------------
describe("E2-11：empornium 的 progress 与 status 使用同一套 <i> 图标", () => {
  it("做种图标同时给出 status=seeding 与 progress=100", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/empornium.ts");
    const { ETorrentStatus } = await import("@ptd/site/types.ts");
    const selectors = siteMetadata.search!.selectors! as any;

    expect(selectors.progress.case["span.icon_disk_seed"]).toBe(100); // 保留基类回落
    expect(selectors.progress.case["i.torrent_icons.seeding"]).toBe(100);

    const probe = await makeProbe(siteMetadata);
    const doc = makeDoc(`
      <table><tbody><tr><td>
        <a href="torrents.php?action=download&amp;id=1">
          <span class="icon_stack"><i class="torrent_icons seeding"></i></span>
        </a>
      </td></tr></tbody></table>`);
    const row = doc.querySelector("tr")!;
    expect(row).not.toBeNull();

    expect(probe.fieldData(row, selectors.progress)).toBe(100);
    expect(probe.fieldData(row, selectors.status)).toBe(ETorrentStatus.seeding);
  });
});

// ---------------------------------------------------------------------------
// E2-12 cgpeers：status / progress 指向旧版 torrents.php?action=download
// ---------------------------------------------------------------------------
describe("E2-12：cgpeers 的 status / progress 适配 /torrent/download/ 新布局", () => {
  it("新布局链接下的状态图标仍能判出 seeding 与 progress=100", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/cgpeers.ts");
    const { ETorrentStatus } = await import("@ptd/site/types.ts");
    const selectors = siteMetadata.search!.selectors! as any;

    expect([].concat(selectors.status.selector)[0]).toContain("torrent/download/");
    expect([].concat(selectors.progress.selector)[0]).toContain("torrent/download/");

    const probe = await makeProbe(siteMetadata);
    const doc = makeDoc(
      '<table><tbody><tr><td><a href="torrent/download/42"><i class="seeding-torrent"></i></a></td></tr></tbody></table>',
    );
    const row = doc.querySelector("tr")!;
    expect(row).not.toBeNull();

    expect(probe.fieldData(row, selectors.status)).toBe(ETorrentStatus.seeding);
    expect(probe.fieldData(row, selectors.progress)).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// E2-09 / E2b-12 ehentai：id 取到图库 id，同图库多个种子 id 相同
// ---------------------------------------------------------------------------
describe("E2-09：ehentai 的 id 取自 gallerytorrents 链接里的种子唯一位", () => {
  it("优先 gtid，其次 t，最后才退回 gid", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/ehentai.ts");
    const idQuery = siteMetadata.search!.selectors!.id as any;
    const filter = idQuery.filters[0] as (href: string) => string;

    expect(JSON.stringify(idQuery.selector)).toContain("gallerytorrents.php?gid=");
    expect(filter("https://e-hentai.org/gallerytorrents.php?gid=4271402&t=abc123&gtid=9001")).toBe("9001");
    expect(filter("https://e-hentai.org/gallerytorrents.php?gid=4271402&t=abc123")).toBe("abc123");
    expect(filter("https://e-hentai.org/gallerytorrents.php?gid=4271402")).toBe("4271402");
  });
});

describe("E2b-11：ehentai 取不到 .torrent 链接时明确失败", () => {
  const load = async () => {
    const { default: EHentai, siteMetadata } = await import("@ptd/site/definitions/ehentai.ts");
    return { EHentai, siteMetadata };
  };

  it("零命中抛错（不再把空串交给下载器，最终请求站点根目录）", async () => {
    const { EHentai, siteMetadata } = await load();
    const site: any = createSite(EHentai, siteMetadata);
    site.request = vi.fn(async () => ({ data: makeDoc("<html><body>no torrent link</body></html>") }));

    await expect(
      site.getTorrentDownloadLink({ id: 1, link: "https://e-hentai.org/gallerytorrents.php?gid=1&t=a" }),
    ).rejects.toThrow(/cannot parse \.torrent link/);
  });

  it("命中时返回 .torrent 链接", async () => {
    const { EHentai, siteMetadata } = await load();
    const site: any = createSite(EHentai, siteMetadata);
    site.request = vi.fn(async () => ({
      data: makeDoc('<a href="https://ehtracker.org/get/1/abc.torrent">dl</a>'),
    }));

    await expect(
      site.getTorrentDownloadLink({ id: 1, link: "https://e-hentai.org/gallerytorrents.php?gid=1&t=a" }),
    ).resolves.toBe("https://ehtracker.org/get/1/abc.torrent");
  });
});

// ---------------------------------------------------------------------------
// E2-10 / E2b-23 filelist：上传/下载量正则要求标签、completed 非空断言
// ---------------------------------------------------------------------------
describe("E2-10：filelist 的上传/下载/魔力值解析不再依赖标签文本", () => {
  const loadSelectors = async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/filelist.ts");
    const process = siteMetadata.userInfo!.process!;
    const first = process.find((step: any) => step.selectors?.uploaded)!.selectors! as any;
    return { siteMetadata, selectors: first };
  };

  it("「1.2 TB」与「Uploaded: 1.2 TB」都解析成同一个字节数", async () => {
    const { parseSizeString } = await import("@ptd/site/utils/filesize.ts");
    const { selectors } = await loadSelectors();
    const uploaded = selectors.uploaded.filters[0];
    const downloaded = selectors.downloaded.filters[0];

    expect(uploaded("1.2 TB")).toBe(parseSizeString("1.2 TB"));
    expect(uploaded("Uploaded: 1.2 TB")).toBe(parseSizeString("1.2 TB"));
    expect(uploaded("")).toBe(0);
    expect(downloaded("456.7 GB")).toBe(parseSizeString("456.7 GB"));
  });

  it("魔力值带前缀时也能解析（旧实现 parseFloat 得到 NaN）", async () => {
    const { siteMetadata, selectors } = await loadSelectors();
    const probe = await makeProbe(siteMetadata);
    expect(probe.runFilters("FLCoins: 1,234", selectors.bonus.filters)).toBe(1234);
  });
});

describe("E2b-23：filelist 的 completed 列缺数字时不再整行丢弃", () => {
  it("空 / 破折号得到 0，正常数字保持原值", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/filelist.ts");
    const completed = (siteMetadata.search!.selectors!.completed as any).filters[0];

    expect(completed("12")).toBe("12");
    expect(completed("-")).toBe(0);
    expect(completed("")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// E2-13 / E2b-19 fappaizuri：自定义 getUserInfoResult 吞掉错误分类
// ---------------------------------------------------------------------------
describe("E2-13：fappaizuri 的 getUserInfoResult 区分网络错误与登录失效", () => {
  const makeSite = async () => {
    const { default: Fappaizuri, siteMetadata } = await import("@ptd/site/definitions/fappaizuri.ts");
    return { site: createSite(Fappaizuri, siteMetadata) };
  };

  it("网络错误 → unknownError（可重试）+ statusMsg", async () => {
    const { site } = await makeSite();
    const { EResultParseStatus } = await import("@ptd/site/types.ts");
    site.request = vi.fn(async () => {
      throw new Error("Network Error: timeout of 30000ms exceeded");
    });

    const info = await site.getUserInfoResult({});
    expect(info.status).toBe(EResultParseStatus.unknownError);
    expect(info.statusMsg).toContain("Network Error");
    expect(adapterMock.logMessage).toHaveBeenCalled();
  });

  it("页面无标题（未登录）仍映射为 needLogin", async () => {
    const { site } = await makeSite();
    const { EResultParseStatus } = await import("@ptd/site/types.ts");
    site.request = vi.fn(async () => ({ data: makeDoc("<html><body></body></html>") }));

    const info = await site.getUserInfoResult({});
    expect(info.status).toBe(EResultParseStatus.needLogin);
  });
});

// ---------------------------------------------------------------------------
// E2-17 / E2-18 / E2b-05：标签与空协作者
// ---------------------------------------------------------------------------
describe("E2-17/E2-18/E2b-05：cinematik / desigaane 的标签修正", () => {
  it("cinematik 的两个标签拆开、desigaane 使用简体「音乐」且不留空 collaborator", async () => {
    const cinematik = (await import("@ptd/site/definitions/cinematik.ts")).siteMetadata;
    const desigaane = (await import("@ptd/site/definitions/desigaane.ts")).siteMetadata;

    expect(cinematik.tags).toEqual(["影视", "原盘"]);
    expect(desigaane.tags).toEqual(["音乐", "印度音乐"]);
    expect(desigaane.collaborator).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// E2-20 / E2b-20 exoticaz：空操作「搜索入口」与空字符串协作者
// ---------------------------------------------------------------------------
describe("E2-20：exoticaz 删除空操作的「搜索入口」分组", () => {
  it("不再有返回 { params: {} } 的分组、没有 searchEntry.area_adult、没有空协作者", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/exoticaz.ts");

    expect(siteMetadata.category!.some((group) => group.key === "entry")).toBe(false);
    expect(siteMetadata.category!.some((group) => typeof group.generateRequestConfig === "function")).toBe(false);
    expect(siteMetadata.searchEntry?.area_adult).toBeUndefined();
    expect((siteMetadata.collaborator ?? []).filter((name) => !name)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// E2-21 gtnet：空关键词搜索不注入 securitytoken
// ---------------------------------------------------------------------------
describe("E2-21：gtnet 空关键词搜索也会注入 securitytoken", () => {
  it("keywords 为空时仍写入 token，并透出取不到 token 的原因", async () => {
    const { default: Gtnet, siteMetadata } = await import("@ptd/site/definitions/gtnet.ts");
    const site: any = createSite(Gtnet, siteMetadata);
    site.getSecurityToken = vi.fn(async () => "TOKEN-123");
    site.request = vi.fn(async () => ({ data: makeDoc("<html><body></body></html>") }));

    await site.getSearchResult(undefined, {});
    expect(site.metadata.search.requestConfig.data.securitytoken).toBe("TOKEN-123");
    // 只改实例 metadata，不污染模块级定义
    expect((siteMetadata.search!.requestConfig!.data as any).securitytoken).toBe("");
  });

  it("取不到 token 时把原因写进 statusMsg", async () => {
    const { default: Gtnet, siteMetadata } = await import("@ptd/site/definitions/gtnet.ts");
    const site: any = createSite(Gtnet, siteMetadata);
    site.getSecurityToken = vi.fn(async () => "");
    site.request = vi.fn(async () => ({ data: makeDoc("<html><body></body></html>") }));

    const result = await site.getSearchResult("keyword", {});
    expect(result.statusMsg).toContain("securitytoken");
  });
});

// ---------------------------------------------------------------------------
// E2-22 gtnet / gtru：站点时区
// ---------------------------------------------------------------------------
describe("E2-22：gtnet / gtru 使用 EET（+0200）而不是 +0800", () => {
  it("两站 timezoneOffset 均为 +0200", async () => {
    const gtnet = (await import("@ptd/site/definitions/gtnet.ts")).siteMetadata;
    const gtru = (await import("@ptd/site/definitions/gtru.ts")).siteMetadata;
    expect(gtnet.timezoneOffset).toBe("+0200");
    expect(gtru.timezoneOffset).toBe("+0200");
  });
});

// ---------------------------------------------------------------------------
// E2-23 darkpeers：明文 favicon 泄漏 rot13 隐藏的域名
// ---------------------------------------------------------------------------
describe("E2-23：darkpeers 不再用明文 favicon 泄漏域名", () => {
  it("favicon 未声明（urls 仍是 rot13）", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/darkpeers.ts");
    expect(siteMetadata.urls![0]).toMatch(/^uggcf:\/\//);
    expect(siteMetadata.favicon).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// E2-24 … E2b-04：不存在的 schema 名、死站残留配置
// ---------------------------------------------------------------------------
describe("E2-25/E2b-03：无实现的 schema 名不再声明", () => {
  it("ccfbits（TBSource）/ cnlang（Discuz）/ fsm（FSM）都不再声明 schema", async () => {
    const ccfbits = (await import("@ptd/site/definitions/ccfbits.ts")).siteMetadata;
    const cnlang = (await import("@ptd/site/definitions/cnlang.ts")).siteMetadata;
    const fsm = (await import("@ptd/site/definitions/fsm.ts")).siteMetadata;

    expect(ccfbits.schema).toBeUndefined();
    expect(cnlang.schema).toBeUndefined();
    expect(fsm.schema).toBeUndefined();
  });
});

describe("E2b-04：死站不再保留生效的运行配置", () => {
  it("dajiao / dhtclub / gainbound / fsm / fearnopeer 的残留配置已移除", async () => {
    const dajiao = (await import("@ptd/site/definitions/dajiao.ts")).siteMetadata;
    const dhtclub = (await import("@ptd/site/definitions/dhtclub.ts")).siteMetadata;
    const gainbound = (await import("@ptd/site/definitions/gainbound.ts")).siteMetadata;
    const fsm = (await import("@ptd/site/definitions/fsm.ts")).siteMetadata;
    const fearnopeer = (await import("@ptd/site/definitions/fearnopeer.ts")).siteMetadata;

    for (const metadata of [dajiao, dhtclub, gainbound, fsm, fearnopeer]) {
      expect(metadata.isDead).toBe(true);
    }
    expect(dajiao.officialGroupPattern).toBeUndefined();
    expect(dhtclub.levelRequirements).toBeUndefined();
    expect(gainbound.levelRequirements).toBeUndefined();
    expect(fsm.levelRequirements).toBeUndefined();
    expect(fsm.collaborator).toBeUndefined();
    expect(fearnopeer.levelRequirements).toBeUndefined();
    expect(dhtclub.timezoneOffset).not.toBe("+0800");
  });
});

// ---------------------------------------------------------------------------
// E2b-24 / E2b-25：描述漂移与 nameAka
// ---------------------------------------------------------------------------
describe("E2b-24/E2b-25：emuwarez 描述与 ggpt 别名", () => {
  it("emuwarez 描述不再声称走 Unit3D JSON API（实现仍抓 HTML）", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/emuwarez.ts");
    expect(siteMetadata.description).not.toContain("JSON API");
    expect((siteMetadata.search!.requestConfig as any).responseType).toBe("document");
  });

  it("ggpt 的 nameAka 拆成两个独立别名", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/ggpt.ts");
    const retiree = siteMetadata.levelRequirements!.find((level) => level.name === "养老族(Retiree)")!;
    expect(retiree.nameAka).toEqual(["养老", "散仙"]);
  });
});
