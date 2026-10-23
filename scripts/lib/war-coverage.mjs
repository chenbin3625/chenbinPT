/**
 * `web_accessible_resources`（WAR）覆盖校验（缺陷清单 G3 / G16；task-12 加固）。
 *
 * 背景：JS chunk 必须使用**固定扩展 ID** 的 WAR 才能被站点页面加载
 * （`use_dynamic_url: true` 会把 chunk 内的静态 import 重定向到固定源，Chrome 拒绝），
 * 所以 `assets/*` / `vendor/*` 是刻意保留的已知取舍。代价是：
 * - 任何网页都能用 `chrome-extension://<id>/assets/*` 探测扩展是否安装；
 * - 暴露面远大于实际需要（真正必需的只有 `assets/cs-app.js` 及其静态 import 闭包）。
 *
 * 收窄需要真实浏览器验证（本轮无浏览器，已记延期），但**收窄/重构不能破坏内容脚本加载**。
 * 因此这里提供一条构建期断言：从 `assets/cs-app.js` 出发，跟随相对路径的
 * `import`/`export from`/字面量 `import()`，把每个依赖都要求：
 * 1. 产物里真的存在（缺 chunk = 站点侧内容脚本挂不上）；
 * 2. 命中至少一条 WAR 通配符（否则页面上下文拿不到这个文件 = 运行时 404）。
 *
 * 这条检查同时是未来「把 WAR 收窄为精确前缀」的安全网：只要漏了某个 chunk，
 * `npm run pack:crx` / `check:bundle` 就会失败，而不是等到用户站点上白屏。
 *
 * task-12 的两处加固：
 * - **说明符提取**：不再用「全文任意 `from "…"` / `import "…"`」的正则，而是先去掉注释，再分别匹配
 *   真实的静态 `import`/`export … from`、副作用 `import "…"`、字面量动态 `import("…")`，
 *   减少注释/普通字符串造成的假红（把 `./foo.js` 当依赖）。
 * - **WAR glob 语义**：按 Chrome 文档实现 `*`（可跨 `/`，即目录递归；可多次出现）并整串锚定，
 *   修掉旧实现「只支持单个 `*`」与 `checkWarWildcardsHaveMatches`「前缀存在即通过」的漏报。
 */

/** 去掉注释再扫描说明符：块注释 + 行注释（行注释避开 `https://` 这类 URL，只处理前面不是 `:` 的 `//`） */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/**
 * 静态 import / `export … from`：`import { a } from "./x.js"`、`export * from "./y.js"`。
 *
 * 语句起点用 `^` / `;` / `}` / 换行 作为边界（构建产物的顶格语句都以这些形态出现），
 * 这样字符串内容里的 `see import z from "..."` 不会被误认为依赖（旧实现的全文本 `from` 正则会假红）。
 */
const STATIC_FROM_RE = /(?:^|[;{}\n])[ \t]*(?:import|export)\b[^;"'`]*?\bfrom\s*["']([^"']+)["']/g;

/** 副作用 import：`import "./x.js"`（不匹配 `import(...)`；同样要求语句边界） */
const SIDE_EFFECT_IMPORT_RE = /(?:^|[;{}\n])[ \t]*import\s*["']([^"']+)["']/g;

/** 字面量动态 import：`import("./x.js")`（变量/拼接路径无法静态分析，刻意不处理） */
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

/** 从 JS 源码里提取相对路径的模块说明符（忽略裸模块、URL、data: 等） */
export function extractRelativeImportSpecifiers(source) {
  const cleanSource = stripComments(source);
  const specifiers = new Set();
  for (const regexp of [STATIC_FROM_RE, SIDE_EFFECT_IMPORT_RE, DYNAMIC_IMPORT_RE]) {
    for (const match of cleanSource.matchAll(regexp)) {
      const specifier = match[1];
      if (specifier.startsWith("./") || specifier.startsWith("../")) {
        specifiers.add(specifier);
      }
    }
  }
  return [...specifiers];
}

/** 以 POSIX 语义把相对说明符解析成 dist 内的相对路径（去掉 query/hash） */
export function resolveRelativeModulePath(fromPath, specifier) {
  const clean = specifier.split(/[?#]/, 1)[0];
  const baseSegments = fromPath.split("/");
  baseSegments.pop(); // 去掉文件名，保留目录
  for (const segment of clean.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") baseSegments.pop();
    else baseSegments.push(segment);
  }
  return baseSegments.join("/");
}

/** 编译后的 WAR 模式缓存（同一模式在 58 个闭包文件上会反复匹配） */
const warGlobCache = new Map();

/**
 * WAR 资源模式是否覆盖某个产物路径（Chrome 语义：`*` 匹配任意字符，**可跨 `/`**，可多次出现；
 * 整串锚定，其余字符按字面量）。例：`assets/*` 覆盖 `assets/sub/x.js`、`*.png` 覆盖任意目录下的 png。
 */
export function warResourceMatches(resource, filePath) {
  const normalized = resource.replace(/^\/+/, ""); // Chrome 文档示例允许前导 `/`
  if (!normalized.includes("*")) {
    return normalized === filePath;
  }
  let regexp = warGlobCache.get(normalized);
  if (!regexp) {
    const pattern = normalized
      .split("*")
      .map((segment) => segment.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*");
    regexp = new RegExp(`^${pattern}$`);
    warGlobCache.set(normalized, regexp);
  }
  return regexp.test(filePath);
}

/**
 * 校验 `assets/cs-app.js` 的相对 import 闭包是否全部存在且被 WAR 覆盖。
 *
 * @param {object} options
 * @param {(path: string) => boolean} options.fileExists 产物内是否存在该路径
 * @param {(path: string) => string | null | Promise<string | null>} options.readFile 读产物内容（不存在返回 null）
 * @param {string} [options.manifestJsonPath] dist 内 manifest 的相对路径（用于给出可读报错，默认 manifest.json）
 * @returns {Promise<{ checked: number, problems: string[] }>}
 */
export async function checkCsAppWarClosure({ fileExists, readFile, manifestJsonPath = "manifest.json" }) {
  const problems = [];
  const manifestRaw = await readFile(manifestJsonPath);
  if (!manifestRaw) {
    return { checked: 0, problems: [`找不到 ${manifestJsonPath}，无法校验 WAR 覆盖`] };
  }

  let manifest;
  try {
    manifest = JSON.parse(manifestRaw);
  } catch (error) {
    return { checked: 0, problems: [`${manifestJsonPath} 不是合法 JSON：${error.message}`] };
  }

  const warResources = (manifest.web_accessible_resources ?? []).flatMap((entry) => entry.resources ?? []);
  if (warResources.length === 0) {
    return { checked: 0, problems: ["manifest 没有任何 web_accessible_resources，内容脚本无法加载 cs-app"] };
  }

  const CS_APP_ENTRY = "assets/cs-app.js";
  if (!fileExists(CS_APP_ENTRY)) {
    // 入口缺失本身由「必需产物」检查报出；这里不重复刷屏，直接返回
    return { checked: 0, problems: [] };
  }

  const queue = [CS_APP_ENTRY];
  const seen = new Set(queue);
  let checked = 0;

  while (queue.length > 0) {
    const current = queue.shift();
    if (!warResources.some((resource) => warResourceMatches(resource, current))) {
      problems.push(`${current} 未被任何 WAR 资源模式覆盖（${warResources.join(", ")}）`);
    }
    const source = await readFile(current);
    if (source === null) {
      problems.push(`${current} 不存在于产物中（cs-app 的 import 闭包缺少该 chunk）`);
      continue;
    }
    checked++;
    for (const specifier of extractRelativeImportSpecifiers(source)) {
      const dependency = resolveRelativeModulePath(current, specifier);
      if (!seen.has(dependency)) {
        seen.add(dependency);
        queue.push(dependency);
      }
    }
  }

  return { checked, problems };
}

/**
 * WAR 里每个资源模式都必须**真实匹配**到产物里的至少一个文件（防止目录整体缺失/拼错）。
 *
 * task-12：旧实现只看第一个 `*` 之前的前缀是否存在于某个文件名开头，`assets/*.css` 在只有
 * `assets/foo.js` 时也会通过（漏报）；现在用 `warResourceMatches` 做完整 glob 匹配。
 * 非通配符条目（如 `chenbinpt.css`）同样要求真实存在。
 */
export function checkWarWildcardsHaveMatches(manifest, listFiles) {
  const problems = [];
  const files = listFiles();
  for (const entry of manifest.web_accessible_resources ?? []) {
    for (const resource of entry.resources ?? []) {
      if (!files.some((file) => warResourceMatches(resource, file))) {
        problems.push(`WAR 资源模式 "${resource}" 在产物里没有任何匹配文件`);
      }
    }
  }
  return problems;
}
