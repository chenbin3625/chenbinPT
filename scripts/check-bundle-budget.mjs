#!/usr/bin/env node
/**
 * 构建产物「完整性 + 体积预算」门禁
 *
 * 用法：
 *   node scripts/check-bundle-budget.mjs            # 检查 dist-chrome
 *   node scripts/check-bundle-budget.mjs --target=firefox
 *   node scripts/check-bundle-budget.mjs --report   # 只打印报表，不按预算判失败
 *
 * 退出码：0 = 通过；1 = 缺产物 或 超预算。
 * 只读，不修改任何文件。
 *
 * 为什么需要它：
 * 1) **缺产物**：构建中途失败或与其它构建进程争用同一 outDir 时，会出现
 *    「exit 0 但 options 页面 / cs-app.js 没生成」的半成品产物。这种包一旦发布，
 *    用户在浏览器里看到的就是「扩展装上了但点开是空白」。因此这里显式断言关键产物存在。
 * 2) **体积回归**：本项目刚做过一轮静态资产瘦身（dist 12MB → 8.5MB，图标 4.5MB → 1.7MB，
 *    MDI 字体 820KB → 28KB）。没有预算断言的话，这类收益会在几次迭代内悄悄流失。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { checkWarExposesNoScripts, checkWarWildcardsHaveMatches } from "./lib/war-coverage.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const TARGET = (args.find((a) => a.startsWith("--target="))?.split("=")[1] ?? "chrome").trim();
const REPORT_ONLY = args.includes("--report");
const DIST = join(ROOT, `dist-${TARGET}`);

/**
 * WXT 产物布局（src/entrypoints/* → dist-<target>/*）：
 * - background.js：chrome 是 service worker，firefox 是常驻 background script（含 offscreen 的处理函数）；
 * - content-scripts/content.js：manifest 注册、**每个页面**都会执行的轻量引导；
 * - content-scripts/cs-app.js：内容脚本 UI，由后台按需 `scripting.executeScript` 注入；
 * - options.html / offscreen.html（offscreen 仅 chrome）。
 * 后台脚本缺失时扩展能装上但**完全不能用**（比空白页更严重），因此都列为必需产物。
 */
const CONTENT_SCRIPT_BOOTSTRAP = "content-scripts/content.js";
const CONTENT_SCRIPT_APP = "content-scripts/cs-app.js";

/** 必须存在的关键产物（相对 dist-<target>）。缺任何一个都视为构建失败。 */
const REQUIRED_ARTIFACTS = [
  "manifest.json",
  "background.js",
  CONTENT_SCRIPT_BOOTSTRAP,
  CONTENT_SCRIPT_APP,
  "options.html",
  "offscreen.html",
  "_locales/en/messages.json",
  "_locales/zh_CN/messages.json",
  "lib/mdi/webfont.woff2",
  // 图标只在 manifest 里被引用，缺了不影响功能但会破坏商店/工具栏展示，单列一项做最低限度守护
  "icons/logo/128.png",
];

/**
 * 体积预算（KB，**实际字节和**，不是 `du` 的磁盘占用——后者会因块对齐明显偏大）。
 * 取值 = 当前实测值 + 约 10~30% 余量，避免正常的代码增长就把 CI 打红，
 * 同时又能拦住「把 4.5MB 图标加回来」这种量级的回归。
 *
 * WXT 迁移后的口径变化：内容脚本 UI（cs-app.js）是自包含的 IIFE（Vue + antd + 全部站点定义，
 * 站点定义按需惰性初始化），不再与管理页共享 chunk，因此 total 比旧构建大约 3MB。
 * `content-bootstrap` 单列：它在**每个页面**都会执行，必须保持轻量。
 */
const BUDGETS_KB_BY_TARGET = {
  chrome: {
    total: 10752, // 实测 ~9180（8.97 MB）
    icons: 1536, // 实测 ~1114
    "lib/mdi": 24, // 实测 11（子集化 webfont，icons.css/fontface.css 已随 DOM 侧 MDI 图标退役删除）
    "content-bootstrap": 32, // 实测 ~15（content-scripts/content.js）
    "largest-js-chunk": 3584, // 实测 ~3030（content-scripts/cs-app.js）
  },
  firefox: {
    // Firefox 使用 background script，不能像 Chrome MV3 一样把下载/站点逻辑放到 offscreen 页面里分摊。
    total: 12800, // 实测 ~11040（10.78 MB）
    icons: 1536, // 实测 ~1114
    "lib/mdi": 24, // 实测 11（子集化 webfont，icons.css/fontface.css 已随 DOM 侧 MDI 图标退役删除）
    "content-bootstrap": 32, // 实测 ~15（content-scripts/content.js）
    "largest-js-chunk": 3584, // 实测 ~3030（content-scripts/cs-app.js；background.js ~2080）
  },
};

const BUDGETS_KB = BUDGETS_KB_BY_TARGET[TARGET] ?? BUDGETS_KB_BY_TARGET.chrome;

function dirSize(p) {
  let total = 0;
  const stack = [p];
  while (stack.length) {
    const cur = stack.pop();
    for (const entry of readdirSync(cur, { withFileTypes: true })) {
      const full = join(cur, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) total += statSync(full).size;
    }
  }
  return total;
}

function largestJsChunk(p) {
  let max = { size: 0, path: "" };
  const stack = [p];
  while (stack.length) {
    const cur = stack.pop();
    for (const entry of readdirSync(cur, { withFileTypes: true })) {
      const full = join(cur, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name.endsWith(".js")) {
        const size = statSync(full).size;
        if (size > max.size) max = { size, path: relative(p, full) };
      }
    }
  }
  return max;
}

/** 列出产物目录内所有文件的相对路径（POSIX 分隔符，供 WAR 通配符校验用） */
function listAllFiles(p) {
  const out = [];
  const stack = [p];
  while (stack.length) {
    const cur = stack.pop();
    for (const entry of readdirSync(cur, { withFileTypes: true })) {
      const full = join(cur, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) out.push(relative(p, full).split(/[\\/]/).join("/"));
    }
  }
  return out;
}

if (!existsSync(DIST)) {
  console.error(
    `✗ 找不到构建产物目录：${relative(ROOT, DIST)}（先跑 npm run build:dist${TARGET === "firefox" ? "-firefox" : ""}）`,
  );
  process.exit(1);
}

const failures = [];

// ---- 1. 产物完整性 ----
const missing = REQUIRED_ARTIFACTS.filter((f) => !existsSync(join(DIST, f)));
// firefox 构建没有 offscreen 页面（manifest 只对 chrome 注册 offscreen 权限）
const exempted = TARGET === "firefox" ? missing.filter((f) => f.includes("offscreen")) : [];
const stillMissing = missing.filter((f) => !exempted.includes(f));
if (stillMissing.length) {
  failures.push(`缺少关键产物 ${stillMissing.length} 个：\n    - ${stillMissing.join("\n    - ")}`);
}

// ---- 1b. WAR 收窄（G3 / G16，WXT 迁移后）----
// 内容脚本 UI 由后台 scripting.executeScript 注入、样式内联，WAR 只应保留页面直接引用的静态资源。
// 1) 每个模式都要真实匹配到产物；2) 不得暴露任何 .js / .html（防止回退到「把 chunk 暴露给网页」）；
// 3) 内容脚本 UI 不能被写进 manifest 的 content_scripts（否则每个页面都会执行 3MB 的脚本）。
let warWildcardProblems = [];
if (existsSync(join(DIST, "manifest.json"))) {
  const manifestForWar = JSON.parse(readFileSync(join(DIST, "manifest.json"), "utf8"));
  const distFiles = listAllFiles(DIST);
  warWildcardProblems = checkWarWildcardsHaveMatches(manifestForWar, () => distFiles);
  if (warWildcardProblems.length) {
    failures.push(`WAR 通配符没有匹配到产物：\n    - ${warWildcardProblems.join("\n    - ")}`);
  }
  const warScriptProblems = checkWarExposesNoScripts(manifestForWar, () => distFiles);
  if (warScriptProblems.length) {
    failures.push(`WAR 暴露了脚本/页面：\n    - ${warScriptProblems.join("\n    - ")}`);
  }

  // WAR 的 `use_dynamic_url` 是 Chrome 特性（task-12 / P2-8）：
  // - chrome 必须保留（icons/lib 用动态 URL 降低指纹面）；
  // - firefox 必须剥离（Firefox 不生成 dynamic URL，未知属性只会产生 AMO/manifest 警告）。
  const warEntries = manifestForWar.web_accessible_resources ?? [];
  const dynamicUrlEntries = warEntries.filter((entry) => entry?.use_dynamic_url === true);
  if (TARGET === "firefox" && dynamicUrlEntries.length > 0) {
    failures.push(
      `firefox manifest 含 use_dynamic_url（应剥离，Firefox 不支持 Chrome dynamic URL）：` +
        dynamicUrlEntries.flatMap((entry) => entry.resources ?? []).join(", "),
    );
  }
  if (TARGET === "chrome" && warEntries.some((entry) => entry?.use_dynamic_url !== true)) {
    failures.push("chrome manifest 的 WAR 条目必须全部使用 use_dynamic_url（降低指纹面）");
  }

  const manifestContentScripts = (manifestForWar.content_scripts ?? []).flatMap((entry) => entry.js ?? []);
  if (manifestContentScripts.includes(CONTENT_SCRIPT_APP)) {
    failures.push(`${CONTENT_SCRIPT_APP} 不应出现在 manifest.content_scripts（应由后台按需注入）`);
  }
  if (!manifestContentScripts.includes(CONTENT_SCRIPT_BOOTSTRAP)) {
    failures.push(`manifest.content_scripts 缺少引导脚本 ${CONTENT_SCRIPT_BOOTSTRAP}`);
  }
  if (!(manifestForWar.permissions ?? []).includes("scripting")) {
    failures.push("manifest 缺少 scripting 权限（后台无法注入内容脚本 UI）");
  }
}

// ---- 2. 体积预算 ----
const measured = {
  total: dirSize(DIST),
  icons: existsSync(join(DIST, "icons")) ? dirSize(join(DIST, "icons")) : 0,
  "lib/mdi": existsSync(join(DIST, "lib/mdi")) ? dirSize(join(DIST, "lib/mdi")) : 0,
  "content-bootstrap": existsSync(join(DIST, CONTENT_SCRIPT_BOOTSTRAP))
    ? statSync(join(DIST, CONTENT_SCRIPT_BOOTSTRAP)).size
    : 0,
};
const chunk = largestJsChunk(DIST);
measured["largest-js-chunk"] = chunk.size;

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
const mb = (n) => `${(n / 1048576).toFixed(2)} MB`;

console.log(`构建产物检查：dist-${TARGET}`);
console.log("─".repeat(64));
for (const [key, budgetKb] of Object.entries(BUDGETS_KB)) {
  const actual = measured[key];
  const over = actual > budgetKb * 1024;
  const label = key === "largest-js-chunk" ? `${key} (${chunk.path})` : key;
  const shown = key === "total" ? mb(actual) : kb(actual);
  console.log(`${over ? "✗" : "✓"} ${label.padEnd(34)} ${shown.padStart(10)}  / 预算 ${kb(budgetKb * 1024)}`);
  if (over) failures.push(`${key} 超预算：${shown} > ${kb(budgetKb * 1024)}`);
}
console.log("─".repeat(64));
// 只统计「本目标真正要求」的产物：被豁免的（firefox 的 offscreen）既不该计入分母，
// 也不该被算作「就位」——原实现把它从 stillMissing 里剔除后仍用 REQUIRED_ARTIFACTS.length
// 作分母，于是 firefox 实际 9/10 却打印 10/10。
const requiredForTarget = REQUIRED_ARTIFACTS.length - exempted.length;
const presentForTarget = requiredForTarget - stillMissing.length;
console.log(
  `关键产物：${presentForTarget}/${requiredForTarget} 就位` +
    (exempted.length ? `（${TARGET} 目标豁免：${exempted.join(", ")}）` : ""),
);

if (failures.length) {
  console.error("\n✗ 构建产物检查未通过：");
  for (const f of failures) console.error(`  - ${f}`);
  if (REPORT_ONLY) {
    console.error("（--report 模式：仅报告，不判失败）");
    process.exit(0);
  }
  process.exit(1);
}

console.log("\n✓ 构建产物完整且未超预算");
