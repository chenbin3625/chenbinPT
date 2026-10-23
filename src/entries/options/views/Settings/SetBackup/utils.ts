import type { TBackupFields } from "@/shared/types.ts";

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
export const PLAINTEXT_UNSAFE_BACKUP_FIELDS: TBackupFields[] = ["cookies", "metadata", "downloadHistory"];

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

/**
 * 从版本串里取出数字版本：兼容现行的三段版本（`v0.0.10+d8d0628`）与旧的四段版本（`v0.0.7.1962+abc`）。
 *
 * M-14：原正则 `/v(\d+\.\d+\.\d+\.\d+)/` 只认四段，版本号改为三段后恒返回 null，
 * compareVersion 随之恒为 null —— 「用旧版扩展恢复新版备份」的警示从此永远不弹。
 */
export function extractVersion(str: string = ""): string | null {
  const match = str.match(/v?(\d+(?:\.\d+){2,3})/);
  return match ? match[1] : null;
}

/**
 * 比较两个版本号字符串：inputV1 < inputV2 返回 -1，相等返回 0，大于返回 1；任一无法解析返回 null。
 * 段数不同时缺失段按 0 处理（`0.0.7.1962` > `0.0.7`，`0.0.8` > `0.0.7.1962`）。
 */
export function compareVersion(inputV1?: string, inputV2?: string): -1 | 0 | 1 | null {
  const v1 = extractVersion(inputV1);
  const v2 = extractVersion(inputV2);
  if (!v1 || !v2) return null;

  const parts1 = v1.split(".").map(Number);
  const parts2 = v2.split(".").map(Number);
  for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
    const num1 = parts1[i] || 0;
    const num2 = parts2[i] || 0;
    if (num1 > num2) return 1;
    if (num1 < num2) return -1;
  }
  return 0;
}
