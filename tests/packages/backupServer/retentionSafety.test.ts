/**
 * 复检 P2（数据破坏优先）：保留策略不能因为「时间无法解析」而误删备份。
 *
 * 场景：S3 等后端返回的 `LastModified` 解析失败时 `time` 为 NaN；NaN 不满足任何
 * `file.time > keepAfter` / 窗口匹配 / 数量前 N 条件，旧实现会把它判成「过期」进入删除候选，
 * 而它很可能正是用户唯一的历史备份。
 */
import { describe, expect, it } from "vitest";

import { macMatches, pruneBackupFiles } from "@ptd/backupServer/utils.ts";
import type { IBackupFileInfo, IBackupRetention } from "@ptd/backupServer/type";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

function file(name: string, time: number): IBackupFileInfo {
  return { filename: name, path: name, time, size: 1 } as IBackupFileInfo;
}

describe("pruneBackupFiles：时间不可解析的备份一律保留", () => {
  it("NaN 时间不会被当成过期删除（按时间期限策略）", () => {
    const files = [file("new.zip", NOW - DAY), file("bad.zip", Number.NaN), file("old.zip", NOW - 400 * DAY)];
    const retention: IBackupRetention = { time: { enabled: true, maxAge: 30 } };

    const [deleted, kept] = pruneBackupFiles(files, retention, NOW);

    expect(deleted.map((item) => item.filename)).toEqual(["old.zip"]);
    expect(kept.map((item) => item.filename).sort()).toEqual(["bad.zip", "new.zip"]);
  });

  it("NaN 时间不会被当成过期删除（按数量策略）", () => {
    const files = [
      file("new.zip", NOW - DAY),
      file("bad.zip", Number.NaN),
      file("mid.zip", NOW - 2 * DAY),
      file("old.zip", NOW - 3 * DAY),
    ];
    const retention: IBackupRetention = { count: { enabled: true, maxCount: 2 } };

    const [deleted, kept] = pruneBackupFiles(files, retention, NOW);

    // 数量策略只应删掉最新的 2 份之外的旧备份；NaN 那份必须被保留
    expect(kept.map((item) => item.filename)).toContain("bad.zip");
    expect(deleted.map((item) => item.filename).sort()).toEqual(["mid.zip", "old.zip"]);
  });

  it("全部时间合法时行为不变（期限内的保留，过期的删除）", () => {
    const files = [file("new.zip", NOW - DAY), file("old.zip", NOW - 40 * DAY)];
    const [deleted, kept] = pruneBackupFiles(files, { time: { enabled: true, maxAge: 30 } }, NOW);

    expect(deleted.map((item) => item.filename)).toEqual(["old.zip"]);
    expect(kept.map((item) => item.filename)).toEqual(["new.zip"]);
  });

  it("未配置有效策略时不删除任何备份", () => {
    const files = [file("a.zip", NOW), file("bad.zip", Number.NaN)];
    const [deleted, kept] = pruneBackupFiles(files, {}, NOW);
    expect(deleted).toEqual([]);
    expect(kept).toHaveLength(2);
  });
});

/**
 * 复检 P2（E）：MAC 比较必须常量时间且拒绝非法形状（CookieCloud integrity 也复用此函数）。
 */
describe("macMatches", () => {
  const mac = "a".repeat(64);

  it("相同 MAC 返回 true", () => {
    expect(macMatches(mac, mac)).toBe(true);
  });

  it("不同 MAC / 长度或字符集非法时返回 false", () => {
    expect(macMatches("b".repeat(64), mac)).toBe(false);
    expect(macMatches(mac, "a".repeat(63))).toBe(false);
    expect(macMatches(mac, "A".repeat(64))).toBe(false);
    expect(macMatches(mac, "")).toBe(false);
  });
});
