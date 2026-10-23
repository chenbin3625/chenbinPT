/**
 * N1：`getSite` 不得修改调用方传入的 userConfig。
 *
 * content-script 传入的是 Pinia store action 直接返回的 state 引用，原地补默认值会变成
 * action 之外的 state 变更，且这些默认值不会持久化（UI 与 offscreen 读到不同值）。
 */
import { describe, expect, it } from "vitest";

import { getSite } from "@ptd/site/index.ts";

describe("getSite：N1 userConfig 副作用", () => {
  it("默认值补在副本上，调用方对象保持不变", async () => {
    const userConfig: any = {};
    const site: any = await getSite("mteam", userConfig);

    expect(userConfig).toEqual({});
    expect(site.userConfig).not.toBe(userConfig);
    expect(site.userConfig.allowSearch).toBeDefined();
    expect(site.userConfig.allowQueryUserInfo).toBeDefined();
  });

  it("不再写入无人消费的 showMessageCount 死字段", async () => {
    const site: any = await getSite("mteam", {});
    expect("showMessageCount" in site.userConfig).toBe(false);
  });

  it("已有的用户配置保持不变（不被覆盖）", async () => {
    const site: any = await getSite("mteam", { allowSearch: false, allowQueryUserInfo: false } as any);
    expect(site.userConfig.allowSearch).toBe(false);
    expect(site.userConfig.allowQueryUserInfo).toBe(false);
  });
});
