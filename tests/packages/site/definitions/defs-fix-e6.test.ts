/**
 * E6（definitions 6/6）审查修复的行为回归（不发网络请求）。
 *
 * 覆盖 `docs/review-2026-10-23/E6-definitions-6.md` 中已修复的条目：
 * - teamhd：assertion 的 `$id$` 占位符真的被替换、年份清洗不再因为「先替换空格」而成死代码；
 * - wihd：法语单位 Go→GB，上传/下载量不再静默归零；
 * - yzyy：`nth-child(9)/(11)` 真的命中对应列（不再用语义错误的 first/last-of-type）；
 * - starspace：发布数不再取分页器页码；
 * - sunnypt：joinTime 经 parseTime 变成毫秒时间戳、不再借用 NPHP 等级表、API Key 只发给本站 host；
 * - springsunday：断言允许 `</b>` 与「条记录」之间的空白，且回落分支不再重复请求同一 AJAX；
 * - torrentleech：重复的 DataTables POST 已删除、uploads 守卫不再恒真、可选步骤失败不整次作废、用户名编码；
 * - tccf / tjupt / sportscult / u2 / tokyotosho / totheglory / xtr / zhixing / yinguskg / torrentday / ubits；
 * - 分类显示名清理、死站点残留配置清理、幽灵 schema 名改回真实基类。
 *
 * 断言对象是真实定义对象 / 真实引擎，不是「源码里存在某字符串」。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ logMessage: vi.fn() }));

vi.mock("@ptd/site/utils/adapter.ts", () => ({
  axios: { request: vi.fn() },
  isCloudflareBlocked: vi.fn(() => false),
  retrieve: vi.fn(async () => null),
  retrieveStore: vi.fn(async () => null),
  cookie: vi.fn(async () => null),
  sleep: vi.fn(async () => {}),
  store: vi.fn(async () => {}),
  logMessage: mocks.logMessage,
}));

(globalThis as any).__BROWSER__ ??= "chrome";

import { siteMetadata as teamhd } from "@ptd/site/definitions/teamhd.ts";
import { siteMetadata as wihd } from "@ptd/site/definitions/wihd.ts";
import { siteMetadata as yzyy } from "@ptd/site/definitions/yzyy.ts";
import { siteMetadata as starspace } from "@ptd/site/definitions/starspace.ts";
import { siteMetadata as sunnypt, default as SunnyPT } from "@ptd/site/definitions/sunnypt.ts";
import { siteMetadata as springsunday, default as SpringSunday } from "@ptd/site/definitions/springsunday.ts";
import { siteMetadata as torrentleech, default as TorrentLeech } from "@ptd/site/definitions/torrentleech.ts";
import { siteMetadata as tccf } from "@ptd/site/definitions/tccf.ts";
import { siteMetadata as tjupt } from "@ptd/site/definitions/tjupt.ts";
import { siteMetadata as sportscult } from "@ptd/site/definitions/sportscult.ts";
import { siteMetadata as u2 } from "@ptd/site/definitions/u2.ts";
import { siteMetadata as tokyotosho } from "@ptd/site/definitions/tokyotosho.ts";
import { siteMetadata as totheglory } from "@ptd/site/definitions/totheglory.ts";
import { siteMetadata as xtr } from "@ptd/site/definitions/xtr.ts";
import { siteMetadata as zhixing, default as Zhixing } from "@ptd/site/definitions/zhixing.ts";
import { siteMetadata as yinguskg } from "@ptd/site/definitions/yinguskg.ts";
import { siteMetadata as torrentday } from "@ptd/site/definitions/torrentday.ts";
import { siteMetadata as ubits } from "@ptd/site/definitions/ubits.ts";
import { siteMetadata as thegeeks } from "@ptd/site/definitions/thegeeks.ts";
import { siteMetadata as wintersakura } from "@ptd/site/definitions/wintersakura.ts";
import * as yemaptDefinition from "@ptd/site/definitions/yemapt.ts";
import * as zhuqueDefinition from "@ptd/site/definitions/zhuque.ts";
import { EResultParseStatus } from "@ptd/site/types.ts";
import { definedFilters } from "@ptd/site/utils/filter.ts";
import PrivateSite from "@ptd/site/schemas/AbstractPrivateSite.ts";
import BittorrentSite from "@ptd/site/schemas/AbstractBittorrentSite.ts";
import NexusPHP from "@ptd/site/schemas/NexusPHP.ts";

const makeDoc = (html: string) => new DOMParser().parseFromString(`<html><body>${html}</body></html>`, "text/html");

/** 用真实引擎暴露 protected getFieldData（与站点实际解析路径一致） */
async function getField(metadata: any, doc: any, query: any): Promise<any> {
  class Probe extends PrivateSite {
    field(element: any, elementQuery: any) {
      return (this as any).getFieldData(element, elementQuery);
    }
  }
  return new Probe(metadata).field(doc, query);
}

/** 取 userInfo.process 中第一个带指定选择器的步骤 */
function processStepWith(metadata: any, key: string): any {
  return metadata.userInfo.process.find((step: any) => step.selectors?.[key]);
}

beforeEach(() => {
  mocks.logMessage.mockReset();
});

// ---------------------------------------------------------------------------
// teamhd（M-9 / M-10 / L-11）
// ---------------------------------------------------------------------------
describe("E6 teamhd：用户 id 占位符与年份清洗", () => {
  const transformer = (teamhd.search as any).requestConfigTransformer;

  it("M-10：先在原始串上剥掉结尾年份，再把空格替换成 %", () => {
    const run = (search: string) =>
      transformer({ requestConfig: { url: "/browse", params: { search } } }).params.search;

    expect(run("Inception 2010")).toBe("Inception");
    expect(run("The Matrix 1999")).toBe("The%Matrix");
    expect(run("Inception")).toBe("Inception");
    // 年份只剥结尾那一个：中间出现的 1999 保留
    expect(run("1999 The Matrix 2003")).toBe("1999%The%Matrix");
  });

  it("M-9：assertion {id:'url'} 真的把 $id$ 替换成用户 id", async () => {
    const step = processStepWith(teamhd, "joinTime");
    expect(step.assertion).toEqual({ id: "url" });
    expect(step.requestConfig.url).toBe("/user/$id$");

    const metadata = {
      id: "e6-probe-teamhd",
      name: "probe",
      type: "private",
      urls: ["https://example.invalid/"],
      userInfo: {
        pickLast: ["id"],
        // 只保留被验证的请求配置，避免依赖真实站点的选择器
        process: [{ ...step, selectors: { marker: { text: "x" } } }],
      },
    };
    const site: any = new PrivateSite(metadata as any);
    const requested: any[] = [];
    site.request = vi.fn(async (config: any) => {
      requested.push(config);
      return { data: {} };
    });

    await site.getUserInfoResult({ id: 12345 });
    expect(requested[0].url).toBe("/user/12345");
  });

  it("L-11：标签选择器不再依赖 style 属性全等匹配", () => {
    const [tag] = teamhd.search!.selectors!.tags as any[];
    expect(tag.selector).toContain("[style*='f2b101']");
    expect(tag.selector).not.toContain("[style='color:#f2b101']");
  });
});

// ---------------------------------------------------------------------------
// wihd（M-27）
// ---------------------------------------------------------------------------
describe("E6 wihd：法语单位归一化后不再静默归零", () => {
  const step = wihd.userInfo!.process!.find((item: any) => item.selectors?.uploaded)!;

  it("Upload/Download 标签里的 o 不再被误替换，Go 被换成 GB 且 parseSize 能解析", () => {
    const uploadedProcess = (step.selectors as any).uploaded.elementProcess;
    const downloadedProcess = (step.selectors as any).downloaded.elementProcess;

    const uploadText = uploadedProcess({ textContent: "Upload 1,5 Go" });
    expect(uploadText).toBe("Upload 1,5 GB");
    expect(definedFilters.parseSize(uploadText)).toBeCloseTo(1.5 * 1024 ** 3, 0);

    const downloadText = downloadedProcess({ textContent: "Download 3,25 Go" });
    expect(downloadText).toBe("Download 3,25 GB");
    expect(definedFilters.parseSize(downloadText)).toBeCloseTo(3.25 * 1024 ** 3, 0);

    // 旧实现（replace(/o/i, "B")）的产物："UplBad 1,5 Go" → parseSize 为 0
    expect(definedFilters.parseSize("UplBad 1,5 Go")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// yzyy（M-28）
// ---------------------------------------------------------------------------
describe("E6 yzyy：时魔按真实列号取第 9 / 11 个 td", () => {
  it("td.hl:nth-child(9)=基础积分，nth-child(11)=做种魔力", async () => {
    const step = processStepWith(yzyy, "bonusPerHour");
    const cells = Array.from({ length: 11 }, (_, i) => {
      const text = i === 8 ? "12" : i === 10 ? "34" : String(i + 1);
      const cls = i === 8 || i === 10 ? ' class="hl"' : "";
      return `<td${cls}>${text}</td>`;
    }).join("");
    const doc = makeDoc(`<table class="dz-mb-table"><tbody><tr class="my">${cells}</tr></tbody></table>`);

    const bonusPerHour = await getField(yzyy, doc, (step.selectors as any).bonusPerHour);
    const seedingBonusPerHour = await getField(yzyy, doc, (step.selectors as any).seedingBonusPerHour);
    expect(bonusPerHour).toBe(12);
    expect(seedingBonusPerHour).toBe(34);

    // 回归守卫：语义错误的伪类不得再出现
    const selectors = [
      ...(step.selectors as any).bonusPerHour.selector,
      ...(step.selectors as any).seedingBonusPerHour.selector,
    ].join(" ");
    expect(selectors).not.toContain("first-of-type");
    expect(selectors).not.toContain("last-of-type");
  });
});

// ---------------------------------------------------------------------------
// starspace（M-29 / L-30）
// ---------------------------------------------------------------------------
describe("E6 starspace：发布数不再等于当前页码", () => {
  const step = processStepWith(starspace, "uploads");
  const elementProcess = (step.selectors as any).uploads.elementProcess;

  it("优先解析分页器「共 N 条」总条数", () => {
    const doc = makeDoc(
      `<div id="table_pager">共 123 条</div><table id="table_tm"><tbody>
         <tr class="tm_tr_1"><td>a</td></tr><tr class="tm_tr_2"><td>b</td></tr>
       </tbody></table>`,
    );
    expect(elementProcess(doc)).toBe(123);
  });

  it("取不到总条数时统计列表行数，而不是取 pager_current 页码", () => {
    const doc = makeDoc(
      `<div id="table_pager"><span class="pager_current">2</span></div><table id="table_tm"><tbody>
         <tr class="tm_tr_1"><td>a</td></tr><tr class="tm_tr_2"><td>b</td></tr>
       </tbody></table>`,
    );
    expect(elementProcess(doc)).toBe(2);
    expect(
      (
        (starspace.userInfo!.process as any[]).find((item) => item.selectors?.uploads).selectors.uploads
          .selector as string[]
      ).join(" "),
    ).not.toContain("pager_current");
  });

  it("空列表返回 0", () => {
    expect(elementProcess(makeDoc(`<table id="table_tm"><tbody></tbody></table>`))).toBe(0);
  });

  it("L-30：时间字段改用 parseFuzzyTime（绝对时间与相对时间都能解析）", () => {
    const timeQuery = (starspace.search!.selectors as any).time;
    expect(timeQuery.filters).toEqual([{ name: "parseFuzzyTime" }]);
    expect(typeof definedFilters.parseFuzzyTime("2026-08-13 12:00", [])).toBe("number");
    expect(typeof definedFilters.parseFuzzyTime("3 days ago", [])).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// sunnypt（M-6 / L-7 / Info-46 / Info-45）
// ---------------------------------------------------------------------------
describe("E6 sunnypt：joinTime 类型、等级表与 API Key 作用域", () => {
  const profileStep = sunnypt.userInfo!.process![0];

  it("M-6：registered_at 经 parseTime 变成毫秒时间戳", async () => {
    const query = (profileStep.selectors as any).joinTime;
    expect(query.filters).toEqual([{ name: "parseTime" }]);
    const value = await getField(sunnypt, { data: { registered_at: "2021-05-01T12:00:00Z" } }, query);
    expect(value).toBe(Date.parse("2021-05-01T12:00:00Z"));
    // 旧实现会把 ISO 字符串原样写进 IUserInfo.joinTime
    expect(typeof value).toBe("number");
  });

  it("L-7 / Info-39：不再借用 NexusPHP 的通用等级表（改用上游 #1557 的站点专属等级表）", async () => {
    const { xiaomloveDefaultUserLevelRequirements } = await import("@ptd/site/schemas/NexusPHP.ts");
    const levels = sunnypt.levelRequirements!;
    expect(levels).not.toEqual(xiaomloveDefaultUserLevelRequirements);
    // 用户等级 id 与 data.class 原值一一对应（0 = Peasant 起），VIP/管理组按组别约定重新编号
    expect(levels.find((level) => level.id === 5)?.name).toContain("Insane User");
    expect(levels.find((level) => level.id === 100)?.groupType).toBe("vip");
    expect(levels.filter((level) => level.groupType === "manager").map((level) => level.id)).toEqual([
      200, 201, 202, 203, 204, 205,
    ]);
  });

  it("#1557：levelId 把 data.class 换算到等级表的 id（用户等级原样，VIP/管理组重新编号）", async () => {
    const query = (profileStep.selectors as any).levelId;
    expect(await getField(sunnypt, { data: { class: 5 } }, query)).toBe(5);
    expect(await getField(sunnypt, { data: { class: 10 } }, query)).toBe(100);
    expect(await getField(sunnypt, { data: { class: 16 } }, query)).toBe(205);
  });

  it("Info-46：schema 指向真实基类", () => {
    expect(sunnypt.schema).toBe("AbstractPrivateSite");
  });

  it("Info-45：X-API-Key 只附加到 SunnyPT 的 host", async () => {
    const requestSpy = vi.spyOn(BittorrentSite.prototype as any, "request").mockResolvedValue({ data: { code: 0 } });
    try {
      const site: any = new SunnyPT(sunnypt as any, { inputSetting: { apiKey: "secret-key" } } as any);
      await site.request({ url: "/torrents" });
      await site.request({ url: "https://api.sunnypt.top/api/v1/mp/torrents" });
      await site.request({ url: "https://cdn.example.invalid/foo.torrent" });

      expect((requestSpy.mock.calls[0][0] as any).headers["X-API-Key"]).toBe("secret-key");
      expect((requestSpy.mock.calls[1][0] as any).headers["X-API-Key"]).toBe("secret-key");
      expect((requestSpy.mock.calls[2][0] as any).headers?.["X-API-Key"]).toBeUndefined();
    } finally {
      requestSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// springsunday（L-1 / L-2）
// ---------------------------------------------------------------------------
describe("E6 springsunday：做种 AJAX 断言与重复请求", () => {
  it("L-2：`</b>` 与「条记录」之间有空格时仍能解析 b:eq(0)/b:eq(1)", async () => {
    const site: any = new SpringSunday(springsunday as any, {});
    site.requestUserSeedingPage = vi.fn(async () => "<b>12</b> 条记录 <b>1.5 GB</b>");
    const info = await site.parseUserInfoForSeedingStatus({ id: 9 });
    expect(info.seeding).toBe(12);
    expect(info.seedingSize).toBeCloseTo(1.5 * 1024 ** 3, 0);
  });

  it("L-1：断言不命中回落到 super 时，同一个 AJAX 只请求一次", async () => {
    const requestSpy = vi
      .spyOn(NexusPHP.prototype as any, "requestUserSeedingPage")
      .mockResolvedValue("<table><tr><td>Total</td></tr></table>");
    try {
      const site: any = new SpringSunday(springsunday as any, {});
      await site.parseUserInfoForSeedingStatus({ id: 9 });
      expect(requestSpy).toHaveBeenCalledTimes(1);
    } finally {
      requestSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// torrentleech（M-16 / M-17 / M-18 / L-19）
// ---------------------------------------------------------------------------
describe("E6 torrentleech：重复 POST、守卫与异常兜底", () => {
  it("M-16：重复的 uploadedtorrents DataTables POST 步骤已从 userInfo.process 删除", () => {
    const process = torrentleech.userInfo!.process as any[];
    expect(process.some((step) => step.requestConfig?.url === "/user/account/uploadedtorrents")).toBe(false);
    expect(process.some((step) => step.assertion?.id === "valid")).toBe(false);
    // 断言路径错误的 `userID: "$id$"` 也随步骤一起消失
    expect(JSON.stringify(process)).not.toContain("$id$");
  });

  it("M-17：uploads 已存在时不再重复 POST，未取到时只补一次", async () => {
    const baseSpy = vi
      .spyOn(PrivateSite.prototype as any, "getUserInfoResult")
      .mockResolvedValue({ status: EResultParseStatus.success, id: "7" });

    try {
      const site: any = new TorrentLeech(torrentleech as any, {});
      site.parseUserInfoForSeedingStatus = vi.fn(async (info: any) => ({ ...info, seeding: 1, seedingSize: 2 }));
      site.parseUserInfoForUploads = vi.fn(async (info: any) => ({ ...info, uploads: 3 }));

      const missing = await site.getUserInfoResult({});
      expect(missing.uploads).toBe(3);
      expect(site.parseUserInfoForUploads).toHaveBeenCalledTimes(1);

      site.parseUserInfoForUploads.mockClear();
      (site.parseUserInfoForSeedingStatus as any).mockClear();
      baseSpy.mockResolvedValue({
        status: EResultParseStatus.success,
        id: "7",
        uploads: 5,
        seeding: 1,
        seedingSize: 2,
      });
      const existing = await site.getUserInfoResult({});
      expect(existing.uploads).toBe(5);
      expect(site.parseUserInfoForUploads).not.toHaveBeenCalled();
    } finally {
      baseSpy.mockRestore();
    }
  });

  it("M-18：做种统计失败只 warn，不把整次用户信息刷新标成失败", async () => {
    const baseSpy = vi
      .spyOn(PrivateSite.prototype as any, "getUserInfoResult")
      .mockResolvedValue({ status: EResultParseStatus.success, id: "7" });

    try {
      const site: any = new TorrentLeech(torrentleech as any, {});
      site.parseUserInfoForSeedingStatus = vi.fn(async () => {
        throw new Error("seeding page 502");
      });
      site.parseUserInfoForUploads = vi.fn(async (info: any) => ({ ...info, uploads: 3 }));

      const info = await site.getUserInfoResult({});
      expect(info.status).toBe(EResultParseStatus.success);
      expect(info.uploads).toBe(3);
      expect(mocks.logMessage).toHaveBeenCalledTimes(1);
      const [message, data, level] = mocks.logMessage.mock.calls[0];
      expect(String(message)).toContain("parseUserInfoForSeedingStatus");
      expect(data.site).toBe("torrentleech");
      expect(data.error.message).toBe("seeding page 502");
      expect(level).toBe("warn");
    } finally {
      baseSpy.mockRestore();
    }
  });

  it("L-19：profile / seeding 请求的用户名经过 encodeURIComponent", async () => {
    const profileStep = processStepWith(torrentleech, "joinTime");
    expect(profileStep.requestConfigTransformer).toBeTypeOf("function");
    const transformed = profileStep.requestConfigTransformer(
      { url: "/profile/Some User#1" } as any,
      {} as any,
      {} as any,
    );
    expect(transformed.url).toBe("/profile/Some%20User%231");

    const site: any = new TorrentLeech(torrentleech as any, {});
    site.request = vi.fn(async () => ({ data: "" }));
    await site.parseUserInfoForSeedingStatus({ name: "Some User#1" });
    expect(site.request.mock.calls[0][0].url).toBe("/profile/Some%20User%231/seeding");
  });
});

// ---------------------------------------------------------------------------
// tccf（L-12）
// ---------------------------------------------------------------------------
describe("E6 tccf：progress 只在带 % 的进度单元格上取值", () => {
  const progress = (tccf.search!.selectors as any).progress;

  it("非进度文本不再被 parseFloat 成日期/分辨率", () => {
    expect(progress.filters[0]("76.5%")).toBe(76.5);
    expect(progress.filters[0]("2024-01-01")).toBe(0);
    expect(progress.filters[0]("1080p")).toBe(0);
  });

  it("选择器收窄到 status 已确认的三种颜色", () => {
    expect(progress.selector).toEqual(["td[bgcolor='#bce672']", "td[bgcolor='#44cef6']", "td[bgcolor='#d0d0d0']"]);
  });
});

// ---------------------------------------------------------------------------
// tjupt（L-14）
// ---------------------------------------------------------------------------
describe("E6 tjupt：bonus.php 步骤重新声明 seedingBonusPerHour", () => {
  it("fields 与 NexusPHP 默认步骤一致", () => {
    const step = (tjupt.userInfo!.process as any[]).find((item) => item.requestConfig?.url === "/bonus.php");
    expect(step.fields).toEqual(["bonusPerHour", "seedingBonusPerHour"]);
  });
});

// ---------------------------------------------------------------------------
// sportscult（L-3 / L-4 / L-5 / Info-46）
// ---------------------------------------------------------------------------
describe("E6 sportscult：统计过滤、分类拼写与 schema", () => {
  const statsFilter = (sportscult.search!.selectors as any).completed.filters[0];

  it("L-5：`-` / `N/A` / 空白返回 0 而不是 NaN", () => {
    expect(statsFilter("-")).toBe(0);
    expect(statsFilter("N/A")).toBe(0);
    expect(statsFilter("--")).toBe(0);
    expect(Number.isNaN(statsFilter("N/A"))).toBe(false);
    expect(statsFilter("1234")).toBe(1234);
  });

  it("L-4：分类名拼写已修正", () => {
    const category = sportscult.category!.find((item) => item.key === "category") as any;
    expect(category.options.find((option: any) => Number(option.value) === 102).name).toBe("Ultimate Disk");
  });

  it("L-3 / Info-46：schema 指向真实基类", () => {
    expect(sportscult.schema).toBe("AbstractPrivateSite");
  });
});

// ---------------------------------------------------------------------------
// u2（L-31）
// ---------------------------------------------------------------------------
describe("E6 u2：做种记录正则允许空白", () => {
  const seedingFilter = (u2.userInfo!.selectors as any).seeding.filters[0];

  it.each([
    ["<b>12</b> 条记录", "12"],
    ["<b>12</b>条记录", "12"],
    ["<b>7</b> records", "7"],
  ])("%s → %s", (input, expected) => {
    expect(seedingFilter(input)).toBe(expected);
  });

  it("做种量允许数字与单位之间有/无空格", () => {
    const sizeFilter = (u2.userInfo!.selectors as any).seedingSize.filters[0];
    expect(definedFilters.parseSize(sizeFilter("大小 1.50 GB"))).toBeCloseTo(1.5 * 1024 ** 3, 0);
    expect(definedFilters.parseSize(sizeFilter("大小 1.50GB"))).toBeCloseTo(1.5 * 1024 ** 3, 0);
  });
});

// ---------------------------------------------------------------------------
// tokyotosho（L-25）
// ---------------------------------------------------------------------------
describe("E6 tokyotosho：列表页 urlPattern 不再匹配所有目录页", () => {
  const patterns = (tokyotosho.list![0].urlPattern as any[]).map((pattern) =>
    typeof pattern === "string" ? new RegExp(pattern, "i") : pattern,
  );
  const matches = (url: string) => patterns.some((pattern) => (pattern as RegExp).test(url));

  it("仍识别首页与搜索结果页", () => {
    expect(matches("https://www.tokyotosho.info/")).toBe(true);
    expect(matches("https://www.tokyotosho.info/?cat=1")).toBe(true);
    expect(matches("https://www.tokyotosho.info/index.php")).toBe(true);
    expect(matches("https://www.tokyotosho.info/search.php?terms=naruto")).toBe(true);
  });

  it("规则/帮助等目录页不再被误判为列表页（详情页由 detail.urlPattern 处理）", () => {
    expect(matches("https://www.tokyotosho.info/rules/")).toBe(false);
    expect(matches("https://www.tokyotosho.info/faq/")).toBe(false);
    expect(matches("https://www.tokyotosho.info/details.php?id=1")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// totheglory（L-26）
// ---------------------------------------------------------------------------
describe("E6 totheglory：标题剥离标签、副标题切分不再依赖小写 <br>", () => {
  const selectors = totheglory.search!.selectors as any;

  it("title 走 extractContent，subTitle 兼容 <br/> 与 <BR>", () => {
    const element = document.createElement("b");
    element.innerHTML = "<font color='red'>The Matrix</font><BR/>1999 1080p";
    expect(selectors.title.elementProcess(element)).toBe("The Matrix");
    expect(selectors.subTitle.elementProcess(element)).toBe("1999 1080p");
  });

  it("没有副标题时返回空串", () => {
    const element = document.createElement("b");
    element.innerHTML = "<font>Only Title</font>";
    expect(selectors.title.elementProcess(element)).toBe("Only Title");
    expect(selectors.subTitle.elementProcess(element)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// xtr（L-36 / L-37 / Info-40）
// ---------------------------------------------------------------------------
describe("E6 xtr：日期正则转义、排序语义说明与 VIP 组", () => {
  const dateFilter = (xtr.search!.selectors as any).time.filters[0];

  it("L-37：点号按字面量匹配，畸形串不再被改写成合法日期", () => {
    expect(dateFilter("13.08.2026 12:00:00")).toBe("2026-08-13 12:00:00");
    expect(dateFilter("2026x08x13 12:00:00")).toBe("2026x08x13 12:00:00");
  });

  it("L-36：排序分组带 notes 说明", () => {
    const groups = xtr.category as any[];
    expect(groups.find((group) => group.key === "sort").notes).toBeTruthy();
    expect(groups.find((group) => group.key === "order").notes).toBeTruthy();
  });

  it("Info-40：VIP 从 100 起并标 groupType", () => {
    const vip = xtr.levelRequirements!.find((level) => level.name === "VIP")!;
    expect(vip.id).toBe(100);
    expect(vip.groupType).toBe("vip");
  });
});

// ---------------------------------------------------------------------------
// zhixing（L-33 / L-34 / L-35 / Info-46）
// ---------------------------------------------------------------------------
describe("E6 zhixing：URL、分页上限/去重与失败语义", () => {
  const category = (zhixing.category as any[]).find((item) => item.key === "category");

  it("L-33：选「全部」（空值）生成 /search/ 而不是 /search//", () => {
    expect(category.generateRequestConfig("").requestConfig.url).toBe("/search/");
    expect(category.generateRequestConfig("movie").requestConfig.url).toBe("/search/movie/");
  });

  it("L-34：越界页回落最后一页时不会重复计数，正常分页有 50 页上限且逐页限速", async () => {
    const site: any = new Zhixing(zhixing as any, {});
    const sleepSpy = vi.spyOn(site, "sleepAction");
    const tenTorrents = Array.from({ length: 10 }, (_, index) => ({ id: index + 1, size: 10 }));
    site.transformSearchPage = vi.fn(async () => tenTorrents);

    // 站点对越界页码始终返回同一页：首行签名相同 → 只统计一次
    const samePage = `<table class="torrenttable"><tbody>
        <tr><th>head</th></tr><tr id="row-1"><td><a name="title" href="/torrents/1">x</a></td></tr>
      </tbody></table>`;
    site.request = vi.fn(async () => ({ data: samePage }));
    const deduped = await site.parseUserInfoForUserTorrent("seeding", "1");
    // 需要多请求一页才能发现「越界页回落最后一页」；计数只发生一次
    expect(site.request).toHaveBeenCalledTimes(2);
    expect(deduped.count).toBe(10);

    // 每页首行都不同 → 由 MAX_PAGES 截断，避免无限请求
    site.request = vi.fn(async (config: any) => {
      const page = String(config.url).split("p").pop();
      return {
        data: `<table class="torrenttable"><tbody>
            <tr><th>head</th></tr><tr id="row-${page}"><td><a name="title" href="/torrents/${page}">x</a></td></tr>
          </tbody></table>`,
      };
    });
    site.transformSearchPage = vi.fn(async () => tenTorrents);
    const capped = await site.parseUserInfoForUserTorrent("seeding", "1");
    expect(site.request).toHaveBeenCalledTimes(50);
    expect(capped.count).toBe(500);
    // 每次请求前都走 sleepAction（requestDelay 未配置时为 0ms，不会真的等待）；本用例共请求 2+50 次
    expect(sleepSpy).toHaveBeenCalledTimes(52);
  });

  it("L-35：补充列表抓取失败只 warn，不覆盖主数据的 success 状态", async () => {
    const baseSpy = vi
      .spyOn(PrivateSite.prototype as any, "getUserInfoResult")
      .mockResolvedValue({ status: EResultParseStatus.success, id: "1", uploaded: 1024 });

    try {
      const site: any = new Zhixing(zhixing as any, {});
      site.parseUserInfoForUserTorrent = vi.fn(async () => {
        throw new Error("page 500");
      });
      const info = await site.getUserInfoResult({});
      expect(info.status).toBe(EResultParseStatus.success);
      expect(info.uploaded).toBe(1024);
      expect(mocks.logMessage).toHaveBeenCalledTimes(1);
      const [message, data, level] = mocks.logMessage.mock.calls[0];
      expect(String(message)).toContain("parseUserInfoForUserTorrent");
      expect(data.site).toBe("zhixing");
      expect(level).toBe("warn");
    } finally {
      baseSpy.mockRestore();
    }
  });

  it("Info-46：schema 指向真实基类", () => {
    expect(zhixing.schema).toBe("AbstractPrivateSite");
  });
});

// ---------------------------------------------------------------------------
// yinguskg（L-38）
// ---------------------------------------------------------------------------
describe("E6 yinguskg：已标记为死站", () => {
  it("上游 2d8f1fab 标记 isDead 并注释掉其余配置后，不再依赖已死亡的 kunlun.ts", () => {
    // 原 L-38 用例验证内联的 invites 配置；站点死亡后 userInfo 整体注释掉，改为断言死站状态
    expect(yinguskg.isDead).toBe(true);
    expect(yinguskg.userInfo).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// torrentday（L-20 / L-21）
// ---------------------------------------------------------------------------
describe("E6 torrentday：站点名与 VIP 组", () => {
  it("name 与 id/aka 一致", () => {
    expect(torrentday.name).toBe("TorrentDay");
  });

  it("VIP 从 100 起并标 groupType=vip", () => {
    const vip = torrentday.levelRequirements!.find((level) => level.name === "VIP")!;
    expect(vip.id).toBe(100);
    expect(vip.groupType).toBe("vip");
  });
});

// ---------------------------------------------------------------------------
// ubits（Info-40）
// ---------------------------------------------------------------------------
describe("E6 ubits：VIP / Retiree 使用非 user 组 id 段", () => {
  it("VIP=100(vip)、Retiree=200(manager)", () => {
    const vip = ubits.levelRequirements!.find((level) => level.name.includes("VIP"))!;
    const retiree = ubits.levelRequirements!.find((level) => level.name.includes("Retiree"))!;
    expect(vip.id).toBe(100);
    expect(vip.groupType).toBe("vip");
    expect(retiree.id).toBe(200);
    expect(retiree.groupType).toBe("manager");
  });
});

// ---------------------------------------------------------------------------
// 分类显示名（L-41）
// ---------------------------------------------------------------------------
describe("E6 分类显示名清理", () => {
  it("thegeeks：修正 Psych/Sociolgy、Business :Misc 与尾随空格", () => {
    const options = (thegeeks.category![0] as any).options as any[];
    const byValue = (value: number) => options.find((option) => Number(option.value) === value);

    expect(byValue(14).name).toBe("Science: Psych/Sociology");
    expect(byValue(28).name).toBe("Business: Misc");
    expect(byValue(3).name).toBe("Comp: Graphics");
    expect(byValue(10).name).toBe("Science: Medicine/Health");
    expect(options.every((option) => option.name === option.name.trim())).toBe(true);
  });

  it("wintersakura：423 名称不再带尾随制表符", () => {
    const category = wintersakura.category!.find((item) => item.key === "cat") as any;
    const option = category.options.find((item: any) => Number(item.value) === 423);
    expect(option.name).toBe("Animation series/动漫剧集(合集)");
    expect(option.name).not.toContain("\t");
  });
});

// ---------------------------------------------------------------------------
// 幽灵 schema 名（L-3 / Info-46）
// ---------------------------------------------------------------------------
describe("E6 幽灵 schema 名改为真实基类", () => {
  it.each([
    ["sportscult", sportscult],
    ["sunnypt", sunnypt],
    ["yemapt", yemaptDefinition.siteMetadata],
    ["zhixing", zhixing],
    ["zhuque", zhuqueDefinition.siteMetadata],
  ])("%s 的 schema 为 AbstractPrivateSite 且仍导出 default class", (name, metadata) => {
    expect(metadata.schema).toBe("AbstractPrivateSite");
    const definition = {
      sportscult: undefined,
      sunnypt: SunnyPT,
      yemapt: yemaptDefinition.default,
      zhixing: Zhixing,
      zhuque: zhuqueDefinition.default,
    } as Record<string, unknown>;
    if (name === "sportscult") return; // sportscult 的 class 在下方单独断言
    expect(definition[name]).toBeTypeOf("function");
  });

  it("sportscult 仍导出 default class", async () => {
    const definition = await import("@ptd/site/definitions/sportscult.ts");
    expect(definition.default).toBeTypeOf("function");
  });
});

// ---------------------------------------------------------------------------
// 死站点残留配置（L-43）
// ---------------------------------------------------------------------------
describe("E6 死站点不再保留等级/分类配置", () => {
  it.each([
    ["torrenthub", () => import("@ptd/site/definitions/torrenthub.ts")],
    ["tosky", () => import("@ptd/site/definitions/tosky.ts")],
    ["wukongwendao", () => import("@ptd/site/definitions/wukongwendao.ts")],
    ["tmpt", () => import("@ptd/site/definitions/tmpt.ts")],
    ["xauat6", () => import("@ptd/site/definitions/xauat6.ts")],
    ["sugoimusic", () => import("@ptd/site/definitions/sugoimusic.ts")],
    ["uhdbits", () => import("@ptd/site/definitions/uhdbits.ts")],
  ])("%s 是 isDead 且没有 levelRequirements / category", async (name, load) => {
    const { siteMetadata } = await load();
    expect(siteMetadata.id).toBe(name);
    expect(siteMetadata.isDead).toBe(true);
    expect(siteMetadata.levelRequirements).toBeUndefined();
    expect(siteMetadata.category).toBeUndefined();
  });
});
