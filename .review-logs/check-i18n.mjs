// 扫描所有 t("key") 调用，检查 key 是否在 zh_CN / en 语言包里
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, relative } from "node:path";
const ROOT = resolve(import.meta.dirname, "..");
const SRC = join(ROOT, "src");
function walk(d, out = []) { for (const n of readdirSync(d)) { const f = join(d, n); if (statSync(f).isDirectory()) walk(f, out); else if (/\.(vue|ts|mts)$/.test(f)) out.push(f); } return out; }
const zh = JSON.parse(readFileSync(join(SRC, "locales/zh_CN.json"), "utf8"));
const en = JSON.parse(readFileSync(join(SRC, "locales/en.json"), "utf8"));
const dig = (o, p) => p.split(".").reduce((a, k) => (a == null ? undefined : a[k]), o);
const used = new Map();
for (const f of walk(SRC)) {
  const t = readFileSync(f, "utf8");
  t.split("\n").forEach((line, i) => {
    if (/^\s*(\/\/|\*|<!--)/.test(line)) return;
    for (const m of line.matchAll(/\bt\(\s*["'`]([A-Za-z0-9_.\-[\]]+)["'`]/g)) {
      const k = m[1];
      if (!used.has(k)) used.set(k, []);
      used.get(k).push(`${relative(ROOT, f)}:${i + 1}`);
    }
  });
}
const missingZh = [], missingEn = [], missingBoth = [];
for (const [k, locs] of used) {
  const a = dig(zh, k) !== undefined, b = dig(en, k) !== undefined;
  if (!a && !b) missingBoth.push([k, locs[0]]);
  else if (!a) missingZh.push([k, locs[0]]);
  else if (!b) missingEn.push([k, locs[0]]);
}
console.log(`引用到的 key 总数: ${used.size}`);
console.log(`\n[两种语言都缺] ${missingBoth.length} 个:`);
for (const [k, l] of missingBoth) console.log(`  ${k}   (${l})`);
console.log(`\n[仅 zh_CN 缺] ${missingZh.length} 个:`);
for (const [k, l] of missingZh.slice(0, 40)) console.log(`  ${k}   (${l})`);
console.log(`\n[仅 en 缺] ${missingEn.length} 个:`);
for (const [k, l] of missingEn.slice(0, 40)) console.log(`  ${k}   (${l})`);
