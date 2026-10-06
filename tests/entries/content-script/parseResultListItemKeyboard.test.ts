/**
 * L-17：可点击的列表行（a-list-item 渲染为裸 <li>）必须能用键盘聚焦并触发。
 */
import { describe, expect, it, vi } from "vitest";

const doKeywordSearch = vi.hoisted(() => vi.fn());
vi.mock("@/content-script/app/utils.ts", () => ({ doKeywordSearch }));

import { mountOptionsView } from "../../helpers/optionsView.ts";

const { default: Item } = await import("@/content-script/app/components/ParseResultListItem.vue");

describe("ParseResultListItem 键盘可达（L-17）", () => {
  it("行可聚焦（tabindex=0, role=button），Enter / Space 触发搜索", async () => {
    const view = mountOptionsView(Item, { props: { title: "t", tagText: "IMDb", keyword: "tt0111161" } });
    try {
      await view.settle();
      const row = view.$<HTMLElement>(".ptd-parse-result-row")!;
      expect(row.getAttribute("tabindex")).toBe("0");
      expect(row.getAttribute("role")).toBe("button");

      row.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      row.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
      expect(doKeywordSearch).toHaveBeenCalledTimes(2);
      expect(doKeywordSearch).toHaveBeenCalledWith("tt0111161", "default");
    } finally {
      view.unmount();
    }
  });
});
