/**
 * SetSite/EditSearchEntryList.vue：站点默认搜索入口的开关列表。
 *
 * 行为断言：
 * - 按 `item.metadata.searchEntries` 逐个渲染入口名称与开关；
 * - 开关初始状态优先级：`userConfig.merge.searchEntry[key].enabled`（boolean）> `entry.enabled` > 默认 true；
 * - 切换开关走 `metadataStore.simplePatch("sites", id, "merge.searchEntry.<key>.enabled", v)`。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/messages.ts", () => ({ sendMessage: vi.fn(), onMessage: vi.fn() }));

import { mountOptionsView, prepareOptionsPinia } from "../../helpers/optionsView.ts";
import { useMetadataStore } from "@/options/stores/metadata.ts";

const SITE_ID = "site-a";

/** 四个入口分别覆盖：无覆盖 + 无 enabled / 覆盖关闭 / 入口关闭但覆盖开启 / 覆盖开启 + 入口关闭 */
function buildItem() {
  return {
    id: SITE_ID,
    metadata: {
      name: "Site A",
      type: "private" as const,
      urls: ["https://site-a.example/"],
      searchEntries: {
        plain: { name: "Plain Entry" },
        entryOff: { name: "Entry Off", enabled: false },
        overrideOff: { name: "Override Off", enabled: true },
        overrideOn: { name: "Override On", enabled: false },
      },
    },
    userConfig: {
      merge: {
        searchEntry: {
          overrideOff: { enabled: false },
          overrideOn: { enabled: true },
        },
      },
    },
  };
}

function mountList() {
  const pinia = prepareOptionsPinia();
  const metadataStore = useMetadataStore(pinia);
  const patchSpy = vi.spyOn(metadataStore, "simplePatch").mockResolvedValue(undefined);
  const item = buildItem();

  const view = mountOptionsView(ListComponent as any, { pinia, props: { item } });
  return { view, metadataStore, patchSpy, item };
}

/** 组件在模块级 import，因此延迟到 pinia 就绪后再动态加载 */
let ListComponent: any;
async function loadComponent() {
  if (!ListComponent) {
    ListComponent = (await import("@/options/views/Settings/SetSite/EditSearchEntryList.vue")).default;
  }
  return ListComponent;
}

function itemByName(name: string): HTMLElement {
  const item = Array.from(document.querySelectorAll<HTMLElement>(".ant-list-item")).find((node) =>
    (node.textContent ?? "").includes(name),
  );
  expect(item, `应渲染出入口「${name}」`).toBeDefined();
  return item!;
}

function switchOf(name: string): HTMLButtonElement {
  const button = itemByName(name).querySelector<HTMLButtonElement>(".ant-switch");
  expect(button, `入口「${name}」应有开关`).not.toBeNull();
  return button!;
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("EditSearchEntryList：渲染与初始开关状态", () => {
  it("每个 searchEntries 入口渲染一行（名称 + 开关）", async () => {
    await loadComponent();
    const { view, item } = mountList();
    try {
      await view.settle();

      const rows = document.querySelectorAll(".ant-list-item");
      expect(rows).toHaveLength(Object.keys(item.metadata.searchEntries).length);
      for (const entry of Object.values(item.metadata.searchEntries)) {
        expect(itemByName(entry.name).textContent).toContain(entry.name);
      }
    } finally {
      view.unmount();
    }
  });

  it("enabled 优先级：用户覆盖 > 入口默认 > true 缺省", async () => {
    await loadComponent();
    const { view } = mountList();
    try {
      await view.settle();

      // 无覆盖、无 enabled → 默认开启
      expect(switchOf("Plain Entry").classList.contains("ant-switch-checked")).toBe(true);
      // 入口自己声明 enabled: false，且无用户覆盖 → 关闭
      expect(switchOf("Entry Off").classList.contains("ant-switch-checked")).toBe(false);
      // 入口 enabled: true，但用户覆盖为 false → 以用户为准，关闭
      expect(switchOf("Override Off").classList.contains("ant-switch-checked")).toBe(false);
      // 入口 enabled: false，但用户覆盖为 true → 以用户为准，开启
      expect(switchOf("Override On").classList.contains("ant-switch-checked")).toBe(true);
    } finally {
      view.unmount();
    }
  });
});

describe("EditSearchEntryList：切换开关写回 metadataStore.simplePatch", () => {
  it("点击开关 → 以反转后的值调用 simplePatch，并带正确的站点 / 路径", async () => {
    await loadComponent();
    const { view, patchSpy } = mountList();
    try {
      await view.settle();

      switchOf("Plain Entry").click();
      await view.settle();

      expect(patchSpy).toHaveBeenCalledTimes(1);
      expect(patchSpy).toHaveBeenCalledWith("sites", SITE_ID, "merge.searchEntry.plain.enabled", false);

      switchOf("Entry Off").click();
      await view.settle();

      expect(patchSpy).toHaveBeenLastCalledWith("sites", SITE_ID, "merge.searchEntry.entryOff.enabled", true);
      expect(patchSpy).toHaveBeenCalledTimes(2);
    } finally {
      view.unmount();
    }
  });
});
