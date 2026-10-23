/**
 * defs-e3 修复回归（E3 / E3b 站点定义第 3 批）。
 *
 * 断言对象是**真实站点定义 + 真实引擎实现**（不是「源码里存在某字符串」），不发网络请求：
 * - E3-2  hdarea：做种数 / 发布数解析失败时不再写成 0；
 * - E3-3  hdroute：行解析失败抛错（而不是返回空对象伪装成功）；
 * - E3-4  hhanclub：seedingBonusPerHour 不再落成 NaN / 字符串；
 * - E3-5  happyfappy：补齐 Scat(14) / AI(15) 分类，删除死配置 advanceKeywordParams.terms；
 * - E3-6  hdspace：sf.png（side freeleech）也算 Free；
 * - E3-7  hdspace：day 分支解析不出 Today/Yesterday 时退回 TTL 解析，而不是写成空值；
 * - E3-8  hdspace / hdtorrents：schema 不再写不存在的 XBTIT；
 * - E3-9  hdcity：seeders/leechers/completed/id/messageCount 的 match 判空；
 * - E3-10 hdupt：progress/status 补 text 默认值；
 * - E3-11 haidan：无 .group_content 祖先时不再抛 TypeError；
 * - E3-13 karagarga：补 User(0) 入口级，普通用户不再判成 -1；
 * - E3-14 jpopsuki：ja 文案补齐 downloaded/joinTime/ratio/bonus；
 * - E3-16 hdroute：下载链接保留完整 query（签名参数）；
 * - B1     hdcity：minfo 同时兼容 class / style 两种写法；
 * - B2     hdhome：时魔版式不匹配时不写总魔力值；
 * - B4     hdsky：新等级表分界按 +0800 本地零点；
 * - B5     hdupt：删掉失配的 seeding/seedingSize selector，交回引擎 ajax 兜底；
 * - B6     iptorrents：列表页 urlPattern 不再误命中 /top、/tv 等页面。
 */
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  logMessage: vi.fn(),
  store: vi.fn(async () => {}),
}));

// 站点定义会连带引入平台适配层（messages.ts 用到 __BROWSER__ 与 chrome API），
// 因此在 import 之前把全局桩与统一日志出口准备好。
vi.mock("@ptd/site/utils/adapter.ts", () => ({
  logMessage: mocks.logMessage,
  store: mocks.store,
  retrieve: vi.fn(async () => null),
  retrieveStore: vi.fn(async () => null),
  isCloudflareBlocked: vi.fn(() => false),
  sleep: vi.fn(async () => {}),
  cookie: vi.fn(async () => null),
  // fixLink 会用 axios.getUri(requestConfig) 还原请求地址；这里给出最小实现，避免测试打桩缺失。
  axios: { request: vi.fn(), getUri: () => "https://hdroute.org/browse.php" },
}));
(globalThis as any).__BROWSER__ ??= "chrome";

/**
 * 用 `document.implementation.createHTMLDocument` 而不是 `DOMParser`：
 * happy-dom 下 DOMParser 产物不是全局 Document / Element 的实例，引擎会走 JSON 分支
 * （见 definitionFixes.test.ts 的同类注释），这里需要真实的 Element 语义。
 */
const makeDoc = (html: string): Document => {
  const doc = document.implementation.createHTMLDocument("defs-fix-e3");
  doc.body.innerHTML = html;
  return doc;
};

const makeUserInfo = (extra: Record<string, unknown>) =>
  ({ site: "probe", status: 0, updateAt: Date.now(), ...extra }) as any;

const GiB = 1024 ** 3;
const DAY = 24 * 3600 * 1000;

describe("E3-11 haidan：找不到 .group_content 祖先时标题为空而不是抛错", () => {
  const makeProbe = async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/haidan.ts");
    const { default: BittorrentSite } = await import("@ptd/site/schemas/AbstractBittorrentSite.ts");
    class Probe extends BittorrentSite {
      field(row: Element, key: string) {
        return this.getFieldData(row, (siteMetadata.search!.selectors as any)[key]);
      }
    }
    return new Probe(siteMetadata as any);
  };

  it("没有 .group_content 时返回空串（旧实现会在 document.classList 上抛 TypeError）", async () => {
    const probe = await makeProbe();
    const doc = makeDoc(`<div class="torrent_wrap"><a href="download.php?id=1">x</a></div>`);
    const row = doc.querySelector(".torrent_wrap")!;
    expect(row).not.toBeNull();
    expect(() => probe.field(row, "title")).not.toThrow();
    expect(probe.field(row, "title")).toBe("");
  });

  it("有 .group_content 祖先时仍能取到 .video_name", async () => {
    const probe = await makeProbe();
    const doc = makeDoc(
      `<div class="group_content">
         <div class="torrent_wrap">
           <div class="name_col"><div class="name"><span class="video_name">Some.Show.S01</span></div></div>
         </div>
       </div>`,
    );
    expect(probe.field(doc.querySelector(".torrent_wrap")!, "title")).toBe("Some.Show.S01");
  });
});

describe("E3-2 hdarea：做种/发布数解析不到时不写成 0", () => {
  it("页面拿不到 data-count 时保留 undefined，拿到时正常解析", async () => {
    const { default: HDArea, siteMetadata } = await import("@ptd/site/definitions/hdarea.ts");
    const site: any = new HDArea(siteMetadata as any);

    site.requestUserSeedingPage = vi.fn().mockResolvedValue(null);
    const missingSeed = await site.parseUserInfoForSeedingStatus(makeUserInfo({ id: 42 }));
    expect(missingSeed.seeding).toBeUndefined();

    const missingUploads = await site.parseUserInfoForUploads(makeUserInfo({ id: 42 }));
    expect(missingUploads.uploads).toBeUndefined();

    site.requestUserSeedingPage = vi.fn().mockResolvedValue(`<div data-count="17"></div>`);
    const parsed = await site.parseUserInfoForSeedingStatus(makeUserInfo({ id: 42 }));
    expect(parsed.seeding).toBe(17);

    site.requestUserSeedingPage = vi.fn().mockResolvedValue(`<div data-count='3'></div>`);
    const parsedUploads = await site.parseUserInfoForUploads(makeUserInfo({ id: 42 }));
    expect(parsedUploads.uploads).toBe(3);
  });
});

describe("E3-3 / E3-16 hdroute：行解析失败抛错、下载链接保留完整 query", () => {
  it("缺 title 的行抛错（旧实现返回 {} 被基类无条件 push 成空白条目）", async () => {
    const { default: HDRoute, siteMetadata } = await import("@ptd/site/definitions/hdroute.ts");
    const site: any = new HDRoute(siteMetadata as any);
    const searchConfig = {
      searchEntry: { selectors: siteMetadata.search!.selectors },
      requestConfig: siteMetadata.search!.requestConfig,
    } as any;

    const doc = makeDoc(`<dl id="dl_torrent_999"><dd>nothing</dd></dl>`);
    await expect(site.parseWholeTorrentFromRow({}, doc.querySelector("dl")!, searchConfig)).rejects.toThrow(
      /title\/id missing/,
    );

    const okDoc = makeDoc(
      `<dl id="dl_torrent_321"><dd><a class="title_chs" href="/details.php?id=321">Some.Movie.2024.1080p</a></dd></dl>`,
    );
    const parsed = await site.parseWholeTorrentFromRow({}, okDoc.querySelector("dl")!, searchConfig);
    expect(parsed.id).toBe(321);
    expect(parsed.title).toBe("Some.Movie.2024.1080p");
  });

  it("link 过滤器保留 &sign= 等签名参数（旧正则只截到 download.php?id=", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/hdroute.ts");
    const filter = ((siteMetadata.search!.selectors as any).link.filters as any[])[0];

    expect(filter(`location.href='download.php?id=123&sign=abc&t=1'`)).toBe("download.php?id=123&sign=abc&t=1");
    expect(filter(`location.href='download.php?id=123'`)).toBe("download.php?id=123");
    expect(filter("")).toBe("");
  });
});

describe("E3-4 hhanclub：seedingBonusPerHour 不再落成 NaN / 字符串", () => {
  const makeSite = async () => {
    const { default: Hhanclub, siteMetadata } = await import("@ptd/site/definitions/hhanclub.ts");
    const site: any = new Hhanclub(siteMetadata as any);
    site.getRescueDocument = vi.fn().mockResolvedValue(
      makeDoc(
        `<table><tbody>
           <tr><td>1</td><td>2</td><td>3</td><td>4</td><td>5</td><td>240</td></tr>
         </tbody></table>`,
      ),
    );
    return site;
  };

  it("基础时魔 + 保种区结算/24 都是 number", async () => {
    mocks.logMessage.mockClear();
    const site = await makeSite();
    const baseDoc = makeDoc(`<div>你当前每小时能获取 1.5 憨豆</div>`);
    const out = await site.parseUserInfoForSeedingBonusPerHour(makeUserInfo({ id: 7 }), baseDoc);
    expect(out.seedingBonusPerHour).toBeCloseTo(1.5 + 240 / 24, 6);
    expect(typeof out.seedingBonusPerHour).toBe("number");
  });

  it("基础时魔零命中时不写字段，也不再请求保种区结算页", async () => {
    const site = await makeSite();
    const out = await site.parseUserInfoForSeedingBonusPerHour(
      makeUserInfo({ id: 7 }),
      makeDoc(`<div>页面改版了</div>`),
    );
    expect(out.seedingBonusPerHour).toBeUndefined();
    expect(site.getRescueDocument).not.toHaveBeenCalled();
  });

  it("结算日志请求失败只记 warn，不吞掉整次用户信息刷新", async () => {
    mocks.logMessage.mockClear();
    const site = await makeSite();
    site.getRescueDocument = vi.fn().mockRejectedValue(new Error("boom"));
    const out = await site.parseUserInfoForSeedingBonusPerHour(
      makeUserInfo({ id: 7 }),
      makeDoc(`<div>你当前每小时能获取 2 憨豆</div>`),
    );
    expect(out.seedingBonusPerHour).toBeUndefined();
    expect(mocks.logMessage).toHaveBeenCalled();
  });
});

describe("E3-5 happyfappy：分类与死配置", () => {
  it("补齐 Scat(14) / AI(15)，且不再保留永不触发的 terms 高级搜索", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/happyfappy.ts");
    const catGroup = (siteMetadata.category as any[]).find((group) => group.key === "filter_cat");
    expect(catGroup.options).toEqual(
      expect.arrayContaining([
        { name: "Scat", value: "14" },
        { name: "AI", value: "15" },
      ]),
    );
    expect((siteMetadata.search as any).advanceKeywordParams).toBeUndefined();
  });
});

describe("E3-6 / E3-7 / E3-8 hdspace：Free 标签、day 分支兜底、schema", () => {
  it("sf.png（side freeleech）与 gold.png 一样算 Free", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/hdspace.ts");
    const tags = (siteMetadata.search!.selectors as any).tags as Array<{ name: string; selector: string }>;
    const free = tags.find((tag) => tag.name === "Free")!;
    expect(free.selector).toContain("gold.png");
    expect(free.selector).toContain("sf.png");
  });

  it("day 分支不是 Today/Yesterday 时退回 TTL 解析（旧实现把时间写成空值）", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/hdspace.ts");
    const { default: NexusPHP } = await import("@ptd/site/schemas/NexusPHP.ts");
    class Probe extends NexusPHP {
      run(query: any, filters: any) {
        return this.runQueryFilters(query, filters);
      }
    }
    const probe = new Probe({ ...siteMetadata, timezoneOffset: "+0000" } as any);
    const chain = (siteMetadata.search!.selectors as any).time.switchFilters["td:nth-child(5):contains('day')"];

    const parsed = probe.run("3 days ago", chain);
    expect(typeof parsed).toBe("number");
    expect(Math.abs(Date.now() - (parsed as number) - 3 * DAY)).toBeLessThan(10_000);
  });

  it("hdspace / hdtorrents 的 schema 不再写不存在的 XBTIT", async () => {
    const { siteMetadata: hdspaceMetadata } = await import("@ptd/site/definitions/hdspace.ts");
    const { siteMetadata: hdtorrentsMetadata } = await import("@ptd/site/definitions/hdtorrents.ts");
    expect(hdspaceMetadata.schema).toBe("AbstractPrivateSite");
    expect(hdtorrentsMetadata.schema).toBe("AbstractPrivateSite");
  });
});

describe("E3-9 / B1 hdcity：match 判空与 minfo 标记兼容", () => {
  const makeProbe = async () => {
    const { default: NexusPHP } = await import("@ptd/site/schemas/NexusPHP.ts");
    const { siteMetadata } = await import("@ptd/site/definitions/hdcity.ts");
    class Probe extends NexusPHP {
      field(row: Element, key: string) {
        return this.getFieldData(row, (siteMetadata.search!.selectors as any)[key]);
      }
    }
    // 运行期 index.ts 会给未声明 timezoneOffset 的 NexusPHP 站点补 +0800，这里显式补上
    return new Probe({ ...siteMetadata, timezoneOffset: "+0800" } as any);
  };

  it("种子数/下载数/完成数的文本里没有数字时返回 0 而不是抛 TypeError", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/hdcity.ts");
    const selectors = siteMetadata.search!.selectors as any;
    for (const field of ["seeders", "leechers", "completed"]) {
      const filter = selectors[field].filters[0] as (query: string) => unknown;
      expect(() => filter("—")).not.toThrow();
      expect(filter("—")).toBe(0);
      expect(filter(`${field} 12`)).toBe(12);
    }
    const userSelectors = siteMetadata.userInfo!.process![0].selectors as any;
    expect(() => userSelectors.id.filters[0]("ID: —")).not.toThrow();
    expect(userSelectors.id.filters[0]("ID: 12345")).toBe("12345");
    expect(() => userSelectors.messageCount.filters[0]("消息中心")).not.toThrow();
    expect(userSelectors.messageCount.filters[0]("消息中心")).toBe(0);
  });

  it("列表行同时兼容 class=minfo 与 style=minfo 两种写法", async () => {
    const probe = await makeProbe();
    const filters = (await import("@ptd/site/utils/filter.ts")).definedFilters;

    const classDoc = makeDoc(
      `<div class="mitem">
         <div class="minfo">发布时间 2024-01-02 03:04:05 <span>alice</span></div>
       </div>`,
    );
    const classRow = classDoc.querySelector(".mitem")!;
    expect(probe.field(classRow, "time")).toBe(Date.parse("2024-01-02T03:04:05+08:00"));
    expect(probe.field(classRow, "author")).toBe("alice");

    const styleDoc = makeDoc(
      `<div class="mitem">
         <div style="minfo">发布时间 2024-01-02 03:04:05 <span>bob</span></div>
       </div>`,
    );
    const styleRow = styleDoc.querySelector(".mitem")!;
    expect(probe.field(styleRow, "time")).toBe(Date.parse("2024-01-02T03:04:05+08:00"));
    expect(probe.field(styleRow, "author")).toBe("bob");
    expect(typeof filters.parseTime).toBe("function");
  });
});

describe("E3-10 / B5 hdupt：进度状态默认值与做种 selector 交回引擎兜底", () => {
  it("没有进度单元格的行得到 unknown / 0，而不是空串", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/hdupt.ts");
    const { default: NexusPHP } = await import("@ptd/site/schemas/NexusPHP.ts");
    const { ETorrentStatus } = await import("@ptd/site/types.ts");
    class Probe extends NexusPHP {
      field(row: Element, key: string) {
        return this.getFieldData(row, (siteMetadata.search!.selectors as any)[key]);
      }
    }
    const probe = new Probe(siteMetadata as any);
    const doc = makeDoc(`<table><tbody><tr><td>1.2 GB</td></tr></tbody></table>`);
    const row = doc.querySelector("tr")!;

    expect(probe.field(row, "status")).toBe(ETorrentStatus.unknown);
    expect(probe.field(row, "progress")).toBe(0);
  });

  it("不再声明失配的 seeding / seedingSize selector（否则引擎的 ajax 兜底被整块跳过）", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/hdupt.ts");
    const selectors = siteMetadata.userInfo!.selectors as any;
    expect(selectors.seeding).toBeUndefined();
    expect(selectors.seedingSize).toBeUndefined();
    // 站点自定义的 bonus 仍然保留
    expect(selectors.bonus).toBeDefined();
  });
});

describe("E3-13 karagarga：User(0) 入口级", () => {
  it("普通用户（class=User）判成 0，而不是 -1 未知等级", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/karagarga.ts");
    const { guessUserLevelId } = await import("@ptd/site/utils/level.ts");
    const levels = siteMetadata.levelRequirements!;

    expect(levels[0]).toMatchObject({ id: 0, name: "User" });
    expect(guessUserLevelId(makeUserInfo({ levelName: "User", uploaded: 0, downloaded: 0, ratio: 0 }), levels)).toBe(0);
    expect(
      guessUserLevelId(
        makeUserInfo({
          levelName: "Power User",
          uploaded: 60 * GiB,
          downloaded: 1 * GiB,
          ratio: 1.2,
          joinTime: Date.now() - 200 * DAY,
        }),
        levels,
      ),
    ).toBe(1);
  });
});

describe("E3-14 jpopsuki：日文界面的字段文案", () => {
  it("downloaded / joinTime / ratio / bonus 的 ja 选择器不再回落英文", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/jpopsuki.ts");
    const selectors = siteMetadata.userInfo!.selectors as any;

    const jaLabelOf = (field: string) =>
      (selectors[field].selector as string[]).find((sel) => /[ぁ-んァ-ン一-龥]/.test(sel))!;

    expect(jaLabelOf("downloaded")).toContain("ダウンロード数");
    expect(jaLabelOf("joinTime")).toContain("登録日");
    expect(jaLabelOf("ratio")).toContain("比率");
    expect(jaLabelOf("bonus")).toContain("ボーナスポイント");

    // 英文界面不受影响：英文选择器仍然存在
    for (const field of ["downloaded", "joinTime", "ratio", "bonus"]) {
      expect((selectors[field].selector as string[]).some((sel) => !/[ぁ-んァ-ン一-龥]/.test(sel))).toBe(true);
    }
  });
});

describe("B2 hdhome：时魔版式不匹配时不再把总魔力值写成时魔", () => {
  const makeBonusDoc = (numbers: number[]) =>
    makeDoc(
      `<table><tbody><tr><td class="text"><h1>憨豆</h1><div align="center">${numbers.join(" ")}</div></td></tr></tbody></table>`,
    );

  it("10 个数字的已知版式取第 0/5/8 个相加", async () => {
    const { default: HDHome, siteMetadata } = await import("@ptd/site/definitions/hdhome.ts");
    const site: any = new HDHome(siteMetadata as any);

    const ten = [1000000, 0, 0, 0, 0, 1.5, 0, 0, 2.5, 0];
    const out = await site.parseUserInfoForBonusPerHour({}, makeBonusDoc(ten));
    expect(out.bonusPerHour).toBe(1000000 + 1.5 + 2.5);
  });

  it("数字个数不是 10 时不写字段（旧实现回落到 queryMatch[0] = 总魔力值）", async () => {
    const { default: HDHome, siteMetadata } = await import("@ptd/site/definitions/hdhome.ts");
    const site: any = new HDHome(siteMetadata as any);

    const out = await site.parseUserInfoForBonusPerHour({}, makeBonusDoc([1000000, 0, 0, 0, 0]));
    expect(out.bonusPerHour).toBeUndefined();
  });

  it("找不到时魔单元格时也不写字段", async () => {
    const { default: HDHome, siteMetadata } = await import("@ptd/site/definitions/hdhome.ts");
    const site: any = new HDHome(siteMetadata as any);

    const out = await site.parseUserInfoForBonusPerHour({}, makeDoc(`<div>没有该单元格</div>`));
    expect(out.bonusPerHour).toBeUndefined();
  });
});

describe("B4 hdsky：新等级表分界按 +0800 本地零点", () => {
  const makeSite = async () => {
    const { default: HDSky, siteMetadata } = await import("@ptd/site/definitions/hdsky.ts");
    return new HDSky(siteMetadata as any) as any;
  };

  // 2025-03-01T04:00:00+08:00 = 2025-02-28T20:00:00Z：站点本地已是 3 月 1 日（应走新表），
  // 但按旧分界 2025-03-01T00:00:00Z 会被判成「3 月 1 日之前」（旧表）。
  const LOCAL_MAR01_04AM = Date.parse("2025-03-01T04:00:00+08:00");

  it("落在 UTC 零点 ~ +0800 零点之间注册的用户按新表判级", async () => {
    const site = await makeSite();
    const userInfo = makeUserInfo({
      joinTime: LOCAL_MAR01_04AM,
      uploaded: 500 * GiB,
      downloaded: 200 * GiB,
      ratio: 2.0,
      bonus: 0,
    });
    // 新表 id2 要求 bonus 600000（本用户为 0）→ 只能判到 User(1)；
    // 旧表没有 bonus 门槛，会判到 Power User(2)。
    expect(site.guessUserLevelId(userInfo)).toBe(1);
  });

  it("2025-03-01 00:00 (+0800) 之前的用户仍用旧表（无 bonus 门槛）", async () => {
    const site = await makeSite();
    const userInfo = makeUserInfo({
      joinTime: Date.parse("2025-02-28T23:59:59+08:00"),
      uploaded: 500 * GiB,
      downloaded: 200 * GiB,
      ratio: 2.0,
      bonus: 0,
    });
    expect(site.guessUserLevelId(userInfo)).toBe(2);
  });
});

describe("B6 iptorrents：列表页 urlPattern 不再过宽", () => {
  it("只匹配 /t（可带 query/hash），不匹配 /top、/tv 等页面", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/iptorrents.ts");
    const pattern = (siteMetadata.list as any[])!
      .flatMap((entry) => ([] as string[]).concat(entry.urlPattern ?? []))
      .find((value: string) => value.includes("/t(?:$|[?#])"));
    expect(pattern).toBeDefined();

    const matches = (url: string) => new RegExp(pattern!, "i").test(url);
    expect(matches("https://iptorrents.com/t")).toBe(true);
    expect(matches("https://iptorrents.com/t?88;q=test")).toBe(true);
    expect(matches("https://iptorrents.com/t#top")).toBe(true);
    expect(matches("https://iptorrents.com/top-of-the-day")).toBe(false);
    expect(matches("https://iptorrents.com/top")).toBe(false);
    expect(matches("https://iptorrents.com/tv")).toBe(false);
    expect(matches("https://iptorrents.com/t/123/name")).toBe(false);
  });
});
