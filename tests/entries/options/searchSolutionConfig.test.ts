/**
 * E2-06 根因回归：`buildSearchSolutionFromCategories` 的多分组合并。
 *
 * 审查修复（2026-10-23，F1 追加范围）：`cross.mode` 为 `brackets` / `comma` 时，多个分类分组
 * 可能交叉写到**同一个字段**（mteam 的「類別（综合）」「類別（成人）」都写 `data.categories`；
 * darkland/datascene 曾因同样的原因被迫把分组合并成一个）。
 * 旧实现对同一路径直接 `set()` 整体覆盖 → 只有最后一组的选项生效，其它组被静默丢弃。
 * 现在改为「读取现值 → 合并 → 去重」，并保留单分组时的原语义。
 */
import { describe, expect, it } from "vitest";
import type { ISearchCategories } from "@ptd/site";

import { buildSearchSolutionFromCategories } from "@/options/utils/searchSolutionConfig.ts";

/** 构造一个「交叉到同一个 key」的分类分组 */
function crossCategory(
  key: string,
  values: Array<string | number>,
  options: { keyPath?: "params" | "data"; crossKey?: string; mode?: string } = {},
): ISearchCategories {
  return {
    name: key,
    key,
    keyPath: options.keyPath ?? "data",
    options: values.map((value) => ({ name: String(value), value })),
    cross: { mode: (options.mode ?? "brackets") as any, key: options.crossKey ?? "categories" },
  } as ISearchCategories;
}

describe("E2-06：多个分组交叉写同一字段时必须合并而不是覆盖", () => {
  it("brackets：两个分组（mteam 综合/成人）的同名 cross.key 合并成一个数组", () => {
    const categories = [crossCategory("categories_normal", [1, 4, 16]), crossCategory("categories_adult", [12, 20])];

    const result = buildSearchSolutionFromCategories(categories, {
      categories_normal: [1, 16],
      categories_adult: ["12", 20],
    } as any);

    expect(result.requestConfig).toEqual({
      requestConfig: { data: { categories: [1, 16, "12", 20] } },
    });
    // 分组选择本身原样保留（UI 回显依赖它）
    expect(result.selectedCategories).toEqual({ categories_normal: [1, 16], categories_adult: ["12", 20] });
  });

  it("brackets：同一值出现在两个分组时只保留一次（顺序稳定）", () => {
    const categories = [crossCategory("groupA", [1, 2]), crossCategory("groupB", [2, 3])];

    const result = buildSearchSolutionFromCategories(categories, {
      groupA: [1, 2],
      groupB: [2, 3],
    } as any);

    expect(result.requestConfig).toEqual({ requestConfig: { data: { categories: [1, 2, 3] } } });
  });

  it("comma：两个分组的逗号串拼起来，且去重", () => {
    const categories = [
      crossCategory("catA", ["401", "402"], { crossKey: "cat", mode: "comma" }),
      crossCategory("catB", ["402", "403"], { crossKey: "cat", mode: "comma" }),
    ];

    const result = buildSearchSolutionFromCategories(categories, {
      catA: ["401", "402"],
      catB: ["402", "403"],
    } as any);

    expect(result.requestConfig).toEqual({ requestConfig: { data: { cat: "401,402,403" } } });
  });

  it("appendQuote：两个分组交叉写同一 key 时合并对象而不是覆盖", () => {
    const categories = [
      crossCategory("tagA", ["a", "b"], { crossKey: "tags", mode: "appendQuote" }),
      crossCategory("tagB", ["c"], { crossKey: "tags", mode: "appendQuote" }),
    ];

    const result = buildSearchSolutionFromCategories(categories, { tagA: ["a", "b"], tagB: ["c"] } as any);

    expect(result.requestConfig).toEqual({ requestConfig: { data: { tags: { a: 1, b: 1, c: 1 } } } });
  });

  it("单分组语义不变：brackets 仍然输出该组的数组", () => {
    const categories = [crossCategory("categories", [1, 4], { crossKey: "categories" })];

    const result = buildSearchSolutionFromCategories(categories, { categories: [1, 4] } as any);
    expect(result.requestConfig).toEqual({ requestConfig: { data: { categories: [1, 4] } } });
  });

  it("append 模式（按选项展开）不受影响", () => {
    const categories = [crossCategory("cat", [401, 402], { crossKey: "c", mode: "append" })];
    const result = buildSearchSolutionFromCategories(categories, { cat: [401, 402] } as any);
    expect(result.requestConfig).toEqual({ requestConfig: { data: { c401: 1, c402: 1 } } });
  });

  it("#url 分类仍然写入 requestConfig.url", () => {
    const categories: ISearchCategories[] = [
      {
        name: "搜索入口",
        key: "#url",
        options: [{ name: "种子", value: "/torrents.php" }],
      } as ISearchCategories,
    ];
    const result = buildSearchSolutionFromCategories(categories, { "#url": "/torrents.php" } as any);
    expect(result.requestConfig).toEqual({ requestConfig: { url: "/torrents.php" } });
  });

  it("generateRequestConfig 的分组仍按 toMerged 合并", () => {
    const categories: ISearchCategories[] = [
      {
        name: "a",
        key: "a",
        options: [{ name: "x", value: 1 }],
        generateRequestConfig: () => ({ requestConfig: { params: { a: 1 } } }),
      } as ISearchCategories,
      {
        name: "b",
        key: "b",
        options: [{ name: "y", value: 2 }],
        generateRequestConfig: () => ({ requestConfig: { params: { b: 2 } } }),
      } as ISearchCategories,
    ];

    const result = buildSearchSolutionFromCategories(categories, { a: 1, b: 2 } as any);
    expect(result.requestConfig).toEqual({ requestConfig: { params: { a: 1, b: 2 } } });
  });

  it("没有任何选择时返回空配置", () => {
    expect(buildSearchSolutionFromCategories([crossCategory("a", [1])], {} as any).requestConfig).toEqual({});
  });
});
