import { effectScope, shallowReactive, watch } from "vue";

import { type ISiteMetadata, type TSiteID } from "@ptd/site";

import { useMetadataStore } from "@/options/stores/metadata.ts";

/**
 * P1-21：站点元数据 memo。
 *
 * `metadataStore.getSiteMetadata(siteId)` 内部是「动态 import 站点定义 + cloneDeep 整份定义」，
 * 没有任何缓存；而 MyData（每行 2 个 computedAsync）、SetSite（341 个站点串行）、Topbar
 * 都会反复调用它。这里做模块级的 Promise memo：同一个站点只动态 import / clone 一次。
 *
 * 只缓存「站点定义」本身。用户覆盖（`siteConfig.merge`）不在这里缓存，
 * 由 getCachedSiteMergedMetadata 每次从 store 读取，保证站点编辑器里的覆盖仍然生效。
 */
const siteMetadataPromiseCache = new Map<TSiteID, Promise<ISiteMetadata>>();

export function getCachedSiteMetadata(siteId: TSiteID): Promise<ISiteMetadata> {
  let cached = siteMetadataPromiseCache.get(siteId);
  if (!cached) {
    cached = useMetadataStore().getSiteMetadata(siteId);
    // 失败时不要把 rejected 的 Promise 留在缓存里，否则该站点永远无法重试
    cached.catch(() => {
      if (siteMetadataPromiseCache.get(siteId) === cached) siteMetadataPromiseCache.delete(siteId);
    });
    siteMetadataPromiseCache.set(siteId, cached);
  }
  return cached;
}

/**
 * 与 `metadataStore.getSiteMergedMetadata` 语义一致（userConfig.merge 优先，其次站点定义，最后默认值），
 * 但站点定义走上面的 memo。
 */
export async function getCachedSiteMergedMetadata<T extends keyof ISiteMetadata>(
  siteId: TSiteID,
  field: T,
  defaultValue?: ISiteMetadata[T],
): Promise<ISiteMetadata[T]> {
  const metadataStore = useMetadataStore();
  const siteConfig = await metadataStore.getSiteUserConfig(siteId);
  if (siteConfig.merge?.[field]) {
    return siteConfig.merge[field] as ISiteMetadata[T];
  }
  const siteMetadata = await getCachedSiteMetadata(siteId);
  return (siteMetadata[field] ?? defaultValue) as ISiteMetadata[T];
}

/** 表格行所需要的、来自站点定义的只读字段 */
export interface ISiteLevelMetadata {
  levelRequirements: NonNullable<ISiteMetadata["levelRequirements"]>;
  userInfo: ISiteMetadata["userInfo"];
}

const EMPTY_SITE_LEVEL_METADATA: ISiteLevelMetadata = { levelRequirements: [], userInfo: undefined };

/**
 * 行级合并元数据缓存：MyData 表格每行原本各挂 2 个 computedAsync，
 * 20 行就是 40 个异步副作用 + 40 次站点定义深拷贝。改为所有行共享这个模块级缓存。
 */
const siteLevelMetadata = shallowReactive<Record<TSiteID, ISiteLevelMetadata>>({});
const loadingSiteLevelMetadata = new Set<TSiteID>();
let invalidationScope: ReturnType<typeof effectScope> | undefined;

/**
 * 站点用户配置（merge）变化时整体失效，等价于原来 computedAsync 对 `state.sites[siteId]` 的响应性。
 * 用 detached 的 effectScope 持有这个 watcher，避免被某个组件的卸载连带停止。
 */
function ensureInvalidationWatch() {
  if (invalidationScope) return;
  invalidationScope = effectScope(true);
  invalidationScope.run(() => {
    const metadataStore = useMetadataStore();
    watch(
      () => metadataStore.sites,
      () => {
        for (const siteId of Object.keys(siteLevelMetadata)) {
          delete siteLevelMetadata[siteId];
        }
        loadingSiteLevelMetadata.clear();
      },
      { deep: true },
    );
  });
}

/**
 * 同步返回该站点的行级元数据（未加载完成时返回空值），并在后台触发一次加载。
 * 必须在响应式上下文中调用（渲染 / computed），这样缓存填充后视图会自动更新。
 */
export function getSiteLevelMetadata(siteId: TSiteID): ISiteLevelMetadata {
  ensureInvalidationWatch();

  const cached = siteLevelMetadata[siteId];
  if (cached) return cached;

  if (siteId && !loadingSiteLevelMetadata.has(siteId)) {
    loadingSiteLevelMetadata.add(siteId);
    Promise.all([
      getCachedSiteMergedMetadata(siteId, "levelRequirements", []),
      getCachedSiteMergedMetadata(siteId, "userInfo"),
    ])
      .then(([levelRequirements, userInfo]) => {
        siteLevelMetadata[siteId] = {
          levelRequirements: (levelRequirements ?? []) as ISiteLevelMetadata["levelRequirements"],
          userInfo,
        };
      })
      .catch(() => {
        // 失败时填充空值，避免每行反复重试；站点配置变化时上面的 watcher 会清空缓存后重试
        siteLevelMetadata[siteId] = EMPTY_SITE_LEVEL_METADATA;
      })
      .finally(() => loadingSiteLevelMetadata.delete(siteId));
  }

  return EMPTY_SITE_LEVEL_METADATA;
}
