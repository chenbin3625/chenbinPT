/**
 * 左侧导航的字号。
 *
 * 侧栏菜单不再单独写 font-size：它现在继承 `#ptd` 的正文基准 13px（token.fontSize）。
 * 断言仍读 `getComputedStyle` 的计算值：侧栏内文案必须是 13px，且侧栏外（#ptd 之外）的
 * 同名 antd 节点不受影响 —— 后者守住「字号来自 #ptd 继承、没有写成全局规则」。
 */
import { expect, it } from "vitest";

import { computedStyle, loadOptionsStyles, mountDom } from "../../helpers/optionsView.ts";

it("左侧导航的菜单文案继承正文基准 13px，且只作用于 #ptd 内", () => {
  loadOptionsStyles();

  const { root, unmount } = mountDom(`
    <div id="ptd">
      <div id="ptd-navigation">
        <div class="ant-menu-item-group-title">分组标题</div>
        <span class="ant-menu-title-content">菜单项</span>
      </div>
    </div>
    <span class="ant-menu-title-content">页面里同名的 antd 节点</span>
  `);

  const shell = root.querySelector("#ptd")!;
  expect(computedStyle(shell, "font-size")).toBe("13px");
  expect(computedStyle(root.querySelector("#ptd-navigation .ant-menu-item-group-title")!, "font-size")).toBe("13px");
  expect(computedStyle(root.querySelector("#ptd-navigation .ant-menu-title-content")!, "font-size")).toBe("13px");
  // 菜单文案与容器基准同值（说明是继承，而不是某条 13px 的局部规则）
  expect(computedStyle(root.querySelector("#ptd-navigation .ant-menu-title-content")!, "font-size")).toBe(
    computedStyle(shell, "font-size"),
  );
  // 侧栏外的同名节点保持浏览器默认字号（不是 13px），证明规则没有被写成全局
  expect(computedStyle(root.querySelectorAll(".ant-menu-title-content")[1]!, "font-size")).not.toBe("13px");

  unmount();
});
