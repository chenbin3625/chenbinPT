/**
 * `extractTextExcluding` 的直接子选择器支持 + 与旧写法等价性（见 docs/performance-audit.md P2-14）。
 *
 * 这个 helper 用来替代站点解析热路径上的「每行 `cloneNode(true)` → 删掉若干节点 → 取文本」。
 * 本文件补的是 P2-14 新增的能力：以 `>` 开头的**仅直接子元素**选择器
 * （如 `">span, div.torrent_info"`，对应 uhdbits 的写法）。
 *
 * 注意 `Element.matches(">span")` 是非法选择器，必须由 helper 自己拆开处理，
 * 否则会抛 SyntaxError 或匹配错误 —— 这正是本文件要钉住的点。
 *
 * 对照实现刻意使用**旧写法本身**（在克隆体上 Sizzle + remove 后取 textContent；
 * 克隆体脱离文档，其按规范的 `innerText` 退化为 `textContent`）。
 */
import Sizzle from "./oracle/selector-oracle.mjs";
import { describe, expect, it } from "vitest";

import { extractTextExcluding } from "@ptd/site/utils/html.ts";

function legacyExtractTextExcluding(element: Element, excludeSelector: string): string {
  const clone = element.cloneNode(true) as Element;
  Sizzle(excludeSelector, clone).forEach((target: Element) => target.remove());
  return clone.textContent ?? "";
}

function makeElement(html: string): Element {
  const container = document.createElement("div");
  container.innerHTML = html;
  return container.firstElementChild as Element;
}

describe("extractTextExcluding：`>` 直接子选择器与旧写法等价（P2-14）", () => {
  const cases: Array<{ name: string; html: string; selector: string }> = [
    {
      name: "uhdbits 的真实用法：排除直接子 span 与后代 div.torrent_info",
      html: '<div class="group_info"><span class="x">SPAN</span>Title Text<div class="torrent_info">INFO</div></div>',
      selector: ">span, div.torrent_info",
    },
    {
      name: "多个直接子 span",
      html: "<div class='group_info'>A<span>B</span>C<span>D</span></div>",
      selector: ">span",
    },
    {
      name: "只有被排除元素 → 空字符串",
      html: '<div class="group_info"><div class="torrent_info">only info</div></div>',
      selector: "div.torrent_info",
    },
    {
      name: "嵌套：span 内部的 div.torrent_info 随 span 一起排除",
      html: '<div class="group_info"><span><div class="torrent_info">nested</div>deep span</span>tail</div>',
      selector: ">span, div.torrent_info",
    },
    {
      name: "''>span' 只匹配直接子元素：深层 span 必须保留",
      html: "<div class='group_info'><p><span>deep</span></p>tail</div>",
      selector: ">span",
    },
    {
      name: "保留非排除元素（含内联标签）",
      html: "<div class='group_info'><p>keep <b>bold</b></p><span>drop</span></div>",
      selector: ">span",
    },
    { name: "中文文本", html: "<div class='group_info'>中文<span>中文</span>标题</div>", selector: ">span" },
    {
      name: "hdspace 用法：排除全部后代 <a>（克隆体 innerText == textContent）",
      html: "<span>Title <a href='x'>link</a> Year</span>",
      selector: "a",
    },
    {
      name: "jpopsuki 用法：排除 artist 链接（属性选择器）",
      html: "<h2>[Album] <a href='artist.php?id=1'>Artist</a> - Album Name [2010]</h2>",
      selector: "a[href*='artist.php']",
    },
    {
      name: "后代选择器不排除根元素本身",
      html: "<div class='group_info'><div class='torrent_info'>A</div>B<div class='torrent_info'>C</div></div>",
      selector: "div.torrent_info",
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      const element = makeElement(testCase.html);
      expect(extractTextExcluding(element, testCase.selector)).toBe(
        legacyExtractTextExcluding(element, testCase.selector),
      );
    });
  }

  it("复杂选择器列表：两侧空格 / 混合直接子与后代选择器", () => {
    const element = makeElement(
      '<div class="group_info">keep<span>drop1</span> <div class="torrent_info">drop2</div> <em>keep2</em></div>',
    );
    expect(extractTextExcluding(element, " > span ,  div.torrent_info ")).toBe(
      legacyExtractTextExcluding(element, ">span, div.torrent_info"),
    );
  });
});
