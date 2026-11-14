/**
 * 下载历史凭据脱敏（OS-1 / B1-4）单元测试。
 *
 * 覆盖三个公开函数：
 * - `sanitizeAddTorrentOptions`：落库前剥离一次性 `localDownloadOption`；
 * - `buildRedactedDownloadRequestConfig`：把请求配置收敛成「method + 脱敏 URL + timeout」；
 * - `sanitizeDownloadHistoryRecordForExport`：备份导出前对旧记录做兜底脱敏。
 *
 * 断言只看行为（返回值 / 入参是否被改写），不依赖实现细节。
 */
import type { AxiosRequestConfig } from "axios";
import { describe, expect, it } from "vitest";

import type { ITorrentDownloadMetadata } from "@/shared/types.ts";
import {
  buildRedactedDownloadRequestConfig,
  sanitizeAddTorrentOptions,
  sanitizeDownloadHistoryRecordForExport,
} from "@/offscreen/utils/downloadHistorySanitize.ts";

function makeRecord(overrides: Partial<ITorrentDownloadMetadata> = {}): ITorrentDownloadMetadata {
  return {
    id: 1,
    siteId: "site-a",
    torrentId: 42,
    downloaderId: "local",
    downloadAt: 1700000000000,
    downloadStatus: "completed",
    title: "Example Torrent",
    subTitle: "Example Sub Title",
    url: "https://site.example/details.php?id=42",
    link: "https://site.example/download.php?id=42&passkey=SECRET",
    torrent: {
      site: "site-a",
      id: 42,
      title: "Example Torrent",
      subTitle: "Example Sub Title",
      url: "https://site.example/details.php?id=42",
      link: "https://site.example/download.php?id=42&passkey=SECRET",
    },
    addTorrentOptions: { savePath: "/downloads", label: "ptd" },
    ...overrides,
  };
}

const SAMPLE_ADD_TORRENT_OPTIONS = {
  savePath: "/downloads",
  label: "ptd",
  addAtPaused: true,
  localDownloadOption: {
    url: "https://site.example/download.php?passkey=SECRET",
    headers: { Authorization: "Bearer SECRET" },
  },
} satisfies Parameters<typeof sanitizeAddTorrentOptions>[0];

describe("sanitizeAddTorrentOptions", () => {
  it("undefined 返回空对象", () => {
    expect(sanitizeAddTorrentOptions(undefined)).toEqual({});
  });

  it("剥离 localDownloadOption，保留其余字段", () => {
    const result = sanitizeAddTorrentOptions(SAMPLE_ADD_TORRENT_OPTIONS);

    expect(result).toEqual({ savePath: "/downloads", label: "ptd", addAtPaused: true });
    expect(result).not.toHaveProperty("localDownloadOption");
  });

  it("只有 localDownloadOption 时返回空对象", () => {
    expect(sanitizeAddTorrentOptions({ localDownloadOption: { url: "https://site.example/dl?token=SECRET" } })).toEqual(
      {},
    );
  });

  it("不修改入参对象（含嵌套的 localDownloadOption）", () => {
    const input = structuredClone(SAMPLE_ADD_TORRENT_OPTIONS);
    const snapshot = structuredClone(input);

    sanitizeAddTorrentOptions(input);

    expect(input).toEqual(snapshot);
  });
});

describe("buildRedactedDownloadRequestConfig", () => {
  it("保留 method/url/timeout，丢弃 baseURL/params/headers/data", () => {
    const config: AxiosRequestConfig = {
      baseURL: "https://site.example/api",
      url: "/download.php?id=42",
      params: { passkey: "deadbeef", token: "abc" },
      method: "GET",
      timeout: 30000,
      headers: { Authorization: "Bearer SECRET" },
      data: { password: "SECRET" },
    };

    const result = buildRedactedDownloadRequestConfig(config);

    expect(result).toEqual({
      method: "GET",
      url: "https://site.example/api/download.php?id=***&passkey=***&token=***",
      timeout: 30000,
    });
    expect(result).not.toHaveProperty("baseURL");
    expect(result).not.toHaveProperty("params");
    expect(result).not.toHaveProperty("headers");
    expect(result).not.toHaveProperty("data");
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });

  it("脱敏 url 中的 query 值，保留键名与 path", () => {
    const result = buildRedactedDownloadRequestConfig({
      url: "https://site.example/dl?token=SECRET&passkey=deadbeef&id=7",
    });

    expect(result).toEqual({ url: "https://site.example/dl?token=***&passkey=***&id=***" });
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });

  it("脱敏 fragment 中的 k=v 值（#access_token=…）", () => {
    const result = buildRedactedDownloadRequestConfig({
      method: "get",
      url: "https://site.example/callback#access_token=SECRET&token_type=bearer",
    });

    expect(result).toEqual({
      method: "get",
      url: "https://site.example/callback#access_token=***&token_type=***",
    });
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });

  it("脱敏 userinfo 凭据并保留 host", () => {
    const result = buildRedactedDownloadRequestConfig({
      url: "https://alice:s3cr3t@site.example/dl?token=SECRET",
    });

    expect(result).toEqual({ url: "https://***@site.example/dl?token=***" });
    expect(JSON.stringify(result)).not.toContain("s3cr3t");
  });

  it("脱敏路径里的凭据段（32 位 passkey）", () => {
    const result = buildRedactedDownloadRequestConfig({
      url: "https://r.example/api/v1/torrents/download/123/0a1b2c3d4e5f60718293a4b5c6d7e8f9",
    });

    expect(result).toEqual({
      url: "https://r.example/api/v1/torrents/download/123/***",
    });
    expect(JSON.stringify(result)).not.toContain("0a1b2c3d4e5f60718293a4b5c6d7e8f9");
  });

  it("通过 axios.getUri 组合 baseURL+url+params 后再脱敏", () => {
    const result = buildRedactedDownloadRequestConfig({
      baseURL: "https://site.example/api",
      url: "/torrents/download",
      params: { id: 42, passkey: "deadbeef" },
      method: "post",
      timeout: 1000,
    });

    expect(result).toEqual({
      method: "post",
      url: "https://site.example/api/torrents/download?id=***&passkey=***",
      timeout: 1000,
    });
  });

  it("getUri 抛错时回退到脱敏后的 config.url，不向调用方抛异常", () => {
    const config: AxiosRequestConfig = {
      method: "get",
      url: "https://site.example/dl?token=SECRET&passkey=deadbeef",
      params: { page: 1 },
      paramsSerializer: {
        serialize: () => {
          throw new Error("invalid config");
        },
      },
      timeout: 5000,
    };

    expect(() => buildRedactedDownloadRequestConfig(config)).not.toThrow();

    const result = buildRedactedDownloadRequestConfig(config);
    expect(result).toEqual({
      method: "get",
      url: "https://site.example/dl?token=***&passkey=***",
      timeout: 5000,
    });
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });

  it("没有 method/timeout 时不生成对应字段", () => {
    expect(buildRedactedDownloadRequestConfig({ url: "https://site.example/dl?token=SECRET" })).toEqual({
      url: "https://site.example/dl?token=***",
    });
  });
});

describe("sanitizeDownloadHistoryRecordForExport", () => {
  it("保留普通字段", () => {
    const record = makeRecord({
      addTorrentResult: { success: true, id: "torrent-1" },
      errorMessage: "some error",
      warningMessage: "some warning",
    });

    const result = sanitizeDownloadHistoryRecordForExport(record);

    expect(result).toMatchObject({
      id: record.id,
      siteId: record.siteId,
      torrentId: record.torrentId,
      downloaderId: record.downloaderId,
      downloadAt: record.downloadAt,
      downloadStatus: record.downloadStatus,
      title: record.title,
      subTitle: record.subTitle,
      url: record.url,
      link: record.link,
      torrent: record.torrent,
      addTorrentResult: record.addTorrentResult,
      errorMessage: record.errorMessage,
      warningMessage: record.warningMessage,
    });
  });

  it("downloadRequestConfig 被收敛成脱敏摘要", () => {
    const record = makeRecord({
      downloadRequestConfig: {
        baseURL: "https://site.example/api",
        url: "/download.php?id=42",
        params: { passkey: "deadbeef" },
        method: "GET",
        timeout: 30000,
        headers: { Authorization: "Bearer SECRET" },
        data: { password: "SECRET" },
      },
    });

    const result = sanitizeDownloadHistoryRecordForExport(record);

    expect(result.downloadRequestConfig).toEqual({
      method: "GET",
      url: "https://site.example/api/download.php?id=***&passkey=***",
      timeout: 30000,
    });
    const serializedConfig = JSON.stringify(result.downloadRequestConfig);
    expect(serializedConfig).not.toContain("deadbeef");
    expect(serializedConfig).not.toContain("Bearer SECRET");
  });

  it("addTorrentOptions 被剥离 localDownloadOption，保留其余字段", () => {
    const record = makeRecord({ addTorrentOptions: SAMPLE_ADD_TORRENT_OPTIONS });

    const result = sanitizeDownloadHistoryRecordForExport(record);

    expect(result.addTorrentOptions).toEqual({ savePath: "/downloads", label: "ptd", addAtPaused: true });
    expect(result.addTorrentOptions).not.toHaveProperty("localDownloadOption");
  });

  it("没有 downloadRequestConfig 时不生成该字段；没有 addTorrentOptions 时收敛为空对象", () => {
    const record = makeRecord({ addTorrentOptions: undefined });

    const result = sanitizeDownloadHistoryRecordForExport(record);

    expect(result).not.toHaveProperty("downloadRequestConfig");
    expect(result.addTorrentOptions).toEqual({});
  });

  it("不修改原记录（downloadRequestConfig 与 addTorrentOptions 保持原样）", () => {
    const record = makeRecord({
      addTorrentOptions: SAMPLE_ADD_TORRENT_OPTIONS,
      downloadRequestConfig: {
        url: "https://site.example/dl?token=SECRET",
        headers: { Authorization: "Bearer SECRET" },
      },
    });
    const snapshot = structuredClone(record);

    sanitizeDownloadHistoryRecordForExport(record);

    expect(record).toEqual(snapshot);
  });
});
