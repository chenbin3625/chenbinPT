/**
 * C2 修复回归：媒体服务器实体契约与 fnOS 并发/缓存。
 *
 * - C2-M-1：Plex `ping()` 必须 resolve false，而不是 reject（与 emby/jellyfin/fnos 一致）
 * - C2-M-2：Plex 非 401 失败落 `parseError`（而不是 unknownError）
 * - C2-M-3：fnOS movie 跳转链接优先用影片主键 item.Id，而不是封面图 tag
 * - C2-M-4：fnOS 并发登录单飞（并发 401 只发一次 AuthenticateByName）
 * - C2-M-5：fnOS 海报缓存按条目数 + 字节预算淘汰（evictCaches 无生产调用点，已在复检中删除死代码）
 */
import axios, { AxiosError } from "axios";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@ptd/site/utils/adapter.ts", () => ({ logMessage: vi.fn() }));

import Plex from "@ptd/mediaServer/entity/plex.ts";
import FnOS from "@ptd/mediaServer/entity/fnos.ts";
import { EResultParseStatus } from "@ptd/site";

const PlexCtor = Plex as unknown as new (config: any) => Plex;
const FnOSCtor = FnOS as unknown as new (config: any) => FnOS;

const plexConfig = () => ({
  id: "plex-1",
  type: "plex",
  name: "Plex",
  address: "https://plex.example",
  auth: { apikey: "token" },
  timeout: 5000,
});

const fnosConfig = () => ({
  id: "fnos-1",
  type: "fnos",
  name: "fnOS",
  address: "https://fnos.example",
  auth: { username: "user", password: "password", parentId: "", apikey: "", userId: "", sessionId: "" },
  timeout: 5000,
});

function axiosErrorWithStatus(status: number): AxiosError {
  return new AxiosError(`Request failed with status code ${status}`, "ERR_BAD_REQUEST", undefined, undefined, {
    status,
    statusText: status === 401 ? "Unauthorized" : "Error",
    headers: {},
    config: {} as any,
    data: {},
  });
}

beforeEach(() => {
  vi.stubGlobal("__EXT_VERSION__", "v0.0.0");
  (FnOS as any).sessionCache.clear();
  (FnOS as any).posterUrlCache.clear();
  (FnOS as any).posterUrlCacheBytes = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("C2-M-1 / C2-M-2：Plex 契约", () => {
  it("ping 在请求失败时 resolve(false) 而不是 reject", async () => {
    const client = new PlexCtor(plexConfig());
    (client as any).request = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

    await expect(client.ping()).resolves.toBe(false);
  });

  it("非 401 的搜索失败落 parseError 并保留 errorMessage", async () => {
    const client = new PlexCtor(plexConfig());
    (client as any).getServerIdentity = vi.fn().mockResolvedValue("machine-1");
    (client as any).request = vi.fn().mockRejectedValue(new Error("timeout of 5000ms exceeded"));

    const result = await client.getSearchResult("matrix");

    expect(result.status).toBe(EResultParseStatus.parseError);
    expect(result.errorMessage).toContain("timeout of 5000ms exceeded");
    expect(result.items).toEqual([]);
  });

  it("401 的搜索失败仍映射为 needLogin", async () => {
    const client = new PlexCtor(plexConfig());
    (client as any).getServerIdentity = vi.fn().mockResolvedValue("machine-1");
    (client as any).request = vi.fn().mockRejectedValue(axiosErrorWithStatus(401));

    const result = await client.getSearchResult("matrix");

    expect(result.status).toBe(EResultParseStatus.needLogin);
  });
});

describe("C2-M-3：fnOS 影片链接主键", () => {
  it("movie 链接使用 item.Id，而不是 ImageTags.Primary", () => {
    const client = new FnOSCtor(fnosConfig());

    const url = (client as any).getItemUrl({
      Id: "movie-guid",
      Type: "Movie",
      Name: "test",
      ImageTags: { Primary: "image-tag-hash" },
    });

    expect(url).toContain("/v/movie/movie-guid");
    expect(url).not.toContain("image-tag-hash");
  });

  it("Series 链接继续使用 item.Id", () => {
    const client = new FnOSCtor(fnosConfig());
    expect((client as any).getItemUrl({ Id: "series-guid", Type: "Series", Name: "s" })).toContain("/v/tv/series-guid");
  });
});

describe("C2-M-4：fnOS 登录单飞", () => {
  it("并发登录（含 force）只发一次 AuthenticateByName", async () => {
    const client = new FnOSCtor(fnosConfig());
    let callCount = 0;
    vi.spyOn(axios, "request").mockImplementation(async () => {
      callCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return {
        data: { AccessToken: "access-token", User: { Id: "user-id" }, SessionInfo: { Id: "session-id" } },
      } as any;
    });

    const results = await Promise.all([
      (client as any).login(true),
      (client as any).login(true),
      (client as any).login(),
    ]);

    expect(callCount).toBe(1);
    expect(results[0]).toEqual({ apikey: "access-token", userId: "user-id", sessionId: "session-id" });
    expect((FnOS as any).sessionCache.size).toBe(1);
  });
});

describe("C2-M-5：fnOS 静态缓存回收", () => {
  it("条目数超过上限时按 FIFO 淘汰", () => {
    const client = new FnOSCtor(fnosConfig());
    const maxEntries = (FnOS as any).POSTER_CACHE_MAX_ENTRIES as number;

    for (let i = 0; i < maxEntries + 5; i++) {
      (client as any).setPosterCache(`key-${i}`, "x");
    }

    expect((FnOS as any).posterUrlCache.size).toBeLessThanOrEqual(maxEntries);
  });

  it("字节预算超限时继续淘汰（不只看条目数）", () => {
    const client = new FnOSCtor(fnosConfig());
    const maxBytes = (FnOS as any).POSTER_CACHE_MAX_BYTES as number;
    // 每张海报 2MB 字符 ≈ 4MB（UTF-16），两张即超过 8MB 预算
    const poster = "a".repeat(2 * 1024 * 1024);

    (client as any).setPosterCache("big-1", poster);
    (client as any).setPosterCache("big-2", poster);
    (client as any).setPosterCache("big-3", poster);

    expect((FnOS as any).posterUrlCache.size).toBeLessThanOrEqual(Math.floor(maxBytes / (poster.length * 2)));
    expect((FnOS as any).posterUrlCacheBytes).toBeLessThanOrEqual(maxBytes);
  });
});
