import { ref, shallowRef } from "vue";
import { CTorrentState, type CTorrent } from "@ptd/downloader";
import type { IMediaServerItem } from "@ptd/mediaServer";
import type { IDownloaderMetadata, IMediaServerMetadata, ISearchResultTorrent } from "@/shared/types.ts";
import { sendMessage } from "@/messages.ts";

export interface IMediaCrossCheckHit {
  serverId: string;
  serverName: string;
  serverType: string;
  item: IMediaServerItem;
  videoQuality?: string;
  normNames: string[];
  imdbId?: string;
  doubanId?: string;
}

export interface IDownloaderCrossCheckBadge {
  state: "seeding" | "downloading" | "paused";
  clientName: string;
}

export function normalizeCrossCheckText(raw: string | undefined): string {
  return String(raw ?? "")
    .toLowerCase()
    .replace(/[\s:：·\-—_,.!?'"()（）[\]【】/\\]+/g, "")
    .trim();
}

export function extractVideoQualityLabel(item: IMediaServerItem): string | undefined {
  if (item.mediaInfo?.video?.resolution) {
    return item.mediaInfo.video.resolution;
  }
  const videoStream = item.streams?.find((s) => s.type === "Video");
  const candidate = videoStream?.title || item.name;
  if (!candidate) return undefined;
  if (/2160p|4k|uhd/i.test(candidate)) return "4K";
  if (/1080p/i.test(candidate)) return "1080p";
  if (/720p/i.test(candidate)) return "720p";
  return videoStream?.title?.slice(0, 16) || undefined;
}

export const mediaCrossCheckLoading = ref(false);
export const mediaCrossCheckHits = shallowRef<IMediaCrossCheckHit[]>([]);

let mediaCheckSeq = 0;

function extractMediaQueryFromSearchKey(searchKey: string): string {
  const trimmed = searchKey.trim();
  if (!trimmed) return "";
  // 去掉 imdb|tt12345 / douban|12345 等前缀，如果是纯 ID 则不适合直接当标题查媒体库（除非媒体库支持）
  if (/^(imdb|douban|tmdb|bangumi|anidb|tvmaze)\|/i.test(trimmed)) {
    return trimmed.replace(/^(imdb|douban|tmdb|bangumi|anidb|tvmaze)\|/i, "").trim();
  }
  return trimmed;
}

export async function runMediaServerCrossCheck(
  searchKey: string,
  enabledServers: ReadonlyArray<IMediaServerMetadata>,
): Promise<void> {
  const seq = ++mediaCheckSeq;
  const query = extractMediaQueryFromSearchKey(searchKey);
  if (!query || enabledServers.length === 0) {
    mediaCrossCheckHits.value = [];
    mediaCrossCheckLoading.value = false;
    return;
  }

  mediaCrossCheckLoading.value = true;
  try {
    const collected: IMediaCrossCheckHit[] = [];
    await Promise.allSettled(
      enabledServers.map(async (server) => {
        try {
          const result = await sendMessage("getMediaServerSearchResult", {
            mediaServerId: server.id,
            keywords: query,
            options: { limit: 10 },
          });
          for (const item of result?.items ?? []) {
            const rawMeta = item.raw as { OriginalTitle?: string; originalTitle?: string } | undefined;
            const origTitle = rawMeta?.OriginalTitle || rawMeta?.originalTitle;
            const normNames = [normalizeCrossCheckText(item.name), normalizeCrossCheckText(origTitle)].filter(
              (n) => n.length >= 2,
            );
            const providerEntries = Object.entries(item.providerIds ?? {});
            const imdbVal = providerEntries.find(([k]) => k.toLowerCase() === "imdb")?.[1];
            const doubanVal = providerEntries.find(([k]) => k.toLowerCase() === "douban")?.[1];
            collected.push({
              serverId: server.id,
              serverName: server.name || server.type,
              serverType: server.type,
              item,
              videoQuality: extractVideoQualityLabel(item),
              normNames,
              imdbId: imdbVal ? String(imdbVal).trim().toLowerCase() : undefined,
              doubanId: doubanVal ? String(doubanVal).trim() : undefined,
            });
          }
        } catch {
          // 单个媒体服务器查询失败不影响搜索体验
        }
      }),
    );

    if (seq !== mediaCheckSeq) return;
    mediaCrossCheckHits.value = collected;
  } finally {
    if (seq === mediaCheckSeq) {
      mediaCrossCheckLoading.value = false;
    }
  }
}

export function clearMediaServerCrossCheck(): void {
  mediaCheckSeq += 1;
  mediaCrossCheckHits.value = [];
  mediaCrossCheckLoading.value = false;
}

export function matchTorrentWithMediaHits(
  torrent: ISearchResultTorrent,
  hits: ReadonlyArray<IMediaCrossCheckHit>,
): IMediaCrossCheckHit | null {
  if (hits.length === 0) return null;
  const torrentImdb = torrent.ext_imdb ? String(torrent.ext_imdb).trim().toLowerCase() : "";
  const torrentDouban = torrent.ext_douban ? String(torrent.ext_douban).trim() : "";
  const normTitle = normalizeCrossCheckText(`${torrent.title ?? ""} ${torrent.subTitle ?? ""}`);

  for (const hit of hits) {
    if (torrentImdb && hit.imdbId && torrentImdb === hit.imdbId) {
      return hit;
    }
    if (torrentDouban && hit.doubanId && torrentDouban === hit.doubanId) {
      return hit;
    }
    if (normTitle && hit.normNames.some((n) => n.length >= 3 && normTitle.includes(n))) {
      return hit;
    }
  }
  return null;
}

// ─── 下载器查重（60s TTL 缓存） ───

interface IClientTorrentEntry {
  infoHash: string;
  normName: string;
  size: number;
  state: CTorrentState;
  clientName: string;
}

const CLIENT_CROSS_CHECK_TTL = 60_000;
let clientCrossCheckFetchedAt = 0;
let clientCrossCheckInFlight: Promise<void> | null = null;

export const downloaderCrossCheckVersion = ref(0);
const byInfoHash = new Map<string, IClientTorrentEntry>();
const byNormName = new Map<string, IClientTorrentEntry[]>();

export async function runDownloaderCrossCheck(
  enabledDownloaders: ReadonlyArray<IDownloaderMetadata>,
  force = false,
): Promise<void> {
  if (enabledDownloaders.length === 0) {
    byInfoHash.clear();
    byNormName.clear();
    downloaderCrossCheckVersion.value += 1;
    return;
  }
  const now = Date.now();
  if (!force && clientCrossCheckFetchedAt > 0 && now - clientCrossCheckFetchedAt < CLIENT_CROSS_CHECK_TTL) {
    return;
  }
  if (clientCrossCheckInFlight) {
    return await clientCrossCheckInFlight;
  }

  clientCrossCheckInFlight = (async () => {
    const nextByHash = new Map<string, IClientTorrentEntry>();
    const nextByName = new Map<string, IClientTorrentEntry[]>();

    await Promise.allSettled(
      enabledDownloaders.map(async (downloader) => {
        try {
          const list: CTorrent[] = await sendMessage("getClientTorrents", downloader.id);
          for (const t of list) {
            const entry: IClientTorrentEntry = {
              infoHash: String(t.infoHash ?? "")
                .trim()
                .toLowerCase(),
              normName: normalizeCrossCheckText(t.name),
              size: t.totalSize ?? 0,
              state: t.state,
              clientName: downloader.name || downloader.id,
            };
            if (entry.infoHash) {
              nextByHash.set(entry.infoHash, entry);
            }
            if (entry.normName) {
              const bucket = nextByName.get(entry.normName) ?? [];
              bucket.push(entry);
              nextByName.set(entry.normName, bucket);
            }
          }
        } catch {
          // 忽略不可达下载器
        }
      }),
    );

    byInfoHash.clear();
    for (const [k, v] of nextByHash) byInfoHash.set(k, v);
    byNormName.clear();
    for (const [k, v] of nextByName) byNormName.set(k, v);

    clientCrossCheckFetchedAt = Date.now();
    downloaderCrossCheckVersion.value += 1;
  })().finally(() => {
    clientCrossCheckInFlight = null;
  });

  await clientCrossCheckInFlight;
}

function mapClientStateBadge(entry: IClientTorrentEntry): IDownloaderCrossCheckBadge {
  if (entry.state === CTorrentState.seeding) {
    return { state: "seeding", clientName: entry.clientName };
  }
  if (
    entry.state === CTorrentState.downloading ||
    entry.state === CTorrentState.checking ||
    entry.state === CTorrentState.queued
  ) {
    return { state: "downloading", clientName: entry.clientName };
  }
  return { state: "paused", clientName: entry.clientName };
}

export function matchTorrentWithDownloaders(torrent: ISearchResultTorrent): IDownloaderCrossCheckBadge | null {
  const hash = String(torrent.infoHash ?? "")
    .trim()
    .toLowerCase();
  if (hash && byInfoHash.has(hash)) {
    return mapClientStateBadge(byInfoHash.get(hash)!);
  }

  const normTitle = normalizeCrossCheckText(torrent.title);
  if (!normTitle) return null;
  const candidates = byNormName.get(normTitle);
  if (!candidates || candidates.length === 0) return null;

  const tSize = typeof torrent.size === "number" && Number.isFinite(torrent.size) ? torrent.size : 0;
  for (const candidate of candidates) {
    if (tSize > 0 && candidate.size > 0) {
      const tolerance = Math.max(10 * 1024 * 1024, tSize * 0.05);
      if (Math.abs(candidate.size - tSize) > tolerance) continue;
    }
    return mapClientStateBadge(candidate);
  }
  return null;
}
