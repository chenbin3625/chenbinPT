export const sizePattern = /^(\d*\.?\d+)([\s\-_]{0,3})([ZEPTGMK](B|iB))s?$/i;

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
 * 把尺寸字符串（如 `"1.5 GiB"` / `"20GB"`）解析为字节数。
 *
 * ⚠️ **无法匹配时返回 `0`，且不抛异常、不记日志**（保持既有语义：调用方很多，
 * 且有用 `0` 表示「未提供」的调用点，不能改成抛错或返回 NaN）。
 *
 * 代价是站点定义里写错单位时**静默**失效：`sizePattern` 要求 `[ZEPTGMK](B|iB)`，
 * 因此 `"10B"`（缺 `K/M/G…` 前缀，B-20b 的 desigaane.ts:41 就是这个写法）会得到 0，
 * 使 `level.ts` 的上传量门槛静默失效。数据侧的修正由定义文件负责，本函数不做兜底猜测。
 *
 * @param size 尺寸字符串，允许千分位逗号
 * @returns 字节数；无法识别时为 `0`
 */
export function parseSizeString(size: string): number {
  size = size.replace(/,/g, ""); // 建议在传入前就替换掉，但是以防万一还是在这里再做一次替换
  const sizeRawMatch = size.match(sizePattern);
  if (sizeRawMatch) {
    const sizeNumber = parseFloat(sizeRawMatch[1]);
    const sizeType = sizeRawMatch[3];
    // 首字母查表替代 switch + 正则，sizePattern 已保证 sizeType 形如 KiB/MB 等
    return sizeNumber * (sizeUnitMultipliers[sizeType[0].toUpperCase()] ?? 1);
  }
  return 0;
}
