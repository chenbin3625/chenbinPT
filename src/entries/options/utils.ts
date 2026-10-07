import { toRaw, isRef, isReactive, isProxy } from "vue";
// Note: filesize library changed type name from FileSizeOptions to FilesizeOptions in v11.0+
import { filesize, type FilesizeOptions } from "filesize";
import {
  differenceInDays,
  differenceInHours,
  differenceInMonths,
  differenceInWeeks,
  differenceInYears,
  differenceInMinutes,
  format as dateFormat,
} from "date-fns";
import { i18n } from "@/options/plugins/i18n.ts";

export function deepToRaw<T extends Record<string, any>>(sourceObj: T): T {
  const objectIterator = (input: any): any => {
    if (Array.isArray(input)) {
      return input.map((item) => objectIterator(item));
    }
    if (isRef(input) || isReactive(input) || isProxy(input)) {
      return objectIterator(toRaw(input));
    }
    if (input && typeof input === "object") {
      return Object.keys(input).reduce((acc, key) => {
        acc[key as keyof typeof acc] = objectIterator(input[key]);
        return acc;
      }, {} as T);
    }
    return input;
  };

  return objectIterator(sourceObj);
}

/**
 * 在模板里替代 Vue 的 `.stop` 事件修饰符，用于那些「第一个 emit 参数不是 Event」的 antd 组件。
 *
 * `.stop` 会编译成 `withModifiers(fn, ["stop"])`，而它的 stop 守卫是 `(e) => e.stopPropagation()`，
 * 拿到的是组件 emit 的**第一个**参数。antd 的 `a-switch` 是 `emit('click', newChecked, e)`，
 * 于是守卫收到布尔值 newChecked → `TypeError: e.stopPropagation is not a function`
 * （报错栈落在 Switch 内部的 AntdIcon 上，见 MyData / SearchEntity 的显示偏好 popover）。
 *
 * Vue 在调用组件事件处理函数时会把「事件载荷 + 原始事件」整体透传，`.stop` 守卫先执行并**提前 return**，
 * 因此由它改成的事件处理函数拿到的是**最后一个**参数才是原始事件（这里是 `e`）。
 * 只做「存在即调用」的防御：万一将来某个组件不再透传事件，也只是少挡一次冒泡，不会抛错。
 */
export const stopEventPropagation = (...args: unknown[]) => {
  const event = args[args.length - 1] as { stopPropagation?: () => void } | undefined;
  event?.stopPropagation?.();
};

export const formValidateRules: Record<string, (args?: any) => (v: any) => boolean | string> = {
  // OPTIONSSETTINGS-8：默认文案必须走 i18n —— 旧实现硬编码英文，调用方（Editor.vue 的站点名/排序/URL
  // 校验）不传文案时，中文界面也会显示 "Item is required" / "Not url"。
  require: (args: string = i18n.t("common.form.required")) => {
    return (v: any) => !!v || args;
  },
  url: (args: string = i18n.t("common.form.invalidUrl")) => {
    return (v: any) => /^(https?):\/\/[-A-Za-z0-9+&@#/%?=~_|!:,.;[\]]+[-A-Za-z0-9+&@#/%=~_|]$/.test(v) || args;
  },
};

/**
 * 判断「下载服务器 / 媒体服务器」地址是否会以明文发送凭据（M-10）。
 *
 * `http://` 与 Aria2 的 `ws://` 都是明文：apikey / password / token 会在链路上裸奔。
 * 这里只做「能解析出协议且协议不加密」的判定：
 * - 空值、用户还没填完（`example.com`、`http:/` 等 `new URL` 抛错的形态）一律返回 false，
 *   把「格式不对」留给 `formValidateRules.url` 提示，避免一个输入框同时报两种错；
 * - 判定不改变任何行为，只驱动设置页的警告展示（不做静默拦截，用户仍可保存）。
 */
export function isInsecureAddress(address?: string | null): boolean {
  if (!address) {
    return false;
  }
  try {
    const { protocol } = new URL(address);
    return protocol === "http:" || protocol === "ws:";
  } catch {
    return false;
  }
}

export const formatSize = (size: number | string, options?: FilesizeOptions) => {
  try {
    return filesize(size, { base: 2, round: 2, pad: true, ...(options ?? {}) });
  } catch (e) {
    return size;
  }
};

export const formatDate = (date: Date | number | string, format: string = "yyyy-MM-dd HH:mm:ss") => {
  try {
    return dateFormat(date, format);
  } catch (e) {
    return date as string;
  }
};

export const formatDateTimeForTable = (
  date: Date | number | string,
  format: string = "yyyy-MM-dd HH:mm:ss",
): string => {
  const formatted = formatDate(date, format);
  return typeof formatted === "string" ? formatted.replace(" ", "\n") : String(formatted);
};

interface formatTimeAgoOptions {
  weekOnly?: boolean; // 是否只显示周数（即小于一周的显示为“不到一周”）
  spacer?: string; // 年月日等单位之间的分隔符，默认为一个空格
}

export const formatTimeAgo = (sourceDate: Date | number | string, options: formatTimeAgoOptions = {}): string => {
  const nowDate = new Date();

  const { weekOnly = false, spacer = " " } = options;

  if (weekOnly) {
    const weeks = differenceInWeeks(nowDate, sourceDate);
    if (weeks < 1) {
      return i18n.t("common.time.lessThanAWeek");
    }
    return `${weeks}${spacer}${i18n.t("common.time.week")}` + i18n.t("common.time.ago");
  }

  const years = differenceInYears(nowDate, sourceDate);
  const months = differenceInMonths(nowDate, sourceDate) % 12;
  const days = differenceInDays(nowDate, sourceDate) % 30;
  const hours = differenceInHours(nowDate, sourceDate) % 24;
  const mins = differenceInMinutes(nowDate, sourceDate) % 60;

  let result;
  if (years > 0) {
    result = `${years}${spacer}${i18n.t("common.time.year")}${spacer}${months}${spacer}${i18n.t("common.time.month")}`;
  } else if (months > 0) {
    result = `${months}${spacer}${i18n.t("common.time.month")}${spacer}${days}${spacer}${i18n.t("common.time.day")}`;
  } else if (days > 0) {
    result = `${days}${spacer}${i18n.t("common.time.day")}${spacer}${hours}${spacer}${i18n.t("common.time.hour")}`;
  } else if (hours > 0) {
    result = `${hours}${spacer}${i18n.t("common.time.hour")}${spacer}${mins}${spacer}${i18n.t("common.time.minute")}`;
  } else if (mins > 0) {
    result = `${mins}${spacer}${i18n.t("common.time.minute")}`;
  } else {
    result = `< 1${spacer}${i18n.t("common.time.minute")}`;
  }
  return result + i18n.t("common.time.ago");
};

export const formatNumber = (num: number, options: Intl.NumberFormatOptions = {}) =>
  Number(num).toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2, ...options });

/**
 * 分享率的展示值。
 *
 * 语义与 `MyData/utils/format.ts` 的 `realFormatRatio` **对齐**（同一概念不应在不同页面显示不同）：
 * - `Infinity`（以及 ≥ 10000 这种事实上无限大）→ `"∞"`；
 * - 缺失 / `NaN` / 空串 / 非数字 → `"-"`；
 * - 其余 → 保留 `digits` 位小数。
 *
 * 为什么视图层不能直接 `.toFixed(2)`：`ratio` 是**跨消息边界传过来的运行期数据**，
 * 各下载器实体对它的处理并不一致（有的客户端在分母为 0 时会算出 `Infinity`，字段也可能整体缺失）。
 * 裸调 `.toFixed(2)` 一旦拿到 `undefined` 就抛 `TypeError`，**让整个 antd 表格渲染崩掉**
 * （实测：MyClient 的 bodyCell 抛错 → 表格空白）。同文件既有的
 * `totalUpSpeed`/`totalDlSpeed` 展示也采用「守卫后返回 `-`」的写法。
 *
 * 与 `realFormatRatio` 的一处**有意差异**：后者把 `-1` 也显示为 `"∞"`——那是 MyData
 * 「尚无下载量」哨兵的语义（见 B-26），下载器侧的种子不存在该哨兵，故这里如实显示 `-1.00`。
 *
 * @param ratio 任意可能为 undefined/NaN/空串/字符串的原始值
 * @param digits 小数位，默认 2
 */
export const formatRatio = (ratio: unknown, digits: number = 2): string => {
  const value = normalizeRatioValue(ratio);
  if (value === null) {
    return "-";
  }
  if (value === Infinity || value >= 10000) {
    return "∞";
  }
  return Number.isFinite(value) ? value.toFixed(digits) : "-";
};

/**
 * `ratio` 的展示值是否应视为「达标」（≥ 1）。
 *
 * 与 `formatRatio` **共用同一个归一化**，避免出现「文本显示 2.50 却给了危险色」这种自相矛盾的渲染
 * （曾经两处各自判断：文本走 `Number()` 能认字符串 `"2.5"`，而颜色表达式用 `Number.isFinite("2.5")`
 * 得到 false → 判定为不达标）。
 */
export const isRatioHealthy = (ratio: unknown): boolean => {
  const value = normalizeRatioValue(ratio);
  return value !== null && (value === Infinity || value >= 1);
};

/** 把任意原始值归一化为 number / null（null 表示「无数据」，与 0 区别开）。 */
function normalizeRatioValue(ratio: unknown): number | null {
  // 空串/" " 不能走 Number()（会得到 0，把「没有数据」显示成 "0.00"）
  if (typeof ratio === "string" && ratio.trim() === "") {
    return null;
  }
  const value = typeof ratio === "string" ? Number(ratio) : ratio;
  if (typeof value !== "number" || Number.isNaN(value)) {
    return null;
  }
  return value;
}

// 定义单位和对应的阈值
const simplifyNumberUnits = [
  { threshold: 1000000000000, suffix: "T" },
  { threshold: 1000000000, suffix: "B" },
  { threshold: 1000000, suffix: "M" },
  { threshold: 1000, suffix: "K" },
];

// 数字简化函数，将大数字转换为带单位的简化形式（用于bonus相关数字）
export const simplifyNumber = (num: number | string, spacer: string = ""): string => {
  const numValue = typeof num === "string" ? parseFloat(num) : num;

  if (isNaN(numValue)) {
    return "-";
  }

  const absNum = Math.abs(numValue);

  // 找到合适的单位
  for (const { threshold, suffix } of simplifyNumberUnits) {
    if (absNum >= threshold) {
      const value = numValue / threshold;
      // 如果是整数，不显示小数点
      return value.toFixed(2) + spacer + suffix;
    }
  }

  // 小于1000的数字直接返回
  return numValue.toFixed(2);
};
