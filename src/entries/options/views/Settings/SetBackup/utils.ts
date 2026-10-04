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
