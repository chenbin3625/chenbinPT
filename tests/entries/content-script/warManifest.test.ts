import { existsSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import webAccessibleResources from "../../../vite/warResources.json";

// @ts-expect-error TS6305：vite/** 属于 tsconfig.node 的 composite project，主项目引用其源文件时要求先构建。
// 方案 B（把测试并入 tsconfig.node.json 的 include）实测会让该 directive 在 check:node 里变成 TS2578 unused，故保留行级豁免（task-12）。
import { chromeWebAccessibleResources, getWebAccessibleResources } from "../../../vite/warResources.ts";

/** 构建输入（vite.config.ts 静态 import 它） */
const WAR_SOURCE_PATH = path.resolve(import.meta.dirname, "../../../vite/warResources.json");

describe("content script WAR policy", () => {
  it("warResources.json 是构建输入，必须存在于工作区（防 untracked 漏提交）", () => {
    // 缺该文件时 `vite build` / `vite dev` 会在读取配置阶段直接失败（ESM 静态 import 解析不到）。
    expect(existsSync(WAR_SOURCE_PATH)).toBe(true);
  });

  it("keeps only icons and styles on dynamic URLs", () => {
    expect(webAccessibleResources).toContainEqual({
      resources: ["icons/*", "lib/*", "chenbinpt.css"],
      matches: ["*://*/*"],
      use_dynamic_url: true,
    });
  });

  it("keeps the entire ESM chunk graph loadable through the canonical ID", () => {
    expect(webAccessibleResources).toContainEqual({
      resources: ["assets/*", "vendor/*"],
      matches: ["*://*/*"],
    });
    expect(webAccessibleResources.find((war) => war.resources.includes("assets/*"))).not.toHaveProperty(
      "use_dynamic_url",
    );
  });

  it("chrome（及非 firefox）目标原样保留 JSON 内容，含 use_dynamic_url", () => {
    expect(getWebAccessibleResources("chrome")).toEqual(webAccessibleResources);
    expect(getWebAccessibleResources("")).toEqual(webAccessibleResources);
    expect(chromeWebAccessibleResources).toEqual(webAccessibleResources);
  });

  it("firefox 目标剥离 use_dynamic_url（Firefox 不支持 Chrome 的 dynamic URL），其余字段不变", () => {
    const firefox = getWebAccessibleResources("firefox");
    expect(firefox).toHaveLength(webAccessibleResources.length);
    expect(firefox.every((entry: any) => !("use_dynamic_url" in entry))).toBe(true);
    expect(firefox[0].resources).toEqual(webAccessibleResources[0].resources);
    expect(firefox[0].matches).toEqual(webAccessibleResources[0].matches);
    expect(firefox[1]).toEqual(webAccessibleResources[1]);
    // 源 JSON 不被修改（剥离是拷贝语义，避免 chrome 构建被污染）
    expect(webAccessibleResources[0]).toHaveProperty("use_dynamic_url", true);
  });
});
