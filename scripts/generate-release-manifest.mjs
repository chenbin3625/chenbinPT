#!/usr/bin/env node
/**
 * 本地发版清单生成脚本：扫描 build/ 中的发布包并产出 build/latest.json。
 *
 * 附带上传到 GitHub Release 后，扩展可优先读取该静态清单：
 * 1) 避开 GitHub REST API 60 次/小时的匿名限流；
 * 2) 为安装包提供 SHA-256 校验值与体积信息，供用户在更新引导弹窗中核对。
 * 若某次发布未附带 latest.json，扩展仍会自动回退到 GitHub Releases API。
 *
 * 用法：
 *   npm run pack:release-manifest
 *   node scripts/generate-release-manifest.mjs --notes "本次更新摘要"
 *   node scripts/generate-release-manifest.mjs --notes-file RELEASE_NOTES.md
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_SLUG = "chenbin3625/chenbinPT";
const DEFAULT_OUT = "build/latest.json";

const CANDIDATE_ASSETS = [
  { key: "chrome", relPath: "build/extension-chrome.zip", name: "extension-chrome.zip" },
  { key: "firefox", relPath: "build/extension-firefox.zip", name: "extension-firefox.zip" },
  { key: "crx", relPath: "build/extension.crx", name: "extension.crx" },
];

function parseArgs(argv) {
  const opts = { out: DEFAULT_OUT, tag: "", notes: "", notesFile: "" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} 需要一个值`);
      return value;
    };
    switch (arg) {
      case "--out":
        opts.out = next();
        break;
      case "--tag":
        opts.tag = next();
        break;
      case "--notes":
        opts.notes = next();
        break;
      case "--notes-file":
        opts.notesFile = next();
        break;
      case "-h":
      case "--help":
        console.log(
          [
            "生成随 GitHub Release 发布的静态更新清单 build/latest.json",
            "",
            "用法：node scripts/generate-release-manifest.mjs [options]",
            `  --out <path>         输出文件路径，默认 ${DEFAULT_OUT}`,
            "  --tag <tag>          发布 tag，默认 v<package.json.version>",
            "  --notes <text>       更新说明文本",
            "  --notes-file <path>  从文件读取更新说明",
          ].join("\n"),
        );
        process.exit(0);
      default:
        throw new Error(`未知参数 ${arg}（--help 查看用法）`);
    }
  }
  return opts;
}

function sha256File(absPath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(absPath));
  return hash.digest("hex");
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const version = String(pkg.version || "").trim();
  if (!version) {
    throw new Error("package.json 缺少有效的 version 字段");
  }

  const tagName = opts.tag.trim() || `v${version}`;
  let notes = opts.notes.trim();
  if (!notes && opts.notesFile) {
    notes = fs.readFileSync(path.resolve(ROOT, opts.notesFile), "utf8").trim();
  }

  const assets = {};
  let assetCount = 0;
  for (const item of CANDIDATE_ASSETS) {
    const absPath = path.resolve(ROOT, item.relPath);
    if (!fs.existsSync(absPath)) continue;
    const stat = fs.statSync(absPath);
    assets[item.key] = {
      name: item.name,
      url: `https://github.com/${REPO_SLUG}/releases/download/${encodeURIComponent(tagName)}/${item.name}`,
      size: stat.size,
      sha256: sha256File(absPath),
    };
    assetCount += 1;
  }

  if (assetCount === 0) {
    throw new Error("build/ 目录下未找到任何发布包（extension-chrome.zip / extension-firefox.zip / extension.crx）");
  }

  const manifest = {
    version,
    tagName,
    name: tagName,
    publishedAt: new Date().toISOString(),
    releaseUrl: `https://github.com/${REPO_SLUG}/releases/tag/${encodeURIComponent(tagName)}`,
    notes,
    assets,
  };

  const outPath = path.resolve(ROOT, opts.out);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  console.log(`✓ 已生成更新清单：${opts.out}（${tagName}，收录 ${assetCount} 个发布包）`);
  for (const [key, info] of Object.entries(assets)) {
    console.log(
      `  - ${key}: ${info.name} (${(info.size / 1024 / 1024).toFixed(2)} MB, sha256=${info.sha256.slice(0, 12)}…)`,
    );
  }
}

try {
  main();
} catch (error) {
  console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
