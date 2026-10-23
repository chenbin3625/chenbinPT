/**
 * 体积解析单测（见 docs/performance-audit.md P2-3）。
 *
 * P2-3 把 `parseSizeString` 的 `switch(true) + 正则字面量` 改成了"首字母查表"，
 * 这里锁住各单位的换算结果与边界行为，防止后续误改倍率或单位表。
 */
import { describe, expect, it } from "vitest";

import { parseSizeString } from "@ptd/site/utils/filesize.ts";

const KB = 2 ** 10;
const MB = 2 ** 20;
const GB = 2 ** 30;
const TB = 2 ** 40;

describe("parseSizeString：单位换算", () => {
  it("二进制单位（KiB/MiB/GiB/TiB）", () => {
    expect(parseSizeString("1 KiB")).toBe(KB);
    expect(parseSizeString("1.5 GiB")).toBe(1.5 * GB);
    expect(parseSizeString("700 MiB")).toBe(700 * MB);
    expect(parseSizeString("2TiB")).toBe(2 * TB);
  });

  it("十进制写法（KB/MB/GB）按同一倍率解析（与原实现一致）", () => {
    expect(parseSizeString("700 MB")).toBe(700 * MB);
    expect(parseSizeString("1 GB")).toBe(GB);
  });

  it("允许大小写与分隔符变化", () => {
    expect(parseSizeString("1.5gib")).toBe(1.5 * GB);
    expect(parseSizeString("1.5  GiB")).toBe(1.5 * GB);
    expect(parseSizeString("1.5-GiB")).toBe(1.5 * GB);
  });

  it("允许千分位逗号", () => {
    expect(parseSizeString("1,024 MiB")).toBe(1024 * MB);
    expect(parseSizeString("12,345,678 B")).toBe(12345678);
  });

  it("E03：欧式小数逗号按小数解析，不再放大/缩小", () => {
    expect(parseSizeString("1,5 GB")).toBe(1.5 * GB);
    expect(parseSizeString("1.234,56 MB")).toBeCloseTo(1234.56 * MB, 0);
    expect(parseSizeString("1,5GiB")).toBe(1.5 * GB);
  });

  it("E01：支持裸字节数（B / Bytes）", () => {
    expect(parseSizeString("10B")).toBe(10);
    expect(parseSizeString("10 Bytes")).toBe(10);
    expect(parseSizeString("1234567890 Bytes")).toBe(1234567890);
  });

  it("空格作为千分位分隔符", () => {
    expect(parseSizeString("1 024 MiB")).toBe(1024 * MB);
  });

  it("0 与非法输入返回 0（与原实现一致，不返回 NaN）", () => {
    expect(parseSizeString("0 B")).toBe(0);
    expect(parseSizeString("abc")).toBe(0);
    expect(parseSizeString("")).toBe(0);
  });

  it("缺少单位时不匹配（返回 0）", () => {
    expect(parseSizeString("1024")).toBe(0);
  });
});
