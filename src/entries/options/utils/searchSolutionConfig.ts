import { cloneDeep, toMerged } from "es-toolkit";
import { isEmpty, set } from "es-toolkit/compat";
import type { IAdvancedSearchRequestConfig, ISearchCategories, TSelectSearchCategoryValue } from "@ptd/site";

export function buildSearchSolutionFromCategories(
  siteMetaCategory: ISearchCategories[],
  selectCategory: Partial<Record<ISearchCategories["key"], TSelectSearchCategoryValue | symbol>>,
): {
  selectedCategories: Record<ISearchCategories["key"], TSelectSearchCategoryValue>;
  requestConfig: IAdvancedSearchRequestConfig;
} {
  const selectedCategories: Record<ISearchCategories["key"], TSelectSearchCategoryValue> = {};
  let requestConfig: IAdvancedSearchRequestConfig = {};

  for (const category of siteMetaCategory) {
    const field = cloneDeep(selectCategory[category.key]);
    if (typeof field === "undefined" || typeof field === "symbol" || (Array.isArray(field) && field.length === 0)) {
      continue;
    }

    selectedCategories[category.key] = field;
    if (category.generateRequestConfig) {
      requestConfig = toMerged(requestConfig, category.generateRequestConfig(field));
      continue;
    }

    let fieldKey = category.key;
    const updatePath = `requestConfig.${category.keyPath ?? "params"}`;
    if (fieldKey === "#url") {
      set(requestConfig, "requestConfig.url", field);
      continue;
    }

    if (category.cross) {
      if (typeof category.cross.key !== "undefined") {
        fieldKey = category.cross.key as string;
      }
      if (category.cross.mode === "append") {
        for (const option of field as (string | number)[]) {
          set(requestConfig, `${updatePath}.${fieldKey}${option}`, 1);
        }
      } else if (category.cross.mode === "appendQuote") {
        const options = Object.fromEntries((field as (string | number)[]).map((option) => [option, 1]));
        set(requestConfig, `${updatePath}.${fieldKey}`, options);
      } else if (category.cross.mode === "comma") {
        set(requestConfig, `${updatePath}.${fieldKey}`, (field as (string | number)[]).join(","));
      } else {
        set(requestConfig, `${updatePath}.${fieldKey}`, field);
      }
    } else {
      set(requestConfig, `${updatePath}.${fieldKey}`, field);
    }
  }

  return {
    selectedCategories,
    requestConfig: isEmpty(requestConfig) ? {} : requestConfig,
  };
}
