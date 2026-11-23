import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type { ResolvedConfig } from "vite";

// @ts-expect-error TS6305：vite/** 属于 tsconfig.node 的 composite project，主项目引用其源文件时要求先构建。
import { generateSiteMetadataIndex, vitePluginGenerateSiteIndex } from "../../vite/plugin/generateSiteIndex.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/**
 * 搭建一个最小的伪站点包目录结构，供 `generateSiteMetadataIndex` / `vitePluginGenerateSiteIndex`
 * 在独立临时目录里快速执行真实 Vite SSR 子构建，不依赖全量 400+ 站点。
 */
function scaffoldFakeSiteRoot(siteName: string, extraExpr = ""): string {
  const root = createTempDir("ptd-site-index-fix-");
  const siteDir = path.join(root, "src", "packages", "site");
  fs.mkdirSync(path.join(siteDir, "definitions"), { recursive: true });
  fs.mkdirSync(path.join(siteDir, "schemas"), { recursive: true });
  fs.mkdirSync(path.join(siteDir, "utils"), { recursive: true });
  fs.mkdirSync(path.join(siteDir, "types"), { recursive: true });

  fs.writeFileSync(
    path.join(siteDir, "definitions", "demo.ts"),
    `// fixture: ${siteName}\nexport const siteMetadata = { id: "demo", name: ${extraExpr || JSON.stringify(siteName)}, type: "private", urls: ["https://demo.example/"] };\n`,
    "utf8",
  );
  fs.writeFileSync(path.join(siteDir, "schemas", "base.ts"), "export const schema = {};\n", "utf8");
  fs.writeFileSync(path.join(siteDir, "utils", "helper.ts"), "export const helper = true;\n", "utf8");
  fs.writeFileSync(
    path.join(siteDir, "types", "metadataIndex.ts"),
    "export type ISiteMetadataIndexEntry = Record<string, unknown>;\n",
    "utf8",
  );
  fs.writeFileSync(path.join(siteDir, "utils.ts"), "export * from './utils/helper.ts';\n", "utf8");
  fs.writeFileSync(
    path.join(siteDir, "utils", "metadataIndex.ts"),
    `export function pickSiteMetadataIndexEntry(meta: Record<string, unknown>) {
  return { name: meta.name, type: meta.type, urls: meta.urls };
}\n`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(siteDir, "index.ts"),
    `const modules = import.meta.glob("./definitions/*.ts");
export const definitionList = Object.keys(modules).map((p) => p.replace(/^\\.\\/definitions\\//, "").replace(/\\.ts$/, ""));
export async function getDefinedSiteMetadata(siteId: string) {
  const mod = (await modules[\`./definitions/\${siteId}.ts\`]()) as { siteMetadata: Record<string, unknown> };
  return mod.siteMetadata;
}\n`,
    "utf8",
  );

  return root;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("W04_build_scripts regression fixes", () => {
  describe("F0022: generateSiteMetadataIndex ESM cache busting & concurrency", () => {
    it("同进程内源码变更后再次生成不返回 Node ESM 缓存的旧索引，并清理临时目录", async () => {
      const root = scaffoldFakeSiteRoot("DemoV1");
      const ctx = { root, mode: "development", define: {}, alias: undefined };

      const first = await generateSiteMetadataIndex(ctx);
      expect(first).toEqual({
        demo: { name: "DemoV1", type: "private", urls: ["https://demo.example/"] },
      });

      // 修改站点定义，同进程再次调用：旧实现固定 import .../site-metadata-index-build/entry.mjs 会返回 DemoV1
      fs.writeFileSync(
        path.join(root, "src", "packages", "site", "definitions", "demo.ts"),
        `export const siteMetadata = { id: "demo", name: "DemoV2", type: "private", urls: ["https://demo-v2.example/"] };\n`,
        "utf8",
      );

      const second = await generateSiteMetadataIndex(ctx);
      expect(second).toEqual({
        demo: { name: "DemoV2", type: "private", urls: ["https://demo-v2.example/"] },
      });

      const workRoot = path.join(root, "node_modules", ".cache", "ptd-depiler", "site-metadata-index-build");
      expect(fs.existsSync(workRoot) ? fs.readdirSync(workRoot) : []).toEqual([]);
    });

    it("并发执行 generateSiteMetadataIndex 不会互相删除临时构建目录", async () => {
      const rootA = scaffoldFakeSiteRoot("SiteA");
      const rootB = scaffoldFakeSiteRoot("SiteB");

      const [resA, resB] = await Promise.all([
        generateSiteMetadataIndex({ root: rootA, mode: "production", define: {}, alias: undefined }),
        generateSiteMetadataIndex({ root: rootB, mode: "production", define: {}, alias: undefined }),
      ]);

      expect(resA.demo.name).toBe("SiteA");
      expect(resB.demo.name).toBe("SiteB");
    });
  });

  describe("F0027: vitePluginGenerateSiteIndex resolveContext precedence & optional configResolved", () => {
    it("跳过 configResolved 时可通过 options.context 正常加载虚拟模块", async () => {
      const root = scaffoldFakeSiteRoot("NoConfigResolved", "__TEST_SITE_LABEL__");
      const plugin = vitePluginGenerateSiteIndex({
        context: {
          root,
          define: { __TEST_SITE_LABEL__: JSON.stringify("FromContextOnly") },
        },
      });

      const resolvedId = (plugin.resolveId as (id: string) => string | undefined)("virtual:site-metadata-index");
      expect(resolvedId).toBe("\0virtual:site-metadata-index");

      const code = await (plugin.load as (id: string) => Promise<string | undefined>)(resolvedId!);
      expect(code).toContain('"name":"FromContextOnly"');
    });

    it("同时存在 configResolved 与 options.context.define 时，options.context.define 优先级更高", async () => {
      const root = scaffoldFakeSiteRoot("OverrideCheck", "__TEST_SITE_LABEL__");
      const plugin = vitePluginGenerateSiteIndex({
        context: {
          root,
          define: { __TEST_SITE_LABEL__: JSON.stringify("FromOptionsOverride") },
        },
      });

      (plugin.configResolved as (cfg: ResolvedConfig) => void)({
        root: "/unused-config-root",
        mode: "development",
        define: { __TEST_SITE_LABEL__: JSON.stringify("FromConfigShouldLose") },
        resolve: { alias: [] },
      } as unknown as ResolvedConfig);

      const code = await (plugin.load as (id: string) => Promise<string | undefined>)("\0virtual:site-metadata-index");
      expect(code).toContain('"name":"FromOptionsOverride"');
    });
  });

  describe("F0023: patches/picomatch+4.0.7.patch ReDoS bypasses", () => {
    it("补丁无 fuzz 干净应用，且拦截 [ 嵌套字符类、!(...) 否定 extglob、未闭合 [ 与非法 POSIX 类绕过", () => {
      const tmp = createTempDir("ptd-picomatch-patch-");
      fs.cpSync(path.join(REPO_ROOT, "node_modules", "picomatch"), path.join(tmp, "node_modules", "picomatch"), {
        recursive: true,
      });

      const parsePath = path.join(tmp, "node_modules", "picomatch", "lib", "parse.js");
      const restored = fs
        .readFileSync(parsePath, "utf8")
        .replace(/const hasUnboundedBranchQuantifier =[\s\S]*?return false;\n\};\n\n/, "")
        .replace(
          /if \(hasUnboundedBranchQuantifier\([^)]*\) \|\| repeatedExtglobRecursion\(branch\) > max\) \{/,
          "if (repeatedExtglobRecursion(branch) > max) {",
        );
      fs.writeFileSync(parsePath, restored, "utf8");

      execFileSync("patch", ["-p1", "--fuzz=0", "-i", path.join(REPO_ROOT, "patches", "picomatch+4.0.7.patch")], {
        cwd: tmp,
        stdio: "pipe",
      });

      const req = createRequire(import.meta.url);
      const pico = req(path.join(tmp, "node_modules", "picomatch")) as {
        (pattern: string, options?: Record<string, unknown>): (input: string) => boolean;
      };

      const redosCases: Array<[string, string, Record<string, unknown>?]> = [
        ["+([[]*)b", "[".repeat(64) + "!"],
        ["+(!(a))b", "b".repeat(64) + "!"],
        ["+([*a)b", "[".repeat(64) + "!"],
        ["+([[:bogus:]*])b", "[".repeat(64) + "!"],
        ["+([[:alpha:]]*)b", "a".repeat(64) + "!"],
        ["+([[]*])b", "[".repeat(64) + "!"],
        ["+([]]*)b", "]".repeat(64) + "!"],
        ["+([^]]*)b", "a".repeat(64) + "!"],
        ["+([!]]*)b", "a".repeat(64) + "!"],
        ["+([!]*)b", "!".repeat(64) + "!"],
        ["+(@(!(a)))b", "b".repeat(64) + "!"],
        ["+([[]|*)b", "[".repeat(64) + "!"],
        ["+([*])b", "[".repeat(64) + "!", { nobracket: true }],
        ["+(*)b", "a".repeat(64) + "!"],
        ["+(*a)b", "a".repeat(64) + "!"],
        ["*(*)b", "a".repeat(64) + "!"],
      ];

      for (const [pattern, input, opts] of redosCases) {
        const start = Date.now();
        expect(pico(pattern, opts)(input), `ReDoS pattern ${pattern}`).toBe(false);
        expect(Date.now() - start, `ReDoS timing ${pattern}`).toBeLessThan(200);
      }

      const compatCases: Array<[string, string, Record<string, unknown>?]> = [
        ["+(abc)", "abcabc"],
        ["+(a|b)", "abba"],
        ["+([ab])", "abba"],
        ["+(\\*)", "*"],
        ['+("*")', "*"],
        ["+([*])", "***"],
        ["+([[]a])", "[a][a]"],
        ["+([[:alpha:]*])", "a*B*"],
        ["+([]*])", "]*]"],
        ["+([^]*])", "a!b"],
        ["+([!]*])", "a!b", { posix: true }],
        ["+(*(a))", "aaaa"],
        ["src/**/*.ts", "src/index.ts"],
      ];

      for (const [pattern, value, opts] of compatCases) {
        expect(pico(pattern, opts)(value), `compat pattern ${pattern}`).toBe(true);
      }
    });
  });

  describe("F0024 / F0025 / F0026: script contracts & syntax checks", () => {
    it("F0024: sendToTgChannel 不再使用字符串版 .replace 拼接 moreMessage", () => {
      const src = fs.readFileSync(path.join(REPO_ROOT, "vite", "sendToTgChannel.ts"), "utf8");
      expect(src).not.toContain("|$|moreMessage|$|");
      expect(src).not.toContain("message.replace(");
    });

    it("F0025: pack-crx.mjs --help 可正常执行，且不再裸调 execFileSync('npm.cmd')", () => {
      const out = execFileSync(process.execPath, [path.join(REPO_ROOT, "scripts", "pack-crx.mjs"), "--help"], {
        encoding: "utf8",
      });
      expect(out).toContain("--build");
      const codeOnly = fs
        .readFileSync(path.join(REPO_ROOT, "scripts", "pack-crx.mjs"), "utf8")
        .split("\n")
        .filter((line) => !line.trim().startsWith("//"))
        .join("\n");
      expect(codeOnly).not.toMatch(/execFileSync\([^)]*"npm\.cmd"/);
      expect(codeOnly).toContain("ComSpec");
      expect(codeOnly).toContain("npm_execpath");
    });

    it("F0026: e2e-extension-smoke.mjs 语法有效且在 WAR 探测前独立断言挂载期零错误", () => {
      execFileSync(process.execPath, ["--check", path.join(REPO_ROOT, "scripts", "e2e-extension-smoke.mjs")]);
      const src = fs.readFileSync(path.join(REPO_ROOT, "scripts", "e2e-extension-smoke.mjs"), "utf8");
      const mountAssertIdx = src.indexOf("mountErrors.length === 0");
      const warProbeIdx = src.indexOf("const webAccessibleScripts");
      expect(mountAssertIdx).toBeGreaterThan(-1);
      expect(warProbeIdx).toBeGreaterThan(mountAssertIdx);
    });
  });
});
