import { beforeEach, describe, expect, it, vi } from "vitest";
import { EResultParseStatus } from "@ptd/site";
import { sendMessage } from "@/messages.ts";

const runtimeState = {
  resetSearchData: vi.fn(),
  showSnakebar: vi.fn(),
  search: {
    isSearching: true,
    snapshot: undefined as string | undefined,
    searchKey: "test",
    searchResult: [] as any[],
    searchPlan: {
      "site-a|$|default": {
        status: 1,
        statusMsg: undefined,
      },
      "site-b|$|default": {
        status: 2,
        statusMsg: undefined,
      },
    },
  },
};

vi.mock("@/messages.ts", () => ({ sendMessage: vi.fn(), onMessage: vi.fn() }));
vi.mock("@/options/stores/runtime.ts", () => ({ useRuntimeStore: () => runtimeState }));
vi.mock("@/options/stores/config.ts", () => ({
  useConfigStore: () => ({ searchEntity: { queueConcurrency: 1, treatTTQueryAsImdbSearch: false } }),
}));
const getSearchSolution = vi.hoisted(() => vi.fn());
vi.mock("@/options/stores/metadata.ts", () => ({ useMetadataStore: () => ({ getSearchSolution }) }));
vi.mock("@/options/views/Overview/SearchEntity/utils/filter.ts", () => ({
  tableCustomFilter: {
    advanceFilterDictRef: { value: {} },
    buildAdvanceItemPropsFn: vi.fn(),
    updateTableFilterValueFn: vi.fn(),
    advanceItemPropsRef: { value: { site: [] } },
  },
}));

async function loadSearchModule() {
  vi.resetModules();
  return await import("@/options/views/Overview/SearchEntity/utils/search.ts");
}

describe("搜索取消：必须使在途任务失效", () => {
  beforeEach(() => {
    vi.mocked(sendMessage).mockReset();
    runtimeState.search.snapshot = undefined;
    runtimeState.search.searchResult = [];
    runtimeState.search.isSearching = true;
    runtimeState.search.searchPlan = {
      "site-a|$|default": {
        status: 1,
        statusMsg: undefined,
      },
      "site-b|$|default": {
        status: 2,
        statusMsg: undefined,
      },
    } as any;
  });

  it("offscreen 请求失败时搜索项进入错误状态，可由重试筛选找到", async () => {
    vi.mocked(sendMessage).mockRejectedValueOnce(new Error("message port closed"));
    const { doSearchEntity, defaultErrorSearchPlanStatus, searchQueue } = await loadSearchModule();

    await doSearchEntity("site-a", "default", {} as any);
    await searchQueue.onIdle();

    const plan = runtimeState.search.searchPlan["site-a|$|default"];
    expect(plan.status).toBe(EResultParseStatus.unknownError);
    expect(plan.statusMsg).toContain("message port closed");
    expect(defaultErrorSearchPlanStatus).toContain(plan.status);
  });

  it("取消后，取消前捕获的搜索轮次不再是当前轮次", async () => {
    const { cancelSearchQueue, captureSearchTaskEpoch, isSearchTaskCurrent } = await loadSearchModule();
    const taskEpoch = captureSearchTaskEpoch();

    cancelSearchQueue();

    expect(isSearchTaskCurrent(taskEpoch)).toBe(false);
    expect(runtimeState.search.isSearching).toBe(false);
    expect(runtimeState.search.searchPlan["site-a|$|default"].statusMsg).toBe("i18n.userCancel");
  });

  it("M-22：取消时在途（working）的计划被收尾，响应到达后不会停在 working", async () => {
    let resolveResponse!: (value: unknown) => void;
    vi.mocked(sendMessage).mockImplementationOnce(() => new Promise((resolve) => (resolveResponse = resolve)) as any);
    const { doSearchEntity, cancelSearchQueue, searchQueue } = await loadSearchModule();

    await doSearchEntity("site-a", "default", {} as any);
    await vi.waitFor(() =>
      expect(runtimeState.search.searchPlan["site-a|$|default"].status).toBe(EResultParseStatus.working),
    );

    cancelSearchQueue();
    resolveResponse({ status: EResultParseStatus.success, data: [] });
    await searchQueue.onIdle();

    const plan = runtimeState.search.searchPlan["site-a|$|default"];
    expect(plan.status).toBe(EResultParseStatus.passParse);
    expect(plan.statusMsg).toBe("i18n.userCancel");
  });

  it("F2：暂停后取消搜索，队列必须恢复运行，下一次搜索能真正发出请求", async () => {
    getSearchSolution.mockReset().mockResolvedValue({
      id: "default",
      solutions: [{ siteId: "site-b", searchEntries: { default: {} } }],
    });
    vi.mocked(sendMessage).mockResolvedValue({ status: EResultParseStatus.success, data: [] } as any);

    const { pauseSearchQueue, cancelSearchQueue, doSearch, searchQueue, searchQueuePaused } = await loadSearchModule();

    pauseSearchQueue();
    expect(searchQueue.isPaused).toBe(true);
    expect(searchQueuePaused.value).toBe(true);

    cancelSearchQueue();
    // PQueue 的 paused 是持久状态：clear() 不会恢复运行，必须显式 start()
    expect(searchQueue.isPaused).toBe(false);
    expect(searchQueuePaused.value).toBe(false);

    await doSearch("kw", "default", true);
    await searchQueue.onIdle();

    expect(searchQueue.size).toBe(0);
    expect(vi.mocked(sendMessage).mock.calls.filter(([type]) => type === "getSiteSearchResult")).toHaveLength(1);
  });

  it("D2-01：恢复出来的 isSearching / waiting 计划在页面加载时被收尾", async () => {
    runtimeState.search.isSearching = true;
    runtimeState.search.searchPlan = {
      "mteam|$|default": {
        status: EResultParseStatus.waiting,
        siteId: "mteam",
        searchEntryName: "default",
        searchEntry: {},
      },
      "hdbits|$|default": {
        status: EResultParseStatus.working,
        siteId: "hdbits",
        searchEntryName: "default",
        searchEntry: {},
      },
    } as any;
    const { reconcileRestoredSearchState } = await loadSearchModule();

    expect(reconcileRestoredSearchState()).toBe(true);
    expect(runtimeState.search.isSearching).toBe(false);
    for (const plan of Object.values(runtimeState.search.searchPlan)) {
      expect(plan.status).toBe(EResultParseStatus.passParse);
      expect(plan.statusMsg).toBe("i18n.userCancel");
      expect((plan as any).endAt).toBeTypeOf("number");
    }
  });

  it("D2-01：队列里已没有对应任务时，「上移队列」不再抛未处理异常", async () => {
    (runtimeState.search.searchPlan as any)["ghost|$|default"] = { queuePriority: 1 } as any;
    const { raiseSearchPriority } = await loadSearchModule();

    await expect(raiseSearchPriority("ghost|$|default" as any)).resolves.toBeUndefined();
  });

  it("D2-04：快照视图下拒绝实时搜索，避免快照与实时结果混用", async () => {
    runtimeState.search.snapshot = "snap-1";
    runtimeState.search.searchPlan = {} as any;
    vi.mocked(sendMessage).mockResolvedValue({ status: EResultParseStatus.success, data: [] } as any);
    const { doSearchEntity, retrySearch } = await loadSearchModule();

    await doSearchEntity("site-a", "default", {} as any);
    await retrySearch();

    expect(runtimeState.search.searchPlan).toEqual({});
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("方案展开晚于新一轮搜索时，不再入队旧方案", async () => {
    let resolveOld!: (value: any) => void;
    const old = new Promise<any>((resolve) => {
      resolveOld = resolve;
    });
    getSearchSolution
      .mockReset()
      .mockReturnValueOnce(old)
      .mockResolvedValueOnce({
        id: "new",
        solutions: [{ siteId: "site-b", searchEntries: { default: {} } }],
      });
    runtimeState.resetSearchData.mockImplementation(() => {
      runtimeState.search.searchPlan = {} as any;
      runtimeState.search.searchResult = [];
    });
    vi.mocked(sendMessage).mockResolvedValue({ status: EResultParseStatus.success, data: [] } as any);
    const { doSearch, searchQueue } = await loadSearchModule();
    const first = doSearch("old", "old");
    await doSearch("new", "new");
    resolveOld({ id: "old", solutions: [{ siteId: "site-a", searchEntries: { default: {} } }] });
    await first;
    await searchQueue.onIdle();
    expect(Object.keys(runtimeState.search.searchPlan)).toEqual(["site-b|$|default"]);
    expect(vi.mocked(sendMessage).mock.calls.filter(([type]) => type === "getSiteSearchResult")).toHaveLength(1);
  });
});

describe("D2-03：路由变化决定是否真正发起搜索", () => {
  const state = (over: Record<string, unknown> = {}) => ({
    searchKey: "kw",
    searchPlanKey: "default",
    startAt: 1,
    resultCount: 2,
    snapshot: undefined as string | undefined,
    ...over,
  });

  it("带 flush 的地址总是发起搜索；处理完可以从 query 中去掉 flush", async () => {
    const { resolveRouteSearchDecision, stripFlushFromQuery } = await loadSearchModule();

    const decision = resolveRouteSearchDecision({
      query: { search: "kw", plan: "default", flush: "1" },
      state: state(),
    });
    expect(decision).toEqual({ search: "kw", plan: "default", resetData: true });

    // 修复前 flush 一直留在 URL 里，刷新/后退会再次清空结果并重搜
    expect(stripFlushFromQuery({ search: "kw", plan: "default", flush: "1" })).toEqual({
      search: "kw",
      plan: "default",
    });
  });

  it("刷新/后退到已处理过 flush 的地址（无 flush）保留恢复结果，不重搜", async () => {
    const { resolveRouteSearchDecision } = await loadSearchModule();

    const decision = resolveRouteSearchDecision({
      query: { search: "kw", plan: "default" },
      state: state(),
    });
    expect(decision.search).toBeUndefined();
    expect(decision.resetData).toBe(false);
  });

  it("地址里的搜索词与恢复结果不同则重新搜索", async () => {
    const { resolveRouteSearchDecision } = await loadSearchModule();

    expect(resolveRouteSearchDecision({ query: { search: "other" }, state: state() }).search).toBe("other");
  });

  it("重复 query 参数（数组）取第一个值，不把数组写进 store", async () => {
    const { resolveRouteSearchDecision } = await loadSearchModule();

    const decision = resolveRouteSearchDecision({
      query: { search: ["a", "b"], plan: ["default", "x"] },
      previousQuery: { search: "kw" },
      state: state(),
    });
    expect(decision.search).toBe("a");
    expect(decision.plan).toBe("default");
  });

  it("离开快照视图（URL 已无 snapshot）时要求清掉快照数据", async () => {
    const { resolveRouteSearchDecision } = await loadSearchModule();

    const decision = resolveRouteSearchDecision({
      query: { search: "kw", plan: "default" },
      previousQuery: { snapshot: "snap-1" },
      state: state({ snapshot: "snap-1" }),
    });
    expect(decision.resetData).toBe(true);
  });

  it("非首次导航里只有 plan 变化也发起搜索", async () => {
    const { resolveRouteSearchDecision } = await loadSearchModule();

    const decision = resolveRouteSearchDecision({
      query: { plan: "site:mteam" },
      previousQuery: { plan: "default" },
      state: state(),
    });
    expect(decision.search).toBe("");
    expect(decision.plan).toBe("site:mteam");
  });
});

describe("OUI-2 / E / F：搜索真正结束的时机、nonce 清理、暂停态自动恢复", () => {
  beforeEach(() => {
    vi.mocked(sendMessage).mockReset();
    runtimeState.search.snapshot = undefined;
    runtimeState.search.searchResult = [];
    runtimeState.search.isSearching = true;
    runtimeState.search.searchPlan = {} as any;
    getSearchSolution.mockReset();
  });

  it("OUI-2：waitForSearchQueueIdle 在搜索任务真正完成前不 resolve", async () => {
    let releaseResponse!: (value: any) => void;
    vi.mocked(sendMessage).mockImplementationOnce(() => new Promise((resolve) => (releaseResponse = resolve)) as any);
    const { doSearchEntity, waitForSearchQueueIdle } = await loadSearchModule();

    await doSearchEntity("site-a", "default", {} as any);
    let settled = false;
    const idle = waitForSearchQueueIdle().then(() => {
      settled = true;
    });

    await vi.waitFor(() =>
      expect(runtimeState.search.searchPlan["site-a|$|default"].status).toBe(EResultParseStatus.working),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled, "搜索请求未返回时不得提前认为队列空闲（否则 flush 会被提前摘掉）").toBe(false);

    releaseResponse({ status: EResultParseStatus.success, data: [] });
    await idle;
    expect(settled).toBe(true);
  });

  it("OUI-2：队列已经空闲时 waitForSearchQueueIdle 立即 resolve（无搜索任务也不挂起）", async () => {
    const { waitForSearchQueueIdle } = await loadSearchModule();
    await expect(waitForSearchQueueIdle()).resolves.toBeUndefined();
  });

  it("E：stripFlushFromQuery 同时摘掉 flush 与搜索 nonce（t）", async () => {
    const { stripFlushFromQuery } = await loadSearchModule();

    expect(
      stripFlushFromQuery({ search: "kw", plan: "default", flush: "1", t: "1729700000000", other: "keep" }),
    ).toEqual({ search: "kw", plan: "default", other: "keep" });
  });

  it("F：暂停状态下发起新一轮搜索会自动恢复队列，不会卡在「搜索中」", async () => {
    getSearchSolution.mockReset().mockResolvedValue({
      id: "default",
      solutions: [{ siteId: "site-b", searchEntries: { default: {} } }],
    });
    vi.mocked(sendMessage).mockResolvedValue({ status: EResultParseStatus.success, data: [] } as any);
    runtimeState.search.isSearching = false;
    const { pauseSearchQueue, doSearch, searchQueuePaused, waitForSearchQueueIdle } = await loadSearchModule();

    pauseSearchQueue();
    expect(searchQueuePaused.value).toBe(true);

    await doSearch("kw", "default", true);
    expect(searchQueuePaused.value, "flush 分支必须 startSearchQueue()，否则任务永远停在暂停队列").toBe(false);

    await waitForSearchQueueIdle();
    expect(runtimeState.search.isSearching).toBe(false);
    expect(
      vi.mocked(sendMessage).mock.calls.filter(([type]) => type === "getSiteSearchResult").length,
      "队列恢复后请求必须真的发出去",
    ).toBe(1);
  });
});
