import { shallowReactive } from "vue";

import type { TSiteHost, TSiteID } from "@ptd/site";
import type { CTorrent } from "@ptd/downloader";

import { sendMessage } from "@/messages.ts";
import { useMetadataStore } from "@/options/stores/metadata.ts";

/**
 * 根据种子内的 tracker 地址识别其所属站点
 *
 * 识别规则：
 * 1. 优先使用下载器返回种子列表时顺带给出的 tracker（CTorrent.trackerUrls），
 *    没有时再调用 `getClientTorrentTrackers` 向下载器请求（结果会被缓存）
 * 2. 客户端明确告知为公开种子（isPrivate === false）时不请求 tracker，直接判定为 public
 * 3. 将 tracker 地址的 host（及其各级父域名）在
 *    已添加站点的 urls / legacyUrls / trackerUrls 的 host 中进行匹配：
 *    - 匹配到私有站点 → site
 *    - 匹配到公开站点 → public
 *    - 其余（含无 tracker / 未匹配）→ unmatched
 *
 * 判定在种子列表加载完成时（MyClient 的 loadSingleDownloader）统一触发。
 *
 * 与上游的差异：fork 的 `torrents` 是 shallowRef + markRaw（P1-20，避免数千个种子被深度代理），
 * 不能把结果写回种子对象（写了也不会触发表格更新）。这里把结果放进按种子身份索引的
 * shallowReactive 缓存，表格单元格通过 `getCachedTorrentSiteMatch` 读取：只有被写入的那一行会重新渲染，
 * 自动刷新整体替换种子列表时缓存依旧命中，不会闪一次加载态。
 */

/** 判定结果 */
export type TTorrentSiteMatch =
  | { type: "site"; siteId: TSiteID } // 匹配到已添加的私有站点
  | { type: "public" } // 公开种子（客户端明确标记，或其 tracker 属于公开站点）
  | { type: "unmatched" }; // 未匹配到任何已添加站点

interface ISiteMatchCacheEntry {
  /**
   * 判定时使用的 siteHostMap；站点映射被重建（新增 / 编辑站点）后据此判定缓存失效。
   * null 表示该结果是判定出错时的兜底值，永不视为有效（下一次刷新会重新判定）。
   */
  hostMap: Record<TSiteHost, TSiteID> | null;
  match: TTorrentSiteMatch;
}

/** 站点判定结果缓存（key: `clientId:infoHash`）；shallowReactive 使单元格能按 key 订阅 */
const siteMatchCache = shallowReactive(new Map<string, ISiteMatchCacheEntry>());

/** 种子 tracker 列表缓存（key 同上），避免重复请求下载器 */
const trackerUrlsCache = new Map<string, string[]>();

/** 同一个种子的 tracker 请求合并 */
const pendingTrackerRequests = new Map<string, Promise<string[]>>();

/** 正在判定中的种子（自动刷新与手动刷新重叠时避免重复判定） */
const resolvingKeys = new Set<string>();

/** 站点类型缓存，避免重复加载站点定义 */
const siteTypeCache = new Map<TSiteID, "private" | "public">();

/** 判定并发上限（同时也是并发 tracker 请求数上限） */
const MAX_CONCURRENT_RESOLVE = 4;

function getTorrentCacheKey(torrent: CTorrent): string {
  return `${torrent.clientId}:${torrent.infoHash || torrent.id}`;
}

/** 获取种子的 tracker 地址列表（优先使用下载器已返回的数据，否则向下载器请求） */
async function getTorrentTrackerUrls(torrent: CTorrent): Promise<string[]> {
  if (torrent.trackerUrls?.length) {
    return torrent.trackerUrls;
  }

  // 已知为公开种子，无需（也不应该）再请求 tracker
  if (torrent.isPrivate === false) {
    return [];
  }

  const cacheKey = getTorrentCacheKey(torrent);
  const cached = trackerUrlsCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  let pending = pendingTrackerRequests.get(cacheKey);
  if (!pending) {
    pending = (async () => {
      try {
        return (await sendMessage("getClientTorrentTrackers", { downloaderId: torrent.clientId, torrent })) ?? [];
      } catch {
        return [];
      }
    })();
    pendingTrackerRequests.set(cacheKey, pending);
  }

  const trackerUrls = await pending;
  pendingTrackerRequests.delete(cacheKey);
  trackerUrlsCache.set(cacheKey, trackerUrls);
  return trackerUrls;
}

/**
 * 生成 host 及其各级父域名（如 tracker.a.com → ["tracker.a.com", "a.com"]），
 * 用于兼容站点使用 tracker 子域名的情况；不包含顶级域名，避免误匹配
 */
export function getHostCandidates(host: TSiteHost): string[] {
  const candidates: string[] = [];
  const [hostname, port] = host.split(":");
  const parts = hostname.split(".");
  for (let i = 0; i <= parts.length - 2; i++) {
    const candidate = parts.slice(i).join(".");
    candidates.push(candidate);
    if (port) {
      candidates.push(`${candidate}:${port}`);
    }
  }
  return candidates;
}

async function getSiteType(siteId: TSiteID): Promise<"private" | "public"> {
  const cached = siteTypeCache.get(siteId);
  if (cached) {
    return cached;
  }

  let siteType: "private" | "public" = "public";
  try {
    siteType = (await useMetadataStore().getSiteMetadata(siteId))?.type ?? "public";
  } catch {
    siteType = "public";
  }
  siteTypeCache.set(siteId, siteType);
  return siteType;
}

async function resolveTorrentSiteMatch(torrent: CTorrent): Promise<TTorrentSiteMatch> {
  const metadataStore = useMetadataStore();

  // 客户端已明确告知为公开种子
  if (torrent.isPrivate === false) {
    return { type: "public" };
  }

  const trackerUrls = await getTorrentTrackerUrls(torrent);
  if (trackerUrls.length === 0) {
    return { type: "unmatched" };
  }

  // 正常情况下 siteHostMap 已由 buildSiteHostMap 生成，此处兜底重建
  if (Object.keys(metadataStore.siteHostMap).length === 0 && metadataStore.getAddedSiteIds.length > 0) {
    await metadataStore.buildSiteMapCache();
  }

  let matchedPublicSite = false;

  for (const trackerUrl of trackerUrls) {
    let host: TSiteHost;
    try {
      host = new URL(trackerUrl).host;
    } catch {
      continue;
    }

    for (const candidate of getHostCandidates(host)) {
      const siteId = metadataStore.siteHostMap[candidate];
      if (!siteId) {
        continue;
      }
      if ((await getSiteType(siteId)) === "private") {
        return { type: "site", siteId };
      }
      matchedPublicSite = true;
    }
  }

  return matchedPublicSite ? { type: "public" } : { type: "unmatched" };
}

function getValidCacheEntry(torrent: CTorrent): ISiteMatchCacheEntry | undefined {
  const cached = siteMatchCache.get(getTorrentCacheKey(torrent));
  return cached && cached.hostMap === useMetadataStore().siteHostMap ? cached : undefined;
}

/**
 * 读取种子的站点判定结果（供表格单元格渲染，响应式）
 *
 * 返回 undefined 表示尚未判定完成。站点映射重建后旧结果仍先展示，直到下一次判定写入新结果，
 * 避免整列同时回到加载态。
 */
export function getCachedTorrentSiteMatch(torrent: CTorrent): TTorrentSiteMatch | undefined {
  return siteMatchCache.get(getTorrentCacheKey(torrent))?.match;
}

/** 获取种子与站点的匹配结果（结果按 torrent + siteHostMap 缓存） */
export async function getTorrentSiteMatch(torrent: CTorrent): Promise<TTorrentSiteMatch> {
  const cached = getValidCacheEntry(torrent);
  if (cached) {
    return cached.match;
  }

  const match = await resolveTorrentSiteMatch(torrent);
  // 重新读取 siteHostMap，兼容 resolve 过程中兜底重建映射的情况
  siteMatchCache.set(getTorrentCacheKey(torrent), { hostMap: useMetadataStore().siteHostMap, match });
  return match;
}

/**
 * 对一批种子进行站点判定，结果写入响应式缓存（对应行会随之刷新）
 *
 * 由 MyClient 的 loadSingleDownloader 在拿到种子列表后调用，避免在表格单元格中逐个判定；
 * 已有有效缓存或正在判定中的种子会被跳过，因此自动刷新只会判定新出现的种子。
 */
export async function annotateTorrentSites(torrents: readonly CTorrent[] | null | undefined): Promise<void> {
  // 下载器异常时 getClientTorrents 可能回空值；这里是 fire-and-forget 调用，不能抛出未处理的 rejection
  if (!Array.isArray(torrents)) return;
  const queue = torrents.filter((torrent) => {
    const key = getTorrentCacheKey(torrent);
    return !resolvingKeys.has(key) && !getValidCacheEntry(torrent);
  });
  for (const torrent of queue) {
    resolvingKeys.add(getTorrentCacheKey(torrent));
  }

  let cursor = 0;
  const worker = async () => {
    while (cursor < queue.length) {
      const torrent = queue[cursor++];
      try {
        await getTorrentSiteMatch(torrent);
      } catch {
        // 判定失败不影响其他种子：该行先显示「未匹配」而不是一直转圈，下一次刷新时会重新判定
        siteMatchCache.set(getTorrentCacheKey(torrent), { hostMap: null, match: { type: "unmatched" } });
      } finally {
        resolvingKeys.delete(getTorrentCacheKey(torrent));
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT_RESOLVE, queue.length) }, worker));
}

/** 清空所有判定相关缓存（仅供测试隔离使用） */
export function resetTorrentSiteCaches(): void {
  siteMatchCache.clear();
  trackerUrlsCache.clear();
  pendingTrackerRequests.clear();
  resolvingKeys.clear();
  siteTypeCache.clear();
}
