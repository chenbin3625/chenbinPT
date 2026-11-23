/**
 * DOWNLOADER-8（第三轮收尾）：搜索页「发送到下载器」的汇总必须把「成功但设置未生效」单独提示。
 *
 * 背景：offscreen 在下载器实体返回 `success` + `message` 时（如 uTorrent 直发 http(s) 链接拿不到
 * infoHash，暂停 / 标签 / 上传限速被跳过）会写 `warningMessage`，但
 * `SentToDownloaderDialog/utils.ts` 的汇总此前只统计 pending / failed，把这个降级成功当普通成功，
 * 用户只看到绿色的「成功发送 N 个任务」而不知道设置没生效。
 *
 * 本文件直接调用真实的 `sendTorrentToDownloader()`，断言真实汇总文案与颜色：
 * - 成功 + warningMessage：文案必须带 `SentToDownloaderDialog.sendSummaryWarning` 段落，颜色 warning；
 * - 阴性对照：普通成功（无 warningMessage）仍是 success、无告警段落（判别力：warningCount 恒为 0
 *   时第一条用例变红，第二条不受影响）；
 * - 部分失败：走 warning 色并带 `sendSummaryFailed` 段落，失败项自带的 `warningMessage` 不计入告警段落；
 * - 全部失败（F0125）：走 error 色并展示失败详情，不再退回 warning / noTasks。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMessageMock = vi.hoisted(() => vi.fn());
const runtimeStore = vi.hoisted(() => ({
  search: { searchKey: "", searchPlanKey: "" },
  showSnackbar: vi.fn(),
}));
const metadataStore = vi.hoisted(() => ({
  getSearchSolutionName: vi.fn(() => "default"),
  getSiteName: vi.fn(() => "testsite"),
}));

vi.mock("@/messages.ts", () => ({ sendMessage: sendMessageMock, onMessage: vi.fn() }));
vi.mock("@/options/stores/runtime.ts", () => ({ useRuntimeStore: () => runtimeStore }));
vi.mock("@/options/stores/metadata.ts", () => ({ useMetadataStore: () => metadataStore }));

const WARNING = "uTorrent add-url 未返回 infoHash，添加后暂停 / 标签 / 上传限速设置未生效";

/** 触发一次批量推送（按序返回每个任务的 mock 结果），返回汇总 snackbar 的 [文案, 选项] */
async function sendBatch(results: Record<string, any>[]) {
  let index = 0;
  sendMessageMock.mockImplementation(async () => results[index++]);
  const { sendTorrentToDownloader } = await import("@/options/components/SentToDownloaderDialog/utils.ts");
  await sendTorrentToDownloader(
    results.map((_, i) => ({ title: `t${i + 1}` }) as any),
    "downloader-1" as any,
    { savePath: "", label: "" } as any,
    vi.fn(),
  );

  expect(runtimeStore.showSnackbar).toHaveBeenCalledTimes(1);
  return runtimeStore.showSnackbar.mock.calls[0] as [string, { color: string }];
}

/** 触发一次单任务推送，返回汇总 snackbar 的 [文案, 选项] */
async function sendOne(result: Record<string, any>) {
  return sendBatch([result]);
}

/** 当前 locale（默认 zh_CN）下 `sendSummaryWarning` 的实际文案，避免测试里硬编码译文 */
async function warningText(count: number) {
  const { i18nInstance } = await import("@/options/plugins/i18n.ts");
  return i18nInstance.global.t("SentToDownloaderDialog.sendSummaryWarning", { count });
}

beforeEach(() => {
  sendMessageMock.mockReset();
  runtimeStore.showSnackbar.mockReset();
});

describe("DOWNLOADER-8：搜索页推送汇总必须暴露「成功但设置未生效」", () => {
  it("成功 + warningMessage：汇总包含告警段落且颜色为 warning", async () => {
    const expectedWarning = await warningText(1);

    const [content, options] = await sendOne({
      downloadId: 1,
      downloadStatus: "completed",
      warningMessage: WARNING,
    });

    // 判别力：删掉 warningCount 统计后，这里两个断言都会变红（颜色回落 success、文案丢段落）
    expect(content, "降级成功必须单独提示「设置未生效」，否则用户以为设置生效了").toContain(expectedWarning);
    expect(options.color, "存在降级成功时不能用 success 绿").toBe("warning");
    // 仍要保留原有成功段落，不能把普通成功也一起吞掉
    const { i18nInstance } = await import("@/options/plugins/i18n.ts");
    expect(content).toContain(
      i18nInstance.global.t("SentToDownloaderDialog.sendSummary", { success: 1, pending: "", failed: "" }),
    );
  });

  it("阴性对照：普通成功（无 warningMessage）仍是 success 且没有告警段落", async () => {
    const expectedWarning = await warningText(1);

    const [content, options] = await sendOne({ downloadId: 1, downloadStatus: "completed" });

    expect(options.color).toBe("success");
    expect(content).not.toContain(expectedWarning);
  });

  it("部分失败走 warning 色与失败段落，且失败项上的 warningMessage 不计入告警段落", async () => {
    const expectedWarning = await warningText(1);
    const { i18nInstance } = await import("@/options/plugins/i18n.ts");
    const expectedFailed = i18nInstance.global.t("SentToDownloaderDialog.sendSummaryFailed", { count: 1 });

    // 包含 1 条成功 + 1 条带 warningMessage 的失败，确保进入汇总格式化分支并验证 failed 不计入 warningCount
    const [content, options] = await sendBatch([
      { downloadId: 1, downloadStatus: "completed" },
      { downloadId: 0, downloadStatus: "failed", warningMessage: WARNING },
    ]);

    expect(options.color).toBe("warning");
    expect(content).toContain(expectedFailed);
    expect(content).not.toContain(expectedWarning);
  });

  it("全部失败时走 error 色并展示失败详情，不再退回 warning / noTasks", async () => {
    const expectedWarning = await warningText(1);
    const { i18nInstance } = await import("@/options/plugins/i18n.ts");
    const expectedError = i18nInstance.global.t("SentToDownloaderDialog.sendFailed", {
      title: "t1",
      error: "network error",
    });

    const [content, options] = await sendOne({
      downloadId: 0,
      downloadStatus: "failed",
      errorMessage: "network error",
      warningMessage: WARNING,
    });

    expect(options.color).toBe("error");
    expect(content).toBe(expectedError);
    expect(content).not.toContain(expectedWarning);
    expect(content).not.toContain(i18nInstance.global.t("SentToDownloaderDialog.noTasks"));
  });
});
