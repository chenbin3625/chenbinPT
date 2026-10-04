// 校验 dist 产物完整性：HTML/JS 里引用的资源是否都存在
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve, relative } from "node:path";
const DIST = resolve(process.argv[2]);
function walk(d, o = []) { for (const n of readdirSync(d)) { const f = join(d, n); statSync(f).isDirectory() ? walk(f, o) : o.push(f); } return o; }
if (!existsSync(DIST)) { console.log("DIST 不存在:", DIST); process.exit(0); }
const all = walk(DIST);
const files = new Set(all.map((f) => "/" + relative(DIST, f)));
const refs = new Map();
for (const f of all) {
  if (!/\.(js|html|css)$/.test(f)) continue;
  const t = readFileSync(f, "utf8");
  for (const m of t.matchAll(/["'(]((?:\/)?(?:assets|vendor|lib|icons)\/[A-Za-z0-9_@./-]+\.(?:js|css|png|woff2|ico))["')]/g)) {
    const p = m[1].startsWith("/") ? m[1] : "/" + m[1];
    if (!refs.has(p)) refs.set(p, new Set());
    refs.get(p).add(relative(DIST, f));
  }
}
const missing = [...refs.keys()].filter((p) => !files.has(p) && !existsSync(join(DIST, p.slice(1))));
console.log(`${DIST}`);
console.log(`  文件数 ${all.length}，被引用的资源 ${refs.size} 个，缺失 ${missing.length} 个`);
for (const m of missing.slice(0, 25)) console.log(`  缺失: ${m}  <- ${[...refs.get(m)].slice(0, 3).join(", ")}`);
// 未被任何文件引用的 assets（孤儿 chunk 不算问题，仅提示）
const orphans = all.filter((f) => relative(DIST, f).startsWith("assets/") && !refs.has("/" + relative(DIST, f)));
console.log(`  assets 下未被直接引用（可能是动态 import，正常）: ${orphans.length}`);
