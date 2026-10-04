/**
 * `getSocialSiteInformation` 进程内缓存的行为验证。
 *
 * 原缺陷：缓存键只有 `site:id`，10 分钟 TTL 内改了 PtGen 端点 / timeout / preferPtGen
 * 也会复用旧 Promise，成功结果（含按错误端点拿到的）被钉死。
 *
 * 这里用 imdb（支持 transformPtGen）作为站点，mock 掉 axios：
 * 只有配置里的 ptGenEndpoint 会成功，内置的 ourhelp 端点始终失败，
 * 从而让 `Promise.any` 的胜者稳定等于当前配置指定的端点。
 * 注意：每次 PtGen 抓取都会同时请求配置端点与内置 ourhelp 端点，断言时用 ptGenRequests() 过滤。
 */
import axios from "axios";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// index.ts 会连带引入 @ptd/site 的运行时依赖（messages.ts 用到 __BROWSER__ 与 chrome API），
// 这里给出最小桩，避免为一个缓存行为测试去跑整个扩展环境。
vi.stubGlobal("__BROWSER__", "chrome");
vi.stubGlobal("chrome", {
  storage: {
    local: {
      get: () => Promise.resolve({}),
      set: () => Promise.resolve(),
      remove: () => Promise.resolve(),
      onChanged: { addListener: () => {}, removeListener: () => {} },
    },
    onChanged: { addListener: () => {}, removeListener: () => {} },
  },
  runtime: {
    id: "test",
    onMessage: { addListener: () => undefined, removeListener: () => undefined },
    sendMessage: () => Promise.resolve(undefined),
    getURL: (path: string) => `chrome-extension://test/${path}`,
  },
  cookies: { get: () => Promise.resolve(null), set: () => Promise.resolve(), getAll: () => Promise.resolve([]) },
  downloads: { download: () => Promise.resolve(1) },
  tabs: { create: () => Promise.resolve(), query: () => Promise.resolve([]) },
  declarativeNetRequest: { updateSessionRules: () => Promise.resolve() },
});

const { getSocialSiteInformation } = await import("@ptd/social");

const SITE = "imdb";
const endpointA = "https://ptgen-a.example/<site>/<sid>.json";
const endpointB = "https://ptgen-b.example/<site>/<sid>.json";

function expand(endpoint: string, id: string): string {
  return endpoint.replace("<site>", SITE).replace("<sid>", id);
}

let requestedUrls: string[] = [];
let namePrefix = "v1";

function ptGenRequests(): string[] {
  return requestedUrls.filter((url) => !url.includes("ourhelp.club"));
}

beforeEach(() => {
  requestedUrls = [];
  namePrefix = "v1";

  vi.spyOn(axios, "get").mockImplementation(((url: string) => {
    requestedUrls.push(url);

    // 内置 ourhelp 端点始终失败，保证 Promise.any 的胜者一定是配置里的 ptGenEndpoint
    if (url.includes("ourhelp.club")) {
      return Promise.reject(new Error("built-in endpoint disabled in test"));
    }

    return Promise.resolve({ status: 200, data: { sid: url, name: `${namePrefix}:${url}` } });
  }) as any);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getSocialSiteInformation 缓存键", () => {
  it("配置等价（键顺序不同、仅 cacheDay 不同）时命中同一条缓存", async () => {
    const id = "tt0000001";

    await getSocialSiteInformation(SITE, id, { preferPtGen: true, ptGenEndpoint: endpointA });
    expect(ptGenRequests()).toEqual([expand(endpointA, id)]);

    requestedUrls = [];
    const second = await getSocialSiteInformation(SITE, id, {
      ptGenEndpoint: endpointA,
      cacheDay: 7,
      preferPtGen: true,
    });

    expect(requestedUrls).toEqual([]); // 完整命中，无网络请求
    expect(second?.title).toBe(`v1:${expand(endpointA, id)}`);
  });

  it("ptGenEndpoint 变化会进入新的缓存键并重新抓取", async () => {
    const id = "tt0000002";

    const first = await getSocialSiteInformation(SITE, id, { ptGenEndpoint: endpointA });
    requestedUrls = [];

    const second = await getSocialSiteInformation(SITE, id, { ptGenEndpoint: endpointB });

    expect(ptGenRequests()).toEqual([expand(endpointB, id)]);
    expect(first?.title).toBe(`v1:${expand(endpointA, id)}`);
    expect(second?.title).toBe(`v1:${expand(endpointB, id)}`);
  });

  it("preferPtGen 变化（改用内置解析）同样不会被旧缓存吞掉", async () => {
    const id = "tt0000003";

    await getSocialSiteInformation(SITE, id, { preferPtGen: true, ptGenEndpoint: endpointA });
    requestedUrls = [];

    // preferPtGen: false → 直接走 imdb 内置解析（请求 p.media-imdb.com 的 ratings JSONP）
    await getSocialSiteInformation(SITE, id, { preferPtGen: false });

    expect(requestedUrls).toEqual([expect.stringContaining("p.media-imdb.com")]);
  });

  it("config.force 绕过缓存、覆盖旧条目，后续普通调用复用强制刷新结果", async () => {
    const id = "tt0000004";
    const config = { ptGenEndpoint: endpointA };

    const cached = await getSocialSiteInformation(SITE, id, config);
    expect(cached?.title).toBe(`v1:${expand(endpointA, id)}`);

    // 强制刷新：mock 返回内容变化，验证确实重新抓取
    namePrefix = "v2";
    requestedUrls = [];
    const forced = await getSocialSiteInformation(SITE, id, { ...config, force: true });

    expect(ptGenRequests()).toEqual([expand(endpointA, id)]);
    expect(forced?.title).toBe(`v2:${expand(endpointA, id)}`);

    // 覆盖：普通调用直接命中 force 写入的新条目（force 不改变缓存键）
    namePrefix = "v3";
    requestedUrls = [];
    const afterForce = await getSocialSiteInformation(SITE, id, config);

    expect(requestedUrls).toEqual([]);
    expect(afterForce?.title).toBe(`v2:${expand(endpointA, id)}`);
  });
});
