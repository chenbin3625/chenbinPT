/**
 * 时区矩阵工具（审查 H-L2 / H-L5）。
 *
 * ## 问题
 *
 * `tests/packages/site/definitions/timezone-sweep.review-fixes.test.ts` 的文件头声称
 * 「区分力来自 TZ=Asia/Shanghai / TZ=America/New_York 两次运行」，但代码里从未设置 `TZ`：
 * 声明 `+0800` 的站点用例在 +0800 开发机上「碰巧」通过，声明 `+0000` 的站群在 UTC 机器上「碰巧」通过。
 * 只靠绝对时间戳断言的用例因此随宿主机漂移，把 SITECORE-1（站点时间按 `metadata.timezoneOffset`
 * 解析，而不是宿主时区）回退成「按宿主时区解析」时，维护者机器上可能整体全绿。
 *
 * ## 做法
 *
 * Node（>=16，本仓库实测 24.21）支持在运行时通过 `process.env.TZ = ...` 切换进程时区
 * （V8 会收到时区变更通知，`new Date(...)` / `date-fns` 随即按新时区解释墙上时间），
 * 因此不需要像 `tests/packages/site/utils/datetimeHostTimezone.test.ts` 那样起子进程：
 * 同一条用例在矩阵里的每个时区各注册一次，失败信息里带 `TZ=`，定位直接。
 *
 * 约束：只改 `process.env.TZ`，用完在 `finally` 里还原；不改变 Intl / 其它全局状态。
 */

import { it } from "vitest";

/** 覆盖「东八区 / UTC / 美东（有夏令时）」三种典型宿主，站点声明的 +0000/+0800/-0500 都能被区分 */
export const TIMEZONE_MATRIX = ["UTC", "Asia/Shanghai", "America/New_York"] as const;

/** 在指定时区下执行 fn（同步或异步），结束后还原原来的 TZ */
export async function runInTimezone<T>(timezone: string, fn: () => T | Promise<T>): Promise<T> {
  const previous = process.env.TZ;
  process.env.TZ = timezone;

  try {
    return await fn();
  } finally {
    if (typeof previous === "undefined") {
      delete process.env.TZ;
    } else {
      process.env.TZ = previous;
    }
  }
}

type TTestBody = (timezone: string) => void | Promise<void>;

/**
 * 注册「同一段断言在每个时区各跑一次」的用例。
 *
 * ```ts
 * itAcrossTimezones(TIMEZONE_MATRIX, "站点 +0000 的时间按站点时区换算", () => {
 *   expect(probe.run("2024-01-02 03:04:05", filters)).toBe(Date.parse("2024-01-02T03:04:05Z"));
 * });
 * ```
 *
 * body 会收到当前时区名，可用于自证（断言 `process.env.TZ` 与 `getTimezoneOffset()` 确实切换了）。
 *
 * 注意：不要用它包裹 `vi.useFakeTimers()` 之外的全局状态改动；`today` 相关的断言请自己固定 now。
 */
export function itAcrossTimezones(
  title: string,
  body: TTestBody,
  options: { timezones?: readonly string[]; timeout?: number } = {},
): void {
  const timezones = options.timezones ?? TIMEZONE_MATRIX;

  for (const timezone of timezones) {
    it(`${title} [TZ=${timezone}]`, () => runInTimezone(timezone, () => body(timezone)), options.timeout);
  }
}
