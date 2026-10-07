/**
 * defs-cleanup（第四波）回归：定义层收口。
 *
 * - 回归①（DEFS1-4 孪生）：redacted id6 的 uniqueGroups:500 改为引擎求值的 groups:500，
 *   500 组门槛真正参与判级（改前不在 level.ts 的「≥」白名单里，会被静默当作已满足，把用户从 id3 抬到 id6）；
 * - DEFS2-3 收尾：nebulance 不再用 tags:[] 覆盖 Gazelle 共享 tags（strong:contains('Freeleech!') → Free）；
 * - DEFS3-5 收尾：tjupt 展开 NexusPHP 共享 tags（Free/2xFree/…）再追加本站标签，且不重复声明 H&R；
 * - H&R 设计冲突：上游 fb79a2a7（PR #336「global H&R sites」）名单内的 3 站恢复恒真 H&R
 *   （完整判据见 hrs-sweep.review-fixes.test.ts 文件头）；
 * - 冗余 override 清理：8 站的 guessUserLevelId override 与 darkpeers 共享 helper 已删除，
 *   站点不再自带判级实现，全部走引擎 level.ts（探针见 verdicts/verify-v2-defs.json notable#4）。
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@ptd/site/utils/adapter.ts", () => ({ logMessage: vi.fn() }));
(globalThis as any).__BROWSER__ ??= "chrome";

const TiB = 1024 ** 4;
const DAY = 24 * 3600 * 1000;

type TTagConfig = { name: string; selector?: string };
type TLoader = () => Promise<any>;

/** 上游 fb79a2a7 / PR #336 点名、且第三波被误删 H&R 的 3 站（本波已恢复） */
const restoredGlobalHrSites: Array<[string, TLoader]> = [
  ["asiancinema", () => import("@ptd/site/definitions/asiancinema.ts")],
  ["blutopia", () => import("@ptd/site/definitions/blutopia.ts")],
  ["broadcasthenet", () => import("@ptd/site/definitions/broadcasthenet.ts")],
];

/** 曾经自带 guessUserLevelId override 的 8 个站点（第四波全部删除，改为走引擎） */
const overrideRemovedSites: Array<[string, TLoader]> = [
  ["desigaane", () => import("@ptd/site/definitions/desigaane.ts")],
  ["darkpeers", () => import("@ptd/site/definitions/darkpeers.ts")],
  ["asiancinema", () => import("@ptd/site/definitions/asiancinema.ts")],
  ["cinematik", () => import("@ptd/site/definitions/cinematik.ts")],
  ["bitporn", () => import("@ptd/site/definitions/bitporn.ts")],
  ["blutopia", () => import("@ptd/site/definitions/blutopia.ts")],
  ["clearjav", () => import("@ptd/site/definitions/clearjav.ts")],
  ["dicmusic", () => import("@ptd/site/definitions/dicmusic.ts")],
];

describe("回归①：redacted 的 uniqueGroups 门槛改用引擎求值的 groups", () => {
  it("id6 门槛为 groups:500，0 组用户不再被判到 id6", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/redacted.ts");
    const { levelRequirementUnMet, guessUserLevelId } = await import("@ptd/site/utils/level.ts");

    const level6 = siteMetadata.levelRequirements!.find((level) => level.id === 6)! as any;
    expect(level6.groups).toBe(500);
    expect(level6.uniqueGroups).toBeUndefined();

    // 0 组 → 门槛登记为未满足；600 组 → 满足。这证明门槛真的参与判级，而不是被静默忽略
    const met = { uploaded: 1 * TiB, downloaded: 0, ratio: 2, uploads: 300, groups: 0 };
    expect(levelRequirementUnMet({ ...met } as any, level6).groups).toBe(500);
    expect(levelRequirementUnMet({ ...met, groups: 600 } as any, level6).groups).toBeUndefined();

    // 上传 1TiB / 发布 300 / 0 组：id4 Elite 满足，id5 需 500 发布、id6 需 500 组 → 只能判到 4
    // （改前 id6 的 uniqueGroups 不在求值白名单里被当作已满足，同一画像会被抬到 id6）
    const userInfo = {
      site: "probe",
      status: 0,
      updateAt: Date.now(),
      levelName: "未识别的自定义头衔",
      ...met,
      joinTime: Date.now() - 60 * DAY,
    } as any;
    expect(guessUserLevelId(userInfo, siteMetadata.levelRequirements!)).toBe(4);
  });
});

describe("DEFS2-3 收尾：nebulance 展开 Gazelle 共享 tags", () => {
  it("保留 Freeleech! → Free 的共享标签，且没有恒真标签", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/nebulance.ts");
    const tags = siteMetadata.search!.selectors!.tags as TTagConfig[];

    expect(tags.some((tag) => tag.name === "Free" && tag.selector?.includes("Freeleech!"))).toBe(true);
    expect(tags.every((tag) => tag.selector !== "*")).toBe(true);
    expect(tags.some((tag) => tag.name === "H&R")).toBe(false);
  });
});

describe("DEFS3-5 收尾：tjupt 展开 NexusPHP 共享 tags 再追加本站标签", () => {
  it("共享 Free/2xFree 与本站 .tag.tag-* 同时存在，H&R 只声明一次", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/tjupt.ts");
    const tags = siteMetadata.search!.selectors!.tags as TTagConfig[];

    expect(tags.some((tag) => tag.name === "Free" && tag.selector === "img.pro_free")).toBe(true);
    expect(tags.some((tag) => tag.name === "2xFree" && tag.selector === "img.pro_free2up")).toBe(true);
    expect(tags.some((tag) => tag.name === "禁转" && tag.selector === ".tag.tag-exclusive")).toBe(true);
    // 共享 tags 里已有 img.hitandrun → H&R，本站不再重复声明（重复会让同一徽标被计入两次）
    expect(tags.filter((tag) => tag.name === "H&R")).toHaveLength(1);
    expect(tags.find((tag) => tag.name === "H&R")!.selector).toBe("img.hitandrun");
    expect(tags.every((tag) => tag.selector !== "*")).toBe(true);
  });

  it("行解析：免费徽标得 Free、H&R 徽标只出现一次、自有标签仍生效", async () => {
    const { default: NexusPHP } = await import("@ptd/site/schemas/NexusPHP.ts");
    const { siteMetadata } = await import("@ptd/site/definitions/tjupt.ts");
    const site: any = new NexusPHP({ ...(siteMetadata as any) }, {});
    const selectors = siteMetadata.search!.selectors!;

    const tagNamesFor = (rowHtml: string) => {
      // happy-dom 下 matchesSelector 只对已挂到文档上的元素生效
      const table = document.createElement("table");
      const tbody = document.createElement("tbody");
      const row = document.createElement("tr");
      row.innerHTML = rowHtml;
      tbody.appendChild(row);
      table.appendChild(tbody);
      document.body.appendChild(table);
      try {
        const torrent = site.parseTorrentRowForTags({}, row, { searchEntry: { selectors } } as any);
        return (torrent.tags ?? []).map((tag: { name: string }) => tag.name);
      } finally {
        document.body.innerHTML = "";
      }
    };

    expect(tagNamesFor('<td><img class="pro_free" src="pic/trans.gif"></td>')).toEqual(["Free"]);
    expect(tagNamesFor('<td><img class="hitandrun" src="pic/trans.gif"></td>')).toEqual(["H&R"]);
    expect(tagNamesFor('<td><span class="tag tag-exclusive">禁转</span></td>')).toEqual(["禁转"]);
  });
});

describe("H&R 设计冲突：全站 H&R 名单内的站点恢复恒真 H&R", () => {
  it.each(restoredGlobalHrSites)("%s 恢复 fb79a2a7 的恒真 H&R", async (_name, load) => {
    const mod = await load();
    const tags = mod.siteMetadata.search!.selectors!.tags as TTagConfig[];
    expect(tags.some((tag) => tag.name === "H&R" && tag.selector === "*")).toBe(true);
  });
});

describe("冗余 override 清理：8 站不再自带 guessUserLevelId", () => {
  it.each(overrideRemovedSites)("%s 的导出类不再覆写 guessUserLevelId", async (_name, load) => {
    const mod = await load();
    const SiteClass = mod.default;
    if (SiteClass) {
      // 只检查自有原型属性：继承自引擎的实现不算 override
      expect(Object.prototype.hasOwnProperty.call(SiteClass.prototype, "guessUserLevelId")).toBe(false);
    }
    // 无 default class 时由 schema 引擎类承载，同样没有站内 override / 共享 helper 导出
    expect(mod.guessUserLevelIdByJudgeableRequirements).toBeUndefined();
  });

  it("darkpeers 不再导出共享 helper，也不再导出站点类", async () => {
    const mod = await import("@ptd/site/definitions/darkpeers.ts");
    expect((mod as any).guessUserLevelIdByJudgeableRequirements).toBeUndefined();
    expect((mod as any).default).toBeUndefined();
  });
});
