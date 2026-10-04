/**
 * chrome.storage 路径读写工具单测（见 docs/performance-audit.md P0-2 / P2-17）。
 *
 * 这些函数是"局部读写替代整份 RMW"的基础设施：一旦在嵌套键、数组下标、
 * 数字样式的键或缺失路径上出现行为偏差，就会静默写坏 metadata/userInfo。
 */
import { describe, expect, it } from "vitest";

import { getValueByPath, parsePath, removeValueByPath, setValueByPath } from "@/shared/storagePath.ts";

describe("parsePath：路径解析", () => {
  it("点号路径拆分为键数组", () => {
    expect(parsePath("a.b.c")).toEqual(["a", "b", "c"]);
  });

  it("纯数字段转换为 number（支持数组下标）", () => {
    expect(parsePath("list.0.name")).toEqual(["list", 0, "name"]);
  });

  it("数组路径原样返回", () => {
    expect(parsePath(["x", 1])).toEqual(["x", 1]);
  });

  it("空字符串与多余点号被忽略", () => {
    expect(parsePath("")).toEqual([]);
    expect(parsePath("a..b.")).toEqual(["a", "b"]);
  });
});

describe("getValueByPath：取值", () => {
  const source = {
    sites: { mteam: { url: "https://mteam.example", merge: { name: "M-Team" } } },
    list: [1, 2],
  };

  it("嵌套对象取值", () => {
    expect(getValueByPath(source, ["sites", "mteam", "merge", "name"])).toBe("M-Team");
  });

  it("数组下标取值（点号路径与数组路径等价）", () => {
    expect(getValueByPath(source, "list.1")).toBe(2);
    expect(getValueByPath(source, ["list", 1])).toBe(2);
  });

  it("路径不存在时返回 undefined（不抛错）", () => {
    expect(getValueByPath(source, ["sites", "nope", "x"])).toBeUndefined();
    expect(getValueByPath(undefined, "a.b")).toBeUndefined();
  });

  it("空路径返回源对象本身", () => {
    expect(getValueByPath(source, [])).toBe(source);
  });
});

describe("setValueByPath：赋值", () => {
  it("自动创建缺失的中间对象", () => {
    const target: any = {};
    setValueByPath(target, ["sites", "mteam", "runtimeSettings", "authKey"], "k1");
    expect(target.sites.mteam.runtimeSettings.authKey).toBe("k1");
  });

  it("下一级是数字键时创建数组", () => {
    const target: any = {};
    setValueByPath(target, ["list", 0, "id"], 7);
    expect(Array.isArray(target.list)).toBe(true);
    expect(target.list[0].id).toBe(7);
  });

  it("空路径不产生副作用", () => {
    const target: any = { a: 1 };
    setValueByPath(target, [], "x");
    expect(target).toEqual({ a: 1 });
  });
});

describe("removeValueByPath：删除", () => {
  it("删除深层键且保留兄弟键", () => {
    const target: any = { a: { b: { c: 1, d: 2 } } };
    removeValueByPath(target, "a.b.c");
    expect(target.a.b).toEqual({ d: 2 });
  });

  it("路径不存在时安全返回", () => {
    const target: any = { a: 1 };
    expect(() => removeValueByPath(target, "a.b.c.d.e")).not.toThrow();
    expect(target).toEqual({ a: 1 });
  });
});
