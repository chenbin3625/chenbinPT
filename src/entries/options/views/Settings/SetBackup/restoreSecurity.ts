import type { IBackupData } from "@ptd/backupServer";

import type { IRestoreOptions, TBackupFields } from "@/shared/types.ts";

/**
 * S-1：恢复备份的安全面分析。
 *
 * 背景：恢复备份时不校验内容，一份他人分享的备份 zip 可以植入指向攻击者 WebDAV / S3 / Gist 的
 * `metadata.backupServers` 记录；随后自动备份会按**被恢复进来的** `backupFields` 把站点 passkey、
 * Cookie、下载器凭据自动上传到攻击者端点。
 *
 * UI 这一环的职责是「让用户看见并显式决定」：本模块把「备份里有哪些备份服务器、本次会恢复哪些敏感
 * 字段、多少个服务器配置不会被恢复」算成一份摘要，供 RestoreDialog 展示警示与开关状态。
 * 解析侧（packages/backupServer/utils.ts）与写入侧（offscreen/utils/backup.ts）的校验由各自的改动负责。
 */
/** 会被恢复的字段中属于「敏感」的那些：含凭据、cookies 或站点/下载器配置 */
export const SENSITIVE_BACKUP_FIELDS: TBackupFields[] = ["cookies", "config", "metadata", "userInfo"];

/** 备份服务器配置的简要信息（只取展示所需字段，避免把凭据带进 UI 摘要） */
export interface IBackupServerBrief {
  id?: string;
  type?: string;
  name?: string;
}

export interface IRestoreSecuritySummary {
  /** 备份中的备份服务器配置 */
  backupServers: IBackupServerBrief[];
  /** 备份是否包含备份服务器配置 */
  hasBackupServers: boolean;
  /** 备份中备份服务器配置的展示名（形如 `名称 (type)`） */
  backupServerLabels: string;
  /** 本次将要恢复的敏感字段 */
  sensitiveFields: TBackupFields[];
  /** 是否需要展示安全警示区块 */
  showSecurityWarning: boolean;
  /** 未勾选「同时恢复备份服务器配置」时，将不被恢复的服务器配置数量 */
  skippedBackupServerCount: number;
}

export function analyzeRestoreSecurity(
  backupData: IBackupData | undefined,
  restoreOptions: IRestoreOptions,
): IRestoreSecuritySummary {
  const servers = (backupData?.metadata?.backupServers ?? {}) as Record<string, IBackupServerBrief>;
  const backupServers = Object.values(servers);

  const sensitiveFields = SENSITIVE_BACKUP_FIELDS.filter((field) => restoreOptions.fields?.includes(field));

  return {
    backupServers,
    hasBackupServers: backupServers.length > 0,
    backupServerLabels: backupServers
      .map((server) => `${server.name || server.id || "?"} (${server.type ?? "?"})`)
      .join(", "),
    sensitiveFields,
    showSecurityWarning: backupServers.length > 0 || sensitiveFields.length > 0,
    // 勾选后才恢复；未勾选时向用户明示「这 N 个不会被恢复」，而不是静默丢弃
    skippedBackupServerCount: restoreOptions.restoreBackupServers ? 0 : backupServers.length,
  };
}

/**
 * offscreen 侧 `restoreBackupData` 的返回报告（结构对齐 `offscreen/utils/backup.ts` 的 `IRestoreReport`）。
 *
 * 该类型目前定义在 offscreen 入口内，UI 直接引用会跨入口并带入 chrome API；
 * 待 `messages.ts` 的返回类型由 boolean 改为共享的报告类型后，这里可直接改用共享定义。
 */
export interface IRestoreReportLike {
  success?: boolean;
  restored?: string[];
  /** 被跳过的字段及原因 */
  skipped?: Array<{ field?: string; reason?: string }>;
  /** 被安全化处理的说明 */
  sanitized?: string[];
  /** 写入中途失败时是否已回滚 */
  rolledBack?: boolean;
}

export interface IRestoreResultSummary {
  /** 恢复是否整体成功（false 表示写入失败，可能已回滚） */
  success: boolean;
  /** 需要如实告知用户的明细（被跳过 / 被安全化的内容） */
  notices: string[];
}

/**
 * S-1：把恢复结果翻译成 UI 可展示的摘要。
 *
 * 兼容两种返回值：旧实现的 boolean（`true` / `undefined` 视为成功）与安全化改造后的报告对象。
 * 拿不到明细时返回空 notices，调用方退回原本的「恢复成功」提示。
 */
export function summarizeRestoreResult(result: unknown): IRestoreResultSummary {
  if (typeof result !== "object" || result === null) {
    return { success: result !== false, notices: [] };
  }

  const report = result as IRestoreReportLike;
  const notices = [
    ...(report.skipped ?? []).map((item) => [item?.field, item?.reason].filter(Boolean).join(": ")),
    ...(report.sanitized ?? []),
  ].filter((notice) => notice.length > 0);

  return { success: report.success !== false, notices };
}
