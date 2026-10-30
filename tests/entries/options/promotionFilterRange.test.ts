/**
 * 优惠系数的范围筛选（移植自上游 13991d15b5 / #1650 的 S4 消费层）。
 *
 * 覆盖两个在本次移植中**改过语义**的点：
 * 1. 字段缺失（系数未知）必须判为「不匹配」——否则「按优惠筛选」会把旧快照、站点没给促销信息的种子
 *    一起列进来（上游 `checkRangeValue` 的原始实现返回 undefined 即视为跳过）；
 * 2. 边界 0 必须被识别为「已设置的边界」——`downloadVolumeFactor = 0`（免费）正是最有意义的筛选下界，
 *    历史实现用 `from || -Infinity` / `Boolean(from && ...)` 会把 0 当成「未设置」。
 *
 * 另外覆盖 `generateRangeField` 的两处加固：一次线性扫描（不用 `Math.min(...data)`，避免上万种子打爆参数栈）、
 * 刻度上限 80（避免滑块渲染出成百上千个 mark）。
 */
import { describe, expect, it } from "vitest";

import { checkRangeValue, generateRangeField } from "@/options/directives/useAdvanceFilter.ts";

type TFilter = Record<string, { from?: number; to?: number }>;

describe("checkRangeValue：优惠系数范围筛选", () => {
  it("免费（系数 0）能被 0 下界识别，不会被当成「未设置」", () => {
    const filter: TFilter = { downloadVolumeFactor: { from: 0, to: 0.5 } };

    expect(checkRangeValue(filter, { downloadVolumeFactor: 0 }, "downloadVolumeFactor")).toBe(true);
    expect(checkRangeValue(filter, { downloadVolumeFactor: 0.5 }, "downloadVolumeFactor")).toBe(true);
    expect(checkRangeValue(filter, { downloadVolumeFactor: 1 }, "downloadVolumeFactor")).toBe(false);
  });

  it("系数未知（字段缺失 / undefined / N/A）一律判为不匹配", () => {
    const filter: TFilter = { downloadVolumeFactor: { from: 0, to: 0.5 } };

    expect(checkRangeValue(filter, {}, "downloadVolumeFactor")).toBe(false);
    expect(checkRangeValue(filter, { downloadVolumeFactor: undefined }, "downloadVolumeFactor")).toBe(false);
    expect(checkRangeValue(filter, { downloadVolumeFactor: "N/A" }, "downloadVolumeFactor")).toBe(false);
  });

  it("上传倍率：2 倍上传能命中 from=2 的筛选，1 倍不命中", () => {
    const filter: TFilter = { uploadVolumeFactor: { from: 2 } };

    expect(checkRangeValue(filter, { uploadVolumeFactor: 2 }, "uploadVolumeFactor")).toBe(true);
    expect(checkRangeValue(filter, { uploadVolumeFactor: 1 }, "uploadVolumeFactor")).toBe(false);
    expect(checkRangeValue(filter, {}, "uploadVolumeFactor")).toBe(false);
  });

  it("该 range 未参与筛选时返回 undefined（调用方据此跳过），而不是 false", () => {
    const filter: TFilter = { downloadVolumeFactor: { from: undefined, to: undefined } };

    expect(checkRangeValue(filter, { downloadVolumeFactor: 0.5 }, "downloadVolumeFactor")).toBe(true);

    const unused: TFilter = {};
    expect(checkRangeValue(unused, { downloadVolumeFactor: 0 }, "downloadVolumeFactor")).toBeUndefined();
  });
});

describe("generateRangeField：范围与刻度", () => {
  it("只接受有限数字，未知值不参与求范围", () => {
    const field = generateRangeField([undefined, 0.25, 0.5, 1] as (number | undefined)[]);

    expect(field.range).toEqual([0.25, 1]);
    expect(field.ticks).toEqual([0.25, 0.5, 1]);
  });

  it("全部未知时回落到开区间，且没有刻度", () => {
    const field = generateRangeField([undefined, undefined, "N/A" as unknown as number]);

    expect(field.range).toEqual([Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY]);
    expect(field.ticks).toEqual([]);
  });

  it("刻度数量有上限（均匀采样），不会渲染出成百上千个 mark", () => {
    const data = Array.from({ length: 500 }, (_, index) => index / 500);
    const field = generateRangeField(data);

    expect(field.range).toEqual([0, 499 / 500]);
    expect(field.ticks.length).toBeLessThanOrEqual(80);
    expect(field.ticks.length).toBeGreaterThan(1);
    // 采样必须落在原始取值上，且保持升序
    const sorted = [...field.ticks].sort((a, b) => a - b);
    expect(field.ticks).toEqual(sorted);
    for (const tick of field.ticks) {
      expect(data).toContain(tick);
    }
  });

  it("样本数少于上限时保留全部刻度（与旧行为一致）", () => {
    const field = generateRangeField([0, 0.5, 1, 0.5]);

    expect(field.range).toEqual([0, 1]);
    expect(field.ticks).toEqual([0, 0.5, 1]);
  });
});
