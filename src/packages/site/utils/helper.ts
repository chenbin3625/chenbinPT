// noinspection ES6PreferShortImport

/**
 * Helper functions for other utilities
 */

// P1-4：显式 import type，避免 utils 层与 types 层产生运行时依赖边
import type { ISearchCategoryOptions } from "../types/search";

/**
 * Builds search category options from a given array of strings or string arrays.
 * The name and value of each option will be the same as the string itself.
 *
 * For Example: [ "Anime", ["Audio", "Literature"] ] => [ { name: "Anime", value: "Anime" }, { name: "Audio", value: "Audio" }, { name: "Literature", value: "Literature" } ]
 *
 * @param options
 */
export function buildCategoryOptionsFromList(options: (string | string[])[]): ISearchCategoryOptions[] {
  return options.flat(Infinity).map(
    (option) =>
      ({
        name: option,
        value: option,
      }) as ISearchCategoryOptions,
  );
}

/**
 * Builds search category options from a given dictionary object.
 * The name of each option will be the value from the dictionary,
 * and the value of each option will be the corresponding key.
 *
 * For Example: { "1": "Anime", "2": "Audio" } => [ { name: "Anime", value: "1" }, { name: "Audio", value: "2" } ]
 *
 * @param dict
 */
export function buildCategoryOptionsFromDict(dict: Record<string | number, string>): ISearchCategoryOptions[] {
  return Object.entries(dict).map(([key, value]) => ({ name: value, value: key }) as ISearchCategoryOptions);
}

/**
 * 以固定并发上限执行异步任务，并按输入顺序返回结果。
 *
 * 用于把原来的串行翻页改为「有上限并发」：请求可以重叠，但结果顺序保持与串行一致，
 * 因此调用方按顺序累加/处理时得到的数值与串行实现完全一致。
 *
 * ## 与项目内其它并发原语的关系（P2-3 收敛评估）
 * 仓库中曾并存三套并发机制：
 *  1. `p-queue`：`backupServer/utils.ts`、`social/recommendations.ts` 的通用队列；
 *  2. 本函数 `mapWithConcurrency`：有界并发的 map；
 *  3. `AbstractBittorrentSite.createRequestThrottle`：限制「请求起始间隔」的节流器。
 * 结论：3 已收敛为 p-queue 的薄封装；2 保持自研实现，理由如下——
 *  - `~packages/site/utils.ts` 会被 content-script 入口静态引用，引入 p-queue 会把依赖
 *    `eventemitter3` 的队列整体打进每次页面加载都要执行的引导/主 chunk，而
 *    `social/index.ts` 已明确为「避免把推荐模块（p-queue）内联进 content script」做过处理；
 *  - 本实现让 worker 在同一个同步块内启动（第 N 个任务在同步阶段就开始执行），
 *    调用方与单测都依赖这一时序（见 tests/packages/site/utils/helper.test.ts）；
 *    p-queue 通过微任务调度，无法保持该语义。
 * 因此这里是「有意识的保留」而非遗漏。
 *
 * @param items 待处理的任务输入
 * @param concurrency 并发上限（至少为 1）
 * @param mapper 单个任务的处理函数
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  let nextIndex = 0;

  const workers = new Array(workerCount).fill(0).map(async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) break;
      results[index] = await mapper(items[index], index);
    }
  });

  await Promise.all(workers);
  return results;
}

/**
 * Detects if a search query contains non-Latin characters
 *
 * Uses Unicode Script Extensions to accurately identify Latin vs non-Latin characters.
 * Characters from Latin and Common scripts (numbers, punctuation, spaces) are considered Latin.
 * Any other Unicode scripts (Chinese, Japanese, Arabic, Cyrillic, etc.) are considered non-Latin.
 *
 * Mixed character handling: If a query contains both Latin and non-Latin characters,
 * it returns true (treated as non-Latin) to ensure compatibility with sites that
 * support the non-Latin characters.
 *
 * @param query - The search query string to analyze
 * @returns true if the query contains any non-Latin characters, false if only Latin/Common characters
 *
 * @example
 * ```typescript
 * hasNonLatinCharacters("hello world"); // false - only Latin
 * hasNonLatinCharacters("你好世界"); // true - Chinese characters
 * hasNonLatinCharacters("hello 世界"); // true - mixed Latin and Chinese
 * hasNonLatinCharacters("123 !@#"); // false - numbers and punctuation are Common script
 * hasNonLatinCharacters(""); // false - empty string
 * ```
 */
export function hasNonLatinCharacters(query: string): boolean {
  try {
    // Return true if query contains any characters outside Latin and Common scripts
    // Latin script includes basic Latin, Latin-1 Supplement, Latin Extended-A/B, etc.
    // Common script includes numbers, punctuation, spaces, and other script-neutral characters
    const latinAndCommonOnly = /^[\p{Script_Extensions=Latin}\p{Script_Extensions=Common}]*$/u;

    return !latinAndCommonOnly.test(query);
  } catch (error) {
    // Fallback: if Unicode Script Extensions are not supported or any error occurs,
    // default to false (treat as Latin) to ensure search functionality continues
    console.warn("Character detection failed, defaulting to Latin-only detection:", error);
    return false;
  }
}

/** 判定「敏感字段名」的规则：密码、token、cookie、密钥、鉴权、会话等 */
const sensitiveFieldNamePattern =
  /pass(word)?|pwd|token|secret|cookie|credential|api[-_]?key|auth(orization)?|session|csrf|2fa|otp/i;

const MAX_REDACT_DEPTH = 6;

/**
 * 复制时跳过的段名：`ret["__proto__"] = ...` 是**设置原型**而不是新增属性，
 * 而远端 JSON 里的 `{"__proto__": {...}}` 经 `JSON.parse` 后是自有属性、会被
 * `Object.entries` 列出，直接赋值就会污染 `ret` 的原型（A-20，与 B-22 同类）。
 * 这三个名字都不是真实的数据字段，脱敏结果里省略它们是安全且更易读的。
 */
const UNSAFE_REDACT_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * 深拷贝对象并把敏感字段值替换为 `***`，用于日志输出前的脱敏。
 *
 * 设计取舍（见 P1-2）：
 * - 仅处理「普通对象 / 数组 / 基础类型 / Date」，其余对象（Document、Element、AxiosResponse、
 *   类实例等）一律降级为 `[ConstructorName]`，避免日志序列化时出现 DOM 结构爆炸或循环引用；
 * - 有深度上限，超限降级为 `[MaxDepth]`；
 * - 不回写原对象，返回全新结构，调用方可以安全打印；
 * - `__proto__` / `constructor` / `prototype` 三个键会被跳过，避免原型污染（见 UNSAFE_REDACT_KEYS）。
 *
 * @param value 待脱敏的数据
 * @param depth 内部递归深度（调用方无需传入）
 */
export function redactSensitive<T>(value: T, depth: number = 0): any {
  if (value === null || typeof value !== "object") {
    return value;
  }

  if (depth >= MAX_REDACT_DEPTH) {
    return "[MaxDepth]";
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactSensitive(item, depth + 1));
  }

  if (value instanceof Date) {
    return value;
  }

  // 正则（站点 metadata 中大量存在）在调试日志里保留可读形式
  if (value instanceof RegExp) {
    return String(value);
  }

  // 只递归普通对象；类实例（DOM、axios 等）直接降级，避免日志体量与循环引用问题
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    return `[${(value as object).constructor?.name ?? "Object"}]`;
  }

  const ret: Record<string, any> = {};
  for (const [key, val] of Object.entries(value as Record<string, any>)) {
    // 跳过会改变原型（而不是新增属性）的键名，见 UNSAFE_REDACT_KEYS
    if (UNSAFE_REDACT_KEYS.has(key)) {
      continue;
    }
    ret[key] = sensitiveFieldNamePattern.test(key) ? "***" : redactSensitive(val, depth + 1);
  }
  return ret;
}
