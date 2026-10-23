import fs from "node:fs";
import process from "node:process";
import path from "node:path";

// Vite And it's plugins
import { defineConfig } from "vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";
import vue from "@vitejs/plugin-vue";
import VueDevTools from "vite-plugin-vue-devtools";
import webExtension from "vite-plugin-web-extension";

// @ts-ignore
import { vitePluginGenerateWebextLocales } from "./vite/plugin/generateWebextLocales.ts";
// task-12：WAR 的按目标裁剪（firefox 剥离 use_dynamic_url）放在独立模块里，便于单测与门禁断言
import { getWebAccessibleResources } from "./vite/warResources.ts";

import git from "git-rev-sync";
import pkg from "./package.json" with { type: "json" };

function base_path(_path = "") {
  return path.resolve(import.meta.dirname, _path);
}

/**
 * 读取 git 元数据时允许降级（缺陷清单 G19）。
 *
 * `git-rev-sync` 内部执行 `git ...`：源码包（没有 `.git`）或 `git` 不在 PATH 时，
 * 旧实现会让 `vite build` 在**读取配置阶段**直接抛错。构建元数据（commit/branch/date）
 * 只用于排查线上问题，不应成为构建的前置条件，因此这里逐个 try/catch 并给 `unknown`/0 兜底。
 */
function safeGit<T>(fallback: T, read: () => T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

const target = process.env.TARGET || "chrome";
const permissions = [
  // INFRA-6：不声明 activeTab —— 全仓没有任何依赖「用户手势后临时访问标签页」的调用
  // （action.onClicked 只调 openOptionsPage），tab.url 由 host_permissions `*://*/*` 覆盖。
  // 多余权限会进入商店审核/安装提示的权限面，按最小权限原则移除。
  "alarms",
  "clipboardWrite",
  "contextMenus",
  "cookies",
  "downloads",
  "declarativeNetRequest",
  "storage",
  "unlimitedStorage",
  "notifications",
];

const optionalPermissions = ["nativeMessaging"];

// @ts-ignore
const git_count = safeGit(0, () => git.count("HEAD"));
const git_short = safeGit("unknown", () => git.short(import.meta.dirname));
const git_long = safeGit("unknown", () => git.long(import.meta.dirname));
const git_date = safeGit(0, () => +git.date());
const git_branch = safeGit("unknown", () => git.branch(import.meta.dirname));

/**
 * manifest 的版本号 = `package.json` 的三位版本（如 `0.0.8`），**不再拼接 git 提交计数**。
 *
 * 旧实现是 `${pkg.version}.${git.count()}`，而 `git-rev-sync` 的 count() 实际执行
 * `git rev-list --all --count` —— 把本机所有引用（包括远端已删除分支的陈旧 remote-tracking
 * 引用）都算进去。后果有两个：
 * 1. 版本号不稳定：同一份代码在换机器 / `git fetch --prune` 后算出的数字会变；
 * 2. 会产出**比已发布版本更小**的号（本机 1956 → 干净克隆 1951），而 Chrome 拒绝降级安装、
 *    商店也拒绝更低的版本号上传。
 *
 * 因此改为显式维护版本：**每次发布前手动抬 `package.json` 的版本号**。
 * 构建信息（commit sha / 提交数 / 分支）仍保留在 chrome 的 `version_name`、`__EXT_VERSION__`
 * 与 `__GIT_VERSION__` 中，排查线上问题时依然能定位到具体提交。
 */
const base_version = pkg.version;
// G19：git 不可用时降级为 "unknown"（version_name 仍是合法字符串，不影响安装/升级）
const commit_version = `${base_version}+${git_short}`;

// https://vitejs.dev/config/
export default defineConfig({
  // task-12（Info-10）：**未**设置 `root`。实测把 root 固定为 import.meta.dirname 并不能让
  // 「从子目录运行」可用（`cd src && vite build --config ../vite.config.ts` 仍会在
  // web-extension 多页构建里对 .vue 报 PARSE_ERROR；原因不在 root），反而让失败构建的
  // `emptyOutDir` 作用到仓库根的 dist-*。该问题需要单独排查 webExtension 的输入/alias 解析，
  // 记录为未修项（见 docs/review-2026-10-23/fix2/tooling.md）。
  build: {
    target: "es2023",
    outDir: `dist-${target}`,
    emptyOutDir: true,
    chunkSizeWarningLimit: 800,
    reportCompressedSize: false,
  },
  plugins: [
    vitePluginGenerateWebextLocales(),
    nodePolyfills({
      // parse-torrent 运行时会调用 path.join；Vite 无 polyfill 时会把 path externalize 为空对象。
      include: ["buffer", "path"],
      globals: {
        Buffer: true,
      },
    }),
    VueDevTools({
      launchEditor: fs.existsSync(base_path("./.idea")) ? "webstorm" : "vscode",
    }),
    vue(),
    webExtension({
      browser: target,
      disableAutoLaunch: true,
      // 关闭插件自带的 manifest 校验（G19）：`{{chrome}}` / `{{firefox}}` 条件字段是模板语法，
      // 默认 schema 校验不适用于它们。补偿手段在发布链路里：`scripts/pack-crx.mjs` 的
      // checkManifestShape 会校验必填结构（manifest_version/name/version/icons/content_scripts/
      // host_permissions/background/WAR matches），`checkManifestReferences` 校验引用与本地化键；
      // `scripts/check-bundle-budget.mjs` 另外断言 cs-app 的 import 闭包被 WAR 覆盖。
      skipManifestValidation: true,
      manifest: () => ({
        manifest_version: 3,
        "{{chrome}}.minimum_chrome_version": "140",

        version: base_version,
        "{{chrome}}.version_name": commit_version,

        name: "__MSG_extName__",
        description: "__MSG_extDesc__",
        default_locale: "en",
        homepage_url: "https://github.com/chenbin3625/chenbinPT",
        icons: {
          "16": "icons/logo/16.png",
          "19": "icons/logo/19.png",
          "64": "icons/logo/64.png",
          "128": "icons/logo/128.png",
        },

        action: {
          default_icon: {
            "16": "icons/logo/16.png",
            "19": "icons/logo/19.png",
            "64": "icons/logo/64.png",
            "128": "icons/logo/128.png",
          },
          default_title: "__MSG_extName__",
        },

        "{{chrome}}.background": {
          service_worker: "src/entries/background/main.ts",
        },

        // 在 Firefox 中，background 不能使用 service_worker
        "{{firefox}}.background": {
          scripts: ["src/entries/background/ff_main.ts"],
        },

        omnibox: {
          keyword: "ptd",
        },

        options_ui: {
          page: "src/entries/options/index.html",
          open_in_tab: true,
        },

        content_scripts: [
          {
            matches: ["*://*/*"],
            exclude_matches: ["*://*/*.xml", "*://*/*.xml?*"],
            js: ["src/entries/content-script/index.ts"],
          },
        ],

        // 在 Chrome 中需要多注册一个 offscreen 权限
        "{{chrome}}.permissions": [...permissions, "offscreen"],
        "{{chrome}}.optional_permissions": optionalPermissions,
        "{{firefox}}.permissions": permissions,
        "{{firefox}}.optional_permissions": optionalPermissions,
        host_permissions: ["*://*/*"],

        "{{firefox}}.browser_specific_settings": {
          gecko: {
            strict_min_version: "133.0",
          },
        },
        "{{firefox}}.content_security_policy": {
          extension_pages: "script-src 'self';",
        },

        /**
         * `web_accessible_resources` 来自 `vite/warResources.json`（G3）。
         *
         * 取舍（已知、刻意保留）：
         * - 第一组（`icons/*`、`lib/*`、`chenbinpt.css`）用 `use_dynamic_url: true`，页面拿不到固定地址；
         * - 第二组（`assets/*`、`vendor/*`）**必须**用固定扩展 ID：chunk 内的静态 `import` 会按
         *   `chrome-extension://<id>/...` 解析，动态 URL 会把它们重定向到固定源而被 Chrome 拒绝，
         *   内容脚本因此无法加载 `assets/cs-app.js`（issue #1467）。
         *
         * 代价：任何网页都能用 `chrome-extension://<id>/assets/*` 探测扩展是否安装（扩展 ID 由签名私钥决定，
         * 对所有用户相同），且暴露面（options/offscreen 的 chunk、全部 vendor）大于真正需要的
         * 「cs-app 静态 import 闭包」。
         *
         * 为什么本轮**不收窄**：正确的收窄方式是从 rollup 产物算出 `assets/cs-app.js` 的传递依赖闭包、
         * 生成精确清单，并在真实浏览器里验证内容脚本仍能加载；本轮没有浏览器环境，手写/猜测清单
         * 极易让内容脚本在站点上白屏（错误修复比不修更糟），因此记入 fix report 延期项。
         *
         * 安全网（收窄前后都生效）：`scripts/lib/war-coverage.mjs` 会在 `npm run check:bundle`
         * 与 `npm run pack:crx` 里跟随 cs-app 的相对 import 闭包，断言每个依赖都存在且命中 WAR，
         * 任何收窄漏项都会让门禁失败，而不是等到用户站点上才发现。
         *
         * task-12（P2-8）：源数据仍是 `vite/warResources.json`（Chrome 口径），但 `use_dynamic_url` 是
         * Chrome 特性；firefox 目标由 `vite/warResources.ts#getWebAccessibleResources` 剥离该键，
         * 避免 Firefox 安装/AMO 校验出现未知属性警告。`check-bundle-budget` 会按目标断言这一点。
         */
        web_accessible_resources: getWebAccessibleResources(target),
      }),
      // vite-plugin-web-extension 会在构造中，将js中引入的css文件自动添加到 manifest 中的 content_scripts 中，我们不需要这种默认行为
      transformManifest: (manifest) => {
        manifest.content_scripts.forEach((script: { css?: any }) => {
          if (script.css) {
            delete script.css;
          }
        });
        return manifest;
      },
      additionalInputs: target == "chrome" ? ["src/entries/offscreen/offscreen.html"] : undefined,
      watchFilePaths: ["package.json"],
      htmlViteConfig: {
        plugins: [
          {
            name: "cs-app-entry",
            config(config) {
              // content script 的重逻辑（Vue/antd/站点包）挂到多页 ESM 构建中作为额外入口，
              // 产物 assets/cs-app.js 由轻量引导在匹配站点时通过 chrome.runtime.getURL 动态加载，
              // 并直接复用 options 构建已拆分的 vendor chunk（见 issue #1467）。
              config.build ??= {};
              config.build.rollupOptions ??= {};
              config.build.rollupOptions.input ??= {};
              (config.build.rollupOptions.input as Record<string, string>)["cs-app"] = base_path(
                "src/entries/content-script/app/init.ts",
              );
              // 该入口仅由 content script 引导在运行时动态 import（构建期无静态消费者），
              // 必须保留入口导出签名，否则 mountApp 会被 rollup 树摇成纯副作用壳
              config.build.rollupOptions.preserveEntrySignatures = "strict";
              // 动态 import 不会自动加载按 chunk 拆分的 css 分片，cs-app 的组件树样式
              // （组件、页面组件等分散在各 chunk 的 css）无法逐份在页面上下文
              // 引入，故合并为单文件，由 app/init.ts 按固定地址 link。
              //
              // G20 实测澄清（旧注释说这是「cs-app 的组件树样式」，与产物不符）：
              // `chenbinpt.css` 实际是 options 页样式（`style.css` + antd reset/覆盖，约 20KB）——
              // 即每个加载 cs-app 的站点页面都会顺带下载/注入**管理页**专用的样式与 `.ant-*` 覆盖，
              // 内容脚本自己的组件样式走 `?inline` 打进 JS、不在这个文件里。
              // 两侧共用一份 CSS 属于跨上下文耦合（改 options 样式会影响站点侧边栏）。
              // 拆分（让 cs-app 只带自己的样式）会改变构建产物的 asset 划分，需要浏览器验证，
              // 本轮记为延期项（见 docs/review-2026-10-23/fix-reports/g-tooling.md），先按实际口径留档。
              config.build.cssCodeSplit = false;
              // 关闭 module preload（见 issue #1524）：
              // 该 ESM 入口被 content script 引导在**站点页面文档**里动态 import，而 Vite 生成的
              // 预加载辅助函数把依赖还原为根相对地址（`function(e){return"/"+e}`），页面上下文会把
              // 它们解析成 `https://<站点>/vendor/...`，每个 chunk 每页都发出一次必然 404 的请求，
              // 并计入站点访问统计。此处产物的 `__vite__mapDeps` 全部为 js 依赖、无 css 依赖，
              // 关掉预加载后辅助函数退化为纯 `import()` 包装（仅少一个无效提示，不影响模块解析），
              // 站点侧不再出现任何发往自身 /vendor/... 的请求。
              // ⚠️ 该设置作用于 cs-app 入口所在的**整个 HTML 多页构建**：options/index.html、offscreen.html
              // 与 cs-app 共用同一份 htmlViteConfig（vite-plugin-web-extension 把 manifest.options_ui.page
              // 与 additionalInputs 的 .html 一起交给 getMultiPageConfig）。因此管理页与 offscreen 文档
              // 也会一并失去 `<link rel="modulepreload">` 提示（每页首屏多一次串行 RTT）——这是为消除
              // 站点侧必然 404 已接受的代价，但**不要**以为只有 cs-app 受影响（INFRA-5）。
              config.build.modulePreload = false;
            },
          },
          {
            name: "sort-asserts",
            config(config) {
              config.build!.rollupOptions!.output = {
                ...config.build?.rollupOptions!.output,
                chunkFileNames: (chunkInfo) => {
                  // 特殊情况下 facadeModuleId 可能为 null，这时我们使用 moduleIds 的最后一个作为 chunkName
                  const chunkName = chunkInfo.facadeModuleId || chunkInfo.moduleIds.slice(-1)[0];

                  // 对 src/entries 下的 Index.vue 文件进行特殊处理（以防止构造产物无法区分）
                  if (/src[\\/]entries[\\/].+?Index\.vue$/.test(chunkName)) {
                    const indexEntryName = chunkName.match(/.+[\\/](.+?)[\\/]Index\.vue/)?.[1];
                    return `assets/${indexEntryName}-[hash].js`;
                  }

                  // 我们自己的 @pkg 下分包，使用 vendor/packages 前缀
                  if (
                    /[\\/]src[\\/]packages[\\/](downloader|backupServer|site|social|mediaServer).+\.ts/.test(chunkName)
                  ) {
                    const name = chunkName.replace(/^.+?[\\/]src[\\/]/, "").replace(/\..+?$/, "");
                    return `vendor/${name}-[hash].js`;
                  }

                  // 其他 node_modules 分包，直接使用 vendor/{deps} 前缀
                  if (/node_modules[\\/].+?[\\/]/.test(chunkName)) {
                    const pkgName = chunkName.match(/.+[\\/]node_modules[\\/](.*?)([\\/]|$)/)?.[1];
                    return `vendor/${pkgName}/[name]-[hash].js`;
                  }

                  return "assets/[name]-[hash].js"; // vite default
                },
                entryFileNames: (chunkInfo) => {
                  // cs-app 的加载地址写死在 content script 引导里，必须使用稳定文件名（不带 hash）
                  if (chunkInfo.name === "cs-app") {
                    return "assets/cs-app.js";
                  }
                  return "assets/[name]-[hash].js"; // vite default
                },
                assetFileNames: (assetInfo) => {
                  const assetName = assetInfo.names[0] || "";

                  // 将 css 文件放到 assets/css 目录
                  if (assetName.endsWith(".css")) {
                    // cssCodeSplit=false 后全量样式合并为单一文件；content script 的
                    // shadow DOM 通过 chrome.runtime.getURL("chenbinpt.css") 固定地址
                    // 加载（见 app/init.ts），必须输出到根目录且使用稳定文件名
                    if (assetName === "index.css" || assetName === "style.css") {
                      return "chenbinpt.css";
                    }
                    return "assets/css/[name]-[hash][extname]";
                  }

                  return "assets/[name]-[hash][extname]"; // vite default
                },
              };

              return config;
            },
          },
        ],
      },
    }),
  ],
  resolve: {
    alias: {
      "~": base_path("./src"),
      "@": base_path("./src/entries"),
      "@ptd": base_path("./src/packages"),
    },
  },
  define: {
    __BROWSER__: JSON.stringify(target),
    __EXT_VERSION__: JSON.stringify(`v${commit_version}`),
    __GIT_VERSION__: {
      short: git_short,
      long: git_long,
      date: git_date,
      count: git_count,
      branch: git_branch,
    },
    __BUILD_TIME__: +Date.now(),
    __RESOURCE_SITE_ICONS__: fs.readdirSync(base_path("./public/icons/site")),
  },
});
