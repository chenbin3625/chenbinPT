import { describe, expect, it } from "vitest";

import { stringifyQuery } from "@/shared/queryString.ts";

/**
 * 期望值由 urlencode@2.0.0 的 `stringify()`（UTF-8 默认分支）生成并硬编码，
 * 用于锁定替换前后 openOptionsPage 查询串与 chrome.downloads POST body 的字节一致。
 */
describe("stringifyQuery（替代 urlencode.stringify）", () => {
  it.each([
    [
      "flat",
      { search: "中文 a&b=c", plan: "site:hdsky", flush: 1 },
      "search=%E4%B8%AD%E6%96%87%20a%26b%3Dc&plan=site%3Ahdsky&flush=1",
    ],
    [
      "nested",
      { a: { b: 1, c: { d: "x y" } }, arr: [1, "二", { k: "v" }] },
      "a[b]=1&a[c][d]=x%20y&arr[0]=1&arr[1]=%E4%BA%8C&arr[2][k]=v",
    ],
    ["nulls", { a: null, b: undefined, c: { d: null }, "": "skip" }, "a=&b=&d="],
    [
      "special",
      { "k[]": "v/?#", bool: true, zero: 0, emptyStr: "", date: "2024-01-01T00:00:00Z" },
      "k%5B%5D=v%2F%3F%23&bool=true&zero=0&emptyStr=&date=2024-01-01T00%3A00%3A00Z",
    ],
    ["emoji", { e: "😀", tilde: "~!*()'" }, "e=%F0%9F%98%80&tilde=~!*()'"],
  ])("%s", (_name, input, expected) => {
    expect(stringifyQuery(input)).toBe(expected);
  });

  it.each([[[1, 2]], ["str"], [1], [null]])("顶层非对象 %j 抛 TypeError", (input) => {
    expect(() => stringifyQuery(input)).toThrow(new TypeError("stringify expects an object"));
  });
});
