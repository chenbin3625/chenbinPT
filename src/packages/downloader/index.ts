import { AbstractBittorrentClient, type DownloaderBaseConfig, type TorrentClientMetaData } from "./types";
import { cloneDeep } from "es-toolkit";

export * from "./types";
// 注意：getRemoteTorrentFile 不再从根入口转发导出（见 docs/performance-audit.md P2-1）：
// 根入口被 content script 使用，转发导出会让 cs-app 静态依赖 utils.ts（parse-torrent / buffer polyfill 等）。
// 需要该方法的调用方请直接从 "@ptd/downloader/utils.ts" 导入。

interface downloaderEntity {
  default: AbstractBittorrentClient;
  clientConfig: DownloaderBaseConfig;
  clientMetaData: TorrentClientMetaData;
}

export const requireContext = import.meta.glob<downloaderEntity>("./entity/*.ts");
export const entityList = Object.keys(requireContext).map((value: string) => {
  return value.replace(/^\.\/entity\//, "").replace(/\.ts$/, "");
}) as string[];

// 从 requireContext 中获取对应模块
export async function getDownloaderModule(configType: string): Promise<downloaderEntity> {
  return await requireContext[`./entity/${configType}.ts`]();
}

export async function getDownloaderDefaultConfig(type: string): Promise<DownloaderBaseConfig> {
  const config = cloneDeep((await getDownloaderModule(type)).clientConfig);
  // 填入/覆盖 缺失项
  config.feature ??= {};
  config.feature.DefaultAutoStart ??= false;
  config.feature.BypassCSRF ??= false;

  return config;
}

export async function getDownloaderMetaData(type: string): Promise<TorrentClientMetaData> {
  return cloneDeep((await getDownloaderModule(type)).clientMetaData);
}

/**
 * 以连接/协议相关配置的稳定序列化作为 key 缓存下载器实例：
 * 连接握手（Deluge / uTorrent / Synology 等的会话）与已建立的长连接（Aria2 的 WS）都保存在实例内，
 * 每次操作都 `new` 一个实例会重复握手，且旧实例的连接不会关闭。
 *
 * 这些字段任意变化都会得到新的 key，从而自动失效；
 * UI 侧字段（name / enabled / suggestFolders / suggestTags 等）变化不会影响实例行为，故不参与 key。
 * 调用方（如 offscreen 的 downloaderInstanceCache）仍可自行决定是否复用实例。
 */
const downloaderInstanceCache = new Map<string, AbstractBittorrentClient>();
const MAX_CACHED_DOWNLOADER_INSTANCES = 16;

function stableSerialize(value: any): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "undefined";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`)
    .join(",")}}`;
}

function getDownloaderInstanceCacheKey(config: DownloaderBaseConfig): string {
  const { id, type, address, username, password, timeout, feature, advanceAddTorrentOptions } = config;
  return stableSerialize({ id, type, address, username, password, timeout, feature, advanceAddTorrentOptions });
}

export async function getDownloader(config: DownloaderBaseConfig): Promise<AbstractBittorrentClient> {
  const cacheKey = getDownloaderInstanceCacheKey(config);
  const cached = downloaderInstanceCache.get(cacheKey);
  if (cached) {
    // LRU：命中后重新插入，保证最近使用的实例排在末尾
    downloaderInstanceCache.delete(cacheKey);
    downloaderInstanceCache.set(cacheKey, cached);
    return cached;
  }

  const DownloaderClass = (await getDownloaderModule(config.type)).default;

  // @ts-expect-error
  // 原因：DownloaderClass 来自动态 import 的实体模块，其构造签名无法被静态收窄（构造后已断言为 AbstractBittorrentClient）
  const instance = new DownloaderClass(config) as AbstractBittorrentClient;

  downloaderInstanceCache.set(cacheKey, instance);
  if (downloaderInstanceCache.size > MAX_CACHED_DOWNLOADER_INSTANCES) {
    // 这里只淘汰最久未使用的引用，不主动 dispose()：
    // offscreen 的 downloaderInstanceCache 没有淘汰机制，被淘汰的实例可能仍被其持有，
    // 主动关闭会破坏调用方仍在使用中的连接。实例不再使用时可由持有者调用 dispose() 释放。
    const oldestKey = downloaderInstanceCache.keys().next().value;
    if (oldestKey !== undefined && oldestKey !== cacheKey) {
      downloaderInstanceCache.delete(oldestKey);
    }
  }

  return instance;
}

export function getDownloaderIcon(type: string) {
  return `/icons/downloader/${type}.png`;
}
