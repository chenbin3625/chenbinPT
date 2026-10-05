import { describe, expect, it, vi } from "vitest";
import { defineComponent, h, nextTick, provide, ref } from "vue";
import { mountOptionsView, prepareOptionsPinia } from "../../helpers/optionsView.ts";

const metadata = vi.hoisted(() => ({
  getSiteMetadata: vi.fn(async (siteId: string) => ({
    id: siteId,
    name: siteId,
    urls: [`https://${siteId}.example/`],
    type: "private",
  })),
  getSiteUserConfig: vi.fn(async (siteId: string) => ({
    url: siteId === "site-a" ? "https://custom.example/" : "https://site-b.example/",
    sortIndex: 100,
  })),
}));

vi.mock("@/options/stores/metadata.ts", () => ({ useMetadataStore: () => metadata }));
vi.mock("@/messages.ts", () => ({ sendMessage: vi.fn(), onMessage: vi.fn() }));

describe("站点编辑器复用", () => {
  it("从自定义 URL 站点切换到官方 URL 站点时清空旧地址", async () => {
    const pinia = prepareOptionsPinia();
    const siteId = ref("site-a");
    const draft = ref({ url: "", sortIndex: 100 });
    const { default: Editor } = await import("@/options/views/Settings/SetSite/Editor.vue");
    const Root = defineComponent({
      setup() {
        provide("storedSiteUserConfig", draft);
        return () => h(Editor, { modelValue: siteId.value });
      },
    });

    const view = mountOptionsView(Root, { pinia });
    await view.settle(100);
    const customUrlInput = () =>
      view.$$<HTMLInputElement>("input.ant-input").find((input) => input.value.includes("custom.example"));
    expect(customUrlInput()).toBeDefined();

    siteId.value = "site-b";
    await nextTick();
    await view.settle(100);

    expect(view.$$<HTMLInputElement>("input.ant-input").some((input) => input.value.includes("custom.example"))).toBe(
      false,
    );
    expect(draft.value.url).toBe("https://site-b.example/");
    view.unmount();
  });
});
