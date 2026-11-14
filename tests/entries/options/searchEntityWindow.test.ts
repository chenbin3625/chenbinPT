/**
 * SetBase/SearchEntityWindow.vue：搜索实体设置的渲染与草稿写入。
 *
 * 组件通过 `useSetBaseConfigDraft()` 读取 SetBase 的草稿（inject）。这里用同模块导出的
 * `provideSetBaseConfigDraft()` 在宿主组件里提供一份真实 reactive 草稿，再真实挂载页签：
 * - 各开关 / 数字输入 / 下拉 / 文本域按草稿渲染；
 * - hiddenTagNames 文本域输入时保留换行，beforeSave 时才 trim / 去空行；
 * - metadataStore.sites 为空时 allowSingleSiteSearch 禁用；
 * - 暴露的 beforeSave 在 saveLastFilter=false 时调用 setLastSearchFilter("")。
 */
import { describe, expect, it, vi } from "vitest";
import { defineComponent, h, ref } from "vue";

import { i18nInstance } from "@/options/plugins/i18n.ts";
import {
  createSetBaseConfigDraft,
  provideSetBaseConfigDraft,
  type TSetBaseConfigDraft,
} from "@/options/views/Settings/SetBase/configDraft.ts";
import { mountOptionsView, prepareOptionsPinia } from "../../helpers/optionsView.ts";

const t = i18nInstance.global.t;

interface IExposedSearchEntityWindow {
  beforeSave: () => Promise<void>;
}

interface IMountOptions {
  /** 提供站点，模拟「已有站点」的场景 */
  sites?: Record<string, any>;
  /** 挂载前修改草稿初始值 */
  draftSetup?: (draft: TSetBaseConfigDraft["value"]) => void;
}

async function mountWindow(options: IMountOptions = {}) {
  const pinia = prepareOptionsPinia();
  const { useConfigStore } = await import("@/options/stores/config.ts");
  const { useMetadataStore } = await import("@/options/stores/metadata.ts");

  const configStore = useConfigStore(pinia);
  const metadataStore = useMetadataStore(pinia);
  (metadataStore as any).$save = vi.fn(async () => undefined);
  metadataStore.sites = options.sites ?? {};

  const draft = ref(createSetBaseConfigDraft(configStore.$state)) as TSetBaseConfigDraft;
  options.draftSetup?.(draft.value);

  const childRef = ref<IExposedSearchEntityWindow | null>(null);
  const { default: SearchEntityWindow } = await import("@/options/views/Settings/SetBase/SearchEntityWindow.vue");

  const Host = defineComponent({
    name: "SearchEntityWindowHost",
    setup() {
      provideSetBaseConfigDraft(draft);
      return () => h(SearchEntityWindow as any, { ref: childRef });
    },
  });

  const view = mountOptionsView(Host, { pinia });
  await view.settle(60);

  return { view, draft, childRef, metadataStore, configStore };
}

function rowFor(label: string, host: HTMLElement): HTMLElement | null {
  return (
    Array.from(host.querySelectorAll<HTMLElement>(".ptd-settings-row")).find((row) =>
      row.textContent?.includes(label),
    ) ?? null
  );
}

const switchInRow = (label: string, host: HTMLElement) =>
  rowFor(label, host)?.querySelector<HTMLElement>(".ant-switch") ?? null;

const isSwitchOn = (element: Element | null) => element?.classList.contains("ant-switch-checked") ?? false;
const isSwitchDisabled = (element: Element | null) => element?.classList.contains("ant-switch-disabled") ?? false;

const inputInRow = (label: string, host: HTMLElement) =>
  rowFor(label, host)?.querySelector<HTMLInputElement>("input") ?? null;

describe("SetBase/SearchEntityWindow", () => {
  it("按草稿渲染各类控件：开关、数字输入、下拉与文本域", async () => {
    const { view } = await mountWindow({
      draftSetup: (draft) => {
        draft.searchEntifyControl.hiddenTagNames = ["a", "b"];
      },
    });
    try {
      expect(view.text()).toContain(t("SetBase.searchEntity.siteSearchConfig"));
      expect(view.text()).toContain(t("SetBase.searchEntity.mediaServerSearchConfig"));

      expect(view.$$(".ant-switch"), "应渲染搜索/筛选/标签/媒体库各分区的开关").toHaveLength(9);
      expect(view.$$(".ant-input-number"), "应渲染 4 个数字输入").toHaveLength(4);
      expect(view.$$(".ant-select")).toHaveLength(1);
      expect(view.$$("textarea")).toHaveLength(1);

      // 数字输入绑定到草稿默认值（两个「请求队列长度」文案相同，媒体服务器分区按区块取）
      expect(inputInRow(t("SetBase.searchEntity.siteQueueConcurrency"), view.host)!.value).toBe("8");
      expect(inputInRow(t("SetBase.searchEntity.maxTagCountBeforeGroup"), view.host)!.value).toBe("0");
      const sections = view.$$(".ptd-settings-section");
      expect(sections, "应渲染站点搜索与媒体服务器搜索两个分区").toHaveLength(2);
      const mediaRows = sections[1].querySelectorAll<HTMLElement>(".ptd-settings-row");
      expect(mediaRows[0].querySelector<HTMLInputElement>("input")!.value).toBe("5");
      expect(mediaRows[1].querySelector<HTMLInputElement>("input")!.value).toBe("50");

      // 开关状态与草稿默认值一致
      const cases: Array<[string, boolean]> = [
        [t("SetBase.searchEntity.allowSingleSiteSearch"), false],
        [t("SetBase.searchEntity.treatTTQueryAsImdbSearch"), true],
        [t("SetBase.searchEntity.showHotRecommendations"), true],
        [t("SetBase.searchEntity.saveLastSearchFilter"), true],
        [t("SetBase.searchEntity.forceImdbIdMatchFilter"), true],
        [t("SetBase.searchEntity.autoDetectOfficialGroupFromTitle"), false],
        [t("SetBase.searchEntity.tagClickToFilter"), true],
        [t("SetBase.searchEntity.autoLoadInitialMediaWall"), true],
        [t("SetBase.searchEntity.autoLoadMoreMediaOnScroll"), true],
      ];
      for (const [label, expected] of cases) {
        expect(isSwitchOn(switchInRow(label, view.host)), `${label} 的开关状态应反映草稿值`).toBe(expected);
      }

      // 下拉显示当前草稿值（promotionDisplay = tags）
      expect(
        rowFor(t("SetBase.searchEntity.promotionDisplay"), view.host)!.querySelector(".ant-select-selection-item")
          ?.textContent,
      ).toBe(t("SetBase.searchEntity.promotionDisplayOptions.tags"));

      // 文本域按「一行一个」展示草稿里的隐藏标签
      expect(view.$<HTMLTextAreaElement>("textarea")!.value).toBe("a\nb");
    } finally {
      view.unmount();
    }
  });

  it("hiddenTagNames 文本域输入时保留换行，保存前才 trim / 过滤空行", async () => {
    const { view, draft, childRef } = await mountWindow();
    try {
      const textarea = view.$<HTMLTextAreaElement>("textarea")!;
      expect(textarea.value).toBe("");

      // 输入期间不得吞掉空行，否则用户按回车无法开始录入下一条标签
      textarea.value = "  foo  \n\n  bar \n   \n";
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      await view.settle();

      expect(draft.value.searchEntifyControl.hiddenTagNames).toEqual(["  foo  ", "", "  bar ", "   ", ""]);
      expect(textarea.value).toBe("  foo  \n\n  bar \n   \n");

      // 保存前的 hooks 负责规范化
      await childRef.value!.beforeSave();
      await view.settle();

      expect(draft.value.searchEntifyControl.hiddenTagNames).toEqual(["foo", "bar"]);
      expect(textarea.value).toBe("foo\nbar");

      // 再次输入：旧值被整体替换，而不是追加
      textarea.value = "baz";
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      await view.settle();
      expect(draft.value.searchEntifyControl.hiddenTagNames).toEqual(["baz"]);
    } finally {
      view.unmount();
    }
  });

  it("metadataStore.sites 为空时 allowSingleSiteSearch 禁用，有站点后可用并可写入草稿", async () => {
    const { view, draft, metadataStore } = await mountWindow({ sites: {} });
    try {
      const label = t("SetBase.searchEntity.allowSingleSiteSearch");
      expect(isSwitchDisabled(switchInRow(label, view.host))).toBe(true);
      expect(isSwitchOn(switchInRow(label, view.host))).toBe(false);

      metadataStore.sites = { demo: { sortIndex: 1 } as any };
      await view.settle();

      expect(isSwitchDisabled(switchInRow(label, view.host))).toBe(false);
      switchInRow(label, view.host)!.click();
      await view.settle();

      expect(draft.value.searchEntity.allowSingleSiteSearch).toBe(true);
      expect(isSwitchOn(switchInRow(label, view.host))).toBe(true);
    } finally {
      view.unmount();
    }
  });

  it("beforeSave：saveLastFilter=false 时清空上一次搜索筛选词", async () => {
    const { view, childRef, metadataStore } = await mountWindow({
      draftSetup: (draft) => {
        draft.searchEntity.saveLastFilter = false;
      },
    });
    const spy = vi.spyOn(metadataStore, "setLastSearchFilter");
    try {
      metadataStore.lastSearchFilter = "site:demo keyword";
      await childRef.value!.beforeSave();

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith("");
      expect(metadataStore.lastSearchFilter).toBe("");
    } finally {
      spy.mockRestore();
      view.unmount();
    }
  });

  it("beforeSave：saveLastFilter=true 时保留上一次搜索筛选词", async () => {
    const { view, childRef, metadataStore } = await mountWindow({
      draftSetup: (draft) => {
        draft.searchEntity.saveLastFilter = true;
      },
    });
    const spy = vi.spyOn(metadataStore, "setLastSearchFilter");
    try {
      metadataStore.lastSearchFilter = "keyword";
      await childRef.value!.beforeSave();

      expect(spy).not.toHaveBeenCalled();
      expect(metadataStore.lastSearchFilter).toBe("keyword");
    } finally {
      spy.mockRestore();
      view.unmount();
    }
  });
});
