/**
 * C2 修复回归：社交页面识别、PtGen 端点候选、海报 URL 校验。
 *
 * - C2-S-1：主机白名单改为后缀匹配，且各实体正则允许常见子域（m.douban.com / m.imdb.com …）
 * - C2-S-2：PtGen 候选集包含全部内置端点（旧实现永远跳过 OurHelp CDN）
 * - C2-S-3：poster 来自第三方 JSON，只允许 http(s) 公网地址，拒绝 javascript:/data(非图片)/本机/私网
 */
import axios from "axios";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// index.ts 会连带引入 @ptd/site 的运行时依赖（messages.ts 用到 __BROWSER__ 与 chrome API）
vi.stubGlobal("__BROWSER__", "chrome");
vi.stubGlobal("chrome", {
  storage: {
    local: { get: () => Promise.resolve({}), set: () => Promise.resolve(), remove: () => Promise.resolve() },
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

const { matchSocialPageUrl, getSocialSiteInformation, buildInPtGenApi } = await import("@ptd/social");
const { normalizeSocialPosterUrl } = await import("@ptd/social/utils.ts");
const { transformPtGen: doubanTransformPtGen } = await import("@ptd/social/entity/douban.ts");
const { transformPtGen: imdbTransformPtGen } = await import("@ptd/social/entity/imdb.ts");

let requestedUrls: string[] = [];

beforeEach(() => {
  requestedUrls = [];
  vi.spyOn(axios, "get").mockImplementation(((url: string) => {
    requestedUrls.push(url);
    if (url.includes("ourbits.github.io")) {
      return Promise.reject(new Error("github pages blocked"));
    }
    if (url.includes("cdn.ourhelp.club")) {
      return Promise.reject(new Error("cdn blocked"));
    }
    return Promise.resolve({
      status: 200,
      data: { sid: url, name: "Imdb Title", poster: "https://m.media-amazon.com/p.jpg" },
    });
  }) as any);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("C2-S-1：社交页面识别", () => {
  it.each([
    ["https://movie.douban.com/subject/1234/", "douban"],
    ["https://m.douban.com/subject/1234/", "douban"],
    ["https://www.imdb.com/title/tt0111161/", "imdb"],
    ["https://m.imdb.com/title/tt0111161/", "imdb"],
    ["https://bgm.tv/subject/123", "bangumi"],
    ["https://m.bgm.tv/subject/123", "bangumi"],
    ["https://www.tvmaze.com/shows/1234/example-show", "tvmaze"],
    ["https://www.themoviedb.org/movie/550-fight-club", "tmdb"],
  ])("%s → %s", (url, expected) => {
    expect(matchSocialPageUrl(url)).toBe(expected);
  });

  it.each([
    "https://elsewhere.example/?next=https://movie.douban.com/subject/1",
    "https://douban.com.evil.example/subject/1234/",
    "https://m.douban.com/other?next=/subject/1234",
    "javascript:alert(1)",
  ])("%s 不被识别为社交页", (url) => {
    expect(matchSocialPageUrl(url)).toBeNull();
  });
});

describe("C2-S-2：PtGen 候选端点", () => {
  it("全部内置端点（含 OurHelp CDN）都参与并发尝试", async () => {
    const result = await getSocialSiteInformation("imdb", "tt0000001", {});

    expect(result?.title).toBe("Imdb Title");
    const usedBuiltInEndpoints = buildInPtGenApi
      .map((api) => api.url.replace("<site>", "imdb").replace("<sid>", "tt0000001"))
      .filter((url) => requestedUrls.includes(url));

    expect(usedBuiltInEndpoints).toHaveLength(buildInPtGenApi.length);
    expect(requestedUrls.some((url) => url.includes("cdn.ourhelp.club"))).toBe(true);
  });
});

describe("C2-S-3：海报 URL 校验", () => {
  it.each([
    ["https://img1.doubanio.com/view/photo/s_ratio_poster/public/p1.jpg", true],
    ["http://img9.doubanio.com/x.jpg", true],
    ["data:image/png;base64,AAAA", true],
    ["javascript:alert(1)", false],
    ["ftp://example.com/x.jpg", false],
    ["http://127.0.0.1/x.jpg", false],
    ["http://localhost/x.jpg", false],
    ["http://192.168.1.10/x.jpg", false],
    ["http://10.0.0.1/x.jpg", false],
    ["http://172.16.3.4/x.jpg", false],
    ["http://169.254.169.254/latest/meta-data/", false],
    ["http://[::1]/x.jpg", false],
    ["not a url", false],
  ])("%s → %s", (url, expected) => {
    const normalized = normalizeSocialPosterUrl(url);
    if (expected) {
      expect(normalized).toBe(url);
    } else {
      expect(normalized).toBeUndefined();
    }
  });

  it("PtGen transform 不会把内网海报地址写进社交信息", () => {
    const douban = doubanTransformPtGen({ sid: "123", poster: "http://192.168.0.2/a.jpg" } as any);
    expect(douban.poster).toBe("");

    const imdb = imdbTransformPtGen({ sid: "tt1", poster: "javascript:alert(1)" } as any);
    expect(imdb.poster).toBe("");

    const ok = imdbTransformPtGen({ sid: "tt1", poster: "https://m.media-amazon.com/a.jpg" } as any);
    expect(ok.poster).toBe("https://m.media-amazon.com/a.jpg");
  });
});
