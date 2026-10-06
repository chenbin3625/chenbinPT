type ErrorWithStatus = {
  message?: unknown;
  response?: {
    status?: unknown;
    statusText?: unknown;
  };
};

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
