/**
 * 辅种任务「发送到下载器」的结果汇总（N11）。
 *
 * 发送循环需要逐项收集结果：某一项失败不能中止后续项，且 `downloadStatus === "pending"`
 * （站点下载间隔未到、后台会排程重发）既不是成功也不是失败，必须单独计数。
 * 抽成纯函数便于回归测试，UI 只负责把汇总翻成提示。
 */
export type TKeepUploadSendOutcome =
  { status: "success"; warningMessage?: string } | { status: "pending" } | { status: "failed"; reason: string };

export interface CKeepUploadSendSummary {
  succeeded: number;
  failed: number;
  pending: number;
  /** 推送成功但下载器设置未全部生效（DOWNLOADER-8 的 warningMessage） */
  warned: number;
  firstFailureReason?: string;
  firstWarningMessage?: string;
}

export function summarizeKeepUploadSendOutcomes(outcomes: readonly TKeepUploadSendOutcome[]): CKeepUploadSendSummary {
  let succeeded = 0;
  let failed = 0;
  let pending = 0;
  let warned = 0;
  let firstFailureReason: string | undefined;
  let firstWarningMessage: string | undefined;

  for (const outcome of outcomes) {
    if (outcome.status === "success") {
      succeeded++;
      if (outcome.warningMessage) {
        warned++;
        firstWarningMessage ||= outcome.warningMessage;
      }
    } else if (outcome.status === "pending") {
      pending++;
    } else {
      failed++;
      firstFailureReason ||= outcome.reason;
    }
  }

  return { succeeded, failed, pending, warned, firstFailureReason, firstWarningMessage };
}
