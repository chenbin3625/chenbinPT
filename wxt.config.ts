import fs from "node:fs";
import path from "node:path";

import vue from "@vitejs/plugin-vue";
import git from "git-rev-sync";
import type { Plugin } from "vite";
import { defineConfig } from "wxt";

import pkg from "./package.json" with { type: "json" };
import { generateWebextLocales } from "./vite/plugin/generateWebextLocales.ts";
import { buildUserManifest, type TBuildTarget } from "./vite/manifest.ts";
import { forbidContentScriptCssAssets } from "./vite/plugin/forbidContentScriptCssAssets.ts";

const root = import.meta.dirname;

function base_path(_path = "") {
  return path.resolve(root, _path);
}

/**
 * 读取 git 元数据时允许降级（缺陷清单 G19）：源码包（没有 `.git`）或 `git` 不在 PATH 时，
 * 构建元数据（commit/branch/date）只用于排查线上问题，不应成为构建的前置条件。
 */
function safeGit<T>(fallback: T, read: () => T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

// @ts-ignore git-rev-sync 的类型声明里 count() 没有参数说明
const git_count = safeGit(0, () => git.count("HEAD"));
const git_short = safeGit("unknown", () => git.short(root));
const git_long = safeGit("unknown", () => git.long(root));
const git_date = safeGit(0, () => +git.date());
const git_branch = safeGit("unknown", () => git.branch(root));

/**
 * manifest 的版本号 = `package.json` 的三位版本（如 `0.0.8`），**不拼接 git 提交计数**：
 * `git rev-list --all --count` 在不同机器/`fetch --prune` 前后结果不同，会产出比已发布版本更小的号
 * （Chrome 拒绝降级安装、商店拒绝更低版本）。每次发布前手动抬 `package.json` 的版本号。
 * 构建信息仍保留在 chrome 的 `version_name`、`__EXT_VERSION__` 与 `__GIT_VERSION__` 中。
 */
const base_version = pkg.version;
const commit_version = `${base_version}+${git_short}`;

/**
 * 项目自己的路径别名：`~` → src、`@` → src/entries、`@ptd` → src/packages。
 *
 * WXT 会强制注册 `@` / `~` → srcDir（见 wxt/dist/core/resolve-config.mjs），与本项目 `@` 的含义冲突。
 * Vite 合并 alias 时「后合并的排在前面、先匹配」，因此这里用 `enforce: "post"` 的插件在 WXT 之后再注入一次，
 * 保证构建、单测（vitest.config.ts）与类型检查（tsconfig.json paths）三处解析到同一个文件。
 */
const projectAliases = {
  "~": base_path("./src"),
  "@": base_path("./src/entries"),
  "@ptd": base_path("./src/packages"),
};

function projectAliasPlugin(target: TBuildTarget): Plugin {
  return {
    name: "ptd:project-aliases",
    enforce: "post",
    config() {
      return {
        resolve: {
          alias: [
            ...Object.entries(projectAliases).map(([find, replacement]) => ({ find, replacement })),
            // background 入口按目标选择实现：Firefox 的 background 是常驻页面，直接把 offscreen 的处理函数一起注册
            {
              find: /^#ptd\/background-main$/,
              replacement: base_path(
                target === "firefox" ? "src/entries/background/ff_main.ts" : "src/entries/background/main.ts",
              ),
            },
            // `parse-torrent` 会 `import path from "path"`，而它只用到 `join` + `sep`
            // （见 src/extends/shims/path.ts 的开头注释）。用本仓的最小实现接管，
            // 换掉 path-browserify 的 478 行实现。用正则做精确匹配，避免误伤 `path/xxx` 子路径。
            { find: /^(node:)?path$/, replacement: base_path("./src/extends/shims/path.ts") },
          ],
        },
      };
    },
  };
}

export default defineConfig({
  srcDir: "src",
  entrypointsDir: "entrypoints",
  publicDir: "public",
  // 产物仍输出到 dist-chrome / dist-firefox，沿用 README、pack-crx、e2e 与 .gitignore 的既有路径；
  // `wxt` dev 模式输出到 dist-chrome-dev（modeSuffix），不会覆盖发布构建
  outDir: ".",
  outDirTemplate: "dist-{{browser}}{{modeSuffix}}",
  manifestVersion: 3,
  targetBrowsers: ["chrome", "firefox"],
  // 不使用自动导入：保持显式 import，避免 .wxt 生成的全局类型与 tsconfig 冲突
  imports: false,
  webExt: {
    // 与旧构建的 disableAutoLaunch 一致：dev 时不自动拉起浏览器
    disabled: true,
  },
  manifest: ({ browser }) =>
    buildUserManifest({
      target: browser as TBuildTarget,
      version: base_version,
      versionName: commit_version,
    }),
  hooks: {
    // _locales 由 src/locales/*.json#manifest 生成到 public/_locales，必须在复制 public 之前完成
    "build:before": () => {
      for (const file of generateWebextLocales(root).generated) {
        console.log(`Generated ${path.relative(root, file)}`);
      }
    },
    // 内容脚本 UI 的样式必须内联进 JS（见 forbidContentScriptCssAssets 的说明）
    "vite:build:extendConfig": (entrypoints, viteConfig) => {
      if (entrypoints.some((entry) => entry.type === "content-script")) {
        viteConfig.plugins ??= [];
        viteConfig.plugins.push(forbidContentScriptCssAssets());
      }
    },
  },
  vite: (env) => {
    const target = env.browser as TBuildTarget;
    return {
      build: {
        target: "es2023",
        chunkSizeWarningLimit: 800,
        reportCompressedSize: false,
      },
      // 这里曾有 `vite-plugin-node-polyfills`（`include: ["buffer","path"]`，globals 默认全开）。已移除，
      // 因为本仓已不再有任何 Node 内建的运行时依赖：
      //   · `buffer`：源码里最后一处用法（downloader 把 ArrayBuffer 转成 Buffer 交给 parse-torrent）
      //     已改为零拷贝的 `new Uint8Array(...)`；
      //   · `path`：唯一使用方 parse-torrent 只用 `join` + `sep`，已由 projectAliasPlugin 的 alias 指向自实现；
      //   · `process` / 裸 `Buffer`：该插件的 globals 只在代码里出现裸标识符时注入，现存引用（axios 的
      //     `typeof process !== "undefined"`、jszip / konva 的 `typeof Buffer` 探测）都带 typeof 守卫，
      //     浏览器里走 queueMicrotask / Uint8Array / btoa 分支；
      //   · `global`：见下方 define（`global` → `globalThis`）。
      // ⚠️ 将来若新增的依赖 import 了 Node 内建：`path` 认 projectAliasPlugin 里那条 alias；其余需要像
      // `src/extends/shims/` 那样补一个等价实现（**不要**重新引入多模块垫片 —— 它们会把用不到的成员一起打进产物）。
      plugins: [vue(), projectAliasPlugin(target)],
      define: {
        __BROWSER__: JSON.stringify(target),
        __EXT_VERSION__: JSON.stringify(`v${commit_version}`),
        __GIT_VERSION__: JSON.stringify({
          short: git_short,
          long: git_long,
          date: git_date,
          count: git_count,
          branch: git_branch,
        }),
        __BUILD_TIME__: JSON.stringify(+Date.now()),
        __RESOURCE_SITE_ICONS__: JSON.stringify(fs.readdirSync(base_path("./public/icons/site"))),
        // 原垫片插件的 globals.global 会把裸 `global` 注入为垫片；移除后用 define 等价接管（零体积）。
        // 现存唯一无 typeof 守卫的引用是 parse-torrent 依赖的 queue-microtask：
        // `queueMicrotask.bind(typeof window !== "undefined" ? window : global)`，在没有 window 的
        // service worker 里会走到 `global` 分支（当前 chrome 的 background.js 未引入它，这里防患于未然）。
        global: "globalThis",
      },
    };
  },
});
