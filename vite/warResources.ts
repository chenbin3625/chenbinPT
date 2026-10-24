/**
 * `web_accessible_resources`（WAR）策略的单一事实来源与按目标裁剪（task-12 / P2-8）。
 *
 * 源数据是 `vite/warResources.json`（Chrome 口径，`use_dynamic_url: true`）：
 * 只暴露站点页面上确实要引用的静态资源（`icons/*`：悬浮按钮 / 站点与下载器图标；`lib/*`），
 * 并用动态 URL 降低页面侧用固定地址做扩展指纹识别的能力。
 *
 * WXT 迁移后，内容脚本 UI（`content-scripts/cs-app.js`）由后台 `scripting.executeScript` 注入，
 * 样式以内联字符串打进脚本，不再需要像旧构建那样把 `assets/*`、`vendor/*`（固定扩展 ID）和
 * `chenbinpt.css` 暴露给任意网页。`scripts/check-bundle-budget.mjs` 会断言 WAR 只包含这一组。
 *
 * Firefox 不支持 Chrome 的 dynamic URL（该键由 Chromium 生成），把 `use_dynamic_url` 原样写进
 * Firefox 的 manifest 只会得到「未知属性」警告（AMO 校验噪音）。因此 firefox 目标剥离该键，
 * 其余字段与 Chrome 完全一致；`scripts/check-bundle-budget.mjs` 会按目标断言这一点。
 */
import webAccessibleResources from "./warResources.json" with { type: "json" };

export interface IWebAccessibleResource {
  resources: string[];
  matches?: string[];
  extension_ids?: string[];
  use_dynamic_url?: boolean;
}

/** Chrome 口径（= JSON 源内容，保持不可变，供测试与断言比对） */
export const chromeWebAccessibleResources: IWebAccessibleResource[] =
  webAccessibleResources as IWebAccessibleResource[];

/** 按构建目标返回 manifest 应写入的 WAR 列表（firefox 剥离 `use_dynamic_url`，非破坏性拷贝） */
export function getWebAccessibleResources(target: string): IWebAccessibleResource[] {
  if (target !== "firefox") {
    return chromeWebAccessibleResources;
  }
  return chromeWebAccessibleResources.map((entry) => {
    const { use_dynamic_url: _useDynamicUrl, ...rest } = entry;
    return rest;
  });
}
