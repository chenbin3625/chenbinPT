import { computed } from "vue";
import { definitionList, type ISiteUserConfig, type TSiteID } from "@ptd/site";
import {
  siteMetadataIndex,
  type ISiteMetadataIndexEntry,
  type TSiteMetadataIndexEntryWithId,
} from "@ptd/site/metadataIndex";

import { useMetadataStore } from "@/options/stores/metadata.ts";

/**
 * 尚未添加的站点（按 definitionList 顺序）。
 *
 * 这里原来是逐个 `getSiteMetadata()` 解析完整站点定义：409 个独立 chunk / 约 1.4 MB，
 * 实测顺序加载 828~884 ms，而并发加载实测 934 ms **没有收益**（瓶颈是解析这些 chunk 的 CPU，
 * 不是 I/O）。改用构建期轻量索引后只有约 117 KB，一次 import 即可同步得到整张列表，
 * 「一键导入」与「添加站点」两个对话框因此都不再需要渐进加载。
 *
 * 索引条目本身不存 id（key 就是它），这里是唯一需要「带 id 的 value 数组」的地方，
 * 所以在取值时用 key 补上 —— 也顺便让 id 的唯一来源就是 key。
 * 索引里没有的 id（只会在构建生成异常时出现）直接跳过，避免往下游传半个条目。
 */
export function getCanAddedSiteIndexEntries(): TSiteMetadataIndexEntryWithId[] {
  const metadataStore = useMetadataStore();
  const addedSiteIds = new Set(metadataStore.getAddedSiteIds);
  return definitionList
    .filter((siteId) => !addedSiteIds.has(siteId) && !!siteMetadataIndex[siteId])
    .map((siteId) => ({ id: siteId, ...siteMetadataIndex[siteId] }));
}

export interface ISiteTableItem {
  id: TSiteID;
  /** 只放构建期轻量索引条目：站点表格只读固定属性，需要完整定义的地方（编辑器）自行按 id 取 */
  metadata: ISiteMetadataIndexEntry;
  userConfig: ISiteUserConfig;
}

/**
 * 索引里没有该站点时给表格用的占位条目。
 *
 * 上游（8c6022c98c）的做法是把这类行直接从表格里过滤掉，但那样用户就**无法删除**一个
 * 「站点定义已从构建产物移除」的旧配置（fork 的 OPTIONSSHELL-2 专门为这种情况加了提示）。
 * 这里保留该行，只把只读元数据退化为占位值，删除 / 开关等操作照常可用。
 */
const UNAVAILABLE_SITE_INDEX_ENTRY: ISiteMetadataIndexEntry = { name: "", type: "public", urls: [] };

/**
 * 已添加站点的表格数据（同步）。
 *
 * 改成普通 `computed`：站点元数据来自构建期轻量索引，不再需要 `computedAsync` 的异步加载态，
 * 首屏也不会有「空表格 → 突然填充」的抖动（因此不再需要 `isLoadingAddedSiteInfo`）。
 */
export const allAddedSiteInfo = computed<ISiteTableItem[]>(() => {
  const metadataStore = useMetadataStore();

  const sitesReturn: ISiteTableItem[] = [];
  for (const [siteId, siteUserConfig] of Object.entries(metadataStore.sites)) {
    const indexEntry = siteMetadataIndex[siteId];
    sitesReturn.push({
      id: siteId,
      metadata: indexEntry ?? { ...UNAVAILABLE_SITE_INDEX_ENTRY, name: siteId },
      userConfig: siteUserConfig,
    });
  }

  return sitesReturn;
});
