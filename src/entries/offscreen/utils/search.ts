import { uniqBy } from "es-toolkit";
import { getMediaServer } from "@ptd/mediaServer";
import {
  normalizeTorrentPromotion,
  normalizedTorrentTagMap,
  sortTorrentTags,
  type TPattern,
  type TPatterns,
} from "@ptd/site";

import { onMessage, sendMessage } from "@/messages.ts";
import type { IMetadataPiniaStorageSchema, TSearchResultSnapshotStorageSchema } from "@/shared/types.ts";

import { logger } from "./logger.ts";
import { getSiteInstance, runSiteOperation } from "./site.ts";

/** 把站点定义里的 pattern（string | RegExp）预编译成正则，避免逐行 eval（见 docs/performance-audit.md P1 搜索热路径） */
function compilePatterns(patterns: TPatterns): RegExp[] {
  return patterns
    .map((pattern) => {
      try {
        if (pattern instanceof RegExp) {
          // 去掉 g/y 标志：带 lastIndex 的正则复用会漏匹配（原实现对 RegExp pattern 会 new 一个新实例）
          return new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ""));
        }
        if (typeof pattern !== "string" || pattern.length === 0) {
          return undefined;
        }
        return new RegExp(pattern, "i");
      } catch {
        return undefined;
      }
    })
    .filter((pattern): pattern is RegExp => !!pattern);
}

onMessage(
  "getSiteSearchResult",
  async ({ data: { siteId, keyword = "", searchEntry = {}, autoDetectOfficialGroupFromTitle } }) => {
    // 只取一个开关，避免整份 config 跨上下文往返
    const autoDetectEnabled =
      typeof autoDetectOfficialGroupFromTitle === "boolean"
        ? autoDetectOfficialGroupFromTitle
        : ((await sendMessage("getExtStoragePath", {
            key: "config",
            path: "searchEntity.autoDetectOfficialGroupFromTitle",
            defaultValue: false,
          })) as boolean);

    logger({
      msg: `getSiteSearchResult For site: ${siteId} with keyword: ${keyword}`,
      data: { siteId, keyword },
    });
    const site = await getSiteInstance<"public">(siteId);

    // OS-5：站点实例已按 siteId 缓存复用；搜索会重置实例内的行级解析状态
    // （`_searchRowFailures` / `_rowElementQueryCache`），同一站点的并发搜索必须串行，
    // 否则两个请求会互相重置计数，导致「全部行解析失败」的判据失效/误报。
    let searchResult = await runSiteOperation(siteId, () => site.getSearchResult(keyword, searchEntry));

    if (searchResult.data.length > 0) {
      let officialGroupPatterns: RegExp[] = [];
      if (autoDetectEnabled && site.metadata.officialGroupPattern?.length) {
        officialGroupPatterns = compilePatterns(site.metadata.officialGroupPattern);
      }

      searchResult.data = searchResult.data.map((item) => {
        item.tags ??= [];

        if (officialGroupPatterns.length > 0 && item.title) {
          if (officialGroupPatterns.some((pattern) => pattern.test(item.title))) {
            item.tags.push({ name: "官方" });
          }
        }

        // 让种子同时具备 factor 与 tag 两种优惠表示（factor 优先；仅 tags 时反推 factor）。
        // 这里也兜住了不经过 parseWholeTorrentFromRow 的 JSON API schema（如 GazelleJSONAPI 直接构造 ITorrent）。
        normalizeTorrentPromotion(item);

        // 尽可能将 tags 转换预定义的部分，去重并排序
        item.tags = sortTorrentTags(
          uniqBy(
            item.tags.map((tag) => {
              for (const normalizedTorrentTag of normalizedTorrentTagMap) {
                if (normalizedTorrentTag.from.test(tag.name)) {
                  return normalizedTorrentTag.to;
                }
              }
              return tag;
            }),
            (tag) => tag.name,
          ),
        );
        return item;
      });
    }

    return searchResult;
  },
);

onMessage("getMediaServerSearchResult", async ({ data: { mediaServerId, keywords = "", options = {} } }) => {
  logger({
    msg: `getMediaServerSearchResult For mediaServer: ${mediaServerId} with: ${keywords}`,
  });
  const mediaServerConfig = await sendMessage("getExtStoragePath", {
    key: "metadata",
    path: ["mediaServers", mediaServerId],
    defaultValue: {},
  });
  const mediaServer = await getMediaServer(mediaServerConfig as IMetadataPiniaStorageSchema["mediaServers"][string]);
  return await mediaServer.getSearchResult(keywords ?? "", options);
});

async function getMediaServerById(mediaServerId: string) {
  const mediaServerConfig = await sendMessage("getExtStoragePath", {
    key: "metadata",
    path: ["mediaServers", mediaServerId],
    defaultValue: {},
  });
  return await getMediaServer(mediaServerConfig as IMetadataPiniaStorageSchema["mediaServers"][string]);
}

// 调研 B12：详情弹窗按需拉取单条目的完整信息（列表只带轻量字段，避免 /Items 响应过大）
onMessage("getMediaServerItemDetail", async ({ data: { mediaServerId, itemId } }) => {
  logger({
    msg: `getMediaServerItemDetail For mediaServer: ${mediaServerId} with itemId: ${itemId}`,
  });
  const mediaServer = await getMediaServerById(mediaServerId);
  return (await mediaServer.getItemDetail(itemId)) ?? null;
});

// 调研 C14 / C20：按需生成媒体库概览 —— 整库遍历与聚合都在这里做，只把统计结果回传 UI
onMessage("getMediaServerOverview", async ({ data: { mediaServerId, maxItems } }) => {
  logger({
    msg: `getMediaServerOverview For mediaServer: ${mediaServerId}`,
    data: { maxItems },
  });
  const mediaServer = await getMediaServerById(mediaServerId);
  return (await mediaServer.getLibraryOverview({ maxItems })) ?? null;
});

type TSanitizedMediaMatch = {
  serverName: string;
  serverType: string;
  itemName: string;
  year?: string | number;
  played?: boolean;
  videoQuality?: string;
};

const SOCIAL_MEDIA_CHECK_CACHE_TTL = 2 * 60 * 1000;
const socialMediaCheckCache = new Map<string, { at: number; matches: TSanitizedMediaMatch[] }>();

function normalizeSocialTitle(raw: string | undefined): string {
  return String(raw ?? "")
    .toLowerCase()
    .replace(/[\s:：·\-—_,.!?'"()（）[\]【】/\\]+/g, "")
    .trim();
}

onMessage("checkMediaServerBySocialInfo", async ({ data }) => {
  const title = typeof data?.title === "string" ? data.title.trim() : "";
  const altTitles = Array.isArray(data?.altTitles)
    ? data.altTitles.filter((t): t is string => typeof t === "string" && t.trim().length > 0).map((t) => t.trim())
    : [];
  const imdbId = typeof data?.imdbId === "string" ? data.imdbId.trim().toLowerCase() : "";
  const doubanId = typeof data?.doubanId === "string" ? data.doubanId.trim() : "";
  const targetYear = data?.year ? Number(String(data.year).slice(0, 4)) : undefined;

  const queryKeywords = uniqBy([title, ...altTitles].filter(Boolean), (k) => k.toLowerCase()).slice(0, 2);
  if (queryKeywords.length === 0 && !imdbId) {
    return [];
  }

  const cacheKey = JSON.stringify({ queryKeywords, imdbId, doubanId, targetYear });
  const cached = socialMediaCheckCache.get(cacheKey);
  if (cached && Date.now() - cached.at < SOCIAL_MEDIA_CHECK_CACHE_TTL) {
    return cached.matches;
  }

  const mediaServers =
    ((await sendMessage("getExtStoragePath", {
      key: "metadata",
      path: ["mediaServers"],
      defaultValue: {},
    })) as IMetadataPiniaStorageSchema["mediaServers"]) ?? {};

  const enabledServers = Object.values(mediaServers).filter((s) => s?.enabled && s?.id);
  if (enabledServers.length === 0) {
    return [];
  }

  const targetTitles = new Set([title, ...altTitles].map(normalizeSocialTitle).filter((t) => t.length >= 2));
  const matches: TSanitizedMediaMatch[] = [];

  await Promise.allSettled(
    enabledServers.map(async (serverConfig) => {
      try {
        const instance = await getMediaServer(serverConfig);
        for (const keyword of queryKeywords) {
          const result = await instance.getSearchResult(keyword, { limit: 12 });
          const items = Array.isArray(result?.items) ? result.items : [];
          for (const item of items) {
            const providerEntries = Object.entries(item.providerIds ?? {});
            const itemImdb = String(providerEntries.find(([k]) => k.toLowerCase() === "imdb")?.[1] ?? "")
              .trim()
              .toLowerCase();
            const itemDouban = String(providerEntries.find(([k]) => k.toLowerCase() === "douban")?.[1] ?? "").trim();
            const normItemName = normalizeSocialTitle(item.name);
            const rawOriginalTitle = item.raw as { OriginalTitle?: string; originalTitle?: string } | undefined;
            const normOrigName = normalizeSocialTitle(
              rawOriginalTitle?.OriginalTitle || rawOriginalTitle?.originalTitle,
            );

            const idMatched = (imdbId !== "" && itemImdb === imdbId) || (doubanId !== "" && itemDouban === doubanId);
            const titleMatched =
              targetTitles.has(normItemName) || (normOrigName.length >= 2 && targetTitles.has(normOrigName));
            const itemYear = item.productionYear ? Number(String(item.productionYear).slice(0, 4)) : undefined;
            const yearCompatible =
              !targetYear ||
              !itemYear ||
              !Number.isFinite(targetYear) ||
              !Number.isFinite(itemYear) ||
              Math.abs(targetYear - itemYear) <= 1;

            if (idMatched || (titleMatched && yearCompatible)) {
              const videoQuality =
                item.mediaInfo?.video?.resolution || item.streams?.find((s) => s.type === "Video")?.title || undefined;
              // 严格脱敏：绝不向内容脚本回传服务器 URL、API Key、内部 itemId 或用户 Token
              matches.push({
                serverName: serverConfig.name || serverConfig.type,
                serverType: serverConfig.type,
                itemName: item.name,
                year: item.productionYear,
                played: item.user?.IsPlayed,
                videoQuality: typeof videoQuality === "string" ? videoQuality.slice(0, 40) : undefined,
              });
              break;
            }
          }
          if (matches.some((m) => m.serverName === (serverConfig.name || serverConfig.type))) {
            break;
          }
        }
      } catch {
        // 单个媒体服务器不可达不影响其它服务器
      }
    }),
  );

  const deduped = uniqBy(matches, (m) => `${m.serverName}|${m.itemName}`);
  socialMediaCheckCache.set(cacheKey, { at: Date.now(), matches: deduped });
  return deduped;
});

/**
 * 搜索快照按 snapshotId 独立读写（见 docs/performance-audit.md P1-4）：
 * 早期实现每次保存/删除都要整份读取并写回 Record<snapshotId, ISearchData>，
 * 第 N 次保存需重新序列化前 N-1 份快照（O(N²) 写入）。
 */
onMessage("getSearchResultSnapshotData", async ({ data: snapshotId }) => {
  const snapshot = (await sendMessage("getExtStoragePath", {
    key: "searchResultSnapshot",
    path: [snapshotId],
    defaultValue: undefined,
  })) as TSearchResultSnapshotStorageSchema[string] | undefined;
  // 显式 null：undefined 经消息序列化也会变成 null，但类型契约必须如实反映。
  return snapshot ?? null;
});

onMessage("saveSearchResultSnapshotData", async ({ data: { snapshotId, data } }) => {
  logger({ msg: `A new SearchResult Snapshot will be add at: ${snapshotId}` });
  await sendMessage("patchExtStoragePath", {
    key: "searchResultSnapshot",
    path: [snapshotId],
    value: data,
  });
});

onMessage("removeSearchResultSnapshotData", async ({ data: snapshotId }) => {
  await sendMessage("patchExtStoragePath", {
    key: "searchResultSnapshot",
    path: [snapshotId],
    remove: true,
  });
  logger({ msg: `SearchResult Snapshot ${snapshotId} is removed.` });
});
