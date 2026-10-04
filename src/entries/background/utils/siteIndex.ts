/**
 * 站点索引（siteIndex）自愈（见 docs/performance-audit.md P2-17）。
 *
 * `metadata.siteHostMap` / `siteNameMap` 是给 content script 与右键菜单用的两个小表，
 * 但读取它们需要反序列化整份 metadata（可达数百 KB ~ MB，且会被用户信息刷新等
 * 高频写入反复失效）。因此 options 侧在重建映射时会额外写一份独立的 `siteIndex` 小 key。
 *
 * 对于"升级前就已经有站点、之后没再改过站点"的用户，`siteIndex` 会缺失，
 * 这里在 service worker 启动时按需从 metadata 派生一次（只做一次小 key 的存在性检查，
 * 已存在时零额外开销）。
 */
import { getExtStorageCached, getExtStoragePathCached, patchExtStoragePathLocal } from "./base.ts";
import type { IMetadataPiniaStorageSchema } from "@/shared/types/storages/metadata.ts";

/**
 * 判断 siteIndex 里的映射是否「可用」。
 *
 * 空对象 `{}` 不能算有效索引：只要 `typeof value === "object"` 就 return 会让上一轮留下的空表
 * 被永久当成有效索引，过期/为空的索引永远不会重建；而读取方（content script 只检查
 * `!siteHostMap`）也不会回落到 metadata，页面就识别不到站点。空表一律视为缺失。
 */
export function isUsableSiteIndexMap(value: unknown): boolean {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 0;
}

export async function ensureSiteIndex(): Promise<void> {
  try {
    const existingHostMap = await getExtStoragePathCached("siteIndex", "siteHostMap", undefined as unknown);
    const existingNameMap = await getExtStoragePathCached("siteIndex", "siteNameMap", undefined as unknown);
    if (isUsableSiteIndexMap(existingHostMap) && isUsableSiteIndexMap(existingNameMap)) {
      return; // 已生成过且有内容，无需再读 metadata
    }

    const metadata = ((await getExtStorageCached("metadata")) as IMetadataPiniaStorageSchema | undefined) ?? undefined;
    const siteHostMap = metadata?.siteHostMap ?? {};
    const siteNameMap = metadata?.siteNameMap ?? {};

    if (Object.keys(siteHostMap).length === 0 && Object.keys(siteNameMap).length === 0) {
      return; // 还没有任何站点，等 options 侧首次重建即可
    }

    // 先把无效的空表清成 null，再写入重建结果：
    // 这样在重建完成前读取方不会把空表当成有效索引，而会按「缺失」回落到 metadata
    // （content script 侧判断为 `!siteHostMap`；右键菜单侧同样会回落）。
    if (!isUsableSiteIndexMap(existingHostMap)) {
      await patchExtStoragePathLocal("siteIndex", "siteHostMap", null);
    }
    if (!isUsableSiteIndexMap(existingNameMap)) {
      await patchExtStoragePathLocal("siteIndex", "siteNameMap", null);
    }

    await patchExtStoragePathLocal("siteIndex", "siteHostMap", siteHostMap);
    await patchExtStoragePathLocal("siteIndex", "siteNameMap", siteNameMap);
    console.debug("[PTD] siteIndex 已按需生成");
  } catch (e) {
    // 索引只是加速手段，失败不影响任何功能（读取方会回落到 metadata）
    console.warn("[PTD] ensureSiteIndex failed:", e);
  }
}

// noinspection JSIgnoredPromiseFromCall
void ensureSiteIndex();
