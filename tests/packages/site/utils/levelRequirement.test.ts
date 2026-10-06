/**
 * 等级门槛求值：
 * - L-18：secretcinema 的 `percentile` 门槛必须参与「是否达标」判断；
 * - M-13：beyondhd 的特殊做种体积门槛键名要与引擎一致（`specialSeedingSize`），下载量门槛是 `downloaded`。
 */
import { describe, expect, it } from "vitest";

import { levelRequirementUnMet } from "@ptd/site/utils/level.ts";

describe("levelRequirementUnMet", () => {
  it("L-18：percentile 低于门槛时列为未满足，达到时不列", () => {
    const requirement = { id: 1, name: "Elite", percentile: 70 } as any;
    expect(levelRequirementUnMet({ percentile: 50 } as any, requirement)).toMatchObject({ percentile: 20 });
    expect(levelRequirementUnMet({ percentile: 80 } as any, requirement)).not.toHaveProperty("percentile");
  });

  it("M-13：specialSeedingSize 与 downloaded 门槛被求值（旧拼写 specialSeedsize / download 会被当成已满足）", () => {
    const requirement = { id: 5, name: "Pro", specialSeedingSize: "500GiB", downloaded: "24TiB" } as any;
    const unmet = levelRequirementUnMet({ specialSeedingSize: 0, downloaded: 0 } as any, requirement);
    expect(unmet.specialSeedingSize).toBe(500 * 1024 ** 3);
    expect(unmet.downloaded).toBe(24 * 1024 ** 4);
  });
});

describe("引擎此前不求值的门槛键（D-23 / D-24）", () => {
  it("donation 不足时列为未满足", () => {
    const unmet = levelRequirementUnMet({ donation: 10 } as any, { id: 9, name: "Adonis", donation: 50 } as any);
    expect(unmet.donation).toBe(40);
  });

  it("alternative 里的 adoptions 参与判断：两组都未满足时才算未达标", () => {
    const requirement = { id: 3, name: "Lv3", alternative: [{ uploads: 5 }, { adoptions: 10 }] } as any;
    expect(Object.keys(levelRequirementUnMet({ uploads: 0, adoptions: 0 } as any, requirement))).not.toHaveLength(0);
    expect(levelRequirementUnMet({ uploads: 0, adoptions: 12 } as any, requirement)).toEqual({});
  });
});

describe("bibliotik Power User 的「任一组」门槛（D-12）", () => {
  it("上传 1GiB + 发布 100 也能达标（原写法会强制 10GiB 上传）", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/bibliotik.ts");
    const powerUser = siteMetadata.levelRequirements!.find((level) => level.name === "Power User")!;
    const base = { joinTime: Date.now() - 30 * 24 * 3600 * 1000, ratio: 2 };
    expect(levelRequirementUnMet({ ...base, uploaded: 1.5 * 1024 ** 3, uploads: 120 } as any, powerUser)).toEqual({});
    expect(levelRequirementUnMet({ ...base, uploaded: 11 * 1024 ** 3, uploads: 12 } as any, powerUser)).toEqual({});
    expect(levelRequirementUnMet({ ...base, uploaded: 1.5 * 1024 ** 3, uploads: 12 } as any, powerUser)).not.toEqual(
      {},
    );
  });
});

describe("等级阶梯必须按门槛单调（D-13）", () => {
  it("empornium：已满足 Smut Peddler 门槛的用户被判到 6 级，而不是卡在 Better Perv 前的 3 级", async () => {
    const { guessUserLevelId } = await import("@ptd/site/utils/level.ts");
    const { siteMetadata } = await import("@ptd/site/definitions/empornium.ts");
    const user = {
      levelName: "unrecognized",
      joinTime: Date.now() - 300 * 24 * 3600 * 1000,
      uploaded: 11 * 1024 ** 4,
      downloaded: 1024 ** 4,
      uploads: 260,
    } as any;
    expect(levelRequirementUnMet({ ...user }, siteMetadata.levelRequirements![1])).toEqual({});
    expect(guessUserLevelId(user, siteMetadata.levelRequirements!)).toBe(6);
  });
});

describe("分享率 + 上传量门槛：上传已足够时不得登记 uploaded: 0（本轮新发现）", () => {
  it("下载量大但上传量也足够时判为已满足", () => {
    const requirement = { id: 2, name: "Perv", uploaded: "10GB", ratio: 0.6 } as any;
    const user = { uploaded: 11 * 1024 ** 4, downloaded: 1024 ** 4 } as any;
    expect(levelRequirementUnMet(user, requirement)).toEqual({});
  });

  it("上传确实不足以覆盖分享率时仍登记差额", () => {
    const requirement = { id: 2, name: "Perv", uploaded: "10GB", ratio: 0.6 } as any;
    const user = { uploaded: 100 * 1024 ** 3, downloaded: 1024 ** 4 } as any;
    expect(levelRequirementUnMet(user, requirement).uploaded).toBeCloseTo(0.6 * 1024 ** 4 - 100 * 1024 ** 3, -3);
  });
});
