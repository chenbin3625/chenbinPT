import { watchEffect, type WatchStopHandle } from "vue";

import { buildThemeVars } from "@/options/plugins/antd.ts";

/**
 * 把 antd Design Token 派生的 `--ptd-*` 同步到 shadow host（`contentRoot`）上。
 *
 * 自定义属性会向下继承进 shadow tree，供注入的 chenbinpt.css（= 构建后的 options/style.css）使用。
 * options 页面把同一套变量写在 `document.documentElement` 上（见 options/App.vue），
 * overlay 的宿主是 contentRoot。
 *
 * A-10：宿主元素在外层文档里，页面可以用 `--ptd-*: … !important` 内联/样式表覆盖宿主上的变量，
 * 整个覆盖层就会掉色（UI redressing 面），因此这里统一按 `important` 优先级写入
 * （shadow 内的重要声明在级联中优先于外层的普通声明）。
 *
 * 写入内容与 init.ts 里 `appliedThemeConfig` 的判定严格一致：
 * - `followsTheme()` 为 true → overlay 应用 `uiTheme` 对应的 algorithm → 写 `vars()`
 *   （即 `useAntdConfig().themeVars`，同样跟随 uiTheme）
 * - 为 false → overlay 应用 antd 默认（浅色）algorithm → **显式写 `buildThemeVars(false)`**
 *   （antd 唯一的 token 来源，不抄第二份映射）
 *
 * 这里刻意不采用"清空变量、靠 style.css 的 `var(--ptd-x, <浅色回退>)` 兜底"的写法：
 * 回退值属于 style.css 的实现细节、随时可能被清理，届时清空变量会直接掉色。
 *
 * @param host shadow host 元素（`contentRoot`）
 * @param vars 跟随主题时使用的变量表，键名即变量名
 * @param followsTheme 是否跟随主题（`configStore.contentScript.applyTheme`）
 */
export function syncThemeVarsToHost(
  host: HTMLElement,
  vars: () => Record<string, string>,
  followsTheme: () => boolean,
): WatchStopHandle {
  // 纯函数产物：antd 默认（浅色）algorithm 的一套 token，只需算一次
  const lightVars = buildThemeVars(false);
  let appliedKeys: string[] = [];

  return watchEffect(() => {
    const next = followsTheme() ? vars() : lightVars;

    // 清掉上一轮写过、这一轮不再存在的变量（键集合变化时不残留旧值）
    for (const name of appliedKeys) {
      if (!(name in next)) host.style.removeProperty(name);
    }
    for (const [name, value] of Object.entries(next)) {
      host.style.setProperty(name, value, "important"); // A-10：页面用 !important 覆盖不了
    }
    appliedKeys = Object.keys(next);
  });
}
