/**
 * 预定义标签归一化的匹配语义测试（见 docs 中「子串误匹配」相关审计项）。
 *
 * 背景：`normalizedTorrentTagMap` 早期用 `new RegExp(fromRaw.join("|"), "i")` 拼串，
 * 别名之间没有边界，导致
 *   - `DVDRip` 命中 DoVi 的别名 `DV`      → 被错误改写为 DoVi；
 *   - `NotFree` 命中 `Free`               → 被错误改写为 Free。
 * 同时 `2xFree` 依赖「表中顺序在 Free 之前」，这一有意行为必须保持不变。
 *
 * 这里直接复用 offscreen 搜索流程的匹配顺序（首个命中的 from 决定结果）。
 */
import { describe, expect, it } from "vitest";

import { normalizedTorrentTagMap, preDefinedTorrentTagMap, preDefinedTorrentTagNameSet } from "@ptd/site/utils/tags.ts";

/** 与 src/entries/offscreen/utils/search.ts 中的归一化逻辑保持一致 */
function normalizeTag(name: string): { name: string; color?: string } {
  for (const normalized of normalizedTorrentTagMap) {
    if (normalized.from.test(name)) {
      return normalized.to;
    }
  }
  return { name };
}

describe("normalizedTorrentTagMap 边界匹配", () => {
  it("有意的优惠映射保持不变", () => {
    expect(normalizeTag("2xFree").name).toBe("2xFree"); // 依赖表顺序，不能被 Free 抢走
    expect(normalizeTag("2x50%").name).toBe("2x50%");
    expect(normalizeTag("50%").name).toBe("50%");
    expect(normalizeTag("Free").name).toBe("Free");
    expect(normalizeTag("Freeload").name).toBe("Freeload");
  });

  it("Freeleech 显式补进 Free 的 aka 后仍然映射为 Free", () => {
    expect(normalizeTag("Freeleech").name).toBe("Free");
    expect(normalizeTag("Freeleech").color).toBe("blue");
    expect(normalizeTag("Freeleech(UL)").name).toBe("Free");
  });

  it("不再发生子串误匹配：DVDRip / NotFree 保持原样", () => {
    expect(normalizeTag("DVDRip")).toEqual({ name: "DVDRip" });
    expect(normalizeTag("DVDR")).toEqual({ name: "DVDR" });
    expect(normalizeTag("NotFree")).toEqual({ name: "NotFree" });
  });

  it("需要保留的映像/编码/分辨率映射", () => {
    expect(normalizeTag("DV").name).toBe("DoVi");
    expect(normalizeTag("Dolby Vision").name).toBe("DoVi");
    expect(normalizeTag("x265").name).toBe("H265");
    expect(normalizeTag("H265").name).toBe("H265");
    expect(normalizeTag("HEVC").name).toBe("H265");
    expect(normalizeTag("2160p").name).toBe("4K");
    expect(normalizeTag("4K").name).toBe("4K");
    expect(normalizeTag("1080p").name).toBe("1080p");
    expect(normalizeTag("WEB-DL").name).toBe("WEB-DL");
    expect(normalizeTag("Blu-ray").name).toBe("Blu-ray");
    expect(normalizeTag("HDR10").name).toBe("HDR");
  });

  it("H&R 与其它站点属性标签仍正常归一化", () => {
    expect(normalizeTag("H&R").name).toBe("H&R");
    expect(normalizeTag("HnR").name).toBe("H&R");
    expect(normalizeTag("Neutral").name).toBe("NL.");
    expect(normalizeTag("Internal").name).toBe("官方");
    expect(normalizeTag("中字").name).toBe("中字");
    expect(normalizeTag("国语").name).toBe("国语");
  });

  it("字面量中的正则元字符被转义（NL. / HDR10+ / 2x50%）", () => {
    // 旧实现里 `NL.` 的 `.` 匹配任意字符，会把 `NLX` 之类错误地当成 NL.
    expect(normalizeTag("NLX")).toEqual({ name: "NLX" });
    expect(normalizeTag("NL.").name).toBe("NL.");
    // `HDR10+` 未转义时 `0+` 表示「一个或多个 0」
    expect(normalizeTag("HDR1").name).toBe("HDR1");
    expect(normalizeTag("HDR10").name).toBe("HDR");
  });

  it("导出集合保持稳定（UI 颜色/排序语义依赖它）", () => {
    expect(preDefinedTorrentTagNameSet).toEqual([
      "NL.",
      "Freeload",
      "2xFree",
      "2xUp",
      "2x50%",
      "25%",
      "30%",
      "35%",
      "50%",
      "70%",
      "75%",
      "Free",
      "可退款",
      "官方",
      "Hot",
      "H&R",
      "Excl.",
      "VIP",
      "DIY",
      "中字",
      "繁体",
      "国语",
      "粤语",
      "4K",
      "1080p",
      "WEB-DL",
      "Blu-ray",
      "H265",
      "HDR",
      "HLG",
      "DoVi",
    ]);
    // Free 的 aka 只做匹配扩展，不新增预定义标签名
    expect(preDefinedTorrentTagMap.find((item) => item.name === "Free")!.aka).toEqual(["Freeleech"]);
  });
});
