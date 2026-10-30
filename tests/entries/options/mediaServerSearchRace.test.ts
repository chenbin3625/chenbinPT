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
    $onReady: async () => {},
  },
}));
const reactiveState = reactive(state);
const reactiveMetadata = reactive(metadata);
vi.mock("@/messages.ts", () => ({ sendMessage: sendMessageMock, onMessage: vi.fn() }));
vi.mock("@/options/stores/runtime.ts", () => ({ useRuntimeStore: () => reactiveState }));
vi.mock("@/options/stores/config.ts", () => ({
  useConfigStore: () => ({ mediaServerEntity: { queueConcurrency: 1, searchLimit: 50 } }),
}));
vi.mock("@/options/stores/metadata.ts", () => ({ useMetadataStore: () => reactiveMetadata }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => (resolve = res));
  return { promise, resolve };
}

describe("媒体搜索的冷启动选择和搜索轮次", () => {
  it("水合后初选启用服务器，切词后丢弃旧响应和队列任务", async () => {
    const runtime = reactiveState;
    const meta = reactiveMetadata;
    state.resetMediaServerSearchData.mockImplementation(() => {
      runtime.mediaServerSearch = { searchKey: "", searchResult: [], searchStatus: {}, isSearching: false };
    });
    const { doSearch, searchQueue, searchMediaServerIds } =
      await import("@/options/views/Overview/MediaServerEntity/utils.ts");
    expect(searchMediaServerIds.value).toEqual([]);
    meta.mediaServers["m1"] = { id: "m1", enabled: true, name: "M1", address: "local" };
    meta.getEnabledMediaServers = [meta.mediaServers["m1"]];
    await Promise.resolve();
    expect(searchMediaServerIds.value).toEqual(["m1"]);

    const old = deferred<any>();
    const fresh = deferred<any>();
    sendMessageMock.mockReset().mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    await doSearch({ searchKey: "old" });
    await vi.waitFor(() => expect(sendMessageMock).toHaveBeenCalledTimes(1));
    await doSearch({ searchKey: "new" });
    old.resolve({ status: EResultParseStatus.success, items: [{ url: "old" }] });
    await vi.waitFor(() => expect(sendMessageMock).toHaveBeenCalledTimes(2));
    fresh.resolve({ status: EResultParseStatus.success, items: [{ url: "new" }] });
    await searchQueue.onIdle();
    expect(runtime.mediaServerSearch.searchKey).toBe("new");
    expect(runtime.mediaServerSearch.searchResult.map((item: any) => item.url)).toEqual(["new"]);
    expect(Object.keys(runtime.mediaServerSearch.searchStatus)).toEqual(["m1"]);
  });
});

describe("N1/N16：恢复态收尾与「未选服务器」路径", () => {
  async function loadFresh() {
    vi.resetModules();
    state.mediaServerSearch = { searchKey: "", searchResult: [], searchStatus: {}, isSearching: false };
    state.showSnackbar = vi.fn();
    metadata.mediaServers = { m1: { id: "m1", enabled: true, name: "M1", address: "local" } };
    metadata.getEnabledMediaServers = [metadata.mediaServers["m1"]];
    return await import("@/options/views/Overview/MediaServerEntity/utils.ts");
  }

  it("N1：队列空闲时把 sessionStorage 恢复出来的 isSearching 复位", async () => {
    const utils = await loadFresh();
    // 模拟「恢复出来的 isSearching=true，但 PQueue 是新的空对象」
    reactiveState.mediaServerSearch = {
      searchKey: "abc",
      searchResult: [{ url: "u1" }],
      searchStatus: {},
      isSearching: true,
    };

    expect(utils.searchQueue.size, "新页面/新模块的队列应为空").toBe(0);
    expect(utils.resetSearchingStateIfIdle()).toBe(true);
    expect(reactiveState.mediaServerSearch.isSearching).toBe(false);
  });

  it("N1：队列仍在跑时不做复位（从别的路由切回来时不清掉在途搜索）", async () => {
    const utils = await loadFresh();
    const { promise, resolve } = deferred<any>();
    sendMessageMock.mockReset().mockReturnValueOnce(promise);

    reactiveState.mediaServerSearch.isSearching = true;
    await utils.doSearch({ searchKey: "running" });
    await vi.waitFor(() => expect(utils.searchQueue.pending).toBe(1));

    expect(utils.resetSearchingStateIfIdle(), "队列非空闲时不应复位").toBe(false);
    expect(reactiveState.mediaServerSearch.isSearching).toBe(true);

    resolve({ status: EResultParseStatus.success, items: [] });
    await utils.searchQueue.onIdle();
  });

  it("N16：一个媒体服务器都没勾选时不发请求、不清空已有结果，并提示用户", async () => {
    const utils = await loadFresh();
    reactiveState.mediaServerSearch = {
      searchKey: "old",
      searchResult: [{ url: "keep-me" }],
      searchStatus: {},
      isSearching: false,
    };
    utils.searchMediaServerIds.value = [];
    sendMessageMock.mockReset();

    await utils.doSearch({ searchKey: "new", userInitiated: true });

    expect(sendMessageMock, "没有可搜索的服务器时不应发请求").not.toHaveBeenCalled();
    expect(
      reactiveState.mediaServerSearch.searchResult.map((item: any) => item.url),
      "不应先清空已有结果",
    ).toEqual(["keep-me"]);
    expect(reactiveState.showSnackbar, "应提示用户先选择媒体服务器").toHaveBeenCalled();
  });

  it("N16：searchStatus 只保留当前仍被勾选（且启用）的服务器", async () => {
    const utils = await loadFresh();
    metadata.mediaServers = {
      m1: { id: "m1", enabled: true, name: "M1", address: "local" },
      m2: { id: "m2", enabled: true, name: "M2", address: "local" },
    };
    metadata.getEnabledMediaServers = [metadata.mediaServers["m1"], metadata.mediaServers["m2"]];
    utils.searchMediaServerIds.value = ["m1"];
    reactiveState.mediaServerSearch = {
      searchKey: "same",
      searchResult: [],
      searchStatus: { m1: { canLoadMore: true }, m2: { canLoadMore: true } },
      isSearching: false,
    };
    sendMessageMock.mockReset().mockResolvedValue({ status: EResultParseStatus.success, items: [] });

    await utils.doSearch({ searchKey: "same" });
    await utils.searchQueue.onIdle();

    expect(Object.keys(reactiveState.mediaServerSearch.searchStatus), "取消勾选/已删除的服务器状态应被剪掉").toEqual([
      "m1",
    ]);
  });
});

describe("N15：加载更多沿用结果对应的搜索词", () => {
  it("输入框改了词但没回车时，点「加载更多」仍按旧搜索词加载", async () => {
    vi.resetModules();
    state.mediaServerSearch = {
      searchKey: "old",
      searchResult: [{ url: "u1", server: "m1", name: "n1", poster: "", format: "", size: 0, streams: [], user: {} }],
      searchStatus: { m1: { canLoadMore: true } },
      // N1：恢复出来的 isSearching=true（页面重载后 PQueue 已空）——进入页面必须被收尾复位
      isSearching: true,
    };
    metadata.mediaServers = { m1: { id: "m1", enabled: true, name: "M1", address: "local" } };
    metadata.getEnabledMediaServers = [metadata.mediaServers["m1"]];
    sendMessageMock.mockReset().mockResolvedValue({ status: EResultParseStatus.success, items: [] });

    const { mountOptionsView } = await import("../../helpers/optionsView.ts");
    const { i18nInstance } = await import("@/options/plugins/i18n.ts");
    const { default: MediaServerView } = await import("@/options/views/Overview/MediaServerEntity/Index.vue");

    const view = mountOptionsView(MediaServerView, { router: true });
    try {
      await view.settle(100);

      // N1：队列空闲时进入页面，恢复出来的 isSearching 必须复位，否则「加载更多」永久 loading
      expect(state.mediaServerSearch.isSearching, "恢复的 isSearching 应在页面水合后被复位").toBe(false);
      expect(document.querySelector(".ant-btn-loading"), "不应有按钮停在 loading 状态").toBeNull();

      const input = view.$<HTMLInputElement>(".page-toolbar input");
      expect(input).not.toBeNull();
      input!.value = "new-keyword";
      input!.dispatchEvent(new Event("input", { bubbles: true }));
      await view.settle(40);

      const loadMore = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
        button.textContent?.includes(i18nInstance.global.t("MediaServerEntity.loadMore")),
      );
      expect(loadMore, "应渲染「加载更多」按钮").not.toBeUndefined();
      loadMore!.click();
      await view.settle(80);

      const call = sendMessageMock.mock.calls.find(([type]) => type === "getMediaServerSearchResult");
      expect(call, "应真的发起加载更多请求").not.toBeUndefined();
      expect(call![1], "加载更多必须使用结果对应的搜索词，而不是输入框实时值").toMatchObject({ keywords: "old" });
    } finally {
      view.unmount();
    }
  });
});

describe("媒体库刷新与分页交互", () => {
  async function setup() {
    vi.resetModules();
    reactiveState.mediaServerSearch = { searchKey: "", searchResult: [], searchStatus: {}, isSearching: false };
    state.resetMediaServerSearchData.mockImplementation(() => {
      reactiveState.mediaServerSearch = { searchKey: "", searchResult: [], searchStatus: {}, isSearching: false };
    });
    reactiveMetadata.mediaServers = {
      m1: { id: "m1", enabled: true, name: "M1", address: "local" },
      m2: { id: "m2", enabled: true, name: "M2", address: "local" },
    };
    reactiveMetadata.getEnabledMediaServers = Object.values(reactiveMetadata.mediaServers);
    sendMessageMock.mockReset();
    const utils = await import("@/options/views/Overview/MediaServerEntity/utils.ts");
    utils.searchMediaServerIds.value = ["m1"];
    return utils;
  }

  it("连续提交相同词只请求一次，搜索完成后同词提交刷新旧内容", async () => {
    const utils = await setup();
    const first = deferred<any>();
    sendMessageMock.mockReturnValueOnce(first.promise).mockResolvedValue({
      status: EResultParseStatus.success,
      items: [{ url: "same-url", name: "Updated" }],
    });
    await utils.doSearch({ searchKey: "same" });
    await utils.doSearch({ searchKey: "same" });
    first.resolve({ status: EResultParseStatus.success, items: [{ url: "same-url", name: "Original" }] });
    await utils.searchQueue.onIdle();
    expect(sendMessageMock).toHaveBeenCalledTimes(1);

    await utils.doSearch({ searchKey: "same", userInitiated: true });
    await utils.searchQueue.onIdle();
    expect(reactiveState.mediaServerSearch.searchResult).toEqual([{ url: "same-url", name: "Updated" }]);
  });

  it("分页失败后保留已加载内容和成功游标，重试仍请求失败的那一页", async () => {
    const utils = await setup();
    reactiveState.mediaServerSearch = {
      searchKey: "same",
      searchResult: [{ url: "first" }],
      searchStatus: {
        m1: { status: EResultParseStatus.success, canLoadMore: true, options: { startIndex: 0, limit: 50 } },
      },
      isSearching: false,
    };
    sendMessageMock.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({
      status: EResultParseStatus.success,
      items: [{ url: "second" }],
      options: { startIndex: 50, limit: 50 },
    });
    await utils.doSearch({ searchKey: "same", loadMore: true });
    await utils.searchQueue.onIdle();
    expect(reactiveState.mediaServerSearch.searchStatus.m1.canLoadMore).toBe(true);
    expect(reactiveState.mediaServerSearch.searchResult).toEqual([{ url: "first" }]);
    await utils.doSearch({ searchKey: "same", loadMore: true });
    await utils.searchQueue.onIdle();
    expect(sendMessageMock.mock.calls.map(([, data]) => data.options.startIndex)).toEqual([50, 50]);
    expect(reactiveState.mediaServerSearch.searchResult.map((item) => item.url)).toEqual(["first", "second"]);
  });

  it("筛选变更后同词提交会搜索新选择，并在旧请求结束前保持加载状态", async () => {
    const utils = await setup();
    const old = deferred<any>();
    sendMessageMock
      .mockReturnValueOnce(old.promise)
      .mockResolvedValue({ status: EResultParseStatus.success, items: [] });
    await utils.doSearch({ searchKey: "same" });
    utils.searchMediaServerIds.value = ["m1", "m2"];
    await utils.doSearch({ searchKey: "same", userInitiated: true });
    const searching = reactiveState.mediaServerSearch.isSearching;
    old.resolve({ status: EResultParseStatus.success, items: [] });
    await utils.searchQueue.onIdle();
    expect(sendMessageMock.mock.calls.map(([, data]) => data.mediaServerId)).toEqual(["m1", "m1", "m2"]);
    expect(searching).toBe(true);
  });

  it("加载更多跳过已结束的服务器，连续点击不重复推进分页", async () => {
    const utils = await setup();
    utils.searchMediaServerIds.value = ["m1", "m2"];
    reactiveState.mediaServerSearch = {
      searchKey: "same",
      searchResult: [],
      searchStatus: {
        m1: { canLoadMore: false, options: { startIndex: 0, limit: 50 } },
        m2: { canLoadMore: true, options: { startIndex: 0, limit: 50 } },
      },
      isSearching: false,
    };
    const page = deferred<any>();
    sendMessageMock.mockReturnValue(page.promise);
    await utils.doSearch({ searchKey: "same", loadMore: true });
    await utils.doSearch({ searchKey: "same", loadMore: true });
    page.resolve({ status: EResultParseStatus.success, items: [], options: { startIndex: 50, limit: 50 } });
    await utils.searchQueue.onIdle();
    expect(sendMessageMock.mock.calls.map(([, data]) => data.mediaServerId)).toEqual(["m2"]);
  });

  it("仅包含重复条目的非空页仍可继续翻页", async () => {
    const utils = await setup();
    reactiveState.mediaServerSearch = {
      searchKey: "same",
      searchResult: [{ url: "first" }],
      searchStatus: { m1: { canLoadMore: true, options: { startIndex: 0, limit: 50 } } },
      isSearching: false,
    };
    sendMessageMock.mockResolvedValue({
      status: EResultParseStatus.success,
      items: [{ url: "first" }],
      options: { startIndex: 50, limit: 50 },
    });
    await utils.doSearch({ searchKey: "same", loadMore: true });
    await utils.searchQueue.onIdle();
    expect(reactiveState.mediaServerSearch.searchResult).toHaveLength(1);
    expect(reactiveState.mediaServerSearch.searchStatus.m1.canLoadMore).toBe(true);
  });

  it("取消选中后丢弃该服务器的在途响应", async () => {
    const utils = await setup();
    const response = deferred<any>();
    sendMessageMock.mockReturnValue(response.promise);
    await utils.doSearch({ searchKey: "same" });
    utils.searchMediaServerIds.value = [];
    response.resolve({ status: EResultParseStatus.success, items: [{ url: "late" }] });
    await utils.searchQueue.onIdle();
    expect(reactiveState.mediaServerSearch.searchStatus).toEqual({});
    expect(reactiveState.mediaServerSearch.searchResult).toEqual([]);
  });
});
