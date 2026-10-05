import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { i18nInstance } from "@/options/plugins/i18n.ts";

const SOURCE_ROOTS = [
  resolve(import.meta.dirname, "../../../src/entries/options"),
  resolve(import.meta.dirname, "../../../src/entries/content-script/app"),
];

const LOCALES = ["zh_CN", "en"] as const;

function collectSourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) return collectSourceFiles(path);
    return /\.(ts|vue)$/.test(entry.name) ? [path] : [];
  });
}

const sourceText = SOURCE_ROOTS.flatMap(collectSourceFiles)
  .map((path) => readFileSync(path, "utf8"))
  .join("\n");

describe("组件提示文案的中英文一致性", () => {
  it("所有新增提示 key 在中英文运行时都能解析", () => {
    const keys = [
      "DownloadHistory.pollingError",
      "DownloadHistory.status.downloading",
      "DownloadHistory.status.pending",
      "DownloadHistory.status.completed",
      "DownloadHistory.status.failed",
      "KeepUploadTask.downloaderNotFound",
      "contentScript.confirmAction",
      "contentScript.inputSearchKeywords",
      "contentScript.emptySearchKeyword",
      "contentScript.localDownloadFailed",
      "contentScript.ignoredForeignLinks",
      "contentScript.untrustedTorrentLink",
      "contentScript.invalidDropData",
      "contentScript.unsupportedDropLinks",
      "SetDownloader.editor.bypassCSRF",
      "SetDownloader.editor.bypassCSRFHelp",
      "SetSearchSolution.import.invalidFile",
      "SetSearchSolution.import.success",
      "SetSearchSolution.import.skipped",
      "SetSearchSolution.import.missingSites",
      "SetSearchSolution.import.invalidJson",
      "SetSearchSolution.import.readFailed",
      "SetSearchSolution.import.noSolutions",
      "SearchEntity.searchSolutionNotFound",
      "SearchEntity.noSiteToSearch",
      "SearchEntity.noSearchPlanToRetry",
      "SentToDownloaderDialog.dynamicReplaceTitle",
      "SentToDownloaderDialog.dynamicReplaceCancelled",
      "SentToDownloaderDialog.sendFailed",
      "SentToDownloaderDialog.sendSummary",
      "SentToDownloaderDialog.noTasks",
      "MyData.UserDataTimeline.defaultTitle",
    ];

    const missing: string[] = [];
    for (const key of keys) {
      for (const locale of LOCALES) {
        const exists = i18nInstance.global.te(key, locale);
        const value = exists ? i18nInstance.global.t(key, {}, { locale }) : "";
        if (!exists || !value || value === key) {
          missing.push(`${locale}:${key}`);
        }
      }
    }

    expect(missing).toEqual([]);
  });

  it("组件源码不再包含已知的硬编码提示文案", () => {
    const forbiddenSnippets = [
      'placeholder="Search"',
      'help="移除请求的 Origin 头以绕过 qBittorrent',
      ">绕过 CSRF 保护<",
      'title: "下载中"',
      'title: "等待中"',
      'title: "已完成"',
      'title: "错误"',
      'title: "这些年走过的路"',
      'showSnakebar("',
      "showSnakebar(`",
      'confirmModal("',
      "confirmModal(`",
      'promptModal("',
      "promptModal(`",
    ];

    expect(forbiddenSnippets.filter((snippet) => sourceText.includes(snippet))).toEqual([]);
  });
});
