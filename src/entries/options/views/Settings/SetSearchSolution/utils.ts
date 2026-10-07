import { nanoid } from "nanoid";
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
