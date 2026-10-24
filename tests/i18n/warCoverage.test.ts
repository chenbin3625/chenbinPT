/**
 * `scripts/lib/war-coverage.mjs` 的 WAR glob 语义与构建期断言（task-12 / 复检 Low#5；WXT 迁移后收窄）。
 *
 * 该脚本是 `npm run check:bundle` 与 `npm run pack:crx` 的构建期安全网：匹配语义写错会造成
 * 假红或漏报。这里锁住：
 * 1. `*` 按 Chrome 语义匹配任意字符（可跨 `/`、可多次出现、整串锚定）；
 * 2. 每个 WAR 模式都要真实匹配到产物；
 * 3. WAR 不得暴露任何脚本/页面产物（内容脚本 UI 改由 scripting.executeScript 注入后不再需要）。
 */
import { describe, expect, it } from "vitest";

import {
  checkWarExposesNoScripts,
  checkWarWildcardsHaveMatches,
  warResourceMatches,
} from "../../scripts/lib/war-coverage.mjs";

describe("WAR glob（Chrome 语义）", () => {
  it("`*` 匹配任意字符且可跨目录（目录递归）", () => {
    expect(warResourceMatches("assets/*", "assets/cs-app.js")).toBe(true);
    expect(warResourceMatches("assets/*", "assets/nested/deeper/chunk.js")).toBe(true);
    expect(warResourceMatches("icons/*", "icons/logo/128.png")).toBe(true);
    expect(warResourceMatches("*.png", "icons/logo/128.png")).toBe(true);
  });

  it("支持多星模式（旧的「只处理第一个 *」实现会漏）", () => {
    expect(warResourceMatches("assets/*/*.js", "assets/sub/x.js")).toBe(true);
    expect(warResourceMatches("assets/*/x/*.js", "assets/a/x/b.js")).toBe(true);
    expect(warResourceMatches("assets/*-*.js", "assets/pre-fix.js")).toBe(true);
    expect(warResourceMatches("assets/*/*.js", "vendor/sub/x.js")).toBe(false);
  });

  it("整串锚定：前缀相同但后缀不同不算覆盖；非通配模式必须完全相等", () => {
    expect(warResourceMatches("assets/*.js", "assets/x.css")).toBe(false);
    expect(warResourceMatches("assets/*.js", "assets/x.js.map")).toBe(false);
    expect(warResourceMatches("style.css", "style.css")).toBe(true);
    expect(warResourceMatches("style.css", "other/style.css")).toBe(false);
    expect(warResourceMatches("assets/*", "assetsbak/x.js")).toBe(false);
  });

  it("容忍 Chrome 文档示例里的前导 `/`", () => {
    expect(warResourceMatches("/assets/*", "assets/cs-app.js")).toBe(true);
    expect(warResourceMatches("/style.css", "style.css")).toBe(true);
  });
});

describe("checkWarWildcardsHaveMatches 做真实匹配（旧实现只看前缀）", () => {
  it("前缀存在但后缀不匹配时必须报告（旧实现漏报）", () => {
    const manifest = { web_accessible_resources: [{ resources: ["assets/*.css"], matches: ["*://*/*"] }] };
    const problems = checkWarWildcardsHaveMatches(manifest, () => ["assets/foo.js"]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("assets/*.css");
  });

  it("匹配到真实文件时通过；非通配条目也要求真实存在", () => {
    const manifest = {
      web_accessible_resources: [{ resources: ["icons/*", "lib/*", "style.css"], matches: ["*://*/*"] }],
    };
    expect(checkWarWildcardsHaveMatches(manifest, () => ["icons/a.png", "lib/mdi/x.woff2", "style.css"])).toEqual([]);
    expect(checkWarWildcardsHaveMatches(manifest, () => ["icons/a.png", "lib/mdi/x.woff2"])).toEqual([
      'WAR 资源模式 "style.css" 在产物里没有任何匹配文件',
    ]);
  });
});

describe("checkWarExposesNoScripts", () => {
  const files = [
    "icons/logo/128.png",
    "lib/mdi/webfont.woff2",
    "content-scripts/cs-app.js",
    "chunks/antd-abc.js",
    "options.html",
  ];

  it("只暴露静态资源时通过", () => {
    const manifest = { web_accessible_resources: [{ resources: ["icons/*", "lib/*"], matches: ["*://*/*"] }] };
    expect(checkWarExposesNoScripts(manifest, () => files)).toEqual([]);
  });

  it("把脚本或页面加回 WAR 时报出具体模式", () => {
    const manifest = {
      web_accessible_resources: [
        { resources: ["icons/*"], matches: ["*://*/*"] },
        { resources: ["chunks/*", "content-scripts/*", "*.html"], matches: ["*://*/*"] },
      ],
    };
    const problems = checkWarExposesNoScripts(manifest, () => files);
    expect(problems).toHaveLength(3);
    expect(problems[0]).toContain('"chunks/*"');
    expect(problems[1]).toContain('"content-scripts/*"');
    expect(problems[2]).toContain('"*.html"');
  });
});
