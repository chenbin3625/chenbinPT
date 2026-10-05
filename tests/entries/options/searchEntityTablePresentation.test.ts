/**
 * 搜索结果 / 下载历史的表格展示。
 *
 * Q-3 改造：原用例有 9 条断言读 `.vue` 源码文本（数 `<a-tag>` 子块里有没有 `closable`、
 * 正则匹配 `display.smAndDown.value ... "32vw" ... "24vw"` 等）。重构即红、行为坏掉却可能照样绿。
 * 现在把**组件级**的展示规则改成真实挂载后查渲染结果：
 * - 标题标签是否可关闭 / 是否是中性色 / 点击是否真的不改变标签集合 → 直接点一下看结果；
 * - `maxWidth` prop 是否真的落到省略容器的内联样式上 → 传 prop 后读 DOM。
 *
 * 仍保留源码级的 5 条见文件末尾「只能源码级」区块的说明（它们定义在 576 / 800 行的视图内部，
 * 没有可导入的模块边界，行为化需要先把那段 computed 抽出去 —— 属于需要源码配合的改动）。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { formatDateTimeForTable } from "@/options/utils.ts";
import { computedStyle, mountOptionsView, prepareOptionsPinia } from "../../helpers/optionsView.ts";

vi.mock("@/messages.ts", () => ({ sendMessage: vi.fn(), onMessage: vi.fn() }));

const TAGS = [{ name: "中字" }, { name: "HDR" }, { name: "完结" }] as any;

let TorrentTitleTd: any;

beforeEach(async () => {
  const pinia = prepareOptionsPinia();
  TorrentTitleTd = (await import("@/options/components/TorrentTitleTd.vue")).default;

  const { useConfigStore } = await import("@/options/stores/config.ts");
  const configStore = useConfigStore();
  configStore.searchEntifyControl.showTorrentTag = true;
  configStore.searchEntifyControl.showTorrentSubtitle = false;
  configStore.searchEntifyControl.showSocialInformation = false;
  configStore.searchEntifyControl.maxTagCountBeforeGroup = 0;
  configStore.searchEntifyControl.hiddenTagNames = [];

  return pinia;
});

describe("搜索结果表格展示", () => {
  it("日期时间按日期和时间分成两行", () => {
    expect(formatDateTimeForTable(new Date(2026, 0, 2, 3, 4, 5))).toBe("2026-01-02\n03:04:05");
  });
});

describe("种子标题单元格（渲染行为）", () => {
  it("标签渲染成中性色的 a-tag，且不提供删除入口", async () => {
    const view = mountOptionsView(TorrentTitleTd, {
      props: { item: { title: "种子标题", tags: TAGS } },
      pinia: prepareOptionsPinia(),
      router: true,
    });
    await view.settle();

    const tags = view.$$(".ant-tag");
    expect(tags.map((tag) => tag.textContent?.trim())).toEqual(TAGS.map((tag: any) => tag.name));

    for (const tag of tags) {
      // 没有关闭按钮（旧实现带 closable + @close，用户能临时隐藏标签却无法恢复）
      expect(tag.querySelector(".ant-tag-close-icon")).toBeNull();
      // 中性色：color="default" 的实际效果是渲染 .ant-tag-default（而 color="green" 之类
      // 会渲染 .ant-tag-green）；旧实现用 resolveColor(tag.color) 算出动态色，会写内联 background/color
      expect(tag.classList.contains("ant-tag-default"), '标签应使用中性色（antd 的 color="default"）').toBe(true);
      const presetColorClasses = Array.from(tag.classList).filter(
        (name) => name.startsWith("ant-tag-") && name !== "ant-tag-default",
      );
      expect(presetColorClasses, `标签不应带预设色类：${presetColorClasses.join(",")}`).toEqual([]);
      expect(tag.getAttribute("style") ?? "").not.toMatch(/background|(^|;)\s*color/);
    }

    view.unmount();
  });

  it("点击标签不会把它从列表里移除（没有临时隐藏逻辑）", async () => {
    const view = mountOptionsView(TorrentTitleTd, {
      props: { item: { title: "种子标题", tags: TAGS } },
      pinia: prepareOptionsPinia(),
      router: true,
    });
    await view.settle();

    const before = view.$$(".ant-tag").length;
    for (const tag of view.$$(".ant-tag")) tag.click();
    await view.settle();

    expect(view.$$(".ant-tag").length).toBe(before);

    view.unmount();
  });

  it("maxWidth prop 真的落到省略容器的内联 max-width 上（不传时用样式表兜底 20rem）", async () => {
    const withProp = mountOptionsView(TorrentTitleTd, {
      props: { item: { title: "很长的种子标题", tags: [] }, maxWidth: "24vw" },
      pinia: prepareOptionsPinia(),
      router: true,
    });
    await withProp.settle();

    const boundRoot = withProp.host.firstElementChild as HTMLElement;
    expect(boundRoot.style.maxWidth, "表格传入的 maxWidth 应内联到根容器").toBe("24vw");
    expect(boundRoot.style.minWidth, "同时要给出 minWidth: 0，否则 flex 子项无法收缩省略").toBe("0");
    withProp.unmount();

    const withoutProp = mountOptionsView(TorrentTitleTd, {
      props: { item: { title: "很长的种子标题", tags: [] } },
      pinia: prepareOptionsPinia(),
      router: true,
    });
    await withoutProp.settle();

    const plainRoot = withoutProp.host.firstElementChild as HTMLElement;
    expect(plainRoot.style.maxWidth, "未传入时不应内联 max-width，交给样式表兜底").toBe("");
    withoutProp.unmount();
  });
});

describe("种子标题单元格的省略规则（样式行为）", () => {
  it("标题单行省略，副标题走共享省略容器（默认限宽 20rem）", async () => {
    const { loadOptionsStyles } = await import("../../helpers/optionsView.ts");
    loadOptionsStyles();

    const pinia = prepareOptionsPinia();
    const { useConfigStore } = await import("@/options/stores/config.ts");
    useConfigStore().searchEntifyControl.showTorrentSubtitle = true;

    const view = mountOptionsView(TorrentTitleTd, {
      props: { item: { title: "很长的种子标题", subTitle: "很长的副标题", tags: [] } },
      pinia,
      router: true,
    });
    await view.settle();

    // 主标题：内联单行省略（不依赖样式表，弹层/表格里都能生效）
    const titleSpan = view.$$("span").find((element) => element.textContent === "很长的种子标题");
    expect(titleSpan, "应渲染出主标题容器").toBeDefined();
    expect(computedStyle(titleSpan!, "text-overflow")).toBe("ellipsis");
    expect(computedStyle(titleSpan!, "white-space")).toBe("nowrap");
    expect(computedStyle(titleSpan!, "overflow")).toBe("hidden");

    // 副标题：共享 .ptd-cell-ellipsis（兜底 20rem = 320px，可由 --ptd-cell-max-width 覆盖）
    const ellipsis = view.$(".ptd-cell-ellipsis")!;
    expect(ellipsis, "副标题应使用共享的省略容器").not.toBeNull();
    expect(computedStyle(ellipsis, "max-width")).toBe("320px");
    expect(computedStyle(ellipsis, "text-overflow")).toBe("ellipsis");

    view.unmount();
  });
});

/**
 * 只能源码级的 5 条 —— 为什么这里必须是源码级断言：
 *
 * 下面这些规则定义在 `views/Overview/SearchEntity/Index.vue`（576 行）与
 * `views/Overview/DownloadHistory/Index.vue` 的 `<script setup>` / 模板内部，**没有可导入的
 * 模块边界**：`titleColumnMaxWidth` 是视图内的 computed，`a-table` 的 loading 也是视图内的内联表达式。
 * 要行为化必须先改 `src/**`（把这段 computed 抽成 composable、或抽出表格组件）—— 那不在本次改动范围内，
 * 因此按「保留为源码级 + 说明」处理，并明确记为需要源码配合的条目（见改造报告）。
 * 这里至少把断言收紧到「结构 + 关键表达式」，并保留一条防止规则整体消失的自证。
 */
describe("视图级宽度 / loading 规则（源码级，需源码配合才能行为化）", () => {
  const readSource = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

  it("搜索结果页：搜索中已有结果时不再显示表格 loading", () => {
    const source = readSource("src/entries/options/views/Overview/SearchEntity/Index.vue");

    expect(source).toContain(
      ':loading="runtimeStore.search.isSearching && runtimeStore.search.searchResult.length === 0"',
    );
  });

  it("搜索结果页与下载历史页：标题列桌面端不限宽（吃满剩余宽度），仅移动端保留 32vw 上限", () => {
    const searchEntity = readSource("src/entries/options/views/Overview/SearchEntity/Index.vue");
    const downloadHistory = readSource("src/entries/options/views/Overview/DownloadHistory/Index.vue");

    for (const source of [searchEntity, downloadHistory]) {
      // 两页都改用共享的判定函数（规则本身由 antdTable.test 行为化断言）
      expect(source).toContain("titleColumnMaxWidthFor(display.smAndDown.value)");
      // 桌面端不再写死 24vw：那正是「取消列展示后标题右侧留下大片空白」的成因
      expect(source, "视图内不应再出现桌面端的 24vw 上限").not.toContain("24vw");
    }
    expect(downloadHistory).toContain(':max-width="titleColumnMaxWidth"');
  });

  it("展示偏好弹层中先显示文案再显示开关", () => {
    const source = readSource("src/entries/options/views/Overview/SearchEntity/Index.vue");
    const controlBlock =
      source.match(/<a-list-item v-for="item in filteredTableBooleanControlKeys"[\s\S]*?<\/a-list-item>/)?.[0] ?? "";

    expect(controlBlock, "应能定位到展示偏好的列表项").not.toBe("");
    expect(controlBlock).toMatch(/<span[^>]*>\{\{ t\("SearchEntity\.index\." \+ item\) \}\}<\/span>[\s\S]*<a-switch/);
  });
});
