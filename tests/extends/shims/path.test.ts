/**
 * src/extends/shims/path.ts 与 Node `path.posix` 的差分测试。
 *
 * 构建时 `path` / `node:path` 被 wxt.config.ts 别名到这个最小实现（唯一使用方 parse-torrent 只用
 * `join` + `sep`），而单测运行在 Node 里、拿到的是真正的 `node:path` —— 因此这里直接 import 垫片，
 * 用穷举的小路径片段组合逐一比对，保证两者语义一致。
 */
import { posix } from "node:path";
import { describe, expect, it } from "vitest";

import shim, { delimiter, join, normalize, sep } from "~/extends/shims/path.ts";

/** 覆盖空段、`.`、`..`、前导/尾随分隔符与重复分隔符的片段 */
const SEGMENTS = ["", ".", "..", "a", "b.c", "/", "//", "/a", "a/", "../a", "a/..", "./a", "a//b", "/../"];

describe("path 垫片（POSIX 语义）", () => {
  it("normalize 与 posix.normalize 一致", () => {
    for (const a of SEGMENTS) {
      for (const b of SEGMENTS) {
        const input = a + b;
        expect(normalize(input), JSON.stringify(input)).toBe(posix.normalize(input));
      }
    }
  });

  it("join 与 posix.join 一致（0~3 个片段的全部组合）", () => {
    expect(join()).toBe(posix.join());
    for (const a of SEGMENTS) {
      expect(join(a), JSON.stringify([a])).toBe(posix.join(a));
      for (const b of SEGMENTS) {
        expect(join(a, b), JSON.stringify([a, b])).toBe(posix.join(a, b));
        for (const c of SEGMENTS) {
          expect(join(a, b, c), JSON.stringify([a, b, c])).toBe(posix.join(a, b, c));
        }
      }
    }
  });

  it("parse-torrent 的调用方式：join(sep, ...parts).slice(1) 得到多文件种子的相对路径", () => {
    const parts = ["Show S01", "Season 1", "e01.mkv"];
    expect(shim.join.apply(null, [shim.sep, ...parts]).slice(1)).toBe("Show S01/Season 1/e01.mkv");
    expect(shim.join.apply(null, [shim.sep, ...parts]).slice(1)).toBe(posix.join(posix.sep, ...parts).slice(1));
  });

  it("导出 sep / delimiter 与 posix 一致", () => {
    expect(sep).toBe(posix.sep);
    expect(delimiter).toBe(posix.delimiter);
  });
});
