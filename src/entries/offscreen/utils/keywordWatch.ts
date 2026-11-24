import PQueue from "p-queue";
import { EResultParseStatus, type IAdvancedSearchRequestConfig, type ITorrent, type TSiteID } from "@ptd/site";

import { onMessage, sendMessage } from "@/messages.ts";
import { isTorrentFree, safeRegexTest } from "@/shared/pushRouting.ts";
import { getTorrentFavoriteKey, type IKeywordWatchRule, type IMetadataPiniaStorageSchema } from "@/shared/types.ts";

import { logger } from "./logger.ts";
import { getSiteInstance, runSiteOperation } from "./site.ts";
import { createTorrentFavorites } from "./torrentFavorite.ts";

const GIB = 1024 ** 3;
const MAX_SEEN_KEYS = 200;
const KEYWORD_WATCH_CONCURRENCY = 3;

export interface IKeywordWatchRunMatch {
  site: TSiteID;
  title: string;
  size?: number;
  url?: string;
}

export interface IKeywordWatchRunResult {
  matchedCount: number;
  newMatches: IKeywordWatchRunMatch[];
  error?: string;
}

export function filterTorrentByKeywordWatchRule(torrent: ITorrent, rule: IKeywordWatchRule): boolean {
  if (rule.freeOnly && !isTorrentFree(torrent)) {
    return false;
  }

  const size = typeof torrent.size === "number" && Number.isFinite(torrent.size) ? torrent.size : 0;
  if (typeof rule.minSizeGiB === "number" && Number.isFinite(rule.minSizeGiB) && rule.minSizeGiB > 0) {
    if (size < rule.minSizeGiB * GIB) return false;
  }
  if (typeof rule.maxSizeGiB === "number" && Number.isFinite(rule.maxSizeGiB) && rule.maxSizeGiB > 0) {
    if (size <= 0 || size > rule.maxSizeGiB * GIB) return false;
  }

  if (typeof rule.minSeeders === "number" && Number.isFinite(rule.minSeeders) && rule.minSeeders > 0) {
    const seeders = typeof torrent.seeders === "number" && Number.isFinite(torrent.seeders) ? torrent.seeders : 0;
    if (seeders < rule.minSeeders) return false;
  }

  const text = `${torrent.title ?? ""} ${torrent.subTitle ?? ""}`.trim();
  if (rule.titleIncludeRegex?.trim() && !safeRegexTest(rule.titleIncludeRegex, text)) {
    return false;
  }
  if (rule.titleExcludeRegex?.trim() && safeRegexTest(rule.titleExcludeRegex, text)) {
    return false;
  }

  return true;
}

async function resolveWatchSearchTargets(
  rule: IKeywordWatchRule,
): Promise<Array<{ siteId: TSiteID; searchEntry: IAdvancedSearchRequestConfig }>> {
  const sites =
    ((await sendMessage("getExtStoragePath", {
      key: "metadata",
      path: ["sites"],
      defaultValue: {},
    })) as IMetadataPiniaStorageSchema["sites"]) ?? {};

  let solutionId = rule.solutionId || "default";
  if (solutionId === "default") {
    const defaultSolutionId = (await sendMessage("getExtStoragePath", {
      key: "metadata",
      path: ["defaultSolutionId"],
      defaultValue: "default",
    })) as string;
    solutionId = defaultSolutionId || "default";
  }

  if (solutionId === "all" || solutionId === "default") {
    return Object.entries(sites)
      .filter(([, cfg]) => cfg && !cfg.isOffline && cfg.allowSearch !== false)
      .map(([siteId]) => ({ siteId, searchEntry: {} }));
  }

  if (solutionId.startsWith("site:")) {
    return solutionId
      .slice(5)
      .split(",")
      .map((s) => s.trim())
      .filter((siteId) => sites[siteId] && !sites[siteId].isOffline && sites[siteId].allowSearch !== false)
      .map((siteId) => ({ siteId, searchEntry: {} }));
  }

  const solution = (await sendMessage("getExtStoragePath", {
    key: "metadata",
    path: ["solutions", solutionId],
    defaultValue: null,
  })) as IMetadataPiniaStorageSchema["solutions"][string] | null;

  if (!solution || !Array.isArray(solution.solutions)) {
    return [];
  }

  const targets: Array<{ siteId: TSiteID; searchEntry: IAdvancedSearchRequestConfig }> = [];
  for (const item of solution.solutions) {
    const siteCfg = sites[item.siteId];
    if (!siteCfg || siteCfg.isOffline || siteCfg.allowSearch === false) continue;
    const entries = Object.values(item.searchEntries ?? {}).filter((entry) => entry?.enabled !== false);
    if (entries.length === 0) {
      targets.push({ siteId: item.siteId, searchEntry: {} });
    } else {
      for (const entry of entries) {
        targets.push({ siteId: item.siteId, searchEntry: entry });
      }
    }
  }
  return targets;
}

export async function runKeywordWatchRule(ruleId: string): Promise<IKeywordWatchRunResult> {
  const rule = (await sendMessage("getExtStoragePath", {
    key: "metadata",
    path: ["keywordWatches", ruleId],
    defaultValue: null,
  })) as IKeywordWatchRule | null;

  if (!rule) {
    return { matchedCount: 0, newMatches: [], error: `Keyword watch rule not found: ${ruleId}` };
  }

  const keyword = rule.keyword?.trim() ?? "";
  if (!keyword) {
    return { matchedCount: 0, newMatches: [], error: "Empty keyword" };
  }

  const now = Date.now();
  const targets = await resolveWatchSearchTargets(rule);
  if (targets.length === 0) {
    await sendMessage("patchExtStoragePath", {
      key: "metadata",
      path: ["keywordWatches", ruleId],
      value: {
        ...rule,
        lastRunAt: now,
        lastMatchCount: 0,
        lastError: "No searchable sites in target solution",
      },
    });
    return { matchedCount: 0, newMatches: [], error: "No searchable sites in target solution" };
  }

  const queue = new PQueue({ concurrency: KEYWORD_WATCH_CONCURRENCY });
  const matchedTorrents: ITorrent[] = [];
  let errorCount = 0;

  await Promise.all(
    targets.map(({ siteId, searchEntry }) =>
      queue.add(async () => {
        try {
          const site = await getSiteInstance<"public">(siteId);
          const result = await runSiteOperation(siteId, () => site.getSearchResult(keyword, searchEntry));
          if (result.status === EResultParseStatus.success && Array.isArray(result.data)) {
            for (const torrent of result.data) {
              if (filterTorrentByKeywordWatchRule(torrent, rule)) {
                matchedTorrents.push(torrent);
              }
            }
          }
        } catch (e) {
          errorCount += 1;
          logger({
            msg: `Keyword watch [${rule.name}] search failed on ${siteId}`,
            level: "warn",
            data: e instanceof Error ? e.message : String(e),
          });
        }
      }),
    ),
  );

  const seenSet = new Set<string>(Array.isArray(rule.seenTorrentKeys) ? rule.seenTorrentKeys : []);
  const newMatchedTorrents: ITorrent[] = [];
  const nextSeenKeys: string[] = Array.isArray(rule.seenTorrentKeys) ? [...rule.seenTorrentKeys] : [];

  for (const torrent of matchedTorrents) {
    const key = getTorrentFavoriteKey(torrent);
    if (!seenSet.has(key)) {
      seenSet.add(key);
      nextSeenKeys.push(key);
      newMatchedTorrents.push(torrent);
    }
  }

  // 限制去重缓存长度
  const cappedSeenKeys =
    nextSeenKeys.length > MAX_SEEN_KEYS ? nextSeenKeys.slice(nextSeenKeys.length - MAX_SEEN_KEYS) : nextSeenKeys;

  if (rule.autoFavorite && newMatchedTorrents.length > 0) {
    try {
      await createTorrentFavorites({
        torrents: newMatchedTorrents,
        favCategories: [rule.favCategory?.trim() || "关键词监控"],
        comment: `关键词监控命中: ${rule.name}`,
      });
    } catch (e) {
      logger({
        msg: `Keyword watch [${rule.name}] auto-favorite failed`,
        level: "warn",
        data: e instanceof Error ? e.message : String(e),
      });
    }
  }

  const lastError = errorCount === targets.length ? `All ${targets.length} sites failed` : "";
  await sendMessage("patchExtStoragePath", {
    key: "metadata",
    path: ["keywordWatches", ruleId],
    value: {
      ...rule,
      lastRunAt: now,
      lastMatchAt: newMatchedTorrents.length > 0 ? now : rule.lastMatchAt,
      lastMatchCount: newMatchedTorrents.length,
      totalMatchCount: (rule.totalMatchCount ?? 0) + newMatchedTorrents.length,
      lastError,
      seenTorrentKeys: cappedSeenKeys,
    },
  });

  logger({
    msg: `Keyword watch [${rule.name}] finished: ${newMatchedTorrents.length} new / ${matchedTorrents.length} matched`,
    data: { ruleId, keyword, sites: targets.length, newCount: newMatchedTorrents.length },
  });

  return {
    matchedCount: matchedTorrents.length,
    newMatches: newMatchedTorrents.map((t) => ({
      site: t.site,
      title: t.title,
      size: t.size,
      url: t.url,
    })),
    error: lastError || undefined,
  };
}

onMessage("runKeywordWatchRule", async ({ data: ruleId }) => {
  return await runKeywordWatchRule(ruleId);
});
