/**
 * M-29：搜索结果「大小」列里的种子状态图标必须真的渲染出来。
 * 旧模板写成 `<component class="ptd-icon-sm" />`（缺 :is），渲染为未知元素 <component>，图标从不显示。
 */
import { describe, expect, it } from "vitest";
import { ETorrentStatus } from "@ptd/site";

import { mountOptionsView } from "../../helpers/optionsView.ts";

const { default: TorrentProcessTd } = await import("@/options/views/Overview/SearchEntity/TorrentProcessTd.vue");

describe("TorrentProcessTd 状态图标（M-29）", () => {
  it.each([
    [ETorrentStatus.downloading, "arrow-down"],
    [ETorrentStatus.seeding, "arrow-up"],
    [ETorrentStatus.completed, "check"],
    [ETorrentStatus.inactive, "disconnect"],
  ])("status=%s 渲染 %s 图标", async (status, iconName) => {
    const view = mountOptionsView(TorrentProcessTd, { props: { torrent: { status, progress: 50 } } });
    try {
      await view.settle();
      expect(view.host.querySelector("component"), "不应渲染未解析的 <component> 元素").toBeNull();
      expect(view.$(`.anticon-${iconName}`)).not.toBeNull();
    } finally {
      view.unmount();
    }
  });
});
