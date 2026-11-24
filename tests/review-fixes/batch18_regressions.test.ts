/**
 * 批量回归测试：覆盖本次修复的站点、弹窗、辅种、内容脚本与智能路由问题。
 *
 * - Bug 2: NexusPHP 维护提示表不应将已知做种数 37 覆写成 0
 * - Bug 3: Unit3D 切换账号后始终解析当前登录用户名，不再沿用旧快照用户名
 * - Bug 6: 自定义站点通过 bootstrap 同步到内容脚本注册表，getSite / detectPageType 正常解析
 * - Bug 7: setSiteLastUserInfo 持久化失败状态，mini-popup 账号健康汇总准确计入异常站点并在恢复后归零
 * - Bug 8: getTorrentInfoForVerification 从 parsedTorrent.info.infoHash 读取真实 infoHash
 * - Bug 9: YemaPT getTorrentDownloadLink 使用 torrent.id（并兼容旧任务从 url 提取）
 * - Bug 10: bootstrap 下发智能路由规则与开关，内容脚本默认推送命中路由发往 B，offscreen 放行路由规则 savePath
 */
import axios from "axios";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineComponent } from "vue";

import { EResultParseStatus } from "@ptd/site/types.ts";

function makeDoc(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

function stubChromeBase() {
  vi.stubGlobal("__BROWSER__", "chrome");
  vi.stubGlobal("__EXT_VERSION__", "v0.0.0");
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => undefined),
        remove: vi.fn(async () => undefined),
        onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
      },
      session: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => undefined),
        remove: vi.fn(async () => undefined),
        onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
      },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    runtime: {
      id: "test-ext",
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
      sendMessage: vi.fn(async () => undefined),
      getURL: (path: string) => `chrome-extension://test-ext/${path}`,
    },
    cookies: {
      get: vi.fn(async () => null),
      set: vi.fn(async () => undefined),
      getAll: vi.fn(async () => []),
    },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Bug 2：NexusPHP 维护提示表不会将已有做种数清零", () => {
  it("资料页已读到做种数 37 且补充接口返回单行/双行维护提示表时，保留 seeding=37 且 seedingSize 不写 0", async () => {
    stubChromeBase();
    const { default: NexusPHP, SchemaMetadata: NexusPHPSchema } = await import("@ptd/site/schemas/NexusPHP.ts");

    class MaintenanceNexusSite extends NexusPHP {
      public seedingAjaxHtml = "<table><tr><td>系统维护中，请稍后再试</td></tr></table>";

      protected override async requestUserSeedingPage(): Promise<string | null> {
        return this.seedingAjaxHtml;
      }

      public override async request<T>(config: any): Promise<any> {
        const url = String(config?.url ?? "");
        if (url.includes("index.php")) {
          return {
            status: 200,
            headers: {},
            config,
            data: makeDoc(`<div id="info_block"><a href="userdetails.php?id=42">alice</a></div>`),
          };
        }
        if (url.includes("userdetails.php")) {
          return {
            status: 200,
            headers: {},
            config,
            data: makeDoc(`
              <table>
                <tr><td class="rowhead">传输</td><td class="rowfollow">上传量: 1.5 TB 下载量: 500 GB</td></tr>
                <tr><td class="rowhead">当前做种</td><td class="rowfollow"><img alt="Torrents seeding" src="u.gif">37</td></tr>
              </table>
            `),
          };
        }
        return { status: 200, headers: {}, config, data: makeDoc("") };
      }
    }

    const site = new MaintenanceNexusSite(
      {
        ...NexusPHPSchema,
        id: "nphp-maint",
        name: "NPHP Maint",
        type: "private",
        urls: ["https://nphp.example/"],
        userInfo: {
          ...NexusPHPSchema.userInfo,
          requestDelay: 0,
          selectors: {
            ...NexusPHPSchema.userInfo.selectors,
            seeding: {
              selector: "td.rowhead:contains('当前做种') + td",
              filters: [{ name: "parseNumber" }],
            },
          },
        },
      } as any,
      {},
    );

    // 1. 单行维护提示表
    site.seedingAjaxHtml = "<table><tr><td>站点维护中，做种列表暂时不可用</td></tr></table>";
    const res1 = await site.getUserInfoResult({});
    expect(res1.status).toBe(EResultParseStatus.success);
    expect(res1.seeding).toBe(37);
    expect(res1.seedingSize).toBeUndefined();

    // 2. 双行维护提示表（带表头与提示内容，但无体积列）
    site.seedingAjaxHtml = "<table><tr><th>公告</th></tr><tr><td>数据库维护中</td></tr></table>";
    const res2 = await site.getUserInfoResult({});
    expect(res2.status).toBe(EResultParseStatus.success);
    expect(res2.seeding).toBe(37);
    expect(res2.seedingSize).toBeUndefined();

    // 3. 明确返回「没有记录」仍正常记为 0
    site.seedingAjaxHtml = "<table><tr><td>没有记录</td></tr></table>";
    const res3 = await site.getUserInfoResult({});
    expect(res3.status).toBe(EResultParseStatus.success);
    expect(res3.seeding).toBe(0);
    expect(res3.seedingSize).toBe(0);
  });
});

describe("Bug 3：Unit3D 切换账号后不再沿用旧快照用户名", () => {
  it("即使传入旧账号 lastUserInfo.name，仍先从首页解析当前登录账号并抓取新账号资料", async () => {
    stubChromeBase();
    const { default: Unit3D, SchemaMetadata: Unit3DSchema } = await import("@ptd/site/schemas/Unit3D.ts");

    expect(Unit3DSchema.userInfo.pickLast).toBeUndefined();

    const requestedUrls: string[] = [];
    class SwitchAccountUnit3D extends Unit3D {
      public override async request<T>(config: any): Promise<any> {
        const url = String(config?.url ?? "");
        requestedUrls.push(url);
        if (url === "/") {
          return {
            status: 200,
            headers: {},
            config,
            data: makeDoc(`<nav><a href="/users/new_account/settings">Settings</a></nav>`),
          };
        }
        if (url === "/users/new_account") {
          return {
            status: 200,
            headers: {},
            config,
            data: makeDoc(`
              <li class="ratio-bar__uploaded"><a><i class="fa-arrow-up"></i> 5 TiB</a></li>
              <li class="ratio-bar__downloaded"><a><i class="fa-arrow-down"></i> 1 TiB</a></li>
            `),
          };
        }
        if (url === "/users/old_account") {
          return {
            status: 200,
            headers: {},
            config,
            data: makeDoc(`
              <li class="ratio-bar__uploaded"><a><i class="fa-arrow-up"></i> 100 GiB</a></li>
              <li class="ratio-bar__downloaded"><a><i class="fa-arrow-down"></i> 50 GiB</a></li>
            `),
          };
        }
        return { status: 200, headers: {}, config, data: makeDoc("") };
      }
    }

    const site = new SwitchAccountUnit3D(
      {
        ...Unit3DSchema,
        id: "u3d-switch",
        name: "U3D Switch",
        type: "private",
        urls: ["https://u3d.example/"],
        userInfo: { ...Unit3DSchema.userInfo, requestDelay: 0 },
      } as any,
      {},
    );

    const result = await site.getUserInfoResult({ name: "old_account" });
    expect(result.status).toBe(EResultParseStatus.success);
    expect(result.name).toBe("new_account");
    expect(requestedUrls).toContain("/");
    expect(requestedUrls).toContain("/users/new_account");
    expect(requestedUrls).not.toContain("/users/old_account");
    // 5 TiB > 1 TiB
    expect(result.uploaded).toBe(5 * 1024 ** 4);
  });
});

describe("Bug 6 & Bug 10：内容脚本 bootstrap 下发自定义站点与智能路由配置", () => {
  it("getContentScriptBootstrapData 下发 customSites、pushRoutingRules 与 enableRoutingRulesOnDefaultSend，且内容脚本能实例化自定义站点", async () => {
    vi.resetModules();
    stubChromeBase();

    const handlers = new Map<string, (msg?: any) => Promise<any>>();
    const storedConfig = {
      lang: "zh_CN",
      theme: "light",
      download: {
        allowDirectSendToClient: false,
        useQuickSendToClient: true,
        enableRoutingRulesOnDefaultSend: true,
      },
    };
    const storedMetadata = {
      siteHostMap: { "custom.pt.example": "custom_nexus_1" },
      defaultDownloader: { id: "dl-a", folder: "/default" },
      downloaders: {
        "dl-a": { id: "dl-a", type: "qbittorrent", name: "Downloader A", address: "http://a", enabled: true },
        "dl-b": { id: "dl-b", type: "qbittorrent", name: "Downloader B", address: "http://b", enabled: true },
      },
      customSites: {
        custom_nexus_1: {
          id: "custom_nexus_1",
          name: "Custom Nexus",
          schema: "NexusPHP",
          type: "private",
          urls: ["https://custom.pt.example/"],
          createdAt: 1000,
        },
      },
      pushRoutingRules: [
        {
          id: "rule-b",
          name: "Send Free to B",
          enabled: true,
          priority: 10,
          sites: ["custom_nexus_1"],
          freeOnly: true,
          targetDownloaderId: "dl-b",
          savePath: "/routed/free",
          label: "Free",
        },
      ],
    };

    vi.doMock("@/messages.ts", () => ({
      onMessage: (name: string, fn: (msg?: any) => Promise<any>) => handlers.set(name, fn),
      sendMessage: vi.fn(async () => undefined),
    }));
    vi.doMock("@/storage.ts", () => ({
      extStorage: {
        getItem: vi.fn(async (key: string) => (key === "config" ? storedConfig : storedMetadata)),
        setItem: vi.fn(async () => undefined),
      },
    }));

    const { invalidateStorageReadCache } = await import("@/background/utils/base.ts");
    invalidateStorageReadCache("config");
    invalidateStorageReadCache("metadata");
    const bootstrapHandler = handlers.get("getContentScriptBootstrapData")!;
    const bootstrap = await bootstrapHandler();

    // Bug 6: customSites 已下发
    expect(bootstrap.metadata.customSites).toHaveProperty("custom_nexus_1");
    expect(bootstrap.metadata.customSites.custom_nexus_1.schema).toBe("NexusPHP");

    // Bug 10: 智能路由规则与默认推送开关已下发
    expect(bootstrap.config.download.enableRoutingRulesOnDefaultSend).toBe(true);
    expect(bootstrap.metadata.pushRoutingRules).toHaveLength(1);
    expect(bootstrap.metadata.pushRoutingRules[0]).toMatchObject({
      id: "rule-b",
      targetDownloaderId: "dl-b",
      savePath: "/routed/free",
    });

    // 验证 mountApp 会同步 customSites 到 @ptd/site 注册表，使 getSite("custom_nexus_1") 成功而不抛 not found in build
    vi.stubGlobal(
      "MutationObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    vi.doMock("@/content-script/app/App.vue", () => ({
      default: defineComponent({ name: "StubApp", render: () => null }),
    }));

    const { mountApp } = await import("@/content-script/app/init.ts");
    const { getSite } = await import("@ptd/site");
    const { syncCustomSites } = await import("@ptd/site/customSiteRegistry.ts");
    const { matchPushRoutingRule } = await import("@/shared/pushRouting.ts");

    syncCustomSites({});
    const mounted = mountApp(document as unknown as Document, {
      siteId: "custom_nexus_1",
      config: bootstrap.config,
      metadata: bootstrap.metadata,
    });
    try {
      const site = await getSite("custom_nexus_1", {});
      expect(site.metadata.id).toBe("custom_nexus_1");
      expect(site.metadata.schema).toBe("NexusPHP");

      // 内容脚本使用下发的路由规则命中下载器 B
      const matched = matchPushRoutingRule(
        { site: "custom_nexus_1", title: "Free Movie", tags: [{ name: "Free" }] },
        bootstrap.metadata.pushRoutingRules,
        new Set(Object.keys(bootstrap.metadata.downloaders)),
      );
      expect(matched?.targetDownloaderId).toBe("dl-b");
      expect(matched?.savePath).toBe("/routed/free");
    } finally {
      mounted.app.unmount();
      mounted.contentRoot.remove();
      syncCustomSites({});
    }
  });
});

describe("Bug 7：刷新失败持久化并在工具栏弹窗健康汇总中准确统计异常站点", () => {
  it("此前正常的站点掉线后：保留 lastUserInfo 成功快照，同时写入 lastUserInfoFailures，弹窗异常数变为 1；恢复后归零", async () => {
    vi.resetModules();
    stubChromeBase();

    const storage = new Map<string, any>();
    storage.set("metadata", {
      sites: { mteam: { allowQueryUserInfo: true } },
      lastUserInfo: {
        mteam: {
          site: "mteam",
          status: EResultParseStatus.success,
          updateAt: 1000,
          uploaded: 5000,
          messageCount: 2,
        },
      },
    });
    storage.set("config", { userInfo: { alwaysPickLastUserInfo: true } });

    const getSiteInstanceMock = vi.fn();
    vi.doMock("@/messages.ts", () => ({
      onMessage: vi.fn(),
      sendMessage: vi.fn(async (type: string, payload: any) => {
        if (type === "getExtStoragePath") {
          const path = Array.isArray(payload.path) ? payload.path : [payload.path];
          let cur = storage.get(payload.key);
          for (const seg of path) {
            if (cur == null) return payload.defaultValue;
            cur = cur[seg];
          }
          return cur === undefined ? payload.defaultValue : structuredClone(cur);
        }
        if (type === "patchExtStoragePath") {
          const root = storage.get(payload.key) ?? {};
          const path = Array.isArray(payload.path) ? payload.path : [payload.path];
          let cur = root;
          for (let i = 0; i < path.length - 1; i++) {
            cur[path[i]] ??= {};
            cur = cur[path[i]];
          }
          const last = path[path.length - 1];
          if (payload.remove) delete cur[last];
          else cur[last] = structuredClone(payload.value);
          storage.set(payload.key, root);
          return undefined;
        }
        return undefined;
      }),
    }));
    vi.doMock("@/offscreen/utils/logger.ts", () => ({ logger: vi.fn() }));
    vi.doMock("@/offscreen/utils/site.ts", () => ({ getSiteInstance: getSiteInstanceMock }));

    const { getSiteUserInfoResult } = await import("@/offscreen/utils/userInfo.ts");
    const { summarizeAccountHealth } = await import("@/shared/accountHealth.ts");

    // 1. 掉线返回 needLogin
    getSiteInstanceMock.mockResolvedValueOnce({
      url: "https://kp.m-team.cc/",
      allowQueryUserInfo: true,
      isOnline: true,
      metadata: { type: "private" },
      getUserInfoResult: vi.fn(async () => ({
        site: "mteam",
        status: EResultParseStatus.needLogin,
        statusMsg: "Cookie expired",
        updateAt: 2000,
      })),
    });

    await getSiteUserInfoResult("mteam");
    const metaAfterFail = storage.get("metadata");
    expect(metaAfterFail.lastUserInfo.mteam.uploaded).toBe(5000);
    expect(metaAfterFail.lastUserInfoFailures.mteam).toMatchObject({
      status: EResultParseStatus.needLogin,
      at: 2000,
    });

    const summaryAfterFail = summarizeAccountHealth({
      siteIds: Object.keys(metaAfterFail.sites),
      lastUserInfo: metaAfterFail.lastUserInfo,
      lastUserInfoFailures: metaAfterFail.lastUserInfoFailures,
      defaultInactivityDays: 30,
      warnBeforeDays: 7,
    });
    expect(summaryAfterFail.abnormalSiteCount).toBe(1);
    expect(summaryAfterFail.unreadMessageCount).toBe(2);

    // 2. 再次刷新成功后，异常记录被清除，异常数归零
    getSiteInstanceMock.mockResolvedValueOnce({
      url: "https://kp.m-team.cc/",
      allowQueryUserInfo: true,
      isOnline: true,
      metadata: { type: "private" },
      getUserInfoResult: vi.fn(async () => ({
        site: "mteam",
        status: EResultParseStatus.success,
        updateAt: 3000,
        uploaded: 6000,
        messageCount: 0,
      })),
    });

    await getSiteUserInfoResult("mteam");
    const metaAfterRecover = storage.get("metadata");
    expect(metaAfterRecover.lastUserInfoFailures?.mteam).toBeUndefined();

    const summaryAfterRecover = summarizeAccountHealth({
      siteIds: Object.keys(metaAfterRecover.sites),
      lastUserInfo: metaAfterRecover.lastUserInfo,
      lastUserInfoFailures: metaAfterRecover.lastUserInfoFailures,
      defaultInactivityDays: 30,
      warnBeforeDays: 7,
    });
    expect(summaryAfterRecover.abnormalSiteCount).toBe(0);
  });
});

describe("Bug 8 & Bug 10（offscreen）：辅种校验返回真实 infoHash，且内容脚本智能路由 savePath 被放行", () => {
  it("getTorrentInfoForVerification 对有效种子返回 40 位 infoHash，且内容脚本推送允许命中路由规则的 savePath", async () => {
    vi.resetModules();
    stubChromeBase();

    const handlers = new Map<string, (msg?: any) => Promise<any>>();
    const addTorrentMock = vi.fn(async () => ({ success: true }));

    // 真实合法的最小 bencoded .torrent 文件字节流
    const bencoded =
      "d4:infod6:lengthi12345e4:name10:sample.mkv12:piece lengthi16384e6:pieces20:12345678901234567890ee";
    const torrentBuffer = new TextEncoder().encode(bencoded).buffer;

    vi.spyOn(axios, "request").mockResolvedValue({
      status: 200,
      headers: { "content-type": "application/x-bittorrent" },
      data: torrentBuffer,
    } as any);

    const mockSite = {
      url: "https://pt.example/",
      downloadInterval: 0,
      metadata: { id: "demo", name: "Demo", urls: ["https://pt.example/"] },
      userConfig: {},
      getTorrentDownloadLink: vi.fn(async () => "https://pt.example/download.php?id=1"),
      getTorrentDownloadRequestConfig: vi.fn(async () => ({
        url: "https://pt.example/download.php?id=1",
        method: "GET",
      })),
      isTrustedSiteUrl: vi.fn(() => true),
      isTrustedDownloadLink: vi.fn(() => true),
    };

    vi.doMock("@/messages.ts", () => ({
      onMessage: (name: string, fn: (msg?: any) => Promise<any>) => handlers.set(name, fn),
      sendMessage: vi.fn(async (type: string, payload: any) => {
        if (type === "getExtStoragePath" && payload.key === "config") {
          if (payload.path === "download") return { saveDownloadHistory: false, allowDirectSendToClient: true };
          if (payload.path === "download.saveDownloadHistory") return false;
        }
        if (type === "getExtStoragePath" && payload.key === "metadata") {
          const path = Array.isArray(payload.path) ? payload.path : [payload.path];
          if (path[0] === "downloaders" && path[1] === "dl-b") {
            return {
              id: "dl-b",
              type: "qbittorrent",
              name: "Downloader B",
              address: "http://b",
              enabled: true,
              suggestFolders: ["/downloads/default"],
            };
          }
          if (path[0] === "defaultDownloader") return { id: "dl-a", folder: "/downloads/a" };
          if (path[0] === "siteNameMap") return "Demo";
          if (path[0] === "pushRoutingRules") {
            return [
              {
                id: "rule-b",
                name: "Route to B",
                enabled: true,
                priority: 10,
                targetDownloaderId: "dl-b",
                savePath: "/downloads/routed-free",
              },
            ];
          }
        }
        return payload?.defaultValue;
      }),
    }));
    vi.doMock("@/offscreen/utils/logger.ts", () => ({ logger: vi.fn() }));
    vi.doMock("@/offscreen/utils/site.ts", () => ({ getSiteInstance: vi.fn(async () => mockSite) }));
    vi.doMock("@/offscreen/utils/torrentFavorite.ts", () => ({
      getTorrentFavoriteStatus: vi.fn(async () => ({ favorites: [] })),
    }));
    vi.doMock("@/offscreen/adapter/indexdb.ts", () => ({
      ptdIndexDb: Promise.resolve({
        put: vi.fn(async () => 1),
        get: vi.fn(async () => null),
        getAll: vi.fn(async () => []),
      }),
    }));
    vi.doMock("@ptd/downloader", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@ptd/downloader")>();
      return {
        ...actual,
        getDownloader: vi.fn(async () => ({ addTorrent: addTorrentMock })),
      };
    });

    const { getTorrentInfoForVerification } = await import("@/offscreen/utils/download.ts");

    // Bug 8: infoHash 非空且为标准 40 位十六进制
    const info = await getTorrentInfoForVerification({
      site: "demo",
      id: "1",
      title: "sample",
      link: "https://pt.example/download.php?id=1",
    });
    expect(info.infoHash).toMatch(/^[a-f0-9]{40}$/i);
    expect(info.name).toBe("sample.mkv");
    expect(info.length).toBe(12345);

    // Bug 10: 来自 content-script sender 且携带智能路由 savePath（不在 suggestFolders 里）应被放行
    const downloadTorrentHandler = handlers.get("downloadTorrent")!;
    const pushRes = await downloadTorrentHandler({
      data: {
        torrent: { site: "demo", id: "1", title: "sample", link: "https://pt.example/download.php?id=1" },
        downloaderId: "dl-b",
        addTorrentOptions: { savePath: "/downloads/routed-free", localDownload: false },
      },
      sender: { id: "test-ext", url: "https://pt.example/torrents.php", tab: { id: 1 } },
    });
    expect(pushRes.downloadStatus).toBe("completed");
    expect(addTorrentMock).toHaveBeenCalledWith(
      "https://pt.example/download.php?id=1",
      expect.objectContaining({ savePath: "/downloads/routed-free" }),
    );
  });
});

describe("Bug 9：YemaPT 生成下载链接使用 torrent.id 并兼容旧任务 url 兜底", () => {
  it("优先传递 torrent.id；旧辅种任务缺少 id 时从详情页 url 提取数字 id", async () => {
    stubChromeBase();
    const { default: YemaPT, siteMetadata } = await import("@ptd/site/definitions/yemapt.ts");
    const site = new YemaPT(siteMetadata, {});

    const requestSpy = vi.spyOn(site as any, "request").mockResolvedValue({
      status: 200,
      headers: {},
      data: { success: true, data: "dl-token-xyz" },
    });

    const link1 = await site.getTorrentDownloadLink({
      site: "yemapt",
      id: "4321",
      title: "Test",
      url: "https://www.yemapt.org/#/torrent/detail/4321",
    } as any);
    expect((requestSpy.mock.calls[0][0] as any).params).toEqual({ id: "4321" });
    expect(link1).toBe("https://www.yemapt.org/api/torrent/download1?token=dl-token-xyz");

    const link2 = await site.getTorrentDownloadLink({
      site: "yemapt",
      title: "Legacy Saved Item",
      url: "https://www.yemapt.org/#/torrent/detail/9988",
    } as any);
    expect((requestSpy.mock.calls[1][0] as any).params).toEqual({ id: "9988" });
    expect(link2).toBe("https://www.yemapt.org/api/torrent/download1?token=dl-token-xyz");
  });
});
