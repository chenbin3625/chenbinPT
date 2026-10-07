/**
 * timezone-sweep（第二波 + 第四波）回归：把绕过站点时区的调用点全部收口。
 *
 * - SITECORE-1 站点侧：能用具名 `parseTime` 的选择器改为具名 filter（由
 *   `AbstractBittorrentSite.runQueryFilters` 按 `metadata.timezoneOffset` 走
 *   `parseValidTimeStringInZone`）；类方法里没有 `this` 的场合才退回
 *   `parseValidTimeStringInZone(..., this.metadata.timezoneOffset)`。
 * - 相对时间（`parseTTL`）已经是绝对毫秒戳，任何形状的时区叠加（含宿主
 *   `getTimezoneOffset()`）都必须删掉，而不是换算（DEFS2-3）。
 * - DEFS3-3 孪生面：`explicitTimeZonePattern` 允许时间与数值偏移之间的空白，
 *   使 `2024-03-10 10:41 +0800` 这类串按「自带偏移的绝对时间」处理，不再被二次换算。
 * - 第四波补齐第二波漏掉的四个站点：anthelion / brokenstones（匿名 filter 里叠宿主偏移）、
 *   hdspace（宿主日历构造 Today/Yesterday）、pussytorrents（`new Date(...)` 直接解析）。
 *
 * 断言取的都是「与宿主时区无关的绝对时间戳」（用 `Date.parse` 带显式偏移计算期望值），
 * 因此在本机 +0800 与 CI 的其它时区下结果一致；站点声明的偏移（+1200 / -0500 / +0000）
 * 与宿主不同，旧实现按宿主解析会得到另一个值，所以这些用例在改动被还原时会变红。
 * 注意：站点声明 +0000 时，旧实现在 `TZ=UTC` 下会「碰巧」得到正确值，区分力来自
 * `TZ=Asia/Shanghai` / `TZ=America/New_York` 两次运行；覆盖 `timezoneOffset` 的用例
 * （-0500）在三种时区下都有区分力。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

// 站点定义会连带引入 @ptd/site 的运行时依赖（messages.ts 用到 __BROWSER__ 与 chrome API），
// 这里给出最小桩（与 defs-2a.review-fixes.test.ts 一致），避免为纯配置断言去跑整个扩展环境。
vi.mock("@ptd/site/utils/adapter.ts", () => ({ logMessage: vi.fn() }));
(globalThis as any).__BROWSER__ ??= "chrome";

// 相对时间 / Today 断言依赖「当前时刻」，用完必须还原，避免影响其它用例
afterEach(() => {
  vi.useRealTimers();
});

// 固定参考时刻：取 UTC 正午，使 TZ=UTC / Asia/Shanghai / America/New_York 三种宿主时区
// 以及站点 +0000 / -0500 的日历日都落在同一天（2024-01-02），排除跨日边界噪声。
const FIXED_NOW = new Date("2024-01-02T12:00:00Z");

/**
 * 只借用 `AbstractBittorrentSite.runQueryFilters` / `getFieldData` / `parseWholeTorrentFromRow`
 * 这几条真实管线，元数据仍来自被改的站点定义；`timezoneOffset` 可显式覆盖，用于证明结果只跟元数据时区走。
 */
async function makeProbe(metadata: any, timezoneOffset?: string) {
  const { default: BittorrentSite } = await import("@ptd/site/schemas/AbstractBittorrentSite.ts");
  class Probe extends BittorrentSite {
    run(query: any, filters: any) {
      return this.runQueryFilters(query, filters);
    }
    parseRow(row: Element | object, selectors: any) {
      return this.parseWholeTorrentFromRow({}, row, {
        searchEntry: { selectors },
        requestConfig: { url: "https://example.invalid/torrents.php" },
      } as any);
    }
  }
  return new Probe({ ...metadata, ...(timezoneOffset ? { timezoneOffset } : {}) });
}

describe("DEFS3-3 带空白的显式时区偏移", () => {
  it("parseTimeWithZone 把 `HH:mm +0800` 当绝对时间，不再叠加偏移", async () => {
    const { parseTimeWithZone } = await import("@ptd/site/utils/datetime.ts");
    const absolute = Date.parse("2024-03-10T10:41:00+08:00");

    expect(parseTimeWithZone("2024-03-10 10:41 +0800", "+0000")).toBe(absolute);
    // 宿主时区二次换算会得到绝对时间 +8h 的另一个值（修复前走的就是这条路径）
    expect(parseTimeWithZone("2024-03-10 10:41 +0800", "+0000")).not.toBe(Date.parse("2024-03-10T10:41:00Z"));
  });

  it("parseValidTimeStringInZone：字符串自带偏移时，站点 timezoneOffset 不再影响结果（跨时区断言）", async () => {
    const { parseValidTimeStringInZone } = await import("@ptd/site/utils/datetime.ts");
    const absolute = Date.parse("2024-03-10T10:41:00+08:00");

    for (const offset of ["+0800", "-0500", "+1400"] as const) {
      expect(parseValidTimeStringInZone("2024-03-10 10:41 +0800", [], offset)).toBe(absolute);
    }
  });
});

describe("retrotoon 列表时间（站点 +1200）", () => {
  it("elementProcess 只归一化文本，具名 parseTime 按站点时区换算", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/retrotoon.ts");
    const timeQuery = (siteMetadata.search!.selectors as any).time;

    const cell = document.createElement("td");
    cell.textContent = " 2024-01-02  03:04:05 ";

    expect(timeQuery.elementProcess(cell)).toBe("2024-01-0203:04:05");
    expect(timeQuery.filters).toEqual([{ name: "parseTime", args: ["yyyy-MM-ddHH:mm:ss"] }]);

    const probe = await makeProbe(siteMetadata);
    // 旧实现按宿主时区（本机 +0800）解析，比 +1200 早 4 小时
    expect(probe.run(timeQuery.elementProcess(cell), timeQuery.filters)).toBe(Date.parse("2024-01-02T03:04:05+12:00"));
  });
});

describe("retroflix 列表时间（站点 +0000）", () => {
  it("elementProcess 原样返回 title，具名 parseTime 按站点时区换算", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/retroflix.ts");
    const timeQuery = (siteMetadata.search!.selectors as any).time;

    const cell = document.createElement("div");
    cell.setAttribute("title", "2024-01-02 03:04:05");

    expect(timeQuery.elementProcess(cell)).toBe("2024-01-02 03:04:05");
    expect(timeQuery.filters).toEqual([{ name: "parseTime" }]);

    const probe = await makeProbe(siteMetadata);
    // 旧实现按宿主 +0800 解析，比站点 +0000 早 8 小时
    expect(probe.run("2024-01-02 03:04:05", timeQuery.filters)).toBe(Date.parse("2024-01-02T03:04:05Z"));
  });
});

describe("karagarga 列表时间（站点 +0000）", () => {
  it("`d MMM yy` 先归一化，再交给具名 parseTime", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/karagarga.ts");
    const timeQuery = (siteMetadata.search!.selectors as any).time;

    expect(timeQuery.filters[0]("Jan 02 '24")).toBe("02 Jan 24");
    expect(timeQuery.filters[1]).toEqual({ name: "parseTime", args: ["d MMM yy"] });

    const probe = await makeProbe(siteMetadata);
    expect(probe.run("Jan 02 '24", timeQuery.filters)).toBe(Date.parse("2024-01-02T00:00:00Z"));
  });
});

describe("filelist 列表时间（站点 +0000）", () => {
  it("`HH:mm:ss DD/MM/YYYY` 归一化后由具名 parseTime 换算", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/filelist.ts");
    const filters = (siteMetadata.search!.selectors as any).time.filters as any[];

    expect(filters[0]("03:04:05\n02/01/2024")).toBe("2024-01-02 03:04:05");
    expect(filters[1]).toEqual({ name: "parseTime" });

    const probe = await makeProbe(siteMetadata);
    // 整条管线：归一化函数 → 具名 parseTime
    expect(probe.run("03:04:05\n02/01/2024", filters)).toBe(Date.parse("2024-01-02T03:04:05Z"));
  });
});

describe("yuscene 用户时间（Unit3D，站点 +0000）", () => {
  it("elementProcess 原样返回，具名 parseTime 按站点时区换算", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/yuscene.ts");
    const joinTime = (siteMetadata.userInfo!.selectors as any).joinTime;

    const timeEl = document.createElement("time");
    timeEl.setAttribute("datetime", "2024-01-02 03:04:05");

    expect(joinTime.elementProcess(timeEl)).toBe("2024-01-02 03:04:05");
    expect(joinTime.filters).toEqual([{ name: "parseTime" }]);

    const probe = await makeProbe(siteMetadata);
    // 旧实现按宿主 +0800 解析，比站点 +0000 早 8 小时
    expect(probe.run(joinTime.elementProcess(timeEl), joinTime.filters)).toBe(Date.parse("2024-01-02T03:04:05Z"));
  });
});

describe("btetree 列表时间（类方法，站点 -0500）", () => {
  it("parseTorrentRowForTime 用站点时区解析 MM/dd HH:mm（年份由 id 查表补全）", async () => {
    const { default: BtEtree, siteMetadata } = await import("@ptd/site/definitions/btetree.ts");

    class Probe extends BtEtree {
      rowTime(torrent: any, row: Element, searchConfig: any) {
        return this.parseTorrentRowForTime(torrent, row, searchConfig);
      }
    }
    const probe = new Probe(siteMetadata as any);

    const row = document.createElement("tr");
    row.innerHTML = "<td>1</td><td>2</td><td>3</td><td>4</td><td>01/02 03:04</td>";
    const searchConfig = { searchEntry: { selectors: { time: siteMetadata.search!.selectors!.time } } } as any;

    // torrentId 621061 落在 torrentYearMap 的 2024 年区间
    const result = probe.rowTime({ id: 621061 }, row, searchConfig);
    // 旧实现按宿主 +0800 解析，与站点 -0500 相差 13 小时
    expect(result.time).toBe(Date.parse("2024-01-02T03:04:00-05:00"));
  });
});

describe("exttorrents 列表时间（站点 +0800）", () => {
  it("相对时间仍走 parseTimeToLiveToDate，且后续具名 parseTime 不破坏数值", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/exttorrents.ts");
    const timeQuery = (siteMetadata.search!.selectors as any).time;

    const cell = document.createElement("span");
    cell.textContent = "5 minutes ago";
    const relative = timeQuery.elementProcess(cell);
    expect(typeof relative).toBe("number");
    expect(Math.abs(Date.now() - 5 * 60 * 1000 - relative)).toBeLessThan(60 * 1000);

    const probe = await makeProbe(siteMetadata);
    expect(probe.run(relative, timeQuery.filters)).toBe(relative);
  });

  it("绝对时间分支只返回 title 原文，解析交给具名 parseTime（args 传站点格式）", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/exttorrents.ts");
    const timeQuery = (siteMetadata.search!.selectors as any).time;

    const cell = document.createElement("span");
    cell.textContent = "some age";
    cell.setAttribute("title", "02 January 2024");

    expect(timeQuery.elementProcess(cell)).toBe("02 January 2024");
    expect(timeQuery.filters).toEqual([{ name: "parseTime", args: ["dd MMMM yyyy"] }]);

    const probe = await makeProbe(siteMetadata);
    expect(probe.run("02 January 2024", timeQuery.filters)).toBe(Date.parse("2024-01-02T00:00:00+08:00"));
  });
});

describe("audiences 用户时间（NexusPHP，站点 +0800）", () => {
  it("joinTime / lastAccessAt 归一化后由具名 parseTime 按站点时区换算", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/audiences.ts");
    const selectors = siteMetadata.userInfo!.selectors as any;

    const samples: Record<string, string> = {
      joinTime: "加入日期：2024-01-02 03:04:05 (最近动向)",
      lastAccessAt: "最近动向：2024-01-02 03:04:05",
    };
    for (const key of ["joinTime", "lastAccessAt"]) {
      expect(selectors[key].filters[0](samples[key])).toBe("2024-01-02 03:04:05");
      expect(selectors[key].filters[1]).toEqual({ name: "parseTime" });
    }

    // 正则不命中时的 split 兜底路径：多余空白必须被归一化掉，
    // 否则具名 parseTime 的 wallTimePattern 失配、回落到原生 Date 分支又会按宿主时区解析
    expect(selectors.joinTime.filters[0]("2024-01-02 03:04:05  (x)")).toBe("2024-01-02 03:04:05");
    expect(selectors.lastAccessAt.filters[0]("2024-01-02 03:04:05  (x)")).toBe("2024-01-02 03:04:05");

    // 站点声明 +0800；这里覆盖成 -0500，证明结果只跟 metadata.timezoneOffset 走（旧实现跟宿主 +0800 走）
    const probe = await makeProbe(siteMetadata, "-0500");
    expect(probe.run("2024-01-02 03:04:05", selectors.joinTime.filters)).toBe(Date.parse("2024-01-02T03:04:05-05:00"));
  });
});

describe("hhanclub 用户时间（NexusPHP，站点 +0800）", () => {
  it("joinTime / lastAccessAt 归一化后由具名 parseTime 按站点时区换算", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/hhanclub.ts");
    const selectors = siteMetadata.userInfo!.selectors as any;

    for (const key of ["joinTime", "lastAccessAt"]) {
      expect(selectors[key].filters[0]("2024-01-02 03:04:05 (2 days ago)")).toBe("2024-01-02 03:04:05");
      // 多余空白同样要归一化，避免 parseTime 落到原生 Date 分支
      expect(selectors[key].filters[0]("2024-01-02 03:04:05  (2 days ago)")).toBe("2024-01-02 03:04:05");
      expect(selectors[key].filters[1]).toEqual({ name: "parseTime" });
    }

    const probe = await makeProbe(siteMetadata, "+0000");
    expect(probe.run("2024-01-02 03:04:05", selectors.joinTime.filters)).toBe(Date.parse("2024-01-02T03:04:05Z"));
  });
});

describe("passthepopcorn 用户时间（Gazelle，站点 +0000）", () => {
  it("joinTime 的 elementProcess 原样返回，具名 parseTime 按站点时区换算", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/passthepopcorn.ts");
    const joinTime = (siteMetadata.userInfo!.selectors as any).joinTime;

    const cell = document.createElement("span");
    cell.setAttribute("title", "Jan 02 2024, 03:04");

    expect(joinTime.elementProcess(cell)).toBe("Jan 02 2024, 03:04");
    expect(joinTime.filters).toEqual([{ name: "parseTime", args: ["MMM dd yyyy, HH:mm"] }]);

    const probe = await makeProbe(siteMetadata);
    expect(probe.run("Jan 02 2024, 03:04", joinTime.filters)).toBe(Date.parse("2024-01-02T03:04:00Z"));
  });
});

describe("aidoruonline 列表时间（站点运行期默认 +0000）", () => {
  it("具名 parseTime 带站点格式串，按 metadata.timezoneOffset 换算", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/aidoruonline.ts");
    const timeQuery = (siteMetadata.search!.selectors as any).time;

    expect(timeQuery.filters).toEqual([{ name: "parseTime", args: ["MMddyy HH:mm:ss"] }]);

    // 该站未在 metadata 里声明 timezoneOffset，运行期由 index.ts 补 +0000
    const probe = await makeProbe(siteMetadata, "+0000");
    expect(probe.run("010224 03:04:05", timeQuery.filters)).toBe(Date.parse("2024-01-02T03:04:05Z"));
  });
});

describe("anthelion 列表时间（站点 +0000，相对时间）", () => {
  it("span.time 的相对时间只走 parseTTL，不再叠加宿主 getTimezoneOffset", async () => {
    vi.useFakeTimers({ now: FIXED_NOW });
    const { siteMetadata } = await import("@ptd/site/definitions/anthelion.ts");
    const timeQuery = (siteMetadata.list![0].selectors as any).time;

    const probe = await makeProbe(siteMetadata);
    // 旧实现再叠加一次宿主偏移：TZ=Asia/Shanghai 会早 8 小时，TZ=America/New_York 会晚 5 小时
    expect(probe.run("3 hours ago", timeQuery.filters)).toBe(FIXED_NOW.getTime() - 3 * 3600_000);
    // parseTTL 已给出绝对毫秒戳，具名 parseTime 之类的二次换算不存在（原 filter 数组只剩一项）
    expect(timeQuery.filters).toHaveLength(1);
  });
});

describe("anthelion 详情页时间（站点 +0000）", () => {
  // 详情页的时间在种子行的下一个 tr 里，对应选择器 `+ tr span.time[title]` / `+ tr span.time`
  const detailRow = (timeHtml: string) => {
    const doc = new DOMParser().parseFromString(
      `<html><body><table><tbody>
        <tr id="row"><td>group</td></tr>
        <tr><td>${timeHtml}</td></tr>
      </tbody></table></body></html>`,
      "text/html",
    );
    return doc.querySelector("#row")!;
  };
  const loadTimeQuery = async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/anthelion.ts");
    return { siteMetadata, timeQuery: (siteMetadata.list![1].selectors as any).time };
  };

  it("有 title 的墙上时间由 parseWholeTorrentFromRow 按 metadata.timezoneOffset 换算", async () => {
    const { siteMetadata, timeQuery } = await loadTimeQuery();
    const row = detailRow(`<span class="time" title="2024-01-02 03:04:05"></span>`);

    // 覆盖成 -0500：结果只跟 metadata 走（叠加宿主偏移的实现会随 TZ 漂移）
    const probe = await makeProbe(siteMetadata, "-0500");
    const torrent = await probe.parseRow(row, { time: timeQuery });
    expect(torrent.time).toBe(Date.parse("2024-01-02T03:04:05-05:00"));
  });

  it("无 title 的相对时间保持 elementProcess 产出的绝对毫秒戳，不再被叠加宿主偏移", async () => {
    vi.useFakeTimers({ now: FIXED_NOW });
    const { siteMetadata, timeQuery } = await loadTimeQuery();
    const row = detailRow(`<span class="time">3 hours ago</span>`);

    const probe = await makeProbe(siteMetadata);
    const torrent = await probe.parseRow(row, { time: timeQuery });
    // 旧实现会得到 now-3h+getTimezoneOffset()（+0800 宿主即 now-11h）
    expect(torrent.time).toBe(FIXED_NOW.getTime() - 3 * 3600_000);
  });
});

describe("brokenstones 列表时间（站点 -0100，相对时间）", () => {
  it("span.time 的相对时间只走 parseTTL，不再叠加宿主偏移与手工 -1h", async () => {
    vi.useFakeTimers({ now: FIXED_NOW });
    const { siteMetadata } = await import("@ptd/site/definitions/brokenstones.ts");
    const timeQuery = (siteMetadata.list![0].selectors as any).time;

    const probe = await makeProbe(siteMetadata);
    // 旧实现会得到 now-2h-1h+getTimezoneOffset()：TZ=Asia/Shanghai 时比正确值早 9 小时
    expect(probe.run("2 hours ago", timeQuery.filters)).toBe(FIXED_NOW.getTime() - 2 * 3600_000);
    expect(timeQuery.filters).toHaveLength(1);
  });
});

describe("hdspace Today / Yesterday（站点 +0000）", () => {
  const loadTimeQuery = async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/hdspace.ts");
    return { siteMetadata, timeQuery: (siteMetadata.search!.selectors as any).time };
  };

  it("Today at 09:17:08 先归一化成墙上时间串，再按 metadata.timezoneOffset 换算", async () => {
    vi.useFakeTimers({ now: FIXED_NOW });
    const { siteMetadata, timeQuery } = await loadTimeQuery();
    const chain = timeQuery.switchFilters["td:nth-child(5):contains('day')"];

    const probe = await makeProbe(siteMetadata);
    // 旧实现用宿主日历 setHours：TZ=Asia/Shanghai 会得到 01:17:08Z（早 8 小时）
    expect(probe.run("Today at 09:17:08", chain)).toBe(Date.parse("2024-01-02T09:17:08Z"));
  });

  it("Yesterday at 17:11:03 取站点日历的前一天", async () => {
    vi.useFakeTimers({ now: FIXED_NOW });
    const { siteMetadata, timeQuery } = await loadTimeQuery();
    const chain = timeQuery.switchFilters["td:nth-child(5):contains('day')"];

    // 参考时刻为 UTC 正午，+0000 与 -0500 的日历日同为 2024-01-02，故「昨天」= 2024-01-01；
    // 旧实现忽略 metadata，在三种宿主时区下都得不到 -05:00 那个绝对时间戳
    const probe = await makeProbe(siteMetadata, "-0500");
    expect(probe.run("Yesterday at 17:11:03", chain)).toBe(Date.parse("2024-01-01T17:11:03-05:00"));
  });

  it("userInfo 的 joinTime / lastAccessAt 的 day 分支走同一条链", async () => {
    vi.useFakeTimers({ now: FIXED_NOW });
    const { siteMetadata } = await import("@ptd/site/definitions/hdspace.ts");
    const step = (siteMetadata.userInfo!.process as any[])[1];
    const probe = await makeProbe(siteMetadata);
    const daySwitchKeys: Record<string, string> = {
      joinTime: "td.header:contains('Joined on') + td:contains('day')",
      lastAccessAt: "td.header:contains('Last access') + td:contains('day')",
    };

    for (const [field, selector] of Object.entries(daySwitchKeys)) {
      expect(probe.run("Today at 09:17:08", step.selectors[field].switchFilters[selector])).toBe(
        Date.parse("2024-01-02T09:17:08Z"),
      );
    }
  });
});

describe("pussytorrents 用户加入时间（站点 +0000）", () => {
  it("只去掉序数后缀，时区换算交给具名 parseTime（跨 TZ 断言绝对时间戳）", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/pussytorrents.ts");
    const joinTime = (siteMetadata.userInfo!.selectors as any).joinTime;

    const probe = await makeProbe(siteMetadata);
    expect(probe.run("Mar 1st 2024", joinTime.filters)).toBe(Date.parse("2024-03-01T00:00:00Z"));
    // 带逗号的写法同样由具名 parseTime 解析，不落到按宿主时区解释的原生 Date 兜底
    expect(probe.run("Mar 1st, 2024", joinTime.filters)).toBe(Date.parse("2024-03-01T00:00:00Z"));

    // 覆盖成 -0500：旧实现 `new Date(cleaned)` 在 TZ=UTC 下也会给出 2024-03-01T00:00:00Z，
    // 因此这一条在三种宿主时区下都有区分力（新实现只跟 metadata.timezoneOffset 走）
    const probeInOtherZone = await makeProbe(siteMetadata, "-0500");
    expect(probeInOtherZone.run("Mar 12th 2024", joinTime.filters)).toBe(Date.parse("2024-03-12T00:00:00-05:00"));
  });
});
