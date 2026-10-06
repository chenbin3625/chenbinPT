import { beforeEach, describe, expect, it, vi } from "vitest";
import { EResultParseStatus } from "@ptd/site";
import { sendMessage } from "@/messages.ts";

const runtimeState = {
  search: {
    isSearching: true,
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
vi.mock("@/options/stores/metadata.ts", () => ({ useMetadataStore: () => ({}) }));
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
    runtimeState.search.searchResult = [];
    runtimeState.search.isSearching = true;
    runtimeState.search.searchPlan["site-a|$|default"].status = 1;
    runtimeState.search.searchPlan["site-b|$|default"].status = 2;
    runtimeState.search.searchPlan["site-a|$|default"].statusMsg = undefined;
    runtimeState.search.searchPlan["site-b|$|default"].statusMsg = undefined;
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
});
