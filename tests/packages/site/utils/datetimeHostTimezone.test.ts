/**
 * 站点时间解析不得依赖运行主机的时区（H-2 及其夏令时边角）。
 *
 * 进程内无法切换时区，因此用不同的 TZ 启动子进程跑同一组输入，要求所有时区得到同一个真值。
 * 夏令时用例：纽约 2024-03-10 02:30 在本地不存在（02:00 → 03:00），旧实现会先按宿主时区 parse
 * 再 format 回字段，于是站点时间被挪 1 小时。
 */
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const probe = resolve(import.meta.dirname, "../../../fixtures/parseInZone.probe.mts");
const tsx = resolve(process.cwd(), "node_modules/.bin/tsx");

const cases: Array<[string, string[], string]> = [
  ["2024-03-01 10:00:00", [], "+0800"],
  ["01/03/2024 10:00", ["dd/MM/yyyy HH:mm"], "+0800"],
  ["10/03/2024 02:30", ["dd/MM/yyyy HH:mm"], "+0800"],
  ["Mar 10 2024, 02:30", ["MMM d yyyy, HH:mm"], "+0000"],
  ["2024-03-10 02:30:00 +02:00", ["yyyy-MM-dd HH:mm:ss XXX"], "+0800"],
];

const truth = [
  "2024-03-01T02:00:00.000Z",
  "2024-03-01T02:00:00.000Z",
  "2024-03-09T18:30:00.000Z",
  "2024-03-10T02:30:00.000Z",
  "2024-03-10T00:30:00.000Z",
];

function runIn(tz: string): string[] {
  const stdout = execFileSync(tsx, [probe, JSON.stringify(cases)], {
    env: { ...process.env, TZ: tz },
    encoding: "utf8",
  });
  return JSON.parse(stdout);
}

describe("parseValidTimeStringInZone 与宿主时区无关", () => {
  it.each(["UTC", "Asia/Shanghai", "America/New_York", "Europe/London"])(
    "TZ=%s",
    (tz) => {
      expect(runIn(tz)).toEqual(truth);
    },
    30_000,
  );
});
