import { beforeEach, describe, expect, it, vi } from "vitest";

const runtimeState = {
  search: {
    isSearching: true,
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
  useConfigStore: () => ({ searchEntity: { queueConcurrency: 1 } }),
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
    runtimeState.search.isSearching = true;
    runtimeState.search.searchPlan["site-a|$|default"].status = 1;
    runtimeState.search.searchPlan["site-b|$|default"].status = 2;
    runtimeState.search.searchPlan["site-a|$|default"].statusMsg = undefined;
    runtimeState.search.searchPlan["site-b|$|default"].statusMsg = undefined;
  });

  it("取消后，取消前捕获的搜索轮次不再是当前轮次", async () => {
    const { cancelSearchQueue, captureSearchTaskEpoch, isSearchTaskCurrent } = await loadSearchModule();
    const taskEpoch = captureSearchTaskEpoch();

    cancelSearchQueue();

    expect(isSearchTaskCurrent(taskEpoch)).toBe(false);
    expect(runtimeState.search.isSearching).toBe(false);
    expect(runtimeState.search.searchPlan["site-a|$|default"].statusMsg).toBe("i18n.userCancel");
  });
});
