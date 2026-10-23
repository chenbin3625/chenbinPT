/**
 * level.ts 修复回归（E08 / E09 / E10 / E15 / E16 / N5）。
 */
import { describe, expect, it } from "vitest";

import type { ILevelRequirement } from "@ptd/site/types.ts";
import { fixRatio, getNextLevelUnMet, guessUserLevelId, levelRequirementUnMet } from "@ptd/site/utils/level.ts";

const GiB = 1024 ** 3;
const DAY = 24 * 3600 * 1000;
const now = () => Date.now();

describe("E08：判级不得写回调用方的 userInfo", () => {
  it("只上传未下载时不再把 ratio=Infinity 注入 userInfo", () => {
    const userInfo: any = { uploaded: 10 * GiB, downloaded: 0 };
    const snapshot = JSON.stringify(userInfo);

    levelRequirementUnMet(userInfo, { id: 2, name: "X", uploaded: "1GB", ratio: 1 } as any);

    expect(JSON.stringify(userInfo)).toBe(snapshot);
    expect("ratio" in userInfo).toBe(false);
  });

  it("trueRatio 同样不写回", () => {
    const userInfo: any = { trueUploaded: 10 * GiB, trueDownloaded: 0 };
    const snapshot = JSON.stringify(userInfo);

    levelRequirementUnMet(userInfo, { id: 2, name: "X", trueRatio: 1 } as any);

    expect(JSON.stringify(userInfo)).toBe(snapshot);
    expect("trueRatio" in userInfo).toBe(false);
  });

  it("getNextLevelUnMet 不污染传入的用户画像", () => {
    const userInfo: any = { uploaded: 10 * GiB, downloaded: 0, levelId: 1 };
    const snapshot = JSON.stringify(userInfo);

    getNextLevelUnMet(userInfo, [
      { id: 1, name: "User", privilege: "" },
      { id: 2, name: "Power", uploaded: "1GB", ratio: 1 },
    ] as ILevelRequirement[]);

    expect(JSON.stringify(userInfo)).toBe(snapshot);
  });
});

describe("E09：分享率区间不得原地 sort 站点定义常量", () => {
  it("调用后 metadata 中的 ratio 数组顺序保持不变，判定仍用 [min,max]", () => {
    const sharedRatio = [2, 1] as number[];
    const requirement = { id: 5, name: "L5", ratio: sharedRatio } as unknown as ILevelRequirement;

    // ratio 3 落在 [1,2] 的 max 之外：会登记 max 未满足
    const unmet = levelRequirementUnMet({ uploaded: 300, downloaded: 100 } as any, requirement);

    expect(sharedRatio).toEqual([2, 1]);
    expect(unmet.ratio).toBe(2);
  });
});

describe("E10：等级名匹配优先全等，避免较短高等级名被低等级抢占", () => {
  const magicLevels: ILevelRequirement[] = [
    { id: 2, name: "准魔法师" },
    { id: 3, name: "魔法师" },
  ];
  const pornLevels: ILevelRequirement[] = [
    { id: 3, name: "Pornstar Trainee" },
    { id: 6, name: "Pornstar" },
  ];

  it("「魔法师」精确命中 3 级，而不是包含匹配的「准魔法师」(2 级)", () => {
    expect(guessUserLevelId({ levelName: "魔法师" } as any, magicLevels)).toBe(3);
  });

  it("「Pornstar」精确命中 6 级，而不是「Pornstar Trainee」(3 级)", () => {
    expect(guessUserLevelId({ levelName: "Pornstar" } as any, pornLevels)).toBe(6);
    expect(guessUserLevelId({ levelName: "Pornstar Trainee" } as any, pornLevels)).toBe(3);
  });

  it("没有全等命中时仍保留「包含」匹配", () => {
    expect(guessUserLevelId({ levelName: "魔法师 " } as any, magicLevels)).toBe(3);
  });
});

describe("E15：无穷分享率哨兵值（-1 / 0）按 Infinity 处理", () => {
  it("fixRatio：-1 与 0 在只上传未下载时视为 Infinity", () => {
    expect(fixRatio({ uploaded: 10, downloaded: 0, ratio: -1 } as any)).toBe(Infinity);
    expect(fixRatio({ uploaded: 10, downloaded: 0, ratio: 0 } as any)).toBe(Infinity);
  });

  it("fixRatio：-1 是「∞」哨兵，不依赖 uploaded/downloaded 是否存在", () => {
    // DEF1/DEF5 反馈：用户画像可能只采集了 ratio（没有上下量），此时也必须识别哨兵
    expect(fixRatio({ ratio: -1 } as any)).toBe(Infinity);
    expect(fixRatio({ uploaded: 30, downloaded: 10, ratio: -1 } as any)).toBe(Infinity);
    expect(fixRatio({ trueRatio: -1 } as any, "trueRatio")).toBe(Infinity);
  });

  it("只上传未下载的用户满足分享率门槛（Luminance/TCG/Gazelle 形态）", () => {
    for (const ratio of [undefined, -1, 0]) {
      const unmet = levelRequirementUnMet(
        { uploaded: 20 * GiB, downloaded: 0, ratio } as any,
        { id: 3, name: "L3", ratio: 1 } as unknown as ILevelRequirement,
      );
      expect(unmet).toEqual({});
    }
  });

  it("只有 ratio=-1、没有上下量时也判为满足（哨兵语义）", () => {
    const requirement = { id: 3, name: "L3", ratio: 1 } as unknown as ILevelRequirement;
    expect(levelRequirementUnMet({ ratio: -1 } as any, requirement)).toEqual({});
    expect(levelRequirementUnMet({ uploaded: 0, downloaded: 0, ratio: -1 } as any, requirement)).toEqual({});
  });
});

describe("E16：joinTime 不可用时区间门槛不得被当作已满足", () => {
  const intervalRequirement = { id: 4, name: "L4", interval: "P4W", downloaded: "50GB", ratio: 1.05 } as any;

  it("joinTime 为 0 / 字符串 / NaN 时保守登记 interval 未满足", () => {
    for (const joinTime of [0, "注册于 昨天", Number.NaN, -1]) {
      const unmet = levelRequirementUnMet(
        { uploaded: 0, downloaded: 0, ratio: 0, joinTime } as any,
        intervalRequirement,
      );
      expect(unmet.interval).toBeTruthy();
      expect(unmet.passTime).toBeGreaterThan(now());
    }
  });

  it("joinTime 缺失时保持原行为（按刚刚加入处理）", () => {
    const unmet = levelRequirementUnMet({ uploaded: 0, downloaded: 0, ratio: 0 } as any, intervalRequirement);
    expect(unmet.interval).toBeTruthy();
  });

  it("合法 joinTime 且已超过区间要求时不登记 interval", () => {
    const unmet = levelRequirementUnMet(
      { uploaded: 0, downloaded: 0, ratio: 0, joinTime: now() - 40 * DAY } as any,
      intervalRequirement,
    );
    expect(unmet.interval).toBeUndefined();
  });
});

describe("N5：levelName 缺失时 guessUserLevelId 不抛异常", () => {
  const ladder: ILevelRequirement[] = [
    { id: 1, name: "User", privilege: "" },
    { id: 2, name: "Power", uploaded: "1GiB" },
  ];

  it.each([undefined, null, ""])("levelName=%j 走回落阶梯", (levelName) => {
    expect(() => guessUserLevelId({ levelName } as any, ladder)).not.toThrow();
    // 空画像不满足 id2 的 1GiB 门槛 → 回落到最低的可判定等级 id1
    expect(guessUserLevelId({ levelName } as any, ladder)).toBe(1);
  });

  it("VIP/管理等级名仍走 groupType 分支", () => {
    const withVip: ILevelRequirement[] = [
      { id: 1, name: "User", privilege: "" },
      { id: 105, name: "VIP", groupType: "vip" },
    ];
    expect(guessUserLevelId({ levelName: "VIP" } as any, withVip)).toBe(105);
  });
});
