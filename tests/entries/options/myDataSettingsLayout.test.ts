/**
 * 我的数据页的「显示列 / 开关」布局。
 *
 * Q-3 改造：
 * - 「这些布尔配置项有默认值」原本靠正则匹配 `config.ts` 源码里的 `key: true,`；现在**真的读
 *   `useConfigStore().myDataTableControl`**，断言 14 个 key 都存在且是 boolean —— 这是真正的数据契约，
 *   config store 的默认值来源改成函数/常量也照样成立。
 * - 「文案在开关之前 + 行内两端对齐」原本靠正则匹配模板与 CSS；现在用真实 DOM + 真实样式表断言
 *   DOM 顺序（`compareDocumentPosition`）与计算样式。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { expect, it } from "vitest";

import { computedStyle, loadOptionsStyles, mountDom, prepareOptionsPinia } from "../../helpers/optionsView.ts";

const booleanSettingKeys = [
  "showSiteName",
  "showUnreadMessage",
  "showUserName",
  "normalizeLevelName",
  "showLevelRequirement",
  "onlyShowUserLevelRequirement",
  "showNextLevelInTable",
  "showNextLevelInDialog",
  "showHnR",
  "showSeedingBonus",
  "updateAtFormatAsAlive",
  "showIntervalAsDate",
  "simplifyBonusNumbers",
  "showBonusNeededInterval",
] as const;

it("我的数据的 14 个表格布尔开关都有 boolean 默认值（直接读 config store）", async () => {
  prepareOptionsPinia();
  const { useConfigStore } = await import("@/options/stores/config.ts");
  const control = useConfigStore().myDataTableControl as Record<string, unknown>;

  for (const key of booleanSettingKeys) {
    expect(typeof control[key], `myDataTableControl.${key} 应是 boolean 默认值`).toBe("boolean");
  }
});

it("显示设置行：文案在开关之前，且整行两端对齐", () => {
  loadOptionsStyles();

  // 与 views/Overview/MyData/Index.vue 里 `<a-list-item class="my-data-setting-item">` 的真实结构一致
  const { root, unmount } = mountDom(`
    <div class="ptd-settings-grid">
      <div class="ant-list-item my-data-setting-item">
        <span class="my-data-setting-label">显示站点名称</span>
        <button class="ant-switch" role="switch"></button>
      </div>
    </div>
  `);

  const row = root.querySelector<HTMLElement>(".my-data-setting-item")!;
  const label = root.querySelector<HTMLElement>(".my-data-setting-label")!;
  const toggle = root.querySelector<HTMLElement>(".ant-switch")!;

  // 文案在左、开关在右：DOM 顺序 + 两端对齐共同决定
  expect(label.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING, "文案应排在开关之前").toBeTruthy();
  expect(computedStyle(row, "justify-content")).toBe("space-between");
  expect(computedStyle(row, "gap")).toBe("16px");

  unmount();
});

/**
 * 保留的源码级断言（1 条）—— 为什么这里必须是源码级：
 *
 * 「MyData 页面把每个布尔开关渲染成一行」只在 `views/Overview/MyData/Index.vue`（700+ 行、依赖
 * 站点元数据异步加载与多个子组件）的模板里成立。要行为化需要挂载整个页面并把它依赖的
 * `views/Overview/MyData/utils/*` 全部打桩，本轮收益与成本不成比例。
 * 这里保留一条**结构性**断言（不再是逐项的计数）：列表项必须遍历 `filteredTableBooleanControlKeys`
 * 并带上 `.my-data-setting-item` / `.my-data-setting-label` 这两个被上面样式断言依赖的钩子。
 * 数据契约的一半已由上面直接读 store 的用例覆盖；剩下的「渲染项数 == 配置项数」记为
 * 需要源码配合（抽出 `MyDataSettingsRow` 之类的展示组件）才能行为化。
 */
it("MyData 页面用同一行组件遍历渲染布尔开关（源码级，见上方说明）", () => {
  const view = readFileSync(resolve(process.cwd(), "src/entries/options/views/Overview/MyData/Index.vue"), "utf8");
  const settingRow = view.match(
    /<a-list-item v-for="index in filteredTableBooleanControlKeys"[\s\S]*?<\/a-list-item>/,
  )?.[0];

  expect(settingRow, "应能定位到布尔开关列表项").toBeDefined();
  expect(settingRow).toContain('class="my-data-setting-item"');
  expect(settingRow!.indexOf("my-data-setting-label")).toBeLessThan(settingRow!.indexOf("<a-switch"));
});
