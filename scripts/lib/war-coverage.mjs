/**
 * `web_accessible_resources`（WAR）构建期校验（缺陷清单 G3 / G16；task-12 加固；WXT 迁移后收窄）。
 *
 * 背景：WAR 里的文件可以被**任意网页**按 `chrome-extension://<id>/<path>` 访问，网页据此就能探测扩展是否安装。
 * 旧构建让站点页面直接 `import()` 扩展里的 ESM chunk，所以必须以固定扩展 ID 暴露整个 `assets/*`、`vendor/*`。
 * 迁移到 WXT 后，内容脚本 UI 由后台 `scripting.executeScript` 注入（扩展自己注入的脚本不受 WAR 约束），
 * 样式也内联进脚本，WAR 只需要保留页面上直接引用的静态资源（`icons/*`、`lib/*`），且用动态 URL。
 *
 * 这里提供两条断言，供 `npm run check:bundle` 与 `npm run pack:crx` 使用：
 * 1. `checkWarWildcardsHaveMatches`：每个资源模式都真实匹配到产物里的文件（防拼错/目录缺失）；
 * 2. `checkWarExposesNoScripts`：WAR 不得覆盖任何 `.js` / `.html` 产物（防止回退到「把 chunk 暴露给网页」）。
 */

/** 编译后的 WAR 模式缓存 */
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
 * WAR 里每个资源模式都必须**真实匹配**到产物里的至少一个文件（防止目录整体缺失/拼错）。
 *
 * task-12：旧实现只看第一个 `*` 之前的前缀是否存在于某个文件名开头，`assets/*.css` 在只有
 * `assets/foo.js` 时也会通过（漏报）；现在用 `warResourceMatches` 做完整 glob 匹配。
 * 非通配符条目同样要求真实存在。
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

/** 不允许出现在 WAR 里的产物类型：脚本与页面（页面可被 iframe 嵌入、脚本可被网页探测/加载） */
const FORBIDDEN_WAR_EXTENSIONS = [".js", ".mjs", ".html"];

/**
 * WAR 不得覆盖任何脚本/页面产物。
 *
 * 内容脚本由 manifest（content-scripts/content.js）与 `scripting.executeScript`（content-scripts/cs-app.js）
 * 注入，都不需要 WAR；一旦有人把 `chunks/*`、`content-scripts/*` 之类加回 WAR，这里直接失败。
 */
export function checkWarExposesNoScripts(manifest, listFiles) {
  const problems = [];
  const files = listFiles().filter((file) => FORBIDDEN_WAR_EXTENSIONS.some((ext) => file.endsWith(ext)));
  for (const entry of manifest.web_accessible_resources ?? []) {
    for (const resource of entry.resources ?? []) {
      const exposed = files.filter((file) => warResourceMatches(resource, file));
      if (exposed.length > 0) {
        const sample = exposed.slice(0, 3).join(", ");
        problems.push(
          `WAR 资源模式 "${resource}" 暴露了 ${exposed.length} 个脚本/页面（例如 ${sample}），网页可据此探测扩展`,
        );
      }
    }
  }
  return problems;
}
