/**
 * defs-2a 修复回归（DEFS2-1 / 2 / 3 / 4 / 5 / 6 / 9）。
 *
 * 只做选择器 / 过滤器 / 配置层面的行为断言，不发网络请求：
 * - DEFS2-1：hdroute 做种/下载人数取第 5/6 个计数块；
 * - DEFS2-2：H&R 恒真标签（selector:"*"）从 6 个定义里移除；
 * - DEFS2-3：nebulance 时间不再叠加宿主时区偏移，overlay 墙上时间按 -11:00 换算；
 * - DEFS2-4：huno JSON 行删掉永不生效的 DOM selector + case；
 * - DEFS2-5：hdcity 时间先归一化成字符串再交给具名 parseTime（按 +0800 换算）；
 * - DEFS2-6：hdclone 分类表按 Jackett hdclone.yml 重写；
 * - DEFS2-9：hdcity levelName 过滤器判空，不再抛错。
 */
import { describe, expect, it, vi } from "vitest";

// 站点定义会连带引入 @ptd/site 的运行时依赖（messages.ts 用到 __BROWSER__ 与 chrome API），
// 这里给出最小桩（与 definitionFixes.test.ts 一致），避免为纯配置断言去跑整个扩展环境。
vi.mock("@ptd/site/utils/adapter.ts", () => ({ logMessage: vi.fn() }));
(globalThis as any).__BROWSER__ ??= "chrome";

const makeDoc = (html: string) => new DOMParser().parseFromString(`<html><body>${html}</body></html>`, "text/html");

describe("hdroute seeders / leechers（DEFS2-1）", () => {
  it("取 .torrent-content-right 的第 5/6 个计数块，而不是 .torrent_count.strong 的下标 0/1", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/hdroute.ts");
    const selectors = siteMetadata.search!.selectors as any;

    const doc = makeDoc(
      `<dl id="dl_torrent_1"><dd><div class="torrent-content-right">${[11, 22, 33, 44, 55, 66]
        .map((n) => `<div class="torrent_count strong"><span>${n}</span></div>`)
        .join("")}</div></dd></dl>`,
    );

    const container = doc.querySelector(".torrent-content-right") as HTMLElement;
    expect(container).not.toBeNull();
    expect(selectors.seeders.elementProcess(container)).toBe(55);
    expect(selectors.leechers.elementProcess(container)).toBe(66);

    // 选择器链仍然能在行里命中容器（makeSelector 的 dd/dt/裸类名三种写法）
    expect(selectors.seeders.selector).toEqual(expect.arrayContaining([".torrent-content-right"]));
  });
});

describe("H&R 恒真标签（DEFS2-2）", () => {
  const targetFiles: Array<[string, () => Promise<any>]> = [
    ["lst", () => import("@ptd/site/definitions/lst.ts")],
    ["luminarr", () => import("@ptd/site/definitions/luminarr.ts")],
    ["nebulance", () => import("@ptd/site/definitions/nebulance.ts")],
    ["oldtoonsworld", () => import("@ptd/site/definitions/oldtoonsworld.ts")],
    ["onlyencodes", () => import("@ptd/site/definitions/onlyencodes.ts")],
    ["opencd", () => import("@ptd/site/definitions/opencd.ts")],
  ];

  it.each(targetFiles)('%s 的 tags 里没有恒真的 selector:"*"', async (_name, load) => {
    const { siteMetadata } = await load();
    const tags = (siteMetadata.search!.selectors as any).tags as Array<{ name: string; selector?: string }>;
    expect(tags.some((tag) => tag.name === "H&R" && tag.selector === "*")).toBe(false);
    // 任何标签都不允许用通配选择器（对任意行恒真）
    expect(tags.every((tag) => tag.selector !== "*")).toBe(true);
  });

  it.each(targetFiles)("%s 的空徽标行不再被贴上 H&R", async (_name, load) => {
    const { siteMetadata } = await load();
    const tags = (siteMetadata.search!.selectors as any).tags as Array<{ name: string; selector?: string }>;

    const { default: BittorrentSite } = await import("@ptd/site/schemas/AbstractBittorrentSite.ts");
    class Probe extends BittorrentSite {
      rowTags(row: Element) {
        return this.parseTorrentRowForTags({}, row, { searchEntry: { selectors: { tags } } } as any).tags;
      }
    }
    const probe = new Probe(siteMetadata as any);

    const row = document.createElement("tr");
    row.innerHTML = "<td><a href='/details'>x</a></td>";
    expect(probe.rowTags(row)).toEqual([]);
  });
});

describe("nebulance 时间（DEFS2-3）", () => {
  it("列表时间只走 parseTTL，不再叠加宿主 getTimezoneOffset 与 -11h", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/nebulance.ts");
    const { default: BittorrentSite } = await import("@ptd/site/schemas/AbstractBittorrentSite.ts");
    const filters = (siteMetadata.list![0].selectors!.time as any).filters as Array<any>;

    class Probe extends BittorrentSite {
      run(query: any, fs: any) {
        return this.runQueryFilters(query, fs);
      }
    }
    const probe = new Probe(siteMetadata as any);

    const value = probe.run("30 days", filters) as number;
    expect(Math.abs(Date.now() - 30 * 24 * 3600 * 1000 - value)).toBeLessThan(60 * 1000);
  });

  it("种子组 overlay 的墙上时间按 -11:00 换算成绝对时间戳", async () => {
    const { parseNblOverlayTime } = await import("@ptd/site/definitions/nebulance.ts");
    // 2024-01-02 03:04 (-11:00) = 2024-01-02T14:04Z
    expect(parseNblOverlayTime("2024-01-02 03:04", "-1100")).toBe(Date.parse("2024-01-02T03:04:00-11:00"));
  });
});

describe("huno status / progress（DEFS2-4）", () => {
  it("JSON 行删除永不生效的 DOM selector + case，回落到引擎缺省值", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/huno.ts");
    const { ETorrentStatus } = await import("@ptd/site/types/torrent.ts");
    const { default: BittorrentSite } = await import("@ptd/site/schemas/AbstractBittorrentSite.ts");
    const selectors = siteMetadata.search!.selectors as any;

    expect(selectors.status.selector).toBeUndefined();
    expect(selectors.status.case).toBeUndefined();
    expect(selectors.progress.selector).toBeUndefined();
    expect(selectors.progress.case).toBeUndefined();

    class Probe extends BittorrentSite {
      field(row: object, key: string) {
        return this.getFieldData(row, selectors[key]);
      }
    }
    const probe = new Probe(siteMetadata as any);
    const row = { id: 1, name: "x", attributes: { seeders: 3, leechers: 1 } };
    expect(probe.field(row, "status")).toBe(ETorrentStatus.unknown);
    expect(probe.field(row, "progress")).toBe(0);
  });
});

describe("hdcity 时间与等级（DEFS2-5 / DEFS2-9）", () => {
  it("列表/用户时间过滤器先归一化成字符串，再交给具名 parseTime", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/hdcity.ts");
    const selectors = siteMetadata.search!.selectors as any;
    const listFilters = selectors.time.filters as Array<any>;

    expect(listFilters[0]("发布时间 2024-01-02 03:04:05")).toBe("2024-01-02 03:04:05");
    expect(listFilters[1]).toEqual({ name: "parseTime", args: ["yyyy-MM-dd HH:mm:ss"] });
    // 无时间戳时返回空串而不是抛 TypeError（旧实现用 match(...)!）
    expect(listFilters[0]("发布时间未知")).toBe("");

    const stepSelectors = siteMetadata.userInfo!.process![0].selectors as any;
    for (const key of ["joinTime", "lastAccessAt"]) {
      const filters = stepSelectors[key].filters as Array<any>;
      expect(filters[0]("加入日期 2024-01-02 03:04:05")).toBe("2024-01-02 03:04:05");
      expect(filters[1]).toEqual({ name: "parseTime", args: ["yyyy-MM-dd HH:mm:ss"] });
    }
  });

  it("具名 parseTime 按站点 +0800 换算，不随宿主时区漂移", async () => {
    const { default: NexusPHP } = await import("@ptd/site/schemas/NexusPHP.ts");
    const { siteMetadata } = await import("@ptd/site/definitions/hdcity.ts");
    const listFilters = (siteMetadata.search!.selectors!.time as any).filters as Array<any>;

    class Probe extends NexusPHP {
      run(query: any, fs: any) {
        return this.runQueryFilters(query, fs);
      }
    }
    // 运行期 index.ts 会给未声明 timezoneOffset 的 NexusPHP 站点补 +0800，这里显式补上
    const probe = new Probe({ ...siteMetadata, timezoneOffset: "+0800" } as any);
    expect(probe.run(listFilters[0]("发布时间 2024-01-02 03:04:05"), listFilters)).toBe(
      Date.parse("2024-01-02T03:04:05+08:00"),
    );
  });

  it("levelName 过滤器在 src 不匹配 /class/N.gif 时不再抛错", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/hdcity.ts");
    const stepSelectors = siteMetadata.userInfo!.process![0].selectors as any;
    const filter = stepSelectors.levelName.filters[0] as (query: string) => unknown;

    expect(() => filter("https://hdcity.city/pic/classic.png")).not.toThrow();
    expect(filter("https://hdcity.city/pic/classic.png")).toBe("https://hdcity.city/pic/classic.png");
    expect(filter("https://hdcity.city/pic/class/3.gif")).toBe("权天使");
  });
});

describe("hdclone 分类（DEFS2-6）", () => {
  it("分类表与 Jackett hdclone.yml 的 categorymappings 对齐（无 406/411）", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/hdclone.ts");
    const group = (siteMetadata.category as any[]).find((x) => x.key === "cat");

    expect(group.options).toEqual([
      { name: "Movies/电影", value: 401 },
      { name: "TV Series/电视剧", value: 402 },
      { name: "TV Shows/综艺", value: 403 },
      { name: "Documentaries/纪录片", value: 404 },
      { name: "Animations/动漫&动画", value: 405 },
      { name: "Others/其他（慎选）", value: 407 },
      { name: "Music/音乐", value: 408 },
      { name: "Playlet/短剧", value: 409 },
      { name: "MV/演唱会", value: 410 },
    ]);
  });
});
