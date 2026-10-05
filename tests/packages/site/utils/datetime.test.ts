import { afterEach, describe, expect, it, vi } from "vitest";

import {
  convertIsoDurationToDate,
  convertIsoDurationToSeconds,
  convertSecondsToIsoDuration,
  parseTimeToLiveToDate,
  parseTimeToLiveToSeconds,
  parseTimeWithZone,
  parseValidTimeString,
} from "@ptd/site/utils/datetime.ts";

const DAY = 86400;
const HOUR = 3600;
const MINUTE = 60;

describe("parseTimeToLiveToSeconds", () => {
  it("标准英文单位", () => {
    expect(parseTimeToLiveToSeconds("1 day")).toBe(DAY);
    expect(parseTimeToLiveToSeconds("2 weeks")).toBe(14 * DAY);
    expect(parseTimeToLiveToSeconds("3 hours")).toBe(3 * HOUR);
    expect(parseTimeToLiveToSeconds("30 minutes")).toBe(30 * MINUTE);
    expect(parseTimeToLiveToSeconds("1yr")).toBe(365 * DAY);
  });

  it("中文单位（含繁体）", () => {
    expect(parseTimeToLiveToSeconds("1天")).toBe(DAY);
    expect(parseTimeToLiveToSeconds("2周")).toBe(14 * DAY);
    expect(parseTimeToLiveToSeconds("1 個月")).toBe(30 * DAY);
    expect(parseTimeToLiveToSeconds("1 小時")).toBe(HOUR);
    expect(parseTimeToLiveToSeconds("3秒")).toBe(3);
  });

  it("单字母单位沿用 moment/date-fns 约定：大写 M/D/W/Y，小写 h/m/s", () => {
    expect(parseTimeToLiveToSeconds("1D")).toBe(DAY);
    expect(parseTimeToLiveToSeconds("5 M")).toBe(150 * DAY); // M = month = 30 天
    expect(parseTimeToLiveToSeconds("3 h")).toBe(3 * HOUR);
    // 小写 d 不在单位表内（大小写敏感），整个字符串原样返回
    expect(parseTimeToLiveToSeconds("1d")).toBe("1d");
  });

  it("多段单位累加", () => {
    expect(parseTimeToLiveToSeconds("1 day 2 hours")).toBe(DAY + 2 * HOUR);
    expect(parseTimeToLiveToSeconds("1天 2小時 30分鐘")).toBe(DAY + 2 * HOUR + 30 * MINUTE);
  });

  it("简体两字单位必须紧跟数字也要能匹配（回归 B-21）", () => {
    // 修复前 "小时" / "个月" 不在单位表里，而正则要求单位紧跟数字，
    // 于是 "1天2小时" 少算 2 小时、"5小时" 直接返回字符串
    expect(parseTimeToLiveToSeconds("1天2小时")).toBe(DAY + 2 * HOUR);
    expect(parseTimeToLiveToSeconds("1天2小时30分钟")).toBe(DAY + 2 * HOUR + 30 * MINUTE);
    expect(parseTimeToLiveToSeconds("5小时")).toBe(5 * HOUR);
    expect(parseTimeToLiveToSeconds("1个月")).toBe(30 * DAY);
    expect(parseTimeToLiveToSeconds("1个月5天")).toBe(30 * DAY + 5 * DAY);
    expect(parseTimeToLiveToSeconds("1週")).toBe(7 * DAY);
    expect(parseTimeToLiveToSeconds("1日")).toBe(DAY);
  });

  it("单字母单位后面不接字母即可，允许紧凑写法（回归 B-24）", () => {
    expect(parseTimeToLiveToSeconds("2h30m")).toBe(2 * HOUR + 30 * MINUTE);
    expect(parseTimeToLiveToSeconds("1D2h")).toBe(DAY + 2 * HOUR);
    // 空格分隔与英文长单位不受影响
    expect(parseTimeToLiveToSeconds("2h 30m")).toBe(2 * HOUR + 30 * MINUTE);
    expect(parseTimeToLiveToSeconds("2 hours 30 minutes")).toBe(2 * HOUR + 30 * MINUTE);
    expect(parseTimeToLiveToSeconds("3 hrs")).toBe(3 * HOUR);
  });

  it("单字母单位的边界必须是「任何字母」，非 ASCII 字母同样要挡住（回归 B-21/B-24 的修复副作用）", () => {
    // 边界曾用 `(?![A-Za-z])`，非 ASCII 字母不在此列，于是下面这些**非英文**时长词会被
    // 当成单字母单位解析出静默错值。可达链路：ncore（匈牙利语）只归一化 éve/hete/napja/perce，
    // 没有 hónap/hét，`"1 hónapja"` 里的 h(小时) 会在旧边界下通过 → MyData 显示成「1 小时前」。
    expect(parseTimeToLiveToSeconds("1 hónapja")).toBe("1 hónapja"); // 匈：1 个月前
    expect(parseTimeToLiveToSeconds("1 hét")).toBe("1 hét"); // 匈：1 周
    expect(parseTimeToLiveToSeconds("1 mês")).toBe("1 mês"); // 葡：1 个月
    // 西班牙语/法语等同类形态
    expect(parseTimeToLiveToSeconds("1 hora")).toBe("1 hora");
    // 合法英文仍必须正常解析（边界变严不能误伤）
    expect(parseTimeToLiveToSeconds("1 hour")).toBe(HOUR);
    expect(parseTimeToLiveToSeconds("1h")).toBe(HOUR);
  });

  it("无法识别时原样返回输入字符串（调用方靠 typeof 判断）", () => {
    expect(parseTimeToLiveToSeconds("abc")).toBe("abc");
    expect(parseTimeToLiveToSeconds("")).toBe("");
    expect(parseTimeToLiveToSeconds("永久")).toBe("永久");
    // 部分匹配不再返回「半截数字」：有数字没被任何单位消费掉时视为解析失败（回归 B-21）
    expect(parseTimeToLiveToSeconds("1天2刻")).toBe("1天2刻");
    expect(parseTimeToLiveToSeconds("1 day 2")).toBe("1 day 2");
    // 但纯文字尾巴（真实站点的 "…ago" / "…前" 格式）仍然按前缀解析
    expect(parseTimeToLiveToSeconds("1 day 2 hours ago")).toBe(DAY + 2 * HOUR);
    expect(parseTimeToLiveToSeconds("1年2月3天4时5分前")).toBe(
      365 * DAY + 2 * 30 * DAY + 3 * DAY + 4 * HOUR + 5 * MINUTE,
    );
  });

  it("0 是合法的解析结果（返回数字 0，而不是原字符串）", () => {
    expect(parseTimeToLiveToSeconds("0 days")).toBe(0);
  });
});

describe("parseTimeToLiveToDate", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("返回「当前时间 - ttl」的时间戳", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-03-01T00:00:00.000Z"));

    expect(parseTimeToLiveToDate("1 day")).toBe(+new Date("2024-02-29T00:00:00.000Z"));
    expect(parseTimeToLiveToDate("2 hours")).toBe(+new Date("2024-02-29T22:00:00.000Z"));
  });

  it("无法解析时原样返回字符串", () => {
    expect(parseTimeToLiveToDate("永久")).toBe("永久");
  });
});

describe("parseTimeWithZone", () => {
  it("Unix 时间戳（秒 / 毫秒 / 纯数字字符串）原样换算，不再叠加时区偏移", () => {
    expect(parseTimeWithZone(1710000000)).toBe(1710000000000);
    expect(parseTimeWithZone("1710000000")).toBe(1710000000000);
    expect(parseTimeWithZone(1710000000000)).toBe(1710000000000);
    expect(parseTimeWithZone("1710000000000")).toBe(1710000000000);
    expect(parseTimeWithZone(0)).toBe(0);
  });

  it("墙上时间按给定偏移换算为绝对时间戳（不依赖运行主机时区）", () => {
    expect(parseTimeWithZone("2024-03-01 10:00:00", "+0800")).toBe(+new Date("2024-03-01T10:00:00+08:00"));
    expect(parseTimeWithZone("2024-03-01 10:00:00", "+0000")).toBe(+new Date("2024-03-01T10:00:00Z"));
    expect(parseTimeWithZone("2024-03-01 10:00:00", "UTC-0500")).toBe(+new Date("2024-03-01T10:00:00-05:00"));
  });

  it("显式带 Z 或偏移的时间已经是绝对时间，不叠加站点偏移", () => {
    expect(parseTimeWithZone("2024-03-01T10:00:00Z", "-0500")).toBe(Date.parse("2024-03-01T10:00:00Z"));
    expect(parseTimeWithZone("2024-03-01T10:00:00-05:00", "+0000")).toBe(Date.parse("2024-03-01T10:00:00-05:00"));
  });

  it("仅含日期的墙上时间按站点零点解释", () => {
    expect(parseTimeWithZone("2024-03-01", "+0800")).toBe(Date.parse("2024-03-01T00:00:00+08:00"));
    expect(parseTimeWithZone("2024-13-01", "+0800")).toBe(0);
  });

  it("默认偏移为 +0000", () => {
    expect(parseTimeWithZone("2024-03-01 10:00:00")).toBe(+new Date("2024-03-01T10:00:00Z"));
  });

  it("偏移写法被规范化：+8 / UTC+8 / +08:00 / +08 与 +0800 等价（回归 B-23）", () => {
    // 修复前这些写法都无法匹配 `^(?:UTC)?([+-])(\\d{1,2})(\\d{2})$`，于是 offsetSign 为 undefined，
    // 函数会按**运行主机的本地时区**解释站点的墙上时间——静默且随机器变化
    const expected = +new Date("2024-03-01T10:00:00+08:00");
    expect(parseTimeWithZone("2024-03-01 10:00:00", "+0800")).toBe(expected);
    expect(parseTimeWithZone("2024-03-01 10:00:00", "+8")).toBe(expected);
    expect(parseTimeWithZone("2024-03-01 10:00:00", "UTC+8")).toBe(expected);
    expect(parseTimeWithZone("2024-03-01 10:00:00", "+08:00" as any)).toBe(expected);
    expect(parseTimeWithZone("2024-03-01 10:00:00", "+08")).toBe(expected);
    // 负偏移与半时区同样支持
    expect(parseTimeWithZone("2024-03-01 10:00:00", "-05:30" as any)).toBe(+new Date("2024-03-01T10:00:00-05:30"));
    // 完全无法识别的偏移：明确失败返回安全值 0，而不是按宿主机时区算出一个假时间戳
    expect(parseTimeWithZone("2024-03-01 10:00:00", "garbage" as any)).toBe(0);
    expect(parseTimeWithZone("2024-03-01 10:00:00", "+0860" as any)).toBe(0);
  });

  it("无效时间与空值返回安全值 0，且绝不抛异常（回归 B-1）", () => {
    // 修复前：format(new Date("昨天"), …) 抛 RangeError: Invalid time value
    expect(parseTimeWithZone("昨天", "+0800")).toBe(0);
    expect(parseTimeWithZone("", "+0800")).toBe(0);
    expect(parseTimeWithZone("not a date", "+0800")).toBe(0);
    // null / undefined 以前会静默变成 1970（new Date(null) === epoch）
    expect(parseTimeWithZone(null as any, "+0800")).toBe(0);
    expect(parseTimeWithZone(undefined as any, "+0800")).toBe(0);
    expect(parseTimeWithZone(Number.NaN, "+0800")).toBe(0);
  });
});

describe("convertIsoDurationToSeconds", () => {
  it("按固定时长常量换算（年 = 365 天，月 = 30 天）", () => {
    expect(convertIsoDurationToSeconds("P1Y")).toBe(365 * DAY);
    expect(convertIsoDurationToSeconds("P1M")).toBe(30 * DAY);
    expect(convertIsoDurationToSeconds("P1W")).toBe(7 * DAY);
    expect(convertIsoDurationToSeconds("P1D")).toBe(DAY);
    expect(convertIsoDurationToSeconds("PT1H")).toBe(HOUR);
    expect(convertIsoDurationToSeconds("PT1M")).toBe(MINUTE);
    expect(convertIsoDurationToSeconds("PT1S")).toBe(1);
  });

  it("小写输入会被大写化后再匹配，各段累加", () => {
    expect(convertIsoDurationToSeconds("p1y2m3dt4h5m6s")).toBe(
      365 * DAY + 2 * 30 * DAY + 3 * DAY + 4 * HOUR + 5 * MINUTE + 6,
    );
    expect(convertIsoDurationToSeconds("p1d")).toBe(DAY);
  });

  it("空 duration 与无法识别的输入返回 0", () => {
    expect(convertIsoDurationToSeconds("P")).toBe(0);
    expect(convertIsoDurationToSeconds("garbage")).toBe(0);
    expect(convertIsoDurationToSeconds("")).toBe(0);
  });
});

describe("convertSecondsToIsoDuration", () => {
  it("按 年/月/周/天 拆分并省略为 0 的段", () => {
    expect(convertSecondsToIsoDuration(DAY)).toBe("P1D");
    expect(convertSecondsToIsoDuration(7 * DAY)).toBe("P1W");
    expect(convertSecondsToIsoDuration(30 * DAY)).toBe("P1M");
    expect(convertSecondsToIsoDuration(365 * DAY)).toBe("P1Y");
    expect(convertSecondsToIsoDuration(366 * DAY)).toBe("P1Y1D");
    expect(convertSecondsToIsoDuration(365 * DAY + 30 * DAY + 7 * DAY + DAY)).toBe("P1Y1M1W1D");
  });

  it("不足一天（含 0 与负数）时返回 P0D", () => {
    expect(convertSecondsToIsoDuration(0)).toBe("P0D");
    expect(convertSecondsToIsoDuration(-5)).toBe("P0D");
    expect(convertSecondsToIsoDuration(HOUR)).toBe("P0D");
  });
});

describe("convertIsoDurationToDate", () => {
  it("天 / 周 / 秒是固定长度", () => {
    expect(convertIsoDurationToDate("P1D", 0)).toBe(DAY * 1000);
    expect(convertIsoDurationToDate("P1W", 0)).toBe(7 * DAY * 1000);
    expect(convertIsoDurationToDate("PT1H", 0)).toBe(HOUR * 1000);
  });

  it("月 / 年是日历语义（date-fns add），与 convertIsoDurationToSeconds 的 30/365 天常量不同", () => {
    // 1970-01-01 + 1 month = 1970-02-01 => 31 天
    expect(convertIsoDurationToDate("P1M", 0)).toBe(31 * DAY * 1000);
    // 1970-01-01 + 1 year = 1971-01-01 => 365 天
    expect(convertIsoDurationToDate("P1Y", 0)).toBe(365 * DAY * 1000);
  });

  it("基于传入的时间戳累加，不修改入参", () => {
    const base = +new Date("2024-03-01T00:00:00.000Z");
    expect(convertIsoDurationToDate("P2D", base)).toBe(base + 2 * DAY * 1000);
    expect(base).toBe(+new Date("2024-03-01T00:00:00.000Z"));
  });
});

describe("parseValidTimeString", () => {
  it("不合法的站点格式串不阻断其它格式与原生日期兜底", () => {
    expect(parseValidTimeString("2024-03-01 10:00:00", ["DD-MM-YYYY HH:mm"])).toBe(+new Date("2024-03-01 10:00:00"));
  });
  it("带时区的 ISO 字符串解析为确定的时间戳", () => {
    expect(parseValidTimeString("2024-03-01T10:00:00.000Z")).toBe(+new Date("2024-03-01T10:00:00.000Z"));
    expect(parseValidTimeString("2024-03-01T10:00:00+08:00")).toBe(+new Date("2024-03-01T10:00:00+08:00"));
  });

  it("无时区的墙上时间按主机本地时区解析（与 Date 构造函数一致）", () => {
    expect(parseValidTimeString("2024-03-01 10:00:00")).toBe(+new Date("2024-03-01 10:00:00"));
  });

  it("优先使用调用方传入的格式串", () => {
    expect(parseValidTimeString("01/03/2024", ["dd/MM/yyyy"])).toBe(+new Date(2024, 2, 1));
    // 未传格式串时 "01/03/2024" 会被原生 Date 当作本地时间 1 月 3 日
    expect(parseValidTimeString("01/03/2024")).toBe(+new Date(2024, 0, 3));
  });

  it("完全无法解析时原样返回输入字符串", () => {
    expect(parseValidTimeString("not a date")).toBe("not a date");
    expect(parseValidTimeString("")).toBe("");
  });
});
