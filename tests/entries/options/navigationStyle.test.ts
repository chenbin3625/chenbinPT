/**
 * 左侧导航的紧凑字号。
 *
 * Q-3 改造：原断言对 `style.css` 做源码正则（`/#ptd-navigation .ant-menu-...\{[\s\S]*?font-size:\s*13px;/`
 * 加上一条「不得是 16px」的否定式）。前者只证明"某条规则写了 13px"，不证明它真的生效
 * （可能被后面的规则覆盖）；后者更是同义反复。
 * 现在读 `getComputedStyle` 的计算值：侧栏内菜单文案必须是 13px，且侧栏外同名的 antd 节点不受影响
 * —— 后者顺带守住"选择器限定在 #ptd-navigation 内"这个意图。
 */
import { expect, it } from "vitest";

import { computedStyle, loadOptionsStyles, mountDom } from "../../helpers/optionsView.ts";

it("左侧导航的菜单文案使用紧凑字号，且只作用于侧栏内", () => {
  loadOptionsStyles();

  const { root, unmount } = mountDom(`
    <div id="ptd-navigation">
      <div class="ant-menu-item-group-title">分组标题</div>
      <span class="ant-menu-title-content">菜单项</span>
    </div>
    <span class="ant-menu-title-content">页面里同名的 antd 节点</span>
  `);

  expect(computedStyle(root.querySelector("#ptd-navigation .ant-menu-item-group-title")!, "font-size")).toBe("13px");
  expect(computedStyle(root.querySelector("#ptd-navigation .ant-menu-title-content")!, "font-size")).toBe("13px");
  // 侧栏外的同名节点保持 antd 默认字号（不是 13px），证明规则没有被写成全局
  expect(computedStyle(root.querySelectorAll(".ant-menu-title-content")[1]!, "font-size")).not.toBe("13px");

  unmount();
});
