/**
 * 用户数据时间轴 / 统计页的控件语义。
 *
 * Q-3 改造：原用例从 842 行的 `UserDataTimeline/Index.vue` 里**截取模板子块**再正则匹配
 * （`expect(statsBlock).toContain("<a-checkbox")`、`expect(usernameAndTitleBlock).not.toContain(":readonly")`）。
 * 那只是在数标签字符串：把 checkbox 换成同名子组件、把 readonly 挪到组件默认值里、
 * 或者改成不可编辑的实际行为，断言都不会变。
 *
 * 现在真实挂载视图并断言**渲染结果与交互**：
 * - 字段区渲染出复选框而不是开关，数量与配置项一致，且每一项带真实文案（不是裸 i18n key）；
 * - 勾选复选框真的改写 config store（这才是"控件接对了"的证据）；
 * - 用户名 / 标题输入框可直接编辑：`readOnly === false`，且输入真的写回 store。
 */
import { describe, expect, it, vi } from "vitest";

import { mountOptionsView, prepareOptionsPinia } from "../../helpers/optionsView.ts";

vi.mock("@/messages.ts", () => ({ sendMessage: vi.fn(), onMessage: vi.fn() }));

// 时间轴画布依赖 konva（需要真实 canvas），单测里替换成结构化替身；
// 本用例只关心左侧「显示内容」控件区，不关心画布绘制。
vi.mock("konva", () => ({ default: {} }));
vi.mock("vue-konva", async () => {
  const { defineComponent, h } = await import("vue");
  const stub = (name: string) =>
    defineComponent({
      name,
      setup:
        (_props, { slots }) =>
        () =>
          h("div", { class: `stub-${name}` }, slots.default?.()),
    });
  return {
    Group: stub("VkGroup"),
    Image: stub("VkImage"),
    Layer: stub("VkLayer"),
    Line: stub("VkLine"),
    Rect: stub("VkRect"),
    Stage: stub("VkStage"),
    Text: stub("VkText"),
  };
});
vi.mock("file-saver", () => ({ saveAs: vi.fn() }));

/** 找到「某段文案」后面的那个区块容器（模板里标题与字段行是相邻兄弟节点） */
function sectionAfterText(root: HTMLElement, text: string): HTMLElement | null {
  const heading = Array.from(root.querySelectorAll<HTMLElement>("*")).find(
    (element) => element.children.length === 0 && (element.textContent ?? "").trim() === text,
  );
  return (heading?.nextElementSibling as HTMLElement | null) ?? null;
}

async function mountTimeline() {
  const pinia = prepareOptionsPinia();
  const { i18nInstance } = await import("@/options/plugins/i18n.ts");
  const { default: TimelineView } = await import("@/options/views/Overview/MyData/UserDataTimeline/Index.vue");
  const { useConfigStore } = await import("@/options/stores/config.ts");

  const view = mountOptionsView(TimelineView, { pinia, router: true });
  await view.settle(80);

  return { view, configStore: useConfigStore(), t: i18nInstance.global.t };
}

describe("时间轴显示内容控件", () => {
  it("时间轴输入控件不产生非法的 onUpdate:value prop 警告", async () => {
    const warnings: unknown[][] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };

    const { view } = await mountTimeline();

    console.warn = warn;
    const invalidUpdateWarnings = warnings.filter((args) =>
      String(args[0]).includes('Invalid prop: type check failed for prop "onUpdate:value"'),
    );
    expect(invalidUpdateWarnings).toEqual([]);

    view.unmount();
  });

  it("统计字段与每站点字段都用复选框渲染，数量与配置项一一对应", async () => {
    const { view, configStore, t } = await mountTimeline();
    const control = configStore.userDataTimelineControl;

    for (const [sectionKey, fieldMap] of [
      ["UserDataTimeline.controls.statsSection", control.showField],
      ["UserDataTimeline.controls.timelineSection", control.showPerSiteField],
    ] as const) {
      const section = sectionAfterText(view.host, t(sectionKey));
      expect(section, `应渲染出「${t(sectionKey)}」区块`).not.toBeNull();

      const checkboxes = section!.querySelectorAll(".ant-checkbox-wrapper");
      expect(checkboxes.length, `${sectionKey} 的复选框数量应等于配置项数量`).toBe(Object.keys(fieldMap).length);
      // 反证旧实现：这里不再用开关（a-switch 渲染成 .ant-switch）
      expect(section!.querySelectorAll(".ant-switch")).toHaveLength(0);

      // 每项文案来自真实翻译，不是裸 key
      const rawKeyLeaked = Array.from(checkboxes).some((box) =>
        /UserDataTimeline\.field\./.test(box.textContent ?? ""),
      );
      expect(rawKeyLeaked, "字段文案不应停留在裸 i18n key").toBe(false);
    }

    view.unmount();
  });

  it("勾选字段复选框真的改写 config store（控件接线正确）", async () => {
    const { view, configStore, t } = await mountTimeline();
    const fieldMap = configStore.userDataTimelineControl.showField;
    const firstKey = (Object.keys(fieldMap) as Array<keyof typeof fieldMap>)[0]!;
    const before = fieldMap[firstKey];

    const section = sectionAfterText(view.host, t("UserDataTimeline.controls.statsSection"))!;
    const checkbox = section.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    checkbox.click();
    await view.settle();

    expect(fieldMap[firstKey], "勾选后 store 里的值应翻转").toBe(!before);

    view.unmount();
  });

  it("用户名与时间轴标题输入框可直接编辑并写回 store", async () => {
    const { view, configStore, t } = await mountTimeline();

    // a-auto-complete 把 placeholder 交给 rc-select 处理，实际渲染出的是搜索输入框
    const searchInputs = view.$$<HTMLInputElement>(".ant-select-selection-search-input");
    expect(searchInputs, "控件区应有且只有一个用户名自动完成输入框").toHaveLength(1);
    const usernameInput = searchInputs[0]!;
    expect(usernameInput.readOnly, "用户名不应是只读").toBe(false);

    usernameInput!.value = "new-user-name";
    usernameInput!.dispatchEvent(new Event("input", { bubbles: true }));
    await view.settle();
    expect(configStore.userName).toBe("new-user-name");

    // 时间轴标题：控件区里唯一的普通文本输入框（模板里是 a-input，label 为 controls.timelineTitle）
    const plainInputs = view.$$<HTMLInputElement>("input.ant-input");
    expect(plainInputs, "控件区应有且只有一个标题文本输入框").toHaveLength(1);
    const titleItem = view.$$(".ant-form-item").find((item) => item.contains(plainInputs[0]!));
    expect(titleItem?.querySelector("label")?.textContent, "该输入框应是「时间轴标题」").toContain(
      t("UserDataTimeline.controls.timelineTitle"),
    );
    const titleInput = plainInputs[0]!;
    expect(titleInput.readOnly, "时间轴标题不应是只读").toBe(false);

    titleInput!.value = "我的时间轴";
    titleInput!.dispatchEvent(new Event("input", { bubbles: true }));
    await view.settle();
    expect(configStore.userDataTimelineControl.title, "标题输入应写回控件配置").toBe("我的时间轴");

    view.unmount();
  });
});

describe("统计页用户名输入", () => {
  it("用户名可直接编辑并写回 store", async () => {
    const pinia = prepareOptionsPinia();
    const { i18nInstance } = await import("@/options/plugins/i18n.ts");
    const { default: StatisticView } = await import("@/options/views/Overview/MyData/UserDataStatistic/Index.vue");
    const { useConfigStore } = await import("@/options/stores/config.ts");

    const view = mountOptionsView(StatisticView, { pinia, router: true });
    await view.settle(80);

    const configStore = useConfigStore();
    const searchInputs = view.$$<HTMLInputElement>(".ant-select-selection-search-input");
    expect(searchInputs, "统计页应渲染出用户名自动完成输入框").toHaveLength(1);
    const usernameInput = searchInputs[0]!;
    expect(usernameInput.readOnly, "用户名不应是只读").toBe(false);

    usernameInput!.value = "stat-user-name";
    usernameInput!.dispatchEvent(new Event("input", { bubbles: true }));
    await view.settle();
    expect(configStore.userName).toBe("stat-user-name");

    view.unmount();
  });
});
