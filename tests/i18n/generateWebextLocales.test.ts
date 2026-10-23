/**
 * `vite/plugin/generateWebextLocales.ts` 的副作用回归（缺陷清单 G17）。
 *
 * 旧实现有三个问题，任何一条回退都会在这里失败：
 * 1. 在 `buildStart` 里**先删整个** `public/_locales` 再逐个写 —— 构建中断会留下缺 key 的半成品；
 * 2. 用 `process.cwd()` 定位（`vite --config` / 从子目录运行时会读错 `src/locales`、清错目录）；
 * 3. 解析失败时目录已经被删掉（错误现场不可诊断）。
 *
 * 现在：全部语言包先解析到内存（失败在写盘之前抛出）→ 逐文件原子写 → 最后清理过期语言目录；
 * 路径来自 `generateWebextLocales(root)` 的显式 root。
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// @ts-expect-error TS6305：vite/plugin 属于 tsconfig.node 的 composite project，主项目直接引用其源文件时
// TS 会要求先构建该 project。这里用精确的行级豁免（而不是把整个测试从 tsconfig 的 include 中排除）；
// 方案 B（把测试并入 tsconfig.node.json 的 include）实测会让该 directive 在 check:node 里变成 TS2578 unused，故保留行级豁免（task-12）。
import { generateWebextLocales } from "../../vite/plugin/generateWebextLocales.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const REPO_PUBLIC_LOCALES = path.join(REPO_ROOT, "public/_locales");

const tempRoots: string[] = [];

function createFixtureRoot(options: { locales: Record<string, unknown> }): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ptd-locales-"));
  tempRoots.push(root);
  fs.mkdirSync(path.join(root, "src/locales"), { recursive: true });
  for (const [locale, content] of Object.entries(options.locales)) {
    fs.writeFileSync(path.join(root, "src/locales", `${locale}.json`), JSON.stringify(content, null, 2));
  }
  return root;
}

function readOutput(root: string, locale: string): any {
  return JSON.parse(fs.readFileSync(path.join(root, "public/_locales", locale, "messages.json"), "utf8"));
}

/** 递归读取目录下所有文件内容（用于断言「没有写到仓库工作区」） */
function snapshotDir(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!fs.existsSync(dir)) return out;
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else out[path.relative(dir, full).split(path.sep).join("/")] = fs.readFileSync(full, "utf8");
    }
  };
  walk(dir);
  return out;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("generateWebextLocales（G17）", () => {
  it("按 root 生成 messages.json，并清理已无源语言包的过期目录", () => {
    const root = createFixtureRoot({
      locales: {
        en: { manifest: { extName: "PTD", extDesc: "desc" } },
        zh_CN: { manifest: { extName: "PTD 中文" } },
      },
    });
    // 预置一个「源语言包已删除」的旧目录：应当被清理（旧行为），但必须在成功写入之后
    fs.mkdirSync(path.join(root, "public/_locales/ja"), { recursive: true });
    fs.writeFileSync(path.join(root, "public/_locales/ja/messages.json"), "{}");

    const result = generateWebextLocales(root);

    expect(readOutput(root, "en")).toEqual({ extName: { message: "PTD" }, extDesc: { message: "desc" } });
    expect(readOutput(root, "zh_CN")).toEqual({ extName: { message: "PTD 中文" } });
    expect(fs.existsSync(path.join(root, "public/_locales/ja"))).toBe(false);
    expect(result.removed).toEqual([path.join(root, "public/_locales/ja")]);
    // 临时文件不残留
    expect(fs.readdirSync(path.join(root, "public/_locales/en"))).toEqual(["messages.json"]);
  });

  it("某个语言包解析失败时不破坏已有产物（先解析、后写盘）", () => {
    const root = createFixtureRoot({
      locales: {
        en: { manifest: { extName: "PTD" } },
        // 缺少 manifest 字段：应当在写盘之前抛错
        broken: { other: true },
      },
    });
    fs.mkdirSync(path.join(root, "public/_locales/en"), { recursive: true });
    fs.writeFileSync(path.join(root, "public/_locales/en/messages.json"), '{"extName":{"message":"OLD"}}');

    expect(() => generateWebextLocales(root)).toThrow(/No manifest field found in broken\.json/);

    // 旧实现会先把整个目录删掉再解析 → 这里旧内容必须仍然完整
    expect(readOutput(root, "en")).toEqual({ extName: { message: "OLD" } });
  });

  it("不会写到 process.cwd() 指向的仓库工作区（路径来自 root，而不是 cwd）", () => {
    // 前提：测试的 cwd 是仓库根（vitest 默认）。旧实现用 process.cwd()，会把仓库的
    // public/_locales 删掉重写 —— 这个断言能让它立刻失败。
    expect(process.cwd()).toBe(REPO_ROOT);
    const before = snapshotDir(REPO_PUBLIC_LOCALES);

    const root = createFixtureRoot({ locales: { en: { manifest: { extName: "PTD" } } } });
    generateWebextLocales(root);

    expect(snapshotDir(REPO_PUBLIC_LOCALES)).toEqual(before);
    expect(fs.existsSync(path.join(root, "public/_locales/en/messages.json"))).toBe(true);
  });

  it("清理上次构建中断留下的 *.tmp-* 临时文件（否则会随 public/ 进发布包）", () => {
    const root = createFixtureRoot({ locales: { en: { manifest: { extName: "PTD" } } } });
    const localeDir = path.join(root, "public/_locales/en");
    fs.mkdirSync(localeDir, { recursive: true });
    fs.writeFileSync(path.join(localeDir, "messages.json"), '{"extName":{"message":"OLD"}}');
    // 模拟上一次构建被 Ctrl-C：rename 之前的临时文件残留（语言子目录内 + _locales 顶层各一份）
    fs.writeFileSync(path.join(localeDir, "messages.json.tmp-99999"), "partial");
    fs.writeFileSync(path.join(root, "public/_locales/messages.json.tmp-1"), "partial-top");

    const result = generateWebextLocales(root);

    expect(fs.readdirSync(localeDir)).toEqual(["messages.json"]);
    expect(fs.existsSync(path.join(root, "public/_locales/messages.json.tmp-1"))).toBe(false);
    expect(result.cleaned.length).toBe(2);
    expect(result.cleaned.every((file: string) => file.includes(".tmp-"))).toBe(true);
    expect(readOutput(root, "en")).toEqual({ extName: { message: "PTD" } });
  });
});
