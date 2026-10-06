import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../../src/entries/content-script/app");
const app = readFileSync(resolve(root, "App.vue"), "utf8");
const css = readFileSync(resolve(root, "app.css"), "utf8");
const button = readFileSync(resolve(root, "components/SpeedDialBtn.vue"), "utf8");
const zh = JSON.parse(readFileSync(resolve(root, "../../../locales/zh_CN.json"), "utf8"));
const en = JSON.parse(readFileSync(resolve(root, "../../../locales/en.json"), "utf8"));

describe("Shadow DOM 内的悬浮按钮组", () => {
  it("在冒出 shadow root 前拦截内部点击，由主按钮显式切换状态", () => {
    expect(app).toContain('@click.stop="handleSpeedDialClick"');
    expect(app).toContain("openSpeedDial.value = !openSpeedDial.value");
    expect(app).toContain("event.target instanceof Element");
    expect(app).toContain('closest(".ant-float-btn-group > .ant-float-btn")');
  });

  it("展开项宽于圆形入口、图文横排且菜单向上展开", () => {
    expect(css).toMatch(
      /\.ptd-content-script-draggable\s+\.ant-float-btn-group\s+\.ant-float-btn-group-wrap\s*\{[^}]*position:\s*absolute;[^}]*bottom:\s*calc\(100% \+ 8px\)/,
    );
    expect(css).toMatch(/\.ant-float-btn-group-square\s+\.ant-float-btn-group-wrap\s*\{[^}]*width:\s*132px/);
    expect(css).toMatch(/\.ant-float-btn-group-square[^{}]*\s+\.ant-float-btn-body\s*\{[^}]*width:\s*100%/);
    expect(css).toMatch(
      /\.ant-float-btn-group-square\s+\.ant-float-btn-group-wrap[^{}]*\s+\.ant-float-btn-content\s*\{[^}]*flex-direction:\s*row/,
    );
    expect(css).not.toMatch(/\.ant-float-btn-group-square\s+\.ant-float-btn-body\s+\.ant-float-btn-content\s*\{/);
    expect(css).toMatch(
      /\.ant-float-btn-group-square[^{}]*\s+\.ant-float-btn-description\s*\{[^}]*white-space:\s*nowrap/,
    );
  });

  it("短标签为三到四个汉字，完整标题仍用于 tooltip", () => {
    const labels = zh.contentScript.speedDial;
    expect(labels).toBeDefined();
    expect(Object.keys(labels)).toEqual(
      expect.arrayContaining([
        "localDownload",
        "copyLink",
        "pushTo",
        "pushToDefault",
        "advanceList",
        "quickSearch",
        "openPTD",
      ]),
    );
    for (const [key, label] of Object.entries(labels)) {
      expect(label, key).toMatch(/^[\u4e00-\u9fff]{3,4}$/);
      expect(en.contentScript.speedDial[key], key).toBeTruthy();
    }
    expect(button).toContain("{{ label ?? title }}");
    expect(button).toContain(':tooltip="title"');
  });
});
