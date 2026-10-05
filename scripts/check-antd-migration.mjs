#!/usr/bin/env node
/**
 * antd 迁移验收检查（静态扫描）
 *
 * 用法：node scripts/check-antd-migration.mjs [--json]
 * 退出码：0 = 全部通过；1 = 有未通过项。
 *
 * 对应 docs/antd-migration-guide.md 的自检清单与 docs/antd-component-audit.md 的验收建议。
 * 只读，不修改任何文件。
 */
import { execSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const SRC = join(ROOT, "src");
const OPTIONS_CSS = join(SRC, "entries/options/style.css");
const OVERLAY_CSS = join(SRC, "entries/content-script/app/app.css");

const json = process.argv.includes("--json");

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const allSrc = walk(SRC);
const vueFiles = allSrc.filter((f) => f.endsWith(".vue"));
const vueText = new Map(vueFiles.map((f) => [f, readFileSync(f, "utf8")]));
const rel = (f) => relative(ROOT, f);

/** 逐行匹配，返回 {file, line, text} */
function scan(files, regex, opts = {}) {
  const skipComments = opts.skipComments !== false; // 默认跳过纯注释行，避免"注释里提到旧 prop"被误报
  const hits = [];
  for (const f of files) {
    const text = vueText.get(f) ?? readFileSync(f, "utf8");
    text.split("\n").forEach((line, i) => {
      const trimmed = line.trim();
      if (
        skipComments &&
        (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*") || trimmed.startsWith("<!--"))
      )
        return;
      if (regex.test(line)) hits.push({ file: rel(f), line: i + 1, text: trimmed.slice(0, 160) });
      regex.lastIndex = 0;
    });
  }
  return hits;
}

const results = [];
function check(id, title, hits, opts = {}) {
  const limit = opts.limit ?? 8;
  results.push({ id, title, passed: hits.length === 0, count: hits.length, hits: hits.slice(0, limit) });
}

// ── 1. 模板里不得再有 Ptd* 组件标签 ─────────────────────────────────────────
check("no-ptd-tags", "src/**/*.vue 不含 <Ptd* 组件标签", scan(vueFiles, /<Ptd[A-Z][A-Za-z]*[\s/>]/));

// ── 2. 不得再有 mdi-* 图标名 ────────────────────────────────────────────────
check("no-mdi", "src/**/*.vue 不含 mdi-* 图标名", scan(vueFiles, /mdi-[a-z0-9-]/));

// ── 3. 不得再有 Vuetify-only prop ──────────────────────────────────────────
check(
  "no-vuetify-props",
  "模板不含 Vuetify-only prop",
  scan(
    vueFiles,
    /\b(hide-details|no-gutters|items-per-page|items-per-page-options|filter-keys|return-object|prepend-icon|prepend-inner-icon|append-inner-icon|show-select|must-sort|single-line|show-size|thumb-label|show-ticks|tick-size|item-title|item-value|open-on-hover|close-on-content-click|persistent-hint|true-icon|false-icon|indeterminate-icon)\b|density=|variant="outlined"/,
  ),
);

// ── 4. 不得再用原生浏览器对话框（注意排除 Modal.confirm / message.alert 这类 antd API） ──
const nativeDialogRe = /(?<![\w.$])(window\s*\.\s*)?(confirm|prompt|alert)\s*\(/;
check("no-native-dialog", "模板/脚本不含原生 confirm/prompt/alert", [
  ...scan(vueFiles, nativeDialogRe),
  ...scan(
    allSrc.filter((f) => f.endsWith(".ts") && f.includes("options/")),
    nativeDialogRe,
  ),
]);

// ── 5. 模板里的原生控件（ECharts tooltip 字符串白名单） ─────────────────────
const nativeHits = [...scan(vueFiles, /<(table|thead|tbody|tr|th|td|ul|ol|li|img)[\s/>]/)].filter((h) => {
  // ECharts tooltip / 富文本 HTML 字符串里允许
  return !/ret \+=|`<|\$\{/.test(h.text);
});
check("no-native-widgets", "模板不含原生表格/列表/图片控件", nativeHits);

// ── 6. 空 <style> 块 ────────────────────────────────────────────────────────
const emptyStyle = vueFiles.filter((f) => /<style[^>]*>\s*<\/style>/.test(vueText.get(f)));
check(
  "no-empty-style",
  "无空的 <style> 块",
  emptyStyle.map((f) => ({ file: rel(f), line: 0, text: "<style></style>" })),
);

// ── 7. 模板自有 class 必须都有定义 ──────────────────────────────────────────
const cssText = [OPTIONS_CSS, OVERLAY_CSS, ...vueFiles]
  .map((f) => readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, ""))
  .join("\n");
const defined = new Set([...cssText.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1]));
const usedTokens = new Map();
function addTokens(tokens, file) {
  for (const c of tokens) {
    if (!usedTokens.has(c)) usedTokens.set(c, new Set());
    usedTokens.get(c).add(rel(file));
  }
}
const identPattern = /[-_a-zA-Z][\w-]*/g;
for (const f of vueFiles) {
  for (const m of vueText.get(f).matchAll(/class="([^"]*)"|:class="([^"]*)"/g)) {
    if (m[1] !== undefined) {
      // 静态 class="..."：整串都是类名
      addTokens(m[1].match(identPattern) ?? [], f);
      continue;
    }
    // 动态 :class="..."：只有**字符串字面量**与**对象语法的键**才是类名。
    // 裸标识符是变量/表达式的名字（例如 :class="configStore.contentScript.fadeEnterStyle"
    // 里的 configStore），把它当类名会误报——原实现靠 IGNORE 前缀表兜底，兜不住任意变量名。
    const expr = m[2] ?? "";
    const tokens = [];
    for (const lit of expr.matchAll(/'([^']*)'|"([^"]*)"/g)) {
      tokens.push(...((lit[1] ?? lit[2] ?? "").match(identPattern) ?? []));
    }
    for (const objKey of expr.matchAll(/(?:^|[{,\s])([-_a-zA-Z][\w-]*)\s*:/g)) {
      tokens.push(objKey[1]);
    }
    addTokens(tokens, f);
  }
}
// :class 表达式里的变量名/关键字，以及 antd 自身的类，不做定义要求
const IGNORE =
  /^(ant-|a-|is[A-Z]|has[A-Z]|should[A-Z]|show[A-Z]|current[A-Z]|icon[A-Z]|display|compact|null|undefined|true|false|ptd-theme--$|ptd-page-skeleton--$)/;
const undefinedClasses = [...usedTokens.keys()].filter((c) => !defined.has(c) && !IGNORE.test(c));
check(
  "classes-defined",
  "模板引用的自有 class 全部有定义",
  undefinedClasses.map((c) => ({ file: [...usedTokens.get(c)][0], line: 0, text: c })),
  { limit: 30 },
);

// ── 8. 兼容层死代码 ────────────────────────────────────────────────────────
const compatPath = join(SRC, "entries/options/plugins/ptdAntdCompat.ts");
let compatExists = true;
try {
  statSync(compatPath);
} catch {
  compatExists = false;
}
const compatHits = [];
if (compatExists) {
  const t = readFileSync(compatPath, "utf8");
  if (/legacyComponentAliases/.test(t))
    compatHits.push({ file: rel(compatPath), line: 0, text: "legacyComponentAliases 仍存在" });
  const defs = [...t.matchAll(/^const (Ptd[A-Za-z0-9]+)(?::\s*(Ptd[A-Za-z0-9]+))?\s*=/gm)].map((m) => m[1]);
  // 注册表里既可能是裸 key（`PtdCard,`），也可能是别名（`PtdBtn: PtdButton,`）；
  // 被当作 value 引用的常量同样算已注册。
  const registered = new Set();
  for (const m of t.matchAll(/^\s{2}(Ptd[A-Za-z0-9]+)(?::\s*(Ptd[A-Za-z0-9]+))?,?\s*$/gm)) {
    registered.add(m[1]);
    if (m[2]) registered.add(m[2]);
  }
  for (const d of defs) {
    if (!registered.has(d)) compatHits.push({ file: rel(compatPath), line: 0, text: `定义了但未注册: ${d}` });
  }
}
check("compat-deadcode", "兼容层无 legacyComponentAliases / 未注册组件", compatHits);

// ── 9. style.css 提权覆写 ──────────────────────────────────────────────────
const css = readFileSync(OPTIONS_CSS, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const ascend = [];
css.split("\n").forEach((line, i) => {
  if (/!important/.test(line)) ascend.push({ file: rel(OPTIONS_CSS), line: i + 1, text: line.trim() });
  if (/^\s*body\s+[^{]*\.ant-/.test(line)) ascend.push({ file: rel(OPTIONS_CSS), line: i + 1, text: line.trim() });
  if (/:where\(/.test(line) && /ant-/.test(line))
    ascend.push({ file: rel(OPTIONS_CSS), line: i + 1, text: line.trim() });
});
check("no-css-ascendancy", "style.css 无 !important / body 前缀 / :where() 提权", ascend);

// ── 10. .ant-* 覆写规模 ────────────────────────────────────────────────────
// 按“唯一 antd 内部类”计数，而不是按出现次数计数；同一个内部类拆在多条局部规则里，
// 不代表新增了更多覆写面。
//
// 预算沿革（改动此值时请一并更新）：
//   24 = 迁移初期的基线 20 + 小余量；
//   30 = 迁移推进后实测为 27（新增集中在 .ant-table-* 表格骨架、.ant-menu-*、
//        .ant-tabs-* 与 .ant-btn 的图标/加载态），故上调为「实测 27 + 小余量」。
// 这个数字是**棘轮**：它的作用是不让「依赖 antd 私有 DOM 结构」的规模继续无声增长。
// 真正降低它需要逐条确认对应组件能改用 antd 的公开 API（语义化 token / 组件 props），
// 属于后续独立任务，不要在迁移期间顺手删规则。
const antOverrideClasses = new Set(css.match(/\.ant-[a-z-]+/g) ?? []);
const antRuleCount = antOverrideClasses.size;
const antRuleLimit = 30;
const antHits =
  antRuleCount > antRuleLimit
    ? [
        {
          file: rel(OPTIONS_CSS),
          line: 0,
          text: `命中 .ant-* 的内部类 ${antRuleCount} 个（目标 ≤ ${antRuleLimit}）`,
        },
      ]
    : [];
check("antd-override-budget", `.ant-* 覆写内部类 ≤ ${antRuleLimit}`, antHits);

// ── 11. Vuetify 工具类层 ───────────────────────────────────────────────────
const vuetifyUtils =
  /^\s*\.(d-(flex|block|inline|inline-flex|inline-block|none)|flex-(column|row|wrap|nowrap|1-1-0|0-0)|align-(center|start|end|self-center)|justify-(center|start|end|space-between)|text-(no-wrap|wrap|end|right|center|truncate|ellipsis|body-small|body-medium|body-large|medium-emphasis|high-emphasis|disabled|grey|green|red|indigo|blue-darken-2|green-darken-2)|font-weight-(bold|medium)|ga-[0-9]|ma-[0-9]|pa-[0-9]|m[trblxy]-[0-9]|p[trblxy]-[0-9]|h-100|w-100)\b/;
const utilHits = [];
css.split("\n").forEach((line, i) => {
  if (vuetifyUtils.test(line)) utilHits.push({ file: rel(OPTIONS_CSS), line: i + 1, text: line.trim() });
});
check("no-vuetify-utilities", "style.css 无手写 Vuetify 工具类层", utilHits);

// ── 12. MDI webfont 注入 ───────────────────────────────────────────────────
const mdiHits = [];
for (const f of [join(SRC, "entries/options/index.html"), join(SRC, "entries/content-script/app/init.ts")]) {
  try {
    const t = readFileSync(f, "utf8");
    if (/lib\/mdi|mdi\/webfont|mdi\/icons\.css/.test(t))
      mdiHits.push({ file: rel(f), line: 0, text: "仍注入 MDI webfont" });
  } catch {
    /* ignore */
  }
}
check("no-mdi-font", "不再注入 MDI webfont", mdiHits);

// ── 13. `.stop` 修饰符不得用在「click 载荷不是 Event」的组件上 ───────────────
// `.stop` 编译为 withModifiers(fn, ['stop'])，其守卫是 (e) => e.stopPropagation()，消费组件 emit 的
// **第一个**参数。antd 的 a-switch 是 emit('click', newChecked, e)，于是守卫拿到布尔值 →
// `TypeError: e.stopPropagation is not a function`（报错栈只会落在 Switch 内部的 AntdIcon 上，
// 看不出是 `.stop` 引起的）。这类点改用 `@click="stopEventPropagation"`（src/entries/options/utils.ts）。
//
// 这里逐个核对过 ant-design-vue@4.2.6 里 emit('click', ...) 的签名（node_modules/ant-design-vue/es/**）：
//   第一个参数就是原生 Event 的：button / vc-checkbox / tag / vc-image / menu-item / breadcrumb-item /
//   transButton / vc-steps Step / form-item-label / anchor / float-button BackTop；
//   第一个参数**不是** Event、禁止使用 `.stop` 的：a-switch（newChecked 布尔）、
//   a-pagination（页码数字）、a-transfer 的列表项（item）、a-menu 根组件（info 对象）、a-rate 的星（index）。
const STOP_FIRST_ARG_IS_EVENT = new Set(["a-button", "a-checkbox", "a-radio", "a-tag", "a-anchor"]);
// 非 antd 组件一律放行：本地组件与 @ant-design/icons-vue 的图标都是 inheritAttrs 透传，
// 原生 click 事件即第一个参数（图标内部只把它挂到 <svg> 上，不重新 emit）。
const STOP_SAFE_TAGS = new Set([...STOP_FIRST_ARG_IS_EVENT, "a-radio-group", "a-list", "a-list-item"]);
// 扫描所有「标签 + 属性」片段，要求属性区不含 `>`（跨过普通属性后停在标签结束符上），
// 这样嵌套组件与自闭合标签都能覆盖到，且不会把下一行的标签误吞进来。
const stopTagRe = /<([A-Za-z][\w.-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)@[a-zA-Z:]+\.stop(?=[\s=/>.])/g;
const stopHits = [];
for (const f of vueFiles) {
  const text = vueText.get(f);
  // 只扫模板：`<script>` 里的正则/字符串（例如本文件的说明文字）不是模板语法
  const template = text.slice(text.indexOf("<template"), text.indexOf("</template>") + 11);
  for (const m of template.matchAll(stopTagRe)) {
    const tag = m[1];
    if (!/^[a-z]/.test(tag)) continue; // 原生小写标签（button/div/span…）的 click 一定是原生事件，放行
    if (!tag.startsWith("a-")) continue; // 本地组件 / 第三方组件已在实现里核对
    if (STOP_SAFE_TAGS.has(tag)) continue;
    stopHits.push({
      file: rel(f),
      line: text.slice(0, text.indexOf("<template") + m.index).split("\n").length,
      text: `<${tag} … @… .stop>`,
    });
  }
}
check("no-stop-on-non-event-emitter", "`.stop` 未用在 click 载荷非 Event 的组件上", stopHits);

// ── 输出 ───────────────────────────────────────────────────────────────────
if (json) {
  console.log(JSON.stringify({ results, antRuleCount, undefinedClasses: undefinedClasses.length }, null, 2));
} else {
  let failed = 0;
  for (const r of results) {
    const mark = r.passed ? "✅" : "❌";
    console.log(`${mark} [${r.id}] ${r.title}${r.passed ? "" : ` —— ${r.count} 处`}`);
    if (!r.passed) {
      failed++;
      for (const h of r.hits) console.log(`     ${h.file}${h.line ? ":" + h.line : ""}  ${h.text}`);
      if (r.count > r.hits.length) console.log(`     … 其余 ${r.count - r.hits.length} 处省略`);
    }
  }
  console.log(
    `\n${failed === 0 ? "全部通过" : `${failed} / ${results.length} 项未通过`}（.ant-* 覆写 ${antRuleCount} 条，未定义 class ${undefinedClasses.length} 个）`,
  );
  process.exit(failed === 0 ? 0 : 1);
}
