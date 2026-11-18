import { i18n } from "@/options/plugins/i18n.ts";

/** `site:<id>[,<id>...]` 是单站搜索方案在 store 里的 key（没有对应的解决方案记录） */
const SINGLE_SITE_PLAN_PREFIX = "site:";

/**
 * 搜索方案在界面上的展示名。
 *
 * 在视图层把 `"all"` 交给 i18n，保证语言切换时展示名随之更新；
 * 其它方案仍由 store 解析。`resolveFromStore` 由调用方注入，便于测试且避免本文件依赖 store 的创建时机。
 * `resolveSiteName` 同理：单站方案（`site:<id>`）的展示名需要站点名，由调用方从 metadata store 取。
 */
export function getSearchSolutionDisplayName(
  planKey: string,
  resolveFromStore: (key: string) => string,
  resolveSiteName?: (siteId: string) => string | undefined,
): string {
  if (planKey === "all") {
    return i18n.t("layout.header.searchPlan.all");
  }
  // F12：单站方案的 key 形如 `site:hdsky`，store 里查不到，直接展示会把原始 key 暴露给用户。
  // 站点名由调用方注入（store 的 siteNameMap 可能在冷启动时为空，此时退回站点 id）。
  if (planKey.startsWith(SINGLE_SITE_PLAN_PREFIX)) {
    const siteIds = planKey
      .slice(SINGLE_SITE_PLAN_PREFIX.length)
      .split(",")
      .map((siteId) => siteId.trim())
      .filter(Boolean);
    if (siteIds.length > 0) {
      return siteIds.map((siteId) => resolveSiteName?.(siteId) || siteId).join(", ");
    }
  }
  return resolveFromStore(planKey);
}
