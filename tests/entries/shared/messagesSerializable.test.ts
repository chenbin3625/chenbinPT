import { describe, expect, it } from "vitest";
import { computed, reactive, ref, shallowRef } from "vue";

import { toSerializable } from "@/shared/messagesSerializable.ts";

describe("toSerializable：与 JSON 往返一致的语义", () => {
  it("对象里 undefined / function / symbol 值的键被丢弃", () => {
    const input = {
      keep: 1,
      dropUndefined: undefined,
      dropFn: () => 1,
      dropSymbol: Symbol("s"),
      nested: { a: undefined, b: 2 },
    };

    expect(toSerializable(input)).toEqual({ keep: 1, nested: { b: 2 } });
  });

  it("数组里的 undefined / function 变成 null（保持下标与长度）", () => {
    const out = toSerializable([1, undefined, () => 2, "x"]);

    expect(out).toEqual([1, null, null, "x"]);
    expect(out).toHaveLength(4);
  });

  it("稀疏数组的洞同样变成 null", () => {
    expect(toSerializable(new Array(3))).toEqual([null, null, null]);
  });

  it("NaN / Infinity 原样保留（JSON 会变成 null，结构化克隆不会）", () => {
    const out = toSerializable({ nan: NaN, inf: Infinity, ninf: -Infinity });

    expect(Number.isNaN(out.nan)).toBe(true);
    expect(out.inf).toBe(Infinity);
    expect(out.ninf).toBe(-Infinity);
  });

  it("基本类型原样返回（含 symbol / bigint 顶层值）", () => {
    expect(toSerializable(1)).toBe(1);
    expect(toSerializable("s")).toBe("s");
    expect(toSerializable(true)).toBe(true);
    expect(toSerializable(null)).toBeNull();
    expect(toSerializable(undefined)).toBeUndefined();

    const sym = Symbol("top");
    expect(toSerializable(sym)).toBe(sym);
    expect(toSerializable(10n)).toBe(10n);
  });
});

describe("toSerializable：解 Vue 响应式代理", () => {
  it("reactive 代理展开为普通对象，内容与 toRaw 一致", () => {
    const state = reactive({ sites: { mteam: { name: "M-Team", merge: { tags: ["a", "b"] } } }, list: [1, 2] });
    const out = toSerializable(state);

    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(out).toEqual(JSON.parse(JSON.stringify(state)));
    expect(Object.getPrototypeOf(out.sites)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(out.sites.mteam)).toBe(Object.prototype);
  });

  it("ref / shallowRef / computed 取 .value", () => {
    expect(toSerializable(ref({ id: 1 }))).toEqual({ id: 1 });
    expect(toSerializable(shallowRef(2))).toBe(2);
    expect(toSerializable(computed(() => 3))).toBe(3);
  });

  it("嵌套在对象 / 数组里的 ref 也会被展开", () => {
    expect(toSerializable({ r: ref(2), nested: { r: ref("x") } })).toEqual({ r: 2, nested: { r: "x" } });
    expect(toSerializable([ref(1), ref(2)])).toEqual([1, 2]);
  });

  it("无 vue 运行时的 __v_raw 代理同样被展开", () => {
    const raw = { a: 1 };
    const fakeProxy = { __v_raw: raw };

    expect(toSerializable(fakeProxy)).toEqual({ a: 1 });
  });

  it("解代理后的结果可被结构化克隆（sendMessage 的实际前置条件）", () => {
    const payload = {
      reactive: reactive({ a: ref(1), b: { c: 2 } }),
      date: new Date("2024-01-02T03:04:05.000Z"),
      list: [undefined, () => 1, { d: 3 }],
    };

    const out = toSerializable(payload);
    expect(() => structuredClone(out)).not.toThrow();
    expect(structuredClone(out).reactive.b.c).toBe(2);
  });
});

describe("toSerializable：平台可能不保留的原生类型必须显式转换（A-1）", () => {
  /**
   * 为什么不能"交给平台"：Chrome 的 `chrome.runtime.sendMessage` 走 JSON 序列化
   * （Map/Set/Blob/Error → {}、Date → ISO 字符串、类型化数组 → {"0":…}），
   * Firefox 走结构化克隆保留原类型 ⇒ 同一消息在不同浏览器/不同分发路径下类型不同。
   * 这里的断言就是「转换后的形状必须能被 JSON 往返无损承载」。
   */
  function expectJsonRoundTrip(out: any) {
    const parsed = JSON.parse(JSON.stringify(out));
    expect(parsed).toEqual(out);
    return parsed;
  }

  it("Date → 毫秒时间戳（不是 ISO 字符串，也不是平台各自为政的形态）", () => {
    const date = new Date("2024-01-02T03:04:05.000Z");
    const out = toSerializable({ date });

    expect(out.date).toBe(1704164645000);
    expect(typeof out.date).toBe("number");
    expectJsonRoundTrip(out);
  });

  it("Map → entries 数组（保留键序与任意键类型，JSON 下不再是 {}）", () => {
    const keyObject = { id: 1 };
    const map = new Map<any, any>([
      ["a", 1],
      [keyObject, { nested: new Date("2024-01-02T03:04:05.000Z") }],
    ]);
    const out = toSerializable({ map });

    expect(out.map).toEqual([
      ["a", 1],
      [keyObject, { nested: 1704164645000 }],
    ]);
    expectJsonRoundTrip(out);
    // 共享引用语义保持：同一个对象既作 Map 键又出现在别处时只展开一次
    const shared = toSerializable({ map, same: keyObject });
    expect((shared.map as any[])[1][0]).toBe(shared.same);
  });

  it("Set → 值数组（JSON 下不再是 {}）", () => {
    const out = toSerializable({ set: new Set([1, "b", { c: 3 }]) });

    expect(out.set).toEqual([1, "b", { c: 3 }]);
    expectJsonRoundTrip(out);
  });

  it("ArrayBuffer / 类型化数组 / DataView → 普通数组", () => {
    const buffer = new ArrayBuffer(4);
    new Uint8Array(buffer).set([1, 2, 3, 4]);
    const typed = new Float32Array([1.5, -2.5]);
    const dataView = new DataView(buffer, 1, 2);

    const out = toSerializable({ buffer, typed, dataView });

    expect(out.buffer).toEqual([1, 2, 3, 4]);
    expect(Array.isArray(out.buffer)).toBe(true);
    expect(out.typed).toEqual([1.5, -2.5]);
    expect(out.dataView).toEqual([2, 3]); // 只取 DataView 覆盖的字节（byteOffset/byteLength）
    expectJsonRoundTrip(out);
  });

  it("URL → href 字符串、Error → { name, message, stack }、RegExp → { source, flags }", () => {
    const url = new URL("https://pt.example.com/a?b=1");
    const error = new TypeError("boom");
    const regexp = /ab+c/gi;

    const out = toSerializable({ url, error, regexp });

    expect(out.url).toBe("https://pt.example.com/a?b=1");
    expect(out.error).toMatchObject({ name: "TypeError", message: "boom" });
    expect(typeof out.error.stack).toBe("string");
    expect(out.regexp).toEqual({ source: "ab+c", flags: "gi" });
    expectJsonRoundTrip(out);
  });

  it("自引用的 Map / Set 不会无限递归，且转换结果仍是环状的普通结构", () => {
    const map = new Map<string, any>();
    map.set("self", map);
    const set = new Set<any>();
    set.add(set);

    const mapOut = toSerializable(map);
    const setOut = toSerializable(set);

    expect(mapOut[0][1]).toBe(mapOut);
    expect(setOut[0]).toBe(setOut);
    expect(() => JSON.stringify(mapOut.map((entry: any) => (entry[1] === mapOut ? "self" : entry[1])))).not.toThrow();
  });

  it("Blob / File 明确抛 TypeError（不再静默降级成 {}）", () => {
    const blob = new Blob(["x"]);
    const file = new File(["x"], "x.txt");

    expect(() => toSerializable({ blob })).toThrow(TypeError);
    expect(() => toSerializable({ nested: { file } })).toThrow(/Blob\/File/);
  });

  it("转换后的整份 payload 仍可被结构化克隆（Firefox 分发路径的实际前置条件）", () => {
    const payload = {
      date: new Date("2024-01-02T03:04:05.000Z"),
      map: new Map([["a", 1]]),
      set: new Set([1]),
      typed: new Uint8Array([1, 2]),
      error: new Error("boom"),
    };

    const out = toSerializable(payload);

    expect(() => structuredClone(out)).not.toThrow();
    expect(structuredClone(out)).toEqual(JSON.parse(JSON.stringify(out)));
  });

  it("类实例（非原生类型）按 JSON 语义展开为普通对象，方法被丢弃", () => {
    class Point {
      constructor(
        public x: number,
        public y: number,
      ) {}

      get sum(): number {
        return this.x + this.y;
      }
    }

    const out = toSerializable({ point: new Point(1, 2) });

    expect(out.point).toEqual({ x: 1, y: 2 });
    expect(Object.getPrototypeOf(out.point)).toBe(Object.prototype);
  });
});

describe("toSerializable：循环引用与共享引用", () => {
  it("自引用对象保持环状，且结果可被结构化克隆", () => {
    const cyclic: any = { name: "c" };
    cyclic.self = cyclic;

    const out = toSerializable(cyclic);

    expect(out.self).toBe(out);
    expect(() => structuredClone(out)).not.toThrow();
  });

  it("互相引用的两个对象同样保持环状", () => {
    const a: any = { name: "a" };
    const b: any = { name: "b", a };
    a.b = b;

    const out = toSerializable({ a, b });

    expect(out.a.b).toBe(out.b);
    expect(out.b.a).toBe(out.a);
  });

  it("同一对象的多次引用在结果里共用同一个副本（不是各复制一份）", () => {
    const shared = { v: 1 };
    const out = toSerializable({ x: shared, y: shared, list: [shared] });

    expect(out.x).toBe(out.y);
    expect(out.list[0]).toBe(out.x);
  });

  it("数组自引用不会无限递归", () => {
    const arr: any[] = [1];
    arr.push(arr);

    const out = toSerializable(arr);

    expect(out[0]).toBe(1);
    expect(out[1]).toBe(out);
  });
});

describe("toSerializable：字面量 __proto__ 键不得改写输出对象原型（A-2）", () => {
  /** 修复前 `out[key] = item` 的等价实现，仅用于对照演示（见下方用例） */
  function legacyPlainCopy(raw: Record<string, any>): Record<string, any> {
    const out: Record<string, any> = {};
    for (const key of Object.keys(raw)) {
      out[key] = raw[key];
    }
    return out;
  }

  it("修复前：out[key] = item 把 __proto__ 的值当成输出对象的新原型，该键被静默丢弃", () => {
    const remote = JSON.parse('{"__proto__":{"__ptdPollutedDemo":"yes"}}');
    const out = legacyPlainCopy(remote);

    // 输出对象**没有**这个自有属性（写入命中了 Object.prototype.__proto__ 的 setter）……
    expect(Object.hasOwn(out, "__proto__")).toBe(false);
    // ……它的原型被换成了数据里的对象，于是数据以「继承属性」的形式泄漏进来（绕过 isPlainObject 等检查）……
    expect(Object.getPrototypeOf(out)).toEqual({ __ptdPollutedDemo: "yes" });
    expect((out as any).__ptdPollutedDemo).toBe("yes");
    // ……而 JSON 往返（消息/落盘的真实形态）里这个键直接消失：数据静默丢失
    expect(JSON.stringify(out)).toBe("{}");
  });

  it("修复后：__proto__ 成为自有可枚举属性，Object.prototype 不被污染", () => {
    const remote = JSON.parse('{"__proto__":{"__ptdPollutedDemo":"yes"}}');
    const out = toSerializable(remote);

    expect(({} as any).__ptdPollutedDemo).toBeUndefined();
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(Object.hasOwn(out, "__proto__")).toBe(true);
    expect(Object.getOwnPropertyDescriptor(out, "__proto__")).toMatchObject({
      value: { __ptdPollutedDemo: "yes" },
      enumerable: true,
      writable: true,
      configurable: true,
    });

    // 与 JSON.parse 语义一致：这个键名会被 JSON 往返保留（不是被丢掉）
    const roundTripped = JSON.parse(JSON.stringify(out));
    expect(Object.getOwnPropertyDescriptor(roundTripped, "__proto__")?.value).toEqual({ __ptdPollutedDemo: "yes" });
    expect(Object.getPrototypeOf(roundTripped)).toBe(Object.prototype);
  });

  it("嵌套位置（对象 / 数组元素 / Map 键值）的 __proto__ 键同样只写自有属性", () => {
    const remote = JSON.parse(
      '{"nested":{"__proto__":{"__ptdPollutedDemo":"nested"}},"list":[{"__proto__":{"__ptdPollutedDemo":"list"}}]}',
    );

    const out = toSerializable(remote);

    expect(({} as any).__ptdPollutedDemo).toBeUndefined();
    expect(Object.getPrototypeOf(out.nested)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(out.nested, "__proto__")?.value).toEqual({ __ptdPollutedDemo: "nested" });
    expect(Object.getPrototypeOf(out.list[0])).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(out.list[0], "__proto__")?.value).toEqual({ __ptdPollutedDemo: "list" });

    const fromMap = toSerializable(new Map([["__proto__", { polluted: "map" }]]));
    expect(({} as any).polluted).toBeUndefined();
    expect(fromMap).toEqual([["__proto__", { polluted: "map" }]]);
  });
});
