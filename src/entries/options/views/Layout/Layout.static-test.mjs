import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import assert from "node:assert/strict";

const __dirname = dirname(fileURLToPath(import.meta.url));
const topbar = readFileSync(resolve(__dirname, "Topbar.vue"), "utf8");
const recommendationMenu = readFileSync(resolve(__dirname, "RecommendationMenu.vue"), "utf8");
const style = readFileSync(resolve(__dirname, "../../style.css"), "utf8");

function cssBlock(selector) {
  const start = style.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `${selector} should exist`);
  const end = style.indexOf("\n}", start);
  return style.slice(start, end === -1 ? style.length : end);
}

const searchGroup = cssBlock(".ptd-search-input");
assert.match(searchGroup, /height:\s*32px;/, "search group should have the same fixed height as middle controls");
assert.match(searchGroup, /align-items:\s*stretch;/, "search group should stretch all controls to one height");
assert.match(style, /\.ptd-search-input\s*>\s*\.ptd-search-key\s*{[\s\S]*?flex:\s*1 1 auto;/);
assert.match(topbar, /<a-space-compact class="ptd-search-input"[^>]*>/);
assert.match(searchGroup, /margin-left:\s*auto;/, "search group should sit on the right side of the topbar");
assert.doesNotMatch(
  topbar,
  /justify-content/,
  "the topbar stays a plain flex row; the right alignment comes from the search group",
);

const recommendationPanel = cssBlock(".hot-recommendation-panel");
// 气泡（面板 + popover 24px 内边距）必须塞得进「火苗图标右边缘 -> 视口左侧」，
// 否则 rc-align 会把气泡水平平移进视口，箭头就脱离图标了。
assert.match(
  recommendationPanel,
  /width:\s*min\(1120px,\s*calc\(100vw\s*-\s*104px\)\);/,
  "recommendation panel must leave room for the fire icon's right offset",
);
assert.match(recommendationPanel, /max-width:\s*calc\(100vw\s*-\s*104px\);/);
assert.match(
  recommendationMenu,
  /<a-popover[^>]*placement="bottomRight"/,
  "the recommendation popover must stay anchored to the fire icon (bottomRight)",
);
assert.match(style, /\.hot-recommendation-list\s*{[\s\S]*?max-height:\s*560px;/);

/* ---- 海报固定 60x84：<a-image> 把 class 透传到内部 <img>，外层 .ant-image 才是 flex 子项 ---- */
const posterBox = cssBlock(".hot-recommendation-item > .ant-image");
assert.match(posterBox, /flex:\s*0 0 60px;/, "poster wrapper must be a fixed-width flex item");
assert.match(posterBox, /width:\s*60px;/, "poster wrapper must have a fixed width");
assert.match(posterBox, /height:\s*84px;/, "poster wrapper must have a fixed height");

// antd 自带 `:where(...).ant-image .ant-image-img { width: 100%; height: auto }` 是 (0,2,0)，
// 优先级高于单个 class；海报图片必须用更高的优先级把尺寸锁死，否则会按原始海报比例变高。
const posterImg = cssBlock(".hot-recommendation-item .hot-recommendation-poster.ant-image-img");
assert.match(posterImg, /width:\s*60px;/, "poster image must override antd's width: 100%");
assert.match(posterImg, /height:\s*84px;/, "poster image must override antd's height: auto");
assert.match(posterImg, /object-fit:\s*cover;/, "poster image must be cropped into the fixed box");

assert.match(style, /\.hot-recommendation-item\s*{[\s\S]*?min-height:\s*118px;/);
assert.doesNotMatch(recommendationMenu, /<a-tag\b[^>]*\scolor=/, "recommendation tags should keep one neutral color");

/* ---- 热门推荐：标签紧凑排列 + 海报与右侧文字之间留空隙 ---- */
const metaRow = cssBlock(".hot-recommendation-meta");
assert.match(metaRow, /gap:\s*4px;/, "the tag row must be laid out by a single compact 4px gap");
const metaTag = cssBlock(".hot-recommendation-meta .ant-tag");
// antd 的 <a-tag> 自带 margin-inline-end: 8px，不清掉的话标签实际间距是 4 + 8 = 12px。
assert.match(metaTag, /margin-inline-end:\s*0;/, "antd's tag right margin must be cleared or tags sit 12px apart");
// .ant-list-item 是 flex 容器但 body 带 flex: 1 1 auto，space-between 生效不了，必须显式 gap。
assert.match(
  cssBlock(".hot-recommendation-item"),
  /gap:\s*8px;/,
  "poster and the text on its right must be separated by an explicit gap",
);

/* ---- 左侧导航固定 + 使用 antd 原生的折叠触发器 ---- */
const navigation = readFileSync(resolve(__dirname, "Navigation.vue"), "utf8");
const navigationCss = cssBlock("#ptd-navigation");
assert.match(navigationCss, /position:\s*sticky;/, "left navigation should stick to the viewport");
assert.match(navigationCss, /align-self:\s*flex-start;/, "left navigation should not be stretched by the flex row");
assert.match(
  navigationCss,
  /height:\s*calc\(100vh\s*-\s*56px\);/,
  "left navigation should fill the area below the topbar",
);
assert.match(navigation, /<a-layout-sider[\s\S]*?collapsible[\s\S]*?@update:collapsed="onNavBarCollapsed"/);
assert.doesNotMatch(navigation, /:trigger="null"/, "the native sider trigger must not be disabled");
assert.doesNotMatch(topbar, /updateNavBarOpenStatus|navBarTip/, "the topbar must not draw its own collapse button");

/* ---- 页面工具条：所有页面共用同一个工具条类，按钮与搜索框同排 ---- */
const toolbarClass = "page-toolbar";
assert.match(style, new RegExp(`\\.${toolbarClass}\\s*\\{`), `.${toolbarClass} must have a style rule`);

const toolbarViews = [
  "Settings/SetSite/Index.vue",
  "Settings/SetDownloader/Index.vue",
  "Settings/SetMediaServer/Index.vue",
  "Settings/SetSearchSolution/Index.vue",
  "Settings/SetBackup/Index.vue",
  "Overview/SearchEntity/Index.vue",
  "Overview/DownloadHistory/Index.vue",
  "Overview/MyData/Index.vue",
  "Overview/SearchResultSnapshot/Index.vue",
  "Overview/MediaServerEntity/Index.vue",
];
for (const view of toolbarViews) {
  const source = readFileSync(resolve(__dirname, "..", view), "utf8");
  assert.match(source, new RegExp(`class="${toolbarClass}"`), `${view} toolbar must use .${toolbarClass}`);
}

/* ---- 侧栏菜单文案一律收缩到 2~4 个字，侧栏宽度随之收窄 ---- */
const siderWidth = Number(navigation.match(/:width="(\d+)"/)?.[1]);
assert.ok(
  Number.isFinite(siderWidth) && siderWidth >= 128 && siderWidth <= 180,
  `left navigation width should stay narrow (128~180), got ${siderWidth}`,
);
assert.match(navigation, /:collapsed-width="display\.smAndUp\.value \? 64 : 0"/);
assert.match(
  style,
  /#ptd-navigation \.ant-menu-item-group-title,\s*#ptd-navigation \.ant-menu-title-content\s*\{[\s\S]*?font-size:\s*13px;/,
  "left navigation menu text should stay compact",
);

const routeLabels = JSON.parse(readFileSync(resolve(__dirname, "../../../../locales/zh_CN.json"), "utf8")).route;
const routeLabelEntries = Object.entries(routeLabels).flatMap(([group, labels]) =>
  Object.entries(labels).map(([key, value]) => [`${group}.${key}`, value]),
);
for (const [key, value] of routeLabelEntries) {
  assert.ok(
    [...value].length >= 2 && [...value].length <= 4,
    `route label ${key} must be 2~4 characters to fit the narrowed sidebar, got ${JSON.stringify(value)}`,
  );
}
