/**
 * 种子优惠「factor ⇄ tags」内核测试（移植自上游 13991d15b5 / #1650）。
 *
 * 覆盖：
 *  - promotionToTags / tagsToPromotion 的互转与合并口径；
 *  - `undefined` 表示「未知」而不是 1；
 *  - normalizeTorrentPromotion 对非法 factor 的收敛（`""` / `"N/A"` / 负数 / 越界下载系数）与 0 的合法性；
 *  - normalizeTorrentPromotion 的幂等性、非优惠标签（H&R / 可退款 / 官方）不被删除；
 *  - isPromotionTagName 对 Freeload 返回 false（Freeload 语义不是倍率）；
 *  - 引擎级：dreadvault / mteam 的 fake row 经 parseWholeTorrentFromRow 后同时具备 factor 与派生标签。
 */
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  logMessage: vi.fn(),
  store: vi.fn(async () => {}),
}));

// 站点定义会连带引入平台适配层（messages.ts 用到 __BROWSER__ 与 chrome API），
// 因此在 import 之前把全局桩与统一日志出口准备好。
vi.mock("@ptd/site/utils/adapter.ts", () => ({
  logMessage: mocks.logMessage,
  store: mocks.store,
  retrieve: vi.fn(async () => null),
  retrieveStore: vi.fn(async () => null),
  isCloudflareBlocked: vi.fn(() => false),
  sleep: vi.fn(async () => {}),
  cookie: vi.fn(async () => null),
  axios: { request: vi.fn(), getUri: () => "https://example.org/" },
}));
(globalThis as any).__BROWSER__ ??= "chrome";

import {
  getTorrentVolumeFactors,
  isPromotionTagName,
  normalizeTorrentPromotion,
  promotionToTags,
  tagsToPromotion,
} from "@ptd/site/utils/promotion.ts";
import type { ITorrent } from "@ptd/site/types/torrent.ts";

const tagNames = (tags?: Array<{ name: string }>) => (tags ?? []).map((tag) => tag.name);

describe("promotionToTags / tagsToPromotion", () => {
  it("Free + 2xUp 合成 2xFree", () => {
    expect(tagNames(promotionToTags(0, 2))).toEqual(["2xFree"]);
    expect(tagsToPromotion([{ name: "Free" }, { name: "2xUp" }])).toEqual({
      downloadVolumeFactor: 0,
      uploadVolumeFactor: 2,
    });
  });

  it("75% + 2xUp 拆成两个标签，多标签按「下载取最小、上传取最大」合并", () => {
    expect(tagNames(promotionToTags(0.75, 2))).toEqual(["75%", "2xUp"]);
    expect(tagsToPromotion([{ name: "75%" }, { name: "2xUp" }])).toEqual({
      downloadVolumeFactor: 0.75,
      uploadVolumeFactor: 2,
    });
    // 同时存在 Free 和 50% 时下载取更优惠的 0
    expect(tagsToPromotion([{ name: "50%" }, { name: "Free" }]).downloadVolumeFactor).toBe(0);
  });

  it("组合优惠优先用站点惯用合成名（NL. / 2x50%）", () => {
    expect(tagNames(promotionToTags(0, 0))).toEqual(["NL."]);
    expect(tagNames(promotionToTags(0.5, 2))).toEqual(["2x50%"]);
    // 派生标签带预定义配色
    expect(promotionToTags(0, 2)[0]).toMatchObject({ name: "2xFree", color: "green" });
  });

  it("优惠标签与 factor 互逆（factor 1 无对应标签，单独处理）", () => {
    const cases: Array<[number | undefined, number | undefined]> = [
      [0, 2],
      [0.75, 2],
      [0.5, 2],
      [0.3, 1],
      [0, 0],
      [1, 2],
    ];
    for (const [download, upload] of cases) {
      const tags = promotionToTags(download, upload);
      const back = tagsToPromotion(tags);
      expect(back.downloadVolumeFactor).toBe(download === 1 ? undefined : download);
      expect(back.uploadVolumeFactor).toBe(upload === 1 ? undefined : upload);
    }
  });

  it("未识别的标签不产生 factor", () => {
    expect(tagsToPromotion([{ name: "H&R" }, { name: "官方" }, { name: "Freeload" }])).toEqual({
      downloadVolumeFactor: undefined,
      uploadVolumeFactor: undefined,
    });
  });
});

describe("undefined 表示未知，不是 1", () => {
  it("无任何优惠信息时两个 factor 都是 undefined", () => {
    expect(getTorrentVolumeFactors({})).toEqual({ downloadVolumeFactor: undefined, uploadVolumeFactor: undefined });
    expect(getTorrentVolumeFactors({ tags: [{ name: "H&R" }] })).toEqual({
      downloadVolumeFactor: undefined,
      uploadVolumeFactor: undefined,
    });
  });

  it("显式字段优先于 tags 反推", () => {
    expect(getTorrentVolumeFactors({ downloadVolumeFactor: 1, tags: [{ name: "Free" }] }).downloadVolumeFactor).toBe(1);
  });

  it("旧数据没有 factor 时从 tags 反推", () => {
    expect(getTorrentVolumeFactors({ tags: [{ name: "2xFree" }] })).toEqual({
      downloadVolumeFactor: 0,
      uploadVolumeFactor: 2,
    });
  });
});

describe("normalizeTorrentPromotion：factor 收敛", () => {
  it("0 是合法值，不会被当成未知", () => {
    const torrent = normalizeTorrentPromotion({ downloadVolumeFactor: 0, uploadVolumeFactor: 0 } as Partial<ITorrent>);
    expect(torrent.downloadVolumeFactor).toBe(0);
    expect(torrent.uploadVolumeFactor).toBe(0);
    expect(tagNames(torrent.tags)).toEqual(["NL."]);
  });

  it("1 是合法值，只是不产生标签", () => {
    const torrent = normalizeTorrentPromotion({ downloadVolumeFactor: 1, uploadVolumeFactor: 1 } as Partial<ITorrent>);
    expect(torrent.downloadVolumeFactor).toBe(1);
    expect(torrent.uploadVolumeFactor).toBe(1);
    expect(torrent.tags).toEqual([]);
  });

  it('拒绝 "" / "N/A" / 负数 / 越界的下载系数', () => {
    for (const bad of ["", "  ", "N/A", null, Number.NaN, -1, 1.5]) {
      const torrent = normalizeTorrentPromotion({ downloadVolumeFactor: bad } as any);
      expect(torrent.downloadVolumeFactor).toBeUndefined();
      expect(Object.hasOwn(torrent, "downloadVolumeFactor")).toBe(false);
      // 「两者都没有」时保持未知语义，不新增 tags 字段
      expect(torrent.tags).toBeUndefined();
    }
  });

  it("上传系数只拒绝非法值，> 1 合法", () => {
    for (const bad of ["", "N/A", null, Number.NaN, -2]) {
      expect(normalizeTorrentPromotion({ uploadVolumeFactor: bad } as any).uploadVolumeFactor).toBeUndefined();
    }
    const torrent = normalizeTorrentPromotion({ uploadVolumeFactor: 3 } as any);
    expect(torrent.uploadVolumeFactor).toBe(3);
    expect(tagNames(torrent.tags)).toEqual(["3xUp"]);
  });
});

describe("normalizeTorrentPromotion：双写与幂等", () => {
  it("只有 tags 时反推 factor，并按 factor 重建优惠标签", () => {
    // Free + 2x → 反推 (0, 2) → 合成写法 2xFree
    const torrent = normalizeTorrentPromotion({ tags: [{ name: "Free" }, { name: "2x" }] } as Partial<ITorrent>);
    expect(torrent.downloadVolumeFactor).toBe(0);
    expect(torrent.uploadVolumeFactor).toBe(2);
    expect(tagNames(torrent.tags)).toEqual(["2xFree"]);

    // 只有 2x 的历史写法 → 规范成 2xUp
    const uploadOnly = normalizeTorrentPromotion({ tags: [{ name: "2x" }] } as Partial<ITorrent>);
    expect(uploadOnly.downloadVolumeFactor).toBeUndefined();
    expect(uploadOnly.uploadVolumeFactor).toBe(2);
    expect(tagNames(uploadOnly.tags)).toEqual(["2xUp"]);
  });

  it("连续归一两次结果完全一致（幂等）", () => {
    const first = normalizeTorrentPromotion({ downloadVolumeFactor: 0.25, uploadVolumeFactor: 1 } as Partial<ITorrent>);
    const second = normalizeTorrentPromotion(first);
    expect(second).toEqual(first);
    expect(tagNames(second.tags)).toEqual(["25%"]);
  });

  it("H&R / 可退款 / 官方等非倍率标签不被删除", () => {
    const torrent = normalizeTorrentPromotion({
      downloadVolumeFactor: 0,
      tags: [{ name: "H&R" }, { name: "可退款" }, { name: "官方" }, { name: "75%" }],
    } as Partial<ITorrent>);
    const names = tagNames(torrent.tags);
    expect(names).toContain("H&R");
    expect(names).toContain("可退款");
    expect(names).toContain("官方");
    expect(names).toContain("Free"); // factor 派生
    expect(names).not.toContain("75%"); // 旧优惠标签被 factor 结果替换
  });

  it("isPromotionTagName 只认倍率语义", () => {
    expect(isPromotionTagName("Freeload")).toBe(false);
    expect(isPromotionTagName("H&R")).toBe(false);
    expect(isPromotionTagName("官方")).toBe(false);
    expect(isPromotionTagName("Free")).toBe(true);
    expect(isPromotionTagName("2xUp")).toBe(true);
    expect(isPromotionTagName("1.5xUp")).toBe(true);
  });
});

describe("引擎级：站点定义只给 factor，标签由归一派生", () => {
  it("dreadvault：75% Free → downloadVolumeFactor 0.25 且 tags 含 25%", async () => {
    const { default: DreadVault, siteMetadata } = await import("@ptd/site/definitions/dreadvault.ts");
    const site: any = new DreadVault(siteMetadata as any);
    const searchConfig = {
      searchEntry: { selectors: siteMetadata.search!.selectors },
      requestConfig: siteMetadata.search!.requestConfig,
    } as any;

    const row = {
      id: 123,
      attributes: { id: 123, freeleech: "75%", double_upload: false, featured: false, internal: false },
    };
    const parsed = await site.parseWholeTorrentFromRow({}, row, searchConfig);

    expect(parsed.downloadVolumeFactor).toBe(0.25);
    expect(parsed.uploadVolumeFactor).toBe(1);
    expect(tagNames(parsed.tags)).toContain("25%");
    // 站规标签（H&R）与非优惠标签保留
    expect(tagNames(parsed.tags)).toContain("H&R");
  });

  it("dreadvault：featured → 免费 + 双倍上传", async () => {
    const { default: DreadVault, siteMetadata } = await import("@ptd/site/definitions/dreadvault.ts");
    const site: any = new DreadVault(siteMetadata as any);
    const searchConfig = {
      searchEntry: { selectors: siteMetadata.search!.selectors },
      requestConfig: siteMetadata.search!.requestConfig,
    } as any;

    const parsed = await site.parseWholeTorrentFromRow(
      {},
      { id: 456, attributes: { id: 456, featured: true, freeleech: "0%", double_upload: false, internal: false } },
      searchConfig,
    );

    expect(parsed.downloadVolumeFactor).toBe(0);
    expect(parsed.uploadVolumeFactor).toBe(2);
    expect(tagNames(parsed.tags)).toContain("2xFree");
    expect(tagNames(parsed.tags)).toContain("精选");
  });

  it("mteam：PERCENT_70 → 按 30% 计费，FREE → 免费", async () => {
    const { default: MTeam, siteMetadata } = await import("@ptd/site/definitions/mteam.ts");
    const site: any = new MTeam(siteMetadata as any);
    const searchConfig = {
      searchEntry: { selectors: siteMetadata.search!.selectors },
      requestConfig: siteMetadata.search!.requestConfig,
    } as any;
    const baseRow = {
      id: "1",
      name: "Fake.Torrent.2024.1080p",
      smallDescr: "",
      createdDate: "2026-10-01 00:00:00",
      size: "123",
      author: null,
      category: "401",
      status: { seeders: 1, leechers: 2, timesCompleted: 3, comments: 0 },
    };

    const percent70 = await site.parseWholeTorrentFromRow(
      {},
      { ...baseRow, status: { ...baseRow.status, discount: "PERCENT_70" } },
      searchConfig,
    );
    expect(percent70.downloadVolumeFactor).toBe(0.3);
    expect(percent70.uploadVolumeFactor).toBe(1);
    expect(tagNames(percent70.tags)).toContain("30%");

    const free = await site.parseWholeTorrentFromRow(
      {},
      { ...baseRow, id: "2", status: { ...baseRow.status, discount: "FREE" } },
      searchConfig,
    );
    expect(free.downloadVolumeFactor).toBe(0);
    expect(tagNames(free.tags)).toContain("Free");

    const doubleUpload = await site.parseWholeTorrentFromRow(
      {},
      { ...baseRow, id: "3", status: { ...baseRow.status, discount: "_2X_PERCENT_50" } },
      searchConfig,
    );
    expect(doubleUpload.downloadVolumeFactor).toBe(0.5);
    expect(doubleUpload.uploadVolumeFactor).toBe(2);
    expect(tagNames(doubleUpload.tags)).toEqual(expect.arrayContaining(["2x50%"]));
  });
});
