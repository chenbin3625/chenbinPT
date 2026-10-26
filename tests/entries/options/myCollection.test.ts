/**
 * 收藏列表页与收藏对话框（移植自上游 122b8942）。
 *
 * - 收藏列表：渲染收藏、按收藏分类（含「未分类」）筛选、点击分类标签快速筛选、清空走 antd 确认框；
 * - 收藏对话框：只通过 getTorrentFavoriteStatus 读取这些种子的状态（不读整表），
 *   全部已收藏时为「编辑收藏」并回填分类与备注，保存时以输入框为准（空值即清空）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h, nextTick, ref } from "vue";

import { mountOptionsView, prepareOptionsPinia } from "../../helpers/optionsView.ts";

const sendMessageMock = vi.hoisted(() => vi.fn());
vi.mock("@/messages.ts", () => ({ sendMessage: sendMessageMock, onMessage: vi.fn() }));

/** 站点图标 / 名称 / 标题单元格会去读站点元数据，本用例只关心收藏页本身 */
vi.mock("@/options/components/SiteFavicon/Index.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return { default: defineComponent({ props: { siteId: String }, setup: () => () => h("i") }) };
});
vi.mock("@/options/components/SiteName.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    default: defineComponent({ props: { siteId: String }, setup: (props) => () => h("span", props.siteId) }),
  };
});
vi.mock("@/options/components/TorrentTitleTd.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    default: defineComponent({
      props: { item: Object },
      setup: (props) => () => h("span", { class: "title-stub" }, (props.item as any)?.title),
    }),
  };
});

function favorite(id: string, favCategories: string[] = [], extra: Record<string, any> = {}) {
  return {
    key: `s1-${id}`,
    site: "s1",
    id,
    title: `torrent-${id}`,
    size: 1024,
    createdAt: Number(id),
    favCategories,
    ...extra,
  };
}

const titles = () => Array.from(document.querySelectorAll(".ant-table-tbody .title-stub")).map((x) => x.textContent);

afterEach(() => {
  document.body.innerHTML = "";
});

describe("收藏列表页", () => {
  let store: any[];

  beforeEach(() => {
    store = [favorite("3", ["电影"]), favorite("2", ["电影", "剧集"], { comment: "等站免" }), favorite("1")];
    sendMessageMock.mockReset();
    sendMessageMock.mockImplementation(async (type: string, data: any) => {
      if (type === "getTorrentFavorites") return structuredClone(store);
      if (type === "deleteTorrentFavorites") {
        store = store.filter((x) => !data.includes(x.key));
        return undefined;
      }
      return undefined;
    });
  });

  async function mountPage() {
    const pinia = prepareOptionsPinia();
    const { useConfigStore } = await import("@/options/stores/config.ts");
    (useConfigStore(pinia) as any).$save = vi.fn(async () => {});
    const { default: MyCollection } = await import("@/options/views/Overview/MyCollection/Index.vue");
    const view = mountOptionsView(MyCollection, { pinia, router: true });
    await view.settle(120);
    const state = () =>
      (view.app as any)._instance.subTree.component?.setupState ?? (view.app as any)._instance.setupState;
    return { view, state };
  }

  it("渲染全部收藏（默认按收藏时间倒序），备注显示在标题下方", async () => {
    const { view } = await mountPage();
    expect(titles()).toEqual(["torrent-3", "torrent-2", "torrent-1"]);
    expect(view.text()).toContain("等站免");
    view.unmount();
  });

  it("按收藏分类筛选：「未分类」与具体分类可多选，点击行内分类标签快速筛选", async () => {
    const { view, state } = await mountPage();

    state().favCategoryFilter = [""];
    await view.settle(20);
    expect(titles()).toEqual(["torrent-1"]);

    state().favCategoryFilter = ["剧集", ""];
    await view.settle(20);
    expect(titles()).toEqual(["torrent-2", "torrent-1"]);

    state().favCategoryFilter = [];
    await view.settle(20);
    const tag = Array.from(document.querySelectorAll<HTMLElement>(".my-collection__category-tag")).find(
      (element) => element.textContent?.trim() === "剧集",
    )!;
    tag.click();
    await view.settle(20);
    expect(state().favCategoryFilter).toEqual(["剧集"]);
    expect(titles()).toEqual(["torrent-2"]);
    view.unmount();
  });

  it("清空全部走 antd 确认框（不是浏览器原生 confirm），确认后删除全部收藏", async () => {
    const { view } = await mountPage();
    // happy-dom 没有 window.confirm；挂一个替身以证明页面没有走浏览器原生确认框
    const confirmSpy = vi.fn(() => true);
    vi.stubGlobal("confirm", confirmSpy);

    const clearButton = Array.from(document.querySelectorAll<HTMLButtonElement>(".page-toolbar button")).find(
      (button) => button.textContent?.includes("清空全部"),
    )!;
    clearButton.click();
    await view.settle(80);
    const ok = Array.from(document.querySelectorAll<HTMLButtonElement>(".ant-modal-confirm .ant-btn-primary")).at(-1);
    expect(ok, "应弹出 antd 确认框").toBeDefined();
    ok!.click();
    await view.settle(80);

    expect(confirmSpy).not.toHaveBeenCalled();
    expect(sendMessageMock).toHaveBeenCalledWith("deleteTorrentFavorites", ["s1-3", "s1-2", "s1-1"]);
    expect(titles()).toEqual([]);
    vi.unstubAllGlobals();
    view.unmount();
  });
});

describe("收藏对话框", () => {
  const torrents = [
    { site: "s1", id: "1", title: "a", link: "https://s1/dl?passkey=x", url: "https://s1/d/1", size: 1 },
    { site: "s1", id: "2", title: "b", link: "https://s1/dl?passkey=y", url: "https://s1/d/2", size: 2 },
  ];

  async function mountDialog(status: any) {
    sendMessageMock.mockReset();
    sendMessageMock.mockImplementation(async (type: string) => {
      if (type === "getTorrentFavoriteStatus") return status;
      if (type === "createTorrentFavorites") return torrents.length;
      return undefined;
    });

    const pinia = prepareOptionsPinia();
    const { default: TorrentFavoriteDialog } = await import("@/options/components/TorrentFavoriteDialog.vue");
    const open = ref(false);
    const saved = vi.fn();
    const Root = defineComponent({
      setup: () => () =>
        h(TorrentFavoriteDialog as any, {
          modelValue: open.value,
          "onUpdate:modelValue": (v: boolean) => (open.value = v),
          torrentItems: torrents,
          onSaved: saved,
        }),
    });
    const view = mountOptionsView(Root, { pinia });
    open.value = true;
    await nextTick();
    await view.settle(80);
    return { view, open, saved };
  }

  it("只用 getTorrentFavoriteStatus 查询这些种子的状态（不读取整份收藏表，也不发送下载链接）", async () => {
    const { view } = await mountDialog({ favorites: [], favCategories: ["电影"] });

    const types = sendMessageMock.mock.calls.map(([type]) => type);
    expect(types).toContain("getTorrentFavoriteStatus");
    expect(types).not.toContain("getTorrentFavorites");
    const [, query] = sendMessageMock.mock.calls.find(([type]) => type === "getTorrentFavoriteStatus")!;
    expect(query.torrents).toEqual(torrents.map(({ site, id, link, url }) => ({ site, id, link, url })));
    expect(document.querySelector(".ant-modal-title")?.textContent).toContain("收藏 2 个种子");
    view.unmount();
  });

  it("全部已收藏时为「编辑收藏」并回填分类与备注；保存时以输入框为准", async () => {
    const { view, open, saved } = await mountDialog({
      favorites: [
        { key: "s1-1", favCategories: ["电影"], comment: "备注1" },
        { key: "s1-2", favCategories: [], comment: "" },
      ],
      favCategories: ["电影"],
    });

    expect(document.querySelector(".ant-modal-title")?.textContent).toContain("编辑收藏");
    expect(document.querySelector<HTMLTextAreaElement>(".ant-modal textarea")!.value).toBe("备注1");

    const textarea = document.querySelector<HTMLTextAreaElement>(".ant-modal textarea")!;
    textarea.value = "  新备注  ";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    await view.settle(20);

    document.querySelector<HTMLButtonElement>(".ant-modal-footer .ant-btn-primary")!.click();
    await view.settle(60);

    expect(sendMessageMock).toHaveBeenCalledWith("createTorrentFavorites", {
      torrents,
      favCategories: ["电影"],
      comment: "新备注",
    });
    expect(saved).toHaveBeenCalledTimes(1);
    expect(open.value).toBe(false);
    view.unmount();
  });
});
