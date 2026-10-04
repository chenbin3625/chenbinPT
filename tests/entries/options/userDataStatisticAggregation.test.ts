/**
 * V-12 回归测试：统计页的「合计」与「逐站序列」必须对同一份数据得出同样的数字。
 *
 * 修复前：合计用 `.filter(isNumber)`，逐站序列用 `Number(val) || 0`。而 es-toolkit/compat 的
 * `isNumber(NaN) === true`、`isNumber("123") === false`：
 *   - 以数字字符串存储的字段（IUserInfo 允许，issue #48）被合计丢弃、却在条形图里计入；
 *   - 一个 NaN 能通过 filter 并污染整个日桶的合计（echarts 断点/空洞）。
 *
 * 修复后两者共用 `toNumber`（parseFloat + Number.isFinite 校验）。
 */
import { describe, expect, it, vi } from "vitest";
import { isNumber } from "es-toolkit/compat";

vi.mock("@/messages.ts", () => ({ sendMessage: vi.fn(), onMessage: vi.fn() }));
vi.mock("@/options/stores/metadata.ts", () => ({ useMetadataStore: () => ({ getAddedSiteIds: [] }) }));

const { toNumber, sumUserInfoFieldByDate } = await import("@/options/views/Overview/MyData/UserDataStatistic/utils.ts");

describe("V-12：toNumber 数值归一化", () => {
  it("数字原样返回，非有限数字归零", () => {
    expect(toNumber(123)).toBe(123);
    expect(toNumber(0)).toBe(0);
    expect(toNumber(-5.5)).toBe(-5.5);
    expect(toNumber(NaN)).toBe(0);
    expect(toNumber(Infinity)).toBe(0);
    expect(toNumber(-Infinity)).toBe(0);
  });

  it("数字字符串按 parseFloat 解析（修复前会被 isNumber 丢弃）", () => {
    expect(toNumber("123")).toBe(123);
    expect(toNumber("123.45")).toBe(123.45);
    expect(toNumber(" 42 ")).toBe(42);
    expect(toNumber("")).toBe(0);
    expect(toNumber("abc")).toBe(0);
  });

  it("其它类型归零", () => {
    expect(toNumber(undefined)).toBe(0);
    expect(toNumber(null)).toBe(0);
    expect(toNumber({})).toBe(0);
    expect(toNumber([])).toBe(0);
  });

  it("旧实现的两个失效点（es-toolkit/compat 语义）仍成立——这正是本修复的动机", () => {
    expect(isNumber(NaN)).toBe(true); // NaN 能通过 filter
    expect(isNumber("123")).toBe(false); // 数字字符串被丢弃
  });
});

describe("V-12：合计与逐站序列一致", () => {
  const dates = ["2026-01-01", "2026-01-02"];
  const sites = ["site-a", "site-b"];
  const dailyUserInfo = {
    "2026-01-01": {
      "site-a": { uploaded: 100 },
      // 数字字符串：旧实现里被合计丢弃，却在条形图里计入
      "site-b": { uploaded: "50" },
    },
    "2026-01-02": {
      // NaN：旧实现里能通过 isNumber filter 并污染整个日桶
      "site-a": { uploaded: NaN },
      "site-b": { uploaded: 30 },
    },
  } as any;

  it("数字字符串计入合计，NaN 归零（不再污染日桶）", () => {
    expect(sumUserInfoFieldByDate(dailyUserInfo, dates, sites, "uploaded")).toEqual([150, 30]);
  });

  it("修复前的合计结果（对照）：数字字符串丢失、NaN 泄漏成 NaN", () => {
    const legacyTotal = (date: string) =>
      Object.values(dailyUserInfo[date] ?? {})
        .map((x: any) => x["uploaded"])
        .filter(isNumber)
        .reduce((a: any, b: any) => (a ?? 0) + (b ?? 0), 0);

    expect(legacyTotal("2026-01-01")).toBe(100); // 期望 150
    expect(Number.isNaN(legacyTotal("2026-01-02"))).toBe(true); // 期望 30
  });

  it("合计恒等于各站点序列之和（跨页勾选任意站点组合都成立）", () => {
    const totals = sumUserInfoFieldByDate(dailyUserInfo, dates, sites, "uploaded");

    const seriesBySite = sites.map((site) => dates.map((date) => toNumber(dailyUserInfo[date]?.[site]?.["uploaded"])));

    dates.forEach((_date, index) => {
      expect(totals[index]).toBe(seriesBySite.reduce((sum, series) => sum + series[index]!, 0));
    });
  });

  it("缺失的日期 / 站点按 0 处理", () => {
    expect(sumUserInfoFieldByDate(dailyUserInfo, ["2026-01-03"], sites, "uploaded")).toEqual([0]);
    expect(sumUserInfoFieldByDate({}, dates, sites, "uploaded")).toEqual([0, 0]);
    expect(sumUserInfoFieldByDate(dailyUserInfo, dates, [], "uploaded")).toEqual([0, 0]);
  });
});
