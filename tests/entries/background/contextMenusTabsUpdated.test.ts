/**
 * 右键菜单在同标签页导航后重建的回归测试（见 L-2）。
 *
 * 缺陷：只在 `tabs.onActivated` 时重建菜单。同一标签页从站点 A 跳到站点 B（含 SPA 的 pushState 导航）
 * 不会触发 onActivated，而 `lastBuiltContextKey` 命中即 return —— 菜单的点击回调继续持有 A 的
 * `thisTabSiteId`，`$torrent.site$` 被替换成 A，文件会落到错误目录。
 *
 * 修复：新增 `chrome.tabs.onUpdated` 监听，且只在 `changeInfo.url` 存在时重建
 * （onUpdated 在标题/图标/加载状态变化时都会触发，不加判断会让每次页面加载都全量重建菜单）。
 */
import { describe, expect, it, vi } from "vitest";

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
  onFocusChangedListeners: [] as Array<(windowId: number) => void>,
  storageChangedListeners: [] as Array<(changes: Record<string, unknown>, areaName: string) => void>,
  currentTab: { url: "https://mteam.example/browse" } as { url: string },
  /** BACKGROUNDSHARED-4：站点过滤开关与排除列表（用例里可改，模拟设置页写入后的 storage 变化） */
  allowDownloaderFilterForSite: true,
  excludedSites: [] as string[],
}));

vi.mock("@/messages.ts", () => ({ sendMessage: mocks.sendMessage, onMessage: mocks.onMessage }));

vi.mock("@/background/utils/base.ts", () => ({
  getExtStorageCached: mocks.getExtStorageCached,
  getExtStoragePathCached: mocks.getExtStoragePathCached,
  logBackgroundError: mocks.logBackgroundError,
  openOptionsPage: mocks.openOptionsPage,
}));

vi.stubGlobal("chrome", {
  contextMenus: {
    onClicked: { addListener: vi.fn() },
    create: vi.fn((data: Record<string, any>) => mocks.createdMenus.push(data)),
    remove: vi.fn(() => Promise.resolve()),
    removeAll: vi.fn(() => {
      mocks.removeAllCount += 1;
      return Promise.resolve();
    }),
  },
  tabs: {
    onActivated: { addListener: vi.fn((fn: () => void) => mocks.onActivatedListeners.push(fn)) },
    onUpdated: {
      addListener: vi.fn((fn: (tabId: number, changeInfo: any, tab: any) => void) => mocks.onUpdatedListeners.push(fn)),
    },
    query: vi.fn(() => Promise.resolve([{ ...mocks.currentTab }])),
  },
  windows: {
    WINDOW_ID_NONE: -1,
    onFocusChanged: {
      addListener: vi.fn((fn: (windowId: number) => void) => mocks.onFocusChangedListeners.push(fn)),
    },
  },
  storage: {
    onChanged: {
      addListener: vi.fn((fn: (changes: Record<string, unknown>, areaName: string) => void) =>
        mocks.storageChangedListeners.push(fn),
      ),
    },
  },
  i18n: { getMessage: vi.fn((key: string) => key) },
});

const siteHostMap = { "mteam.example": "mteam", "btsite.example": "btsite" };
const siteNameMap = { mteam: "M-Team", btsite: "B-Site" };

mocks.getExtStoragePathCached.mockImplementation(async (key: string, path: string) => {
  if (key === "siteIndex" && path === "siteHostMap") return siteHostMap;
  if (key === "siteIndex" && path === "siteNameMap") return siteNameMap;
  return undefined;
});

mocks.getExtStorageCached.mockImplementation(async (key: string) => {
  if (key === "config") {
    return {
      contextMenus: {
        enabled: true,
        allowSelectionTextSearch: false,
        allowSocialLinkSearch: false,
        allowLinkDownloadPush: true,
      },
      download: { allowDownloaderFilterForSite: mocks.allowDownloaderFilterForSite },
    };
  }
  return {
    solutions: {},
    sites: {},
    downloaders: {
      qb: {
        id: "qb",
        name: "qBittorrent",
        address: "http://127.0.0.1:8080",
        enabled: true,
        sortIndex: 100,
        suggestFolders: ["/downloads/$torrent.site$"],
        excludedSites: mocks.excludedSites,
      },
    },
  };
});

await import("@/background/utils/contextMenus.ts");

/** 构建是异步链（多次 mock 的 storage 读取），这里把微任务/宏任务都排空 */
async function flushBuild() {
  for (let i = 0; i < 6; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** 只取「从 fromIndex 起新建」的菜单标题：重建是新增一批菜单，而不是复用旧对象 */
function menuTitles(fromIndex = 0): string[] {
  return mocks.createdMenus
    .slice(fromIndex)
    .map((menu) => menu.title)
    .filter((title) => typeof title === "string");
}

/** 只取「从 fromIndex 起新建」的菜单 id（用于断言某个下载器子菜单是否存在） */
function menuIds(fromIndex = 0): string[] {
  return mocks.createdMenus.slice(fromIndex).map((menu) => String(menu.id));
}

const QB_DOWNLOADER_MENU_ID = "chenbinPT-Context-Menus**Link-Download-Push**qb";

describe("右键菜单：同标签页导航后重建（L-2）", () => {
  it("changeInfo.url 触发重建；没有 url 的 onUpdated 不重建", async () => {
    await flushBuild();

    expect(mocks.onUpdatedListeners.length, "必须注册 tabs.onUpdated 监听").toBe(1);
    expect(mocks.onActivatedListeners.length, "原有的 onActivated 监听应保留").toBe(1);

    // 首次构建：按站点 A 解析 $torrent.site$
    expect(menuTitles()).toContain("-> /downloads/mteam");
    const buildsAfterInitial = mocks.removeAllCount;
    expect(buildsAfterInitial).toBeGreaterThan(0);

    // 同标签页 A → B：URL 变了，但先发一个「没有 url」的 onUpdated（标题/图标变化也会触发它）
    mocks.currentTab.url = "https://btsite.example/browse";
    mocks.onUpdatedListeners[0]!(-1, { status: "complete" }, { ...mocks.currentTab });
    await flushBuild();
    expect(mocks.removeAllCount, "没有 changeInfo.url 时不得重建（否则每次页面加载都全量重建）").toBe(
      buildsAfterInitial,
    );

    // 真正的 URL 变化：必须重建，且当前站点上下文换成 B
    const menusBeforeRebuild = mocks.createdMenus.length;
    mocks.onUpdatedListeners[0]!(-1, { url: "https://btsite.example/browse" }, { ...mocks.currentTab });
    await flushBuild();

    expect(mocks.removeAllCount, "changeInfo.url 必须触发重建").toBe(buildsAfterInitial + 1);
    const titles = menuTitles(menusBeforeRebuild);
    expect(titles).toContain("-> /downloads/btsite");
    expect(titles, "重建后的菜单不应再使用 A 的站点上下文").not.toContain("-> /downloads/mteam");
  });
});

describe("右键菜单：切换窗口后重建（M-16）", () => {
  it("windows.onFocusChanged 按新窗口的活动标签页重建；焦点移出浏览器（WINDOW_ID_NONE）不重建", async () => {
    await flushBuild();
    expect(mocks.onFocusChangedListeners.length, "必须注册 windows.onFocusChanged 监听").toBe(1);

    // 窗口 1 停在 B（上一个用例结束时的状态），切到停在 A 的窗口 2
    mocks.currentTab.url = "https://mteam.example/browse";
    const before = mocks.removeAllCount;
    const menusBefore = mocks.createdMenus.length;
    mocks.onFocusChangedListeners[0]!(2);
    await flushBuild();

    expect(mocks.removeAllCount).toBe(before + 1);
    expect(menuTitles(menusBefore)).toContain("-> /downloads/mteam");

    mocks.onFocusChangedListeners[0]!(-1);
    await flushBuild();
    expect(mocks.removeAllCount).toBe(before + 1);
  });
});

describe("右键菜单：与菜单无关的 metadata 写入不触发重建（L-6）", () => {
  it("只改了 lastUserInfo 时摘要不变，1s 防抖后也不 removeAll", async () => {
    await flushBuild();
    expect(mocks.storageChangedListeners.length).toBe(1);
    const before = mocks.removeAllCount;

    vi.useFakeTimers();
    try {
      // 自动刷新用户信息：每个站点各写一次 metadata（lastUserInfo 不在菜单摘要里）
      for (let i = 0; i < 3; i++) {
        mocks.storageChangedListeners[0]!({ metadata: { newValue: {} } }, "local");
      }
      await vi.advanceTimersByTimeAsync(1500);
    } finally {
      vi.useRealTimers();
    }
    await flushBuild();

    expect(mocks.removeAllCount, "菜单摘要未变化时不应 removeAll + 全量重建").toBe(before);
  });
});

describe("右键菜单：按站点排除下载器（BACKGROUNDSHARED-4）", () => {
  /** 按当前标签页触发一次重建（onUpdated 带 changeInfo.url） */
  async function rebuildAtCurrentTab() {
    mocks.onUpdatedListeners[0]!(-1, { url: mocks.currentTab.url }, { ...mocks.currentTab });
    await flushBuild();
  }

  it("开关打开且 excludedSites 命中当前站点 → 该下载器不再出现在菜单里", async () => {
    mocks.currentTab.url = "https://mteam.example/browse";
    mocks.allowDownloaderFilterForSite = true;
    mocks.excludedSites = [];
    await rebuildAtCurrentTab(); // 建立基线（不排除）
    const before = mocks.createdMenus.length;

    // 站点过滤里把 qb 排除出 mteam：与 options store 的 getEnabledDownloadersBySite 语义一致
    mocks.excludedSites = ["mteam"];
    await rebuildAtCurrentTab();

    expect(menuIds(before), "被排除的下载器不得出现在右键菜单里").not.toContain(QB_DOWNLOADER_MENU_ID);
    expect(menuTitles(before)).not.toContain("-> /downloads/mteam");
  });

  it("开关关闭时排除列表不生效（否则菜单会与设置页行为相反）", async () => {
    mocks.currentTab.url = "https://mteam.example/browse";
    mocks.excludedSites = ["mteam"];
    mocks.allowDownloaderFilterForSite = false; // 上一个用例是 true → 摘要变化必然重建
    const before = mocks.createdMenus.length;

    await rebuildAtCurrentTab();

    expect(menuIds(before), "开关关闭时排除列表本就不生效").toContain(QB_DOWNLOADER_MENU_ID);
  });
});
