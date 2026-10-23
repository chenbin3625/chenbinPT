/**
 * `scripts/lib/war-coverage.mjs` 的说明符提取与 WAR glob 语义（task-12 / 复检 Low#5）。
 *
 * 该脚本是 `npm run check:bundle` 与 `npm run pack:crx` 的构建期安全网：匹配语义写错会造成
 * 假红（把注释里的 `from "..."` 当依赖）或漏报（只看前缀就说 WAR 覆盖了）。这里锁住两件事：
 * 1. `*` 按 Chrome 语义匹配任意字符（可跨 `/`、可多次出现、整串锚定）；
 * 2. 说明符只从真实的 import/export 语句里提取，注释/普通字符串里的 `from "..."` 不算。
 */
import { describe, expect, it } from "vitest";

import {
  checkCsAppWarClosure,
  checkWarWildcardsHaveMatches,
  extractRelativeImportSpecifiers,
  resolveRelativeModulePath,
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
    expect(warResourceMatches("chenbinpt.css", "chenbinpt.css")).toBe(true);
    expect(warResourceMatches("chenbinpt.css", "other/chenbinpt.css")).toBe(false);
    expect(warResourceMatches("assets/*", "assetsbak/x.js")).toBe(false);
  });

  it("容忍 Chrome 文档示例里的前导 `/`", () => {
    expect(warResourceMatches("/assets/*", "assets/cs-app.js")).toBe(true);
    expect(warResourceMatches("/chenbinpt.css", "chenbinpt.css")).toBe(true);
  });
});

describe("import 说明符提取", () => {
  it("覆盖静态 import / export … from / 副作用 import / 字面量动态 import", () => {
    const source = `
      import { a } from "./static.js";
      import "./side-effect.js";
      export * from "./reexport.js";
      export { b } from "./reexport2.js";
      const lazy = import("./dynamic.js");
      import bare from "bare-package";
    `;
    expect(extractRelativeImportSpecifiers(source).sort()).toEqual(
      ["./dynamic.js", "./reexport.js", "./reexport2.js", "./side-effect.js", "./static.js"].sort(),
    );
  });

  it("不把注释与普通字符串里的 from/import 当依赖（旧实现会假红）", () => {
    const source = `
      // import x from "./commented-line.js";
      /* import y from "./commented-block.js"; */
      const message = "see import z from './string.js'";
      const url = "https://example.com/import/from/x.js";
      import { real } from "./real.js";
    `;
    expect(extractRelativeImportSpecifiers(source)).toEqual(["./real.js"]);
  });

  it("相对说明符解析为产物内 POSIX 路径", () => {
    expect(resolveRelativeModulePath("assets/cs-app.js", "./runtime-x.js")).toBe("assets/runtime-x.js");
    expect(resolveRelativeModulePath("assets/cs-app.js", "../vendor/a/b.js")).toBe("vendor/a/b.js");
    expect(resolveRelativeModulePath("assets/a.js", "./sub/../z.js")).toBe("assets/z.js");
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
      web_accessible_resources: [
        { resources: ["assets/*", "chenbinpt.css"], matches: ["*://*/*"] },
        { resources: ["vendor/*"], matches: ["*://*/*"] },
      ],
    };
    expect(checkWarWildcardsHaveMatches(manifest, () => ["assets/cs-app.js", "chenbinpt.css", "vendor/a.js"])).toEqual(
      [],
    );
    expect(checkWarWildcardsHaveMatches(manifest, () => ["assets/cs-app.js", "vendor/a.js"])).toEqual([
      'WAR 资源模式 "chenbinpt.css" 在产物里没有任何匹配文件',
    ]);
  });
});

describe("checkCsAppWarClosure", () => {
  it("闭包完整且被 WAR 覆盖时无问题", async () => {
    const files = new Map([
      [
        "manifest.json",
        JSON.stringify({ web_accessible_resources: [{ resources: ["assets/*", "vendor/*"], matches: ["*://*/*"] }] }),
      ],
      ["assets/cs-app.js", 'import { a } from "./runtime.js"; import { b } from "../vendor/lib.js";'],
      ["assets/runtime.js", "export const a = 1;"],
      ["vendor/lib.js", "export const b = 1;"],
    ]);
    const result = await checkCsAppWarClosure({
      fileExists: (file: string) => files.has(file),
      readFile: (file: string) => files.get(file) ?? null,
    });
    expect(result.problems).toEqual([]);
    expect(result.checked).toBe(3);
  });

  it("缺 chunk 或 WAR 收窄漏项时报出具体文件", async () => {
    const files = new Map([
      [
        "manifest.json",
        JSON.stringify({ web_accessible_resources: [{ resources: ["assets/*"], matches: ["*://*/*"] }] }),
      ],
      ["assets/cs-app.js", 'import "./runtime.js"; import "../vendor/lib.js";'],
      ["assets/runtime.js", "export const a = 1;"],
      // vendor/lib.js 既缺文件，也没被 WAR 覆盖
    ]);
    const result = await checkCsAppWarClosure({
      fileExists: (file: string) => files.has(file),
      readFile: (file: string) => files.get(file) ?? null,
    });
    expect(result.problems.some((problem: string) => problem.includes("vendor/lib.js 未被任何 WAR 资源模式覆盖"))).toBe(
      true,
    );
    expect(result.problems.some((problem: string) => problem.includes("vendor/lib.js 不存在于产物中"))).toBe(true);
  });
});
