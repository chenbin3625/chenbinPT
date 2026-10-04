// 静态审计：模板里给 antd 组件 (a-*) 绑定的事件，antd 是否真的会 emit / 接收
// 数据来源：node_modules/ant-design-vue/es 下每个组件的 name / emit() / onXxx prop
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, relative } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const SRC = join(ROOT, "src");
const ANTD = join(ROOT, "node_modules/ant-design-vue/es");

function walk(dir, filter, out = []) {
  for (const n of readdirSync(dir)) {
    const f = join(dir, n);
    if (statSync(f).isDirectory()) walk(f, filter, out);
    else if (filter(f)) out.push(f);
  }
  return out;
}

// ── 1. 收集 antd 组件：name -> 已知事件集合 ─────────────────────────────
const compEvents = new Map(); // 'AButton' -> Set(events)
const antdFiles = walk(ANTD, (f) => f.endsWith(".js"));
for (const f of antdFiles) {
  const t = readFileSync(f, "utf8");
  const names = [...t.matchAll(/\bname:\s*['"](A[A-Za-z0-9]+)['"]/g)].map((m) => m[1]);
  if (names.length === 0) continue;
  const events = new Set();
  for (const m of t.matchAll(/\bemit\(\s*['"]([\w:-]+)['"]/g)) events.add(m[1]);
  // antd 常把事件写成 prop：'onUpdate:checked': { type: Function } / onChange: { ... }
  for (const m of t.matchAll(/['"]?on([A-Z][\w]*|Update:[\w-]+)['"]?\s*:\s*\{/g)) {
    const raw = m[1];
    if (raw.startsWith("Update:")) events.add("update:" + raw.slice(7));
    else events.add(raw[0].toLowerCase() + raw.slice(1));
  }
  for (const nm of names) {
    if (!compEvents.has(nm)) compEvents.set(nm, new Set());
    for (const e of events) compEvents.get(nm).add(e);
  }
}
// 组件目录内的子文件（如 typography/Text.js）事件也并入
for (const nm of [...compEvents.keys()]) {
  for (const f of antdFiles) {
    if (!f.includes("/" + nm.replace(/^A/, "").replace(/([A-Z])/g, (c) => "-" + c.toLowerCase()).replace(/^-/, "") + "/")) continue;
    const t = readFileSync(f, "utf8");
    for (const m of t.matchAll(/\bemit\(\s*['"]([\w:-]+)['"]/g)) compEvents.get(nm).add(m[1]);
  }
}

const NATIVE = new Set(["click", "dblclick", "change", "input", "focus", "blur", "keydown", "keyup", "keypress", "mousedown", "mouseup", "mouseenter", "mouseleave", "mouseover", "mouseout", "mousemove", "contextmenu", "scroll", "submit", "reset", "load", "error", "touchstart", "touchend", "pointerdown", "pointerup", "paste", "copy", "cut", "wheel", "drag", "dragstart", "dragend", "drop", "animationend", "transitionend"]);
const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
const pascal = (s) => camel(s).replace(/^./, (c) => c.toUpperCase());

const vueFiles = walk(SRC, (f) => f.endsWith(".vue"));
const problems = [];
const seen = new Map();
for (const f of vueFiles) {
  const t = readFileSync(f, "utf8");
  const tpl = t.slice(t.indexOf("<template>"));
  const re = /<(a-[a-z0-9-]+)\b/g;
  let m;
  while ((m = re.exec(tpl))) {
    let i = re.lastIndex, q = null;
    for (; i < tpl.length; i++) { const c = tpl[i]; if (q) { if (c === q) q = null; continue; } if (c === '"' || c === "'") q = c; else if (c === ">") break; }
    const attrs = tpl.slice(re.lastIndex, i);
    re.lastIndex = i;
    const tag = m[1];
    const comp = "A" + pascal(tag.slice(2));
    const known = compEvents.get(comp);
    const line = t.slice(0, m.index).split("\n").length;
    for (const e of attrs.matchAll(/@([\w:-]+)\s*=/g)) {
      const ev = e[1];
      if (NATIVE.has(ev)) continue;
      const evCamel = camel(ev);
      if (known && (known.has(evCamel) || known.has(ev))) continue;
      // 未收录该组件（映射不到 name）时只报「有名字但事件对不上」的
      if (!known) continue;
      const key = `${tag}@${ev}`;
      if (!seen.has(key)) seen.set(key, { comp, known: [...known].slice(0, 12), hits: [] });
      seen.get(key).hits.push(`${relative(ROOT, f)}:${line}`);
    }
  }
}
console.log(`antd 组件事件表: ${compEvents.size} 个组件`);
console.log(`可能永不触发的绑定: ${[...seen.values()].reduce((a, b) => a + b.hits.length, 0)} 处 / ${seen.size} 种组合\n`);
for (const [k, v] of [...seen.entries()].sort((a, b) => b[1].hits.length - a[1].hits.length)) {
  console.log(`### ${k}  (${v.hits.length} 处)  —— 该组件声明的事件: ${v.known.join(", ")}`);
  for (const h of v.hits.slice(0, 8)) console.log(`    ${h}`);
  if (v.hits.length > 8) console.log(`    … 其余 ${v.hits.length - 8} 处`);
}
