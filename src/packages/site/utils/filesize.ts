/**
 * 数字与尺寸解析（站点页面/API 返回的文本数字格式不统一）。
 *
 * ## 数字格式（E03）
 *
 * 站点文本里的数字可能带千分位（`,` / `.` / 空格）或欧式小数逗号（`"1,5 GB"`）。
 * 早期实现对逗号一律 `replace(/,/g, "")`，会把 `"1,5 GB"` 放大 10 倍、把
 * `"1.234,56 MB"` 缩小约 1000 倍，而且静默无日志。`parseLocalizedNumber` 统一处理：
 * - 同时出现 `,` 与 `.` 时，**最后出现的**那个视为小数分隔符，另一个视为千分位；
 * - 只有 `,` 时，若逗号后每段都是 3 位数字则按千分位，否则按欧式小数逗号；
 * - 只有 `.` 时保留为小数（与既有行为一致；出现多段且每段 3 位时按千分位）；
 * - 空格（含不换行空格）一律按千分位分隔符处理。
 */

/**
 * 尺寸文本：数字（允许千分位/小数分隔符） + 可选分隔符 + 单位。
 *
 * E01/E02：单位部分大小写不敏感（`/i`），并支持无前缀的 `B` / `Bytes` 写法
 * （`"10B"`、`"1234567890 Bytes"` 这类站点/接口文本）。
 */
export const sizePattern = /^([\d.,\s]+?)[\s\-_]{0,3}([ZEPTGMK](?:B|iB)|B(?:ytes?)?)s?$/i;

export type TSizeUnit = `${"" | "K" | "M" | "G" | "T" | "P" | "E" | "Z"}${"i" | ""}B`;
export type TSize = `${number}${" " | ""}${TSizeUnit}`;

export const KB = Math.pow(2, 10);
export const MB = Math.pow(2, 20);
export const GB = Math.pow(2, 30);
export const TB = Math.pow(2, 40);
export const PB = Math.pow(2, 50);
export const EB = Math.pow(2, 60);
export const ZB = Math.pow(2, 70);

// sizePattern 匹配到的单位（如 KiB / MB）首字母到倍数的查表，未命中时倍数同原实现的 default 分支为 1
const sizeUnitMultipliers: Record<string, number> = { Z: ZB, E: EB, P: PB, T: TB, G: GB, M: MB, K: KB };

/**
 * 解析带区域格式的数字字符串；无法解析时返回 `NaN`。
 *
 * @param raw 数字文本（不含单位），如 `"1,024"`、`"1,5"`、`"1.234,56"`、`"1 024"`
 */
export function parseLocalizedNumber(raw: string): number {
  const token = String(raw ?? "").trim();
  if (!token) return Number.NaN;

  const lastComma = token.lastIndexOf(",");
  const lastDot = token.lastIndexOf(".");

  let normalized: string;
  if (lastComma >= 0 && lastDot >= 0) {
    // 同时出现两种分隔符：最后出现的那个是小数分隔符
    const decimalSeparator = lastComma > lastDot ? "," : ".";
    const thousandsSeparator = decimalSeparator === "," ? "." : ",";
    normalized = token.split(thousandsSeparator).join("").replace(decimalSeparator, ".");
  } else if (lastComma >= 0) {
    const groups = token.split(",");
    // 逗号后每段都是 3 位数字时按千分位（"1,024"），否则按欧式小数逗号（"1,5"）
    normalized =
      groups.length > 1 && groups.slice(1).every((group) => group.length === 3) ? groups.join("") : groups.join(".");
  } else if (lastDot >= 0) {
    const groups = token.split(".");
    normalized = groups.length > 2 && groups.slice(1).every((group) => group.length === 3) ? groups.join("") : token;
  } else {
    normalized = token;
  }

  // 空格 / 不换行空格作为千分位分隔符
  normalized = normalized.replace(/[\s\u00a0\u202f]/g, "");
  return parseFloat(normalized);
}

/**
 * 把尺寸字符串（如 `"1.5 GiB"` / `"20GB"` / `"10B"` / `"1 234,5 MiB"`）解析为字节数。
 *
 * ⚠️ **无法匹配时返回 `0`，且不抛异常、不记日志**（保持既有语义：调用方很多，
 * 且有用 `0` 表示「未提供」的调用点，不能改成抛错或返回 NaN）。
 *
 * 不带数字前缀的单位（如 `"10B"`）现在按 1 字节处理；其它无法识别的输入
 * （`"abc"`、`"1024"` 这类没有单位的纯数字）仍返回 0。纯数字文本请直接用
 * `parseLocalizedNumber` / `tryToNumber`，本函数不猜测「裸字节数」。
 *
 * @param size 尺寸字符串，允许千分位与区域小数分隔符
 * @returns 字节数；无法识别时为 `0`
 */
export function parseSizeString(size: string): number {
  if (!size) return 0;

  const sizeRawMatch = String(size).match(sizePattern);
  if (!sizeRawMatch) {
    return 0;
  }

  const sizeNumber = parseLocalizedNumber(sizeRawMatch[1]);
  if (!Number.isFinite(sizeNumber)) {
    return 0;
  }

  // sizePattern 已保证 sizeType 形如 KiB/MB/B/Bytes；无前缀的 B/Bytes 倍数为 1
  const sizeType = sizeRawMatch[2];
  const multiplier = sizeUnitMultipliers[sizeType[0].toUpperCase()] ?? 1;
  return sizeNumber * multiplier;
}
