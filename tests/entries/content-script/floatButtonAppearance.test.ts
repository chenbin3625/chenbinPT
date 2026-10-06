import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const app = readFileSync(resolve(import.meta.dirname, "../../../src/entries/content-script/app/App.vue"), "utf8");
const css = readFileSync(resolve(import.meta.dirname, "../../../src/entries/content-script/app/app.css"), "utf8");

describe("PT 站点主悬浮按钮", () => {
  it("Logo 不超过图标槽尺寸，避免被 FloatButton 的 overflow 裁切", () => {
    const avatarSize = Number(app.match(/<a-avatar[\s\S]*?:size="(\d+)"/)?.[1]);
    const iconRule = css.match(
      /\.ptd-content-script-draggable\s+\.ant-float-btn-group\s*>\s*\.ant-float-btn\s+\.ant-float-btn-body\s+\.ant-float-btn-icon\s*\{([^}]+)\}/,
    )?.[1];
    const iconWidth = Number(iconRule?.match(/width:\s*(\d+)px/)?.[1]);

    expect(avatarSize).toBeGreaterThan(0);
    expect(iconWidth).toBeGreaterThanOrEqual(avatarSize);
  });
});
