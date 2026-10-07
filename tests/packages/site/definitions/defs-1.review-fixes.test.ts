/**
 * defs-1 包审查修复的行为回归（DEFS1-1 / 1-2 / 1-3 / 1-4 / 1-5 / 1-6 / 1-8）。
 * 全部用例都在本地 DOM（happy-dom）与仓库真实的判级/选择器实现上跑，不发网络请求。
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@ptd/site/utils/adapter.ts", () => ({ logMessage: vi.fn() }));
(globalThis as any).__BROWSER__ ??= "chrome";

const GiB = 1024 ** 3;
const TiB = 1024 ** 4;
const DAY = 24 * 3600 * 1000;
const daysAgo = (days: number) => Date.now() - days * DAY;

const makeDoc = (html: string) => new DOMParser().parseFromString(`<html><body>${html}</body></html>`, "text/html");

const makeUserInfo = (extra: Record<string, unknown>) =>
  ({ site: "probe", status: 0, updateAt: Date.now(), ...extra }) as any;

describe("DEFS1-1 desigaane：没有门槛的 5/6/7 级不再把用户抬到顶级", () => {
  it("等级名未命中时按可判定门槛判级（引擎回落返回 4）", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/desigaane.ts");
    // 第四波：站内 guessUserLevelId override 已删除（引擎已具备同语义），站点实例回落为 GazelleJSONAPI，
    // 这里直接以引擎类构造，验证的就是站点实际使用的判级路径。
    const { default: GazelleJSONAPI } = await import("@ptd/site/schemas/GazelleJSONAPI.ts");
    const { guessUserLevelId: baseGuessUserLevelId } = await import("@ptd/site/utils/level.ts");

    const userInfo = makeUserInfo({
      levelName: "未识别的自定义头衔",
      uploaded: 200 * GiB,
      uploads: 50,
      ratio: 0.7,
      joinTime: daysAgo(40),
    });
    const levelRequirements = siteMetadata.levelRequirements!;

    // 基类：5/6/7 级只剩 name/privilege（无可判定门槛），不再被当作已满足 → 只按可判定门槛取最高已满足等级 = 4
    expect(baseGuessUserLevelId(userInfo, levelRequirements)).toBe(4);

    const site: any = new GazelleJSONAPI(siteMetadata as any);
    // 站点不再有 override，结果与引擎一致：不再把用户抬到没有门槛的 Elite TM(7)
    expect(site.guessUserLevelId(userInfo)).toBe(4);

    // 等级名/别名命中时仍然给出站点真实等级
    expect(site.guessUserLevelId({ ...userInfo, levelName: "Elite" })).toBe(4);
    expect(site.guessUserLevelId({ ...userInfo, levelName: "Torrent Master" })).toBe(5);
    expect(site.guessUserLevelId({ ...userInfo, levelName: "Power TM" })).toBe(6);
    expect(site.guessUserLevelId({ ...userInfo, levelName: "Elite TM" })).toBe(7);
  });
});

describe("DEFS1-2 broadcasthenet：共享 Free 标签不再被覆盖", () => {
  it("同一行仍解析出 Gazelle 的 Free 标签，并按其全站 H&R 身份附带恒真 H&R", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/broadcasthenet.ts");
    const { default: BroadcastTheNet } = await import("@ptd/site/definitions/broadcasthenet.ts");

    const tags = (siteMetadata.search!.selectors as any).tags as Array<{ name: string; selector: string }>;
    expect(tags.some((tag) => tag.name === "Free" && tag.selector.includes("Freeleech!"))).toBe(true);
    // DEFS2-2 复核：broadcasthenet 属上游 fb79a2a7（PR #336）「global H&R sites」名单，
    // 恒真 H&R 是「全站 H&R」的刻意表达，第三波删除已由第四波恢复（判据见 hrs-sweep 测试文件头）
    expect(tags.some((tag) => tag.name === "H&R" && tag.selector === "*")).toBe(true);

    // happy-dom 下 matchesSelector 只对已挂到文档上的元素生效，这里把行挂到 body 上再解析
    const table = document.createElement("table");
    const tbody = document.createElement("tbody");
    const row = document.createElement("tr");
    row.innerHTML = "<td><strong>Freeleech!</strong></td>";
    tbody.appendChild(row);
    table.appendChild(tbody);
    document.body.appendChild(table);

    try {
      const site: any = new BroadcastTheNet(siteMetadata as any);
      const torrent = site.parseTorrentRowForTags({}, row, {
        searchEntry: { selectors: siteMetadata.search!.selectors },
        requestConfig: { url: "https://broadcasthe.net/" },
      });

      // 共享 Free 标签仍被解析出来；恒真 H&R 按其全站 H&R 身份一并出现
      expect(torrent.tags!.map((tag: any) => tag.name)).toEqual(["Free", "H&R"]);
    } finally {
      document.body.innerHTML = "";
    }
  });
});

describe("DEFS1-3 做种类等级插在阶梯中间时不再判低一级", () => {
  it("darkpeers：5TiB 上传 / 500GiB 做种的用户判到 SuperUser(4)，而不是 PowerUser(2)", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/darkpeers.ts");
    // 第四波：站内 override 与共享 helper 已删除（引擎已具备同语义），站点实例回落为 Unit3D
    const { default: Unit3D } = await import("@ptd/site/schemas/Unit3D.ts");
    const { guessUserLevelId: baseGuessUserLevelId } = await import("@ptd/site/utils/level.ts");

    const userInfo = makeUserInfo({
      levelName: "未识别的自定义头衔",
      uploaded: 5 * TiB,
      ratio: 0.8,
      seedingSize: 500 * GiB,
      uploads: 5,
      joinTime: daysAgo(100),
    });
    const levelRequirements = siteMetadata.levelRequirements!;

    // 基类已改为「取所有门槛都满足的最高 user 等级」：id3 Seeder 的 3TiB 做种不满足，
    // 但其后的 id4 SuperUser（5TiB 上传 / 500GiB 做种）满足 → 4，不再因中途插有特殊等级而短路在 id2
    expect(baseGuessUserLevelId(userInfo, levelRequirements)).toBe(4);

    const site: any = new Unit3D(siteMetadata as any);
    expect(site.guessUserLevelId(userInfo)).toBe(4);

    // 等级名命中时仍然是站点真实等级（Seeder=3 / Collector=5 / Legend=10）
    expect(site.guessUserLevelId({ ...userInfo, levelName: "Seeder" })).toBe(3);
    expect(site.guessUserLevelId({ ...userInfo, levelName: "Collector" })).toBe(5);
    expect(site.guessUserLevelId({ ...userInfo, levelName: "Legend" })).toBe(10);
  });

  it("blutopia：做种型 BluSeeder(7) 不再因缺少 100TiB 上传门槛被判成 BluUser(2)", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/blutopia.ts");
    // 第四波：站内 override 与共享 helper 已删除（引擎已具备同语义），站点实例回落为 Unit3D
    const { default: Unit3D } = await import("@ptd/site/schemas/Unit3D.ts");
    const { guessUserLevelId: baseGuessUserLevelId } = await import("@ptd/site/utils/level.ts");

    const userInfo = makeUserInfo({
      levelName: "未识别的自定义头衔",
      uploaded: 1 * TiB,
      seedingSize: 5 * TiB,
      averageSeedingTime: 40 * 24 * 3600,
      joinTime: daysAgo(40),
    });
    const levelRequirements = siteMetadata.levelRequirements!;

    // 基类同样取最高已满足等级：id2..id6 的 100TiB 上传等门槛不满足，id7 BluSeeder 的做种门槛满足 → 7
    expect(baseGuessUserLevelId(userInfo, levelRequirements)).toBe(7);

    const site: any = new Unit3D(siteMetadata as any);
    expect(site.guessUserLevelId(userInfo)).toBe(7);
    expect(site.guessUserLevelId({ ...userInfo, levelName: "BluArchivist" })).toBe(9);
  });
});

describe("DEFS1-4 dicmusic：uniqueGroups 门槛改用引擎求值的 groups", () => {
  it("id6 门槛改写为 groups: 300，并真正参与判级", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/dicmusic.ts");
    const { levelRequirementUnMet } = await import("@ptd/site/utils/level.ts");

    const level6 = siteMetadata.levelRequirements!.find((level) => level.id === 6)! as any;
    expect(level6.groups).toBe(300);
    expect(level6.uniqueGroups).toBeUndefined();

    const unmetWithZeroGroups = levelRequirementUnMet(
      makeUserInfo({ uploaded: 0, downloaded: 0, ratio: 0, groups: 0 }),
      level6,
    );
    expect(unmetWithZeroGroups.groups).toBe(300);

    const unmetWithEnoughGroups = levelRequirementUnMet(
      makeUserInfo({ uploaded: 1 * TiB, downloaded: 0, ratio: 2, groups: 400, uploads: 200 }),
      level6,
    );
    expect(unmetWithEnoughGroups.groups).toBeUndefined();
  });
});

describe("DEFS1-5 版式变化时不再因裸取下标抛 TypeError", () => {
  it("exttorrents：取不到注入脚本时 extractWindowVar 返回 null，搜索降级而不是整体失败", async () => {
    const { default: ExtTorrents, siteMetadata } = await import("@ptd/site/definitions/exttorrents.ts");
    const { default: BittorrentSite } = await import("@ptd/site/schemas/AbstractBittorrentSite.ts");

    const site: any = new ExtTorrents(siteMetadata as any);
    // 旧实现会对 undefined 取 .textContent → TypeError
    expect(site.extractWindowVar(undefined, "pageToken")).toBeNull();
    expect(site.extractWindowVar(undefined, "searchPageToken")).toBeNull();

    // happy-dom 下 DOMParser 产物不是全局 Document 的实例（引擎会走 JSON 分支），
    // 这里把父类 transformSearchPage 打桩，专注验证本站的注入脚本守卫逻辑。
    const superSpy = vi
      .spyOn(BittorrentSite.prototype as any, "transformSearchPage")
      .mockResolvedValue([{ title: "Some Movie", id: 123 }]);

    try {
      const noScriptDoc = document.implementation.createHTMLDocument("exttorrents");
      noScriptDoc.body.innerHTML = "<div>没有注入脚本</div>";
      const torrents = await site.transformSearchPage(noScriptDoc, {} as any);
      // 不再抛错，浏览结果原样返回（link 里没有换取磁力所需的 "pageToken|csrfToken" 标记）
      expect(torrents).toEqual([{ title: "Some Movie", id: 123 }]);

      const tokenDoc = document.implementation.createHTMLDocument("exttorrents-with-token");
      tokenDoc.body.innerHTML =
        "<script src='app.js'></script><script>window.searchPageToken = 'PT'; window.csrfToken = 'CT';</script>";
      const torrentsWithTokens = await site.transformSearchPage(tokenDoc, {} as any);
      expect(torrentsWithTokens[0].link).toBe("PT|CT");
    } finally {
      superSpy.mockRestore();
    }
  });

  it("audiobookbay：详情页缺少 Info Hash/标题单元格时返回空串而不是抛错", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/audiobookbay.ts");
    const linkQuery = siteMetadata.detail!.selectors!.link as any;

    expect(linkQuery.elementProcess(makeDoc("<div>什么也没有</div>"))).toBe("");
  });

  it("audiences：做种统计行缺列时跳过该字段而不是抛错", async () => {
    const { default: Audiences, siteMetadata } = await import("@ptd/site/definitions/audiences.ts");
    const site: any = new Audiences(siteMetadata as any);

    // 只有 2 个 td：旧实现会读取 tds[2] → TypeError
    site.requestUserSeedingPage = vi.fn().mockResolvedValue("<table><tr><td>Total</td><td>12</td></tr></table>");
    const shortRowResult = await site.parseUserInfoForSeedingStatus(makeUserInfo({ id: 42 }));
    expect(shortRowResult.seeding).toBeUndefined();
    expect(shortRowResult.seedingSize).toBeUndefined();

    // 列数正常时仍然解析出做种数与做种体积
    site.requestUserSeedingPage = vi
      .fn()
      .mockResolvedValue("<table><tr><td>Total</td><td>12</td><td>1.50 GB</td></tr></table>");
    const fullRowResult = await site.parseUserInfoForSeedingStatus(makeUserInfo({ id: 42 }));
    expect(fullRowResult.seeding).toBe(12);
    expect(fullRowResult.seedingSize).toBeGreaterThan(1024 ** 3);
  });
});

describe("DEFS1-6 dicmusic：判级键完全相同的 Elite TM / Elite TM + 不再停在较高一级", () => {
  it("未命中等级名的用户判到 id7，命中名字时仍能区分 id7 与 id8", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/dicmusic.ts");
    const { default: DICMusic } = await import("@ptd/site/definitions/dicmusic.ts");
    const { guessUserLevelId: baseGuessUserLevelId } = await import("@ptd/site/utils/level.ts");

    const userInfo = makeUserInfo({
      levelName: "未识别的自定义头衔",
      uploaded: 700 * GiB,
      uploads: 200,
      groups: 400,
      perfectFlacs: 600,
      ratio: 1.2,
      joinTime: daysAgo(100),
    });
    const levelRequirements = siteMetadata.levelRequirements!;

    // 基类同样跳过判级键逐字相同的重复等级：id8 与 id7 判级键一致，用户停在先出现的 id7
    expect(baseGuessUserLevelId(userInfo, levelRequirements)).toBe(7);

    // 第四波：dicmusic 的 guessUserLevelId override 已删除，这里验证的正是站点现在走的引擎路径
    const site: any = new DICMusic(siteMetadata as any);
    expect(site.guessUserLevelId(userInfo)).toBe(7);
    expect(site.guessUserLevelId({ ...userInfo, levelName: "Elite TM" })).toBe(7);
    expect(site.guessUserLevelId({ ...userInfo, levelName: "Elite TM +" })).toBe(8);
  });
});

describe("DEFS1-8 freefarm：制作组选项不再同名不同值", () => {
  it("4 个待定制作组的选项名带上 team id，同一数组内没有重名选项", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/freefarm.ts");

    const teamCategory = siteMetadata.category!.find((category: any) => category.key === "team") as any;
    const names = teamCategory.options.map((option: any) => option.name);
    const values = teamCategory.options.map((option: any) => option.value);

    expect(new Set(names).size).toBe(names.length);
    expect(new Set(values).size).toBe(values.length);
    expect(names).toContain("待定（team=11）");
    expect(values).toContain(11);
  });
});
