/**
 * 备份文件名「生成 / 保留策略过滤」一致性测试。
 *
 * 历史缺陷：生成用 `formatDate(..., "yyyyMMdd'T'HHmm")` → `PTD_backup_20261004T0215.zip`（13 位、含字面量 T），
 * 而保留策略的过滤正则写成 `/^PTD_backup_\d{16}\.zip$/`（16 位纯数字），两者永远不可能匹配，
 * 导致自动备份成功后一条历史都清理不掉、远端备份无限累积。
 *
 * 这里用「生成 → 必须匹配」的全量一致性断言把两侧锁在同一个格式定义上：
 * 任何一侧单独改动（格式串或匹配规则）都会让本用例失败。
 */
import { describe, expect, it } from "vitest";

import { getBackupFilename, isBackupFilename } from "@ptd/backupServer/utils.ts";

/** 覆盖跨月、跨年、闰日、月末、边界时间 */
const sampleDates = [
  new Date(2000, 0, 1, 0, 0),
  new Date(2000, 11, 31, 23, 59),
  new Date(2001, 1, 1, 0, 0),
  new Date(2024, 1, 29, 23, 59), // 闰日
  new Date(2026, 9, 4, 2, 15),
  new Date(2026, 9, 31, 23, 59), // 月末
  new Date(2026, 11, 31, 23, 59),
  new Date(2030, 0, 1, 0, 0),
];

describe("getBackupFilename：生成格式", () => {
  it("按 yyyyMMddTHHmm（本地时间）生成，含字面量 T", () => {
    expect(getBackupFilename(new Date(2026, 9, 4, 2, 15))).toBe("PTD_backup_20261004T0215.zip");
    expect(getBackupFilename(new Date(2000, 0, 1, 0, 0))).toBe("PTD_backup_20000101T0000.zip");
  });

  it("生成的文件名一定通过保留策略过滤", () => {
    for (const date of sampleDates) {
      const filename = getBackupFilename(date);
      expect(isBackupFilename(filename), `isBackupFilename(${filename})`).toBe(true);
    }
  });
});

describe("isBackupFilename：拒绝非本插件备份文件", () => {
  it("回归：缺陷报告中的实际文件名必须匹配（旧正则 \\d{16} 匹配不到）", () => {
    const filename = "PTD_backup_20261004T0215.zip";
    expect(/^PTD_backup_\d{16}\.zip$/.test(filename)).toBe(false); // 旧实现：永不匹配
    expect(isBackupFilename(filename)).toBe(true); // 新实现：严格按生成格式匹配
  });

  it("拒绝格式不符或非本插件生成的文件名（避免误删用户数据）", () => {
    const notBackupFilenames = [
      // 旧实现错误期望的「16 位纯数字」格式
      "PTD_backup_2026100402150000.zip",
      "PTD_backup_20261004T0215.zip.bak",
      "PTD_backup_20261004T0215", // 缺 .zip
      "PTD_backup_20261004T0215.zipx",
      "PTD_backup_20261004T0215.zip ",
      "PTD_backup_20261004T021.zip", // 分钟只有 1 位
      "PTD_backup_20261004T02155.zip", // 分钟多 1 位
      "PTD_backup_2026-10-04T02-15.zip", // 分隔符错误
      "PTD_backup_20261004t0215.zip", // 小写 t
      "PTD_backup_20261340T0261.zip", // 月份/分钟越界
      "PTD_backup_20260230T0215.zip", // 不存在的日期
      "PTD_backup_.zip", // 没有日期部分
      "backup_20261004T0215.zip", // 前缀不符
      "other.zip", // 与本插件无关
      "",
    ];

    for (const filename of notBackupFilenames) {
      expect(isBackupFilename(filename), `isBackupFilename(${filename})`).toBe(false);
    }
  });
});
