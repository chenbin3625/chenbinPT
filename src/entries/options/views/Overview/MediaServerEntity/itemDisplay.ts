/**
 * 媒体库条目在卡片 / 详情弹窗上的展示文案（调研 A1–A6 / B7–B12）。
 *
 * 只做纯计算、不碰组件与 i18n，方便单测；需要本地化的部分由调用方传入已翻译的片段。
 */
import { formatBitrate, type IMediaServerItem } from "@ptd/mediaServer";

/** 卡片上的画质摘要（调研 A2）：分辨率 · 码率；没有结构化信息时回退到首个视频流标题 */
export function videoSummary(item: IMediaServerItem): string | undefined {
  const video = item.mediaInfo?.video;
  const parts = [video?.resolution, formatBitrate(video?.bitrate)].filter(Boolean) as string[];
  if (parts.length > 0) return parts.join(" · ");
  return item.streams?.filter((s) => s.type === "Video")[0]?.title;
}

/** 详情弹窗的画质摘要（调研 A2）：分辨率 · 编码(档次) · 色域 · 码率 · 帧率 */
export function videoDetailText(item: IMediaServerItem): string {
  const video = item.mediaInfo?.video;
  if (!video) return "";
  return [
    video.resolution,
    video.codec ? `${video.codec}${video.profile ? ` ${video.profile}` : ""}` : undefined,
    video.videoRange && !/^sdr$/i.test(video.videoRange) ? video.videoRange.toUpperCase() : undefined,
    formatBitrate(video.bitrate),
    video.frameRate ? `${video.frameRate} fps` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** 色域角标（调研 A2）：SDR 不显示，其余（HDR10 / DolbyVision…）透出原始值 */
export function videoRangeBadge(item: IMediaServerItem): string | undefined {
  const range = item.mediaInfo?.video?.videoRange;
  if (!range || /^sdr$/i.test(range)) return undefined;
  return range.toUpperCase();
}

/** 剧集编号（调研 B10）：S01E05（季号缺失时只给 E05） */
export function seriesText(item: IMediaServerItem): string | undefined {
  if (typeof item.indexNumber !== "number") return undefined;
  const season =
    typeof item.parentIndexNumber === "number" ? `S${String(item.parentIndexNumber).padStart(2, "0")}` : "";
  return `${season}E${String(item.indexNumber).padStart(2, "0")}`;
}

/** 音轨的一行描述：语言 · 编码 · 声道数 · 声道布局（全都缺失时回退到标题） */
export function audioText(audio: NonNullable<NonNullable<IMediaServerItem["mediaInfo"]>["audio"]>[number]): string {
  return (
    [audio.language, audio.codec, audio.channels ? `${audio.channels}ch` : undefined, audio.channelLayout]
      .filter(Boolean)
      .join(" · ") ||
    audio.title ||
    ""
  );
}

/** public/icons/social 下实际存在的 provider 图标（其余不显示图标） */
const SOCIAL_ICON_FILES: Record<string, string> = {
  imdb: "imdb",
  tmdb: "tmdb",
  themoviedb: "tmdb",
  tvdb: "tvdb",
  thetvdb: "tvdb",
  douban: "douban",
  bangumi: "bangumi",
  anidb: "anidb",
  tvmaze: "tvmaze",
  trakt: "trakt",
  metatube: "metatube",
};

/** provider 名 → 图标的 URL（没有对应图标时返回 undefined） */
export function socialIcon(name?: string): string | undefined {
  const key = (name ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const file = SOCIAL_ICON_FILES[key];
  return file ? `/icons/social/${file}.png` : undefined;
}

/** 剧集类条目（各家写法不一：Emby/Jellyfin 的 Series / Season / Episode，Plex 的 show / season / episode） */
const TV_LIKE_TYPES = new Set(["series", "show", "season", "episode"]);

/**
 * 调研 B7：用外部标识（imdb / tmdb）拼站点搜索的高级关键词。
 *
 * TMDb 的裸数字 id 分不出电影还是剧集（social/entity/tmdb.ts 的 idMatch 要求 `movie/123` / `tv/123`），
 * 所以这里按条目类型补上媒体类型前缀；已经带前缀的（如服务器给了 movie/123）保持原样。
 */
export function getSiteSearchKeyword(item: IMediaServerItem, field: "imdb" | "tmdb"): string | undefined {
  const value = item.providerIds?.[field];
  if (!value) return undefined;

  const isTvLike = TV_LIKE_TYPES.has((item.type ?? "").toLowerCase());
  const searchValue = field === "tmdb" && !value.includes("/") ? `${isTvLike ? "tv" : "movie"}/${value}` : value;
  return `${field}|${searchValue}`;
}
