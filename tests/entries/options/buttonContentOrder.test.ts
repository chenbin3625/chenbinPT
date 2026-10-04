/**
 * 按钮内「文案 / 图标」的排列顺序。
 *
 * Q-3 改造：原断言对 `style.css` 做源码正则（匹配 `.ant-btn:not(...) > .anticon {\n order: 1;`），
 * 只证明"某条规则这么写了"，不证明它真的生效（可能被后面的规则覆盖、被 `:not()` 写错而永不命中）。
 * 现在读 `getComputedStyle` 的计算值：
 * - 文字按钮的直接子图标确实拿到 `order: 1`（视觉上排到文案后面）；
 * - 纯图标按钮 / 状态按钮**不**吃这条规则（`:not()` 边界真的生效）；
 * - `.status-btn__item` 是 inline-flex + 4px 间距，保证"数值紧邻它的图标"。
 *
 * 仍保留 2 条源码级断言见文件末尾说明（状态药丸的**值在图标之前**只存在于两个 500+ 行视图的模板里，
 * 行为化需要先把该药丸抽成组件 —— 属于需要源码配合的改动）。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { expect, it } from "vitest";

import { computedStyle, loadOptionsStyles, mountDom } from "../../helpers/optionsView.ts";

it("文字按钮的图标靠 order 排在文案之后", () => {
  loadOptionsStyles();

  const { root, unmount } = mountDom(`
    <button class="ant-btn"><span class="anticon" id="text-btn-icon">i</span><span>文案</span></button>
    <button class="ant-btn ant-btn-icon-only"><span class="anticon" id="icon-only-icon">i</span></button>
    <button class="ant-btn status-btn"><span class="anticon" id="status-btn-icon">i</span></button>
    <button class="ant-btn"><span class="ant-btn-loading-icon"><span class="anticon">i</span></span>加载中</button>
  `);

  // 布局前提：按钮是 flex 容器，order 才有意义（antd 运行时注入的 :where(...) 会把它设成 inline-block）
  const textButton = root.querySelector<HTMLElement>(".ant-btn")!;
  expect(computedStyle(textButton, "display")).toBe("inline-flex");
  expect(computedStyle(textButton, "align-items")).toBe("center");
  expect(computedStyle(textButton, "justify-content")).toBe("center");

  expect(computedStyle(root.querySelector("#text-btn-icon")!, "order"), "文字按钮的图标应后置").toBe("1");
  // loading 图标同样后置（否则加载态会跳一下位置）
  expect(computedStyle(root.querySelector(".ant-btn-loading-icon")!, "order")).toBe("1");
  // 边界：纯图标按钮、状态按钮不吃这条规则
  expect(computedStyle(root.querySelector("#icon-only-icon")!, "order")).toBe("");
  expect(computedStyle(root.querySelector("#status-btn-icon")!, "order")).toBe("");

  unmount();
});

it("状态药丸内部：数值与图标紧邻（inline-flex + 4px 间距）", () => {
  loadOptionsStyles();

  const { root, unmount } = mountDom(`
    <span class="status-btn__item"><span id="value">12</span><span class="anticon" id="icon">i</span></span>
  `);

  const item = root.querySelector<HTMLElement>(".status-btn__item")!;
  expect(computedStyle(item, "display")).toBe("inline-flex");
  expect(computedStyle(item, "align-items")).toBe("center");
  expect(computedStyle(item, "gap")).toBe("4px");

  // 药丸内部的 DOM 顺序 = 视觉顺序（没有 order 反转），所以"值在前、图标在后"就是最终呈现
  const children = Array.from(item.children);
  expect(children.indexOf(root.querySelector("#value")!)).toBeLessThan(children.indexOf(root.querySelector("#icon")!));

  unmount();
});

/**
 * 只能源码级的 2 条 —— 为什么这里必须是源码级断言：
 *
 * 「状态值紧邻它的图标」这条规则只体现在 `views/Overview/SearchEntity/Index.vue` 与
 * `views/Overview/MyClient/Index.vue` 的**内联模板**里（`{{ searchPlanStatus.success }}<CheckOutlined/>`）。
 * 这两个视图是 500+ 行、依赖后台消息 / 大量子对话框的页面组件，无法在单测里稳定挂载；
 * 而这条规则本身没有可导入的模块边界（不像上面两条有 CSS 规则可读）。
 *
 * 正确修法（需要改 `src/**`，不在本次范围内）：把状态药丸抽成一个小组件（例如
 * `components/StatusPill.vue`，props = value/icon/color），随后即可挂载断言「渲染出的文本节点
 * 在图标之前」。已记入改造报告的「需要源码配合才能行为化」清单。
 */
it("视图内联模板：状态值排在匹配图标之前（源码级）", () => {
  const searchView = readFileSync(
    resolve(process.cwd(), "src/entries/options/views/Overview/SearchEntity/Index.vue"),
    "utf8",
  );
  const clientView = readFileSync(
    resolve(process.cwd(), "src/entries/options/views/Overview/MyClient/Index.vue"),
    "utf8",
  );

  expect(searchView).toMatch(
    /class="status-btn__item"[^>]*>\s*\{\{\s*searchPlanStatus\.success\s*\}\}\s*<CheckOutlined/,
  );
  expect(clientView).toMatch(/<span class="status-btn__item">\s*\{\{\s*allTorrents\.length\s*\}\}\s*<DatabaseOutlined/);
});
