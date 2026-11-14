/**
 * deepToRaw 回归：ref 解包、特殊对象保留、循环引用。
 *
 * 旧实现：
 * - 对 RefImpl 调 `toRaw()` 返回的仍是 Ref → `isRef()` 恒真 → 无限递归（嵌套 ref 时爆栈）；
 * - Date / Map / Set / RegExp 被 `Object.keys()` 归约成 `{}`。
 */
import { describe, expect, it } from "vitest";
import { reactive, ref } from "vue";

import { deepToRaw } from "@/options/utils.ts";

describe("deepToRaw", () => {
  it("纯数据（MyData userInfo）输出与旧实现一致：逐字段复制为普通对象", () => {
    const source = {
      ratio: 1.5,
      tags: ["a", "b"],
      nested: { messageCount: 3, joinTime: 1700000000000 },
    };

    const result = deepToRaw(source);

    expect(result).toEqual(source);
    expect(result).not.toBe(source);
    expect(result.nested).not.toBe(source.nested);
    expect(result.tags).not.toBe(source.tags);
  });

  it("解包 reactive 代理与嵌套 ref，且不会递归爆栈", () => {
    const source = reactive({
      name: "site",
      nested: ref({ count: ref(7) }),
      list: [ref("x")],
    });

    expect(deepToRaw(source)).toEqual({ name: "site", nested: { count: 7 }, list: ["x"] });
  });

  it("Date / RegExp / Map / Set 原样保留（不再被归约成 {}）", () => {
    const date = new Date(1700000000000);
    const regexp = /abc/gi;
    const map = new Map<string, number>([["a", 1]]);
    const set = new Set([1, 2]);

    const result = deepToRaw({ date, regexp, map, set } as any);

    expect(result.date).toBe(date);
    expect(result.regexp).toBe(regexp);
    expect(result.map).toBe(map);
    expect(result.set).toBe(set);
  });

  it("循环引用不会无限递归，输出中保留环", () => {
    const source: any = { name: "root" };
    source.self = source;
    source.children = [{ parent: source }];

    const result: any = deepToRaw(source);

    expect(result.self).toBe(result);
    expect(result.children[0].parent).toBe(result);
  });
});
