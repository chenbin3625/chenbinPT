// noinspection ES6PreferShortImport

import { parseTimeToLiveToDate, parseTimeToLiveToSeconds, parseValidTimeString } from "./datetime.ts";
import { parseLocalizedNumber, parseSizeString } from "./filesize.ts";
import { socialParseUrlMap } from "@ptd/social/index.ts";

/**
 * 尽可能把「纯整数」字符串转成 number（保留非整数/非数字文本的原样）。
 *
 * E03：只认「整组 3 位的千分位」分隔符。早期实现把所有 `,`/空格删掉再匹配整数，
 * 于是 `"1,5"`（欧式小数）会被误转成 `15`。现在 `"1,5"` 保持字符串，交由上层
 * 用 `parseLocalizedNumber` / `parseSizeString` 按真实语义解析。
 */
export function tryToNumber(value: any): number {
  if (typeof value === "string") {
    const trimmed = value.trim();
    const normalized = /^-?\d{1,3}(?:[, \u00a0]\d{3})+$/.test(trimmed) ? trimmed.replace(/[, \u00a0]/g, "") : trimmed;
    if (/^-?\d+$/.test(normalized)) {
      // 尽可能的将返回值转成数字类型
      value = isNaN(parseInt(normalized)) ? 0 : parseInt(normalized);
    }
  }
  return value;
}

/**
 * 把「可能是数字的字段值」归一为有限数字；空值/无法解析时返回 `undefined`。
 *
 * 供 `getFieldData` 这类「零命中回落到 `""`」的读取路径使用：调用方可以据此区分
 * 「字段缺失」（undefined，交给 lastUserInfo 合并/跳过）与「字段真的是 0」。
 * 字符串会按区域数字格式解析（复用 `parseLocalizedNumber`）。
 */
export function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const parsed = parseLocalizedNumber(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * 把「可能是数字的字段值」归一为数字，无法解析时返回 `fallback`（默认 `0`）。
 *
 * 与 `toFiniteNumber` 的区别：不保留「零命中」信息，适合确定要写入 number 字段的场景
 * （如 seeders/leechers/completed 这类缺失即 0 的计数）。
 */
export function normalizeNumericField(value: unknown, fallback = 0): number {
  return toFiniteNumber(value) ?? fallback;
}

type TQueryFilterFn = (query: any, args?: any[]) => any;

/**
 * T-1：用 `satisfies` 而不是 `: Record<string, …>` 标注 —— 后者把 `keyof typeof definedFilters` 宽化成 `string`，
 * 于是定义里 `{ name: "divide" }` 这类不存在的过滤器名能通过类型检查，运行时又被静默跳过（M-12 的根因）。
 */
export const definedFilters = {
  /**
   * Extract values from URL arguments.
   * If more than one arg is provided, the first one that matches will be returned.
   *
   * input: browse.php?cat=123
   * args: ["cat"]
   * results: 123
   */
  querystring: (query, args) => {
    const baseUrl = /^https?:/.test(query as string) ? undefined : "http://localhost/";

    const parsedQueryString = new URL(query, baseUrl).searchParams;
    for (const arg of args!) {
      if (parsedQueryString.has(arg)) {
        return parsedQueryString.get(arg);
      }
    }
    return "";
  },

  /**
   * Extends a string by appending additional characters to the end.
   *
   * input: "a"
   * args: ["b"]
   * results: "ab"
   */
  append: (query, args) => query + (args![0] || ""),

  /**
   * Inserts a string by appending additional characters to the beginning of its current value.
   *
   * input: "b"
   * args: ["a"]
   * results: "ab"
   */
  prepend: (query, args) => (args![0] || "") + query,

  /**
   * Converts a string to lowercase letters. Does not require any parameters.
   *
   * input: MY MOVIE TITLE 1080P
   * results: my movie title 1080p
   */
  toLower: (query) => String(query).toLowerCase(),

  /**
   * Converts a string to uppercase letters. Does not require any parameters.
   *
   * input: my movie title 1080p
   * results: MY MOVIE TITLE 1080P
   */
  toUpper: (query) => String(query).toUpperCase(),

  /**
   * If the pattern string is matched, then the pattern is replaced by a replacement string.
   * args[0] can be a string or a regular expression.
   *
   * input: "Hello, world!"
   * args: ["Hello", "Hi"]
   * results: "Hi, world!"
   */
  replace: (query, args) => String(query).replace(args![0], args![1]),

  /**
   * Divides a string into an array of substrings, and return the selected substring.
   * The first parameter in the argument is the single character pattern used to split the string,
   * and the second parameter is the array element number of the wanted substring,
   * counting from zero for the first element.
   * If the second parameter is omitted, the first element will be returned.
   *
   * input: "Hello, world!"
   * args: [",", 1]
   * results: " world!"
   */
  split: (query, args) => String(query).split(args![0])[args![1] ?? 0],

  /**
   * Removes all leading and trailing white-space characters.
   *
   * input: "  Hello, world!  "
   * results: "Hello, world!"
   */
  trim: (query) => String(query).trim(),

  /**
   * Extracts a number from a string.
   *
   * E03：不能先删逗号/空格再取数字，否则 `"1,5"`（欧式小数）会变成 `15`、
   * `"1.234,56"` 会变成 `1.23456`。这里先取出第一个数字片段，再按区域格式解析。
   *
   * E03 复检 L-2：允许**省略整数部分的小数**（`.5` / `-.5`），否则 `parseNumber(".5")`
   * 会从整数部分开始匹配成 `5`（旧实现 `parseFloat(".5")` = 0.5）。
   *
   * input: "This is 8.5"
   * results: 8.5
   */
  parseNumber: (query) => {
    if (typeof query === "number") {
      return query;
    }
    const queryMatch = String(query ?? "")
      .trim()
      .match(/-?(?:\d+(?:[.,\s\u00a0\u202f]\d+)*|\.\d+)/);
    if (!queryMatch) {
      return 0;
    }
    const parsed = parseLocalizedNumber(queryMatch[0]);
    return Number.isFinite(parsed) ? parsed : 0;
  },

  /**
   * Extracts a size from a string.
   * The size string can be in the format of "123.45 MB" or "123.45MiB".
   *
   * E01/E02：取**第一个**「数字 + 单位」片段（单位大小写不敏感，支持 `B`/`Bytes`），
   * 不再用贪婪正则吞到字符串末尾的 `B`（如 `"700 MB (Blu-ray)"`）导致解析为 0。
   *
   * E01 复检 L-2：数字片段允许以 `.` 开头（`.5 GB`、`0.5 GB`），避免把 `.5` 抽成 `5`（10 倍错值）。
   *
   * input: "This is 8.5 MB"
   * results: 8912896
   */
  parseSize: (query) => {
    if (typeof query === "number") {
      return query;
    }
    const raw = String(query ?? "").trim();
    if (!raw) {
      return 0;
    }

    // 不删除空格：`"[3] 1.5 GB"` 删空格会拼成 `"3]1.5GB"`，必须按原始文本定位片段
    const sizeMatch = raw.match(/((?:\d|\.\d)[\d.,\s\u00a0\u202f]*?)[\s\-_]{0,3}([ZEPTGMK](?:i?B)|B(?:ytes?)?)/i);
    if (sizeMatch) {
      const parsed = parseSizeString(`${sizeMatch[1]}${sizeMatch[2]}`);
      if (parsed > 0) {
        return parsed;
      }
    }

    // 兜底：整段就是带千分位的纯整数时，按字节数处理（站点 tooltip 里的裸字节计数）
    const plain = raw.replace(/[\s,\u00a0\u202f]/g, "");
    if (/^-?\d+$/.test(plain)) {
      return parseInt(plain, 10);
    }

    return 0;
  },

  /**
   * Extracts a valid time from a string.
   * The time string should be in the format of "2021-01-01 12:00:00".
   * If the time string is not valid, the original string will be returned.
   * Only used when you know the format of the time string.
   *
   * input: "2021-01-01 12:00:00"
   * args: ["yyyy-MM-dd HH:mm:ss"]
   * results: 1609488000000
   */
  parseTime: parseValidTimeString,

  /**
   * Extracts a valid time from a string.
   * The time string should be in the format of "1年2月3天4时5分前" or "1 year 3 months ago".
   * all valid time units are:
   *  - year, quarter, month, week, day, hour, minute, second.
   *  - 年, 月, 天, 时, 分, 秒.
   *  - yr, qtr, mo, wk, day, hr, min, sec.
   * If the time string is not valid, the original string will be returned.
   *
   * input: "1 year 2 months 3 days 4 hours 5 minutes ago"
   * results: 1609488000000
   */
  parseTTL: parseTimeToLiveToDate,

  /**
   * Extracts a duration value (seconds) from a string.
   * The time string should be in the format of "1年2月3天4时5分前" or "1 year 3 months ago".
   * all valid time units are:
   *  - year, quarter, month, week, day, hour, minute, second.
   *  - 年, 月, 天, 时, 分, 秒.
   *  - yr, qtr, mo, wk, day, hr, min, sec.
   * If the time string is not valid, the original string will be returned.
   *
   * input: "1 year 2 months 3 days 4 hours 5 minutes"
   * results: 36993900
   */
  parseDuration: parseTimeToLiveToSeconds,

  /**
   * Parses a string into a timestamp (milliseconds).
   * Attempts to use the provided format (e.g. "yyyy-MM-dd HH:mm:ss");
   * if parsing fails, falls back to TTL-style parsing (e.g. "1 year 2 months ago").
   *
   * Example input: "2021-01-01 12:00:00" or "1 year 2 months 3 days 4 hours 5 minutes ago"
   * args: ["yyyy-MM-dd HH:mm:ss"] // optional, specify the time format
   * Returns: 1609488000000 (timestamp). If parsing fails, returns the original string or TTL result.
   */
  parseFuzzyTime: (query, args) => {
    const time = parseValidTimeString(query, args);
    return time === query ? parseTimeToLiveToDate(query) : time;
  },

  // Social Site Parser
  extAnidbId: socialParseUrlMap.anidb,
  extBangumiId: socialParseUrlMap.bangumi,
  extDoubanId: socialParseUrlMap.douban,
  extImdbId: socialParseUrlMap.imdb,
  extTvmazeId: socialParseUrlMap.tvmaze,

  /**
   * Print the query to the console.
   * This filter is used for debugging purposes.
   * No change for the query.
   */
  dump: (query) => {
    console?.log(query);
    return query;
  },
} satisfies Record<string, TQueryFilterFn>;

export const filterNames = Object.keys(definedFilters);

export type TDefinedFilterName = keyof typeof definedFilters;

export interface IDefinedQueryFilter {
  name: TDefinedFilterName;
  args?: any[];
}

export type TQueryFilter = IDefinedQueryFilter | TQueryFilterFn;
