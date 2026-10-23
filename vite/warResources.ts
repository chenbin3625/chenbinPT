/**
 * `web_accessible_resources`（WAR）策略的单一事实来源与按目标裁剪（task-12 / P2-8）。
 *
 * 源数据是 `vite/warResources.json`（Chrome 口径，含第一组的 `use_dynamic_url: true`）：
 * - 第一组（`icons/*`、`lib/*`、`chenbinpt.css`）用动态 URL，降低页面侧用固定地址做扩展指纹识别的能力；
 * - 第二组（`assets/*`、`vendor/*`）**必须**用固定扩展 ID —— chunk 内的静态 `import` 会按
 *   `chrome-extension://<id>/...` 解析，动态 URL 会让内容脚本加载 `assets/cs-app.js` 失败（issue #1467）。
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
