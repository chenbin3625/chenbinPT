/**
 * 我的数据「等级要求」浮层。
 *
 * Q-3 改造：原断言直接读 `UserLevelRequirementsTd.vue` 源码文本，断言里面出现
 * `<a-popover` / `<template #content>`，且不出现 `<a-tooltip` / `<template #title>` / `<a-card`。
 * 那只是在数标签字符串：把 Popover 换成别的实现、或浮层内容搬进子组件，断言就失真。
 *
 * 现在真实挂载组件并在**悬停后检查文档里实际渲染出的浮层**：
 * - 出现 antd 的白色 Popover 外壳（`.ant-popover`），而不是 Tooltip 的深色外壳（`.ant-tooltip`）；
 * - 浮层内容走的是 content 插槽（渲染出等级列表），不是只渲染标题；
 * - 内容里没有 `a-card` 那层卡片包裹；
 * - 悬停前不渲染浮层（触发方式确实是 hover）。
 */
import { describe, expect, it, vi } from "vitest";

import { mountOptionsView, prepareOptionsPinia } from "../../helpers/optionsView.ts";

const levelRequirement = {
  id: 2,
  name: "Power User",
  groupType: "user",
  privilege: "可以下载更多种子",
  interval: "P4W",
  seedingSize: "100GB",
  seedingBonus: 1000,
};

const userInfo = {
  site: "mteam",
  levelName: "User",
  levelId: 1,
  joinTime: 1_700_000_000,
  uploaded: 0,
  downloaded: 0,
  ratio: 1,
  seedingSize: 0,
  seedingBonus: 0,
} as any;

/** 行级站点元数据缓存是模块级单例，这里替换成直接返回可控数据（该缓存的自身逻辑不在此用例范围） */
vi.mock("@/options/views/Overview/MyData/utils/siteMetadataCache.ts", () => ({
  getSiteLevelMetadata: () => ({ levelRequirements: [levelRequirement], userInfo: undefined }),
}));

vi.mock("@/messages.ts", () => ({ sendMessage: vi.fn(), onMessage: vi.fn() }));

/** 子组件会去读站点元数据 / 画进度条，本用例只关心浮层外壳与内容插槽 */
vi.mock("@/options/views/Overview/MyData/UserLevelsComponent.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    default: defineComponent({
      name: "UserLevelsComponentStub",
      setup: () => () => h("span", { class: "stub-level-requirement" }, "要求明细"),
    }),
  };
});
vi.mock("@/options/views/Overview/MyData/UserNextLevelUnMet.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    default: defineComponent({
      name: "UserNextLevelUnMetStub",
      setup: () => () => h("span", { class: "stub-next-level" }, "距离下一级"),
    }),
  };
});

/** 浮层会 teleport 到 body，因此断言必须查 document */
const popoversInDocument = () => Array.from(document.querySelectorAll(".ant-popover"));
const tooltipsInDocument = () => Array.from(document.querySelectorAll(".ant-tooltip"));

/**
 * antd Popover 把 trigger 事件绑在它包裹的那个子元素上，而 mouseenter 不冒泡，
 * 因此在宿主里的每个 span 上都派发一次（外层的 `<span v-if="levelName">` 不会替内层代收）。
 */
const hoverAllSpans = (view: { $$: (selector: string) => HTMLElement[] }) => {
  for (const element of view.$$("span")) {
    element.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
  }
};

const cleanupOverlays = () => {
  document.querySelectorAll(".ant-popover, .ant-tooltip").forEach((element) => element.remove());
};

async function mountLevelCell() {
  const pinia = prepareOptionsPinia();
  const { useConfigStore } = await import("@/options/stores/config.ts");
  const { default: UserLevelRequirementsTd } =
    await import("@/options/views/Overview/MyData/UserLevelRequirementsTd.vue");

  const configStore = useConfigStore();
  configStore.myDataTableControl.showLevelRequirement = true;
  configStore.myDataTableControl.onlyShowUserLevelRequirement = false;
  configStore.myDataTableControl.showNextLevelInDialog = false;

  const view = mountOptionsView(UserLevelRequirementsTd, { props: { userInfo }, pinia });
  await view.settle();
  return view;
}

describe("我的数据等级要求浮层", () => {
  it("悬停前不渲染浮层；悬停后渲染的是 Popover 而不是 Tooltip", async () => {
    cleanupOverlays();
    const view = await mountLevelCell();

    const spans = view.$$("span");
    expect(spans.length, "等级单元格应渲染出内容").toBeGreaterThan(0);
    expect(popoversInDocument(), "未悬停时不应渲染浮层").toHaveLength(0);

    hoverAllSpans(view);
    await view.settle(300);

    expect(popoversInDocument().length, "悬停应渲染出 Popover 浮层").toBeGreaterThan(0);
    // 反证旧实现：不得退化成 Tooltip 的深色外壳
    expect(tooltipsInDocument(), "不应使用 Tooltip 外壳").toHaveLength(0);

    view.unmount();
    cleanupOverlays();
  });

  it("浮层内容来自 content 插槽：渲染出等级要求明细，且没有额外的 a-card 包裹", async () => {
    cleanupOverlays();
    const view = await mountLevelCell();

    hoverAllSpans(view);
    await view.settle(300);

    const popover = document.querySelector<HTMLElement>(".ant-popover")!;
    expect(popover, "应渲染出 Popover").not.toBeNull();

    // content 插槽真的被渲染（不是只渲染了 title）
    expect(popover.querySelector(".ant-popover-title"), "不应使用 Popover 的 title 插槽").toBeNull();
    expect(popover.textContent, "浮层应列出等级名称").toContain("Power User");
    expect(popover.querySelector(".stub-level-requirement"), "等级要求明细组件应渲染进内容区").not.toBeNull();
    // 不再多套一层卡片
    expect(popover.querySelector(".ant-card"), "浮层里不应再套 a-card").toBeNull();

    view.unmount();
    cleanupOverlays();
  });
});
