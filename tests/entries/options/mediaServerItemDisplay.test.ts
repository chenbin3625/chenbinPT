/**
 * 上游 765480dd 在媒体库卡片 / 详情弹窗 / 媒体库概览里新增的展示逻辑与文案（antd 重写版）。
 *
 * - itemDisplay.ts：画质摘要、色域角标、剧集编号、音轨描述、站点搜索关键词
 * - 新增的 i18n key 在两个语言包里都要解析出真实文案（漏加时 vue-i18n 会原样返回 key）
 */
import { describe, expect, it } from "vitest";
import { createI18n } from "vue-i18n";

import en from "~/locales/en.json";
import zh_CN from "~/locales/zh_CN.json";

import {
  audioText,
  getSiteSearchKeyword,
  seriesText,
  socialIcon,
  videoDetailText,
  videoRangeBadge,
  videoSummary,
} from "@/options/views/Overview/MediaServerEntity/itemDisplay.ts";

const item = (overrides: Record<string, unknown> = {}) =>
  ({ server: "m", name: "x", url: "", user: {}, raw: {}, ...overrides }) as any;

describe("媒体库条目展示文案", () => {
  it("卡片画质摘要：分辨率 · 码率；缺结构化信息时回退到首个视频流标题", () => {
    expect(videoSummary(item({ mediaInfo: { video: { resolution: "1080p", bitrate: 8_200_000 } } }))).toBe(
      "1080p · 8.2 Mbps",
    );
    expect(videoSummary(item({ streams: [{ type: "Video", title: "1080p H264", format: "h264" }] }))).toBe(
      "1080p H264",
    );
    expect(videoSummary(item())).toBeUndefined();
  });

  it("详情画质：编码带档次，SDR 不显示", () => {
    const video = { resolution: "4K", codec: "hevc", profile: "Main 10", videoRange: "SDR", frameRate: 23.976 };
    expect(videoDetailText(item({ mediaInfo: { video } }))).toBe("4K · hevc Main 10 · 23.976 fps");
    expect(videoDetailText(item({ mediaInfo: { video: { ...video, videoRange: "hdr10" } } }))).toContain("HDR10");
    expect(videoDetailText(item())).toBe("");
  });

  it("色域角标与剧集编号", () => {
    expect(videoRangeBadge(item({ mediaInfo: { video: { videoRange: "DolbyVision" } } }))).toBe("DOLBYVISION");
    expect(videoRangeBadge(item({ mediaInfo: { video: { videoRange: "sdr" } } }))).toBeUndefined();
    expect(seriesText(item({ indexNumber: 5, parentIndexNumber: 1 }))).toBe("S01E05");
    expect(seriesText(item({ indexNumber: 12 }))).toBe("E12");
    expect(seriesText(item())).toBeUndefined();
  });

  it("音轨描述：信息全缺时回退到标题", () => {
    expect(audioText({ language: "eng", codec: "truehd", channels: 8, channelLayout: "7.1" })).toBe(
      "eng · truehd · 8ch · 7.1",
    );
    expect(audioText({ title: "Track 1" })).toBe("Track 1");
  });

  it("站点搜索关键词：TMDb 裸 id 按条目类型补 movie/ 或 tv/ 前缀（含 Plex 的首字母大写类型）", () => {
    const providerIds = { imdb: "tt1", tmdb: "42" };
    expect(getSiteSearchKeyword(item({ type: "Movie", providerIds }), "imdb")).toBe("imdb|tt1");
    expect(getSiteSearchKeyword(item({ type: "Movie", providerIds }), "tmdb")).toBe("tmdb|movie/42");
    expect(getSiteSearchKeyword(item({ type: "Series", providerIds }), "tmdb")).toBe("tmdb|tv/42");
    expect(getSiteSearchKeyword(item({ type: "Show", providerIds }), "tmdb")).toBe("tmdb|tv/42");
    expect(getSiteSearchKeyword(item({ type: "Movie", providerIds: { tmdb: "tv/7" } }), "tmdb")).toBe("tmdb|tv/7");
    expect(getSiteSearchKeyword(item({ providerIds: {} }), "imdb")).toBeUndefined();
  });

  it("外部链接图标只认 public/icons/social 下实际存在的文件", () => {
    expect(socialIcon("TheMovieDb")).toBe("/icons/social/tmdb.png");
    expect(socialIcon("Trakt")).toBe("/icons/social/trakt.png");
    expect(socialIcon("Wikipedia")).toBeUndefined();
  });
});

const REQUIRED_KEYS = [
  "MediaServerEntity.versions",
  "MediaServerEntity.embedded",
  "MediaServerEntity.external",
  "MediaServerEntity.ItemInformationDialog.searchOnSite",
  "MediaServerEntity.ItemInformationDialog.people",
  "MediaServerEntity.ItemInformationDialog.loadingDetail",
  "MediaServerEntity.ItemInformationDialog.mediaInfo",
  "SetMediaServer.Index.status",
  "SetMediaServer.Index.refreshStatus",
  "SetMediaServer.Overview.title",
  "SetMediaServer.Overview.warningConfirm",
  "SetMediaServer.Overview.byResolution",
  "SetMediaServer.Overview.byRootPath",
  "SetMediaServer.Overview.totalItems",
  "SetMediaServer.Overview.playsPerGb",
];

for (const [locale, messages] of [
  ["zh_CN", zh_CN],
  ["en", en],
] as const) {
  describe(`${locale} 语言包：媒体库信息增强`, () => {
    const i18n = createI18n({
      legacy: false,
      locale,
      fallbackLocale: locale,
      messages: { [locale]: messages },
      missingWarn: false,
      fallbackWarn: false,
    });

    it.each(REQUIRED_KEYS)("%s 解析出真实文案（不是 key 本身）", (key) => {
      expect(i18n.global.t(key)).not.toBe(key);
    });

    it("带计数的文案能插值", () => {
      expect(i18n.global.t("MediaServerEntity.versions", { count: 3 })).toContain("3");
      expect(i18n.global.t("SetMediaServer.Overview.truncated", { count: 20000 })).toContain("20000");
    });

    it("概览风险提示如实说明：关闭弹窗不会中止已开始的后台遍历", () => {
      expect(i18n.global.t("SetMediaServer.Overview.warningLine3")).not.toMatch(/停止后续请求|stops further requests/);
    });
  });
}
