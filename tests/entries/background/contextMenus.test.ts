/**
 * 右键菜单「上下文摘要 + 合并式防抖」测试（见 docs/performance-audit.md P1-7）。
 *
 * 本轮重构为了让切标签页不再全量重建菜单，引入了两个回归：
 * - contextKey 只有 `tabHost|siteId|siteName`：只改 `config.contextMenus.*`、下载器、
 *   搜索方案、站点列表时菜单永远不重建；
 * - `chrome.storage.onChanged` 在已有定时器时直接 return：1s 窗口内的后续变更被永久丢弃
 *   （而 lastBuiltContextKey 已被置 null），最后一次变更可能永远不生效。
 *
 * 这里只测可注入依赖的纯函数：摘要函数与合并式防抖。
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/messages.ts", () => ({
  sendMessage: vi.fn(),
  onMessage: vi.fn(),
}));

vi.mock("@/background/utils/base.ts", () => ({
  getExtStorageCached: vi.fn(),
  getExtStoragePathCached: vi.fn(),
  logBackgroundError: vi.fn(),
  openOptionsPage: vi.fn(),
}));

vi.stubGlobal("chrome", {
  contextMenus: {
    onClicked: { addListener: vi.fn() },
    create: vi.fn(),
    remove: vi.fn(() => Promise.resolve()),
    removeAll: vi.fn(() => Promise.resolve()),
  },
  tabs: {
    onActivated: { addListener: vi.fn() },
    // L-2：模块现在还会注册 tabs.onUpdated（同标签页导航后重建菜单），stub 必须提供它
    onUpdated: { addListener: vi.fn() },
    query: vi.fn(() => Promise.resolve([])),
  },
  storage: { onChanged: { addListener: vi.fn() } },
  i18n: { getMessage: vi.fn((key: string) => key) },
});

const { buildContextMenusContextKey, createCoalescingDebounce } = await import("@/background/utils/contextMenus.ts");

const baseMetadata = {
  solutions: { default: { id: "default", name: "Default", enabled: true, sort: 1 } },
  sites: { mteam: { isOffline: false, allowSearch: true, sortIndex: 10 } },
  downloaders: {
    qb: {
      id: "qb",
      name: "qBittorrent",
      address: "http://127.0.0.1:8080",
      enabled: true,
      sortIndex: 100,
      suggestFolders: ["/downloads"],
    },
  },
};

const baseConfig = {
  contextMenus: {
    enabled: true,
    allowSelectionTextSearch: true,
    allowSocialLinkSearch: true,
    allowLinkDownloadPush: true,
  },
};

function makeInput(overrides: Record<string, unknown> = {}): any {
  return {
    tabHost: "mteam.example",
    thisTabSiteId: "mteam",
    thisTabSiteName: "M-Team",
    config: baseConfig,
    metadata: baseMetadata,
    siteNameMap: { mteam: "M-Team" },
    ...overrides,
  };
}

describe("buildContextMenusContextKey", () => {
  it("相同输入得到相同 key（保证仍能跳过无意义重建）", () => {
    expect(buildContextMenusContextKey(makeInput())).toBe(buildContextMenusContextKey(makeInput()));
  });

  it("config.contextMenus.* 变化必须让 key 变化（旧实现只比较站点，改配置不会重建）", () => {
    const base = buildContextMenusContextKey(makeInput());

    expect(
      buildContextMenusContextKey(
        makeInput({ config: { contextMenus: { ...baseConfig.contextMenus, enabled: false } } }),
      ),
    ).not.toBe(base);
    expect(
      buildContextMenusContextKey(
        makeInput({ config: { contextMenus: { ...baseConfig.contextMenus, allowLinkDownloadPush: false } } }),
      ),
    ).not.toBe(base);
    expect(
      buildContextMenusContextKey(
        makeInput({ config: { contextMenus: { ...baseConfig.contextMenus, allowSocialLinkSearch: false } } }),
      ),
    ).not.toBe(base);
  });

  it("下载器列表/建议目录变化必须让 key 变化", () => {
    const base = buildContextMenusContextKey(makeInput());

    const changedFolders = {
      ...baseMetadata,
      downloaders: { qb: { ...baseMetadata.downloaders.qb, suggestFolders: ["/downloads", "/movies"] } },
    };
    expect(buildContextMenusContextKey(makeInput({ metadata: changedFolders }))).not.toBe(base);

    const disabledDownloader = {
      ...baseMetadata,
      downloaders: { qb: { ...baseMetadata.downloaders.qb, enabled: false } },
    };
    expect(buildContextMenusContextKey(makeInput({ metadata: disabledDownloader }))).not.toBe(base);
  });

  it("搜索方案与可搜索站点列表变化必须让 key 变化", () => {
    const base = buildContextMenusContextKey(makeInput());

    const anotherSolution = {
      ...baseMetadata,
      solutions: {
        ...baseMetadata.solutions,
        second: { id: "second", name: "Second", enabled: true, sort: 2 },
      },
    };
    expect(buildContextMenusContextKey(makeInput({ metadata: anotherSolution }))).not.toBe(base);

    const noSearchSite = {
      ...baseMetadata,
      sites: { mteam: { ...baseMetadata.sites.mteam, allowSearch: false } },
    };
    expect(buildContextMenusContextKey(makeInput({ metadata: noSearchSite }))).not.toBe(base);

    const offlineSite = {
      ...baseMetadata,
      sites: { mteam: { ...baseMetadata.sites.mteam, isOffline: true } },
    };
    expect(buildContextMenusContextKey(makeInput({ metadata: offlineSite }))).not.toBe(base);
  });

  it("当前站点名称（siteIndex 标题）变化必须让 key 变化", () => {
    const base = buildContextMenusContextKey(makeInput());
    expect(buildContextMenusContextKey(makeInput({ siteNameMap: { mteam: "M-Team 新名" } }))).not.toBe(base);
  });

  it("BACKGROUNDSHARED-1：downloader.feature.DefaultAutoStart 变化必须让 key 变化（菜单闭包读它决定 addAtPaused）", () => {
    const base = buildContextMenusContextKey(makeInput());

    const autoStartChanged = {
      ...baseMetadata,
      downloaders: {
        qb: { ...baseMetadata.downloaders.qb, feature: { DefaultAutoStart: false } },
      },
    };
    expect(buildContextMenusContextKey(makeInput({ metadata: autoStartChanged }))).not.toBe(base);
  });

  it("BACKGROUNDSHARED-4：excludedSites 与站点过滤开关变化必须让 key 变化（否则改了排除也不会重建菜单）", () => {
    const base = buildContextMenusContextKey(makeInput());

    const excludedChanged = {
      ...baseMetadata,
      downloaders: {
        qb: { ...baseMetadata.downloaders.qb, excludedSites: ["mteam"] },
      },
    };
    expect(buildContextMenusContextKey(makeInput({ metadata: excludedChanged }))).not.toBe(base);

    const filterEnabled = { ...baseConfig, download: { allowDownloaderFilterForSite: true } };
    expect(buildContextMenusContextKey(makeInput({ config: filterEnabled }))).not.toBe(base);
  });
});

describe("createCoalescingDebounce", () => {
  it("窗口内的多次变更只执行一次", async () => {
    vi.useFakeTimers();
    const run = vi.fn();
    const debounce = createCoalescingDebounce(run, 1000);

    for (let i = 0; i < 5; i++) {
      debounce.schedule();
    }

    await vi.advanceTimersByTimeAsync(999);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });

  it("执行期间到达的新变更会在本轮结束后再跑一轮（最后一次变更一定生效）", async () => {
    vi.useFakeTimers();
    const resolvers: Array<() => void> = [];
    const run = vi.fn(() => new Promise<void>((resolve) => resolvers.push(resolve)));
    const debounce = createCoalescingDebounce(run, 1000);

    debounce.schedule();
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(1);

    // 首轮 run 还在 pending 时又来了两次变更
    debounce.schedule();
    debounce.schedule();
    expect(run).toHaveBeenCalledTimes(1);

    resolvers[0]!(); // 首轮结束 → finally 里发现 pending，重新安排
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(2);

    resolvers[1]!();
    await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();
  });

  it("run 抛错时走 onError，且不丢后续变更", async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const run = vi.fn(() => Promise.reject(new Error("rebuild failed")));
    const debounce = createCoalescingDebounce(run, 1000, onError);

    debounce.schedule();
    await vi.advanceTimersByTimeAsync(1000);
    expect(onError).toHaveBeenCalledTimes(1);

    debounce.schedule();
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });
});
