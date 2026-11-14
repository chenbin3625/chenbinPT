/**
 * SearchEntity/SelectionBar.vue：多选操作条的数量/体积文案、计费体积与清除事件。
 *
 * 组件挂载时会读取 #ptd-main 的布局并注册 ResizeObserver / rAF；happy-dom 虽有这些 API，
 * 这里仍显式补齐（stub ResizeObserver、准备 #ptd-main），避免测试因环境缺失 API 而抛错。
 * ActionTd 被替换成局部 stub：本文件只验证操作条自身的行为。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { i18nInstance } from "@/options/plugins/i18n.ts";
import { mountOptionsView, prepareOptionsPinia } from "../../helpers/optionsView.ts";

vi.mock("@/options/views/Overview/SearchEntity/ActionTd.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    default: defineComponent({
      name: "ActionTdStub",
      setup: () => () => h("span", { class: "stub-action-td" }),
    }),
  };
});

class TestResizeObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}

beforeEach(() => {
  document.body.innerHTML = "";
  vi.stubGlobal("ResizeObserver", TestResizeObserver);
  // 组件以 #ptd-main 的内容盒做定位；缺失时 syncInsets 会直接 return，这里补上真实节点。
  const main = document.createElement("div");
  main.id = "ptd-main";
  document.body.appendChild(main);
});

const t = i18nInstance.global.t;

type Torrent = {
  site: string;
  id: string;
  title: string;
  size: number;
  downloadVolumeFactor?: number;
};

function torrent(size: number, downloadVolumeFactor?: number, id = String(size)): Torrent {
  return {
    site: "s1",
    id,
    title: `torrent-${id}`,
    size,
    ...(downloadVolumeFactor === undefined ? {} : { downloadVolumeFactor }),
  };
}

async function mountBar(selectedTorrents: Torrent[], promotionDisplay: "tags" | "factor" | "both" | "none" = "tags") {
  const pinia = prepareOptionsPinia();
  const { useConfigStore } = await import("@/options/stores/config.ts");
  useConfigStore(pinia).searchEntifyControl.promotionDisplay = promotionDisplay;

  const onClear = vi.fn();
  const { default: SelectionBar } = await import("@/options/views/Overview/SearchEntity/SelectionBar.vue");
  const view = mountOptionsView(SelectionBar, { pinia, props: { selectedTorrents, onClear } });
  await view.settle();
  return { view, onClear };
}

describe("SelectionBar", () => {
  it("没有选中种子时不渲染操作条", async () => {
    const { view } = await mountBar([]);
    try {
      expect(document.querySelector(".ptd-selection-bar")).toBeNull();
      expect(document.body.textContent).not.toContain(t("SearchEntity.index.clearSelection"));
    } finally {
      view.unmount();
    }
  });

  it("显示选中数量与总大小；下载系数缺失时按 1 计，因而不额外显示计费体积", async () => {
    const { view } = await mountBar([torrent(1024, undefined, "a"), torrent(2048, undefined, "b")]);
    try {
      const bar = document.querySelector(".ptd-selection-bar");
      expect(bar).not.toBeNull();
      expect(bar!.textContent).toContain(t("SearchEntity.index.selectedTorrents", [2]));
      expect(bar!.textContent).toContain(t("SearchEntity.index.totalSize", ["3.00 KiB"]));
      // 缺失系数按 1 折算 → 计费体积 === 总大小，模板不重复展示
      expect(bar!.textContent).not.toContain(t("SearchEntity.index.billableSize", ["3.00 KiB"]));
    } finally {
      view.unmount();
    }
  });

  it("下载系数为 0 / 0.5 时显示按折算值计算的计费体积", async () => {
    const { view } = await mountBar([torrent(1024, 0, "free"), torrent(1024, 0.5, "half")]);
    try {
      const bar = document.querySelector(".ptd-selection-bar")!;
      expect(bar.textContent).toContain(t("SearchEntity.index.totalSize", ["2.00 KiB"]));
      // 1024 * 0 + 1024 * 0.5 = 512 B
      expect(bar.textContent).toContain(t("SearchEntity.index.billableSize", ["512.00 B"]));
      expect(bar.querySelector(".ptd-selection-bar__size")).not.toBeNull();
    } finally {
      view.unmount();
    }
  });

  it("promotionDisplay === 'none' 时隐藏计费体积，但总大小仍在", async () => {
    const { view } = await mountBar([torrent(1024, 0, "free"), torrent(1024, 0.5, "half")], "none");
    try {
      const bar = document.querySelector(".ptd-selection-bar")!;
      expect(bar.textContent).toContain(t("SearchEntity.index.totalSize", ["2.00 KiB"]));
      expect(bar.textContent).not.toContain(t("SearchEntity.index.billableSize", ["512.00 B"]));
    } finally {
      view.unmount();
    }
  });

  it("点击清除按钮 emit('clear')", async () => {
    const { view, onClear } = await mountBar([torrent(1024, undefined, "a")]);
    try {
      const clear = document.querySelector<HTMLButtonElement>(
        `.ptd-selection-bar button[title="${t("SearchEntity.index.clearSelection")}"]`,
      );
      expect(clear, "操作条上应有清除按钮").not.toBeNull();
      clear!.click();
      await view.settle();
      expect(onClear).toHaveBeenCalledTimes(1);
    } finally {
      view.unmount();
    }
  });
});
