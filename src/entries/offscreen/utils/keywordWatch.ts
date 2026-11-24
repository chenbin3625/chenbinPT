import { cloneDeep } from "es-toolkit";
import PQueue from "p-queue";
import {
  EResultParseStatus,
  getDefinedSiteMetadata,
  type ISearchEntryRequestConfig,
  type ISiteUserConfig,
  type ITorrent,
  type TSiteID,
} from "@ptd/site";

import { onMessage, sendMessage } from "@/messages.ts";
import { isTorrentFree, safeRegexTest } from "@/shared/pushRouting.ts";
import { getTorrentFavoriteKey, type IKeywordWatchRule, type IMetadataPiniaStorageSchema } from "@/shared/types.ts";

import { logger } from "./logger.ts";
import { ensureCustomSitesSynced, getSiteInstance, runSiteOperation } from "./site.ts";
import { createTorrentFavorites } from "./torrentFavorite.ts";

const GIB = 1024 ** 3;
const MAX_SEEN_KEYS = 200;
const KEYWORD_WATCH_CONCURRENCY = 3;

const SEARCH_FAILURE_STATUSES: ReadonlySet<EResultParseStatus> = new Set([
  EResultParseStatus.unknownError,
  EResultParseStatus.parseError,
  EResultParseStatus.CFBlocked,
  EResultParseStatus.needLogin,
  EResultParseStatus.noUserInput,
]);

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

/**
 * 与 metadataStore.getSiteDefaultSearchSolution 对齐：
 * 展开站点默认 searchEntry 并合入用户在 siteCfg.merge.searchEntry 中的启停覆盖，同时过滤已死亡站点。
 */
async function resolveDefaultSiteSearchTargets(
  siteId: TSiteID,
  siteCfg: ISiteUserConfig | undefined,
): Promise<Array<{ siteId: TSiteID; searchEntry: ISearchEntryRequestConfig }>> {
  if (!siteCfg || siteCfg.isOffline || siteCfg.allowSearch === false) {
    return [];
  }

  const mergeEntries = siteCfg.merge?.searchEntry;
  try {
    const siteMetadata = await getDefinedSiteMetadata(siteId);
    if (siteMetadata.isDead) {
      return [];
    }

    const hasDefinedEntries = Boolean(siteMetadata.searchEntry && Object.keys(siteMetadata.searchEntry).length > 0);
    const searchEntries: Record<string, ISearchEntryRequestConfig> = hasDefinedEntries
      ? cloneDeep(siteMetadata.searchEntry!)
      : { default: {} };

    for (const [entryKey, overrideEntry] of Object.entries(mergeEntries ?? {})) {
      if (!overrideEntry || typeof overrideEntry !== "object") continue;
      searchEntries[entryKey] = {
        ...(searchEntries[entryKey] ?? {}),
        ...cloneDeep(overrideEntry),
      };
    }

    const targets: Array<{ siteId: TSiteID; searchEntry: ISearchEntryRequestConfig }> = [];
    for (const [entryKey, entry] of Object.entries(searchEntries)) {
      if (entry?.enabled === false) continue;
      const resolvedEntry: ISearchEntryRequestConfig =
        hasDefinedEntries || entryKey !== "default" ? { ...entry, id: entry?.id ?? entryKey } : { ...entry };
      targets.push({ siteId, searchEntry: resolvedEntry });
    }
    return targets;
  } catch {
    // 测试环境或自定义占位站点无内置元数据时，优先尊重用户 merge.searchEntry，否则退回单默认入口
    if (mergeEntries && Object.keys(mergeEntries).length > 0) {
      return Object.entries(mergeEntries)
        .filter(([, entry]) => entry?.enabled !== false)
        .map(([entryKey, entry]) => ({
          siteId,
          searchEntry: { ...(entry ?? {}), id: entry?.id ?? entryKey },
        }));
    }
    return [{ siteId, searchEntry: {} }];
  }
}

async function resolveWatchSearchTargets(
  rule: IKeywordWatchRule,
): Promise<Array<{ siteId: TSiteID; searchEntry: ISearchEntryRequestConfig }>> {
  await ensureCustomSitesSynced();

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
    const targets: Array<{ siteId: TSiteID; searchEntry: ISearchEntryRequestConfig }> = [];
    for (const [siteId, cfg] of Object.entries(sites)) {
      targets.push(...(await resolveDefaultSiteSearchTargets(siteId, cfg)));
    }
    return targets;
  }

  if (solutionId.startsWith("site:")) {
    const targets: Array<{ siteId: TSiteID; searchEntry: ISearchEntryRequestConfig }> = [];
    const siteIds = solutionId
      .slice(5)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const siteId of siteIds) {
      targets.push(...(await resolveDefaultSiteSearchTargets(siteId, sites[siteId])));
    }
    return targets;
  }

  const solution = (await sendMessage("getExtStoragePath", {
    key: "metadata",
    path: ["solutions", solutionId],
    defaultValue: null,
  })) as IMetadataPiniaStorageSchema["solutions"][string] | null;

  if (!solution || !Array.isArray(solution.solutions)) {
    return [];
  }

  const targets: Array<{ siteId: TSiteID; searchEntry: ISearchEntryRequestConfig }> = [];
  for (const item of solution.solutions) {
    if (!item || typeof item !== "object") continue;
    const siteCfg = sites[item.siteId];
    if (!siteCfg || siteCfg.isOffline || siteCfg.allowSearch === false) continue;

    const rawEntries = Object.entries(item.searchEntries ?? {});
    // 与 metadataStore.getSearchSolution 对齐：id === "default" 且未显式限定 searchEntries 时展开站点默认入口；
    // 若用户显式配置了 searchEntries 但全部设为 enabled: false，则不再凭空补发默认入口。
    if (item.id === "default" && rawEntries.length === 0) {
      targets.push(...(await resolveDefaultSiteSearchTargets(item.siteId, siteCfg)));
      continue;
    }

    for (const [entryKey, entry] of rawEntries) {
      if (entry?.enabled === false) continue;
      targets.push({
        siteId: item.siteId,
        searchEntry: { ...(entry ?? {}), id: entry?.id ?? entryKey },
      });
    }
  }
  return targets;
}

async function readLatestWatchRule(ruleId: string): Promise<IKeywordWatchRule | null> {
  return (await sendMessage("getExtStoragePath", {
    key: "metadata",
    path: ["keywordWatches", ruleId],
    defaultValue: null,
  })) as IKeywordWatchRule | null;
}

export async function runKeywordWatchRule(ruleId: string): Promise<IKeywordWatchRunResult> {
  const rule = await readLatestWatchRule(ruleId);

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
    const latestRule = await readLatestWatchRule(ruleId);
    if (latestRule) {
      await sendMessage("patchExtStoragePath", {
        key: "metadata",
        path: ["keywordWatches", ruleId],
        value: {
          ...latestRule,
          lastRunAt: now,
          lastMatchCount: 0,
          lastError: "No searchable sites in target solution",
        },
      });
    }
    return { matchedCount: 0, newMatches: [], error: "No searchable sites in target solution" };
  }

  const queue = new PQueue({ concurrency: KEYWORD_WATCH_CONCURRENCY });
  const matchedTorrents: ITorrent[] = [];
  let errorCount = 0;
  let attemptedCount = 0;
  let firstErrorReason = "";

  await Promise.all(
    targets.map(({ siteId, searchEntry }) =>
      queue.add(async () => {
        try {
          const site = await getSiteInstance<"public">(siteId);
          const result = await runSiteOperation(siteId, () => site.getSearchResult(keyword, searchEntry));
          if (result.status === EResultParseStatus.passParse) {
            return;
          }
          attemptedCount += 1;
          if (result.status === EResultParseStatus.success && Array.isArray(result.data)) {
            for (const torrent of result.data) {
              if (filterTorrentByKeywordWatchRule(torrent, rule)) {
                matchedTorrents.push(torrent);
              }
            }
          } else if (result.status === EResultParseStatus.noResults) {
            // 无结果属于正常状态，不计为站点错误
          } else if (SEARCH_FAILURE_STATUSES.has(result.status) || result.status !== EResultParseStatus.success) {
            errorCount += 1;
            const reason = result.statusMsg || EResultParseStatus[result.status] || String(result.status);
            if (!firstErrorReason) {
              firstErrorReason = `${siteId}: ${reason}`;
            }
            logger({
              msg: `Keyword watch [${rule.name}] search returned failure on ${siteId}`,
              level: "warn",
              data: { status: result.status, statusMsg: result.statusMsg },
            });
          }
        } catch (e) {
          attemptedCount += 1;
          errorCount += 1;
          const reason = e instanceof Error ? e.message : String(e);
          if (!firstErrorReason) {
            firstErrorReason = `${siteId}: ${reason}`;
          }
          logger({
            msg: `Keyword watch [${rule.name}] search failed on ${siteId}`,
            level: "warn",
            data: reason,
          });
        }
      }),
    ),
  );

  // 搜索耗时期间规则可能已被用户删除或停用：重新读取最新规则，已删除则直接放弃写回与副作用
  const latestRuleBeforeSideEffects = await readLatestWatchRule(ruleId);
  if (!latestRuleBeforeSideEffects) {
    logger({
      msg: `Keyword watch [${rule.name}] was deleted during search; skipping persistence`,
      level: "info",
      data: { ruleId },
    });
    return { matchedCount: matchedTorrents.length, newMatches: [] };
  }

  const disabledDuringRun = rule.enabled && !latestRuleBeforeSideEffects.enabled;
  const previousSeenKeys = Array.isArray(latestRuleBeforeSideEffects.seenTorrentKeys)
    ? latestRuleBeforeSideEffects.seenTorrentKeys
    : [];
  const previousSeenSet = new Set<string>(previousSeenKeys);

  // 对本轮命中的种子去重，区分「仍在命中的历史条目」和「首次命中的新条目」
  const uniqueCurrentKeys = new Set<string>();
  const activeExistingKeys: string[] = [];
  const newMatchedTorrents: ITorrent[] = [];
  const newMatchedKeys: string[] = [];

  for (const torrent of matchedTorrents) {
    const key = getTorrentFavoriteKey(torrent);
    if (uniqueCurrentKeys.has(key)) continue;
    uniqueCurrentKeys.add(key);

    if (previousSeenSet.has(key)) {
      activeExistingKeys.push(key);
    } else {
      newMatchedKeys.push(key);
      newMatchedTorrents.push(torrent);
    }
  }

  let autoFavoriteFailed = false;
  let autoFavoriteError = "";
  if (!disabledDuringRun && latestRuleBeforeSideEffects.autoFavorite && newMatchedTorrents.length > 0) {
    try {
      await createTorrentFavorites({
        torrents: newMatchedTorrents,
        favCategories: [latestRuleBeforeSideEffects.favCategory?.trim() || "关键词监控"],
        comment: `关键词监控命中: ${latestRuleBeforeSideEffects.name}`,
      });
    } catch (e) {
      autoFavoriteFailed = true;
      autoFavoriteError = e instanceof Error ? e.message : String(e);
      logger({
        msg: `Keyword watch [${latestRuleBeforeSideEffects.name}] auto-favorite failed`,
        level: "warn",
        data: autoFavoriteError,
      });
    }
  }

  // 自动收藏失败（或运行期间规则被停用）时不把新命中写入 seenTorrentKeys，保证下次触发可重试收藏与通知
  const shouldCommitNewMatches = !disabledDuringRun && !autoFavoriteFailed;
  const committedNewKeys = shouldCommitNewMatches ? newMatchedKeys : [];
  const committedNewTorrents = shouldCommitNewMatches ? newMatchedTorrents : [];

  // 去重缓存保留策略：
  // 1) 将本轮仍命中的历史 key 刷新到队尾，避免被旧窗口淘汰；
  // 2) 容量至少覆盖本轮全部活跃命中数，避免稳定命中超过 200 条时每轮滚动淘汰并重复告警。
  const staleHistoricalKeys = previousSeenKeys.filter((key) => !uniqueCurrentKeys.has(key));
  const combinedSeenKeys = [...staleHistoricalKeys, ...activeExistingKeys, ...committedNewKeys];
  const retentionLimit = Math.max(MAX_SEEN_KEYS, activeExistingKeys.length + committedNewKeys.length);
  const cappedSeenKeys =
    combinedSeenKeys.length > retentionLimit
      ? combinedSeenKeys.slice(combinedSeenKeys.length - retentionLimit)
      : combinedSeenKeys;

  const allTargetsFailed =
    errorCount > 0 && (errorCount === targets.length || (attemptedCount > 0 && errorCount === attemptedCount));
  const siteError = allTargetsFailed
    ? firstErrorReason
      ? `All ${attemptedCount || targets.length} sites failed (${firstErrorReason})`
      : `All ${attemptedCount || targets.length} sites failed`
    : "";
  const lastError = siteError || (autoFavoriteFailed ? `Auto-favorite failed: ${autoFavoriteError}` : "");

  // 落盘前再次读取最新规则，防止在 autoFavorite 期间规则被删除/停用/编辑
  const latestRuleBeforeSave = await readLatestWatchRule(ruleId);
  if (latestRuleBeforeSave) {
    await sendMessage("patchExtStoragePath", {
      key: "metadata",
      path: ["keywordWatches", ruleId],
      value: {
        ...latestRuleBeforeSave,
        lastRunAt: now,
        lastMatchAt: committedNewTorrents.length > 0 ? now : latestRuleBeforeSave.lastMatchAt,
        lastMatchCount: committedNewTorrents.length,
        totalMatchCount: (latestRuleBeforeSave.totalMatchCount ?? 0) + committedNewTorrents.length,
        lastError,
        seenTorrentKeys: cappedSeenKeys,
      },
    });
  }

  logger({
    msg: `Keyword watch [${latestRuleBeforeSideEffects.name}] finished: ${committedNewTorrents.length} new / ${matchedTorrents.length} matched`,
    data: { ruleId, keyword, sites: targets.length, newCount: committedNewTorrents.length },
  });

  return {
    matchedCount: matchedTorrents.length,
    newMatches: committedNewTorrents.map((t) => ({
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
