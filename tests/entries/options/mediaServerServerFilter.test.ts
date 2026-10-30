/**
 * 上游 31affcff（#1599）：媒体库服务器筛选改为 chip 筛选器并即时过滤已加载卡片（antd 重写版）。
 *
 * - 排队中的搜索任务在真正发请求前再校验一次筛选：期间被取消勾选的服务器不再收到请求
 * - 工具条平铺服务器 chip；取消勾选后该服务器已加载的卡片即时隐藏，重新勾选即时恢复（不重新搜索）
 */
import { describe, expect, it, vi } from "vitest";
import { reactive } from "vue";
import { EResultParseStatus } from "@ptd/site";

const { sendMessageMock, state, metadata } = vi.hoisted(() => ({
  sendMessageMock: vi.fn(),
  state: {
    mediaServerSearch: {
      searchKey: "",
      searchResult: [] as any[],
      searchStatus: {} as Record<string, any>,
      isSearching: false,
    },
    resetMediaServerSearchData: vi.fn(),
    showSnackbar: vi.fn(),
  },
  metadata: {
    mediaServers: {} as Record<string, any>,
    getEnabledMediaServers: [] as any[],
    getMediaServers: [] as any[],
    $onReady: async () => {},
  },
}));
const reactiveState = reactive(state);
const reactiveMetadata = reactive(metadata);
vi.mock("@/messages.ts", () => ({ sendMessage: sendMessageMock, onMessage: vi.fn() }));
vi.mock("@/options/stores/runtime.ts", () => ({ useRuntimeStore: () => reactiveState }));
vi.mock("@/options/stores/config.ts", () => ({
  useConfigStore: () => ({
    mediaServerEntity: { queueConcurrency: 1, searchLimit: 50, autoSearchWhenMount: false },
  }),
}));
vi.mock("@/options/stores/metadata.ts", () => ({ useMetadataStore: () => reactiveMetadata }));

function setupServers() {
  vi.resetModules();
  reactiveState.mediaServerSearch = { searchKey: "", searchResult: [], searchStatus: {}, isSearching: false };
  state.resetMediaServerSearchData.mockImplementation(() => {
    reactiveState.mediaServerSearch = { searchKey: "", searchResult: [], searchStatus: {}, isSearching: false };
  });
  const servers = {
    m1: { id: "m1", type: "emby", enabled: true, name: "Emby-1", address: "local" },
    m2: { id: "m2", type: "plex", enabled: true, name: "Plex-2", address: "local" },
  };
  reactiveMetadata.mediaServers = servers;
  reactiveMetadata.getEnabledMediaServers = [servers.m1, servers.m2];
  reactiveMetadata.getMediaServers = [servers.m1, servers.m2];
}

describe("排队中的搜索任务按最新筛选发请求", () => {
  it("排队期间被取消勾选的服务器不再收到请求", async () => {
    setupServers();
    const utils = await import("@/options/views/Overview/MediaServerEntity/utils.ts");
    utils.searchMediaServerIds.value = ["m1", "m2"];

    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve));
    sendMessageMock.mockReset().mockImplementation(async (_type: string, data: any) => {
      if (data.mediaServerId === "m1") await firstGate;
      return { status: EResultParseStatus.success, items: [] };
    });

    await utils.doSearch({ searchKey: "kw" });
    await vi.waitFor(() => expect(sendMessageMock).toHaveBeenCalledTimes(1));
    // m1 的请求还在途、m2 仍在排队时取消勾选 m2
    utils.searchMediaServerIds.value = ["m1"];
    releaseFirst();
    await utils.searchQueue.onIdle();

    const requested = sendMessageMock.mock.calls.map(([, data]) => data.mediaServerId);
    expect(requested).toEqual(["m1"]);
  });
});

describe("工具条服务器 chip 即时过滤已加载卡片", () => {
  it("取消勾选隐藏该服务器的卡片，「全部」恢复；不触发新的搜索", async () => {
    setupServers();
    const card = (server: string, url: string) => ({
      server,
      url,
      name: url,
      poster: "",
      format: "",
      size: 0,
      streams: [],
      user: {},
      raw: {},
    });
    reactiveState.mediaServerSearch = {
      searchKey: "kw",
      searchResult: [card("m1", "a"), card("m2", "b")],
      searchStatus: { m1: { canLoadMore: false }, m2: { canLoadMore: false } },
      isSearching: false,
    };
    sendMessageMock
      .mockReset()
      .mockImplementation(async (type: string) =>
        type === "getMediaServerItemDetail" ? null : { status: EResultParseStatus.success, items: [] },
      );

    const { mountOptionsView } = await import("../../helpers/optionsView.ts");
    const { i18nInstance } = await import("@/options/plugins/i18n.ts");
    const { searchMediaServerIds } = await import("@/options/views/Overview/MediaServerEntity/utils.ts");
    const { default: MediaServerView } = await import("@/options/views/Overview/MediaServerEntity/Index.vue");
    searchMediaServerIds.value = ["m1", "m2"];

    const view = mountOptionsView(MediaServerView, { router: true });
    try {
      await view.settle(60);
      const cardTitles = () => view.$$(".masonry-item .media-card-title").map((el) => el.getAttribute("title"));
      const chip = (text: string) =>
        view.$$<HTMLButtonElement>(".page-toolbar button").find((button) => button.textContent?.includes(text));

      expect(cardTitles()).toEqual(["a", "b"]);
      expect(chip("Plex-2")?.getAttribute("aria-pressed")).toBe("true");

      chip("Plex-2")!.click();
      await view.settle(40);
      expect(searchMediaServerIds.value).toEqual(["m1"]);
      expect(cardTitles(), "取消勾选后该服务器的卡片即时隐藏").toEqual(["a"]);

      chip("Emby-1")!.click();
      await view.settle(40);
      expect(cardTitles()).toEqual([]);
      expect(view.text(), "结果全被筛掉时给出专门提示，而不是「暂无内容」").toContain(
        i18nInstance.global.t("MediaServerEntity.serverFilter.allHidden"),
      );

      chip(i18nInstance.global.t("MediaServerEntity.serverFilter.all"))!.click();
      await view.settle(40);
      expect(cardTitles(), "「全部」即时恢复，不必重新搜索").toEqual(["a", "b"]);
      expect(sendMessageMock.mock.calls.filter(([type]) => type === "getMediaServerSearchResult")).toEqual([]);
    } finally {
      view.unmount();
    }
  });
});

describe("媒体库可操作入口", () => {
  async function mountLibrary(count = 1) {
    setupServers();
    reactiveState.mediaServerSearch = {
      searchKey: "saved-keyword",
      searchResult: Array.from({ length: count }, (_, index) => ({
        id: String(index),
        server: "m1",
        url: `https://media.local/${index}`,
        name: `Title ${index}`,
        poster: "",
        user: {},
        raw: {},
        description: "Library item summary",
        duration: 7384,
        externalUrls: [{ name: "IMDb", url: "https://www.imdb.com/title/tt1" }],
      })),
      searchStatus: { m1: { canLoadMore: false } },
      isSearching: false,
    };
    sendMessageMock.mockReset().mockResolvedValue({ status: EResultParseStatus.success, items: [] });
    const { mountOptionsView } = await import("../../helpers/optionsView.ts");
    const { default: MediaServerView } = await import("@/options/views/Overview/MediaServerEntity/Index.vue");
    const view = mountOptionsView(MediaServerView, { router: true });
    await view.settle(60);
    return view;
  }

  it("点击海报直接打开详情，访问服务器有独立链接，缺图仍有可操作占位", async () => {
    const view = await mountLibrary();
    try {
      const poster = view.$<HTMLButtonElement>("button.media-poster-button");
      expect(poster, "详情不能依赖鼠标悬停").not.toBeNull();
      expect(poster!.getAttribute("aria-label")).toContain("Title 0");
      expect(view.$(".media-poster-fallback")).not.toBeNull();
      expect(view.$('a[href="https://media.local/0"]')?.getAttribute("target")).toBe("_blank");
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      poster!.click();
      await view.settle(60);
      expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Title 0");
    } finally {
      view.unmount();
    }
  });

  it("悬浮海报显示摘要和外部链接，打开详情后关闭悬浮卡片", async () => {
    const view = await mountLibrary();
    try {
      const poster = view.$<HTMLButtonElement>("button.media-poster-button")!;
      poster.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));
      await view.settle(450);
      const preview = document.querySelector(".media-hover-preview");
      expect(preview?.textContent).toContain("Library item summary");
      expect(preview?.querySelector('a[href="https://www.imdb.com/title/tt1"]')).not.toBeNull();
      poster.click();
      await view.settle(400);
      expect(
        document.querySelector(".ant-popover-hidden .media-hover-preview") ||
          !document.querySelector(".media-hover-preview"),
      ).toBeTruthy();
    } finally {
      view.unmount();
    }
  });

  it("详情加载失败显示重试入口，重试成功后更新内容，并显示可读时长", async () => {
    const view = await mountLibrary();
    try {
      sendMessageMock.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({
        id: "0",
        server: "m1",
        url: "https://media.local/0",
        name: "Detailed Title",
        description: "Full detail",
        duration: 7384,
        user: {},
        raw: {},
      });
      view.$<HTMLButtonElement>("button.media-poster-button")!.click();
      await view.settle(80);
      const modal = document.querySelector('[role="dialog"]')!;
      expect(modal.textContent).toContain("2:03:04");
      const retry = modal.querySelector<HTMLButtonElement>(".media-detail-retry");
      expect(retry, "详情失败后用户可以重试").not.toBeNull();
      retry!.click();
      await view.settle(80);
      expect(modal.textContent).toContain("Detailed Title");
      expect(modal.textContent).toContain("Full detail");
      expect(modal.querySelector(".media-detail-retry")).toBeNull();
    } finally {
      view.unmount();
    }
  });

  it.each([0, 1])("关闭详情后打开条目 %s 从顶部展示", async (index) => {
    const view = await mountLibrary(2);
    try {
      view.$<HTMLButtonElement>(".media-poster-button")!.click();
      await view.settle(60);
      document.querySelector<HTMLElement>(".ant-modal-body")!.scrollTop = 200;
      document.querySelector<HTMLButtonElement>(".ant-modal-close")!.click();
      await view.settle(400);
      view.$$<HTMLButtonElement>(".media-poster-button")[index].click();
      await view.settle(60);
      expect(document.querySelector<HTMLElement>(".ant-modal-body")!.scrollTop).toBe(0);
    } finally {
      view.unmount();
    }
  });

  it("恢复已搜索的关键词，中文输入确认不发请求，显式提交按钮执行搜索", async () => {
    const view = await mountLibrary();
    try {
      const input = view.$<HTMLInputElement>(".page-toolbar input")!;
      expect(input.value).toBe("saved-keyword");
      input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      const enter = new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true });
      input.dispatchEvent(enter);
      expect(enter.defaultPrevented).toBe(true);
      input.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", isComposing: true, bubbles: true }));
      await view.settle();
      expect(sendMessageMock).not.toHaveBeenCalled();
      input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
      input.value = "new-keyword";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await view.settle();
      expect(view.$('button[type="submit"]'), "搜索有可点击的提交按钮").not.toBeNull();
      view.$("form[role='search']")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await view.settle();
      expect(sendMessageMock.mock.calls.filter(([type]) => type === "getMediaServerSearchResult")).toHaveLength(2);
      expect(sendMessageMock.mock.calls[0][1].keywords).toBe("new-keyword");
    } finally {
      view.unmount();
    }
  });

  it("已加载但未渲染的条目可手动展开，不依赖滚动观察器或再次请求", async () => {
    const view = await mountLibrary(45);
    try {
      expect(view.$$(".masonry-item")).toHaveLength(40);
      const { i18nInstance } = await import("@/options/plugins/i18n.ts");
      const loadMore = view
        .$$<HTMLButtonElement>("button")
        .find((button) => button.textContent?.includes(i18nInstance.global.t("MediaServerEntity.loadMore")));
      expect(loadMore?.disabled).toBe(false);
      loadMore!.click();
      await view.settle();
      expect(view.$$(".masonry-item")).toHaveLength(45);
      expect(sendMessageMock).not.toHaveBeenCalled();
    } finally {
      view.unmount();
    }
  });
});
