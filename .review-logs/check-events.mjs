// 静态检查：父模板给自定义子组件绑定的事件，子组件是否真的会 emit（否则 handler 永不触发）
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const SRC = join(ROOT, "src");

function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    const f = join(dir, n);
    if (statSync(f).isDirectory()) walk(f, out);
    else if (f.endsWith(".vue")) out.push(f);
  }
  return out;
}
const files = walk(SRC);

/** 组件信息：emits 名称集合、props 名称集合、是否有多个根节点（fallthrough 是否可靠） */
const comps = new Map(); // 组件文件绝对路径 -> info
for (const f of files) {
  const t = readFileSync(f, "utf8");
  const emits = new Set();
  // defineEmits<{ (e: "x"): void; ... }>  或  defineEmits<{ x: [...] }>
  const de = t.match(/defineEmits<([\s\S]*?)>\s*\(/);
  if (de) {
    for (const m of de[1].matchAll(/\(\s*e\s*:\s*["']([^"']+)["']/g)) emits.add(m[1]);
    for (const m of de[1].matchAll(/^\s*["']?([\w:-]+)["']?\s*:/gm)) emits.add(m[1]);
  }
  for (const m of t.matchAll(/defineEmits\(\s*\[([^\]]*)\]/g)) {
    for (const s of m[1].matchAll(/["']([^"']+)["']/g)) emits.add(s[1]);
  }
  for (const m of t.matchAll(/\bemit\(\s*["']([^"']+)["']/g)) emits.add(m[1]);
  for (const m of t.matchAll(/\bemits\(\s*["']([^"']+)["']/g)) emits.add(m[1]);
  // defineModel('x') / defineModel<...>('x')
  for (const m of t.matchAll(/defineModel\s*(?:<[^>]*>)?\s*\(\s*(?:["']([^"']+)["'])?/g)) {
    const name = m[1] ?? "modelValue";
    emits.add(`update:${name}`);
  }
  comps.set(f, { emits, text: t });
}

const NATIVE = new Set([
  "click", "dblclick", "change", "input", "focus", "blur", "keydown", "keyup", "keypress", "mousedown",
  "mouseup", "mouseenter", "mouseleave", "mouseover", "mouseout", "mousemove", "contextmenu", "scroll",
  "submit", "reset", "load", "error", "touchstart", "touchend", "pointerdown", "pointerup", "paste", "copy",
  "cut", "wheel", "drag", "dragstart", "dragend", "dragover", "drop", "animationend", "transitionend",
]);

const problems = [];
for (const f of files) {
  const t = readFileSync(f, "utf8");
  const tpl = t.slice(t.indexOf("<template>"));
  // 本文件 import 的本地组件
  const imports = new Map();
  for (const m of t.matchAll(/import\s+(\w+)\s+from\s+["']([^"']+\.vue)["']/g)) {
    const spec = m[2].startsWith("@/") ? join(SRC, m[2].slice(2)) : resolve(dirname(f), m[2]);
    const target = spec;
    imports.set(m[1], target);
  }
  // 扫描标签：属性值里的箭头函数含 '>'，必须按引号状态找真正的结束 '>'
  function* tags(src) {
    const re = /<([A-Z][A-Za-z0-9]*)\b/g;
    let m;
    while ((m = re.exec(src))) {
      let i = re.lastIndex;
      let quote = null;
      for (; i < src.length; i++) {
        const c = src[i];
        if (quote) { if (c === quote) quote = null; continue; }
        if (c === '"' || c === "'") { quote = c; continue; }
        if (c === ">") break;
      }
      yield { tag: m[1], attrs: src.slice(re.lastIndex, i), index: m.index };
      re.lastIndex = i;
    }
  }
  for (const m of tags(tpl)) {
    const { tag, attrs } = m;
    if (/^(template|slot|component|Transition|KeepAlive|Suspense|Teleport)$/.test(tag)) continue;
    const target = imports.get(tag);
    if (!target) continue;
    const info = comps.get(target);
    if (!info) continue;
    const bound = [];
    for (const e of attrs.matchAll(/@([\w:-]+)\s*=/g)) bound.push(e[1]);
    for (const e of attrs.matchAll(/v-on:([\w:-]+)\s*=/g)) bound.push(e[1]);
    for (const name of bound) {
      if (NATIVE.has(name)) continue;
      const base = name.replace(/^update:/, "").replace(/^update:/, "");
      const candidates = [
        name,
        name.replace(/-([a-z])/g, (_, c) => c.toUpperCase()), // kebab -> camel
      ];
      if (name.startsWith("update:")) {
        candidates.push("update:" + base.replace(/-([a-z])/g, (_, c) => c.toUpperCase()));
      }
      const ok = candidates.some((c) => info.emits.has(c));
      if (!ok) {
        const line = t.slice(0, m.index).split("\n").length;
        problems.push({ file: relative(ROOT, f), line, tag, event: name, declared: [...info.emits].filter((x) => x.startsWith("update:") || /[A-Z]|-/.test(x)).slice(0, 30) });
      }
    }
  }
}

const byEvent = new Map();
for (const p of problems) {
  const k = `${p.tag}@${p.event}`;
  if (!byEvent.has(k)) byEvent.set(k, []);
  byEvent.get(k).push(p);
}
console.log(`可能永不触发的事件绑定：${problems.length} 处，涉及 ${byEvent.size} 种 (组件, 事件) 组合\n`);
for (const [k, list] of [...byEvent.entries()].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`### ${k}  —— ${list.length} 处`);
  for (const p of list.slice(0, 6)) console.log(`   ${p.file}:${p.line}`);
  if (list.length > 6) console.log(`   … 其余 ${list.length - 6} 处`);
  console.log(`   子组件声明的（部分）: ${list[0].declared.join(", ") || "(无)"}`);
}
