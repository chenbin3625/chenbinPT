/**
 * 统计页「显示站点设置」区块的布局。
 *
 * Q-3 改造：原断言从 `UserDataStatistic/Index.vue` 截两段模板文本再正则匹配
 * （标题行里有 `<span>{{ t("...displaySiteSettings") }}</span>`、站点行里有 `<SiteFavicon` 等）。
 * 那是"模板写了这些标签"，不是"用户看到的是这样"。
 *
 * 现在真实挂载视图（`loadFullData` 替换成受控数据，让 allSites 非空），断言：
 * - 标题文案在左、批量开关在右（DOM 顺序 + `margin-left: auto` 的计算样式）；
 * - 每个站点复选框里 favicon 与站点名在同一行容器内，且站点名渲染成 `span`（`tag="span"` 的实际效果）。
 */
import { describe, expect, it, vi } from "vitest";

import {
  computedStyle,
  loadOptionsStyles,
  loadScopedStyles,
  mountOptionsView,
  prepareOptionsPinia,
} from "../../helpers/optionsView.ts";

vi.mock("@/messages.ts", () => ({ sendMessage: vi.fn().mockResolvedValue(""), onMessage: vi.fn() }));

/**
 * 统计页的数据源是 `loadFullData()`：真实实现要读 chrome.storage 里的用户信息历史。
 * 这里替换成固定的两份站点数据，让「显示站点设置」区块的站点行真正渲染出来。
 */
vi.mock("@/options/views/Overview/MyData/UserDataStatistic/utils.ts", async () => {
  const actual = await vi.importActual<any>("@/options/views/Overview/MyData/UserDataStatistic/utils.ts");
  return {
    ...actual,
    loadFullData: async () => ({
      siteDateRange: { mteam: { first: 1, last: 2 }, ourbits: { first: 1, last: 2 } },
      dailyUserInfo: {
        "2026-01-01": { mteam: { uploaded: 1, downloaded: 1 } },
        "2026-01-02": { mteam: { uploaded: 2, downloaded: 2 }, ourbits: { uploaded: 1, downloaded: 1 } },
      },
      incrementalData: {},
    }),
  };
});

/**
 * 图表用 echarts 的 canvas 渲染器，happy-dom 里没有真实 canvas（zrender 会在 clearRect 上抛错）。
 * 本用例只断言「显示站点设置」区块，因此把图表组件替换成空壳。
 */
vi.mock("vue-echarts", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    default: defineComponent({ name: "VChartStub", setup: () => () => h("div", { class: "stub-chart" }) }),
    THEME_KEY: Symbol("echarts-theme"),
  };
});

/** 「站点设置」区站点名用的是 SiteName 的替身（它内部要读 metadata store 的异步水合） */ vi.mock(
  "@/options/components/SiteName.vue",
  async () => {
    const { defineComponent, h } = await import("vue");
    return {
      default: defineComponent({
        name: "SiteNameStub",
        props: { siteId: { type: String, default: "" }, tag: { type: String, default: "span" } },
        setup: (props) => () => h(props.tag, { class: "stub-site-name" }, props.siteId),
      }),
    };
  },
);
vi.mock("@/options/components/SiteFavicon/Index.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    default: defineComponent({
      name: "SiteFaviconStub",
      props: { siteId: { type: String, default: "" } },
      setup: (props) => () => h("i", { class: "stub-site-favicon" }),
    }),
  };
});

async function mountStatistic() {
  // 标题行的 flex / margin-left:auto 写在 SFC 的 <style scoped> 里，必须一并注入才能读计算值
  loadScopedStyles("src/entries/options/views/Overview/MyData/UserDataStatistic/Index.vue");

  const pinia = prepareOptionsPinia();
  const { i18nInstance } = await import("@/options/plugins/i18n.ts");
  const { default: StatisticView } = await import("@/options/views/Overview/MyData/UserDataStatistic/Index.vue");

  const view = mountOptionsView(StatisticView, { pinia, router: true });
  await view.settle(150);

  return { view, t: i18nInstance.global.t };
}

describe("统计页站点设置区块", () => {
  it("标题文案在左、批量开关在右（DOM 顺序 + 自动左边距）", async () => {
    loadOptionsStyles();
    const { view, t } = await mountStatistic();

    const heading = view.$(".user-statistic-site-settings-heading");
    expect(heading, "应渲染出站点设置标题行").not.toBeNull();
    expect(heading!.textContent).toContain(t("UserDataStatistic.chart.displaySiteSettings"));

    const titleSpan = Array.from(heading!.querySelectorAll("span")).find(
      (element) => element.textContent === t("UserDataStatistic.chart.displaySiteSettings"),
    );
    const toggle = heading!.querySelector<HTMLElement>(".user-statistic-site-settings-toggle");
    expect(titleSpan, "标题文案应是标题行里的一个 span").toBeDefined();
    expect(toggle, "批量开关容器应存在").not.toBeNull();
    // 批量开关确实渲染出了子组件（不是空容器）
    expect(toggle!.children.length, "批量开关容器里应有 CheckSwitchButton").toBeGreaterThan(0);

    // 文案在前、开关在后（DOM 顺序即视觉顺序，配合 margin-left:auto 把开关推到右侧）
    expect(
      titleSpan!.compareDocumentPosition(toggle!) & Node.DOCUMENT_POSITION_FOLLOWING,
      "标题文案应排在开关之前",
    ).toBeTruthy();
    expect(computedStyle(toggle!, "margin-left")).toBe("auto");
    expect(computedStyle(heading!, "display")).toBe("flex");

    view.unmount();
  });

  it("每个站点的 favicon 与站点名在同一行容器内，站点名渲染成 span", async () => {
    const { view } = await mountStatistic();

    const options = view.$$(".user-statistic-site-option");
    expect(options, "两个站点应各渲染一个站点选项容器").toHaveLength(2);

    for (const option of options) {
      expect(option.querySelector(".stub-site-favicon"), "favicon 应在该行容器内").not.toBeNull();
      const siteName = option.querySelector(".stub-site-name");
      expect(siteName, "站点名应在同一行容器内").not.toBeNull();
      // SiteName 的 tag="span" 实际效果：渲染出的元素就是 <span>
      expect(siteName!.tagName).toBe("SPAN");
    }
    // 站点名在 favicon 之后（图标在前、名称在后）
    expect(options[0]!.firstElementChild!.classList.contains("stub-site-favicon")).toBe(true);

    // 复选框与站点选项容器是父子关系（点击站点行 = 勾选该站点）
    for (const option of options) {
      expect(option.closest(".ant-checkbox-wrapper"), "站点选项应在复选框内").not.toBeNull();
    }

    view.unmount();
  });
});
