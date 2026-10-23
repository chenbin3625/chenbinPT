import axios from "axios";
import PQueue from "p-queue";
import { getSocialRecommendations } from "@ptd/social";
import type { ISocialRecommendationItem } from "@ptd/social";

import { onMessage } from "@/messages.ts";
import { setupReplaceUnsafeHeader } from "~/extends/axios/replaceUnsafeHeader.ts";
import { logger } from "./logger.ts";
import { getSocialInformation } from "./socialInformation.ts";

const posterAxios = setupReplaceUnsafeHeader(axios.create());
// S-3：海报请求是第三方数据驱动的跨站请求，实例级也固定不携带凭据（含 Cookie）。
if (posterAxios.defaults) {
  posterAxios.defaults.withCredentials = false;
}

type TRecommendationEnrichmentMode = "all" | "none" | "visible";

interface IGetSocialRecommendationsMessageOptions {
  flush?: boolean;
  enrichment?: TRecommendationEnrichmentMode;
}

const RECOMMENDATION_ENRICHMENT_CONCURRENCY = 8;
const VISIBLE_RECOMMENDATION_CATEGORY_LIMIT = 5;
const POSTER_CANDIDATE_LIMIT = 8;
const VISIBLE_POSTER_CANDIDATE_LIMIT = 2;
const POSTER_CACHE_LIMIT = 100;
const POSTER_FETCH_TIMEOUT = 3e3;
const VISIBLE_POSTER_FETCH_TIMEOUT = 800;
const posterDataUrlCache = new Map<string, string>();

/**
 * 海报抓取的主机白名单（见 OS-6）。
 *
 * `item.poster` / `socialInformation.poster` 来自第三方页面数据（ld+json、豆瓣/TMDB/IMDb 等），
 * 而扩展拥有 `<all_urls>` 主机权限。原实现对任意 URL 直接 `axios.get`：被篡改的 image 字段可以
 * 指向内网地址或带副作用的 GET 接口，扩展会以自身身份发起请求（内网探测 / CSRF 式 GET）。
 * 这里只允许已知图床；协议只接受 http(s)，并在响应后二次校验重定向后的最终地址。
 */
const POSTER_ALLOWED_HOSTS = [
  "doubanio.com", // 豆瓣图床（img1/2/3/9.doubanio.com）
  "image.tmdb.org", // TMDB
  "m.media-amazon.com", // IMDb
  "cdn.anidb.net", // AniDB
  "img.anidb.net", // AniDB 备用图床
  "lain.bgm.tv", // Bangumi
  "static.tvmaze.com", // TVmaze
];

/** 海报体积上限（B1-7）：base64 后约放大 1.33 倍，5MB 已足够覆盖最高清的官方海报 */
const POSTER_FETCH_MAX_BYTES = 5 * 1024 * 1024;
/** data:image/... 直接透传时的字符串上限，避免上游塞入超大 base64 占满内存与消息体积 */
const POSTER_DATA_URL_MAX_LENGTH = 8 * 1024 * 1024;
/** 透传给 UI 渲染的第三方海报 URL 长度上限（只渲染，不抓取） */
const POSTER_PASSTHROUGH_URL_MAX_LENGTH = 2048;

/** 取 URL 的主机名（只对 http(s) 返回，其它协议返回 null） */
export function getPosterUrlHostname(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed.hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** 是否为允许抓取的海报 URL（协议 + 主机白名单，见 OS-6） */
export function isAllowedPosterUrl(url: string): boolean {
  const hostname = getPosterUrlHostname(url);
  if (!hostname) {
    return false;
  }
  return POSTER_ALLOWED_HOSTS.some((host) => hostname === host || hostname.endsWith(`.${host}`));
}

/**
 * 复检 RB-4：抓取仍只允许白名单（SSRF/CSRF 防护不变），但**渲染**不应因白名单而丢海报。
 *
 * 自定义 PtGen 端点（`social/index.ts` 支持用户配置，含图片反代/镜像部署）返回的海报可能来自
 * 任意自建图床（见 `social/utils.ts` 的说明）。这类 URL 不交给扩展 fetch，但可以原样回传给
 * options 由 `<img :src>` 渲染（浏览器图片请求不携带扩展凭据，且不是扩展发起的特权请求）。
 * 只接受 `https:`（避免混合内容）；豆瓣图床有防盗链，必须走 data URL，因此不在此回退。
 */
export function pickPassThroughPosterUrl(...posters: Array<string | undefined>): string | undefined {
  for (const poster of posters) {
    if (typeof poster !== "string") continue;
    const url = poster.trim();
    if (!url || url.length > POSTER_PASSTHROUGH_URL_MAX_LENGTH) continue;
    if (!/^https:\/\//i.test(url)) continue;
    if (isDoubanPosterUrl(url)) continue;
    return url;
  }
  return undefined;
}

/** 取响应经过重定向后的最终 URL（XHR 的 responseURL）；拿不到时返回 undefined */
function getPosterFinalResponseUrl(response: unknown): string | undefined {
  const responseUrl = (response as { request?: { responseURL?: unknown } } | undefined)?.request?.responseURL;
  return typeof responseUrl === "string" && responseUrl.length > 0 ? responseUrl : undefined;
}

function setPosterDataUrlCache(key: string, poster: string) {
  if (posterDataUrlCache.size >= POSTER_CACHE_LIMIT) {
    const oldestKey = posterDataUrlCache.keys().next().value;
    if (oldestKey) {
      posterDataUrlCache.delete(oldestKey);
    }
  }
  posterDataUrlCache.set(key, poster);
}

function getDoubanPosterRatioCandidates(poster: string): string[] {
  return [
    poster,
    poster.replace("/l_ratio_poster/", "/s_ratio_poster/"),
    poster.replace("/l_ratio_poster/", "/m_ratio_poster/"),
    poster.replace("/s_ratio_poster/", "/m_ratio_poster/"),
    poster.replace("/s_ratio_poster/", "/l_ratio_poster/"),
  ];
}

function getPosterCandidates(...posters: Array<string | undefined>): string[] {
  const candidates = posters.flatMap((poster) => {
    if (!poster || !/doubanio\.com/.test(poster)) {
      return poster ? [poster] : [];
    }

    return getDoubanPosterRatioCandidates(poster).flatMap((ratioCandidate) =>
      ["img1", "img2", "img3", "img9"].map((host) => ratioCandidate.replace(/img\d(?=\.doubanio\.com)/, host)),
    );
  });

  return Array.from(new Set(candidates)).slice(0, POSTER_CANDIDATE_LIMIT);
}

function getPosterFetchOptions(enrichment: TRecommendationEnrichmentMode) {
  return enrichment === "visible"
    ? {
        candidateLimit: VISIBLE_POSTER_CANDIDATE_LIMIT,
        timeout: VISIBLE_POSTER_FETCH_TIMEOUT,
      }
    : {
        candidateLimit: POSTER_CANDIDATE_LIMIT,
        timeout: POSTER_FETCH_TIMEOUT,
      };
}

function isDoubanPosterUrl(poster?: string) {
  return !!poster && /doubanio\.com/.test(poster);
}

async function getSocialInformationSafely(item: ISocialRecommendationItem) {
  try {
    return await getSocialInformation(item.site, item.id, {
      requireMetadata: !item.releaseYear || !item.region || !item.genres?.length,
      requireSummary: !item.summary,
    });
  } catch (error) {
    logger({
      msg: "Failed to enrich social recommendation",
      level: "warn",
      data: { site: item.site, id: item.id, error: error instanceof Error ? error.message : String(error) },
    });
    return undefined;
  }
}

function transformBlob(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("loadend", () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
      } else {
        reject(new Error("Error when parse recommendation poster Blob"));
      }
    });

    reader.readAsDataURL(blob);
  });
}

async function fetchPosterDataUrl(
  enrichment: TRecommendationEnrichmentMode,
  ...posters: Array<string | undefined>
): Promise<string | undefined> {
  const posterFetchOptions = getPosterFetchOptions(enrichment);
  const dataUrlPoster = posters.find((poster): poster is string => !!poster?.startsWith("data:image/"));

  if (dataUrlPoster) {
    // B1-7：data URL 同样可能有体积上限，超限视为无可用海报（不再原样透传给 options）。
    return dataUrlPoster.length <= POSTER_DATA_URL_MAX_LENGTH ? dataUrlPoster : undefined;
  }

  const candidates = getPosterCandidates(...posters).slice(0, posterFetchOptions.candidateLimit);
  const cacheKey = candidates.join("\n");
  const cachedPoster = posterDataUrlCache.get(cacheKey);

  if (cachedPoster) {
    return cachedPoster;
  }

  for (const candidate of candidates) {
    // OS-6：只抓取已知图床；其它来源（内网/任意站点）直接跳过，不再以扩展身份发起请求。
    if (!isAllowedPosterUrl(candidate)) {
      continue;
    }

    try {
      const response = await posterAxios.get<Blob>(candidate, {
        headers: isDoubanPosterUrl(candidate) ? { Referer: "https://m.douban.com/" } : undefined,
        responseType: "blob",
        timeout: posterFetchOptions.timeout,
        // S-3：海报抓取是「第三方数据 → 扩展特权请求」的汇点，禁止携带任何 Cookie/凭据。
        // 扩展页默认 withCredentials=false，这里显式声明，避免将来有人给 posterAxios 设全局默认值时回退。
        withCredentials: false,
      });

      /**
       * 重定向后的最终地址也必须仍在白名单内（axios 默认跟随重定向，只校验入参会被绕过）。
       *
       * 注意（复检 RB-8）：浏览器 XHR 会自动跟随重定向，因此这一步只能**事后丢弃响应体**，
       * 无法阻止「白名单主机 302 到内网/任意地址」的请求本身。当前允许的图床（doubanio/TMDB/
       * Amazon/AniDB/Bangumi/TVmaze）均无用户可控的开放重定向，残余风险低；若要请求级防护，
       * 需要改为 `fetch(..., { redirect: "manual" })` 逐跳校验（工作区本期不做）。
       */
      const finalUrl = getPosterFinalResponseUrl(response);
      if (finalUrl && !isAllowedPosterUrl(finalUrl)) {
        logger({ msg: "Skip recommendation poster redirected outside allowlist", level: "debug", data: { finalUrl } });
        continue;
      }

      const contentType = response.headers["content-type"];
      const normalizedContentType =
        typeof contentType === "string" ? contentType.split(";")[0] : response.data.type || undefined;
      const contentSize = response.data.size;

      // B1-7：只保留下限校验会把任意大的图片整体 base64 化并留在缓存里，这里加上限。
      if (contentSize > POSTER_FETCH_MAX_BYTES) {
        logger({ msg: "Skip oversized recommendation poster", level: "warn", data: { contentSize } });
        continue;
      }

      if (normalizedContentType?.startsWith("image/") && contentSize > 1024) {
        const poster = await transformBlob(response.data);
        setPosterDataUrlCache(cacheKey, poster);
        return poster;
      }
    } catch (error) {
      logger({
        msg: "Failed to fetch recommendation poster",
        level: "debug",
        data: { error: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  return undefined;
}

async function enrichRecommendation(
  item: ISocialRecommendationItem,
  enrichment: TRecommendationEnrichmentMode,
): Promise<ISocialRecommendationItem> {
  const needsSocialInformation =
    !item.poster || !item.summary || !item.releaseYear || !item.region || !item.genres?.length || !item.ratingScore;
  const socialInformation = needsSocialInformation ? await getSocialInformationSafely(item) : undefined;
  const poster = await fetchPosterDataUrl(enrichment, item.poster, socialInformation?.poster);
  const passThroughPoster = poster ? undefined : pickPassThroughPosterUrl(item.poster, socialInformation?.poster);

  if (passThroughPoster && !isAllowedPosterUrl(passThroughPoster)) {
    // 自定义 PtGen/自建图床：不抓取但回传 URL 供 UI 渲染，记一条 debug 便于排查「为什么没有 data URL」。
    logger({
      msg: "Pass through non-allowlisted recommendation poster URL (no fetch)",
      level: "debug",
      data: { host: getPosterUrlHostname(passThroughPoster) },
    });
  }

  return {
    ...item,
    /**
     * 三层取舍（复检 RB-4）：
     * 1. 优先用抓到的 data URL（白名单图床，已去凭据、带 douban Referer）；
     * 2. 抓取失败/非白名单时，只把 **https** 原始 URL 透传给 UI 渲染（不发起扩展请求；豆瓣防盗链除外）；
     * 3. 其它（http/data: 非图片/超长/非法）一律丢弃，避免 options 侧 `<img :src>` 变成可被第三方
     *    数据驱动的请求汇点（OS-6 的原始诉求）。
     */
    poster: poster || passThroughPoster,
    summary: socialInformation?.summary || item.summary,
    releaseYear: socialInformation?.releaseYear || item.releaseYear,
    region: socialInformation?.region || item.region,
    genres: socialInformation?.genres?.length ? socialInformation.genres : item.genres,
    ratingScore: socialInformation?.ratingScore || item.ratingScore,
    ratingCount: socialInformation?.ratingCount || item.ratingCount,
  };
}

function getRecommendationItemKey(item: ISocialRecommendationItem) {
  return `${item.category}:${item.site}:${item.id}`;
}

function getVisibleRecommendationItemKeys(items: ISocialRecommendationItem[]) {
  const categoryCounts = new Map<ISocialRecommendationItem["category"], number>();
  const visibleItemKeys = new Set<string>();

  for (const item of items) {
    const categoryCount = categoryCounts.get(item.category) ?? 0;
    categoryCounts.set(item.category, categoryCount + 1);

    if (categoryCount < VISIBLE_RECOMMENDATION_CATEGORY_LIMIT) {
      visibleItemKeys.add(getRecommendationItemKey(item));
    }
  }

  return visibleItemKeys;
}

function shouldEnrichRecommendation(
  item: ISocialRecommendationItem,
  enrichment: TRecommendationEnrichmentMode,
  visibleItemKeys: Set<string>,
) {
  return enrichment !== "visible" || visibleItemKeys.has(getRecommendationItemKey(item));
}

async function enrichRecommendations(
  items: ISocialRecommendationItem[],
  enrichment: TRecommendationEnrichmentMode,
): Promise<ISocialRecommendationItem[]> {
  const visibleItemKeys = getVisibleRecommendationItemKeys(items);
  const enrichmentQueue = new PQueue({ concurrency: RECOMMENDATION_ENRICHMENT_CONCURRENCY });
  return Promise.all(
    items.map((item) => {
      if (!shouldEnrichRecommendation(item, enrichment, visibleItemKeys)) {
        return item;
      }

      return enrichmentQueue.add(() => enrichRecommendation(item, enrichment)) as Promise<ISocialRecommendationItem>;
    }),
  );
}

onMessage("getSocialRecommendations", async ({ data }) => {
  const options = (data ?? {}) as IGetSocialRecommendationsMessageOptions;
  const result = await getSocialRecommendations(options);

  if (options.enrichment === "none") {
    logger({
      msg: "getSocialRecommendations",
      data: {
        count: result.items.length,
        flush: options.flush ?? false,
        hasFailedSources: result.hasFailedSources,
        enrichment: "none",
      },
    });
    return result;
  }

  const enrichment = options.enrichment ?? "all";
  const items = await enrichRecommendations(result.items, enrichment);

  logger({
    msg: "getSocialRecommendations",
    data: {
      count: items.length,
      flush: options.flush ?? false,
      hasFailedSources: result.hasFailedSources,
      enrichment,
    },
  });
  return { ...result, items };
});

onMessage("getSocialRecommendationItem", async ({ data }) => {
  const enrichment = data.enrichment ?? "all";
  const item = await enrichRecommendation(data.item, enrichment);

  logger({
    msg: "getSocialRecommendationItem",
    data: {
      item: getRecommendationItemKey(item),
      enrichment,
    },
  });

  return { item };
});
