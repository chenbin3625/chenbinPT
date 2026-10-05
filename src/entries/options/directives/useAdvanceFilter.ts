import { filesize } from "filesize";
import { get } from "es-toolkit/compat";
import { refDebounced } from "@vueuse/core";
import { computed, type Ref, ref, unref, watch, isRef } from "vue";
import { flatten, flattenDeep, isEqual, uniq, uniqBy } from "es-toolkit";
import { startOfDay, startOfMonth, startOfQuarter, startOfWeek, startOfYear } from "date-fns";
import searchQueryParser, { type SearchParserOptions, SearchParserResult as TFilter } from "search-query-parser";

import { parseSizeString, parseValidTimeString } from "@ptd/site";
import { formatDate } from "@/options/utils.ts";

type TAdvanceFilterFormat = "date" | "size" | "number" | "boolean";

export interface ITextValue {
  required: string[];
  exclude: string[];
}

export interface IRangedField {
  range: [number, number];
  ticks: number[];
}

interface IValueFormat {
  parse?: (value: any) => any;
  build?: (value: any) => string;
}

export const dateFilterFormat = [
  "T",
  "yyyyMMdd'T'HHmmss",
  "yyyyMMdd'T'HHmm",
  "yyyyMMdd'T'HH",
  "yyyyMMdd",
  "yyyyMM",
  "yyyy",
];

/**
 * B-15：boolean 必须显式判断，不能靠真值。
 * 早期实现是 `(value) => (value ? "1" : "0")`，而字符串 "0" 在 JS 里是真值 ——
 * 实测 parse("0") === "1"、build("0") === "1"，于是用户输入的 `userConfig.isOffline:0`
 * 经 buildFilterDictFn 归一化后被改写成 `:1`，筛选语义完全反转
 * （`SetSite/Index.vue` 里写死 "1" 的绕行只是掩盖症状）。
 * 保留对数字 1 的容忍（`parse(1)` 在修复前也是 "1"），其余一律归一化为 "0"。
 */
const toBooleanFilterValue = (value: unknown): string =>
  value === true || value === 1 || value === "1" || value === "true" ? "1" : "0";

const advanceFilterFormat: Record<TAdvanceFilterFormat, IValueFormat> = {
  date: {
    parse: (value: string | number) => {
      if (typeof value === "number") return value;
      else return parseValidTimeString(value, dateFilterFormat) as number;
    },
    build: (value: string | number) => formatDate(value, "yyyyMMdd'T'HHmmss") as string,
  },
  size: {
    parse: (value: string | number) => {
      if (typeof value === "number") return value;
      else return parseSizeString(value);
    },
    build: (value: string | number) => filesize(value, { spacer: "" }) as string,
  },
  // 对 number 全部转为字符串比较
  number: {
    parse: (value: string | number) => value.toString(),
    build: (value: string | number) => value.toString(),
  },
  // B-15：显式判断（见 toBooleanFilterValue 的说明）
  boolean: {
    parse: toBooleanFilterValue,
    build: toBooleanFilterValue,
  },
} as const;

type TFormat = Record<string, TAdvanceFilterFormat | IValueFormat>;

/**
 * B-14：转义方案必须与 search-query-parser（1.6.0）的解析行为对齐，且必须可逆。
 *
 * 早期实现用「反斜杠 + `\u00XX`」转义保留字符，但库在 parse 时会剥掉反斜杠
 * （`val.replace(/\\(.?)/g, ...)`），`My\u0020Sites` 被解析成 `Myu0020Sites`；
 * 而 unEscapeQueryValue 用来匹配的 token 是带反斜杠的 `\u0020` —— 永远匹配不上。
 * 实测（同版本库）：`My Sites → Myu0020Sites`、`a,b → au002cb`、`hello world → hellou0020world`，
 * 即「设置 → 站点」里分组名为 `My Sites` 时表格零行命中而复选框仍勾选。
 *
 * 现在改用百分号编码，编码结果里不含反斜杠/引号/逗号/空白，因此不会被 parse 改写：
 * - `,`：库会把 keyword 的值按 `,` 拆成多个值（`value.split(",")`），必须编码；
 * - 空白：库的 stringify 只给「含空格的单个值」加引号，而多值场景下 `site:"My Sites",foo`
 *   实测会被解析成 `site:["My Sites"]` + text `",foo"`（值被拆错），故空白也要编码；
 * - `:`：避免值被重新解析成 `${keyword}:${value}`（例如纯文本筛选 `site:x`）；
 * - `\`、`"`、`'`：库会剥掉反斜杠 / 去掉首尾引号，必须编码；
 * - `%`：先编码自身，保证「值里本来就有 %xx」时也能无损往返。
 * 编解码都必须只做一次：decodeURIComponent 不是幂等的（`a%252Cb` 解两次会变成 `a,b`）。
 */
function escapeQueryValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  // encodeURIComponent 不处理 !'()*~，这里一并编码，避免引号参与库的引号解析
  return encodeURIComponent(value).replace(
    /[!'()*~]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
  );
}

function unEscapeQueryValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return decodeURIComponent(value);
  } catch {
    // 用户手写的非法百分号序列（例如 `100%`）：原样返回，不做任何猜测
    return value;
  }
}

function normalizeFilterValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return unEscapeQueryValue(value) as string;
}

// /pattern/[gimsuy]
const regexLiteralPattern = /^\/((?:\\.|[^\\/])*)\/([gimsuy]*)$/;
const regexCache = new Map<string, RegExp | null>();

/**
 * 仅解析 /pattern/[gimsuy] 结构，失败时返回 null。
 * 入参必须是**已解码**的值（调用方都先走 normalizeFilterValue）——解码不可重入，这里不再解一次。
 */
function toRegexIfValid(normalizedValue: unknown): RegExp | null {
  if (typeof normalizedValue !== "string") return null;

  if (regexCache.has(normalizedValue)) {
    return regexCache.get(normalizedValue) ?? null;
  }

  const matched = regexLiteralPattern.exec(normalizedValue);
  if (!matched) {
    regexCache.set(normalizedValue, null);
    return null;
  }

  const [, pattern, flags] = matched;
  try {
    // B-16：必须剔除 g/y。regexCache 对每个 pattern 只保留一个实例并被 `regex.test()` 反复复用，
    // 带 g/y 时 lastIndex 会跨值残留，出现「隔一个值命中一次」——实测 `/1080p/g` 复用于
    // ["a1080pb","c1080pd","e1080pf","g1080ph"] 得到 true,false,true,false（期望全 true）。
    const regex = new RegExp(pattern, flags.replace(/[gy]/g, ""));
    regexCache.set(normalizedValue, regex);
    return regex;
  } catch {
    regexCache.set(normalizedValue, null);
    return null;
  }
}

function matchFilterValue(itemValue: string, rawFilterValue: unknown): boolean {
  const filterValue = normalizeFilterValue(rawFilterValue);
  if (typeof filterValue !== "string") return false;
  const regex = toRegexIfValid(filterValue);
  return regex ? regex.test(itemValue) : itemValue === filterValue;
}

const getRaw = (x: any) => x;
function getValueFormat(key: string, format: TFormat = {}): Required<IValueFormat> {
  let valueFormatFn: IValueFormat = {};

  if (format[key]) {
    if (typeof format[key] === "string" && advanceFilterFormat[format[key] as TAdvanceFilterFormat]) {
      valueFormatFn = advanceFilterFormat[format[key] as TAdvanceFilterFormat];
    } else {
      const { parse: parseFn, build: buildFn } = format[key] as IValueFormat;
      valueFormatFn.parse ??= parseFn;
      valueFormatFn.build ??= buildFn;
    }
  }

  valueFormatFn.parse ??= getRaw;
  valueFormatFn.build ??= getRaw;

  return valueFormatFn as Required<IValueFormat>;
}

export function getThisDateUnitRange(
  dateType: "day" | "week" | "month" | "quarter" | "year",
  range: [number, number],
): [number, number] {
  const [minDate, maxDate] = range;

  const now = new Date();
  const start = {
    day: startOfDay(now),
    week: startOfWeek(now),
    month: startOfMonth(now),
    quarter: startOfQuarter(now),
    year: startOfYear(now),
  }[dateType];

  return [Math.max(minDate, start.getTime()), Math.min(maxDate, now.getTime())];
}

export function generateRangeField(data: (number | undefined)[]): IRangedField {
  const numData = data.filter((x) => !isNaN(x as unknown as number)) as number[];

  return {
    range: numData.length > 0 ? [Math.min(...numData), Math.max(...numData)] : [-Infinity, Infinity],
    ticks: Array.from(new Set(data)) as number[],
  };
}

export function setDateRangeByDatePicker(value: unknown[]): [number, number] {
  const dateRange = value as Date[];
  return [dateRange[0].getTime(), dateRange[dateRange.length - 1].getTime()];
}

type TRawItem = { [key: string]: any };

export function checkKeywordValue(
  filter: TFilter,
  rawItem: TRawItem,
  keyword: string,
  format: TFormat = {},
  exclude = false,
  // @ts-ignore
): boolean | undefined {
  const itemValue = get(rawItem, keyword); // true    filter[keyword] = ['1']
  if (filter[keyword]) {
    // 如果原始数据中没有该 keyword 字段，则直接返回 false
    if (typeof itemValue == "undefined") {
      return false;
    }

    const valueFormat = getValueFormat(keyword as string, format);
    if (Array.isArray(itemValue)) {
      const parsedValues = itemValue.map((v: any) => valueFormat.parse(v) as string);
      const filterVals = filter[keyword] as string[];
      // 如果是正向关键词则要求全部包含，如果是排除关键词则要求有任意一个包含
      return exclude
        ? filterVals.some((k) => parsedValues.some((v) => matchFilterValue(v, k)))
        : filterVals.every((k) => parsedValues.some((v) => matchFilterValue(v, k)));
    } else {
      const itemParsedValue = valueFormat.parse(itemValue) as string;
      return filter[keyword].some((k: string) => matchFilterValue(itemParsedValue, k));
    }
  }
}

/**
 * P1-16: from/to 的 parse 结果只与「过滤器对象 + keyword + format」有关，
 * 与具体 item 无关。这里按过滤器对象做 WeakMap 缓存，避免每个 item 都重复 parse
 * （parseSizeString / parseValidTimeString 在范围过滤时会被调用 2n 次）。
 * format 变了（引用不同）则重新解析，语义与原实现一致。
 */
const rangeBoundCache = new WeakMap<object, Map<string, { format: TFormat; from: number; to: number }>>();

function getParsedRangeBounds(filter: TFilter, keyword: string, format: TFormat) {
  let keywordCache = rangeBoundCache.get(filter as unknown as object);
  if (!keywordCache) {
    keywordCache = new Map();
    rangeBoundCache.set(filter as unknown as object, keywordCache);
  }

  const cached = keywordCache.get(keyword);
  if (cached && cached.format === format) return cached;

  const valueFormat = getValueFormat(keyword, format);
  const bounds = {
    format,
    from: valueFormat.parse((filter[keyword] as any).from ?? -Infinity) as number,
    to: valueFormat.parse((filter[keyword] as any).to ?? Infinity) as number,
  };
  keywordCache.set(keyword, bounds);
  return bounds;
}

export function checkRangeValue(
  filter: TFilter,
  rawItem: TRawItem,
  keyword: string,
  format: TFormat = {},
  // @ts-ignore
): boolean | undefined {
  const itemValue = get(rawItem, keyword);
  if (filter[keyword] && typeof itemValue !== "undefined") {
    const valueFormat = getValueFormat(keyword, format);
    const value = valueFormat.parse(itemValue) as number;
    const { from, to } = getParsedRangeBounds(filter, keyword, format);

    return value >= from && value <= to;
  }
}

interface TableCustomFilterOptions<ItemType> {
  parseOptions: SearchParserOptions;
  titleFields: string[]; // item的那些部分作为title

  format?: TFormat;

  initialSearchValue?: string; // 用于生成 tableWaitFilterRef 的初始数据
  initialItems?: Ref<ItemType[]> | ItemType[]; // 用于生成 advanceFilterDictRef 的初始数据
  debouncedMs?: number; // 过滤器字符串更新的防抖时间，单位毫秒

  watchItems?: boolean; // 是否监听 items 的变化（需要传入的为ref），动态更新 advanceFilterDictRef
  autoUpdateFilter?: boolean; // 是否在 advanceFilterDictRef 变化时自动更新过滤器字符串（需要传入的为ref）
}

export function useTableCustomFilter<ItemType extends Record<string, any>>(
  options: TableCustomFilterOptions<ItemType>,
) {
  const {
    parseOptions,
    titleFields = ["title"],
    format = {},
    initialSearchValue = "",
    initialItems = [],
    debouncedMs = 500,
    watchItems = false,
    autoUpdateFilter = false,
  } = options;

  // 给 parseOptions 设置一些固定的值，以控制 searchQueryParser.parse 的结果
  parseOptions.tokenize = true;
  parseOptions.offsets = false;
  parseOptions.alwaysArray = true;

  /**
   * 用作输入组件的 v-model，接收用户的直接输入
   */
  const tableWaitFilterRef = ref(initialSearchValue);

  /**
   * 用作数据表格的搜索词，
   * 由于表格过滤操作较重，而用户直接输入的更新操作触发频繁
   * 通过延迟实际使用的搜索过滤词生成来避免不必要的卡顿
   */
  const tableFilterRef = refDebounced(tableWaitFilterRef, debouncedMs); // 延迟搜索过滤词的生成

  /**
   * 用作数据表格内部比较方法 tableFilterFn
   * 通过 computed 来缓存 实际使用的判断字典
   */
  const tableParsedFilterRef = computed<TFilter>(
    () => searchQueryParser.parse(tableFilterRef.value, parseOptions) as TFilter,
  );

  /**
   * 用来表示 initialItems 中 parseOptions.{keywords, ranges} 可选值的字典，结构如下
   * {
   *   `${keyword}`: string[],
   *   `${ranges}`: { range: [min, max], ticks: [x1, x2, x3, ...] }
   * }
   */
  const advanceItemPropsRef = ref<Record<string, any>>({});

  function buildAdvanceItemPropsFn() {
    const unRefedItems = unref(initialItems);

    parseOptions.keywords?.forEach((keyword) => {
      const valueFormat = getValueFormat(keyword, format);

      advanceItemPropsRef.value[keyword] = uniqBy(
        flatten(unRefedItems.map((item) => item[keyword]).filter(Boolean)),
        (x) => valueFormat.parse(x),
      );
    });
    parseOptions.ranges?.forEach((keyword) => {
      advanceItemPropsRef.value[keyword] = generateRangeField(unRefedItems.map((item) => item[keyword]));
    });
  }

  // 方法调用时主动构建一次
  buildAdvanceItemPropsFn();

  // 如果设置了主动观察，且传入的 initialItems 可以被观察，则使用 watch 来自动构建
  if (watchItems && isRef(initialItems)) {
    watch(initialItems, () => buildAdvanceItemPropsFn(), { deep: true });
  }

  /**
   * 一个中间态字典，用于缓存在高级筛选窗口中勾选的项目
   * {
   *   text: { required: string[], exclude: string[] },
   *   `${keyword}`: { required: string[], exclude: string[] },
   *   `${ranges}`: [number, number]
   * }
   */
  const advanceFilterDictRef = ref<Record<string, any>>({});

  // 从 string 中构建 advanceFilterDictRef
  function buildFilterDictFn(text: string = "") {
    const { keywords = [], ranges = [] } = parseOptions;
    const parsedFilter = searchQueryParser.parse(text ?? "", parseOptions) as TFilter;

    ["text", ...keywords].forEach((key) => {
      const valueFormat = getValueFormat(key, format);
      let required: unknown[] = [];
      let exclude: unknown[] = [];

      const thisRequired = parsedFilter[key];
      if (Array.isArray(thisRequired) && thisRequired.length > 0) {
        required = uniq(flattenDeep(thisRequired.map((v: any) => valueFormat.parse(unEscapeQueryValue(v)))));
      }

      const thisExclude = parsedFilter.exclude?.[key];
      if (Array.isArray(thisExclude) && thisExclude.length > 0) {
        exclude = uniq(flattenDeep(thisExclude.map((v: any) => valueFormat.parse(unEscapeQueryValue(v)))));
      }

      advanceFilterDictRef.value[key] = { required, exclude };
    });

    ranges.forEach((key) => {
      const valueFormat = getValueFormat(key, format);

      advanceFilterDictRef.value[key] = [
        parsedFilter[key]?.from ? valueFormat.parse(parsedFilter[key].from) : -Infinity,
        parsedFilter[key]?.to ? valueFormat.parse(parsedFilter[key].to) : Infinity,
      ];
    });
  }

  // 方法调用时主动构建一次
  buildFilterDictFn(initialSearchValue);

  function stringifyFilterDictFn() {
    const { keywords = [], ranges = [] } = parseOptions;
    const filters: any = { exclude: {} };

    ["text", ...keywords].forEach((key) => {
      const valueFormat = getValueFormat(key, format);
      const { required, exclude } = advanceFilterDictRef.value[key] as unknown as ITextValue;
      if (required?.length > 0) {
        filters[key] = uniq(flattenDeep(required.map((v) => escapeQueryValue(valueFormat.build(v)))));
      }
      if (exclude?.length > 0) {
        filters.exclude[key] = uniq(flattenDeep(exclude.map((v) => escapeQueryValue(valueFormat.build(v)))));
      }
    });

    ranges.forEach((key) => {
      const valueFormat = getValueFormat(key, format);
      const value = (advanceFilterDictRef.value[key] as unknown as [number, number]).map(valueFormat.parse);

      if (Number.isFinite(value[0]) || Number.isFinite(value[1])) {
        filters[key] = {
          from: valueFormat.build(Number.isFinite(value[0]) ? value[0] : 0),
          to: Number.isFinite(value[1]) ? valueFormat.build(value[1]) : undefined,
        };
      }
    });

    return searchQueryParser.stringify(filters, parseOptions);
  }

  function updateTableFilterValueFn() {
    tableWaitFilterRef.value = stringifyFilterDictFn();
  }

  if (autoUpdateFilter) {
    watch(
      advanceFilterDictRef,
      () => {
        updateTableFilterValueFn();
      },
      { deep: true },
    );
  }

  const reBuildFilterCountRef = ref<number>(0);
  function reBuildAdvanceFilter(updateItemProps: boolean = false) {
    reBuildFilterCountRef.value++; // 更新计数，防止因为 :key 的问题导致 vue 无法重置 v-checkbox 状态
    if (updateItemProps) buildAdvanceItemPropsFn();
    buildFilterDictFn(""); // 使用空字符串构建
  }

  function toggleKeywordStateFn(field: string, value: string) {
    const keywordState = advanceFilterDictRef.value[field] as ITextValue;
    const state = keywordState.required!.includes(value);
    if (state) {
      keywordState.exclude!.push(value);
    } else {
      keywordState.exclude! = keywordState.exclude!.filter((x: string) => !isEqual(x, value));
    }
  }

  // P1-16：titleFields 拼串（flattenDeep + get + join + toLowerCase）对同一个 item 是稳定的，
  // 而每次改动过滤词都会对所有 item 重新执行。这里按 item 做 WeakMap 缓存，只计算一次。
  const itemTitleCache = new WeakMap<ItemType, string>();
  function getItemTitle(rawItem: ItemType): string {
    let cached = itemTitleCache.get(rawItem);
    if (cached === undefined) {
      cached = flattenDeep(titleFields.map((key) => get(rawItem, key)))
        .filter(Boolean)
        .join("|$|")
        .toString();
      itemTitleCache.set(rawItem, cached);
    }
    return cached;
  }

  function tableFilterFn(value: any, query: string, item: any): boolean {
    const rawItem = item.raw as ItemType;

    const { text, exclude } = tableParsedFilterRef.value;

    const itemTitle = getItemTitle(rawItem);
    const itemTitleLowerCase = itemTitle.toLowerCase();

    if (text) {
      const includeText = Array.isArray(text) ? text : [text];
      if (
        !includeText.every((keyword: string) => {
          const normalizedKeyword = normalizeFilterValue(keyword);
          if (typeof normalizedKeyword !== "string") return false;
          const regex = toRegexIfValid(normalizedKeyword);
          return regex ? regex.test(itemTitle) : itemTitleLowerCase.includes(normalizedKeyword.toLowerCase());
        })
      ) {
        return false;
      }
    }

    if (parseOptions.keywords) {
      for (const keyword of parseOptions.keywords) {
        if (checkKeywordValue(tableParsedFilterRef.value, rawItem, keyword, format) === false) return false;
      }
    }

    if (parseOptions.ranges) {
      for (const keyword of parseOptions.ranges) {
        if (checkRangeValue(tableParsedFilterRef.value, rawItem, keyword, format) === false) return false;
      }
    }

    if (exclude) {
      const { text: exText } = exclude;

      if (exText) {
        const excludesText = Array.isArray(exText) ? exText : [exText];
        if (
          excludesText.some((keyword: string) => {
            const normalizedKeyword = normalizeFilterValue(keyword);
            if (typeof normalizedKeyword !== "string") return false;
            const regex = toRegexIfValid(normalizedKeyword);
            return regex ? regex.test(itemTitle) : itemTitleLowerCase.includes(normalizedKeyword.toLowerCase());
          })
        ) {
          return false;
        }
      }

      if (parseOptions.keywords) {
        for (const keyword of parseOptions.keywords) {
          if (checkKeywordValue(exclude, rawItem, keyword, format, true) === true) return false;
        }
      }

      // NOTE： search-query-parser 不支持 range 的 exclude
    }

    return true;
  }

  return {
    tableWaitFilterRef,
    tableFilterRef,
    tableParsedFilterRef,
    advanceItemPropsRef,
    buildAdvanceItemPropsFn,
    advanceFilterDictRef,
    buildFilterDictFn,
    stringifyFilterDictFn,
    tableFilterFn,
    reBuildFilterCountRef,
    reBuildAdvanceFilter,
    updateTableFilterValueFn,
    toggleKeywordStateFn,
  };
}
