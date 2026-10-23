/**
 * L2（F1 遗留）：MyClient 批量汇总改用专用文案 + 实体 false 契约。
 *
 * 背景：F1 在语言包里新增了 `MyClient.batch.partialFailure` 但零引用，F4 仍在用
 * `SentToDownloaderDialog.sendSummaryFailed` 拼「发送失败」这种语义不符的文案。
 * 这里直接断言汇总函数产出的提示使用新 key。
 *
 * 同时锁定 `summarizeBatchResults` 的失败判据：实体契约是 `Promise<boolean>`，但 Deluge 的
 * `pause_torrent` / `force_recheck` 等上游 RPC 没有返回值，实体按原样透传 `null`（C1 DE-1）；
 * 因此只有 **`false` / reject** 算失败，`null` / `undefined` 仍算成功。
 */
import { describe, expect, it } from "vitest";

// helper 会补 Vite 构建期常量（__BROWSER__ 等），必须先于 MyClient/utils.ts（→ messages.ts）求值
import { prepareOptionsPinia } from "../../helpers/optionsView.ts";

const { i18nInstance } = await import("@/options/plugins/i18n.ts");
const t = i18nInstance.global.t;

prepareOptionsPinia();
const { formatBatchOpMessage, summarizeBatchResults } = await import("@/options/views/Overview/MyClient/utils.ts");

describe("L2：MyClient 批量汇总文案", () => {
  it("部分失败时使用 MyClient.batch.partialFailure 专用文案，并保留首个可读原因", () => {
    const summary = summarizeBatchResults([
      { status: "fulfilled", value: true },
      { status: "fulfilled", value: true },
      { status: "rejected", reason: new Error("network down") },
    ]);
    expect(summary).toMatchObject({ total: 3, succeeded: 2, failed: 1, firstFailureReason: "network down" });

    const message = formatBatchOpMessage(t, "MyClient.action.pauseSelectedSuccess", summary);
    expect(message).toContain(t("MyClient.batch.partialFailure"));
    expect(message).toContain("network down");
    // 旧实现借用的「发送到下载器」文案不应再出现在批量操作提示里
    expect(message).not.toContain(t("SentToDownloaderDialog.sendSummaryFailed", { count: 1 }));
  });

  it("实体契约：只有 false / reject 算失败，null / undefined（Deluge RPC 无返回值）算成功", () => {
    const summary = summarizeBatchResults([
      { status: "fulfilled", value: null },
      { status: "fulfilled", value: undefined },
      { status: "fulfilled", value: false },
      { status: "rejected", reason: "boom" },
    ]);
    expect(summary.succeeded).toBe(2);
    expect(summary.failed).toBe(2);
  });
});
