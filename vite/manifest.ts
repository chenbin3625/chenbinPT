/**
 * 扩展 manifest 的单一事实来源（WXT 迁移后从 vite.config.ts 拆出，便于 wxt.config.ts 与测试共用）。
 *
 * WXT 会根据 `src/entrypoints/` 自动补齐 background / content_scripts / options_ui 等入口字段，
 * 这里只声明「入口以外」的字段：权限、图标、action、omnibox、CSP、WAR 等。
 */
import { getWebAccessibleResources, type IWebAccessibleResource } from "./warResources.ts";

export type TBuildTarget = "chrome" | "firefox";

// INFRA-6：不声明 activeTab —— 全仓没有任何依赖「用户手势后临时访问标签页」的调用
// （action.onClicked 只调 openOptionsPage），tab.url 由 host_permissions `*://*/*` 覆盖。
//
// `scripting`：内容脚本 UI（content-scripts/cs-app.js）改由后台用 `scripting.executeScript`
// 按需注入到「已识别为 PT / 社交站点」的页面（见 src/entries/background/utils/contentScriptApp.ts）。
// 旧实现靠页面里的 `import(chrome-extension://<id>/assets/cs-app.js)` 加载，必须把 `assets/*`、`vendor/*`
// 以固定扩展 ID 暴露为 web_accessible_resources（任何网页都能据此探测扩展是否安装）。
// 已有 `*://*/*` host 权限，`scripting` 不会增加安装时的权限提示。
export const permissions = [
  "alarms",
  "clipboardWrite",
  "contextMenus",
  "cookies",
  "downloads",
  "declarativeNetRequest",
  "scripting",
  "storage",
  "unlimitedStorage",
  "notifications",
];

export const optionalPermissions = ["nativeMessaging"];

const icons = {
  "16": "icons/logo/16.png",
  "19": "icons/logo/19.png",
  "64": "icons/logo/64.png",
  "128": "icons/logo/128.png",
};

export interface IManifestBuildInfo {
  target: TBuildTarget;
  /** package.json 的三位版本号（见 wxt.config.ts 对版本策略的说明） */
  version: string;
  /** chrome 的 version_name，例如 `0.0.14+abc1234` */
  versionName: string;
}

/** 返回交给 WXT `manifest` 选项的用户字段（入口字段由 WXT 生成） */
export function buildUserManifest({ target, version, versionName }: IManifestBuildInfo) {
  const webAccessibleResources: IWebAccessibleResource[] = getWebAccessibleResources(target);

  return {
    name: "__MSG_extName__",
    description: "__MSG_extDesc__",
    default_locale: "en",
    homepage_url: "https://github.com/chenbin3625/chenbinPT",
    version,
    ...(target === "chrome" ? { version_name: versionName, minimum_chrome_version: "140" } : {}),
    icons,
    action: {
      default_icon: icons,
      default_title: "__MSG_extName__",
    },
    omnibox: {
      keyword: "ptd",
    },
    // 在 Chrome 中需要多注册一个 offscreen 权限（Firefox 的 background 是常驻页面，不需要 offscreen 文档）
    permissions: target === "chrome" ? [...permissions, "offscreen"] : permissions,
    optional_permissions: optionalPermissions,
    host_permissions: ["*://*/*"],
    ...(target === "firefox"
      ? {
          browser_specific_settings: {
            gecko: {
              strict_min_version: "133.0",
            },
          },
          content_security_policy: {
            extension_pages: "script-src 'self';",
          },
        }
      : {}),
    web_accessible_resources: webAccessibleResources,
  };
}
