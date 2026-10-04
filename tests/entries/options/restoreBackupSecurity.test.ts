/**
 * S-1：备份恢复安全链的 UI 一环（SetBackup/RestoreDialog.vue）。
 *
 * 一份他人分享的备份 zip 可以植入指向攻击者 WebDAV / S3 / Gist 的 `metadata.backupServers`，
 * 随后自动备份会把本机凭据上传到攻击者端点。UI 必须：
 * 1. 备份含 backupServers / 本次将恢复敏感字段时展示显著警示；
 * 2. 恢复备份服务器配置的开关默认关闭，并且未勾选时明确告知将不恢复多少个；
 * 3. 不把该开关透传成 true；
 * 4. 恢复结果按实际情况提示，而不是笼统的「恢复成功」。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { analyzeRestoreSecurity, summarizeRestoreResult } from "@/options/views/Settings/SetBackup/restoreSecurity.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const readSource = (path: string) => readFileSync(resolve(repoRoot, path), "utf8");

const RESTORE_DIALOG = "src/entries/options/views/Settings/SetBackup/RestoreDialog.vue";

/** 含备份服务器配置的样例备份（模拟他人分享的、被植入的备份） */
const backupWithServers = {
  manifest: { version: "chenbinPT (v1.0.0.0)", files: { metadata: 1, cookies: 1, config: 1, userInfo: 1 } },
  metadata: {
    backupServers: {
      evil1: { id: "evil1", type: "webdav", name: "my-webdav", config: { address: "https://attacker.example/dav" } },
      evil2: { id: "evil2", type: "s3", name: "my-s3", config: { endpoint: "https://attacker.example" } },
    },
  },
};

/** 不含备份服务器配置的普通备份 */
const backupWithoutServers = {
  manifest: { version: "chenbinPT (v1.0.0.0)", files: { cookies: 1 } },
  cookies: {},
};

const optionsOf = (files: string[], restoreBackupServers = false) =>
  ({ fields: files, expandCookieMinutes: 0, keepExistUserInfo: true, restoreBackupServers }) as any;

describe("S-1：含 backupServers 的备份", () => {
  it("展示安全警示，并列出备份中的备份服务器配置", () => {
    const summary = analyzeRestoreSecurity(backupWithServers as any, optionsOf(["metadata", "cookies"]));

    expect(summary.showSecurityWarning).toBe(true);
    expect(summary.hasBackupServers).toBe(true);
    expect(summary.backupServers).toHaveLength(2);
    expect(summary.backupServerLabels).toBe("my-webdav (webdav), my-s3 (s3)");
    expect(summary.sensitiveFields).toEqual(["cookies", "metadata"]);
  });

  it("开关默认关闭：未勾选时提示将不恢复其中的 N 个服务器配置", () => {
    const summary = analyzeRestoreSecurity(backupWithServers as any, optionsOf(["metadata"]));

    expect(summary.skippedBackupServerCount).toBe(2);
  });

  it("勾选后才恢复，且勾选会通过 restoreOptions 原样传递给 offscreen", () => {
    const checked = analyzeRestoreSecurity(backupWithServers as any, optionsOf(["metadata"], true));
    expect(checked.skippedBackupServerCount).toBe(0);

    const source = readSource(RESTORE_DIALOG);
    expect(source).toMatch(/restoreOptions: restoreOptions\.value/); // 未勾选时该字段为 false，不会透传成 true
  });
});

describe("S-1：不含 backupServers 的普通备份", () => {
  it("只恢复非敏感字段（下载历史等）时完全不出警示，流程与改动前一致", () => {
    const summary = analyzeRestoreSecurity(
      { manifest: { version: "chenbinPT (v1.0.0.0)", files: { downloadHistory: 1 } }, downloadHistory: [] } as any,
      optionsOf(["downloadHistory"]),
    );

    expect(summary.hasBackupServers).toBe(false);
    expect(summary.backupServers).toHaveLength(0);
    expect(summary.skippedBackupServerCount).toBe(0);
    expect(summary.sensitiveFields).toEqual([]);
    expect(summary.showSecurityWarning).toBe(false);
    // 未勾选开关时必须原样传 false（不会被透传成 true）
    expect(optionsOf(["downloadHistory"]).restoreBackupServers).toBe(false);
  });

  it("备份里没有服务器配置时，警示只来自「本次将恢复敏感字段」，不含服务器配置那一行", () => {
    const summary = analyzeRestoreSecurity(backupWithoutServers as any, optionsOf(["cookies", "metadata"]));

    expect(summary.hasBackupServers).toBe(false);
    expect(summary.sensitiveFields).toEqual(["cookies", "metadata"]);
    expect(summary.showSecurityWarning).toBe(true);
    expect(summary.skippedBackupServerCount).toBe(0);
  });
});

describe("S-1：RestoreDialog 的接线", () => {
  const source = readSource(RESTORE_DIALOG);

  it("默认 restoreBackupServers 为 false，且每次解析出新备份都重置为 false", () => {
    expect(source).toMatch(/restoreBackupServers: false/);
    expect(source.match(/restoreBackupServers: false/g)?.length).toBeGreaterThanOrEqual(2); // 初始值 + buildBackupOptions
  });

  it("警示区块、开关与「将不恢复」提示都绑定了 analyzeRestoreSecurity 的结果", () => {
    expect(source).toContain('import { analyzeRestoreSecurity, summarizeRestoreResult } from "./restoreSecurity.ts"');
    expect(source).toMatch(/restoreSecurity\.showSecurityWarning/);
    expect(source).toMatch(/v-model:checked="restoreOptions\.restoreBackupServers"/);
    expect(source).toMatch(/restoreSecurity\.skippedBackupServerCount/);
    expect(source).toMatch(/SetBackup\.RestoreDialog\.willNotRestoreBackupServers/);
  });

  it("恢复结果不再是笼统的「恢复成功」：false / 报告对象都有对应提示", () => {
    expect(source).toMatch(/function reportRestoreResult/);
    expect(source).toMatch(/SetBackup\.RestoreDialog\.partialFailure/);
    expect(source).toMatch(/SetBackup\.RestoreDialog\.successWithNotice/);
    expect(source).toMatch(/reportRestoreResult\(result\)/);
  });

  it("解析阶段被丢弃的条目会展示给用户", () => {
    expect(source).toMatch(/getBackupWarnings/);
    expect(source).toMatch(/backupParseWarnings/);
    expect(source).toMatch(/securityWarning\.parseWarnings/);
  });

  it("本地文件与远程服务器两条路径、既有恢复选项保持可用", () => {
    expect(source).toMatch(/restoreMetadata\.type === "file"/);
    expect(source).toMatch(/restoreMetadata\.type === "remote"/);
    expect(source).toMatch(/v-model:checked="restoreOptions\.keepExistUserInfo"/);
    expect(source).toMatch(/v-model:value="restoreOptions\.expandCookieMinutes"/);
    expect(source).toMatch(/showDecryptKey/);
    expect(source).toMatch(/isDecryptKeyValid/);
  });
});

describe("S-1：恢复结果报告的翻译", () => {
  it("旧实现的 boolean 返回值：true / undefined 成功，false 失败且无明细", () => {
    expect(summarizeRestoreResult(true)).toEqual({ success: true, notices: [] });
    expect(summarizeRestoreResult(undefined)).toEqual({ success: true, notices: [] });
    expect(summarizeRestoreResult(false)).toEqual({ success: false, notices: [] });
  });

  it("报告对象：列出被跳过与被安全化的内容；success=false 时按失败处理", () => {
    const summary = summarizeRestoreResult({
      success: true,
      restored: ["config", "cookies"],
      skipped: [{ field: "downloadHistory", reason: "invalid data in backup, local history kept" }],
      sanitized: ['backupServers["evil1"]: 已丢弃（未勾选恢复备份服务器配置）'],
      rolledBack: false,
    });

    expect(summary.success).toBe(true);
    expect(summary.notices).toEqual([
      "downloadHistory: invalid data in backup, local history kept",
      'backupServers["evil1"]: 已丢弃（未勾选恢复备份服务器配置）',
    ]);

    expect(summarizeRestoreResult({ success: false, rolledBack: true }).success).toBe(false);
  });
});
