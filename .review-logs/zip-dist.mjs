// 本地等价于 CI 的 webext-buildtools-pack-extension-dir-action：
// 把 dist-<target> 打成 zip（相对路径、跳过 .DS_Store、DEFLATE level 9），
// 与 scripts/pack-crx.mjs 内部生成 CRX 载荷的口径保持一致。
// 用法: node .review-logs/zip-dist.mjs <distDir> <outZip>
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import JSZip from "jszip";

const SKIP = new Set([".DS_Store", "Thumbs.db"]);

function listFiles(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (SKIP.has(entry.name) || entry.name.startsWith("._")) continue;
    if (entry.isDirectory()) out.push(...listFiles(abs, base));
    else if (entry.isFile()) out.push({ abs, rel: path.relative(base, abs).split(path.sep).join("/") });
  }
  return out;
}

const [, , distDir, outZip] = process.argv;
const abs = path.resolve(distDir);
if (!fs.existsSync(path.join(abs, "manifest.json"))) throw new Error(`${distDir} 下没有 manifest.json`);

const zip = new JSZip();
const files = listFiles(abs).sort((a, b) => (a.rel < b.rel ? -1 : 1));
for (const f of files) {
  zip.file(f.rel, fs.readFileSync(f.abs), { date: fs.statSync(f.abs).mtime, createFolders: false });
}
const buf = await zip.generateAsync({
  type: "nodebuffer",
  compression: "DEFLATE",
  compressionOptions: { level: 9 },
  platform: "UNIX",
});
fs.mkdirSync(path.dirname(path.resolve(outZip)), { recursive: true });
fs.writeFileSync(path.resolve(outZip), buf);
console.log(`${outZip}: ${files.length} files, ${(buf.length / 1024 / 1024).toFixed(2)} MB`);
