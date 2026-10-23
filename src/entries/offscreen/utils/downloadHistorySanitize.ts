/**
 * 下载历史的凭据脱敏（见审查报告 OS-1 / B1-4）。
 *
 * 单独成模块的原因：`download.ts` 与 `backup.ts` 都要用，而 `backup.ts` 的测试会把
 * `download.ts` 整体 mock 掉（避免拖入下载器依赖）；放在这里两边都能直接 import。
 */
import axios, { type AxiosRequestConfig } from "axios";
import type { CAddTorrentOptions } from "@ptd/downloader";
import type { ITorrentDownloadMetadata } from "@/shared/types.ts";

import { redactSensitiveUrls } from "./redact.ts";

/**
 * 剥离下载历史里的凭据字段。
 *
 * `CAddTorrentOptions.localDownloadOption` 是下载器「本地中转」时携带的 Axios 请求配置，
 * 里面的 url/headers 可能含站点 passkey/token；它只在下发下载器时用一次，没有长期保存的理由。
 */
export function sanitizeAddTorrentOptions(
  addTorrentOptions: Partial<CAddTorrentOptions> | undefined,
): Partial<CAddTorrentOptions> {
  if (!addTorrentOptions) {
    return {};
  }
  const { localDownloadOption: _localDownloadOption, ...rest } = addTorrentOptions as Partial<CAddTorrentOptions> & {
    localDownloadOption?: AxiosRequestConfig;
  };
  return rest;
}

/**
 * 把下载请求配置收敛成「可长期保存的调试摘要」。
 *
 * 原始配置的 url 常内嵌 passkey/token（M-Team genDlToken、yemapt ?token=、NexusPHP &passkey=），
 * headers 也可能带 Authorization/Cookie。UI 从未读取过该字段（只用于排障），因此只保留
 * `method + 脱敏后的完整 URL + timeout`，丢弃 baseURL/params/headers/data。
 */
export function buildRedactedDownloadRequestConfig(config: AxiosRequestConfig): AxiosRequestConfig {
  let safeUrl: string | undefined;
  try {
    safeUrl = redactSensitiveUrls(axios.getUri(config));
  } catch {
    safeUrl = typeof config.url === "string" ? redactSensitiveUrls(config.url) : undefined;
  }

  return {
    ...(typeof config.method === "string" ? { method: config.method } : {}),
    ...(safeUrl ? { url: safeUrl } : {}),
    ...(typeof config.timeout === "number" ? { timeout: config.timeout } : {}),
  };
}

/**
 * 备份导出前的兜底脱敏：旧版本落库的历史记录里 `downloadRequestConfig` 可能是完整的
 * url+headers，而备份 zip 会被上传到第三方存储；导出时统一收敛成脱敏摘要。
 */
export function sanitizeDownloadHistoryRecordForExport(record: ITorrentDownloadMetadata): ITorrentDownloadMetadata {
  const { downloadRequestConfig, addTorrentOptions, ...rest } = record;
  return {
    ...rest,
    ...(downloadRequestConfig
      ? { downloadRequestConfig: buildRedactedDownloadRequestConfig(downloadRequestConfig as AxiosRequestConfig) }
      : {}),
    addTorrentOptions: sanitizeAddTorrentOptions(addTorrentOptions),
  } as ITorrentDownloadMetadata;
}
