// P1-4：不再从 @ptd/site 桶入口自引用，直接指向 types 桶，减少类型图耦合
import type { ITorrentTag } from "../types";

interface IPreDefinedTorrentTag extends ITorrentTag {
  aka?: Array<string | RegExp>;
}

/**
 * 由于部分站点可能有动态标签情况，此处预定义一些比较基础的标签重新映射名称和颜色，以避免相同性质标签过多重复
 * 如果 site.getSearchResult 返回 tag name 命中 name 或者 aka 中的字段（不区分大小写），会直接替换为对应的 name 和 color
 *
 * color 使用 shared/colors.ts 中支持的语义色或 Material 色名。
 */
export const preDefinedTorrentTagMap: IPreDefinedTorrentTag[] = [
  // 优惠类
  { name: "NL.", color: "deep-purple", aka: ["Neutral"] }, // 中性种子（0xUP & 0xDL）
  { name: "Freeload", color: "red", aka: [] }, // Freeload
  { name: "2xFree", color: "green", aka: [] }, // 免费下载 + 2x 上传
  { name: "2xUp", color: "lime", aka: [] }, // 2x 上传
  { name: "2x50%", color: "light-green", aka: [] }, // 2x 上传 + 50% 下载
  { name: "25%", color: "purple", aka: [] }, // 25% 下载
  { name: "30%", color: "indigo", aka: [] }, // 30% 下载
  { name: "35%", color: "indigo-darken-3", aka: [] }, // 35% 下载
  { name: "50%", color: "orange", aka: [] }, // 50% 下载
  { name: "70%", color: "blue-grey", aka: [] }, // 70% 下载
  { name: "75%", color: "lime-darken-3", aka: [] }, // 75% 下载
  // Freeleech 与 Free 语义相同；边界匹配后必须显式列出，否则前者不会再被归一化
  { name: "Free", color: "blue", aka: ["Freeleech"] }, // 免费下载
  { name: "可退款", color: "gray", aka: ["Refund"] }, // 定期退还下载量

  // 站点属性类
  { name: "官方", color: "blue-darken-2", aka: ["官组", "官种", "Internal"] },
  { name: "Hot", color: "yellow-lighten-1", aka: ["热门", "熱門"] },
  { name: "H&R", color: "red", aka: ["HnR"] }, // 需要 H&R
  { name: "Excl.", color: "deep-orange-darken-1", aka: ["独家", "限转", "禁转"] }, // 禁止转载
  { name: "VIP", color: "orange-darken-2", aka: [] }, // 仅 VIP 可下载

  // 种子属性类
  { name: "DIY", color: "brown", aka: ["自定义"] },

  { name: "中字", color: "pink-darken-1", aka: ["中文", "简体"] },
  { name: "繁体", color: "amber-darken-3", aka: ["繁中"] },
  { name: "国语", color: "cyan-darken-2", aka: ["国配", "普通话", "中配", /国语$/] },
  { name: "粤语", color: "teal-darken-1", aka: ["粤配"] },

  { name: "4K", color: "teal-darken-3", aka: ["4p", "2160p", /4 ?[Kk]/] },
  { name: "1080p", color: "teal-darken-1", aka: [] },

  { name: "WEB-DL", color: "green-darken-2", aka: ["WEB DL", /WEB\.?DL/] },
  { name: "Blu-ray", color: "blue-darken-3", aka: ["蓝光", /Blu[-]?ray/] },

  { name: "H265", color: "indigo", aka: ["HEVC", "x265", /H\.?265/] },

  { name: "HDR", color: "purple", aka: ["HDR10", "HDR10+"] },
  { name: "HLG", color: "deep-purple", aka: ["Hybrid Log-Gamma", /混合对数伽玛/] },
  { name: "DoVi", color: "pink", aka: ["Dolby Vision", "DV", /杜比(视界)*/, /DOLBY\s?VISION/] },
] as const;

export type TPreDefinedTorrentTagName = (typeof preDefinedTorrentTagMap)[number]["name"];

export const preDefinedTorrentTagNameSet: Array<string> = preDefinedTorrentTagMap.map((item) => item.name);

/** 字面量别名进入正则前必须转义，否则 `NL.`、`HDR10+` 等会被当成元字符 */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 把字符串别名转成「带词边界」的正则片段。
 *
 * 早期实现直接 `new RegExp(fromRaw.join("|"), "i")`，别名之间没有任何边界，
 * 于是短别名会命中无关标签的子串：`DV`（DoVi）命中 `DVDRip`、`Free` 命中 `NotFree`。
 * 这里对以 `[A-Za-z0-9]` 开头/结尾的别名补上前后断言，使 `DVDRip` / `NotFree` 不再被改写；
 * 中文别名两侧都不是 `[A-Za-z0-9]`，行为与之前保持一致。
 *
 * 边界只约束「字母数字连续片段」，因此 `2160p`、`WEB-DL`、`50%`、`H&R` 等仍按预期命中；
 * 需要刻意放宽的匹配继续由 aka 中的 RegExp 字面量承担（如 `/H\.?265/`、`/4 ?[Kk]/`）。
 */
function toBoundedLiteralPattern(literal: string): string {
  const prefix = /^[A-Za-z0-9]/.test(literal) ? "(?<![A-Za-z0-9])" : "";
  const suffix = /[A-Za-z0-9]$/.test(literal) ? "(?![A-Za-z0-9])" : "";
  return `${prefix}${escapeRegExp(literal)}${suffix}`;
}

// 构建一个中间态的转换 Map
export const normalizedTorrentTagMap: Array<{ from: RegExp; to: ITorrentTag }> = preDefinedTorrentTagMap.flatMap(
  (tagMap) => {
    const to = { name: tagMap.name, color: tagMap.color };
    const fromRaw = [tagMap.name, ...(tagMap.aka ?? [])];

    const retNormalized: Array<{ from: RegExp; to: ITorrentTag }> = [];

    // 将字符串类型的 from 转换为正则表达式
    retNormalized.push({
      from: new RegExp(
        fromRaw
          .filter((t) => typeof t === "string")
          .map((t) => toBoundedLiteralPattern(t as string))
          .join("|"),
        "i",
      ),
      to,
    });

    // 将 正则表达式类型的 from 直接加入
    fromRaw
      .filter((t) => t instanceof RegExp)
      .forEach((regExp) => {
        retNormalized.push({ from: regExp as RegExp, to });
      });

    return retNormalized;
  },
);

export function sortTorrentTags(tags: ITorrentTag[]) {
  return tags.toSorted((a, b) => {
    const aIndex = preDefinedTorrentTagNameSet.findIndex((ntt) => ntt === a.name);
    const bIndex = preDefinedTorrentTagNameSet.findIndex((ntt) => ntt === b.name);
    return (aIndex === -1 ? Number.MAX_SAFE_INTEGER : aIndex) - (bIndex === -1 ? Number.MAX_SAFE_INTEGER : bIndex);
  });
}
