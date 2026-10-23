/**
 * defs-fix-e1：E1 / E1b 站点定义审查（47 个定义）修复的回归。
 *
 * 覆盖范围：0magnet / abtorrents / 52pt / 1337x / aidoruonline / animetosho / alpharatio /
 * animebytes / anisource / audiences / audiobookbay / audionews / bakabt / beyondhd /
 * bibliotik / bitbr / bitporn / btschool / btetree / broadcasthenet / avistaz。
 *
 * 全部用例都在本地 DOM（happy-dom）与仓库真实的选择器/判级实现上跑，不发网络请求；
 * 需要时间相关断言的地方使用 fake timers 固定「当前时刻」。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

// 站点定义会连带引入 @ptd/site 的运行时依赖（messages.ts 用到 __BROWSER__ 与 chrome API），
// 这里给出最小桩（与 definitionFixes.test.ts / defs-1.review-fixes.test.ts 一致）。
vi.mock("@ptd/site/utils/adapter.ts", () => ({ logMessage: vi.fn() }));
(globalThis as any).__BROWSER__ ??= "chrome";

const makeDoc = (html: string) => new DOMParser().parseFromString(`<html><body>${html}</body></html>`, "text/html");
const makeTitledDoc = (title: string) =>
  new DOMParser().parseFromString(
    `<html><head><title>${title}</title></head><body><div>nothing</div></body></html>`,
    "text/html",
  );

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("E1-A1 0magnet：不再把综合磁力站标成成人站", () => {
  it("tags 与搜索行 category 都不再是 XXX", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/0magnet.ts");

    expect(siteMetadata.tags).not.toContain("XXX");
    expect(siteMetadata.tags).not.toContain("成人");
    expect((siteMetadata.search!.selectors as any).category.text).toBe("Other");
  });
});

describe("E1-A2 abtorrents：默认状态与分类面板首项一致", () => {
  it("requestConfig.params.incldead 默认 0（仅活种）", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/abtorrents.ts");

    const params = siteMetadata.search!.requestConfig!.params as any;
    const statusGroup = siteMetadata.category!.find((group) => group.key === "incldead")!;
    expect(params.incldead).toBe(0);
    // 与面板首项「仅活种」的 value 相同
    expect(statusGroup.options![0].value).toBe(params.incldead);
  });
});

describe("E1-A3 / A4 / C11 52pt：等级文案、共享 userInfo、判级数据源", () => {
  it("VIP/管理组等级不再保留占位式 privilege", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/52pt.ts");

    const staffLevels = siteMetadata.levelRequirements!.filter((level) => level.id >= 100 && level.id < 200);
    expect(staffLevels.length).toBeGreaterThan(0);
    for (const level of staffLevels) {
      expect(level.privilege).toBeUndefined();
    }
  });

  it("userInfo 内联了 invites 选择器（不再依赖已死亡站点 kunlun 的模块级对象）", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/52pt.ts");

    expect((siteMetadata.userInfo!.selectors as any).invites).toBeTruthy();
    expect(siteMetadata.userInfo!.process!.length).toBeGreaterThan(0);
  });

  it("guessUserLevelId 读实例 metadata：自定义等级表也能正确判级", async () => {
    const { default: Site52PT, siteMetadata } = await import("@ptd/site/definitions/52pt.ts");

    const site: any = new Site52PT({
      ...(siteMetadata as any),
      levelRequirements: [{ id: 42, name: "自定义等级", nameAka: ["Custom"] }],
    });
    expect(site.guessUserLevelId({ levelName: "自定义等级" })).toBe(42);
    expect(site.guessUserLevelId({ levelName: "Custom" })).toBe(42);
  });
});

describe("E1-A5 1337x：未知 sub id 的 category 不再是 undefined", () => {
  it("命中映射表时保持原值，未命中时兜底 Other/Other", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/1337x.ts");

    const filter = (siteMetadata.search!.selectors as any).category.filters[0] as (q: string) => string;
    expect(filter("/sub/42")).toBe("Movies/HD");
    expect(filter("/sub/999999")).toBe("Other/Other");
  });
});

describe("E1-B1 / B2 / B3 与 E1-C2 aidoruonline", () => {
  it("默认 pcat 是真实分类值，不再是被二次编码的 Show+All", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/aidoruonline.ts");

    const params = siteMetadata.search!.requestConfig!.params as any;
    const pcatOptions = siteMetadata.category!.find((group) => group.key === "pcat")!.options!;
    expect(params.pcat).toBe("Show All");
    expect(pcatOptions.some((option) => option.value === params.pcat)).toBe(true);
  });

  it("seedingPage 取斜杠后的总页数", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/aidoruonline.ts");

    const filter = (siteMetadata.userInfo!.selectors as any).seedingPage.filters[0] as (q: string) => number;
    expect(filter("Page 1 / 3")).toBe(3);
    expect(filter("Page 4 / 12")).toBe(12);
    expect(filter("没有分页信息")).toBe(0);
  });

  it("不再输出 -1 哨兵作为分享率（∞ 交给引擎按上传/下载推导）", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/aidoruonline.ts");

    expect((siteMetadata.userInfo!.selectors as any).ratio).toBeUndefined();
  });

  it("恒不成立的下载链接兜底覆写已删除", async () => {
    const { default: AidoruOnline } = await import("@ptd/site/definitions/aidoruonline.ts");

    expect(Object.prototype.hasOwnProperty.call(AidoruOnline.prototype, "getTorrentDownloadLink")).toBe(false);
  });

  it("getUserInfoResult 用 classifySiteError：网络错误不再被报成解析失败", async () => {
    const { default: AidoruOnline, siteMetadata } = await import("@ptd/site/definitions/aidoruonline.ts");
    const { EResultParseStatus } = await import("@ptd/site/types.ts");

    const site: any = new AidoruOnline(siteMetadata as any);
    vi.spyOn(site, "request").mockRejectedValue(new Error("Network Error: timeout"));

    const result = await site.getUserInfoResult({});
    expect(result.status).toBe(EResultParseStatus.unknownError);
    expect(result.statusMsg).toContain("Network Error");
  });

  it("getUserInfoResult 复刻基类零命中守卫：详情页改版时报 parseError 而不是 success", async () => {
    const { default: AidoruOnline, siteMetadata } = await import("@ptd/site/definitions/aidoruonline.ts");
    const { EResultParseStatus } = await import("@ptd/site/types.ts");

    const site: any = new AidoruOnline(siteMetadata as any);
    const userCp = makeDoc(`<a href="/forum/member.php?action=profile&uid=42">profile</a>`);
    const account = makeTitledDoc("Account");
    const request = vi.spyOn(site, "request");
    request.mockResolvedValueOnce({ data: userCp } as any).mockResolvedValueOnce({ data: account } as any);

    const result = await site.getUserInfoResult({});
    expect(result.status).toBe(EResultParseStatus.parseError);
    expect(result.statusMsg).toContain("未命中");
  });
});

describe("E1-B4 animetosho：Today/Yesterday 按 UTC 日历补全", () => {
  it("宿主时区为 +0800 时，Today 仍取 UTC 的当天", async () => {
    vi.useFakeTimers();
    // UTC 2024-01-01 20:00 = 宿主（+0800）2024-01-02 04:00
    vi.setSystemTime(new Date("2024-01-01T20:00:00Z"));
    const { siteMetadata } = await import("@ptd/site/definitions/animetosho.ts");

    const filter = (siteMetadata.search!.selectors as any).time.filters[0] as (q: string) => string;
    expect(filter("Today 01:59")).toBe("01/01/2024 01:59");
    expect(filter("Yesterday 23:39")).toBe("31/12/2023 23:39");
    expect(filter("03/06/2011 08:17")).toBe("03/06/2011 08:17");
  });
});

describe("E1-B5 alpharatio：Adonis/Cyclops/Chimera 不再复制上一级权限文案", () => {
  it("id 9/10/11 的 privilege 被省略，id 8 Satyr 保留自身文案", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/alpharatio.ts");

    const levels = siteMetadata.levelRequirements!;
    for (const id of [9, 10, 11]) {
      expect(levels.find((level) => level.id === id)!.privilege).toBeUndefined();
    }
    expect(levels.find((level) => level.id === 8)!.privilege).toContain("Harpy");
  });
});

describe("E1-B6 animebytes：passkey 取 RSS 链接最后一段", () => {
  it("`/{username}/{passkey}` 形态下得到 passkey 而不是 username", async () => {
    const { default: AnimeBytes, siteMetadata } = await import("@ptd/site/definitions/animebytes.ts");

    const site: any = new AnimeBytes({ ...(siteMetadata as any), urls: ["https://animebytes.tv/"] });
    site.retrieveRuntimeSettings = vi.fn().mockResolvedValue(null);
    site.storeRuntimeSettings = vi.fn().mockResolvedValue(undefined);
    site.request = vi.fn().mockResolvedValue({
      data: makeDoc(
        `<a class="username" href="/user/alice">alice</a>` +
          `<link href="/feed/rss_torrents_all/alice/passkey0123456789abcdef01234567">`,
      ),
    });

    const baseUserInfo = await site.getBaseUserInfo();
    expect(baseUserInfo.passkey).toBe("passkey0123456789abcdef01234567");

    // 只有 passkey 一段时结果不变
    site.request = vi.fn().mockResolvedValue({
      data: makeDoc(`<link href="/feed/rss_torrents_all/passkey-short">`),
    });
    const singleSegment = await site.getBaseUserInfo();
    expect(singleSegment.passkey).toBe("passkey-short");
  });
});

describe("E1-B8 anisource：时区偏移不再硬编码进时间过滤器", () => {
  it("过滤器只返回墙上时间串，偏移交给 metadata.timezoneOffset", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/anisource.ts");

    const timeQuery = (siteMetadata.search!.selectors as any).time;
    const filter = timeQuery.filters[0] as (q: string) => string;
    expect(filter("2010-06-07 at 13:29 Central US (UTC -9:00)")).toBe("2010-06-07 13:29");
    expect(filter("无法解析的文案")).toBe("");
    expect(timeQuery.filters[1]).toEqual({ name: "parseTime", args: ["yyyy-MM-dd HH:mm"] });
    expect(siteMetadata.timezoneOffset).toBe("-0900");
  });
});

describe("E1b-C1 / C6 / C7 audiences", () => {
  it("「粤语」不再与「原创」共用同一选择器（所有 tag 选择器唯一）", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/audiences.ts");

    const tags = siteMetadata.search!.selectors!.tags as Array<{ name: string; selector: string }>;
    const selectors = tags.map((tag) => tag.selector);
    expect(new Set(selectors).size).toBe(selectors.length);
    expect(tags.some((tag) => tag.name === "粤语")).toBe(false);
  });

  it("豆瓣高级搜索仍写入 search_area=5", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/audiences.ts");

    const douban = (siteMetadata.search!.advanceKeywordParams as any).douban;
    const config = douban.requestConfigTransformer({ requestConfig: { params: {} } });
    expect(config.params.search_area).toBe(5);
  });

  it("做种分页请求的 Referer 跟随站点（镜像）地址", async () => {
    const { default: Audiences, siteMetadata } = await import("@ptd/site/definitions/audiences.ts");

    const site: any = new Audiences({ ...(siteMetadata as any), urls: ["https://mirror.example/"] });
    const request = vi.spyOn(site, "request").mockResolvedValue({ data: "<table></table>" } as any);

    await site.requestUserSeedingPage(7, "seeding");
    expect((request.mock.calls[0][0] as any).headers.Referer).toBe("https://mirror.example/userdetails.php");
  });
});

describe("E1-C1 / C3 / C4 audiobookbay", () => {
  it("list 有 urlPattern，列表页能被识别（不再只有 excludeUrlPattern）", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/audiobookbay.ts");

    const entry = siteMetadata.list![0];
    const patterns = ([] as (string | RegExp)[]).concat((entry.urlPattern ?? []) as any);
    expect(patterns.length).toBeGreaterThan(0);
    const matches = (url: string) => patterns.some((pattern) => new RegExp(pattern as string, "i").test(url));
    expect(matches("https://audiobookbay.lu/")).toBe(true);
    expect(matches("https://audiobookbay.lu/page/2/")).toBe(true);
    expect(matches("https://audiobookbay.lu/?s=dune")).toBe(true);
    // 详情页由 excludeUrlPattern 排除（这里只验证详情页不因该正则被误判为别的形态）
    expect(siteMetadata.detail!.urlPattern).toContain("/abss/");
  });

  it("Posted 日期只做字符串归一化，时区交给具名 parseTime", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/audiobookbay.ts");

    const timeQuery = (siteMetadata.search!.selectors as any).time;
    const filter = timeQuery.filters[0] as (q: string) => string;
    expect(filter("File Size: 209.5 MBs\nPosted: 22 Oct 2026\nLanguage: English")).toBe("22 Oct 2026");
    expect(filter("没有日期")).toBe("");
    expect(timeQuery.filters[1]).toEqual({ name: "parseTime", args: ["d MMM yyyy"] });
    expect(siteMetadata.timezoneOffset).toBe("+0100");
  });

  it("seeders/leechers/completed 不再输出字符串 N/A", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/audiobookbay.ts");

    const selectors = siteMetadata.search!.selectors as any;
    expect(selectors.seeders).toBeUndefined();
    expect(selectors.leechers).toBeUndefined();
    expect(selectors.completed).toBeUndefined();
  });
});

describe("E1b-C2 / C5 audionews", () => {
  it("完成数不再复用回帖数，也不再声明 N/A 字符串字段", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/audionews.ts");

    const selectors = siteMetadata.search!.selectors as any;
    expect(selectors.completed).toBeUndefined();
    expect(selectors.comments).toBeTruthy();

    const profileStep = siteMetadata.userInfo!.process!.at(-1)!;
    expect((profileStep.selectors as any).bonus).toBeUndefined();
    expect((profileStep.selectors as any).bonusPerHour).toBeUndefined();
  });
});

describe("E1-C2 / C13 / C15 / C16 bakabt", () => {
  it("completed 把 123k 展开成数字", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/bakabt.ts");

    const completed = (siteMetadata.search!.selectors as any).completed;
    const filters = completed.filters as Array<(q: string) => any>;
    const expand = filters[filters.length - 1];
    expect(expand("123k")).toBe(123000);
    expect(expand("12.3k")).toBe(12300);
    expect(expand("999")).toBe(999);
    expect(expand("???")).toBe(0);
  });

  it("Alternative versions 行的判定对空白不敏感", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/bakabt.ts");

    const rowsFilter = (siteMetadata.search!.selectors as any).rows.filter as (rows: Element[]) => Element[];
    const altRow = document.createElement("tr");
    altRow.className = "torrent_alt";
    altRow.textContent = "Alternative versions:\n";
    const normalRow = document.createElement("tr");
    normalRow.className = "torrent";

    expect(rowsFilter([altRow, normalRow])).toEqual([normalRow]);
  });

  it("levelName 过滤器在文案变化时退化为原始文本而不是抛 TypeError", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/bakabt.ts");

    const profileStep = siteMetadata.userInfo!.process!.at(-1)!;
    const filter = (profileStep.selectors as any).levelName.filters[0];
    expect(filter("(User - 1.2 TiB)")).toBe("1.2 TiB");
    expect(filter("Power User")).toBe("Power User");
  });

  it("不再输出 -1 哨兵作为分享率", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/bakabt.ts");

    expect((siteMetadata.userInfo!.process!.at(-1)!.selectors as any).ratio).toBeUndefined();
  });
});

describe("E1b-C9 / C10 / C11 / C12 / C18 / C9(loggedCheck) beyondhd", () => {
  it("download_url 为 null 时归一成空串（交给详情页兜底），不再产出 /api/null", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/beyondhd.ts");

    const linkQuery = siteMetadata.search!.selectors!.link as any;
    const filter = linkQuery.filters[0];
    expect(filter(null)).toBe("");
    expect(filter(undefined)).toBe("");
    expect(filter("https://beyondhd.me/torrents/123")).toBe("https://beyondhd.me/download/123");
  });

  it("「种子状态」筛选写进 data（而不是 query）", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/beyondhd.ts");

    const seedStatus = siteMetadata.category!.find((group) => group.key === "seedStatus")!;
    expect(seedStatus.keyPath).toBe("data");
    // 同文件其它筛选组也都在 data
    expect(siteMetadata.category!.find((group) => group.key === "categories")!.keyPath).toBe("data");
  });

  it("promo 标签的百分比表示减免比例", async () => {
    const { default: BeyondHD, siteMetadata } = await import("@ptd/site/definitions/beyondhd.ts");

    const site: any = new BeyondHD(siteMetadata as any);
    const torrent = site.parseTorrentRowForTags({}, { promo25: 1, promo50: 0, promo75: 1 }, {
      searchEntry: { selectors: siteMetadata.search!.selectors },
    } as any);

    const names = (torrent.tags ?? []).map((tag: { name: string }) => tag.name);
    expect(names).toEqual(expect.arrayContaining(["25%", "75%"]));
    expect(names).not.toContain("50%");
  });

  it("messageCount 不再伪造 11", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/beyondhd.ts");

    const messageCount = siteMetadata.userInfo!.selectors!.messageCount as any;
    const el = document.createElement("span");
    el.textContent = "";
    expect(messageCount.elementProcess(el)).toBe(1);
    el.textContent = "7";
    expect(messageCount.elementProcess(el)).toBe(7);
  });

  it("getUserInfoResult 用 classifySiteError：网络错误归为可重试的 unknownError", async () => {
    const { default: BeyondHD, siteMetadata } = await import("@ptd/site/definitions/beyondhd.ts");
    const { EResultParseStatus } = await import("@ptd/site/types.ts");

    const site: any = new BeyondHD(siteMetadata as any);
    vi.spyOn(site, "request").mockRejectedValue(new Error("Network Error: timeout"));

    const result = await site.getUserInfoResult({});
    expect(result.status).toBe(EResultParseStatus.unknownError);
    expect(result.statusMsg).toContain("Network Error");
  });

  it("loggedCheck 只在鉴权特征上返回 false（限流/参数错误不再要求重新登录）", async () => {
    const { default: BeyondHD, siteMetadata } = await import("@ptd/site/definitions/beyondhd.ts");

    const site: any = new BeyondHD(siteMetadata as any);
    const check = (status: number, data: any) =>
      site.loggedCheck({ status, config: { url: "/api/torrents/secret-key" }, data });

    expect(check(200, { success: false, status_code: 0, message: "Too many requests" })).toBe(true);
    expect(check(200, { success: false, status_code: 0, message: "Invalid API Key" })).toBe(false);
    expect(check(401, {})).toBe(false);
    expect(check(200, { success: true, status_code: 1 })).toBe(true);
  });
});

describe("E1b-C17 bibliotik：做种分页异常不再让整次用户信息刷新失败", () => {
  it("分页请求抛错时保留 success 与已取到的字段，只透传 statusMsg", async () => {
    const { default: Bibliotik, siteMetadata } = await import("@ptd/site/definitions/bibliotik.ts");
    const { default: PrivateSite } = await import("@ptd/site/schemas/AbstractPrivateSite.ts");
    const { EResultParseStatus } = await import("@ptd/site/types.ts");

    const site: any = new Bibliotik(siteMetadata as any);
    vi.spyOn(PrivateSite.prototype as any, "getUserInfoResult").mockResolvedValue({
      site: "bibliotik",
      status: EResultParseStatus.success,
      updateAt: Date.now(),
      id: 42,
    });
    vi.spyOn(site, "parseUserInfoForSeedingStatus").mockRejectedValue(new Error("Network Error: seeding page down"));

    const result = await site.getUserInfoResult({});
    expect(result.status).toBe(EResultParseStatus.success);
    expect(result.id).toBe(42);
    expect(result.statusMsg).toContain("Network Error");
  });
});

describe("E1b-C19 bitbr：ratio 是 number", () => {
  it("elementProcess 返回数字而不是字符串", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/bitbr.ts");

    const ratioQuery = (siteMetadata.userInfo!.selectors as any).ratio;
    const el = document.createElement("span");
    el.className = "medium";
    el.textContent = "Ratio: 1.23 Uploaded: 10 GiB Downloaded: 8 GiB Torrents: 5";

    const ratio = ratioQuery.elementProcess(el);
    expect(ratio).toBe(1.23);
    expect(typeof ratio).toBe("number");

    el.textContent = "没有任何信息";
    expect(ratioQuery.elementProcess(el)).toBeUndefined();
  });
});

describe("E1b-C7 / C27 bitporn：subTitle 是字符串且不再保留死代码", () => {
  it("命中时拼接关键词徽标，未命中时返回空串", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/bitporn.ts");

    const subTitle = (siteMetadata.search!.selectors as any).subTitle;
    const el = document.createElement("div");
    el.className = "torrent-keywords-container";
    el.innerHTML = '<a class="torrent-keywords-badge">TagA</a><a class="torrent-keywords-badge">TagB</a>';

    expect(subTitle.elementProcess(el)).toBe("TagA, TagB");
    expect(subTitle.elementProcess(undefined)).toBe("");
  });
});

describe("E1b-C8 / C20 btschool：cache buster 每次请求重新求值", () => {
  it("requestConfigTransformer 每次生成新的 _，且保留原有 params", async () => {
    vi.useFakeTimers();
    const { siteMetadata } = await import("@ptd/site/definitions/btschool.ts");

    const step = siteMetadata.userInfo!.process![0];
    const transformer = step.requestConfigTransformer!;

    vi.setSystemTime(1_000);
    const first: any = transformer({ params: { a: 1 } } as any, {} as any, null as any);
    vi.setSystemTime(2_000);
    const second: any = transformer({ params: { a: 1 } } as any, {} as any, null as any);

    expect(first.params).toEqual({ a: 1, _: 1_000 });
    expect(second.params).toEqual({ a: 1, _: 2_000 });
  });
});

describe("E1b-C3 / C26 btetree：年份推断不再 2027 失效", () => {
  const rowHtml = (time: string) => `<td>1</td><td>2</td><td>3</td><td>4</td><td>${time}</td>`;

  it("超出阈值表 / id 不可用时按当前年兜底，表内 id 仍按表推断", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2027-06-15T12:00:00Z"));
    const { default: BtEtree, siteMetadata } = await import("@ptd/site/definitions/btetree.ts");

    class Probe extends BtEtree {
      rowTime(torrent: any, row: Element, searchConfig: any) {
        return this.parseTorrentRowForTime(torrent, row, searchConfig);
      }
    }
    const probe: any = new Probe(siteMetadata as any);
    const searchConfig = { searchEntry: { selectors: { time: siteMetadata.search!.selectors!.time } } } as any;

    // 表内 id：仍然是 2024（与既有 timezone-sweep 用例一致）
    expect(probe.rowTime({ id: 621061 }, document.createElement("tr"), searchConfig)).toBeDefined();
    const inTableRow = document.createElement("tr");
    inTableRow.innerHTML = rowHtml("01/02 03:04");
    expect(probe.rowTime({ id: 621061 }, inTableRow, searchConfig).time).toBe(Date.parse("2024-01-02T03:04:00-05:00"));

    // 超出表末（旧实现会永远停在 2026）
    const futureRow = document.createElement("tr");
    futureRow.innerHTML = rowHtml("05/06 07:08");
    expect(probe.rowTime({ id: 999999999 }, futureRow, searchConfig).time).toBe(
      Date.parse("2027-05-06T07:08:00-05:00"),
    );

    // id 解析失败（NaN，旧实现会一路覆盖到表末 2026）
    const nanRow = document.createElement("tr");
    nanRow.innerHTML = rowHtml("05/06 07:08");
    expect(probe.rowTime({ id: "not-a-number" }, nanRow, searchConfig).time).toBe(
      Date.parse("2027-05-06T07:08:00-05:00"),
    );

    // 跨年：1 月列表里出现 12/31 → 上一年
    const crossYearRow = document.createElement("tr");
    crossYearRow.innerHTML = rowHtml("12/31 23:59");
    expect(probe.rowTime({ id: 999999999 }, crossYearRow, searchConfig).time).toBe(
      Date.parse("2026-12-31T23:59:00-05:00"),
    );
  });
});

describe("E1b-C22 broadcasthenet：imdb/series 路径补回 time 与 Free", () => {
  it("解析 span.time[title] 的绝对时间，Free 生效且不伪造 H&R", async () => {
    const { default: BroadcastTheNet, siteMetadata } = await import("@ptd/site/definitions/broadcasthenet.ts");

    const doc = new DOMParser().parseFromString(
      `<html><body><table class="torrent_table">
        <tr class="colhead_dark"><td><strong>Season 1</strong></td></tr>
        <tr class="group_torrent">
          <td><a href="/torrents.php?id=1&torrentid=11">Episode 1</a>
              <span class="time" title="2024-01-02 03:04:05">2 days ago</span></td>
          <td><a href="/torrents.php?action=download&id=11&torrent_pass=x">DL</a></td>
          <td><strong>Freeleech!</strong></td>
          <td>1.5 GB</td><td>10</td><td>2</td><td>0</td>
        </tr>
      </table></body></html>`,
      "text/html",
    );

    const site: any = new BroadcastTheNet({ ...(siteMetadata as any), timezoneOffset: "+0000" });
    const torrents = site.parseSeriesPageTorrents(doc, "https://broadcasthe.net/series.php?id=1");

    expect(torrents).toHaveLength(1);
    expect(torrents[0].time).toBe(Date.parse("2024-01-02T03:04:05Z"));
    const names = (torrents[0].tags ?? []).map((tag: { name: string }) => tag.name);
    expect(names).toContain("Free");
    expect(names).not.toContain("H&R");
  });
});

describe("E1-C6 avistaz：audio/subtitle 缺 language 时不抛错", () => {
  it("缺 language 的元素被过滤，其余元素仍能判定中配", async () => {
    const { default: Avistaz, siteMetadata } = await import("@ptd/site/definitions/avistaz.ts");

    const site: any = new Avistaz(siteMetadata as any);
    const torrent = site.parseTorrentRowForTags(
      {},
      {
        audio: [{ language: undefined }, { language: "Chinese" }],
        subtitle: [{ language: undefined }],
      },
      { searchEntry: { selectors: {} } } as any,
    );

    const names = (torrent.tags ?? []).map((tag: { name: string }) => tag.name);
    expect(names).toContain("中配");
    expect(names).not.toContain("中字");
  });
});
