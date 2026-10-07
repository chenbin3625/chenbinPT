// This file is the entry point for the content script
//
// 此入口应保持轻量（仅做"当前页面是否需要挂载"的判断），
// 重资源（Vue/组件库/站点包）都在多页构建的 assets/cs-app.js 中按需加载；
// social 匹配判断经消息由 offscreen 代查，避免把 social 包打进引导（见 issue #1467）。
//
// 性能说明（见 docs/performance-audit.md P1-3）：引导在每次页面加载时都会执行，
// 早期实现通过 getExtStorage 读取**整份** config 与 metadata（其中 metadata 含
// 所有站点配置与 lastUserInfo，体积可达数百 KB ~ MB 级）却只用到 2~3 个字段。
// 现改为 getExtStoragePath 精确取值，跨进程传输量与反序列化开销都降为常数级。

import { getHostFromUrl } from "@ptd/site/utils/html.ts";

import { sendMessage } from "@/messages.ts";
import type { IConfigPiniaStorageSchema } from "@/shared/types/storages/config.ts";

/** 多页构建产出的 ESM 入口固定文件名（对应 vite.config.ts 中的 cs-app 输入） */
const APP_CHUNK_PATH = "assets/cs-app.js";
/** chunk 首次加载失败后的重试间隔（毫秒） */
const APP_CHUNK_RETRY_DELAY = 300;

async function loadApp(props: Parameters<(typeof import("./app/init.ts"))["mountApp"]>[1]) {
  // 运行时从扩展包内加载多页构建产出的 ESM 入口（assets/cs-app.js，固定文件名），
  // @vite-ignore 阻止本入口（IIFE 单文件构建）将 app 静态打进引导
  const appUrl = chrome.runtime.getURL(APP_CHUNK_PATH);
  console.debug("[PTD] loading app from", appUrl);

  let appModule: typeof import("./app/init.ts");
  try {
    appModule = (await import(/* @vite-ignore */ appUrl)) as typeof import("./app/init.ts");
  } catch (firstError) {
    // 首屏 chunk 失败常见于：扩展刚热重载（Extension context invalidated）或瞬时 IO 错误。
    // 浏览器会把失败的模块记入 ESM module map，直接重试同一 URL 可能命中失败缓存，
    // 因此重试时带一次性查询参数强制重新拉取；仍失败则抛出，交由引导链外层的 catch 降级。
    console.warn(`[PTD] failed to load app chunk ${appUrl}, retrying once...`, firstError);
    await new Promise((resolve) => setTimeout(resolve, APP_CHUNK_RETRY_DELAY));
    const retryUrl = `${appUrl}${appUrl.includes("?") ? "&" : "?"}ptdRetry=${Date.now()}`;
    appModule = (await import(/* @vite-ignore */ retryUrl)) as typeof import("./app/init.ts");
  }

  console.debug("[PTD] app module loaded");
  await appModule.mountApp(document, props);
  console.debug("[PTD] app mounted");
}

let bootstrapDataPromise: Promise<any> | null = null;

function getContentScriptBootstrapData() {
  bootstrapDataPromise ??= sendMessage("getContentScriptBootstrapData", undefined);
  return bootstrapDataPromise;
}

sendMessage("getExtStoragePath", {
  key: "config",
  path: "contentScript",
  defaultValue: {},
})
  .then(async (contentScriptConfig) => {
    const contentScript = (contentScriptConfig ?? {}) as IConfigPiniaStorageSchema["contentScript"];

    if (contentScript.enabled ?? true) {
      if (contentScript.enabledAtSocialSite ?? true) {
        const socialSite = await sendMessage("matchSocialPage", window.location.href);
        if (socialSite) {
          console.debug(`[PTD] Social site detected: ${socialSite}, loading app...`);
          await loadApp({ socialSite, ...(await getContentScriptBootstrapData()) });
          return; // 找到匹配的 social site 后，直接加载应用并退出
        }
      }

      const host = getHostFromUrl(window.location.href); // 获取当前页面的 host
      // 优先读独立的 siteIndex 小 key（见 docs/performance-audit.md P2-17）：
      // metadata 很大且会被高频写入反复失效，这里只需要 host → siteId 映射表。
      // 旧数据（尚未生成 siteIndex）时回落到 metadata。
      let siteHostMap = (await sendMessage("getExtStoragePath", {
        key: "siteIndex",
        path: "siteHostMap",
        defaultValue: undefined,
      })) as Record<string, string> | undefined;

      // 空对象同样视为「未生成/不可用」：SW 侧 siteIndex 自愈会把无效空表清成 null 再重建，
      // 但自愈与页面加载之间存在竞态，这里再兜底一次，避免空表让页面识别不到站点。
      if (!siteHostMap || Object.keys(siteHostMap).length === 0) {
        siteHostMap =
          ((await sendMessage("getExtStoragePath", {
            key: "metadata",
            path: "siteHostMap",
            defaultValue: {},
          })) as Record<string, string>) ?? {};
      }

      // A-3/S-2：必须用 Object.hasOwn 取自有属性。单标签 host（例如内网/DNS 后缀名
      // `http://constructor/`）会沿原型链命中 `Object.prototype.constructor`，
      // 得到一个真值非字符串的 siteId 并继续流入消息路径与 createSiteInstance。
      const siteId = Object.hasOwn(siteHostMap, host) ? siteHostMap[host] : undefined;

      if (siteId) {
        // 如果当前页面的 host 在 siteHostMap 中有对应的 siteId，加载 app
        if (contentScript.allowExceptionSites === true) {
          const allowContentScript = await sendMessage("getExtStoragePath", {
            key: "metadata",
            path: ["sites", siteId, "allowContentScript"],
            defaultValue: true,
          });
          if (allowContentScript === false) {
            console.debug(`[PTD] Content script is disabled for site: ${siteId}`);
            return; // 如果允许排除站点，且站点配置中禁用了 contentScript，则不加载应用
          }
        }

        console.debug(`[PTD] host found for site: ${siteId}, loading app...`);
        await loadApp({ siteId, ...(await getContentScriptBootstrapData()) });
      }
    }
  })
  .catch((error) => {
    // 引导链的唯一兜底出口：SW 未就绪、扩展上下文失效（Extension context invalidated）、
    // chunk 在一次重试后仍加载失败、或 mountApp 内部抛错，都在这里留下可诊断信息，
    // 而不是变成静默的 unhandled rejection（页面侧永不挂载且无任何提示）。
    // 该脚本运行在宿主页面：页面控制台是当前唯一对开发者可见的渠道，
    // 因此这里刻意保留 console.error（不引入 Vue/站点包，保持入口轻量，也不影响宿主页面 UI）。
    console.error("[PTD] content script bootstrap failed, app will not be mounted:", error);
  });
