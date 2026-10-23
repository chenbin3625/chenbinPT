/**
 * OS-5：站点实例按 siteId 缓存 + per-site 串行；A2：getSiteUserConfig 的 sender→site 绑定。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  let siteInstanceSeq = 0;
  return {
    nextSiteInstance: () => ({ tag: `site-${++siteInstanceSeq}` }),
    resetSiteSeq: () => {
      siteInstanceSeq = 0;
    },
    onMessage: vi.fn(),
    sendMessage: vi.fn(),
    logger: vi.fn(),
    getDefinedSiteMetadata: vi.fn(),
    createSiteInstance: vi.fn(),
    getFavicon: vi.fn(),
    db: { get: vi.fn(), put: vi.fn(), clear: vi.fn() },
    siteConfigs: {} as Record<string, any>,
  };
});

vi.mock("@/messages.ts", () => ({ onMessage: mocks.onMessage, sendMessage: mocks.sendMessage }));
vi.mock("@/offscreen/utils/logger.ts", () => ({ logger: mocks.logger }));
vi.mock("@/offscreen/adapter/indexdb.ts", () => ({ ptdIndexDb: Promise.resolve(mocks.db) }));
vi.mock("@ptd/site", () => ({
  getDefinedSiteMetadata: mocks.getDefinedSiteMetadata,
  getFavicon: mocks.getFavicon,
  getSite: mocks.createSiteInstance,
  NO_IMAGE: "no-image",
  checkSiteMetadataAllow: () => true,
}));

vi.stubGlobal("chrome", {
  runtime: {
    id: "test",
    getURL: (path: string) => `chrome-extension://test/${path}`,
  },
} as any);
vi.stubGlobal("__BROWSER__", "chrome");

type TGetSiteUserConfigHandler = (args: { data: { siteId: string; flush?: boolean }; sender?: any }) => Promise<any>;

async function loadSiteModule() {
  vi.resetModules();
  mocks.onMessage.mockClear();
  mocks.sendMessage.mockReset();
  mocks.logger.mockClear();
  mocks.getDefinedSiteMetadata.mockReset();
  mocks.createSiteInstance.mockReset();
  mocks.getFavicon.mockReset();
  mocks.getFavicon.mockResolvedValue("data:image/png;base64,x");
  mocks.db.get.mockReset();
  mocks.db.put.mockReset();
  mocks.db.get.mockResolvedValue(undefined);
  mocks.resetSiteSeq();
  mocks.siteConfigs = {};

  mocks.getDefinedSiteMetadata.mockImplementation(async (siteId: string) => ({
    id: siteId,
    urls: [`https://${siteId}.example.com/`],
    schema: "AbstractBittorrentSite",
    type: "private",
  }));

  mocks.sendMessage.mockImplementation(async (name: string, payload: any) => {
    if (name === "getExtStoragePath" && Array.isArray(payload?.path) && payload.path[0] === "sites") {
      return mocks.siteConfigs[payload.path[1]] ?? {};
    }
    return payload?.defaultValue;
  });

  // 每个实例都带独立的 isTrustedDownloadLink（用于 sender 绑定断言）
  mocks.createSiteInstance.mockImplementation(async (siteId: string) => {
    const primaryHost = `${siteId}.example.com`;
    // 模拟 mteam 这类站点：兄弟 API 主机也属于可信集合（D2 的 trustedHostnames 覆写）。
    const trustedHosts = [primaryHost, `api.${primaryHost}`];
    return {
      ...mocks.nextSiteInstance(),
      url: `https://${primaryHost}/`,
      metadata: { id: siteId, urls: [`https://${primaryHost}/`] },
      userConfig: {},
      isTrustedSiteUrl: (url: string) => trustedHosts.includes(new URL(url).hostname),
    };
  });

  return await import("@/offscreen/utils/site.ts");
}

describe("OS-5：站点实例缓存与 per-site 串行", () => {
  beforeEach(() => {
    mocks.siteConfigs = {};
  });

  it("同站点同配置的重复 getSiteInstance 只构造一次", async () => {
    const { getSiteInstance } = await loadSiteModule();
    mocks.siteConfigs.a = { url: "https://a.example.com/" };

    const first = await getSiteInstance("a");
    const second = await getSiteInstance("a");

    expect(mocks.createSiteInstance).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
  });

  it("用户配置变化时缓存失效并重建实例", async () => {
    const { getSiteInstance } = await loadSiteModule();
    mocks.siteConfigs.a = { url: "https://a.example.com/", timeout: 30000 };

    const first = await getSiteInstance("a");
    mocks.siteConfigs.a = { ...mocks.siteConfigs.a, timeout: 60000 };
    const second = await getSiteInstance("a");

    expect(mocks.createSiteInstance).toHaveBeenCalledTimes(2);
    expect(first).not.toBe(second);
  });

  it("clearSiteInstanceCache 会强制下次重建（备份恢复等整份重写 metadata 的场景）", async () => {
    const { getSiteInstance } = await loadSiteModule();
    const { clearSiteInstanceCache } = await import("@/offscreen/utils/siteInstanceCache.ts");
    mocks.siteConfigs.a = { url: "https://a.example.com/" };

    await getSiteInstance("a");
    clearSiteInstanceCache();
    await getSiteInstance("a");

    expect(mocks.createSiteInstance).toHaveBeenCalledTimes(2);
  });

  it("runSiteOperation 按站点串行、不同站点互不阻塞", async () => {
    const { runSiteOperation } = await loadSiteModule();

    const events: string[] = [];
    let releaseA!: () => void;
    const gateA = new Promise<void>((resolve) => (releaseA = resolve));

    const a1 = runSiteOperation("a", async () => {
      events.push("a1-start");
      await gateA;
      events.push("a1-end");
    });
    const a2 = runSiteOperation("a", async () => {
      events.push("a2-start");
      events.push("a2-end");
    });
    const b1 = runSiteOperation("b", async () => {
      events.push("b1");
    });

    // b1 可以先完成；a2 必须等 a1
    await b1;
    expect(events).toEqual(["a1-start", "b1"]);
    releaseA();
    await Promise.all([a1, a2]);
    expect(events).toEqual(["a1-start", "b1", "a1-end", "a2-start", "a2-end"]);
  });
});

describe("A2：getSiteUserConfig 的 sender→site 绑定", () => {
  beforeEach(() => {
    mocks.siteConfigs = { a: { url: "https://a.example.com/" } };
  });

  async function getHandler(): Promise<TGetSiteUserConfigHandler> {
    const { onMessage } = await import("@/messages.ts");
    const { getSiteUserConfig } = await import("@/offscreen/utils/site.ts");
    expect(typeof getSiteUserConfig).toBe("function");
    const calls = (onMessage as any).mock.calls.filter(([name]: [string]) => name === "getSiteUserConfig");
    expect(calls).toHaveLength(1);
    return calls[0][1] as TGetSiteUserConfigHandler;
  }

  it("内容脚本在自己站点页面上可以读该站点配置", async () => {
    await loadSiteModule();
    mocks.siteConfigs.a = { url: "https://a.example.com/" };
    const handler = await getHandler();

    const result = await handler({
      data: { siteId: "a" },
      sender: { id: "test", url: "https://a.example.com/torrents.php?id=1", tab: { url: "https://a.example.com/" } },
    });

    expect(result).toMatchObject({ url: "https://a.example.com/" });
  });

  it("内容脚本跨站读取其它站点配置被拒绝（A2 凭据面收口）", async () => {
    await loadSiteModule();
    mocks.siteConfigs.a = { url: "https://a.example.com/" };
    const handler = await getHandler();

    await expect(
      handler({
        data: { siteId: "a" },
        sender: { id: "test", url: "https://evil.example/x", tab: { url: "https://evil.example/" } },
      }),
    ).rejects.toThrow(/Permission denied/);
  });

  it("扩展页（options）读取任意站点配置不受限制", async () => {
    await loadSiteModule();
    mocks.siteConfigs.a = { url: "https://a.example.com/" };
    const handler = await getHandler();

    const result = await handler({
      data: { siteId: "a" },
      sender: { id: "test", url: "chrome-extension://test/src/entries/options/index.html" },
    });
    expect(result).toMatchObject({ url: "https://a.example.com/" });
  });
});

describe("D2：getSiteUserConfig 绑定复用 isTrustedSiteUrl（兄弟 API 主机不被误拒）", () => {
  it("mteam 式站点：从兄弟 API 主机页面发起的读取同样被放行", async () => {
    await loadSiteModule();
    mocks.siteConfigs.a = { url: "https://a.example.com/" };
    const { onMessage } = await import("@/messages.ts");
    await import("@/offscreen/utils/site.ts");
    const handler = (onMessage as any).mock.calls.find(([name]: [string]) => name === "getSiteUserConfig")[1];

    const result = await handler({
      data: { siteId: "a" },
      sender: { id: "test", url: "https://api.a.example.com/torrents.php" },
    });
    expect(result).toMatchObject({ url: "https://a.example.com/" });
  });
});

describe("D2-N8：getSiteFavicon 传 legacyUrls 且失败时回落 NO_IMAGE", () => {
  it("getFavicon 收到 legacyUrls，并缓存结果", async () => {
    const { getSiteFavicon } = await loadSiteModule();
    mocks.siteConfigs.a = { url: "https://a.example.com/" };
    mocks.createSiteInstance.mockImplementationOnce(async () => ({
      url: "https://a.example.com/",
      metadata: {
        id: "a",
        urls: ["https://a.example.com/"],
        legacyUrls: ["https://old-a.example.com/"],
        favicon: undefined,
      },
      userConfig: {},
      isTrustedSiteUrl: () => true,
    }));

    await getSiteFavicon("a");

    expect(mocks.getFavicon).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "a",
        urls: ["https://a.example.com/"],
        legacyUrls: ["https://old-a.example.com/"],
      }),
    );
    expect(mocks.db.put).toHaveBeenCalledWith("favicon", "data:image/png;base64,x", "a");
  });

  it("站点实例化失败时不 reject，回落 NO_IMAGE 且不写缓存", async () => {
    const { getSiteFavicon } = await loadSiteModule();
    mocks.siteConfigs.a = { url: "https://a.example.com/" };
    mocks.createSiteInstance.mockRejectedValueOnce(new Error("site definition missing"));

    await expect(getSiteFavicon("missing-site")).resolves.toBe("no-image");
    expect(mocks.db.put).not.toHaveBeenCalled();
  });
});

describe("OS-5：缓存 key 稳定序列化（2026-10-24 P2-7）", () => {
  it("对象键序不同但内容等价的配置生成同一个 key", async () => {
    const { getSiteInstanceCacheKey } = await import("@/offscreen/utils/siteInstanceCache.ts");

    const configA = { url: "https://a.example.com/", timeout: 30000, groups: ["x", "y"] } as any;
    const configB = { groups: ["x", "y"], timeout: 30000, url: "https://a.example.com/" } as any;

    expect(getSiteInstanceCacheKey("a", configA, true)).toBe(getSiteInstanceCacheKey("a", configB, true));
  });

  it("内容不同（含数组顺序）仍生成不同 key；runtimeSettings 不参与 key", async () => {
    const { getSiteInstanceCacheKey } = await import("@/offscreen/utils/siteInstanceCache.ts");

    const base = { url: "https://a.example.com/", groups: ["x", "y"] } as any;
    expect(getSiteInstanceCacheKey("a", { ...base, url: "https://b.example.com/" }, true)).not.toBe(
      getSiteInstanceCacheKey("a", base, true),
    );
    expect(getSiteInstanceCacheKey("a", { ...base, groups: ["y", "x"] }, true)).not.toBe(
      getSiteInstanceCacheKey("a", base, true),
    );
    expect(getSiteInstanceCacheKey("a", { ...base, runtimeSettings: { passkey: "secret" } }, true)).toBe(
      getSiteInstanceCacheKey("a", base, true),
    );
    // mergeUserConfig 也是 key 的一部分
    expect(getSiteInstanceCacheKey("a", base, false)).not.toBe(getSiteInstanceCacheKey("a", base, true));
  });
});
