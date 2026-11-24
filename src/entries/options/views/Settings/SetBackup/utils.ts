import type { TBackupFields } from "@/shared/types.ts";
export { compareVersion, extractVersion } from "@/shared/updateCheck.ts";

type ErrorWithStatus = {
  message?: unknown;
  response?: {
    status?: unknown;
    statusText?: unknown;
  };
};

/**
 * H-2（OS-2）：未设置备份加密密钥时，**远端**备份被库侧 fail-closed 拒绝的敏感字段。
 *
 * 与 `src/entries/offscreen/utils/backup.ts` 的 `PLAINTEXT_UNSAFE_BACKUP_FIELDS` 保持同口径
 * （本地导出允许明文，不受这条限制）。UI 需要据此给出可操作指引，而不是只显示「备份失败」。
 */
export const PLAINTEXT_UNSAFE_BACKUP_FIELDS: TBackupFields[] = [
  "cookies",
  "metadata",
  "downloadHistory",
  "torrentFavorite",
  // 辅种任务 / 搜索快照里的种子下载链接可能带 passkey（与 backup.ts 的列表保持同步）
  "keepUploadTask",
  "searchResultSnapshot",
  // config 里含 config.socialSite.bangumi.apikey 等第三方凭据（与 backup.ts 的列表保持同步）
  "config",
];

/**
 * H-2：本次备份是否会因「无加密密钥 + 含敏感字段」被远端拒绝。
 *
 * 返回 true 时 UI 提示应附带可操作指引（去基础设置生成密钥 / 取消勾选敏感字段 / 改用导出到本地）。
 */
export function needsBackupEncryptionKeyHint(fields: readonly TBackupFields[], encryptionKey: unknown): boolean {
  const key = typeof encryptionKey === "string" ? encryptionKey.trim() : "";
  if (key.length > 0) return false;
  return fields.some((field) => PLAINTEXT_UNSAFE_BACKUP_FIELDS.includes(field));
}

/** H-2：把 exportBackupData 抛出的可读原因规范化（库侧抛出的 message 优先，其次兜底文案由调用方翻译） */
export function getBackupFailureReason(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  if (typeof error === "string" && error.trim()) return error.trim();
  const maybeError = error as ErrorWithStatus;
  if (typeof maybeError?.message === "string" && maybeError.message.trim()) return maybeError.message.trim();
  return "";
}

export function getBackupHistoryErrorReason(error: unknown): string {
  const maybeError = error as ErrorWithStatus;
  const status = maybeError?.response?.status;
  if (status === 401) {
    return "401 Unauthorized";
  }

  if (typeof maybeError?.message === "string" && maybeError.message) {
    return maybeError.message;
  }

  return String(error);
}
