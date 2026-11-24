import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildSuggestedDownloadFilename,
  compareVersion,
  extractVersion,
  getBrowserExtensionsPageUrl,
  hasUnignoredUpdate,
  isTrustedUpdateUrl,
  parseGitHubReleaseApi,
  parseReleaseManifest,
  reconcileUpdateCheckState,
  sanitizeUpdateFilename,
  selectAssetForBrowser,
  UPDATE_CHECK_STATE_STORAGE_KEY,
  UPDATE_RELEASE_API_URL,
  UPDATE_RELEASE_MANIFEST_URL,
  type IUpdateCheckState,
} from "@/shared/updateCheck.ts";

const mocks = vi.hoisted(() => ({
  onMessageHandlers: new Map<string, (msg: { data: any }) => any>(),
  sendMessage: vi.fn(async () => undefined),
  getExtStoragePathCached: vi.fn(),
  logBackgroundError: vi.fn(),
  openOptionsPage: vi.fn(),
  showNotificationSafely: vi.fn(),
}));

vi.mock("@/messages.ts", () => ({
  onMessage: (type: string, handler: (msg: { data: any }) => any) => {
    mocks.onMessageHandlers.set(type, handler);
  },
  sendMessage: mocks.sendMessage,
}));

vi.mock("@/background/utils/base.ts", () => ({
  getExtStoragePathCached: mocks.getExtStoragePathCached,
  logBackgroundError: mocks.logBackgroundError,
  openOptionsPage: mocks.openOptionsPage,
}));

vi.mock("@/background/utils/contextMenus.ts", () => ({
  showNotificationSafely: mocks.showNotificationSafely,
}));

function makeChromeEnv(options?: { version?: string; initialState?: IUpdateCheckState; tabsCreateFail?: boolean }) {
  const localStore: Record<string, unknown> = {};
  if (options?.initialState) {
    localStore[UPDATE_CHECK_STATE_STORAGE_KEY] = options.initialState;
  }

  const notificationClickListeners: Array<(id: string) => void> = [];
  const storageChangeListeners: Array<(changes: Record<string, any>, area: string) => void> = [];

  const setBadgeText = vi.fn(async (_details: unknown) => undefined);
  const setBadgeBackgroundColor = vi.fn(async (_details: unknown) => undefined);
  const setBadgeTextColor = vi.fn(async (_details: unknown) => undefined);
  const notificationsCreate = vi.fn(async (_id: string, _opts?: unknown) => "notif-id");
  const notificationsClear = vi.fn(async (_id: string) => true);
  const downloadsDownload = vi.fn(async (_opts: unknown) => 42);
  const tabsCreate = options?.tabsCreateFail
    ? vi.fn(async (_opts: unknown) => {
        throw new Error("Illegal URL");
      })
    : vi.fn(async (_opts: unknown) => ({ id: 1 }));

  const chromeMock = {
    runtime: {
      getManifest: () => ({ version: options?.version ?? "0.0.27" }),
      getURL: (p: string) => `chrome-extension://test-id/${p}`,
    },
    i18n: {
      getMessage: vi.fn((key: string, subs?: string[]) => `${key}:${(subs ?? []).join(",")}`),
    },
    action: {
      setBadgeText,
      setBadgeBackgroundColor,
      setBadgeTextColor,
    },
    notifications: {
      create: notificationsCreate,
      clear: notificationsClear,
      onClicked: {
        addListener: (fn: (id: string) => void) => notificationClickListeners.push(fn),
      },
    },
    downloads: {
      download: downloadsDownload,
    },
    tabs: {
      create: tabsCreate,
    },
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: localStore[key] })),
        set: vi.fn(async (patch: Record<string, unknown>) => {
          Object.assign(localStore, patch);
        }),
      },
      onChanged: {
        addListener: (fn: (changes: Record<string, any>, area: string) => void) => storageChangeListeners.push(fn),
      },
    },
  };

  vi.stubGlobal("chrome", chromeMock);
  vi.stubGlobal("__BROWSER__", "chrome");
  vi.stubGlobal("__EXT_VERSION__", `v${options?.version ?? "0.0.27"}+abc1234`);

  return {
    localStore,
    setBadgeText,
    setBadgeBackgroundColor,
    notificationsCreate,
    notificationsClear,
    downloadsDownload,
    tabsCreate,
    notificationClickListeners,
    storageChangeListeners,
  };
}

describe("版本更新纯逻辑（shared/updateCheck）", () => {
  it("版本号提取与比较兼容三段与四段版本", () => {
    expect(extractVersion("v0.0.27+0b798c3")).toBe("0.0.27");
    expect(extractVersion("v0.0.7.1962")).toBe("0.0.7.1962");
    expect(compareVersion("0.0.28", "0.0.27")).toBe(1);
    expect(compareVersion("0.0.27", "0.0.27")).toBe(0);
    expect(compareVersion("0.0.26", "0.0.27")).toBe(-1);
    expect(compareVersion("0.0.8", "0.0.7.1962")).toBe(1);
    expect(compareVersion("invalid", "0.0.27")).toBeNull();
  });

  it("仅放行官方仓库及其 GitHub Release CDN 的 HTTPS 链接", () => {
    expect(isTrustedUpdateUrl("https://github.com/chenbin3625/chenbinPT/releases/tag/v0.0.28")).toBe(true);
    expect(
      isTrustedUpdateUrl("https://github.com/chenbin3625/chenbinPT/releases/download/v0.0.28/extension-chrome.zip"),
    ).toBe(true);
    expect(isTrustedUpdateUrl("https://objects.githubusercontent.com/github-production-release-asset-1/foo.zip")).toBe(
      true,
    );
    expect(isTrustedUpdateUrl("https://release-assets.githubusercontent.com/some/path.zip")).toBe(true);

    // 非 HTTPS、其他仓库、任意外链、javascript 协议一律拒绝
    expect(isTrustedUpdateUrl("http://github.com/chenbin3625/chenbinPT/releases/latest")).toBe(false);
    expect(isTrustedUpdateUrl("https://github.com/evil/repo/releases/download/v1.0.0/evil.zip")).toBe(false);
    expect(isTrustedUpdateUrl("https://evil.example.com/extension-chrome.zip")).toBe(false);
    expect(isTrustedUpdateUrl("javascript:alert(1)")).toBe(false);
  });

  it("下载文件名会阻断路径穿越并自动带上版本号", () => {
    expect(sanitizeUpdateFilename("../../evil.zip", "0.0.28")).toBe("evil.zip");
    expect(sanitizeUpdateFilename("bad.exe", "0.0.28")).toBe("chenbinPT-v0.0.28.zip");
    expect(buildSuggestedDownloadFilename("extension-chrome.zip", "0.0.28")).toBe(
      "chenbinPT-v0.0.28-extension-chrome.zip",
    );
    expect(buildSuggestedDownloadFilename("chenbinPT-0.0.28-chrome.zip", "0.0.28")).toBe("chenbinPT-0.0.28-chrome.zip");
  });

  it("按目标浏览器准确挑选首选安装包", () => {
    const assets = [
      {
        name: "extension.crx",
        url: "https://github.com/chenbin3625/chenbinPT/releases/download/v0.0.28/extension.crx",
      },
      {
        name: "extension-firefox.zip",
        url: "https://github.com/chenbin3625/chenbinPT/releases/download/v0.0.28/extension-firefox.zip",
      },
      {
        name: "extension-chrome.zip",
        url: "https://github.com/chenbin3625/chenbinPT/releases/download/v0.0.28/extension-chrome.zip",
      },
    ];
    expect(selectAssetForBrowser(assets, "chrome")?.name).toBe("extension-chrome.zip");
    expect(selectAssetForBrowser(assets, "firefox")?.name).toBe("extension-firefox.zip");
  });

  it("解析静态清单 latest.json 并剥离非可信资产链接", () => {
    const parsed = parseReleaseManifest(
      {
        version: "0.0.28",
        tagName: "v0.0.28",
        publishedAt: "2026-11-24T08:00:00Z",
        releaseUrl: "https://github.com/chenbin3625/chenbinPT/releases/tag/v0.0.28",
        notes: "- 修复站点解析",
        assets: {
          chrome: {
            name: "extension-chrome.zip",
            url: "https://github.com/chenbin3625/chenbinPT/releases/download/v0.0.28/extension-chrome.zip",
            size: 4_500_000,
            sha256: "a".repeat(64),
          },
          evil: {
            name: "evil.zip",
            url: "https://attacker.example/evil.zip",
          },
        },
      },
      "chrome",
    );

    expect(parsed).not.toBeNull();
    expect(parsed?.source).toBe("manifest");
    expect(parsed?.version).toBe("0.0.28");
    expect(parsed?.asset?.name).toBe("extension-chrome.zip");
    expect(parsed?.asset?.sha256).toBe("a".repeat(64));
    expect(parsed?.allAssets).toHaveLength(1);
  });

  it("解析 GitHub Releases API 响应并忽略 draft 与非压缩包资产", () => {
    expect(parseGitHubReleaseApi({ draft: true, tag_name: "v0.0.29" }, "chrome")).toBeNull();

    const parsed = parseGitHubReleaseApi(
      {
        tag_name: "v0.0.28",
        name: "Release v0.0.28",
        html_url: "https://github.com/chenbin3625/chenbinPT/releases/tag/v0.0.28",
        published_at: "2026-11-24T08:00:00Z",
        body: "新增更新检测功能",
        assets: [
          {
            name: "latest.json",
            browser_download_url: "https://github.com/chenbin3625/chenbinPT/releases/download/v0.0.28/latest.json",
            size: 512,
          },
          {
            name: "extension-chrome.zip",
            browser_download_url:
              "https://github.com/chenbin3625/chenbinPT/releases/download/v0.0.28/extension-chrome.zip",
            size: 4_600_000,
          },
          {
            name: "extension-firefox.zip",
            browser_download_url:
              "https://github.com/chenbin3625/chenbinPT/releases/download/v0.0.28/extension-firefox.zip",
            size: 4_550_000,
          },
        ],
      },
      "firefox",
    );

    expect(parsed?.source).toBe("github-api");
    expect(parsed?.asset?.name).toBe("extension-firefox.zip");
    expect(parsed?.allAssets.map((a) => a.name)).toEqual(["extension-chrome.zip", "extension-firefox.zip"]);
  });

  it("本地已升级后重算缓存状态会自动从 update-available 转为 up-to-date，且支持忽略版本判定", () => {
    const staleState: IUpdateCheckState = {
      currentVersion: "0.0.27",
      checkedAt: Date.now(),
      status: "update-available",
      latest: {
        version: "0.0.28",
        tagName: "v0.0.28",
        name: "v0.0.28",
        releaseUrl: "https://github.com/chenbin3625/chenbinPT/releases/tag/v0.0.28",
        notes: "",
        source: "github-api",
        allAssets: [],
      },
    };

    expect(hasUnignoredUpdate(staleState, "")).toBe(true);
    expect(hasUnignoredUpdate(staleState, "0.0.28")).toBe(false);
    expect(hasUnignoredUpdate(staleState, "0.0.27")).toBe(true);

    const afterUpgrade = reconcileUpdateCheckState(staleState, "0.0.28");
    expect(afterUpgrade.status).toBe("up-to-date");
    expect(hasUnignoredUpdate(afterUpgrade, "")).toBe(false);
  });

  it("按浏览器与 UA 返回对应的扩展管理页 URL", () => {
    expect(getBrowserExtensionsPageUrl("chrome", "Mozilla/5.0 Chrome/140.0")).toBe("chrome://extensions");
    expect(getBrowserExtensionsPageUrl("chrome", "Mozilla/5.0 Chrome/140.0 Edg/140.0")).toBe("edge://extensions");
    expect(getBrowserExtensionsPageUrl("firefox", "Mozilla/5.0 Firefox/133.0")).toBe(
      "about:debugging#/runtime/this-firefox",
    );
  });
});

describe("后台更新检测服务（background/utils/updateCheck）", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.onMessageHandlers.clear();
    mocks.sendMessage.mockClear();
    mocks.getExtStoragePathCached.mockReset();
    mocks.logBackgroundError.mockClear();
    mocks.openOptionsPage.mockClear();
    mocks.showNotificationSafely.mockClear();
    mocks.getExtStoragePathCached.mockResolvedValue({
      enabled: true,
      intervalHours: 24,
      notifyBrowser: true,
      ignoredVersion: "",
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("优先使用 latest.json；若 404 则无缝回退 GitHub Releases API，并设置角标与去重通知", async () => {
    const env = makeChromeEnv({ version: "0.0.27" });
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (String(url) === UPDATE_RELEASE_MANIFEST_URL) {
        return new Response("Not Found", { status: 404, statusText: "Not Found" });
      }
      if (String(url) === UPDATE_RELEASE_API_URL) {
        return new Response(
          JSON.stringify({
            tag_name: "v0.0.28",
            name: "v0.0.28",
            html_url: "https://github.com/chenbin3625/chenbinPT/releases/tag/v0.0.28",
            body: "修复若干问题",
            assets: [
              {
                name: "extension-chrome.zip",
                browser_download_url:
                  "https://github.com/chenbin3625/chenbinPT/releases/download/v0.0.28/extension-chrome.zip",
                size: 4_100_000,
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`unexpected url ${String(url)}`);
    });

    const mod = await import("@/background/utils/updateCheck.ts");
    const result = await mod.performExtensionUpdateCheck({
      force: true,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(result.status).toBe("update-available");
    expect(result.latest?.source).toBe("github-api");
    expect(result.latest?.version).toBe("0.0.28");
    expect(result.latest?.asset?.name).toBe("extension-chrome.zip");
    expect(env.setBadgeText).toHaveBeenCalledWith({ text: "NEW" });
    expect(env.notificationsCreate).toHaveBeenCalledTimes(1);
    expect(env.notificationsCreate.mock.calls[0]?.[0]).toBe("ptd-ext-update:0.0.28");

    // 同版本再次强制检测不重复发桌面通知
    const second = await mod.performExtensionUpdateCheck({
      force: true,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(second.status).toBe("update-available");
    expect(env.notificationsCreate).toHaveBeenCalledTimes(1);

    // 点击更新通知应打开版本更新设置页并清除通知
    env.notificationClickListeners[0]?.("ptd-ext-update:0.0.28");
    expect(mocks.openOptionsPage).toHaveBeenCalledWith("/set-base/update");
    expect(env.notificationsClear).toHaveBeenCalledWith("ptd-ext-update:0.0.28");
  });

  it("静态清单 latest.json 可用时直接采用且不再请求 GitHub API", async () => {
    makeChromeEnv({ version: "0.0.27" });
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (String(url) === UPDATE_RELEASE_MANIFEST_URL) {
        return new Response(
          JSON.stringify({
            version: "0.0.29",
            tagName: "v0.0.29",
            notes: "新特性",
            assets: {
              chrome: {
                name: "extension-chrome.zip",
                url: "https://github.com/chenbin3625/chenbinPT/releases/download/v0.0.29/extension-chrome.zip",
                size: 4_200_000,
                sha256: "b".repeat(64),
              },
            },
          }),
          { status: 200 },
        );
      }
      throw new Error("should not fall back to GitHub API");
    });

    const mod = await import("@/background/utils/updateCheck.ts");
    const result = await mod.performExtensionUpdateCheck({
      force: true,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("update-available");
    expect(result.latest?.source).toBe("manifest");
    expect(result.latest?.asset?.sha256).toBe("b".repeat(64));
  });

  it("定时任务关闭或未达到检查间隔时跳过网络请求", async () => {
    const now = Date.now();
    makeChromeEnv({
      version: "0.0.27",
      initialState: {
        currentVersion: "0.0.27",
        checkedAt: now - 10 * 60 * 1000, // 10 分钟前已查过
        status: "up-to-date",
      },
    });
    const fetchMock = vi.fn();

    const mod = await import("@/background/utils/updateCheck.ts");

    // 未超过 24h，非强制调用应命中缓存
    const cached = await mod.performExtensionUpdateCheck({
      force: false,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(cached.status).toBe("up-to-date");
    expect(fetchMock).not.toHaveBeenCalled();

    // 关闭自动检测时，定时任务不发请求
    mocks.getExtStoragePathCached.mockResolvedValue({
      enabled: false,
      intervalHours: 24,
      notifyBrowser: true,
      ignoredVersion: "",
    });
    await mod.performExtensionUpdateCheck({
      force: true,
      isScheduled: true,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("一键下载仅允许可信 GitHub 链接，并生成带版本号的文件名", async () => {
    const env = makeChromeEnv({
      version: "0.0.27",
      initialState: {
        currentVersion: "0.0.27",
        checkedAt: Date.now(),
        status: "update-available",
        latest: {
          version: "0.0.28",
          tagName: "v0.0.28",
          name: "v0.0.28",
          releaseUrl: "https://github.com/chenbin3625/chenbinPT/releases/tag/v0.0.28",
          notes: "",
          source: "github-api",
          asset: {
            name: "extension-chrome.zip",
            url: "https://github.com/chenbin3625/chenbinPT/releases/download/v0.0.28/extension-chrome.zip",
          },
          allAssets: [],
        },
      },
    });

    const mod = await import("@/background/utils/updateCheck.ts");
    const res = await mod.downloadExtensionUpdate();
    expect(res).toEqual({
      downloadId: 42,
      filename: "chenbinPT-v0.0.28-extension-chrome.zip",
    });
    expect(env.downloadsDownload).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://github.com/chenbin3625/chenbinPT/releases/download/v0.0.28/extension-chrome.zip",
        filename: "chenbinPT-v0.0.28-extension-chrome.zip",
      }),
    );

    await expect(mod.downloadExtensionUpdate({ url: "https://evil.example/malware.zip" })).rejects.toThrow(
      /Untrusted update download URL/,
    );
  });

  it("打开扩展管理页受浏览器限制时优雅降级返回 opened=false 与目标地址", async () => {
    makeChromeEnv({ version: "0.0.27", tabsCreateFail: true });
    const mod = await import("@/background/utils/updateCheck.ts");

    const res = await mod.openBrowserExtensionsPage();
    expect(res.opened).toBe(false);
    expect(res.url).toMatch(/^(chrome|edge):\/\/extensions$/);
  });
});
