/**
 * M-32：manifest 的 icons 含 null 等非对象条目时，不能中止整个图标收集。
 *
 * 旧实现在 forEach 的参数里直接解构 `({ sizes, src }) => …`，`[null]` 会在进入函数体前抛 TypeError，
 * 于是第 1 步已收集的 <link rel=icon> 一起作废，最终回落 NO_IMAGE（A-19 想避免的正是这个）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock("@ptd/site/utils/adapter.ts", () => ({ logMessage: vi.fn() }));
vi.stubGlobal("__RESOURCE_SITE_ICONS__", []);
vi.stubGlobal("fetch", fetchMock);

const { getFavicon, NO_IMAGE } = await import("@ptd/site/utils/favicon.ts");

function response(
  data: Document | Blob | object,
  options: { url?: string; ok?: boolean; status?: number } = {},
): Response {
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    // 真实 fetch 的 response.url 在跟随重定向后是**最终**地址；favicon 用它校验可信 host、
    // 并作为相对图标/manifest 的解析基址（L-3 回归）。
    url: options.url ?? "",
    text: async () => (data as Document).documentElement.outerHTML,
    json: async () => data,
    blob: async () => data as Blob,
  } as Response;
}

describe("getFavicon：manifest 中的坏条目（M-32）", () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it("icons 含 null 时仍使用 <link rel=icon> 收集到的图标", async () => {
    const page = new DOMParser().parseFromString(
      `<html><head><link rel="icon" href="https://pt.example/icon.png"><link rel="manifest" href="https://pt.example/manifest.json"></head></html>`,
      "text/html",
    );
    const png = new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" });
    fetchMock.mockImplementation(async (url: string) => {
      if (url === "https://pt.example/") return response(page);
      if (url === "https://pt.example/manifest.json") return response({ icons: [null, { src: "", sizes: "1x1" }] });
      if (url === "https://pt.example/favicon.ico") throw new Error("404");
      if (url === "https://pt.example/icon.png") return response(png);
      throw new Error(`unexpected ${url}`);
    });

    const favicon = await getFavicon({ id: "pt", urls: ["https://pt.example/"] } as any);

    expect(favicon).not.toBe(NO_IMAGE);
    expect(favicon.startsWith("data:image/png")).toBe(true);
  });

  it("manifest 请求失败仍使用页面已有的 icon", async () => {
    const page = new DOMParser().parseFromString(
      `<head><link rel="icon" href="/icon.png"><link rel="manifest" href="/manifest.json"></head>`,
      "text/html",
    );
    const png = new Blob(["png"], { type: "image/png" });
    fetchMock.mockImplementation(async (url: string) => {
      if (url === "https://pt.example/") return response(page);
      if (url === "https://pt.example/manifest.json") throw new Error("offline");
      if (url === "https://pt.example/favicon.ico") throw new Error("404");
      if (url === "https://pt.example/icon.png") return response(png);
      throw new Error(`unexpected ${url}`);
    });

    expect(await getFavicon({ id: "pt", urls: ["https://pt.example/"] } as any)).toMatch(/^data:image\/png/);
    expect(fetchMock).toHaveBeenCalledWith("https://pt.example/icon.png", {
      credentials: "same-origin",
      redirect: "follow",
    });
  });

  it("manifest 的相对 src 按 manifest 目录解析；跨站候选不发请求", async () => {
    const page = new DOMParser().parseFromString(
      `<head><link rel="icon" href="https://evil.example/icon.png">
       <link rel="manifest" href="/assets/site.webmanifest">
       <link rel="apple-touch-icon" href="javascript:alert(1)"></head>`,
      "text/html",
    );
    const png = new Blob(["png"], { type: "image/png" });
    fetchMock.mockImplementation(async (url: string) => {
      if (url === "https://pt.example/") return response(page);
      if (url === "https://pt.example/assets/site.webmanifest")
        return response({
          icons: [
            { src: "https://evil.example/other.png", sizes: "32x32" },
            { src: "//evil.example/protocol.png", sizes: "32x32" },
            { src: "icons/valid.png", sizes: "48x48" },
          ],
        });
      if (url === "https://pt.example/favicon.ico") throw new Error("404");
      if (url === "https://pt.example/assets/icons/valid.png") return response(png);
      throw new Error(`unexpected ${url}`);
    });

    expect(await getFavicon({ id: "pt", urls: ["https://pt.example/"] } as any)).toMatch(/^data:image\/png/);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://pt.example/",
      "https://pt.example/assets/site.webmanifest",
      "https://pt.example/favicon.ico",
      "https://pt.example/assets/icons/valid.png",
    ]);
  });

  it("跨站 manifest 与 metadata icon 均不得被盲 GET", async () => {
    const page = new DOMParser().parseFromString(
      `<head><link rel="manifest" href="https://evil.example/manifest.json">
       <link rel="icon" href="https://pt.example.evil.test/icon.png"></head>`,
      "text/html",
    );
    fetchMock.mockImplementation(async (url: string) => {
      if (url === "https://pt.example/") return response(page);
      if (url === "https://pt.example/favicon.ico") throw new Error("404");
      throw new Error(`unexpected ${url}`);
    });

    expect(
      await getFavicon({
        id: "pt",
        urls: ["https://pt.example/"],
        favicon: "https://evil.example/config.png",
      } as any),
    ).toBe(NO_IMAGE);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["https://pt.example/", "https://pt.example/favicon.ico"]);
  });

  it("metadata icon 请求失败后仍能从首页取图标", async () => {
    const png = new Blob(["png"], { type: "image/png" });
    const page = new DOMParser().parseFromString(`<head><link rel="icon" href="/safe.png"></head>`, "text/html");
    fetchMock.mockImplementation(async (url: string) => {
      if (url === "https://pt.example/config.png") throw new TypeError("Redirect is not allowed");
      if (url === "https://pt.example/") return response(page);
      if (url === "https://pt.example/favicon.ico") throw new Error("404");
      if (url === "https://pt.example/safe.png") return response(png);
      throw new Error(`unexpected ${url}`);
    });

    expect(
      await getFavicon({ id: "pt", urls: ["https://pt.example/"], favicon: "https://pt.example/config.png" }),
    ).toMatch(/^data:image\/png/);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://pt.example/config.png",
      "https://pt.example/",
      "https://pt.example/favicon.ico",
      "https://pt.example/safe.png",
    ]);
  });

  it("首页请求失败时尝试下一个站点地址", async () => {
    const png = new Blob(["png"], { type: "image/png" });
    const page = new DOMParser().parseFromString(`<head><link rel="icon" href="/safe.png"></head>`, "text/html");
    fetchMock.mockImplementation(async (url: string) => {
      if (url === "https://pt.example/") throw new TypeError("Redirect is not allowed");
      if (url === "https://pt-backup.example/") return response(page);
      if (url === "https://pt-backup.example/favicon.ico") throw new Error("404");
      if (url === "https://pt-backup.example/safe.png") return response(png);
      throw new Error(`unexpected ${url}`);
    });

    expect(await getFavicon({ id: "pt", urls: ["https://pt.example/", "https://pt-backup.example/"] })).toMatch(
      /^data:image\/png/,
    );
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://pt.example/",
      "https://pt-backup.example/",
      "https://pt-backup.example/favicon.ico",
      "https://pt-backup.example/safe.png",
    ]);
  });

  it("manifest 与排名最靠前的候选请求失败时保留其他候选", async () => {
    const png = new Blob(["png"], { type: "image/png" });
    const page = new DOMParser().parseFromString(
      `<head><link rel="icon" href="/icon.png"><link rel="apple-touch-icon" href="/other.svg"><link rel="manifest" href="/manifest.json"></head>`,
      "text/html",
    );
    fetchMock.mockImplementation(async (url: string) => {
      if (url === "https://pt.example/") return response(page);
      if (url === "https://pt.example/manifest.json") throw new TypeError("Redirect is not allowed");
      if (url === "https://pt.example/favicon.ico") throw new Error("404");
      if (url === "https://pt.example/icon.png") throw new TypeError("Redirect is not allowed");
      if (url === "https://pt.example/other.svg") return response(png);
      throw new Error(`unexpected ${url}`);
    });

    expect(await getFavicon({ id: "pt", urls: ["https://pt.example/"] })).toMatch(/^data:image\/png/);
    // N4：svg 现在排在 png 之前（同一 source 下 svg 优先级更高），所以先尝试 other.svg 并成功
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://pt.example/",
      "https://pt.example/manifest.json",
      "https://pt.example/favicon.ico",
      "https://pt.example/other.svg",
    ]);
  });

  it("N4：同时存在 /favicon.ico 与 manifest 大图时，优先使用 manifest 的图标", async () => {
    const ico = new Blob(["ico"], { type: "image/x-icon" });
    const bigPng = new Blob(["big"], { type: "image/png" });
    const page = new DOMParser().parseFromString(
      `<head><link rel="manifest" href="/site.webmanifest"></head>`,
      "text/html",
    );
    fetchMock.mockImplementation(async (url: string) => {
      if (url === "https://pt.example/") return response(page);
      if (url === "https://pt.example/site.webmanifest")
        return response({ icons: [{ src: "/icons/512.png", sizes: "512x512", type: "image/png" }] });
      if (url === "https://pt.example/favicon.ico") return response(ico);
      if (url === "https://pt.example/icons/512.png") return response(bigPng);
      throw new Error(`unexpected ${url}`);
    });

    const favicon = await getFavicon({ id: "pt", urls: ["https://pt.example/"] });
    // favicon.ico 的 base64 前缀是 data:image/x-icon，manifest PNG 是 data:image/png
    expect(favicon.startsWith("data:image/png")).toBe(true);
  });

  it("E21：link 图标返回非图片（200 登录页/HTML）时跳过并尝试下一个候选", async () => {
    const html = new Blob(["<html>login</html>"], { type: "text/html" });
    const png = new Blob(["png"], { type: "image/png" });
    const page = new DOMParser().parseFromString(
      `<head><link rel="icon" href="/icon.png"><link rel="apple-touch-icon" href="/real.png"></head>`,
      "text/html",
    );
    fetchMock.mockImplementation(async (url: string) => {
      if (url === "https://pt.example/") return response(page);
      if (url === "https://pt.example/favicon.ico") throw new Error("404");
      if (url === "https://pt.example/icon.png") return response(html);
      if (url === "https://pt.example/real.png") return response(png);
      throw new Error(`unexpected ${url}`);
    });

    expect(await getFavicon({ id: "pt", urls: ["https://pt.example/"] })).toMatch(/^data:image\/png/);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://pt.example/",
      "https://pt.example/favicon.ico",
      "https://pt.example/icon.png",
      "https://pt.example/real.png",
    ]);
  });

  it("E21：metadata 声明的 favicon 返回非图片时回落到首页解析", async () => {
    const html = new Blob(["<html>login</html>"], { type: "text/html" });
    const png = new Blob(["png"], { type: "image/png" });
    const page = new DOMParser().parseFromString(`<head><link rel="icon" href="/safe.png"></head>`, "text/html");
    fetchMock.mockImplementation(async (url: string) => {
      if (url === "https://pt.example/config.png") return response(html);
      if (url === "https://pt.example/") return response(page);
      if (url === "https://pt.example/favicon.ico") throw new Error("404");
      if (url === "https://pt.example/safe.png") return response(png);
      throw new Error(`unexpected ${url}`);
    });

    expect(
      await getFavicon({ id: "pt", urls: ["https://pt.example/"], favicon: "https://pt.example/config.png" }),
    ).toMatch(/^data:image\/png/);
  });

  it("L-3：所有图标请求使用 follow + same-origin 选项；请求失败时回落 NO_IMAGE", async () => {
    const page = new DOMParser().parseFromString("<head></head>", "text/html");
    fetchMock.mockImplementation(async (url: string) => {
      if (url === "https://pt.example/") return response(page);
      if (url === "https://pt.example/favicon.ico") throw new TypeError("Redirect is not allowed");
      throw new Error(`unexpected ${url}`);
    });

    expect(await getFavicon({ id: "pt", urls: ["https://pt.example/"] })).toBe(NO_IMAGE);
    expect(fetchMock.mock.calls.map(([, init]) => init)).toEqual([
      { credentials: "same-origin", redirect: "follow" },
      { credentials: "same-origin", redirect: "follow" },
    ]);
  });

  it("L-3：重定向到可信子域后按最终地址解析相对图标（不再直接回落 NO_IMAGE）", async () => {
    const png = new Blob(["png"], { type: "image/png" });
    const page = new DOMParser().parseFromString(`<head><link rel="icon" href="/icon.png"></head>`, "text/html");
    fetchMock.mockImplementation(async (url: string) => {
      // 入口 URL 301 到静态子域：最终 URL 落在可信子域内，允许继续
      if (url === "https://pt.example/") return response(page, { url: "https://cdn.pt.example/" });
      if (url === "https://cdn.pt.example/favicon.ico") throw new Error("404");
      // 相对 href 必须按最终页面地址（cdn.pt.example）解析
      if (url === "https://cdn.pt.example/icon.png") return response(png);
      throw new Error(`unexpected ${url}`);
    });

    expect(await getFavicon({ id: "pt", urls: ["https://pt.example/"] })).toMatch(/^data:image\/png/);
    expect(fetchMock.mock.calls.map(([url]) => url)).toContain("https://cdn.pt.example/icon.png");
  });

  it("L-3：重定向到外站时丢弃响应（不解析外站页面、不使用外站图标）", async () => {
    const png = new Blob(["png"], { type: "image/png" });
    const evilPage = new DOMParser().parseFromString(
      `<head><link rel="icon" href="https://evil.example/icon.png"></head>`,
      "text/html",
    );
    fetchMock.mockImplementation(async (url: string) => {
      if (url === "https://pt.example/") return response(evilPage, { url: "https://evil.example/" });
      if (url === "https://pt.example/favicon.ico") throw new Error("404");
      if (url === "https://evil.example/icon.png") return response(png);
      throw new Error(`unexpected ${url}`);
    });

    expect(await getFavicon({ id: "pt", urls: ["https://pt.example/"] })).toBe(NO_IMAGE);
    // 外站页面不会被解析、外站图标不会被请求
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["https://pt.example/"]);
  });

  it("L-3：子域图标候选按 isHostTrusted 规则放行", async () => {
    const png = new Blob(["png"], { type: "image/png" });
    const page = new DOMParser().parseFromString(
      `<head><link rel="icon" href="https://static.pt.example/icon.png"><link rel="manifest" href="/m.json"></head>`,
      "text/html",
    );
    fetchMock.mockImplementation(async (url: string) => {
      if (url === "https://pt.example/") return response(page);
      if (url === "https://pt.example/m.json") return response({ icons: [] });
      if (url === "https://pt.example/favicon.ico") throw new Error("404");
      if (url === "https://static.pt.example/icon.png") return response(png);
      throw new Error(`unexpected ${url}`);
    });

    expect(await getFavicon({ id: "pt", urls: ["https://pt.example/"] })).toMatch(/^data:image\/png/);
  });

  it("L-4：application/octet-stream 标注的图标按扩展名兜底接受", async () => {
    const ico = new Blob(["ico"], { type: "application/octet-stream" });
    const page = new DOMParser().parseFromString(`<head><link rel="icon" href="/icon.ico"></head>`, "text/html");
    fetchMock.mockImplementation(async (url: string) => {
      if (url === "https://pt.example/") return response(page);
      if (url === "https://pt.example/favicon.ico") throw new Error("404");
      if (url === "https://pt.example/icon.ico") return response(ico);
      throw new Error(`unexpected ${url}`);
    });

    // image/* 之外的 MIME 只有「无 MIME/通用二进制」才按扩展名兜底；octet-stream + .ico 属于可接受
    expect(await getFavicon({ id: "pt", urls: ["https://pt.example/"] })).toMatch(/^data:/);
    expect(await getFavicon({ id: "pt2", urls: ["https://pt.example/"] })).not.toBe(NO_IMAGE);
  });

  it("L-4：明确的非图片 MIME（text/html）仍被拒绝", async () => {
    const html = new Blob(["<html>login</html>"], { type: "text/html" });
    const page = new DOMParser().parseFromString(`<head><link rel="icon" href="/icon.ico"></head>`, "text/html");
    fetchMock.mockImplementation(async (url: string) => {
      if (url === "https://pt.example/") return response(page);
      if (url === "https://pt.example/favicon.ico") throw new Error("404");
      if (url === "https://pt.example/icon.ico") return response(html);
      throw new Error(`unexpected ${url}`);
    });

    expect(await getFavicon({ id: "pt", urls: ["https://pt.example/"] })).toBe(NO_IMAGE);
  });
});
