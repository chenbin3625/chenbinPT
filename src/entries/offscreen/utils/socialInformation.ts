import type { ISocialInformation, TSupportSocialSite$1 } from "@ptd/social";
import { getSocialSiteInformation, matchSocialPageUrl } from "@ptd/social";

import { onMessage, sendMessage } from "@/messages.ts";
import type { IConfigPiniaStorageSchema } from "@/shared/types.ts";

import { ptdIndexDb } from "../adapter/indexdb.ts";
import { logger } from "../utils/logger.ts";

interface IGetSocialInformationOptions {
  force?: boolean;
  requireSummary?: boolean;
  requireMetadata?: boolean;
}

// 记录本次会话中已经因缺失字段联网重取过的 key，避免对源本身就不提供
// 简介/元数据的条目在每次调用时反复联网（绕过 cacheDay TTL）。
const enrichmentAttemptedKeys = new Set<string>();

/**
 * 影响抓取结果的配置指纹。IndexedDB 的旧 key 只有 `site:sid`，
 * 用户改了 ptGenEndpoint / preferPtGen / socialSite 后仍会命中旧缓存直到 cacheDay 过期。
 * cacheDay 只控制 TTL、force 只表示绕过缓存，二者不参与指纹（与 social 包的进程内 key 一致）。
 * socialSite 里有 API key，所以只把哈希写进 key。
 */
async function getSocialConfigFingerprint(config: IConfigPiniaStorageSchema["socialSiteInformation"]): Promise<string> {
  const payload = JSON.stringify({
    preferPtGen: config?.preferPtGen,
    ptGenEndpoint: config?.ptGenEndpoint,
    timeout: config?.timeout,
    socialSite: config?.socialSite,
  });
  try {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
    return Array.from(new Uint8Array(digest).slice(0, 8), (byte) => byte.toString(16).padStart(2, "0")).join("");
  } catch {
    // 没有 subtle（非安全上下文）时退化为不指纹化，行为与旧实现一致
    return "";
  }
}

function getSocialInformationStorageKey(site: TSupportSocialSite$1, sid: string, fingerprint: string): string {
  return fingerprint ? `${site}:${sid}:${fingerprint}` : `${site}:${sid}`;
}

/**
 * 过期条目以前只在读取时被忽略、永不删除；推荐列表不断产生新 key，IndexedDB 会无限增长。
 * 每个 offscreen 会话清理一次（尽力而为，失败不影响读取）。
 */
let socialCachePruneStarted = false;
async function pruneExpiredSocialInformation(cacheDay: number): Promise<void> {
  if (socialCachePruneStarted) return;
  socialCachePruneStarted = true;
  try {
    const db = await ptdIndexDb;
    const keys = await db.getAllKeys("social_information");
    const values = (await db.getAll("social_information")) as ISocialInformation[];
    const cutoff = Date.now() - 86_400_000 * Math.max(cacheDay, 0);
    const expiredKeys = keys.filter((_key, index) => (values[index]?.createAt ?? 0) < cutoff);
    if (expiredKeys.length === 0) return;
    const tx = db.transaction("social_information", "readwrite");
    await Promise.all(expiredKeys.map((key) => tx.store.delete(key)));
    await tx.done;
  } catch {
    // 清理失败下次会话再试
  }
}

export async function getSocialInformation(
  site: TSupportSocialSite$1,
  sid: string,
  options: IGetSocialInformationOptions = {},
): Promise<ISocialInformation> {
  // 只取 socialSiteInformation 子表（见 docs/performance-audit.md P0-2）
  const socialInformationConfig = ((await sendMessage("getExtStoragePath", {
    key: "config",
    path: "socialSiteInformation",
    defaultValue: {},
  })) ?? {}) as IConfigPiniaStorageSchema["socialSiteInformation"];

  void pruneExpiredSocialInformation(socialInformationConfig.cacheDay ?? 3);
  const fingerprint = await getSocialConfigFingerprint(socialInformationConfig);
  const key = getSocialInformationStorageKey(site, sid, fingerprint);
  let stored = await (await ptdIndexDb).get("social_information", key);

  const isExpired = stored && stored.createAt < Date.now() - 86400000 * (socialInformationConfig.cacheDay ?? 3);
  // 仅在本会话尚未因缺失字段重取过该 key 时才允许补取，避免源本身无数据时反复联网。
  const canRetryForMissingFields = !enrichmentAttemptedKeys.has(key);
  const isMissingRequiredSummary = canRetryForMissingFields && options.requireSummary && stored && !stored.summary;
  const isMissingRequiredMetadata =
    canRetryForMissingFields &&
    options.requireMetadata &&
    stored &&
    (!stored.releaseYear || !stored.region || !stored.genres?.length);

  const shouldMarkEnrichmentAttempted = isMissingRequiredSummary || isMissingRequiredMetadata;

  if (options.force || !stored || isExpired || shouldMarkEnrichmentAttempted) {
    // 强制刷新必须一路透传到 social 包的进程内缓存：否则只绕过 IndexedDB，
    // 仍可能命中 getSocialSiteInformation 的 10 分钟缓存，force 相当于无效。
    stored = await getSocialSiteInformation(site, sid, { ...socialInformationConfig, force: options.force === true });
    if (shouldMarkEnrichmentAttempted) {
      enrichmentAttemptedKeys.add(key);
    }
    if (stored && (stored.title !== "" || stored.poster !== "")) {
      await setSocialInformation(site, sid, stored, fingerprint);
    }
    logger({ msg: `getSocialInformation for ${site} with sid: ${sid}`, data: stored });
  }

  return stored as ISocialInformation;
}

onMessage("getSocialInformation", async ({ data: { site, sid } }) => await getSocialInformation(site, sid));

// content-script 引导的轻量预筛：social 包的正则聚合在本上下文已有完整依赖，
// 由这里判断后回传命中的社交站点名，引导无需携带 social 包（见 issue #1467）
onMessage("matchSocialPage", async ({ data: url }) => {
  return matchSocialPageUrl(url);
});

export async function setSocialInformation(
  site: TSupportSocialSite$1,
  sid: string,
  val: ISocialInformation,
  fingerprint: string = "",
) {
  const key = getSocialInformationStorageKey(site, sid, fingerprint);
  return await (await ptdIndexDb).put("social_information", val, key);
}

export async function deleteSocialInformation(site: TSupportSocialSite$1, sid: string) {
  const key = `${site}:${sid}`;
  return await (await ptdIndexDb).delete("social_information", key);
}

export async function clearSocialInformation() {
  return await (await ptdIndexDb).clear("social_information");
}

onMessage("clearSocialInformationCache", async () => {
  await clearSocialInformation();
});
