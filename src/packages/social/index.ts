import axios from "axios";
import { logMessage } from "@ptd/site/utils/adapter.ts";
import {
  IFetchSocialSiteInformationConfig,
  ISocialInformation,
  TSupportSocialSite,
  TSupportSocialSitePageParserMatches,
} from "./types.ts";
import type {
  IGetSocialRecommendationsOptions,
  ISocialRecommendationItem,
  ISocialRecommendationsResult,
  TSocialRecommendationCategory,
} from "./recommendations.ts";

export * from "./types.ts";

// 推荐模块通过独立子路径（@ptd/social/recommendations）提供，这里只做惰性转发与类型导出，
// 避免 `export *` 把推荐模块整体内联进所有 `@ptd/social` 使用方（尤其是 content script）的共享 chunk。
export type {
  IGetSocialRecommendationsOptions,
  ISocialRecommendationItem,
  ISocialRecommendationsResult,
  TSocialRecommendationCategory,
};

export async function getSocialRecommendations(
  options: IGetSocialRecommendationsOptions = {},
): Promise<ISocialRecommendationsResult> {
  return await (await import("./recommendations.ts")).getSocialRecommendations(options);
}

// From https://github.com/ourbits/PtGen#usage
export const buildInPtGenApi = [
  { provider: "Github Pages", url: "https://ourbits.github.io/PtGen/<site>/<sid>.json" },
  { provider: "OurHelp CDN", url: "https://cdn.ourhelp.club/ptgen/<site>/<sid>.json" },
  { provider: "OurHelp API", url: "https://api.ourhelp.club/infogen?site=<site>&sid=<sid>" },
];

interface socialEntity {
  parse: (query: string) => string;
  build: (id: string) => string;
  pageParserMatches?: TSupportSocialSitePageParserMatches;
  transformPtGen?: (data: any) => ISocialInformation;
  fetchInformation: (id: string, config: IFetchSocialSiteInformationConfig) => Promise<ISocialInformation>;
}

export const socialContent = import.meta.glob<socialEntity>("./entity/*.ts", { eager: true });
export const socialEntityList = Object.keys(socialContent).map((value: string) => {
  return value.replace(/^\.\/entity\//, "").replace(/\.ts$/, "");
}) as TSupportSocialSite[];

export type TSupportSocialSite$1 = (typeof socialEntityList)[number];

const PtGenApiSupportSite: TSupportSocialSite$1[] = [] as const;

export const socialBuildUrlMap = {} as Record<TSupportSocialSite$1, socialEntity["build"]>;
export const socialParseUrlMap = {} as Record<TSupportSocialSite$1, socialEntity["parse"]>;
export const socialPageParserMatchesMap = {} as Record<TSupportSocialSite$1, TSupportSocialSitePageParserMatches>;

/**
 * 各社交站点的「可信主机」后缀白名单（C2-S-1）。
 *
 * 旧实现是精确 hostname 集合，`m.douban.com` / `m.imdb.com` / `m.themoviedb.org` 这类常见移动页
 * 会被判为非社交页（快捷搜索入口消失），与各实体正则本身允许的 `m.*` / `mobile.*` 子域不一致。
 * 后缀匹配同时保留了反例（如 `douban.com.evil.example` 不匹配）。
 */
const socialPageHosts: Record<TSupportSocialSite$1, readonly string[]> = {
  anidb: ["anidb.net"],
  bangumi: ["bgm.tv", "bangumi.tv", "chii.in"],
  douban: ["douban.com"],
  imdb: ["imdb.com"],
  tmdb: ["themoviedb.org"],
  tvmaze: ["tvmaze.com"],
};

/** host 是否等于白名单域名本身或为其子域 */
export function isSocialPageHost(hostname: string, site: TSupportSocialSite$1): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return (socialPageHosts[site] ?? []).some((domain) => host === domain || host.endsWith(`.${domain}`));
}

export function matchSocialPageUrl(url: string): TSupportSocialSite$1 | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;

  const pageUrl = parsed.origin + parsed.pathname;
  for (const [site, patternMatches] of Object.entries(socialPageParserMatchesMap)) {
    if (!isSocialPageHost(parsed.hostname, site as TSupportSocialSite$1)) continue;
    if (patternMatches.some(([pattern]) => new RegExp(pattern, "i").test(pageUrl))) {
      return site as TSupportSocialSite$1;
    }
  }
  return null;
}

export function getSocialModule(site: TSupportSocialSite$1): socialEntity {
  return socialContent[`./entity/${site}.ts`];
}

for (const socialEntity of socialEntityList) {
  const socialModule = getSocialModule(socialEntity);

  socialBuildUrlMap[socialEntity] = socialModule.build;
  socialParseUrlMap[socialEntity] = socialModule.parse;

  if (socialModule.pageParserMatches) {
    socialPageParserMatchesMap[socialEntity] = socialModule.pageParserMatches;
  }

  if (socialModule.transformPtGen) {
    PtGenApiSupportSite.push(socialEntity);
  }
}

/**
 * 成功结果的进程内复用时长。
 *
 * 搜索结果页里同一部影片会有多个版本（720p/1080p/4K…），它们的 ext 相同，
 * 因此会以同一个 site:id 并发调用；offscreen 侧另有 IDB 级别的长缓存（cacheDay），
 * 这里只需要合并"进行中"的请求并短暂复用成功结果即可。
 */
const SOCIAL_INFORMATION_CACHE_TTL = 10 * 60 * 1000;
const MAX_SOCIAL_INFORMATION_CACHE_SIZE = 1000;

/**
 * 不参与缓存键的配置字段：
 * - `cacheDay` 只影响调用侧（offscreen）的 IDB 缓存，不改变本次抓取结果；
 * - `force` 是"跳过缓存"的开关，纳入缓存键会让强制刷新落到另一个 key 上，无法覆盖旧条目。
 */
const SOCIAL_INFORMATION_CACHE_IGNORED_CONFIG_KEYS = new Set(["cacheDay", "force"]);

interface ICachedSocialInformation {
  promise: Promise<ISocialInformation | undefined>;
  createAt: number;
}

const socialInformationInFlight = new Map<string, ICachedSocialInformation>();

/** 递归按 key 排序，保证对象键顺序不同的等价配置得到同一个缓存键 */
function normalizeConfigForCacheKey(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeConfigForCacheKey(item));
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !SOCIAL_INFORMATION_CACHE_IGNORED_CONFIG_KEYS.has(key))
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, normalizeConfigForCacheKey(item)]),
    );
  }

  return value;
}

/**
 * 影响抓取结果的配置（PtGen 端点 / preferPtGen / timeout / socialSite）必须纳入缓存键，
 * 否则调用方改了配置后，10 分钟 TTL 内仍会复用按旧配置抓到的结果。
 */
function buildSocialInformationCacheKey(
  site: TSupportSocialSite$1,
  id: string,
  config: IFetchSocialSiteInformationConfig,
): string {
  return `${site}:${id}:${JSON.stringify(normalizeConfigForCacheKey(config))}`;
}

async function fetchSocialSiteInformation(
  site: TSupportSocialSite$1,
  id: string,
  config: IFetchSocialSiteInformationConfig,
): Promise<ISocialInformation | undefined> {
  const socialModule = getSocialModule(site);
  const { preferPtGen = true, ptGenEndpoint = buildInPtGenApi[0].url, timeout = 5e3 } = config;

  if (preferPtGen && PtGenApiSupportSite.includes(site)) {
    console?.log("Use PtGen API to fetch social site information ", { site, id });

    // 所有内置端点 + 用户配置端点并行请求（去重），共享同一个 deadline：任一成功即返回。
    // C2-S-2：旧候选集只有 [配置端点, buildInPtGenApi.at(-1)]，中间的 OurHelp CDN 端点永远不请求，
    // 与 types.ts 里「从默认的 buildInPtGenApi 中依次尝试」的说明不符。
    const deadline = Date.now() + timeout;
    const ptGenUrls = Array.from(
      new Set<string>(
        [ptGenEndpoint, ...buildInPtGenApi.map((api) => api.url)].filter((endpoint): endpoint is string => !!endpoint),
      ),
    ).map((endpoint) => endpoint.replace("<site>", site).replace("<sid>", id));

    if (ptGenUrls.length > 0) {
      const requestPtGen = async (ptGenUrl: string) => {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          throw new Error("PtGen request timeout");
        }

        const req = await axios.get(ptGenUrl, { timeout: Math.max(remaining, 1), responseType: "json" });
        const data = req.data as any;
        if (req.status !== 200 || data?.success === false) {
          throw new Error("Invalid PtGen response");
        }
        return socialModule.transformPtGen!(data);
      };

      try {
        return await Promise.any(ptGenUrls.map((ptGenUrl) => requestPtGen(ptGenUrl)));
      } catch (error) {
        // P1-5：所有 PtGen 端点都失败时回落到内置解析，属于预期内的降级路径，
        // 但必须留下原因，否则线上无法判断「内置结果」是命中还是 PtGen 全线故障。
        logMessage("[Social] PtGen API 全部失败，回落到内置解析", {
          site,
          id,
          endpoints: ptGenUrls,
          error: error instanceof AggregateError ? error.errors.map((e) => String(e)) : String(error),
        });
      }
    }
  }

  // 如果没有使用 PtGen API 或者 PtGen API 获取失败，则使用内置的解析方法
  console?.log("Use build-in API to fetch social site information:", { site, id });
  return await socialModule.fetchInformation(id, config);
}

export async function getSocialSiteInformation(
  site: TSupportSocialSite$1,
  id: string,
  config: IFetchSocialSiteInformationConfig = {},
): Promise<ISocialInformation | undefined> {
  const cacheKey = buildSocialInformationCacheKey(site, id, config);
  const forceRefresh = config.force === true;

  if (!forceRefresh) {
    const cached = socialInformationInFlight.get(cacheKey);
    if (cached && Date.now() - cached.createAt < SOCIAL_INFORMATION_CACHE_TTL) {
      return await cached.promise;
    }
  }

  const promise = fetchSocialSiteInformation(site, id, config);
  // 强制刷新时直接覆盖旧条目（key 不含 force，天然命中同一条目）
  socialInformationInFlight.set(cacheKey, { promise, createAt: Date.now() });

  // 限制 Map 体积（FIFO 淘汰，最坏情况下只是少一次复用）
  if (socialInformationInFlight.size > MAX_SOCIAL_INFORMATION_CACHE_SIZE) {
    const oldestKey = socialInformationInFlight.keys().next().value;
    if (oldestKey !== undefined && oldestKey !== cacheKey) {
      socialInformationInFlight.delete(oldestKey);
    }
  }

  try {
    const result = await promise;
    if (!result || (!result.title && !result.poster)) {
      // 内置解析器在请求失败时也可能返回带 createAt 的空对象。
      if (socialInformationInFlight.get(cacheKey)?.promise === promise) {
        socialInformationInFlight.delete(cacheKey);
      }
    }
    return result;
  } catch (e) {
    if (socialInformationInFlight.get(cacheKey)?.promise === promise) {
      socialInformationInFlight.delete(cacheKey);
    }
    throw e;
  }
}
