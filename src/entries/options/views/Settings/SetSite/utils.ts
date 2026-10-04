import { computedAsync } from "@vueuse/core";
import { ref } from "vue";
import { definitionList, ISiteMetadata, type ISiteUserConfig, TSiteID } from "@ptd/site";

import { useMetadataStore } from "@/options/stores/metadata.ts";
import { getCachedSiteMetadata } from "@/options/views/Overview/MyData/utils/siteMetadataCache.ts";

/**
 * P1-21/P2-16：站点定义加载改为「memo + 分批并发」。
 * 原来 341 个站点串行 await（每个都要动态 import + cloneDeep 整份定义），打开「添加站点」要等很久；
 * 现在每批 20 个并发，且同一个站点的定义在整个 options 生命周期内只加载一次。
 */
const SITE_METADATA_CONCURRENCY = 20;

async function loadSiteMetadataInBatches<T>(
  items: T[],
  loader: (item: T) => Promise<ISiteMetadata>,
): Promise<ISiteMetadata[]> {
  const results: ISiteMetadata[] = [];
  for (let i = 0; i < items.length; i += SITE_METADATA_CONCURRENCY) {
    const batch = items.slice(i, i + SITE_METADATA_CONCURRENCY);
    results.push(...(await Promise.all(batch.map((item) => loader(item)))));
  }
  return results;
}

export async function getCanAddedSiteMetadata() {
  const canAddedSiteMetadata: Record<TSiteID, ISiteMetadata> = {};
  const metadataStore = useMetadataStore();
  const canAddedSiteList = definitionList.filter((x) => !metadataStore.getAddedSiteIds.includes(x));
  const metadatas = await loadSiteMetadataInBatches(canAddedSiteList, (siteId) => getCachedSiteMetadata(siteId));
  canAddedSiteList.forEach((siteId, index) => {
    canAddedSiteMetadata[siteId] = metadatas[index]!;
  });
  return canAddedSiteMetadata;
}

export interface ISiteTableItem {
  id: TSiteID;
  metadata: ISiteMetadata;
  userConfig: ISiteUserConfig;
}

/**
 * `allAddedSiteInfo` 的加载标识。
 *
 * computedAsync 自身不暴露 loading 状态，而这里逐个 await 站点元数据可能耗时较久，
 * 首屏若不显示 loading 就会出现「空表格 → 突然填充」的抖动，因此在回调内手动置位。
 */
export const isLoadingAddedSiteInfo = ref<boolean>(false);

export const allAddedSiteInfo = computedAsync<ISiteTableItem[]>(async () => {
  isLoadingAddedSiteInfo.value = true;
  try {
    const metadataStore = useMetadataStore();
    // noinspection BadExpressionStatementJS
    Object.values(metadataStore.sites).map((x) => x);

    const siteEntries = Object.entries(metadataStore.sites);
    // P1-21：站点定义走 memo + 分批并发（顺序与原来一致）
    const metadatas = await loadSiteMetadataInBatches(siteEntries, ([siteId]) => getCachedSiteMetadata(siteId));

    return siteEntries.map(([siteId, siteUserConfig], index) => ({
      id: siteId,
      metadata: metadatas[index]!,
      userConfig: siteUserConfig,
    }));
  } finally {
    isLoadingAddedSiteInfo.value = false;
  }
});
