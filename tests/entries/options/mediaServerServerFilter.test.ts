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
    showSnakebar: vi.fn(),
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
    sendMessageMock.mockReset().mockResolvedValue({ status: EResultParseStatus.success, items: [] });

    const { mountOptionsView } = await import("../../helpers/optionsView.ts");
    const { i18nInstance } = await import("@/options/plugins/i18n.ts");
    const { searchMediaServerIds } = await import("@/options/views/Overview/MediaServerEntity/utils.ts");
    const { default: MediaServerView } = await import("@/options/views/Overview/MediaServerEntity/Index.vue");
    searchMediaServerIds.value = ["m1", "m2"];

    const view = mountOptionsView(MediaServerView, { router: true });
    try {
      await view.settle(60);
      const cardTitles = () => view.$$(".masonry-item a[title]").map((el) => el.getAttribute("title"));
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
