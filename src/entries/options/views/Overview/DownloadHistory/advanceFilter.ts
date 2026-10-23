/**
 * 下载历史高级筛选弹窗里与「状态机」有关的两段纯逻辑（I1 / I2）。
 *
 * 抽成模块而不是留在 SFC 里，是为了让这两个容易回归的边界（三态循环、±Infinity 区间）
 * 有可断言的回归测试；SFC 只负责把结果绑到控件上。
 */

/** 高级筛选字典里某个关键词字段的三态存储 */
export interface IKeywordFilterDict {
  required?: string[];
  exclude?: string[];
}

export type TKeywordFilterState = "required" | "exclude" | "none";

/** 当前值处于哪一态（checked = required / indeterminate = exclude / 未勾选 = none） */
export function keywordFilterStateOf(dict: IKeywordFilterDict | undefined, value: string): TKeywordFilterState {
  if (dict?.required?.includes(value)) return "required";
  if (dict?.exclude?.includes(value)) return "exclude";
  return "none";
}

/**
 * 三态循环：none → required → exclude → none。
 *
 * 原先 SFC 里同时绑 `@click.stop="toggleKeywordStateFn"` 与 `@update:checked`，
 * 真实事件顺序（click 先于 update:checked）下三态被打乱：排除后无法回到「不参与筛选」，
 * 用户只能整体重置。这里用单一入口完成状态迁移，并返回新状态便于断言/调试。
 */
export function cycleKeywordFilterState(dict: IKeywordFilterDict | undefined, value: string): TKeywordFilterState {
  if (!dict) return "none";
  const required = dict.required ?? [];
  const exclude = dict.exclude ?? [];

  if (required.includes(value)) {
    dict.required = required.filter((item) => item !== value);
    dict.exclude = [...exclude.filter((item) => item !== value), value];
    return "exclude";
  }
  if (exclude.includes(value)) {
    dict.exclude = exclude.filter((item) => item !== value);
    return "none";
  }
  dict.required = [...required.filter((item) => item !== value), value];
  return "required";
}

export const FALLBACK_RANGE_DAYS = 30;

/**
 * 把 `generateRangeField()` 可能返回的 `[-Infinity, Infinity]` 收敛成有限区间（I2）。
 *
 * 下载历史为空 / 尚未加载完时打开高级筛选弹窗，`advanceItemPropsRef.downloadAt.range` 是
 * `[-Infinity, Infinity]`：直接传给 a-slider 的 :min/:max 会得到 NaN 位置的手柄，
 * 自定义日期挑选也不可用。这里回落到「最近 30 天 ~ 现在」作为**展示**区间
 * （调用方不应把返回值写回字典，`[-Infinity, Infinity]` 仍表示「不参与日期筛选」）。
 */
export function resolveFiniteRangeDays(
  range: readonly [number, number] | undefined,
  now: number = Date.now(),
  fallbackDays: number = FALLBACK_RANGE_DAYS,
): [number, number] {
  const rawMin = range?.[0] ?? -Infinity;
  const rawMax = range?.[1] ?? Infinity;
  const min = Number.isFinite(rawMin) ? rawMin : now - fallbackDays * 24 * 60 * 60 * 1000;
  const max = Number.isFinite(rawMax) ? rawMax : now;
  return [min, Math.max(min, max)];
}
