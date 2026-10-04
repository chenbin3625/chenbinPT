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
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const TARGET = (args.find((a) => a.startsWith("--target="))?.split("=")[1] ?? "chrome").trim();
const REPORT_ONLY = args.includes("--report");
const DIST = join(ROOT, `dist-${TARGET}`);

/**
 * 后台入口的产物名按目标不同：
 * - chrome（MV3）：`background.service_worker: src/entries/background/main.js`
 * - firefox（MV2）：`background.scripts: ["src/entries/background/ff_main.js"]`
 * 二者都必须在清单里被守护——后台脚本缺失时扩展能装上但**完全不能用**（比空白页更严重）。
 */
const BACKGROUND_ARTIFACT =
  TARGET === "firefox" ? "src/entries/background/ff_main.js" : "src/entries/background/main.js";

/** 必须存在的关键产物（相对 dist-<target>）。缺任何一个都视为构建失败。 */
const REQUIRED_ARTIFACTS = [
  "manifest.json",
  "chenbinpt.css",
  "assets/cs-app.js",
  BACKGROUND_ARTIFACT,
  "src/entries/options/index.html",
  "src/entries/offscreen/offscreen.html",
  "src/entries/content-script/index.js",
  "_locales/en/messages.json",
  "_locales/zh_CN/messages.json",
  "lib/mdi/webfont.woff2",
  // 图标只在 manifest 里被引用，缺了不影响功能但会破坏商店/工具栏展示，单列一项做最低限度守护
  "icons/logo/128.png",
];

/**
 * 体积预算（KB，**实际字节和**，不是 `du` 的磁盘占用——后者会因块对齐明显偏大：
 * 当前 dist-chrome 目录 780+ 个文件，`du` 报 8.4MB，字节和只有 6.7MB）。
 * 取值 = 当前实测值 + 约 10~30% 余量，避免正常的代码增长就把 CI 打红，
 * 同时又能拦住「把 4.5MB 图标加回来」这种量级的回归。
 */
const BUDGETS_KB_BY_TARGET = {
  chrome: {
    total: 7680, // 实测 ~6850（约 6.7 MB 字节）
    icons: 1536, // 实测 ~1114
    "lib/mdi": 24, // 实测 11（子集化 webfont，icons.css/fontface.css 已随 DOM 侧 MDI 图标退役删除）
    "largest-js-chunk": 1792, // 实测 ~1359
  },
  firefox: {
    // Firefox 使用 background script，不能像 Chrome MV3 一样把下载/站点逻辑放到 offscreen 页面里分摊。
    total: 9728, // 实测 ~8630
    icons: 1536, // 实测 ~1114
    "lib/mdi": 24, // 实测 11（子集化 webfont，icons.css/fontface.css 已随 DOM 侧 MDI 图标退役删除）
    "largest-js-chunk": 2816, // 实测 ~2310（src/entries/background/ff_main.js）
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

// ---- 2. 体积预算 ----
const measured = {
  total: dirSize(DIST),
  icons: existsSync(join(DIST, "icons")) ? dirSize(join(DIST, "icons")) : 0,
  "lib/mdi": existsSync(join(DIST, "lib/mdi")) ? dirSize(join(DIST, "lib/mdi")) : 0,
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
