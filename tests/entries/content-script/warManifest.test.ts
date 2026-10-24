import { existsSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import webAccessibleResources from "../../../vite/warResources.json";

// @ts-expect-error TS6305：vite/** 属于 tsconfig.node 的 composite project，主项目引用其源文件时要求先构建。
// 方案 B（把测试并入 tsconfig.node.json 的 include）实测会让该 directive 在 check:node 里变成 TS2578 unused，故保留行级豁免（task-12）。
import { chromeWebAccessibleResources, getWebAccessibleResources } from "../../../vite/warResources.ts";

/** 构建输入（vite/manifest.ts 静态 import 它） */
const WAR_SOURCE_PATH = path.resolve(import.meta.dirname, "../../../vite/warResources.json");

describe("content script WAR policy", () => {
  it("warResources.json 是构建输入，必须存在于工作区（防 untracked 漏提交）", () => {
    // 缺该文件时 `wxt build` 会在读取配置阶段直接失败（ESM 静态 import 解析不到）。
    expect(existsSync(WAR_SOURCE_PATH)).toBe(true);
  });

  it("只暴露页面上直接引用的静态资源，且使用动态 URL", () => {
    expect(webAccessibleResources).toEqual([
      {
        resources: ["icons/*", "lib/*"],
        matches: ["*://*/*"],
        use_dynamic_url: true,
      },
    ]);
  });

  it("不再以固定扩展 ID 暴露任何 JS chunk / 样式文件（内容脚本 UI 改由 scripting.executeScript 注入）", () => {
    const resources = webAccessibleResources.flatMap((war) => war.resources);
    for (const legacy of ["assets/*", "vendor/*", "chenbinpt.css", "chunks/*", "content-scripts/*"]) {
      expect(resources).not.toContain(legacy);
    }
    expect(webAccessibleResources.every((war) => war.use_dynamic_url === true)).toBe(true);
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
    // 源 JSON 不被修改（剥离是拷贝语义，避免 chrome 构建被污染）
    expect(webAccessibleResources[0]).toHaveProperty("use_dynamic_url", true);
  });
});
