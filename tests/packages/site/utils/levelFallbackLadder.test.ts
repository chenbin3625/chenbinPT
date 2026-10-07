/**
 * 回落判级阶梯（level.ts）的修复回归：
 * - DEFS1-1：没有门槛的等级（desigaane 5/6/7）不能被判为「已满足」；
 * - DEFS1-3：阶梯中间插有特殊等级时取「所有门槛都满足的最高等级」，而不是遇到首个未满足就取前一项；
 * - DEFS1-6：判级键与前面等级逐字相同的「非入口级」重复等级只按第一次出现计入；
 *   零统计用户也能满足的入口级重复（midnightscene id0/id1 同为 {ratio:0}）不去重，取较高的入口级。
 * 同时覆盖「距下一级」（getNextLevelUnMet）跳无门槛 / 与当前等级重复的目标。
 */
import { describe, expect, it } from "vitest";

import type { ILevelRequirement } from "@ptd/site/types.ts";
import {
  getJudgeableLevelRequirement,
  getNextLevelUnMet,
  guessUserLevelId,
  hasJudgeableRequirement,
} from "@ptd/site/utils/level.ts";

const GiB = 1024 ** 3;
const TiB = 1024 ** 4;
const DAY = 24 * 3600 * 1000;
const daysAgo = (days: number) => Date.now() - days * DAY;

const makeUser = (extra: Record<string, unknown>) =>
  ({ site: "probe", status: 0, updateAt: Date.now(), levelName: "未识别的自定义头衔", ...extra }) as any;

/** desigaane 形状：1/4/5 级只剩 name/privilege，2/3 级有可判定门槛 */
const emptyTailLadder: ILevelRequirement[] = [
  { id: 1, name: "User", privilege: "None" },
  { id: 2, name: "Member", interval: "P1W", uploaded: "10GiB", ratio: 0.6, privilege: "Invites" },
  { id: 3, name: "Elite", interval: "P4W", uploads: 50, uploaded: "100GiB", ratio: 0.65, privilege: "" },
  { id: 4, name: "Torrent Master", privilege: "" },
  { id: 5, name: "Elite TM", privilege: "" },
];

describe("DEFS1-1 无门槛等级不参与回落判级", () => {
  it("满足前两级时停在 id3，而不是末位的无门槛等级 id5", () => {
    const user = makeUser({ uploaded: 200 * GiB, uploads: 50, ratio: 0.7, joinTime: daysAgo(40) });
    expect(guessUserLevelId(user, emptyTailLadder)).toBe(3);
  });

  it("什么都没满足时仍落回最低的无门槛默认等级（id1）", () => {
    const user = makeUser({ uploaded: 0, ratio: 0, joinTime: Date.now() });
    expect(guessUserLevelId(user, emptyTailLadder)).toBe(1);
  });

  it("值为 undefined 的判级键不算门槛", () => {
    expect(hasJudgeableRequirement({ id: 1, name: "User", uploaded: undefined } as any)).toBe(false);
    expect(hasJudgeableRequirement(emptyTailLadder[1])).toBe(true);
  });

  it("真实 desigaane：只达 Elite 的用户不再被判成无门槛的 Elite TM", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/desigaane.ts");
    const levels = siteMetadata.levelRequirements!;
    const user = makeUser({ uploaded: 200 * GiB, uploads: 50, ratio: 0.7, joinTime: daysAgo(40) });

    expect(guessUserLevelId(user, levels)).toBe(4);

    // 等级名命中时仍返回站点配置的真实等级（包括无门槛的顶级），name 路径不受影响
    expect(guessUserLevelId({ ...user, levelName: "Elite TM" }, levels)).toBe(7);
  });
});

describe("DEFS1-6 非入口级（需累积）的重复判级键只按第一次出现计入", () => {
  it("只差 name/privilege/isKept 的相邻等级判级键相同，用户判到较低的一级", () => {
    const ladder: ILevelRequirement[] = [
      { id: 6, name: "Power TM", interval: "P8W", uploaded: "200GiB", ratio: 1.05, groups: 300 },
      {
        id: 7,
        name: "Elite TM",
        interval: "P12W",
        uploaded: "600GiB",
        ratio: 1.05,
        perfectFlacs: 500,
        isKept: true,
      },
      {
        id: 8,
        name: "Elite TM +",
        interval: "P12W",
        uploaded: "600GiB",
        ratio: 1.05,
        perfectFlacs: 500,
        isKept: true,
        privilege: "与 id7 不同的特权说明",
      },
    ];
    const user = makeUser({
      uploaded: 700 * GiB,
      groups: 400,
      perfectFlacs: 600,
      ratio: 1.2,
      joinTime: daysAgo(100),
    });

    expect(getJudgeableLevelRequirement(ladder[1])).toEqual(getJudgeableLevelRequirement(ladder[2]));
    expect(guessUserLevelId(user, ladder)).toBe(7);
  });

  it("真实 dicmusic：满足 id7 门槛的用户判到 Elite Torrent Master(7)，而不是重复的 id8", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/dicmusic.ts");
    const user = makeUser({
      uploaded: 700 * GiB,
      uploads: 200,
      groups: 400,
      perfectFlacs: 600,
      ratio: 1.2,
      joinTime: daysAgo(100),
    });

    expect(guessUserLevelId(user, siteMetadata.levelRequirements!)).toBe(7);
  });
});

describe("DEFS1-6 收口：入口级重复判级键不去重（midnightscene），需累积的重复仍去重（dicmusic）", () => {
  /** midnightscene 形状：id0 Leech 与 id1 User 的判级键都是 {ratio:0}，零统计用户也满足 */
  const entryLevelLadder: ILevelRequirement[] = [
    { id: 0, name: "Leech", ratio: 0, privilege: "1下载槽" },
    { id: 1, name: "User", ratio: 0, privilege: "无限下载槽 上传种子" },
    { id: 2, name: "PowerUser", uploaded: "1TiB", ratio: 0.4, interval: "P1M" },
  ];

  it("(a) 入口级 id0/id1 判级键同为 {ratio:0}：取较高的入口级 id1，而不是 Leech(id0)", () => {
    expect(getJudgeableLevelRequirement(entryLevelLadder[0])).toEqual(
      getJudgeableLevelRequirement(entryLevelLadder[1]),
    );
    expect(guessUserLevelId(makeUser({ uploaded: 0, ratio: 0 }), entryLevelLadder)).toBe(1);
    expect(guessUserLevelId(makeUser({ uploaded: 50 * GiB, ratio: 1.0 }), entryLevelLadder)).toBe(1);
  });

  it("(b) 需累积门槛的重复（dicmusic id7/id8 形状）仍按第一次出现去重：返回较低的那一级 id7", () => {
    const strictLadder: ILevelRequirement[] = [
      { id: 7, name: "Elite TM", interval: "P12W", uploaded: "600GiB", ratio: 1.05, perfectFlacs: 500, isKept: true },
      {
        id: 8,
        name: "Elite TM +",
        interval: "P12W",
        uploaded: "600GiB",
        ratio: 1.05,
        perfectFlacs: 500,
        isKept: true,
        privilege: "与 id7 不同的特权说明",
      },
    ];
    const user = makeUser({ uploaded: 700 * GiB, perfectFlacs: 600, ratio: 1.2, joinTime: daysAgo(100) });

    expect(getJudgeableLevelRequirement(strictLadder[0])).toEqual(getJudgeableLevelRequirement(strictLadder[1]));
    expect(guessUserLevelId(user, strictLadder)).toBe(7);
  });

  it("真实 midnightscene：新/小用户不再被判成 Leech(0)", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/midnightscene.ts");
    const levels = siteMetadata.levelRequirements!;

    expect(guessUserLevelId(makeUser({ uploaded: 0, ratio: 0 }), levels)).toBe(1);
    expect(guessUserLevelId(makeUser({ uploaded: 50 * GiB, ratio: 1.0 }), levels)).toBe(1);
    // 未达 PowerUser 门槛（1TiB / P1M）的活跃用户同样应停在 User(1)
    expect(guessUserLevelId(makeUser({ uploaded: 100 * GiB, ratio: 1.2, joinTime: daysAgo(40) }), levels)).toBe(1);
  });

  it("真实 dicmusic：入口级豁免不会让严格重复的 id8 抢占 id7", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/dicmusic.ts");
    const user = makeUser({
      uploaded: 700 * GiB,
      uploads: 200,
      groups: 400,
      perfectFlacs: 600,
      ratio: 1.2,
      joinTime: daysAgo(100),
    });

    expect(guessUserLevelId(user, siteMetadata.levelRequirements!)).toBe(7);
  });
});

describe("DEFS1-3 满足多级时取所有门槛都满足的最高等级", () => {
  /** darkpeers 形状：做种型 Seeder(3) 插在递增的上传阶梯中间 */
  const ladder: ILevelRequirement[] = [
    { id: 1, name: "Leecher", privilege: "" },
    { id: 2, name: "PowerUser", uploaded: "1TiB", ratio: 0.8, interval: "P1M" },
    { id: 3, name: "Seeder", ratio: 0.8, interval: "P1M", averageSeedingTime: "P1M", seedingSize: "3TiB" },
    { id: 4, name: "SuperUser", uploaded: "5TiB", ratio: 0.8, interval: "P2M", seedingSize: "500GiB", uploads: 5 },
  ];

  it("中间的首个未满足等级（Seeder 要 3TiB 做种体积）不再短路判级", () => {
    const user = makeUser({
      uploaded: 5 * TiB,
      ratio: 0.8,
      seedingSize: 500 * GiB,
      uploads: 5,
      joinTime: daysAgo(100),
    });
    expect(guessUserLevelId(user, ladder)).toBe(4);
  });

  it("真实 darkpeers：同样形状的用户判到 SuperUser(4)（原走位只会给 PowerUser(2)）", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/darkpeers.ts");
    const user = makeUser({
      uploaded: 5 * TiB,
      ratio: 0.8,
      seedingSize: 500 * GiB,
      uploads: 5,
      joinTime: daysAgo(100),
    });

    expect(guessUserLevelId(user, siteMetadata.levelRequirements!)).toBe(4);
  });
});

describe("距下一级：跳过无门槛与与当前等级重复的目标", () => {
  it("desigaane 的 Elite(4) 用户不再看到「Torrent Master: 无待满足条件」", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/desigaane.ts");
    const user = makeUser({ uploaded: 200 * GiB, uploads: 50, ratio: 0.7, joinTime: daysAgo(40), levelId: 4 });

    expect(getNextLevelUnMet(user, siteMetadata.levelRequirements!)).toEqual({});
  });

  it("dicmusic 的 Elite TM(7) 用户跳过判级键相同的 id8，直接以 Guru(9) 为目标", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/dicmusic.ts");
    const user = makeUser({
      uploaded: 700 * GiB,
      uploads: 200,
      groups: 400,
      perfectFlacs: 600,
      ratio: 1.2,
      joinTime: daysAgo(100),
      levelId: 7,
    });

    const nextLevelUnMet = getNextLevelUnMet(user, siteMetadata.levelRequirements!);
    expect((nextLevelUnMet as any).level?.id).toBe(9);
    expect(nextLevelUnMet.uploaded).toBeGreaterThan(0);
  });

  it("正常阶梯仍给出真实的下一级与未满足项", () => {
    const user = makeUser({ uploaded: 0, ratio: 0, joinTime: Date.now(), levelId: 1 });
    const nextLevelUnMet = getNextLevelUnMet(user, emptyTailLadder);

    expect((nextLevelUnMet as any).level?.id).toBe(2);
    expect(nextLevelUnMet.uploaded).toBe(10 * GiB);
  });

  it("levelId 未知（-1）时也跳过无门槛的首级", () => {
    const user = makeUser({ uploaded: 0, ratio: 0, joinTime: Date.now() });
    expect((getNextLevelUnMet(user, emptyTailLadder) as any).level?.id).toBe(2);
  });

  it("已在最高 user 等级时返回空对象", () => {
    expect(getNextLevelUnMet(makeUser({ levelId: 5 }), emptyTailLadder)).toEqual({});
  });
});

describe("回落判级既有语义保留", () => {
  it("首个等级就带门槛且未满足时仍返回 -1（部分 NPHP 从 PU 开始定义）", () => {
    const ladder: ILevelRequirement[] = [{ id: 1, name: "Power User", uploaded: "1TiB", ratio: 1 }];
    expect(guessUserLevelId(makeUser({ uploaded: 0, ratio: 0 }), ladder)).toBe(-1);
  });

  it("全部可判定门槛满足时取最高 user 等级", () => {
    const ladder: ILevelRequirement[] = [
      { id: 1, name: "User", privilege: "" },
      { id: 2, name: "Power User", uploaded: "1GiB" },
      { id: 3, name: "Elite", uploaded: "2GiB" },
    ];
    expect(guessUserLevelId(makeUser({ uploaded: 5 * GiB, ratio: 1 }), ladder)).toBe(3);
  });

  it("vip / manager 等级不参与回落阶梯", () => {
    const ladder: ILevelRequirement[] = [
      { id: 1, name: "User", privilege: "" },
      { id: 105, name: "VIP", groupType: "vip", privilege: "" },
      { id: 205, name: "Staff", groupType: "manager", privilege: "" },
    ];
    expect(guessUserLevelId(makeUser({ uploaded: 0, ratio: 0 }), ladder)).toBe(1);
  });

  it("整条阶梯只有无门槛等级时仍取最高 user 等级（保持原默认）", () => {
    const ladder: ILevelRequirement[] = [
      { id: 1, name: "User", privilege: "" },
      { id: 2, name: "Member", privilege: "" },
    ];
    expect(guessUserLevelId(makeUser({}), ladder)).toBe(2);
  });
});
