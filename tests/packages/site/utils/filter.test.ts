/**
 * 内置过滤器回归测试（E01 / E02 / E03 / E04）。
 *
 * 背景：`tests/packages/site/utils/filterNameTyping.test.ts` 只测了「过滤器名的类型约束」，
 * 内置过滤器的行为没有任何单测，于是 parseSize 的贪婪正则、大小写、逗号问题长期存在。
 */
import { describe, expect, it } from "vitest";

import { definedFilters, normalizeNumericField, toFiniteNumber, tryToNumber } from "@ptd/site/utils/filter.ts";

const parseSize = definedFilters.parseSize as (query: unknown) => number;
const parseNumber = definedFilters.parseNumber as (query: unknown) => number;
const parseTTL = definedFilters.parseTTL as (query: unknown) => number | string;
const parseFuzzyTime = definedFilters.parseFuzzyTime as (query: unknown, args?: string[]) => number | string;

const KB = 1024;
const MB = 1024 ** 2;
const GB = 1024 ** 3;
const TB = 1024 ** 4;

describe("parseSize（E01：贪婪正则 / E02：单位大小写 / E03：逗号小数）", () => {
  it("尺寸后跟其它文字（含 B）时仍取第一个「数字+单位」片段", () => {
    expect(parseSize("700 MB (Blu-ray)")).toBe(700 * MB);
    expect(parseSize("1.5 GB Blu-ray")).toBe(1.5 * GB);
    expect(parseSize("4.2 GB [BD]")).toBe(4.2 * GB);
    expect(parseSize("1.5 GB (1,610,612,736 Bytes)")).toBe(1.5 * GB);
    expect(parseSize("[3] 1.5 GB")).toBe(1.5 * GB);
    expect(parseSize("2.5TB / Blu-ray")).toBe(2.5 * TB);
    expect(parseSize("1.44GB / 2.5GB")).toBe(1.44 * GB);
    expect(parseSize("Size: 1.44 GB")).toBe(1.44 * GB);
  });

  it("单位大小写不敏感（E02）", () => {
    expect(parseSize("700 mb")).toBe(700 * MB);
    expect(parseSize("1.2 gb")).toBe(1.2 * GB);
    expect(parseSize("1.5gib")).toBe(1.5 * GB);
    expect(parseSize("700 MiB")).toBe(700 * MB);
  });

  it("支持裸字节数文本（B / Bytes）", () => {
    expect(parseSize("1234567890 Bytes")).toBe(1234567890);
    expect(parseSize("10B")).toBe(10);
    expect(parseSize("0 B")).toBe(0);
  });

  it("欧式小数逗号不再放大/缩小（E03）", () => {
    expect(parseSize("1,5 GB")).toBe(1.5 * GB);
    expect(parseSize("1.234,56 MB")).toBeCloseTo(1234.56 * MB, 0);
    expect(parseSize("1,024 MiB")).toBe(1024 * MB);
  });

  it("无单位整数按字节数、其它无法解析的输入返回 0", () => {
    expect(parseSize(1024)).toBe(1024);
    expect(parseSize("1024")).toBe(1024);
    expect(parseSize("")).toBe(0);
    expect(parseSize(null)).toBe(0);
    expect(parseSize("abc")).toBe(0);
  });

  it("L-2：省略整数部分的小数按小数解析（.5 GB / .5 TB）", () => {
    expect(parseSize(".5 GB")).toBe(0.5 * GB);
    expect(parseSize(" .5 GB")).toBe(0.5 * GB);
    expect(parseSize(".5TB")).toBe(0.5 * TB);
    expect(parseSize("Size: .5 GB (536,870,912 Bytes)")).toBe(0.5 * GB);
    // 负数尺寸没有业务含义，但也不能被抽成 5
    expect(parseSize("-.5 GB")).toBe(0.5 * GB);
  });
});

describe("parseNumber（E03）", () => {
  it("取第一个数字片段并按区域格式解析", () => {
    expect(parseNumber("This is 8.5")).toBe(8.5);
    expect(parseNumber("1,024")).toBe(1024);
    expect(parseNumber("1 024")).toBe(1024);
    expect(parseNumber("-12")).toBe(-12);
    expect(parseNumber(42)).toBe(42);
  });

  it("欧式小数逗号解析为小数", () => {
    expect(parseNumber("1,5 GB")).toBe(1.5);
    expect(parseNumber("1.234,56 MB")).toBe(1234.56);
  });

  it("没有数字时返回 0", () => {
    expect(parseNumber("no digits here")).toBe(0);
    expect(parseNumber("")).toBe(0);
    expect(parseNumber(null)).toBe(0);
  });

  it("L-2：省略整数部分的小数保留小数语义（.5 / -.5）", () => {
    expect(parseNumber(".5")).toBe(0.5);
    expect(parseNumber(" ratio .5 ")).toBe(0.5);
    expect(parseNumber("-.5")).toBe(-0.5);
    // 已有格式不回归
    expect(parseNumber("0.5")).toBe(0.5);
    expect(parseNumber("-0.5")).toBe(-0.5);
  });
});

describe("tryToNumber（E03）", () => {
  it("只把千分位整数转成 number", () => {
    expect(tryToNumber("1024")).toBe(1024);
    expect(tryToNumber("1,024")).toBe(1024);
    expect(tryToNumber("1 024")).toBe(1024);
    expect(tryToNumber("  -12 ")).toBe(-12);
    expect(tryToNumber(42)).toBe(42);
  });

  it("欧式小数与非数字文本保持原样，避免被误判为整数", () => {
    expect(tryToNumber("1,5")).toBe("1,5");
    expect(tryToNumber("12abc")).toBe("12abc");
    expect(tryToNumber("1.5")).toBe("1.5");
  });
});

describe("parseTTL / parseFuzzyTime（E04 联动）", () => {
  it("parseTTL 返回「当前时间 - 时长」的时间戳", () => {
    const now = Date.now();
    const oneDayAgo = parseTTL("1 day");
    expect(typeof oneDayAgo).toBe("number");
    expect(Math.abs(now - (oneDayAgo as number) - 24 * 3600 * 1000)).toBeLessThan(5_000);
  });

  it("parseFuzzyTime：无年份自然语言日期按当前年份补全（不再回落到 2001 年）", () => {
    const parsed = parseFuzzyTime("5 Jan");
    expect(typeof parsed).toBe("number");
    const date = new Date(parsed as number);
    expect(date.getFullYear()).toBe(new Date().getFullYear());
    expect(date.getMonth()).toBe(0);
    expect(date.getDate()).toBe(5);
  });

  it("parseFuzzyTime：无法识别的文本原样返回", () => {
    expect(parseFuzzyTime("Released 3")).toBe("Released 3");
    expect(parseFuzzyTime("unknown")).toBe("unknown");
  });
});

describe('数值字段归一 helper（供 getFieldData 零命中 "" 使用）', () => {
  it("toFiniteNumber：区分「字段缺失」与「值真的是 0」", () => {
    expect(toFiniteNumber("")).toBeUndefined();
    expect(toFiniteNumber("   ")).toBeUndefined();
    expect(toFiniteNumber(null)).toBeUndefined();
    expect(toFiniteNumber(undefined)).toBeUndefined();
    expect(toFiniteNumber("abc")).toBeUndefined();
    expect(toFiniteNumber(Number.NaN)).toBeUndefined();
    expect(toFiniteNumber(Number.POSITIVE_INFINITY)).toBeUndefined();

    expect(toFiniteNumber("0")).toBe(0);
    expect(toFiniteNumber(0)).toBe(0);
    expect(toFiniteNumber("1,234")).toBe(1234);
    expect(toFiniteNumber("1,5")).toBe(1.5);
    expect(toFiniteNumber(" 42 ")).toBe(42);
    expect(toFiniteNumber(-3)).toBe(-3);
  });

  it("normalizeNumericField：空值/不可解析时回落 fallback", () => {
    expect(normalizeNumericField("")).toBe(0);
    expect(normalizeNumericField(null)).toBe(0);
    expect(normalizeNumericField("abc")).toBe(0);
    expect(normalizeNumericField("", 7)).toBe(7);
    expect(normalizeNumericField("1,024")).toBe(1024);
    expect(normalizeNumericField(5)).toBe(5);
  });
});
