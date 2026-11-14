/**
 * MediaServerEntity/ServerFilterChips.vue：服务器筛选 chip 的 v-model 行为。
 *
 * 用一个持有 `model` 的宿主组件真实挂载（与页面里 `v-model="searchMediaServerIds"` 等价），
 * 断言用户点击后 chip 的可见选中态与模型值，而不是读源码文本。
 */
import { describe, expect, it } from "vitest";
import { defineComponent, h, ref } from "vue";

import { mountOptionsView, prepareOptionsPinia } from "../../helpers/optionsView.ts";

const ITEMS = [
  { id: "m1", name: "Emby One", type: "emby" },
  { id: "m2", name: "Plex Two", type: "plex" },
];

async function mountChips(initial: string[], items: typeof ITEMS | [] = ITEMS) {
  const pinia = prepareOptionsPinia();
  const { default: ServerFilterChips } =
    await import("@/options/views/Overview/MediaServerEntity/ServerFilterChips.vue");

  const model = ref<string[]>(initial);
  const updates: string[][] = [];

  const Wrapper = defineComponent({
    name: "ServerFilterChipsHost",
    setup() {
      return () =>
        h(ServerFilterChips, {
          items,
          modelValue: model.value,
          "onUpdate:modelValue": (value: string[]) => {
            updates.push(value);
            model.value = value;
          },
        });
    },
  });

  const view = mountOptionsView(Wrapper, { pinia });
  await view.settle();

  const button = (label: string) => view.$<HTMLButtonElement>(`.media-server-filters button[aria-label="${label}"]`);

  return { view, model, updates, button };
}

describe("ServerFilterChips", () => {
  it("渲染「全部」以及每个服务器各一个 chip", async () => {
    const { view } = await mountChips([]);
    try {
      const labels = view
        .$$<HTMLButtonElement>(".media-server-filters button")
        .map((element) => element.getAttribute("aria-label"));
      expect(labels).toEqual(["全部服务器", "Emby One", "Plex Two"]);
      expect(view.text()).toContain("全部服务器");
      expect(view.text()).toContain("Emby One");
      expect(view.text()).toContain("Plex Two");
    } finally {
      view.unmount();
    }
  });

  it("点击服务器会在 v-model 中加入/移除其 id，并同步 chip 选中态", async () => {
    const { view, model, updates, button } = await mountChips([]);
    try {
      expect(button("Emby One")!.getAttribute("aria-pressed")).toBe("false");

      button("Emby One")!.click();
      await view.settle();
      expect(model.value).toEqual(["m1"]);
      expect(updates.at(-1)).toEqual(["m1"]);
      expect(button("Emby One")!.getAttribute("aria-pressed")).toBe("true");

      // 再点一次取消
      button("Emby One")!.click();
      await view.settle();
      expect(model.value).toEqual([]);
      expect(updates.at(-1)).toEqual([]);
      expect(button("Emby One")!.getAttribute("aria-pressed")).toBe("false");

      // 不同服务器是追加而不是替换
      button("Emby One")!.click();
      await view.settle();
      button("Plex Two")!.click();
      await view.settle();
      expect(model.value).toEqual(["m1", "m2"]);
    } finally {
      view.unmount();
    }
  });

  it("点击「全部」把所有服务器 id 写入模型，并呈现选中态", async () => {
    const { view, model, updates, button } = await mountChips(["m1"]);
    try {
      const all = button("全部服务器")!;
      expect(all.getAttribute("aria-pressed")).toBe("false");
      expect(all.className).not.toContain("ant-btn-primary");

      all.click();
      await view.settle();

      expect(model.value).toEqual(["m1", "m2"]);
      expect(updates.at(-1)).toEqual(["m1", "m2"]);
      expect(all.getAttribute("aria-pressed")).toBe("true");
      expect(all.className).toContain("ant-btn-primary");
      expect(button("Emby One")!.getAttribute("aria-pressed")).toBe("true");
      expect(button("Plex Two")!.getAttribute("aria-pressed")).toBe("true");
    } finally {
      view.unmount();
    }
  });

  it("items 为空时「全部」不呈选中态（isAllSelected 要求至少有一个 item）", async () => {
    const { view, model, button } = await mountChips([], []);
    try {
      const all = button("全部服务器")!;
      expect(all).not.toBeNull();
      expect(all.getAttribute("aria-pressed")).toBe("false");
      expect(all.className).not.toContain("ant-btn-primary");

      all.click();
      await view.settle();
      // items 为空时 selectAll 写入空数组，也不应误判为「全选」
      expect(model.value).toEqual([]);
      expect(all.getAttribute("aria-pressed")).toBe("false");
    } finally {
      view.unmount();
    }
  });
});
