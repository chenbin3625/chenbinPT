/**
 * OS-6 / B1-7：推荐海报抓取的主机白名单、重定向校验与大小上限。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const isolatedAxios = { get: vi.fn() };
  return {
    isolatedAxios,
    axiosCreate: vi.fn(() => isolatedAxios),
    setupReplaceUnsafeHeader: vi.fn((instance) => instance),
    onMessage: vi.fn(),
    logger: vi.fn(),
    getSocialInformation: vi.fn(),
    getSocialRecommendations: vi.fn(),
  };
});

vi.mock("axios", () => ({ default: { create: mocks.axiosCreate, get: vi.fn() } }));
vi.mock("~/extends/axios/replaceUnsafeHeader.ts", () => ({
  setupReplaceUnsafeHeader: mocks.setupReplaceUnsafeHeader,
}));
vi.mock("@ptd/social", () => ({ getSocialRecommendations: mocks.getSocialRecommendations }));
vi.mock("@/messages.ts", () => ({ onMessage: mocks.onMessage }));
vi.mock("@/offscreen/utils/logger.ts", () => ({ logger: mocks.logger }));
vi.mock("@/offscreen/utils/socialInformation.ts", () => ({ getSocialInformation: mocks.getSocialInformation }));

async function loadModule() {
  vi.resetModules();
  mocks.onMessage.mockClear();
  mocks.logger.mockClear();
  mocks.getSocialInformation.mockReset();
  mocks.getSocialInformation.mockResolvedValue(undefined);
  mocks.isolatedAxios.get.mockReset();

  const mod = await import("@/offscreen/utils/socialRecommendations.ts");
  const handler = mocks.onMessage.mock.calls.find(([name]) => name === "getSocialRecommendations")?.[1];
  expect(handler).toBeTypeOf("function");
  return { mod, handler: handler as (args: { data: any }) => Promise<any> };
}

function makeResult(poster?: string) {
  mocks.getSocialRecommendations.mockResolvedValue({
    items: [{ category: "movie", site: "douban", id: "1", title: "t", poster }],
    hasFailedSources: false,
  });
}

function makeImageResponse(size: number, extra: Record<string, any> = {}) {
  const bytes = new Uint8Array(size);
  return {
    data: new Blob([bytes], { type: "image/png" }),
    headers: { "content-type": "image/png" },
    ...extra,
  };
}

describe("OS-6：海报 URL 主机/协议白名单", () => {
  it("白名单工具函数：已知图床放行、内网/任意站点/非 http(s) 拒绝", async () => {
    const { mod } = await loadModule();
    expect(mod.isAllowedPosterUrl("https://img1.doubanio.com/view/photo/x.jpg")).toBe(true);
    expect(mod.isAllowedPosterUrl("https://image.tmdb.org/t/p/w500/x.jpg")).toBe(true);
    expect(mod.isAllowedPosterUrl("https://m.media-amazon.com/images/M/x.jpg")).toBe(true);
    expect(mod.isAllowedPosterUrl("https://cdn.anidb.net/images/main/x.jpg")).toBe(true);
    expect(mod.isAllowedPosterUrl("https://lain.bgm.tv/pic/cover/x.jpg")).toBe(true);
    expect(mod.isAllowedPosterUrl("https://static.tvmaze.com/uploads/x.jpg")).toBe(true);

    expect(mod.isAllowedPosterUrl("http://127.0.0.1/x.png")).toBe(false);
    expect(mod.isAllowedPosterUrl("http://192.168.1.1/x.png")).toBe(false);
    expect(mod.isAllowedPosterUrl("https://evil.example/x.png")).toBe(false);
    expect(mod.isAllowedPosterUrl("file:///etc/passwd")).toBe(false);
    expect(mod.isAllowedPosterUrl("javascript:alert(1)")).toBe(false);
    // 伪装成白名单后缀的域名不放行
    expect(mod.isAllowedPosterUrl("https://doubanio.com.evil.example/x.png")).toBe(false);
  });

  it("推荐项 poster 指向内网时不会发起请求，也不会把原始 URL 透传给 options", async () => {
    const { handler } = await loadModule();
    makeResult("http://127.0.0.1:8080/admin/shutdown");

    const result = await handler({ data: {} });

    expect(mocks.isolatedAxios.get).not.toHaveBeenCalled();
    expect(result.items[0].poster).toBeUndefined();
  });

  it("白名单图床正常抓取并转 data URL", async () => {
    const { handler } = await loadModule();
    mocks.isolatedAxios.get.mockResolvedValue(makeImageResponse(4096));
    makeResult("https://img1.doubanio.com/view/photo/s_ratio_poster/public/x.jpg");

    const result = await handler({ data: {} });

    expect(mocks.isolatedAxios.get).toHaveBeenCalled();
    expect(mocks.isolatedAxios.get.mock.calls[0]![0]).toContain("doubanio.com");
    // S-3：海报抓取永不携带 Cookie/凭据
    expect(mocks.isolatedAxios.get.mock.calls[0]![1]).toMatchObject({ withCredentials: false });
    expect(result.items[0].poster).toMatch(/^data:image\//);
  });

  it("重定向到白名单之外时丢弃该候选（不缓存、不透传）", async () => {
    const { handler } = await loadModule();
    mocks.isolatedAxios.get.mockResolvedValue(
      makeImageResponse(4096, { request: { responseURL: "http://127.0.0.1/redirected.png" } }),
    );
    makeResult("https://image.tmdb.org/t/p/w500/x.jpg");

    const result = await handler({ data: {} });
    // 白名单域名（非豆瓣，无防盗链）允许作为 <img src> 回落到原始 URL，但绝不能是 data URL / 内网地址
    expect(result.items[0].poster).toBe("https://image.tmdb.org/t/p/w500/x.jpg");
    expect(result.items[0].poster).not.toMatch(/^data:/);
  });
});

describe("B1-7：海报体积上限", () => {
  it("超过上限的图片被跳过（不 base64 化、不缓存）", async () => {
    const { handler } = await loadModule();
    mocks.isolatedAxios.get.mockResolvedValue(makeImageResponse(5 * 1024 * 1024 + 1));
    makeResult("https://image.tmdb.org/t/p/original/x.jpg");

    const result = await handler({ data: {} });
    expect(result.items[0].poster).toBe("https://image.tmdb.org/t/p/original/x.jpg");
    expect(result.items[0].poster).not.toMatch(/^data:/);
    const messages = mocks.logger.mock.calls.map(([item]: any[]) => String(item?.msg ?? ""));
    expect(messages.some((msg: string) => msg.includes("oversized recommendation poster"))).toBe(true);
  });

  it("体积合法的图片正常返回", async () => {
    const { handler } = await loadModule();
    mocks.isolatedAxios.get.mockResolvedValue(makeImageResponse(2048));
    makeResult("https://image.tmdb.org/t/p/w500/x.jpg");

    const result = await handler({ data: {} });
    expect(result.items[0].poster).toMatch(/^data:image\//);
  });
});

/**
 * 复检 RB-4：自定义 PtGen（含图片反代）的海报来自自建图床时，
 * 「不抓取」（SSRF 防护不变）但也不应把 poster 置 undefined（否则整个推荐海报消失）。
 */
describe("RB-4：非白名单 https 海报原样透传（不抓取）", () => {
  it("自建图床的 https 海报：不发起请求，URL 原样回传给 options", async () => {
    const { handler } = await loadModule();
    makeResult("https://img.example.com/poster/abc.jpg");

    const result = await handler({ data: {} });

    expect(mocks.isolatedAxios.get).not.toHaveBeenCalled();
    expect(result.items[0].poster).toBe("https://img.example.com/poster/abc.jpg");
  });

  it("社交信息（自定义 PtGen）返回的 https 海报同样透传", async () => {
    const { handler } = await loadModule();
    mocks.getSocialInformation.mockResolvedValue({
      site: "douban",
      id: "1",
      title: "t",
      poster: "https://my-ptgen.example/pic/abc.jpg",
    });
    makeResult(undefined);

    const result = await handler({ data: {} });

    expect(mocks.isolatedAxios.get).not.toHaveBeenCalled();
    expect(result.items[0].poster).toBe("https://my-ptgen.example/pic/abc.jpg");
  });

  it("纯策略函数：仅 https 且非豆瓣图床才透传", async () => {
    const { mod } = await loadModule();

    expect(mod.pickPassThroughPosterUrl("https://img.example.com/p.jpg")).toBe("https://img.example.com/p.jpg");
    expect(mod.pickPassThroughPosterUrl(undefined, "https://ptgen.example.com/p.jpg")).toBe(
      "https://ptgen.example.com/p.jpg",
    );
    expect(mod.pickPassThroughPosterUrl("http://img.example.com/p.jpg")).toBeUndefined();
    expect(mod.pickPassThroughPosterUrl("data:image/png;base64,AAAA")).toBeUndefined();
    // 豆瓣图床有防盗链，必须抓到 data URL；抓不到就丢弃
    expect(mod.pickPassThroughPosterUrl("https://img1.doubanio.com/view/photo/l/public/p1.jpg")).toBeUndefined();
    expect(mod.pickPassThroughPosterUrl(`https://img.example.com/${"a".repeat(3000)}.jpg`)).toBeUndefined();
  });

  it("http（非 https）的内网/任意地址仍被丢弃", async () => {
    const { handler } = await loadModule();
    makeResult("http://img.example.com/poster.jpg");

    const result = await handler({ data: {} });

    expect(mocks.isolatedAxios.get).not.toHaveBeenCalled();
    expect(result.items[0].poster).toBeUndefined();
  });
});
