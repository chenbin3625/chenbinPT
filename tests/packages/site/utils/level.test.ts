import { describe, expect, it } from "vitest";

import { cleanLevelName, fixRatio, guessUserLevelGroupType } from "@ptd/site/utils/level.ts";

describe("cleanLevelName", () => {
  it("去掉空格与下划线并统一小写", () => {
    expect(cleanLevelName(" Power  User ")).toBe("poweruser");
    expect(cleanLevelName("VIP_Level")).toBe("viplevel");
    expect(cleanLevelName("Elite\tUser")).toBe("eliteuser");
    expect(cleanLevelName("Elite\nUser")).toBe("eliteuser");
  });

  it("中日文等级名不受影响（不作为分隔符）", () => {
    expect(cleanLevelName("用户 等级")).toBe("用户等级");
    expect(cleanLevelName("PowerUser")).toBe("poweruser");
  });

  it("空串返回空串", () => {
    expect(cleanLevelName("")).toBe("");
  });
});

describe("fixRatio", () => {
  it("显式提供了 ratio 时直接使用（0 也视为已提供）", () => {
    expect(fixRatio({ ratio: 1.5, uploaded: 10, downloaded: 100 })).toBe(1.5);
    expect(fixRatio({ ratio: 0, uploaded: 10, downloaded: 100 })).toBe(0);
  });

  it("未提供 ratio 时用 uploaded / downloaded 计算", () => {
    expect(fixRatio({ uploaded: 10, downloaded: 5 })).toBe(2);
    expect(fixRatio({ uploaded: 1, downloaded: 3 })).toBeCloseTo(1 / 3, 10);
  });

  it("下载量为 0 且有上传量 -> Infinity", () => {
    expect(fixRatio({ uploaded: 10, downloaded: 0 })).toBe(Infinity);
  });

  it("上传与下载都为 0（或完全没有数据）-> -Infinity", () => {
    expect(fixRatio({ uploaded: 0, downloaded: 0 })).toBe(-Infinity);
    expect(fixRatio({})).toBe(-Infinity);
  });

  it("trueRatio 使用 trueUploaded / trueDownloaded", () => {
    expect(fixRatio({ trueUploaded: 30, trueDownloaded: 10 }, "trueRatio")).toBe(3);
    // 只给了 uploaded/downloaded：trueUploaded/trueDownloaded 视为 0/0
    expect(fixRatio({ uploaded: 10, downloaded: 5 }, "trueRatio")).toBe(-Infinity);
  });

  it("显式的 trueRatio 优先于计数换算", () => {
    expect(fixRatio({ trueRatio: 4.25, trueUploaded: 1, trueDownloaded: 1 }, "trueRatio")).toBe(4.25);
  });
});

describe("guessUserLevelGroupType", () => {
  it("普通等级 -> user", () => {
    expect(guessUserLevelGroupType("User")).toBe("user");
    expect(guessUserLevelGroupType("Power User")).toBe("user");
    expect(guessUserLevelGroupType("Elite User")).toBe("user");
    expect(guessUserLevelGroupType("")).toBe("user");
  });

  it("管理/特殊等级 -> manager（大小写不敏感，支持中英关键字）", () => {
    expect(guessUserLevelGroupType("Uploader")).toBe("manager");
    expect(guessUserLevelGroupType("MODERATOR")).toBe("manager");
    expect(guessUserLevelGroupType("Administrator")).toBe("manager"); // 命中 "admin"
    expect(guessUserLevelGroupType("Retiree")).toBe("manager");
    expect(guessUserLevelGroupType("Seeder")).toBe("manager");
    expect(guessUserLevelGroupType("保种员")).toBe("manager");
    expect(guessUserLevelGroupType("发布员")).toBe("manager");
  });

  it("VIP / 荣誉等级 -> vip", () => {
    expect(guessUserLevelGroupType("VIP")).toBe("vip");
    expect(guessUserLevelGroupType("贵宾")).toBe("vip");
    expect(guessUserLevelGroupType("Honorary Member")).toBe("vip");
    expect(guessUserLevelGroupType("荣誉会员")).toBe("vip");
  });

  it("同时命中 manager 与 vip 时 manager 优先（遍历顺序决定）", () => {
    expect(guessUserLevelGroupType("VIP 发布员")).toBe("manager");
    expect(guessUserLevelGroupType("vip uploader")).toBe("manager");
  });
});
