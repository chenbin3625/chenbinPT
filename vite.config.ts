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

import git from "git-rev-sync";
import pkg from "./package.json" with { type: "json" };

function base_path(_path = "") {
  return path.resolve(import.meta.dirname, _path);
}

const target = process.env.TARGET || "chrome";
const permissions = [
  "activeTab",
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
const git_count = git.count("HEAD");

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
const commit_version = `${base_version}+${git.short(import.meta.dirname)}`;

// https://vitejs.dev/config/
export default defineConfig({
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

        web_accessible_resources: [
          {
            resources: ["icons/*", "lib/*", "chenbinpt.css"],
            matches: ["*://*/*"],
          },
          // content script 的按需主逻辑（assets/cs-app.js）及其共享 chunk 依赖链，
          // 由轻量引导在匹配站点时于页面上下文动态 import 加载（见 issue #1467）。
          // 使用通配以避免依赖拓扑变化后遗漏新 chunk 导致运行时加载失败。
          //
          // ⚠️ 已知风险（Q-4，本轮有意不改行为）：
          // `matches: ["*://*/*"]` 把 assets/* 与 vendor/* 暴露给**所有站点**，任何网站都可以
          // fetch 一个已知 URL（例如 assets/cs-app.js，或那个 751 KB 的 pinia chunk）来判断
          // "访问者装了本扩展" —— 即**扩展指纹识别**。对 PT 用户群体而言这是隐私问题
          // （站点可以把"装了哪些扩展"作为画像/风控依据），因此这条通配是**有代价的**。
          //
          // 若要收窄，正确做法是（不要手写清单）：
          //   1. 构建期从 rollup 的 chunk 图（`bundle` 的 `generateBundle` 钩子）算出
          //      assets/cs-app.js 的**传递依赖闭包**，据此生成 `resources` 精确清单；
          //   2. 在 CI 里断言该清单包含 cs-app.js 及其整条依赖链（缺一项就会在生产环境
          //      静默 404 → 内容脚本功能整块失效，比指纹识别严重得多）。
          //
          // 本轮不做的原因：现有注释指出的失败模式是真实的 —— 手写/静态清单一旦遗漏新 chunk，
          // 失败发生在**生产环境的运行时**且是静默的（用户在站点上看不到任何提示）；
          // 而本轮无法做浏览器端验证（装包 + 真实站点跑一遍 cs-app.js 的按需加载）。
          // 在"能用但可指纹识别"与"可能静默坏掉且无法验证"之间，本轮选择前者，并把
          // 精确清单 + CI 断言作为后续独立改动。**不要在没有浏览器验证的情况下改成静态清单。**
          {
            resources: ["assets/*", "vendor/*"],
            matches: ["*://*/*"],
          },
        ],
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
              // 引入，故合并为单文件，由 app/init.ts 按固定地址 link
              config.build.cssCodeSplit = false;
              // 关闭 module preload（见 issue #1524）：
              // 该 ESM 入口被 content script 引导在**站点页面文档**里动态 import，而 Vite 生成的
              // 预加载辅助函数把依赖还原为根相对地址（`function(e){return"/"+e}`），页面上下文会把
              // 它们解析成 `https://<站点>/vendor/...`，每个 chunk 每页都发出一次必然 404 的请求，
              // 并计入站点访问统计。此处产物的 `__vite__mapDeps` 全部为 js 依赖、无 css 依赖，
              // 关掉预加载后辅助函数退化为纯 `import()` 包装（仅少一个无效提示，不影响模块解析），
              // 站点侧不再出现任何发往自身 /vendor/... 的请求。
              // 仅作用于 cs-app 入口所在的多页构建；offscreen 等扩展页面文档不受影响。
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
      short: git.short(import.meta.dirname),
      long: git.long(import.meta.dirname),
      date: +git.date(),
      count: git_count,
      branch: git.branch(import.meta.dirname),
    },
    __BUILD_TIME__: +Date.now(),
    __RESOURCE_SITE_ICONS__: fs.readdirSync(base_path("./public/icons/site")),
  },
});
