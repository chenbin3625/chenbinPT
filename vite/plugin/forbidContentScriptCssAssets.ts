import type { Plugin } from "vite";

/**
 * 内容脚本构建步骤里禁止产出独立的 CSS 文件。
 *
 * 内容脚本 UI 挂在 closed shadow root 里，样式需要以字符串形式写进 shadow root：
 * `src/entries/content-script/app/init.ts` 用 `?inline` 导入 app.css、antd reset 与 options/style.css。
 * 如果有人在内容脚本的依赖图里新增了 SFC `<style>` 块或普通 `import "./x.css"`，Vite 会把它抽成
 * `content-scripts/<name>.css` —— 这个文件既不会被注入（cssInjectionMode: "manual"），
 * 也不在 web_accessible_resources 里，样式会在站点页面上静默丢失。
 *
 * 因此直接让构建失败，提示改为 `?inline` 导入。
 */
export function forbidContentScriptCssAssets(): Plugin {
  return {
    name: "ptd:forbid-content-script-css-assets",
    apply: "build",
    generateBundle(_options, bundle) {
      const cssAssets = Object.values(bundle)
        .filter((file) => file.type === "asset" && file.fileName.endsWith(".css"))
        .map((file) => file.fileName);
      if (cssAssets.length > 0) {
        this.error(
          `内容脚本构建产出了独立 CSS 文件（${cssAssets.join(", ")}），它不会被注入到 shadow root。` +
            `请改用 \`import css from "./x.css?inline"\` 并在 init.ts 中写入 shadow root。`,
        );
      }
    },
  };
}
