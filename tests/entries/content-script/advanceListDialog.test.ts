import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createPinia } from "pinia";
import { createApp, defineComponent, h, nextTick, provide, ref } from "vue";
import { describe, expect, it } from "vitest";
import { ConfigProvider } from "ant-design-vue";
import { StyleProvider } from "ant-design-vue/es/_util/cssinjs";

import AdvanceListModuleDialog from "@/content-script/app/components/AdvanceListModuleDialog.vue";
import { antdInstance } from "@/options/plugins/antd.ts";
import { i18nInstance } from "@/options/plugins/i18n.ts";

const source = readFileSync(
  resolve(import.meta.dirname, "../../../src/entries/content-script/app/components/AdvanceListModuleDialog.vue"),
  "utf8",
);
const init = readFileSync(resolve(import.meta.dirname, "../../../src/entries/content-script/app/init.ts"), "utf8");

describe("高级列表弹窗", () => {
  it("响应式居中，表格滚动范围给分页与底部操作留出空间", () => {
    expect(source).toMatch(/<a-modal[\s\S]*?\bcentered\b/);
    expect(source).toMatch(/:width="[^"]*min\(/);
    expect(source).toContain("min(1200px, calc(100vw - 32px))");
    expect(source).not.toContain("windowHeight - 256");
    expect(source).toContain("defaultPageSize: 25");
    expect(source).not.toMatch(/:pagination="\{ pageSize: 25/);
    expect(init).toContain('popupHostElement.addEventListener("mousedown", stopRetargetedSelectPointerDown)');
    expect(init).toContain('popupHostElement.addEventListener("touchstart", stopRetargetedSelectPointerDown)');
  });

  it("在 shadow 弹层里点击下一页显示后续种子", async () => {
    const host = document.createElement("div");
    const shadow = host.attachShadow({ mode: "open" });
    const mount = document.createElement("div");
    const popup = document.createElement("div");
    shadow.append(mount, popup);
    document.body.append(host);

    const items = Array.from({ length: 30 }, (_, index) => ({
      id: `torrent-${index + 1}`,
      title: `Torrent ${index + 1}`,
      site: "test",
      link: `https://example.com/${index + 1}`,
    }));
    const shown = ref(false);
    const Root = defineComponent({
      setup() {
        provide("remoteDownloadDialogData", { show: false, torrents: [], isDefaultSend: false });
        return () =>
          h(
            StyleProvider,
            { container: shadow },
            {
              default: () =>
                h(
                  ConfigProvider,
                  { getPopupContainer: () => popup },
                  {
                    default: () =>
                      h(AdvanceListModuleDialog, {
                        modelValue: shown.value,
                        "onUpdate:modelValue": (value: boolean | undefined) => (shown.value = value ?? false),
                        torrentItems: items,
                      }),
                  },
                ),
            },
          );
      },
    });
    const app = createApp(Root).use(createPinia()).use(i18nInstance).use(antdInstance);
    try {
      app.mount(mount);
      await nextTick();
      shown.value = true;
      await nextTick();
      await nextTick();
      const next = popup.querySelector<HTMLElement>(".ant-pagination-next button");
      expect(next).not.toBeNull();
      next!.click();
      await nextTick();
      expect(popup.textContent).toContain("Torrent 26");
      expect(popup.querySelector(".ant-pagination-item-active")?.textContent).toContain("2");
    } finally {
      app.unmount();
      host.remove();
    }
  });
});

describe("高级列表弹窗 · 行 key 唯一性（B2-5）", () => {
  it("id 缺失/重复的种子也渲染出互不相同的 data-row-key（避免选中串行）", async () => {
    const host = document.createElement("div");
    const shadow = host.attachShadow({ mode: "open" });
    const mount = document.createElement("div");
    const popup = document.createElement("div");
    shadow.append(mount, popup);
    document.body.append(host);

    // 引擎在 url/link 都解析不到时不会补 id；同一页面上也可能出现重复 id（列表里重复条目）
    const items = [
      { title: "Torrent A", site: "test", link: "https://example.com/a" },
      { title: "Torrent B", site: "test", link: "https://example.com/b" },
      { id: "dup", title: "Torrent C", site: "test", link: "https://example.com/c" },
      { id: "dup", title: "Torrent D", site: "test", link: "https://example.com/d" },
    ] as any[];

    const shown = ref(false);
    const Root = defineComponent({
      setup() {
        provide("remoteDownloadDialogData", { show: false, torrents: [], isDefaultSend: false });
        return () =>
          h(
            StyleProvider,
            { container: shadow },
            {
              default: () =>
                h(
                  ConfigProvider,
                  { getPopupContainer: () => popup },
                  {
                    default: () =>
                      h(AdvanceListModuleDialog, {
                        modelValue: shown.value,
                        "onUpdate:modelValue": (value: boolean | undefined) => (shown.value = value ?? false),
                        torrentItems: items,
                      }),
                  },
                ),
            },
          );
      },
    });
    const app = createApp(Root).use(createPinia()).use(i18nInstance).use(antdInstance);
    try {
      app.mount(mount);
      await nextTick();
      shown.value = true;
      await nextTick();
      await nextTick();

      const rowKeys = Array.from(popup.querySelectorAll<HTMLElement>(".ant-table-tbody > tr[data-row-key]")).map(
        (row) => row.getAttribute("data-row-key"),
      );
      expect(rowKeys).toHaveLength(items.length);
      expect(new Set(rowKeys).size, `row-key 必须唯一，实际：${rowKeys.join(",")}`).toBe(items.length);
    } finally {
      app.unmount();
      host.remove();
    }
  });
});
