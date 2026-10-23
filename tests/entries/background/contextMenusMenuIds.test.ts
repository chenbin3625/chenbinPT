/**
 * 右键菜单 A3 / N3 / N5 回归测试（2026-10-23 审查修复）。
 *
 * - A3：父菜单下的「在默认方案中搜索」必须有**确定性 id**。旧实现不传 id，每次重建用 nanoid，
 *   SW 回收后浏览器保留旧菜单、事件表按新 id 重建 → 第一次点击被静默丢弃。
 * - N3：suggestFolders 变量替换后可能收敛成同一目录，菜单 id 由最终目录派生 → 重复 id 让
 *   `chrome.contextMenus.create` 失败（只写 lastError）。现在先按最终目录去重，并检查 lastError。
 * - N5：`chrome.notifications.create` 的 Promise 失败必须有日志（不再 unhandled rejection）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  onMessage: vi.fn(),
  getExtStorageCached: vi.fn(),
  getExtStoragePathCached: vi.fn(),
  logBackgroundError: vi.fn(),
  openOptionsPage: vi.fn(),
  createdMenus: [] as Array<Record<string, any>>,
  removeAllCount: 0,
  onActivatedListeners: [] as Array<() => void>,
  onUpdatedListeners: [] as Array<(tabId: number, changeInfo: any, tab: any) => void>,
  onClickedListeners: [] as Array<(info: any, tab: any) => void>,
  onErrorIds: new Set<string>(),
  /** 可选：自定义某 id 的 create 失败文案（默认 duplicate id） */
  errorMessages: new Map<string, string>(),
  /** G2：removeAll 挂起（未调用 callback），用于断言 create 必须等 removeAll 完成 */
  removeAllGate: null as null | { callback?: () => void },
  notificationsCreate: vi.fn(),
  currentTabUrl: "https://mteam.example/browse",
  suggestFolders: ["/downloads/$torrent.site$"] as string[],
}));

vi.mock("@/messages.ts", () => ({ sendMessage: mocks.sendMessage, onMessage: mocks.onMessage }));

vi.mock("@/background/utils/base.ts", () => ({
  getExtStorageCached: mocks.getExtStorageCached,
  getExtStoragePathCached: mocks.getExtStoragePathCached,
  logBackgroundError: mocks.logBackgroundError,
  openOptionsPage: mocks.openOptionsPage,
}));

const chromeMock: any = {
  contextMenus: {
    onClicked: { addListener: vi.fn((fn: any) => mocks.onClickedListeners.push(fn)) },
    create: vi.fn((data: Record<string, any>, callback?: () => void) => {
      mocks.createdMenus.push(data);
      if (callback) {
        if (mocks.onErrorIds.has(String(data.id))) {
          chromeMock.runtime.lastError = {
            message: mocks.errorMessages.get(String(data.id)) ?? "Cannot create item with duplicate id",
          };
        }
        callback();
        chromeMock.runtime.lastError = undefined;
      }
    }),
    remove: vi.fn(() => Promise.resolve()),
    removeAll: vi.fn((callback?: () => void) => {
      mocks.removeAllCount += 1;
      if (mocks.removeAllGate) {
        mocks.removeAllGate.callback = callback;
        return Promise.resolve();
      }
      callback?.();
      return Promise.resolve();
    }),
  },
  tabs: {
    onActivated: {
      addListener: vi.fn((fn: () => void) => mocks.onActivatedListeners.push(fn)),
    },
    onUpdated: {
      addListener: vi.fn((fn: (tabId: number, changeInfo: any, tab: any) => void) => mocks.onUpdatedListeners.push(fn)),
    },
    query: vi.fn(() => Promise.resolve([{ url: mocks.currentTabUrl }])),
  },
  windows: {
    WINDOW_ID_NONE: -1,
    onFocusChanged: { addListener: vi.fn() },
  },
  storage: { onChanged: { addListener: vi.fn() } },
  i18n: { getMessage: vi.fn((key: string) => key) },
  notifications: { create: mocks.notificationsCreate },
  runtime: {
    lastError: undefined as { message: string } | undefined,
    getURL: (path: string) => `chrome-extension://test/${path}`,
  },
};

vi.stubGlobal("chrome", chromeMock);

const siteHostMap = { "mteam.example": "mteam" };
mocks.getExtStoragePathCached.mockImplementation(async (key: string, path: string) => {
  if (key === "siteIndex" && path === "siteHostMap") return siteHostMap;
  if (key === "siteIndex" && path === "siteNameMap") return { mteam: "M-Team" };
  return undefined;
});

mocks.getExtStorageCached.mockImplementation(async (key: string) => {
  if (key === "config") {
    return {
      contextMenus: {
        enabled: true,
        allowSelectionTextSearch: true,
        allowSocialLinkSearch: false,
        allowLinkDownloadPush: true,
      },
      download: { allowDownloaderFilterForSite: false },
    };
  }
  return {
    solutions: { default: { id: "default", name: "默认方案", enabled: true, sort: 1 } },
    sites: { mteam: { isOffline: false, allowSearch: true, sortIndex: 10 } },
    downloaders: {
      qb: {
        id: "qb",
        name: "qBittorrent",
        address: "http://127.0.0.1:8080",
        enabled: true,
        sortIndex: 100,
        suggestFolders: mocks.suggestFolders,
      },
    },
  };
});

async function flushBuild() {
  for (let i = 0; i < 8; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** 只推进微任务（不触发 clearContextMenus 的 setTimeout 兜底），用于断言「removeAll 未完成不得 create」 */
async function flushMicrotasks(count = 30) {
  for (let i = 0; i < count; i++) {
    await Promise.resolve();
  }
}

const DEFAULT_SEARCH_MENU_ID = "chenbinPT-Context-Menus**Search**Search-In-Default";

async function loadFreshModule() {
  mocks.createdMenus.length = 0;
  mocks.removeAllCount = 0;
  mocks.logBackgroundError.mockReset();
  mocks.onActivatedListeners.length = 0;
  mocks.onUpdatedListeners.length = 0;
  mocks.onClickedListeners.length = 0;
  mocks.removeAllGate = null;
  mocks.errorMessages.clear();
  vi.resetModules();
  const module = await import("@/background/utils/contextMenus.ts");
  await flushBuild();
  return module;
}

describe("右键菜单：搜索项 id 确定性（A3）", () => {
  beforeEach(() => {
    mocks.currentTabUrl = "https://mteam.example/browse";
    mocks.suggestFolders = ["/downloads/$torrent.site$"];
    mocks.onErrorIds.clear();
  });

  it("「在默认方案中搜索」使用确定性 id，SW 回收前后重建得到相同 id", async () => {
    await loadFreshModule();
    const idsFirstBuild = mocks.createdMenus.map((menu) => String(menu.id));
    expect(idsFirstBuild).toContain(DEFAULT_SEARCH_MENU_ID);

    // 模拟 SW 被回收后重新求值（模块内存清空，浏览器侧菜单仍在）→ 再次构建
    await loadFreshModule();
    const idsSecondBuild = mocks.createdMenus.map((menu) => String(menu.id));

    expect(idsSecondBuild).toContain(DEFAULT_SEARCH_MENU_ID);
    // 关键：同一菜单在所有构建里 id 一致（旧实现这里是 nanoid，第二次构建就变了）
    const first = idsFirstBuild.filter((id) => id.includes("Search-In-Default"));
    const second = idsSecondBuild.filter((id) => id.includes("Search-In-Default"));
    expect(first).toEqual([DEFAULT_SEARCH_MENU_ID]);
    expect(second).toEqual([DEFAULT_SEARCH_MENU_ID]);
  });
});

describe("右键菜单：建议目录去重与创建失败可见（N3）", () => {
  beforeEach(() => {
    mocks.currentTabUrl = "https://mteam.example/browse";
    mocks.suggestFolders = ["/downloads/$torrent.site$"];
    mocks.onErrorIds.clear();
  });

  it("变量替换后相同的目录只创建一个菜单项（避免重复 id 静默丢项）", async () => {
    // 两个模板最终都变成 /downloads/mteam；另外用户配置里还包含空串（等价默认目录）
    mocks.suggestFolders = ["/downloads/$torrent.site$", "/downloads/mteam", "/downloads/mteam", ""];

    await loadFreshModule();

    const downloaderSubMenuPrefix = "chenbinPT-Context-Menus**Link-Download-Push**qb";
    const folderMenus = mocks.createdMenus.filter((menu) => menu.parentId === downloaderSubMenuPrefix);
    const folderIds = folderMenus.map((menu) => String(menu.id));

    expect(new Set(folderIds).size).toBe(folderIds.length);
    // 默认目录 + 一个 /downloads/mteam
    expect(folderIds).toEqual([`${downloaderSubMenuPrefix}**`, `${downloaderSubMenuPrefix}**/downloads/mteam`]);
  });

  it("contextMenus.create 失败（lastError）必须上报，而不是静默丢项", async () => {
    mocks.suggestFolders = ["/bad"];
    mocks.onErrorIds.add("chenbinPT-Context-Menus**Link-Download-Push**qb**/bad");

    await loadFreshModule();

    expect(mocks.logBackgroundError).toHaveBeenCalledWith(
      expect.stringContaining("Failed to create context menu"),
      expect.stringContaining("duplicate id"),
    );
  });

  it("create 失败不删除已注册 handler：失败后点击该菜单项仍然生效（真正走生产 addContextMenu）", async () => {
    mocks.onErrorIds.add(DEFAULT_SEARCH_MENU_ID);

    await loadFreshModule();
    expect(mocks.logBackgroundError).toHaveBeenCalledWith(
      expect.stringContaining("Failed to create context menu"),
      expect.stringContaining("duplicate id"),
    );

    // 用户点击浏览器侧仍在的旧菜单项（确定性 id）：
    // - 新实现：handler 保留 → 直接触发 openOptionsPage；
    // - 旧实现（失败即 delete handler）：dispatcher 找不到 handler → rebuild → create 再次失败并再删 → 点击静默丢弃。
    expect(mocks.onClickedListeners.length).toBeGreaterThan(0);
    mocks.onClickedListeners[0]!(
      { menuItemId: DEFAULT_SEARCH_MENU_ID, selectionText: "ubuntu" },
      { id: 1, url: "https://mteam.example/browse" },
    );
    await flushBuild();

    expect(mocks.openOptionsPage, "create 失败不得删除 handler（否则点击被静默丢弃）").toHaveBeenCalledWith(
      expect.objectContaining({ path: "/search-entity" }),
    );
  });

  it("非 duplicate 的 create 失败同样保留 handler", async () => {
    mocks.onErrorIds.add(DEFAULT_SEARCH_MENU_ID);
    mocks.errorMessages.set(DEFAULT_SEARCH_MENU_ID, "Some other create failure");

    await loadFreshModule();
    mocks.onClickedListeners[0]!(
      { menuItemId: DEFAULT_SEARCH_MENU_ID, selectionText: "ubuntu" },
      { id: 1, url: "https://mteam.example/browse" },
    );
    await flushBuild();

    expect(mocks.openOptionsPage).toHaveBeenCalledWith(expect.objectContaining({ path: "/search-entity" }));
  });

  it("G2：必须等 removeAll 完成后再 create（消除 create/removeAll 的 duplicate-id 竞态）", async () => {
    mocks.currentTabUrl = "https://mteam.example/browse";
    await loadFreshModule();
    const menusBeforeRebuild = mocks.createdMenus.length;

    // 下一次重建的 removeAll 挂起（callback 不调用）
    mocks.removeAllGate = {};
    mocks.currentTabUrl = "https://btsite.example/browse";
    mocks.onUpdatedListeners[0]!(-1, { url: mocks.currentTabUrl }, { url: mocks.currentTabUrl });
    await flushMicrotasks();

    expect(mocks.removeAllCount, "应已发起 removeAll").toBeGreaterThan(1);
    expect(mocks.createdMenus.length, "removeAll 未完成前不得 create").toBe(menusBeforeRebuild);

    // 释放 removeAll 后才允许创建
    mocks.removeAllGate!.callback?.();
    mocks.removeAllGate = null;
    await flushBuild();
    expect(mocks.createdMenus.length).toBeGreaterThan(menusBeforeRebuild);
  });

  it("G2：create 失败不提交上下文摘要，同一上下文再次触发会重建（重试）", async () => {
    mocks.suggestFolders = ["/bad"];
    mocks.onErrorIds.add(DEFAULT_SEARCH_MENU_ID);
    mocks.onErrorIds.add("chenbinPT-Context-Menus**Link-Download-Push**qb**/bad");

    await loadFreshModule(); // 初始构建失败（key 不提交）
    const removeAllAfterFailure = mocks.removeAllCount;
    expect(
      mocks.logBackgroundError.mock.calls.some(([message]) => String(message).includes("create failure")),
      "构建失败必须留下可诊断日志",
    ).toBe(true);

    // 同一上下文再次触发（模拟 tabs.onActivated）：key 未提交 → 必须重建
    mocks.onActivatedListeners[0]!();
    await flushBuild();
    expect(mocks.removeAllCount, "失败后不得把该上下文标记为构建成功").toBeGreaterThan(removeAllAfterFailure);
  });
});

describe("通知发送失败必须可见（N5）", () => {
  beforeEach(() => {
    mocks.currentTabUrl = "https://mteam.example/browse";
    mocks.suggestFolders = ["/downloads/$torrent.site$"];
    mocks.onErrorIds.clear();
    mocks.notificationsCreate.mockReset();
  });

  it("chrome.notifications.create reject 时转进 logBackgroundError，不产生 unhandled rejection", async () => {
    const { showNotificationSafely } = await loadFreshModule();
    mocks.notificationsCreate.mockRejectedValueOnce(new Error("notifications disabled"));

    showNotificationSafely({ type: "basic", iconUrl: "x", title: "t", message: "m" } as any);
    await flushBuild();

    expect(mocks.logBackgroundError).toHaveBeenCalledWith(
      "Failed to show notification",
      expect.objectContaining({ message: "notifications disabled" }),
    );
  });
});
