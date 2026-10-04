import { describe, expect, it } from "vitest";

import {
  buildCategoryOptionsFromDict,
  buildCategoryOptionsFromList,
  hasNonLatinCharacters,
  mapWithConcurrency,
  redactSensitive,
} from "@ptd/site/utils/helper.ts";
import { getValueByPath, removeValueByPath, setValueByPath } from "@/shared/storagePath.ts";

describe("mapWithConcurrency", () => {
  it("结果按输入下标对齐，与任务完成顺序无关", async () => {
    const resolvers: Array<(value: string) => void> = [];
    const started: number[] = [];

    const promise = mapWithConcurrency([0, 1, 2], 3, (item, index) => {
      started.push(index);
      return new Promise<string>((resolve) => {
        resolvers[index] = resolve;
      });
    });

    // 并发上限 >= 元素个数时，所有 worker 都在同一个同步块里启动
    expect(started).toEqual([0, 1, 2]);

    // 故意让完成顺序与输入顺序相反
    resolvers[2](`item-2`);
    resolvers[1](`item-1`);
    resolvers[0](`item-0`);

    await expect(promise).resolves.toEqual(["item-0", "item-1", "item-2"]);
  });

  it("并发上限被严格遵守（5 个任务 / 上限 2 => 峰值恰好 2）", async () => {
    let inFlight = 0;
    let peak = 0;

    const results = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (item) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight--;
      return item * 2;
    });

    expect(peak).toBe(2);
    expect(results).toEqual([2, 4, 6, 8, 10]);
  });

  it("mapper 收到的是原始元素与原始下标", async () => {
    const seen: Array<[string, number]> = [];
    const results = await mapWithConcurrency(["a", "b", "c"], 1, async (item, index) => {
      seen.push([item, index]);
      return index;
    });

    expect(results).toEqual([0, 1, 2]);
    expect(seen).toEqual([
      ["a", 0],
      ["b", 1],
      ["c", 2],
    ]);
  });

  it("并发上限 >= 元素个数时不做额外串行化（峰值 = 元素个数）", async () => {
    let inFlight = 0;
    let peak = 0;

    await mapWithConcurrency([1, 2, 3], 10, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight--;
      return 0;
    });

    expect(peak).toBe(3);
  });

  it("并发上限 <= 0 时退化为串行（至少 1 个 worker）", async () => {
    let inFlight = 0;
    let peak = 0;

    const results = await mapWithConcurrency([1, 2, 3], 0, async (item) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight--;
      return item;
    });

    expect(peak).toBe(1);
    expect(results).toEqual([1, 2, 3]);

    let negativePeak = 0;
    let negativeInFlight = 0;
    await mapWithConcurrency([1, 2], -5, async () => {
      negativeInFlight++;
      negativePeak = Math.max(negativePeak, negativeInFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      negativeInFlight--;
      return 0;
    });
    expect(negativePeak).toBe(1);
  });

  it("空数组不发任何任务并返回空数组", async () => {
    let calls = 0;
    const results = await mapWithConcurrency([], 4, async () => {
      calls++;
      return 0;
    });

    expect(calls).toBe(0);
    expect(results).toEqual([]);
  });

  it("mapper 抛错时整体 reject，且错误原样向上传递", async () => {
    const boom = new Error("boom");
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (item) => {
        if (item === 2) throw boom;
        return item;
      }),
    ).rejects.toBe(boom);
  });
});

describe("hasNonLatinCharacters", () => {
  it("纯拉丁 / 数字 / 标点 / 空白为 false", () => {
    expect(hasNonLatinCharacters("")).toBe(false);
    expect(hasNonLatinCharacters("hello world")).toBe(false);
    expect(hasNonLatinCharacters("123 !@#$%^&*()")).toBe(false);
    expect(hasNonLatinCharacters("café")).toBe(false); // é 属于 Latin script
    expect(hasNonLatinCharacters("Pt.Example.COM")).toBe(false);
  });

  it("非拉丁文字系统为 true", () => {
    expect(hasNonLatinCharacters("你好世界")).toBe(true);
    expect(hasNonLatinCharacters("こんにちは")).toBe(true);
    expect(hasNonLatinCharacters("Привет")).toBe(true);
    expect(hasNonLatinCharacters("αβγ")).toBe(true);
    expect(hasNonLatinCharacters("नमस्ते")).toBe(true);
    expect(hasNonLatinCharacters("مرحبا")).toBe(true);
  });

  it("混合拉丁与非拉丁时为 true（宁可走非拉丁分支）", () => {
    expect(hasNonLatinCharacters("hello 世界")).toBe(true);
    expect(hasNonLatinCharacters("a你")).toBe(true);
  });

  it("边界：Script=Common 的字符（emoji / 全角形式）按实现语义算作「拉丁」", () => {
    // 这些字符的 Script_Extensions 是 Common，与数字、标点同类，因此返回 false。
    // 这是 hasNonLatinCharacters 的既有语义（见其 JSDoc），单独钉住以免被无意改动。
    expect(hasNonLatinCharacters("😀")).toBe(false);
    expect(hasNonLatinCharacters("ＡＢＣ")).toBe(false);
    expect(hasNonLatinCharacters("ｈｅｌｌｏ")).toBe(false);
    expect(hasNonLatinCharacters("２３")).toBe(false);
  });
});

describe("buildCategoryOptionsFromList", () => {
  it("name 与 value 都取字符串本身，并按 Infinity 深度拍平", () => {
    expect(buildCategoryOptionsFromList(["Anime", ["Audio", "Literature"]])).toEqual([
      { name: "Anime", value: "Anime" },
      { name: "Audio", value: "Audio" },
      { name: "Literature", value: "Literature" },
    ]);
  });

  it("深层嵌套同样被拍平且保持顺序", () => {
    // 形参类型只声明到 (string | string[])[]，但实现用 flat(Infinity) 拍平任意深度，
    // 这里用 as any 覆盖「运行时深层嵌套」的行为。
    const deeplyNested = [[["a"]], "b", [["c", ["d"]]]] as any;

    expect(buildCategoryOptionsFromList(deeplyNested)).toEqual([
      { name: "a", value: "a" },
      { name: "b", value: "b" },
      { name: "c", value: "c" },
      { name: "d", value: "d" },
    ]);
  });

  it("空数组返回空数组", () => {
    expect(buildCategoryOptionsFromList([])).toEqual([]);
  });
});

describe("buildCategoryOptionsFromDict", () => {
  it("name 取字典的值，value 取字典的键（键统一为字符串）", () => {
    expect(buildCategoryOptionsFromDict({ "1": "Anime", "2": "Audio" })).toEqual([
      { name: "Anime", value: "1" },
      { name: "Audio", value: "2" },
    ]);
  });

  it("数字键会被 Object.entries 转成字符串", () => {
    expect(buildCategoryOptionsFromDict({ 1: "Anime" })).toEqual([{ name: "Anime", value: "1" }]);
  });

  it("空字典返回空数组", () => {
    expect(buildCategoryOptionsFromDict({})).toEqual([]);
  });
});

describe("redactSensitive", () => {
  it("敏感字段被替换为 ***，并返回全新对象", () => {
    const source = { site: "mteam", userConfig: { passkey: "secret-value", isOffline: true } };
    const redacted = redactSensitive(source);

    expect(redacted).toEqual({ site: "mteam", userConfig: { passkey: "***", isOffline: true } });
    expect(redacted).not.toBe(source);
    // 不回写原对象
    expect(source.userConfig.passkey).toBe("secret-value");
  });

  it("JSON 里的 __proto__ 键不会污染原型（与 B-22 同类，A-20）", () => {
    // JSON.parse 会把 "__proto__" 建成**自有属性**，Object.entries 能枚举到；
    // 若直接 `ret[key] = value` 赋值，改的是 ret 的原型而不是新增字段
    const parsed = JSON.parse('{"__proto__":{"polluted":"yes"},"site":"mteam","token":"tok"}');
    const redacted = redactSensitive(parsed);

    expect(({} as any).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(redacted)).toBe(Object.prototype);
    expect(Object.keys(redacted)).toEqual(["site", "token"]);
    expect(redacted).toEqual({ site: "mteam", token: "***" });
  });

  it("constructor / prototype 键同样被跳过，避免覆盖正常成员", () => {
    const redacted = redactSensitive({ constructor: { name: "evil" }, prototype: { x: 1 }, id: "a" });
    expect(redacted).toEqual({ id: "a" });
    expect(Object.getPrototypeOf(redacted)).toBe(Object.prototype);
  });
});

/**
 * storagePath 的原型污染守卫（B-22）。
 *
 * 说明：`tests/entries/shared/storagePath.test.ts` 不在本次修复允许改动的文件清单内，
 * 因此回归断言就近放在这里，与 A-20 的 redactSensitive 用例一起覆盖同一类缺陷。
 */
describe("storagePath：危险段名守卫（B-22）", () => {
  it("__proto__ / constructor / prototype 段被拒绝，不写入也不污染全局原型", () => {
    const target: any = {};

    setValueByPath(target, ["sites", "__proto__", "runtimeSettings", "x"], 1);
    setValueByPath(target, ["__proto__", "polluted"], "yes");
    setValueByPath(target, "a.constructor.prototype.b", 2);
    setValueByPath(target, ["prototype"], 3);

    expect(({} as any).runtimeSettings).toBeUndefined();
    expect(({} as any).polluted).toBeUndefined();
    expect(({} as any).b).toBeUndefined();
    expect(Object.getPrototypeOf(target)).toBe(Object.prototype);
    expect(Object.getOwnPropertyNames(target)).toEqual([]);
  });

  it("removeValueByPath 同样拒绝危险段（不会删到原型成员）", () => {
    const target: any = { keep: 1 };
    removeValueByPath(target, ["__proto__"]);
    removeValueByPath(target, ["a", "constructor", "prototype", "b"]);
    removeValueByPath(target, ["keep"]);

    expect(Object.getPrototypeOf(target)).toBe(Object.prototype);
    expect(target.keep).toBeUndefined();
  });

  it("getValueByPath 只读自有属性，不沿原型链读取", () => {
    expect(getValueByPath({}, "constructor")).toBeUndefined();
    expect(getValueByPath({}, "__proto__")).toBeUndefined();
    expect(getValueByPath({ a: { b: 1 } }, "a.b")).toBe(1);
    expect(getValueByPath({ a: { b: null } }, "a.b.c")).toBeUndefined();
  });

  it("正常路径的读写删不受影响", () => {
    const target: any = {};
    setValueByPath(target, ["sites", "mteam", "userConfig", "isOffline"], true);
    setValueByPath(target, "list.0.name", "a");
    expect(getValueByPath(target, ["sites", "mteam", "userConfig", "isOffline"])).toBe(true);
    expect(target.list[0].name).toBe("a");

    removeValueByPath(target, "sites.mteam.userConfig.isOffline");
    expect(getValueByPath(target, "sites.mteam.userConfig.isOffline")).toBeUndefined();
  });
});
