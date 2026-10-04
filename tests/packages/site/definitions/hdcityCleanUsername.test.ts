/**
 * hdcity `cleanUsername` 的等价性测试（见 docs/performance-audit.md P2-14）。
 *
 * 原实现：`cloneNode(true)` → `querySelectorAll("i, span, div")` 里删除
 * `textContent` 含 "star" 的元素 → 取 `textContent` → 正则清理 → 空则回落 `element.textContent.trim()`。
 *
 * 新实现：用 `extractTextExcludingByPredicate` 按同一谓词"跳过"这些元素（不再深克隆）。
 *
 * 等价性依据：被排除元素的 `textContent` 是自身固有属性，不会因为兄弟/子元素先被删除而改变，
 * 所以"静态列表逐个 remove"与"遍历时按谓词跳过"保留的元素集合完全一致。
 * 这里用**旧实现本身**作为对照，覆盖嵌套、大小写、父/子同时命中、无命中、空结果回落等形态。
 */
import { describe, expect, it, vi } from "vitest";

// 站点定义会连带引入 @ptd/site 的运行时依赖（messages.ts 用到 __BROWSER__ 与 chrome API），
// 这里给出最小桩，避免为了一次纯函数等价性测试去跑整个扩展环境。
vi.stubGlobal("__BROWSER__", "chrome");
vi.stubGlobal("chrome", {
  storage: {
    local: {
      get: () => Promise.resolve({}),
      set: () => Promise.resolve(),
      remove: () => Promise.resolve(),
      onChanged: { addListener: () => {}, removeListener: () => {} },
    },
    onChanged: { addListener: () => {}, removeListener: () => {} },
  },
  runtime: {
    id: "test",
    onMessage: { addListener: () => undefined, removeListener: () => undefined },
    sendMessage: () => Promise.resolve(undefined),
    getURL: (path: string) => `chrome-extension://test/${path}`,
  },
  cookies: { get: () => Promise.resolve(null), set: () => Promise.resolve(), getAll: () => Promise.resolve([]) },
  downloads: { download: () => Promise.resolve(1) },
  tabs: { create: () => Promise.resolve(), query: () => Promise.resolve([]) },
});

const { cleanUsername } = await import("@ptd/site/definitions/hdcity.ts");

/** 旧实现（克隆 + remove），仅用于对照 */
function legacyCleanUsername(element: Element): string {
  const clone = element.cloneNode(true) as Element;
  clone.querySelectorAll("i, span, div").forEach((el) => {
    if (el.textContent?.toLowerCase().includes("star")) {
      el.remove();
    }
  });

  let result = clone.textContent?.replace(/\b(starbig|star)\b/gi, "") || "";
  result = result.replace(/\s+/g, " ").replace(/^[\s\-_\.=]+|[\s\-_\.=]+$/g, "");
  return result || element.textContent?.trim() || "";
}

function makeElement(html: string): Element {
  const container = document.createElement("div");
  container.innerHTML = html;
  return container.firstElementChild as Element;
}

describe("hdcity cleanUsername：与克隆+删除的旧实现等价", () => {
  const cases = [
    "<span><i>starbig</i>UserName</span>",
    "<span><i>STAR</i>UserName</span>",
    "<span>UserName<i>starbig</i></span>",
    "<div><span>star</span></div>",
    "<div>Plain<span>star</span>Name</div>",
    "<div><span><i>star</i></span>Tail</div>",
    "<span>star</span>",
    "<span>---User Name---</span>",
    "<span>User   Name</span>",
    "<div><span>keep</span><i>starbig</i></div>",
    "<span>星标用户</span>",
    "<span><i>StArBiG</i>Mixed</span>",
  ];

  for (const html of cases) {
    it(`等价：${html}`, () => {
      const element = makeElement(html);
      expect(cleanUsername(element)).toBe(legacyCleanUsername(element));
    });
  }

  it("无 star 时保留原文本（含多余空白归一化）", () => {
    expect(cleanUsername(makeElement("<span>  User   Name  </span>"))).toBe("User Name");
  });

  it("全部被清理时回落到 element.textContent.trim()", () => {
    expect(cleanUsername(makeElement("<span><i>star</i></span>"))).toBe("star");
  });
});
