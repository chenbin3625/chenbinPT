/**
 * M-32：manifest 的 icons 含 null 等非对象条目时，不能中止整个图标收集。
 *
 * 旧实现在 forEach 的参数里直接解构 `({ sizes, src }) => …`，`[null]` 会在进入函数体前抛 TypeError，
 * 于是第 1 步已收集的 <link rel=icon> 一起作废，最终回落 NO_IMAGE（A-19 想避免的正是这个）。
 */
import { describe, expect, it, vi } from "vitest";

const axiosGet = vi.hoisted(() => vi.fn());
vi.mock("axios", () => ({ default: { get: axiosGet } }));
vi.mock("@ptd/site/utils/adapter.ts", () => ({ logMessage: vi.fn() }));
vi.stubGlobal("__RESOURCE_SITE_ICONS__", []);

const { getFavicon, NO_IMAGE } = await import("@ptd/site/utils/favicon.ts");

describe("getFavicon：manifest 中的坏条目（M-32）", () => {
  it("icons 含 null 时仍使用 <link rel=icon> 收集到的图标", async () => {
    const page = new DOMParser().parseFromString(
      `<html><head><link rel="icon" href="https://pt.example/icon.png"><link rel="manifest" href="https://pt.example/manifest.json"></head></html>`,
      "text/html",
    );
    const png = new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" });
    axiosGet.mockImplementation(async (url: string) => {
      if (url === "https://pt.example/") return { data: page };
      if (url === "https://pt.example/manifest.json") return { data: { icons: [null, { src: "", sizes: "1x1" }] } };
      if (url === "/favicon.ico") throw new Error("404");
      if (url === "https://pt.example/icon.png") return { data: png };
      throw new Error(`unexpected ${url}`);
    });

    const favicon = await getFavicon({ id: "pt", urls: ["https://pt.example/"] } as any);

    expect(favicon).not.toBe(NO_IMAGE);
    expect(favicon.startsWith("data:image/png")).toBe(true);
  });
});
