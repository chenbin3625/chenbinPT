import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createApp, defineComponent, h } from "vue";
import { describe, expect, it } from "vitest";

import { renderEllipsisCell } from "@/options/views/Overview/utils/antdTable.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("表格超长字段悬停提示", () => {
  it("使用可换行的 Tooltip 展示完整字段，而不是浏览器原生 title", () => {
    const vnode = renderEllipsisCell("一个很长的字段值");

    expect(vnode.type).not.toBe("span");
    expect(vnode.props).not.toBeNull();
    expect(vnode.props!).toMatchObject({
      placement: "topLeft",
    });
    expect(vnode.props!.overlayInnerStyle).toMatchObject({
      overflowWrap: "anywhere",
      whiteSpace: "pre-wrap",
    });
    expect(vnode.children).toHaveProperty("default");
  });

  it("鼠标悬停省略文本时实际渲染 Tooltip", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const app = createApp(
      defineComponent({
        setup: () => () => h(renderEllipsisCell("一个很长的字段值")),
      }),
    );

    app.mount(host);
    host
      .querySelector<HTMLElement>(".ptd-cell-ellipsis")
      ?.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    await sleep(160);

    expect(document.querySelector(".ant-tooltip")).not.toBeNull();
    expect(document.querySelector(".ant-tooltip-inner")?.textContent).toContain("一个很长的字段值");

    app.unmount();
    host.remove();
    document.querySelectorAll(".ant-tooltip").forEach((element) => element.remove());
  });

  it("种子标题单元格使用同一套 Tooltip 展示完整标题", () => {
    const source = readFileSync(resolve(process.cwd(), "src/entries/options/components/TorrentTitleTd.vue"), "utf8");

    expect(source).toContain("<a-tooltip");
    expect(source).toContain(':title="item.title');
  });
});
