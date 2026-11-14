import { describe, expect, it, vi } from "vitest";

import { EResultParseStatus } from "@ptd/site";

import { formatSize } from "@/options/utils.ts";
import { mountOptionsView, prepareOptionsPinia } from "../../helpers/optionsView.ts";

vi.mock("@/messages.ts", () => ({ sendMessage: vi.fn().mockResolvedValue(undefined), onMessage: vi.fn() }));

describe("MyData 页面数据摘要", () => {
  it("仅汇总成功站点，并显示异常站点数量", async () => {
    const pinia = prepareOptionsPinia();
    const { default: MyData } = await import("@/options/views/Overview/MyData/Index.vue");
    const { perSiteLastUserData } = await import("@/options/views/Overview/MyData/utils/lastUserData.ts");

    const view = mountOptionsView(MyData, { pinia, router: true });
    await view.settle(120);

    perSiteLastUserData.value = {
      "site-a": {
        site: "site-a",
        siteName: "Site A",
        siteUserConfig: {},
        status: EResultParseStatus.success,
        uploaded: 1024,
        downloaded: 512,
        seedingSize: 2048,
      },
      "site-b": {
        site: "site-b",
        siteName: "Site B",
        siteUserConfig: {},
        status: EResultParseStatus.parseError,
        uploaded: 9999,
        downloaded: 9999,
        seedingSize: 9999,
      },
    } as any;
    await view.settle();

    const summary = view.$<HTMLElement>(".my-data-summary")!;
    expect(summary).not.toBeNull();
    expect(summary.textContent).toContain(formatSize(1024));
    expect(summary.textContent).toContain(formatSize(512));
    expect(summary.textContent).toContain(formatSize(2048));
    expect(summary.textContent).not.toContain(formatSize(9999));

    const errorSites = summary.querySelector<HTMLButtonElement>(".my-data-summary__item--warning")!;
    expect(errorSites).not.toBeNull();
    expect(errorSites.textContent).toContain("1");

    view.unmount();
  });
});
