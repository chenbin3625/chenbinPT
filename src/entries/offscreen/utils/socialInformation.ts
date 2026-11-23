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
 * 缓存失效代际追踪：clearSocialInformation / deleteSocialInformation 清掉 IndexedDB 后，
 * `@ptd/social` 进程内仍有 10 分钟的 `socialInformationInFlight` 缓存；
 * 通过记录失效代际并在下次读取时透传 `force: true`，强制 `@ptd/social` 绕过并覆盖旧条目。
 */
let cacheInvalidationEpoch = 0;
let lastFullClearEpoch = 0;
const deletedPrefixEpoch = new Map<string, number>();
const deletedStorageKeyEpoch = new Map<string, number>();
const refreshedStorageKeyEpoch = new Map<string, number>();
const MAX_INVALIDATION_TRACKING_ENTRIES = 1000;

function setBoundedMapEntry<K, V>(map: Map<K, V>, key: K, value: V): void {
  if (map.has(key)) {
    map.delete(key);
  }
  map.set(key, value);
  if (map.size > MAX_INVALIDATION_TRACKING_ENTRIES) {
    const oldestKey = map.keys().next().value;
    if (oldestKey !== undefined) {
      map.delete(oldestKey);
    }
  }
}

function getRequiredInvalidationEpoch(site: TSupportSocialSite$1, sid: string, storageKey: string): number {
  const prefix = `${site}:${sid}`;
  return Math.max(lastFullClearEpoch, deletedPrefixEpoch.get(prefix) ?? 0, deletedStorageKeyEpoch.get(storageKey) ?? 0);
}

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
    // keys / values 必须来自同一个只读事务：两次独立读取之间可能有新条目写入，
    // 导致按下标配对错位、误删刚写入的缓存。
    const readTx = db.transaction("social_information");
    const [keys, values] = await Promise.all([
      readTx.store.getAllKeys(),
      readTx.store.getAll() as Promise<ISocialInformation[]>,
    ]);
    await readTx.done;
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
    const requiredEpoch = getRequiredInvalidationEpoch(site, sid, key);
    const refreshedEpoch = refreshedStorageKeyEpoch.get(key) ?? 0;
    const forceForInvalidation = requiredEpoch > refreshedEpoch;
    const effectiveForce = options.force === true || forceForInvalidation;

    if (effectiveForce && requiredEpoch > 0) {
      // 同步记录已刷新代际：getSocialSiteInformation 在首个 await 前就会覆盖进程内缓存，
      // 并发到来的同 key 请求仍可复用本次新发起的 in-flight Promise，不会重复请求远端。
      setBoundedMapEntry(refreshedStorageKeyEpoch, key, requiredEpoch);
    }

    // 强制刷新或缓存失效后必须一路透传到 social 包的进程内缓存：否则只绕过 IndexedDB，
    // 仍可能命中 getSocialSiteInformation 的 10 分钟缓存，force / 清缓存相当于无效。
    try {
      stored = await getSocialSiteInformation(site, sid, { ...socialInformationConfig, force: effectiveForce });
    } catch (error) {
      if (forceForInvalidation && refreshedStorageKeyEpoch.get(key) === requiredEpoch) {
        refreshedStorageKeyEpoch.delete(key);
      }
      throw error;
    }

    const invalidatedDuringFetch = getRequiredInvalidationEpoch(site, sid, key) > requiredEpoch;
    if (!invalidatedDuringFetch) {
      if (shouldMarkEnrichmentAttempted) {
        enrichmentAttemptedKeys.add(key);
      }
      if (stored && (stored.title !== "" || stored.poster !== "")) {
        await setSocialInformation(site, sid, stored, fingerprint);
      }
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

export async function deleteSocialInformation(site: TSupportSocialSite$1, sid: string, fingerprint: string = "") {
  cacheInvalidationEpoch += 1;
  const prefix = `${site}:${sid}`;
  const db = await ptdIndexDb;
  if (fingerprint) {
    const storageKey = getSocialInformationStorageKey(site, sid, fingerprint);
    enrichmentAttemptedKeys.delete(storageKey);
    refreshedStorageKeyEpoch.delete(storageKey);
    setBoundedMapEntry(deletedStorageKeyEpoch, storageKey, cacheInvalidationEpoch);
    return await db.delete("social_information", storageKey);
  }

  // 未指定 fingerprint 时删除该 sid 的全部缓存：只删 `${site}:${sid}` 命不中
  // 实际以 `${site}:${sid}:${fingerprint}` 存储的条目。
  for (const attemptedKey of enrichmentAttemptedKeys) {
    if (attemptedKey === prefix || attemptedKey.startsWith(`${prefix}:`)) {
      enrichmentAttemptedKeys.delete(attemptedKey);
    }
  }
  for (const refreshedKey of refreshedStorageKeyEpoch.keys()) {
    if (refreshedKey === prefix || refreshedKey.startsWith(`${prefix}:`)) {
      refreshedStorageKeyEpoch.delete(refreshedKey);
    }
  }
  setBoundedMapEntry(deletedPrefixEpoch, prefix, cacheInvalidationEpoch);

  const keys = await db.getAllKeys("social_information");
  const targetKeys = keys.filter((key) => key === prefix || key.startsWith(`${prefix}:`));
  if (targetKeys.length === 0) return;
  const tx = db.transaction("social_information", "readwrite");
  await Promise.all(targetKeys.map((key) => tx.store.delete(key)));
  await tx.done;
}

export async function clearSocialInformation() {
  cacheInvalidationEpoch += 1;
  lastFullClearEpoch = cacheInvalidationEpoch;
  enrichmentAttemptedKeys.clear();
  deletedPrefixEpoch.clear();
  deletedStorageKeyEpoch.clear();
  refreshedStorageKeyEpoch.clear();
  return await (await ptdIndexDb).clear("social_information");
}

onMessage("clearSocialInformationCache", async () => {
  await clearSocialInformation();
});
