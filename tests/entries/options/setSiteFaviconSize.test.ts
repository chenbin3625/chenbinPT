import { describe, expect, it, vi } from "vitest";
import { mountOptionsView, prepareOptionsPinia } from "../../helpers/optionsView.ts";

vi.mock("@/messages.ts", () => ({ sendMessage: vi.fn(), onMessage: vi.fn() }));
vi.mock("@/options/views/Settings/SetSite/utils.ts", async () => {
  const { ref } = await import("vue");
  return {
    allAddedSiteInfo: ref([
      {
        id: "mteam",
        metadata: { id: "mteam", name: "M-Team", urls: ["https://example.com"] },
        userConfig: { sortIndex: 1, groups: [], url: "https://example.com" },
      },
    ]),
    isLoadingAddedSiteInfo: ref(false),
    getCanAddedSiteMetadata: vi.fn().mockResolvedValue({}),
  };
});
vi.mock("@/options/components/SiteFavicon/utils.ts", () => ({
  getSiteFavicon: vi.fn().mockResolvedValue("data:image/png;base64,AA=="),
}));

describe("站点设置列表", () => {
  it("站点图标以 20px 尺寸渲染", async () => {
    const pinia = prepareOptionsPinia();
    const { default: SetSite } = await import("@/options/views/Settings/SetSite/Index.vue");
    const view = mountOptionsView(SetSite, { pinia });
    await view.settle();

    const favicon = view.$<HTMLImageElement>(".ant-table-tbody .ant-image-img");
    expect(favicon).not.toBeNull();
    expect(favicon!.getAttribute("width")).toBe("20");
    expect(favicon!.getAttribute("height")).toBe("20");

    view.unmount();
  });
});
