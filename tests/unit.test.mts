/**
 * 最小单元测试集（无新增依赖，仅用仓库已有的 tsx 运行）。
 *
 * 运行：npm run test:legacy（`npm run verify` 会跑；vitest 的 include 是 `tests/**\/*.test.ts`，
 * 不会收集这份 .mts，所以 `npm test` 跑不到这 30 条断言 —— 见 TESTS-8）
 *
 * 覆盖本轮性能修复中最容易出错、且无需浏览器环境即可验证的纯逻辑：
 * - chrome.storage 路径读写（P0-2 / P2-17 的基础设施）
 * - 消息解代理 toSerializable（P1-1，替代原 JSON 深拷贝）
 * - 站点层纯函数 parseSizeString / parseTimeToLiveToSeconds（P2-3 正则常量化后的等价性）
 */
import { reactive, ref } from "vue";

import { getValueByPath, parsePath, removeValueByPath, setValueByPath } from "../src/entries/shared/storagePath.ts";
import { toSerializable } from "../src/entries/shared/messagesSerializable.ts";
import { parseSizeString } from "../src/packages/site/utils/filesize.ts";
import { parseTimeToLiveToSeconds } from "../src/packages/site/utils/datetime.ts";

let passed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, extra?: unknown) {
  if (condition) {
    passed++;
    return;
  }
  failures.push(`${name}${extra === undefined ? "" : ` :: ${JSON.stringify(extra)}`}`);
  console.error("FAIL:", name, extra ?? "");
}

function equal(name: string, actual: unknown, expected: unknown) {
  const ok = Object.is(actual, expected) || JSON.stringify(actual) === JSON.stringify(expected);
  check(name, ok, { actual, expected });
}

// ── 1. storagePath ───────────────────────────────────────────────────
equal("parsePath: dot string", parsePath("a.b.c"), ["a", "b", "c"]);
equal("parsePath: numeric segment → number", parsePath("list.0.name"), ["list", 0, "name"]);
equal("parsePath: array passthrough", parsePath(["x", 1]), ["x", 1]);
equal("parsePath: empty string", parsePath(""), []);

const source = { sites: { mteam: { url: "https://mteam.example", merge: { name: "M-Team" } } }, list: [1, 2] };
equal("getValueByPath: nested", getValueByPath(source, ["sites", "mteam", "merge", "name"]), "M-Team");
equal("getValueByPath: array index", getValueByPath(source, "list.1"), 2);
equal("getValueByPath: missing path", getValueByPath(source, ["sites", "nope", "x"]), undefined);
equal("getValueByPath: empty path returns source", getValueByPath(source, []), source);

const target: any = {};
setValueByPath(target, ["sites", "mteam", "runtimeSettings", "authKey"], "k1");
equal("setValueByPath: creates nested objects", target.sites.mteam.runtimeSettings.authKey, "k1");

const arrTarget: any = {};
setValueByPath(arrTarget, ["list", 0, "id"], 7);
check("setValueByPath: creates array for numeric key", Array.isArray(arrTarget.list) && arrTarget.list[0].id === 7, arrTarget);

const removeTarget: any = { a: { b: { c: 1, d: 2 } } };
removeValueByPath(removeTarget, "a.b.c");
check("removeValueByPath: removes deep key", !("c" in removeTarget.a.b) && removeTarget.a.b.d === 2, removeTarget);
removeValueByPath(removeTarget, "a.b.c.d.e"); // 不应抛错
check("removeValueByPath: missing path is safe", true);

// ── 2. toSerializable（消息解代理）───────────────────────────────────
const plainCase: any = { keep: 1, dropUndefined: undefined, dropFn: () => 1, arr: [1, undefined, () => 2] };
equal(
  "toSerializable: matches JSON semantics for undefined/function",
  JSON.stringify(toSerializable(plainCase)),
  JSON.stringify(JSON.parse(JSON.stringify(plainCase))),
);

const reactiveState = reactive({ sites: { a: { name: "A", merge: { x: [1, 2] } } } });
const unwrapped = toSerializable(reactiveState);
check("toSerializable: unwraps reactive proxy", Object.getPrototypeOf(unwrapped) === Object.prototype, unwrapped);
equal("toSerializable: unwrapped value equals raw", unwrapped, JSON.parse(JSON.stringify(reactiveState)));
check("toSerializable: reactive result is structuredClone-able", (() => {
  try {
    structuredClone(unwrapped);
    return true;
  } catch {
    return false;
  }
})());
equal("toSerializable: ref unwrapped to value", toSerializable(ref({ id: 1 })), { id: 1 });

const special = { d: new Date("2024-01-02T03:04:05Z"), m: new Map([["a", 1]]), s: new Set([1]) };
const specialOut = toSerializable(special) as any;
// A-1 之后的契约：Date/Map/Set 显式转成 JSON 可往返的形状（跨上下文消息与 chrome.storage 都只有 JSON 语义），
// 而不是原样保留（原样保留在 JSON 往返后会变成 {}）。详细契约见 tests/entries/shared/messagesSerializable.test.ts。
check(
  "toSerializable: Date/Map/Set → JSON-safe",
  specialOut.d === Date.parse("2024-01-02T03:04:05Z") &&
    JSON.stringify(specialOut.m) === JSON.stringify([["a", 1]]) &&
    JSON.stringify(specialOut.s) === JSON.stringify([1]),
);

const cyclic: any = { name: "c" };
cyclic.self = cyclic;
const cyclicOut = toSerializable(cyclic);
check("toSerializable: keeps cycles", cyclicOut.self === cyclicOut);
check("toSerializable: cyclic result is structuredClone-able", (() => {
  try {
    const cloned = structuredClone(cyclicOut);
    return cloned.self === cloned;
  } catch {
    return false;
  }
})());

// ── 3. 站点层纯函数（正则常量化后的等价性）──────────────────────────
equal("parseSizeString: 1.5 GiB", parseSizeString("1.5 GiB"), 1.5 * Math.pow(2, 30));
equal("parseSizeString: 700 MB", parseSizeString("700 MB"), 700 * Math.pow(2, 20));
equal("parseSizeString: 2TiB", parseSizeString("2TiB"), 2 * Math.pow(2, 40));
equal("parseSizeString: 0 B", parseSizeString("0 B"), 0);
// 无匹配时原实现（含本次正则常量化之后）返回 0，而不是 NaN
equal("parseSizeString: invalid → 0", parseSizeString("abc"), 0);
equal("parseSizeString: 千分位逗号", parseSizeString("1,024 MiB"), 1024 * Math.pow(2, 20));

equal("parseTimeToLiveToSeconds: 1 day", parseTimeToLiveToSeconds("1 day"), 86400);
equal("parseTimeToLiveToSeconds: 2 weeks", parseTimeToLiveToSeconds("2 weeks"), 14 * 86400);
equal("parseTimeToLiveToSeconds: 3 hours", parseTimeToLiveToSeconds("3 hours"), 3 * 3600);
equal("parseTimeToLiveToSeconds: 30 minutes", parseTimeToLiveToSeconds("30 minutes"), 30 * 60);

// ── 结果 ─────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error(`\n${failures.length} case(s) failed / ${passed + failures.length} total`);
  process.exit(1);
}
console.log(`ALL PASS (${passed} assertions)`);
