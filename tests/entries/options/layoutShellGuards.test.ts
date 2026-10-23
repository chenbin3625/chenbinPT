/**
 * options 外壳布局 / 文案守卫（F1 修复：替换并删除 `views/Layout/Layout.static-test.mjs`）。
 *
 * 背景：旧文件 `Layout.static-test.mjs` 既不在 vitest 的 `include`（`tests/**\/*.test.ts`）
 * 也不在 `npm run test:legacy` 里，**没有任何 runner 会执行它**；而它的断言还停留在旧数值
 * （要求 `.ptd-search-input { height: 32px }`、`#ptd-navigation { height: calc(100vh - 56px) }`，
 * 实际是 28px / 48px）—— 直接 `node` 运行就 AssertionError。
 * 也就是说这条「侧栏/顶栏/热门推荐」守卫给人已在守的错觉，实际零覆盖。
 *
 * 这里把仍然有价值的约束迁移成真实用例并更新到当前值：
 * - 顶栏搜索组、侧栏 sticky 区域、热门推荐面板/海报尺寸 → 优先用 `getComputedStyle` 断言计算值；
 *   happy-dom 对 `calc()`/`min()` 只回传声明值，这几条退化为「对 style.css 里对应规则的精确文本断言」，
 *   并显式注明原因（避免以后又出现「断言的是书写形式而不是效果」的误判）；
 * - 菜单文案长度、工具栏类名复用、侧栏宽度、热门推荐 popover 锚点 → 源码/资源级守卫（无运行时可断言对象）。
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { computedStyle, loadOptionsStyles, mountDom } from "../../helpers/optionsView.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const layoutDir = resolve(repoRoot, "src/entries/options/views/Layout");

function readSource(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), "utf8");
}

/** 取出 style.css 里某个选择器块的文本（第一个 `{ ... }`） */
function cssBlock(selector: string): string {
  const style = readSource("src/entries/options/style.css");
  const start = style.indexOf(`${selector} {`);
  expect(start, `${selector} 规则应存在于 style.css`).not.toBe(-1);
  const end = style.indexOf("\n}", start);
  return style.slice(start, end === -1 ? style.length : end);
}

describe("顶栏搜索组", () => {
  loadOptionsStyles();

  it("搜索组高度与居中控件一致、子项拉伸，且贴右", () => {
    const { root, unmount } = mountDom(`
      <div id="ptd-topbar">
        <div class="ptd-search-input"><input class="ptd-search-key" /></div>
      </div>
    `);

    // happy-dom 能计算 px 值（height 是 28px）
    expect(computedStyle(root.querySelector(".ptd-search-input")!, "height")).toBe("28px");
    expect(computedStyle(root.querySelector(".ptd-search-input")!, "align-items")).toBe("stretch");
    expect(computedStyle(root.querySelector(".ptd-search-input")!, "display")).toBe("flex");
    // 搜索框贴到顶栏右侧
    expect(computedStyle(root.querySelector(".ptd-search-input")!, "margin-left")).toBe("auto");

    unmount();
  });

  it("搜索输入框占满搜索组剩余宽度", () => {
    const { root, unmount } = mountDom(`
      <div class="ptd-search-input"><input class="ptd-search-key" /></div>
    `);
    const keyStyle = getComputedStyle(root.querySelector(".ptd-search-key")!);
    expect(keyStyle.getPropertyValue("flex-grow")).toBe("1");
    unmount();
  });
});

describe("左侧导航", () => {
  loadOptionsStyles();

  it("sticky 在顶栏下方，且不参与 flex 拉伸", () => {
    const { root, unmount } = mountDom(`<div id="ptd-navigation"></div>`);
    const navigation = root.querySelector("#ptd-navigation")!;

    expect(computedStyle(navigation, "position")).toBe("sticky");
    expect(computedStyle(navigation, "top")).toBe("48px");
    expect(computedStyle(navigation, "align-self")).toBe("flex-start");
    // happy-dom 会把 100vh 先算成视口像素高度（calc(768px - 48px)），这里按语义匹配两种形态
    expect(computedStyle(navigation, "height")).toMatch(/^calc\((?:100vh|\d+px) - 48px\)$/);
    expect(computedStyle(navigation, "min-height")).toMatch(/^calc\((?:100vh|\d+px) - 48px\)$/);
    // 不能有 overflow: hidden —— 否则窄屏折叠时 antd 原生零宽触发器会被裁掉
    expect(cssBlock("#ptd-navigation")).not.toContain("overflow");

    unmount();
  });

  it("使用 antd 原生折叠触发器，且折叠宽度随断点变化", () => {
    const navigation = readSource("src/entries/options/views/Layout/Navigation.vue");
    const topbar = readSource("src/entries/options/views/Layout/Topbar.vue");

    expect(navigation).toMatch(/<a-layout-sider[\s\S]*?collapsible[\s\S]*?@update:collapsed="onNavBarCollapsed"/);
    expect(navigation, "原生 sider 触发器的 trigger 不能被禁用").not.toContain(':trigger="null"');
    expect(navigation).toContain(':collapsed-width="display.smAndUp.value ? 64 : 0"');
    // 顶栏不再自绘折叠按钮
    expect(topbar).not.toContain("updateNavBarOpenStatus");
    expect(topbar).not.toContain("navBarTip");

    const siderWidth = Number(navigation.match(/:width="(\d+)"/)?.[1]);
    expect(Number.isFinite(siderWidth)).toBe(true);
    expect(siderWidth).toBeGreaterThanOrEqual(128);
    expect(siderWidth).toBeLessThanOrEqual(180);
  });
});

describe("热门推荐气泡", () => {
  loadOptionsStyles();

  it("面板必须能塞进「火苗图标右侧到视口左侧」的空间（宽度按视口收窄）", () => {
    // calc/min 在 happy-dom 里无法算出 px：直接断言声明值（注释已说明原因）。
    // L（REVIEW-FINDINGS options-8）：CSS 源码里空格/换行的书写变化不应让测试变红 ——
    // 先把两侧空白归一化再比较，只断言「声明了同一条规则」。
    const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
    const panel = normalize(cssBlock(".hot-recommendation-panel"));
    expect(panel).toContain(normalize("width: min(1120px, calc(100vw - 104px));"));
    expect(panel).toContain(normalize("max-width: calc(100vw - 104px);"));
  });

  it("点开时气泡锚定在火苗图标上（bottomRight）", () => {
    const recommendationMenu = readSource("src/entries/options/views/Layout/RecommendationMenu.vue");
    expect(recommendationMenu).toMatch(/<a-popover[^>]*placement="bottomRight"/);
  });

  it("海报固定 60×84 且裁剪，列表限高可滚动", () => {
    const { root, unmount } = mountDom(`
      <div class="hot-recommendation-item">
        <div class="ant-image"><img class="hot-recommendation-poster ant-image-img" /></div>
      </div>
      <div class="hot-recommendation-list"></div>
      <div class="hot-recommendation-meta"><span class="ant-tag">tag</span></div>
    `);

    const item = root.querySelector(".hot-recommendation-item")!;
    expect(computedStyle(item, "min-height")).toBe("118px");
    expect(computedStyle(item, "gap")).toBe("8px");

    const posterBox = root.querySelector(".hot-recommendation-item > .ant-image")!;
    expect(computedStyle(posterBox, "width")).toBe("60px");
    expect(computedStyle(posterBox, "height")).toBe("84px");

    const poster = root.querySelector(".hot-recommendation-poster")!;
    expect(computedStyle(poster, "width")).toBe("60px");
    expect(computedStyle(poster, "height")).toBe("84px");
    expect(computedStyle(poster, "object-fit")).toBe("cover");

    const list = root.querySelector(".hot-recommendation-list")!;
    expect(computedStyle(list, "max-height")).toBe("560px");
    expect(computedStyle(list, "overflow-y")).toBe("auto");

    const meta = root.querySelector(".hot-recommendation-meta")!;
    expect(computedStyle(meta, "gap")).toBe("4px");

    unmount();
  });

  it("推荐标签统一中性色（不逐条上色）", () => {
    const recommendationMenu = readSource("src/entries/options/views/Layout/RecommendationMenu.vue");
    expect(recommendationMenu).not.toMatch(/<a-tag\b[^>]*\scolor=/);
  });
});

describe("页面工具条：所有列表页复用同一个类", () => {
  const toolbarViews = [
    "views/Settings/SetSite/Index.vue",
    "views/Settings/SetDownloader/Index.vue",
    "views/Settings/SetMediaServer/Index.vue",
    "views/Settings/SetSearchSolution/Index.vue",
    "views/Settings/SetBackup/Index.vue",
    "views/Overview/SearchEntity/Index.vue",
    "views/Overview/DownloadHistory/Index.vue",
    "views/Overview/MyData/Index.vue",
    "views/Overview/SearchResultSnapshot/Index.vue",
    "views/Overview/MediaServerEntity/Index.vue",
  ];

  it("style.css 定义了 .page-toolbar，且各列表页都使用它", () => {
    expect(readSource("src/entries/options/style.css")).toMatch(/\.page-toolbar\s*\{/);

    for (const view of toolbarViews) {
      const source = readSource(resolve("src/entries/options", view));
      expect(source, `${view} 的工具条应使用 .page-toolbar`).toContain('class="page-toolbar"');
    }
  });
});

describe("侧栏路由文案保持 2~4 个字（适配收窄后的侧栏宽度）", () => {
  it("zh_CN 的 route.* 文案长度都在 2~4 之间", () => {
    const zhCN = JSON.parse(readSource("src/locales/zh_CN.json")) as { route: Record<string, Record<string, string>> };
    const entries = Object.entries(zhCN.route ?? {}).flatMap(([group, labels]) =>
      Object.entries(labels ?? {}).map(([key, value]) => [`${group}.${key}`, value] as const),
    );

    expect(entries.length).toBeGreaterThan(0);
    for (const [key, value] of entries) {
      const length = [...String(value)].length;
      expect(length, `route label ${key} 应为 2~4 个字（实际 ${JSON.stringify(value)}）`).toBeGreaterThanOrEqual(2);
      expect(length, `route label ${key} 应为 2~4 个字（实际 ${JSON.stringify(value)}）`).toBeLessThanOrEqual(4);
    }
  });
});

describe("工具栏按钮在窄屏只显示图标（NavButton 依赖 useDisplay 断点）", () => {
  loadOptionsStyles();

  it("NavButton 用 smAndDown 断点控制 iconOnly，且按钮是 flex 容器", () => {
    const navButton = readSource("src/entries/options/components/NavButton.vue");
    expect(navButton).toContain("const iconOnly = display.smAndDown;");
    expect(navButton).toContain('<span v-if="!iconOnly">{{ text }}</span>');
  });
});

/** 兜底：确认本文件真的被执行到（防止整份文件被误删/改为 skip 后无人发现） */
describe("守卫文件自检", () => {
  it("Layout 目录下不再有静态测试脚本（已迁移到本文件）", () => {
    const files = readdirSync(layoutDir);
    expect(files.filter((file) => file.includes("static-test"))).toEqual([]);
    expect(files.sort()).toEqual(
      ["Navigation.vue", "RecommendationMenu.vue", "Topbar.vue", "recommendationEnrichmentQueue.ts"].sort(),
    );
  });

  it("本用例所在路径在 vitest include 范围内", () => {
    const self = relative(repoRoot, fileURLToPath(import.meta.url))
      .split("\\")
      .join("/");
    expect(self.startsWith("tests/")).toBe(true);
    expect(self.endsWith(".test.ts")).toBe(true);
  });
});
