import { cloneDeep, toMerged } from "es-toolkit";
import { get, isEmpty, set } from "es-toolkit/compat";
import type { IAdvancedSearchRequestConfig, ISearchCategories, TSelectSearchCategoryValue } from "@ptd/site";

/**
 * 把多选值追加到同一个数组路径（`cross.mode === "brackets"`：`{ key: [v1, v2] }`）。
 *
 * E2-06 根因修复：同一份请求配置里可能有**多个分类分组**交叉写到同一个 `cross.key`
 * （例如 mteam 的「類別（综合）」与「類別（成人）」都写 `data.categories`；darkland/datascene
 * 在站点定义侧曾因同样的原因被迫合并分组）。旧实现直接 `set(path, field)` 整体覆盖，
 * 于是只有最后一组的选项生效，用户勾选的其它组被静默丢弃。这里改成「读取现值 → 合并 → 去重」。
 */
function mergeIntoArrayPath(requestConfig: IAdvancedSearchRequestConfig, path: string, values: unknown[]): void {
  const existing = get(requestConfig as any, path);
  const merged = [
    ...(Array.isArray(existing) ? existing : typeof existing === "undefined" || existing === null ? [] : [existing]),
    ...values,
  ];
  set(requestConfig as any, path, Array.from(new Set(merged)));
}

/** 多选值追加到同一个逗号分隔字符串路径（`cross.mode === "comma"`：`{ key: "v1,v2" }`） */
function mergeIntoCommaPath(requestConfig: IAdvancedSearchRequestConfig, path: string, values: unknown[]): void {
  const existing = get(requestConfig as any, path);
  const parts = [
    ...(typeof existing === "string" && existing !== "" ? existing.split(",") : []),
    ...values.map((value) => String(value)),
  ];
  set(requestConfig as any, path, Array.from(new Set(parts)).join(","));
}

/** 多选值追加到同一个对象路径（`cross.mode === "appendQuote"` 等以对象表达的形态） */
function mergeIntoObjectPath(
  requestConfig: IAdvancedSearchRequestConfig,
  path: string,
  values: Record<string, unknown>,
): void {
  const existing = get(requestConfig as any, path);
  const merged =
    existing !== null && typeof existing === "object" && !Array.isArray(existing) ? { ...existing, ...values } : values;
  set(requestConfig as any, path, merged);
}

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
        // 同一 cross.key 被多个分组使用时合并对象而不是覆盖
        mergeIntoObjectPath(requestConfig, `${updatePath}.${fieldKey}`, options);
      } else if (category.cross.mode === "comma") {
        // 同一 cross.key 被多个分组使用时把逗号串拼起来（去重，保持稳定顺序）
        mergeIntoCommaPath(requestConfig, `${updatePath}.${fieldKey}`, field as (string | number)[]);
      } else if (category.cross.mode === "brackets") {
        // 同一 cross.key 被多个分组使用时合并数组（去重，保持稳定顺序）
        mergeIntoArrayPath(requestConfig, `${updatePath}.${fieldKey}`, field as (string | number)[]);
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
