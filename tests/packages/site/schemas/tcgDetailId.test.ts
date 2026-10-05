/**
 * TCG 系站点（thegeeks / thevault）详情页 id 解析回归（缺陷清单 M-3）。
 *
 * 缺陷：`detail.selectors.id` 只声明了 `selector: ":self"` + querystring filter，没有 attr /
 * elementProcess。引擎对「无 attr / elementProcess 的 DOM 选择器」会读 `innerText ?? textContent`，
 * 而 `:self` 在详情页传下来的是 Document —— 按 DOM 规范 `Document.textContent` 是 **null**，
 * 于是真实浏览器里 `(null).replace(...)` 抛 TypeError，详情页解析整体失败（复制链接 / 推送下载器 /
 * 快捷搜索静默失效）。
 *
 * 注意：happy-dom 的 `Document.textContent` 返回 `""`，崩溃不会自然复现，因此这里用
 * `withBrowserLikeDocument` 显式把原型 getter 换成浏览器语义（返回 null），否则这条回归测不出来。
 */
import { describe, expect, it, vi } from "vitest";

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
});

const { default: TCG, SchemaMetadata } = await import("@ptd/site/schemas/TCG.ts");

const metadata = {
  id: "thegeeks",
  name: "TheGeeks",
  type: "private",
  urls: ["https://thegeeks.click/"],
  ...SchemaMetadata,
} as any;

const idQuery = SchemaMetadata.detail!.selectors!.id;

function createDetailDocument(url: string): Document {
  const doc = new DOMParser().parseFromString(
    `<html><body><div><h1>Some Torrent</h1></div><a href="download.php/12345/Some.Torrent.torrent">下载</a></body></html>`,
    "text/html",
  );
  // happy-dom 的 DOMParser 产出 about:blank 文档；详情页解析只依赖 URL，这里显式给出
  Object.defineProperty(doc, "URL", { value: url, configurable: true });
  return doc;
}

/** 以真实浏览器语义执行回调：把 Document 的 textContent 变成 null（DOM 规范行为） */
function withBrowserLikeDocument(node: Document, fn: () => void) {
  const proto = Object.getPrototypeOf(node);
  const original = Object.getOwnPropertyDescriptor(proto, "textContent");
  Object.defineProperty(proto, "textContent", { configurable: true, get: () => null });
  try {
    fn();
  } finally {
    if (original) {
      Object.defineProperty(proto, "textContent", original);
    } else {
      delete (proto as any).textContent;
    }
  }
}

function getDetailId(site: unknown, doc: Document) {
  return (site as any).getFieldData(doc, idQuery);
}

describe("TCG 详情页 id 选择器（M-3）", () => {
  it("从详情页 URL 的 id 参数取出 id", () => {
    const site = new TCG(metadata, {} as any);
    expect(getDetailId(site, createDetailDocument("https://thegeeks.click/details.php?id=12345"))).toBe(12345);
  });

  it("浏览器语义（Document.textContent === null）下不抛 TypeError", () => {
    const site = new TCG(metadata, {} as any);
    const doc = createDetailDocument("https://thegeeks.click/details.php?id=12345");

    withBrowserLikeDocument(doc, () => {
      expect(() => getDetailId(site, doc)).not.toThrow();
      expect(getDetailId(site, doc)).toBe(12345);
    });
  });

  it("URL 里没有 id 参数时返回空串（交给引擎的 url 兜底，不抛错也不瞎猜）", () => {
    const site = new TCG(metadata, {} as any);
    const doc = createDetailDocument("https://thegeeks.click/details.php");

    withBrowserLikeDocument(doc, () => {
      expect(getDetailId(site, doc)).toBe("");
    });
  });

  it("搜索页 id 仍从详情链接解析（与详情页两条路径都可用）", () => {
    const site = new TCG(metadata, {} as any);
    const doc = new DOMParser().parseFromString(
      `<html><body><table><tr><td><a href="details.php?id=777" title="T">T</a></td></tr></table></body></html>`,
      "text/html",
    );
    const row = doc.querySelector("tr")!;
    expect((site as any).getFieldData(row, SchemaMetadata.search!.selectors!.id)).toBe(777);
  });
});
