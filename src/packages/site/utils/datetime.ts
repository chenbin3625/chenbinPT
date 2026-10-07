import { add, sub, parse, isValid, format, type DurationUnit } from "date-fns";

export type timezoneOffset = `${"UTC" | ""}${"-" | "+"}${number}`;
export type isoDuration = `P${string}`;

enum DateUnitDuration {
  Second = 1,
  Minute = 60 * Second,
  Hour = 60 * Minute,
  Day = 24 * Hour,
  Week = 7 * Day,
  Month = 30 * Day,
  Quarter = 3 * Month,
  Year = 365 * Day,
}

export const dateUnit: Array<DurationUnit | "quarters"> = [
  "years",
  "quarters",
  "months",
  "weeks",
  "days",
  "hours",
  "minutes",
  "seconds",
] as const;

/**
 * 非标准单位表（中英文别名）。
 *
 * 两条硬性要求，改动本表时请一并检查（B-21）：
 * 1. **每个数组按字符串长度降序排列**。单位正则是 `(\d+)\s*(单位)`，同一单位内的多个别名
 *    之间是正则「或」关系，长别名必须排在前面，否则短别名会先命中并留下残尾
 *    （`month` 必须先于 `mo`，`hour` 必须先于 `hr`，`小时` 必须先于 `时`）。
 * 2. **简体与繁体两字形式都要列出**。正则是 `(\d+)\s*(单位)`，单位必须**紧跟数字**，
 *    因此 `"1个月"` / `"5小时"` 无法靠单字别名（`月` / `时`）间接匹配，必须显式给出
 *    `个月` / `小时`，否则整段时长会被静默丢弃甚至原样返回字符串。
 */
export const nonStandDateUnitMap: Record<(typeof dateUnit)[number], string[]> = {
  years: ["year", "yr", "年", "Y"],
  quarters: ["quarter", "qtr", "季度"],
  months: ["month", "個月", "个月", "mo", "月", "M"],
  weeks: ["week", "wk", "週", "周", "W"],
  days: ["day", "天", "日", "D"],
  hours: ["hour", "小時", "小时", "hr", "时", "h"],
  minutes: ["minute", "min", "分鐘", "分钟", "分", "m"],
  seconds: ["second", "sec", "秒", "s"],
};

const dateUnitToSecondsMap: Record<(typeof dateUnit)[number], number> = {
  years: DateUnitDuration.Year,
  quarters: DateUnitDuration.Quarter,
  months: DateUnitDuration.Month,
  weeks: DateUnitDuration.Week,
  days: DateUnitDuration.Day,
  hours: DateUnitDuration.Hour,
  minutes: DateUnitDuration.Minute,
  seconds: DateUnitDuration.Second,
};

/**
 * 预编译正则，避免每次调用 parseTimeToLiveToSeconds 都重新编译（原实现每次调用 16 次 new RegExp）
 */
const nonStandDateUnitRegexes: Array<[string, RegExp]> = Object.entries(nonStandDateUnitMap).map(([k, v]) => {
  // 再按长度降序排一次：保证「最长匹配优先」不依赖单位表里手写的顺序（见 nonStandDateUnitMap 的说明）
  const longestFirst = [...v].sort((a, b) => b.length - a.length);
  // 单字符 ASCII 单位需要「后面不接字母」的边界：
  // - 既避免在单词内部误匹配（`h` 不应命中 `hour` 中的 `h`）；
  // - 又允许 `2h30m` / `1D2h` 这类紧凑写法，而修复前的 `(?=\s|$)` 会把它们整段拒绝（B-24）。
  //
  // 边界必须是「任何字母」而不是 `[A-Za-z]`：站点里存在非英文的时长词，例如 ncore（匈牙利语）
  // 只归一化了 éve/hete/napja/órája/perce，没有 hónap/hét，于是 `"1 hónapja"` 里的 `h`(小时)
  // 会在 `[A-Za-z]` 版本下**通过**边界检查 → 静默返回 3600 秒（错值），而不是走「明确失败」。
  // 用 `\p{L}` 需要 `u` 标志（故下面的 RegExp 带 "gu"）。
  //
  // ⚠️ 维护须知：`u` 模式下单位串里的字符会被**严格解析**——往 `nonStandDateUnitMap` 添加含
  // 正则元字符的条目（如 `{2}`、`+`、`\p`）会让 `new RegExp` 在**模块加载时抛 SyntaxError**，
  // 即整个 datetime 模块不可用（不是等到运行时才失败）。当前表内 35 项已逐一验证可编译；
  // 新增条目请只写纯文本单位，或在此处显式转义。
  const unitConvArr = longestFirst.map((str) => (/^[A-Za-z]$/.test(str) ? `${str}(?!\\p{L})` : str));
  return [k, new RegExp(`(\\d+)\\s*(${unitConvArr.join("|")})`, "gu")];
});

const dateUnitRegexMap = new Map<(typeof dateUnit)[number], RegExp>(
  dateUnit.map((v) => [v, new RegExp(`([.\\d]+) ?(${v}s?)`)]),
);

/**
 * 剥离输入中所有「数字 + 标准单位」片段，用于检查是否还有没被识别的数字残留。
 * 与 dateUnitRegexMap 同源（同样的 `([.\d]+) ?单位s?` 形状），只是这里要处理全部出现。
 */
const consumedDateUnitRegex = new RegExp(dateUnit.map((v) => `[.\\d]+ ?${v}s?`).join("|"), "g");

export function parseTimeToLiveToSeconds(ttl: string): number | string {
  // A flag to check if we have successfully parsed any unit
  let parsed = false;

  // Deep copy of ttl to avoid side effects
  let ttlTemp = ttl;

  // 处理原始字符串中的非标准Unit
  for (const [k, regex] of nonStandDateUnitRegexes) {
    regex.lastIndex = 0; // 使用模块级 /g 正则，显式复位以保证 replace 行为稳定
    ttlTemp = ttlTemp.replace(regex, `$1 ${k}`);
  }

  let seconds = 0;
  for (const [v, regex] of dateUnitRegexMap) {
    const matched = ttlTemp.match(regex);
    if (matched) {
      parsed = true;
      const amount = parseFloat(matched[1]);
      seconds += amount * dateUnitToSecondsMap[v];
    }
  }

  // 「部分匹配」必须当作解析失败：只要有数字没能被任何单位消费掉（例如单位表未覆盖 `个月`、
  // 或输入里混入了别的数字），累加出来的数值就是错的，比返回原始字符串更难发现（B-21）。
  // 调用方按 `typeof === "string"` 判断解析失败，因此这里原样返回输入。
  const residual = ttlTemp.replace(consumedDateUnitRegex, " ");
  if (parsed && !/\d/.test(residual)) {
    return seconds;
  }

  return ttl;
}

export function parseTimeToLiveToDate(ttl: string): number | string {
  const parsedTTL = parseTimeToLiveToSeconds(ttl);
  if (typeof parsedTTL === "string") return parsedTTL;
  return +sub(new Date(), { seconds: parsedTTL });
}

export function parseValidTimeString(query: string, formatString: string[] = []): number | string {
  for (const f of [...formatString, "yyyy-MM-dd'T'HH:mm:ssXXX", "yyyy-MM-dd HH:mm:ss", "yyyy-MM-dd HH:mm:ss.SSS"]) {
    try {
      const time = parse(query, f, new Date());
      if (isValid(time)) {
        return +time;
      }
    } catch {
      // A bad site-defined format must not prevent the remaining formats from being tried.
    }
  }

  // 尝试使用原生 Date 构造函数，它能处理很多常见格式
  let nativeDate = new Date(query);
  if (isValid(nativeDate)) {
    return +nativeDate;
  }

  return query;
}

// DEFS3-3：允许时间与数值偏移之间存在空白（如 `2024-03-10 10:41 +0800`）。
// 原生 Date 已能把这类串解析成绝对时间，正则若不识别，下面的 parseValidTimeStringInZone 会把它
// 当作墙上时间再按站点偏移二次换算（并把宿主时区的 local 字段当成站点时间），结果随运行主机漂移。
const explicitTimeZonePattern = /[T\s]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?\s*(?:Z|[+-]\d{2}:?\d{2})$/i;
const wallTimePattern = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2})(?::(\d{2})(\.\d+)?)?)?$/;

/**
 * 本地日历方法全部落到 UTC 的 Date：给 date-fns 的 `parse` 当上下文用（`in` 选项），
 * 让「墙上时间字段」的解析与宿主时区（含夏令时跳变）完全脱钩。
 */
class UTCWallDate extends Date {
  constructor(value: number | string | Date = Date.now()) {
    super(value instanceof Date ? +value : value);
  }
  override getFullYear() {
    return this.getUTCFullYear();
  }
  override getMonth() {
    return this.getUTCMonth();
  }
  override getDate() {
    return this.getUTCDate();
  }
  override getDay() {
    return this.getUTCDay();
  }
  override getHours() {
    return this.getUTCHours();
  }
  override getMinutes() {
    return this.getUTCMinutes();
  }
  override getSeconds() {
    return this.getUTCSeconds();
  }
  override getMilliseconds() {
    return this.getUTCMilliseconds();
  }
  override getTimezoneOffset() {
    return 0;
  }
  override setFullYear(...args: Parameters<Date["setUTCFullYear"]>) {
    return this.setUTCFullYear(...args);
  }
  override setMonth(...args: Parameters<Date["setUTCMonth"]>) {
    return this.setUTCMonth(...args);
  }
  override setDate(date: number) {
    return this.setUTCDate(date);
  }
  override setHours(...args: Parameters<Date["setUTCHours"]>) {
    return this.setUTCHours(...args);
  }
  override setMinutes(...args: Parameters<Date["setUTCMinutes"]>) {
    return this.setUTCMinutes(...args);
  }
  override setSeconds(...args: Parameters<Date["setUTCSeconds"]>) {
    return this.setUTCSeconds(...args);
  }
  override setMilliseconds(ms: number) {
    return this.setUTCMilliseconds(ms);
  }
}

export function parseValidTimeStringInZone(
  query: string,
  formatString: string[],
  offset: timezoneOffset,
): number | string {
  if (/^\d+$/.test(query)) return parseTimeWithZone(query, offset);
  if (wallTimePattern.test(query)) return parseTimeWithZone(query, offset);

  // 站点自定义格式：在 UTC 上下文里解析出墙上时间字段，再按站点时区换算。
  // 不能先让 date-fns 按宿主时区 parse 再 format 回字段 —— 宿主处于夏令时跳变的那一小时
  // （如纽约 2024-03-10 02:30 不存在）时，parse 会把它挪到 03:30，站点时间就差 1 小时。
  for (const f of formatString) {
    try {
      // 格式里没有的字段（如年份）取自参考日期，与 date-fns 默认一致取当前时刻
      const wall = parse(query, f, new UTCWallDate(), { in: (value) => new UTCWallDate(value) });
      if (!isValid(wall)) continue;
      // 格式自带时区（XXX / 'Z' 等）时 date-fns 已换算成绝对时间，直接返回
      if (/[XxOz]/.test(f.replace(/'[^']*'/g, ""))) return +wall;
      return parseTimeWithZone(new Date(+wall).toISOString().slice(0, 23), offset);
    } catch {
      // 坏格式不阻止后续格式的尝试
    }
  }

  const parsed = parseValidTimeString(query, formatString);
  if (typeof parsed !== "number" || explicitTimeZonePattern.test(query)) return parsed;

  // date-fns parsed an unzoned wall time in the host zone. Reuse its calendar fields,
  // then apply the site's zone exactly once.
  return parseTimeWithZone(format(parsed, "yyyy-MM-dd'T'HH:mm:ss.SSS"), offset);
}

/**
 * 解析时区偏移文本，返回 `±HH:MM` 形式；无法识别时返回 `null`（由调用方按解析失败处理）。
 *
 * 声明类型 `timezoneOffset` 允许 `+8` / `UTC+8` / `+0800` 等写法，因此这里显式接受
 * 「可选 UTC 前缀 + 符号 + 1~2 位小时 + 可选冒号 + 可选 2 位分钟」，缺分钟按 `00` 处理（B-23）。
 * 修复前只在 `[+-]HHMM` 上匹配，`"+8"` / `"UTC+8"` / `"+08:00"` 失配后会**静默**按运行主机的
 * 本地时区解释站点的墙上时间，产生随机器变化的偏移。
 */
function parseTimezoneOffset(value: string): string | null {
  const matched = /^(?:UTC)?([+-])(\d{1,2}):?(\d{2})?$/.exec(value ?? "");
  if (!matched) {
    return null;
  }

  const [, sign, hoursText, minutesText] = matched;
  const hours = Number(hoursText);
  const minutes = minutesText ? Number(minutesText) : 0;
  if (hours > 23 || minutes > 59) {
    return null;
  }

  return `${sign}${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}`;
}

/**
 * 将时间解析为时间戳。
 *
 * timezoneOffset 表示**输入时间所采用的时区**，即站点本地时间相对 UTC 的偏移：
 * - 输入为字符串（如 "2024-03-01 10:00:00"）时，该字符串是站点的墙上时间，
 *   按其偏移换算为 UTC 时间戳；该墙上时间不随时间变化（如 "-0400" 的站点在
 *   夏令时期间仍按同一偏移解析）。
 * - 输入为 Unix 时间戳（秒或毫秒）时，它已经是绝对时间，本函数直接原样返回，
 *   不再套用偏移——否则偏移会被重复计算，且解析结果依赖运行主机的本地时区。
 *
 * **本函数是全函数（total），不会抛异常**：无效日期（如 `"昨天"`）、空值（`null` /
 * `undefined` / `""`）与无法识别的偏移一律返回 `0`（Unix 纪元）作为安全值，
 * 绝不按运行主机的本地时区猜测，调用方可用 `timestamp === 0` 判断解析失败（B-1 / B-23）。
 *
 * @param time 时间字符串或 Unix 时间戳（秒/毫秒）
 * @param timezoneOffset 输入时间所属时区的偏移，如 "+0800"
 */
export function parseTimeWithZone(
  time: number | string | null | undefined,
  timezoneOffset: timezoneOffset = "+0000",
): number {
  // Unix 时间戳（秒/毫秒）本身就是绝对时间，无需也无法再做时区换算
  if (typeof time === "number") {
    // NaN / ±Infinity 不是时间戳，返回安全值而不是把 NaN 扩散给调用方
    if (!Number.isFinite(time)) {
      return 0;
    }
    // 10 位及以下视为秒级时间戳
    return String(Math.trunc(time)).length <= 10 ? time * 1000 : time;
  }

  // 空值：`new Date(null)` 是 1970-01-01（静默变成纪元），`new Date("")` 是 Invalid Date，
  // 两者都不能代表站点的墙上时间，统一按解析失败处理
  if (time === null || time === undefined || time === "") {
    return 0;
  }

  // 纯数字字符串同样是 Unix 时间戳
  if (/^\d+$/.test(time)) {
    const timestamp = Number(time);
    return String(Math.trunc(timestamp)).length <= 10 ? timestamp * 1000 : timestamp;
  }

  if (explicitTimeZonePattern.test(time)) {
    const absoluteTime = Date.parse(time);
    return Number.isNaN(absoluteTime) ? 0 : absoluteTime;
  }

  // 字符串形式为站点本地的墙上时间，显式按其偏移构造，避免依赖运行主机的本地时区
  const offset = parseTimezoneOffset(timezoneOffset);
  if (offset === null) {
    // 偏移无法识别时明确失败（返回安全值），而不是落到 `+new Date(time)` 上按宿主机时区算
    return 0;
  }

  const wallTime = wallTimePattern.exec(time);
  if (wallTime) {
    const timestamp = +new Date(
      `${wallTime[1]}T${wallTime[2] ?? "00:00"}:${wallTime[3] ?? "00"}${wallTime[4] ?? ""}${offset}`,
    );
    return Number.isNaN(timestamp) ? 0 : timestamp;
  }

  const date = new Date(time);
  if (Number.isNaN(date.getTime())) {
    // 无效日期（如 "昨天"）：`format()` 对 Invalid Date 会抛 RangeError，必须先拦截
    return 0;
  }

  // 时间格式按 ISO 8601 标准设置，如：2020-01-01T00:00:01+08:00
  return +new Date(`${format(date, "yyyy-MM-dd'T'HH:mm:ss.SSS")}${offset}`);
}

export function convertIsoDurationToDate(duration: isoDuration, timestamp: number): number {
  let date = new Date(timestamp);
  const regex = /P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?/;
  const match = duration.match(regex);
  if (match) {
    const [, years, months, weeks, days, hours, minutes, seconds] = match;
    const timeDelta = {
      years: years ? parseInt(years, 10) : 0,
      months: months ? parseInt(months, 10) : 0,
      weeks: weeks ? parseInt(weeks, 10) : 0,
      days: days ? parseInt(days, 10) : 0,
      hours: hours ? parseInt(hours, 10) : 0,
      minutes: minutes ? parseInt(minutes, 10) : 0,
      seconds: seconds ? parseInt(seconds, 10) : 0,
    };
    date = add(date, timeDelta);
  }
  return date.getTime();
}

export function convertIsoDurationToSeconds(duration: string): number {
  const regex = /P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?/;
  const match = duration.toUpperCase().match(regex);
  if (!match) return 0;
  const [, years, months, weeks, days, hours, minutes, seconds] = match;
  const timeDelta: Record<DurationUnit, number> = {
    years: years ? parseInt(years, 10) : 0,
    months: months ? parseInt(months, 10) : 0,
    weeks: weeks ? parseInt(weeks, 10) : 0,
    days: days ? parseInt(days, 10) : 0,
    hours: hours ? parseInt(hours, 10) : 0,
    minutes: minutes ? parseInt(minutes, 10) : 0,
    seconds: seconds ? parseInt(seconds, 10) : 0,
  };

  return (Object.keys(timeDelta) as DurationUnit[]).reduce((sum, k) => {
    return sum + timeDelta[k] * dateUnitToSecondsMap[k];
  }, 0);
}

/**
 * 将秒数转换为ISO duration格式
 * 主要用于将时间长度转换为标准的ISO 8601 duration格式
 * 只包含日期部分（年、月、周、天），忽略时间部分（时、分、秒）
 */
export function convertSecondsToIsoDuration(seconds: number): isoDuration {
  if (seconds <= 0) return "P0D";

  const years = Math.floor(seconds / (365 * 24 * 3600));
  const remainingAfterYears = seconds % (365 * 24 * 3600);

  const months = Math.floor(remainingAfterYears / (30 * 24 * 3600));
  const remainingAfterMonths = remainingAfterYears % (30 * 24 * 3600);

  const weeks = Math.floor(remainingAfterMonths / (7 * 24 * 3600));
  const remainingAfterWeeks = remainingAfterMonths % (7 * 24 * 3600);

  const days = Math.floor(remainingAfterWeeks / (24 * 3600));

  let duration = "P";

  if (years > 0) duration += `${years}Y`;
  if (months > 0) duration += `${months}M`;
  if (weeks > 0) duration += `${weeks}W`;
  if (days > 0) duration += `${days}D`;

  // 如果所有值都为0，返回P0D
  if (duration === "P") duration = "P0D";

  return duration as isoDuration;
}
