/**
 * `resolveColor` 查表回归测试（BACKGROUNDSHARED-5）。
 *
 * 缺陷：语义色/调色板都是对象字面量，普通下标会沿原型链命中：
 * `resolveColor("constructor")` 返回 Object 构造函数、`"__proto__"` 返回 Object.prototype，
 * 而调用点（TorrentTitleTd.vue 的 `resolveColor(tag.color) ?? "default"`）里函数不是 nullish，
 * `?? "default"` 兜不住 → 标签底色退化成无效样式。修好后这些名字应回落到「未知颜色关键字透传」语义。
 */
import { describe, expect, it } from "vitest";

import { resolveColor } from "@/shared/colors.ts";

describe("resolveColor（BACKGROUNDSHARED-5）", () => {
  it("原型链成员名不得返回函数/原型对象，而应作为未知关键字透传", () => {
    for (const name of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"]) {
      const resolved = resolveColor(name);
      expect(typeof resolved, `${name} 必须是字符串而不是原型链成员`).toBe("string");
      expect(resolved).toBe(name);
    }
  });

  it("正常查表行为不变（语义色 / 调色板 / 档位 / 未知关键字）", () => {
    expect(resolveColor("primary")).toBe("#1677ff");
    expect(resolveColor("blue")).toBe("#2196f3");
    expect(resolveColor("blue-grey-darken-2")).toBe("#455a64");
    expect(resolveColor("blue-accent-3")).toBe("#2196f3"); // 未收录的档位回落到 base
    expect(resolveColor("gray")).toBe("#9e9e9e");
    expect(resolveColor("#ff0000")).toBe("#ff0000");
    expect(resolveColor("rgb(1, 2, 3)")).toBe("rgb(1, 2, 3)");
    expect(resolveColor("transparent")).toBe("transparent");
    expect(resolveColor("")).toBeUndefined();
    expect(resolveColor(null)).toBeUndefined();
  });
});
