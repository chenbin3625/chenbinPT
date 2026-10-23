import { i18n } from "@/options/plugins/i18n.ts";

/**
 * 搜索方案在界面上的展示名。
 *
 * F12：`metadataStore.getSearchSolutionName("all")` 里硬编码了中文「全站」（store 内标着
 * `// FIXME i18n`）。跨站搜索（`searchPlanKey` 被重写为 `"all"`）时，英文界面的搜索结果页头部
 * 与状态弹窗会显示中文，与页面其它文案中英混排。
 *
 * 这里在视图层把 `"all"` 交给 i18n（复用顶栏已有的 `layout.header.searchPlan.all`，中英均有翻译）；
 * 其它方案仍由 store 解析。`resolveFromStore` 由调用方注入，便于测试且避免本文件依赖 store 的创建时机。
 */
export function getSearchSolutionDisplayName(planKey: string, resolveFromStore: (key: string) => string): string {
  if (planKey === "all") {
    return i18n.t("layout.header.searchPlan.all");
  }
  return resolveFromStore(planKey);
}
