/**
 * E11：`matchesSelector` 对游离 DOM（脱离文档的子树）也必须按原生 `Element.matches` 语义工作。
 *
 * 触发场景：`AbstractBittorrentSite` 在 `rows.merge > 1` 时把多行 tr 移入一个 `createElement("div")`
 * 的未挂载 wrapper，再交给逐字段解析；此时 `document.contains(elem)` 为 false，旧实现的
 * `matchesSelector` 对任何选择器都返回 false，导致合并行的 `case` / `tags` 判定失效。
 */
import { describe, expect, it } from "vitest";

import { matchesSelector, selectElements } from "@ptd/site/utils/selector.ts";

function detached(html: string): HTMLDivElement {
  const div = document.createElement("div");
  div.innerHTML = html;
  return div;
}

describe("E11：matchesSelector 与游离 DOM", () => {
  it("游离子树中的元素按原生 matches 语义返回", () => {
    const root = detached(`<table><tbody><tr id="r"><td class="a">x</td><td class="b">y</td></tr></tbody></table>`);
    const td = root.querySelector("td.a") as Element;

    expect(matchesSelector(td, ".a")).toBe(td.matches(".a"));
    expect(matchesSelector(td, "td")).toBe(true);
    expect(matchesSelector(td, "tr td")).toBe(td.matches("tr td"));
    expect(matchesSelector(td, "tr > td:first")).toBe(true);
    expect(matchesSelector(td, ".b")).toBe(false);
    expect(matchesSelector(td, "td:contains('x')")).toBe(true);
  });

  it("游离子树的根元素自身也能被匹配", () => {
    const img = document.createElement("img");
    img.className = "free";

    expect(matchesSelector(img, "img.free")).toBe(true);
    expect(matchesSelector(img, "img")).toBe(true);
    expect(matchesSelector(img, ".nope")).toBe(false);
  });

  it("merge 行场景：tr 移入未挂载 wrapper 后，td/img 的 tag 判定仍有效", () => {
    document.body.innerHTML = `<table id="t"><tbody>
      <tr id="m1"><td class="x"><img class="free" src="x.png"></td></tr>
      <tr id="m2"><td class="x"><img class="free" src="x.png"></td></tr>
    </tbody></table>`;

    const trs = Array.from(document.querySelectorAll("#t tbody tr"));
    const wrapper = document.createElement("div");
    trs.forEach((tr) => wrapper.appendChild(tr));

    const candidates = selectElements("td, img.free", wrapper);
    expect(candidates.length).toBe(4);
    // 合并行的候选元素全部游离于文档
    expect(candidates.every((candidate) => !document.contains(candidate))).toBe(true);
    expect(candidates.filter((candidate) => matchesSelector(candidate, "td")).length).toBe(2);
    expect(candidates.filter((candidate) => matchesSelector(candidate, "img.free")).length).toBe(2);
  });

  it("selectElements 的「不含上下文自身」语义不受影响", () => {
    const root = detached(`<span id="s1">a</span><span id="s2">b</span>`);
    root.id = "box";

    expect(selectElements("span", root).length).toBe(2);
    expect(selectElements("#box", root)).toEqual([]);
  });
});
