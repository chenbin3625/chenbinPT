// 强校验：解析 JS 中的动态/静态 import 路径，检查 chunk 是否齐全
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve, relative, dirname } from "node:path";
const DIST = resolve(process.argv[2]);
function walk(d, o = []) { for (const n of readdirSync(d)) { const f = join(d, n); statSync(f).isDirectory() ? walk(f, o) : o.push(f); } return o; }
if (!existsSync(DIST)) { console.log("不存在:", DIST); process.exit(0); }
const all = walk(DIST).filter((f) => /\.(js|html|css)$/.test(f));
const missing = new Map();
for (const f of all) {
  const t = readFileSync(f, "utf8");
  const pats = [/import\(\s*["']([^"']+\.js)["']\s*\)/g, /from\s*["']([^"']+\.js)["']/g, /(?:src|href)="([^"]+\.(?:js|css))"/g, /new URL\(\s*["']([^"']+)["']/g];
  for (const re of pats) {
    for (const m of t.matchAll(re)) {
      let p = m[1];
      if (/^(https?:|data:|chrome-extension:)/.test(p)) continue;
      const abs = p.startsWith("/") ? join(DIST, p) : resolve(dirname(f), p);
      if (!existsSync(abs)) { if (!missing.has(p)) missing.set(p, new Set()); missing.get(p).add(relative(DIST, f)); }
    }
  }
}
console.log(`${relative(process.cwd(), DIST)}: 扫描 ${all.length} 个文件，缺失引用 ${missing.size} 个`);
for (const [p, src] of [...missing].slice(0, 30)) console.log(`  缺失 ${p}  <- ${[...src].slice(0, 2).join(", ")}`);
