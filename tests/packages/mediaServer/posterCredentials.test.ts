import { describe, expect, it, vi } from "vitest";

const axiosMock = vi.hoisted(() => ({
  request: vi.fn(),
}));

vi.mock("axios", async (importOriginal) => {
  const actual = await importOriginal<typeof import("axios")>();
  return { ...actual, default: { ...actual.default, request: axiosMock.request } };
});

import Plex from "@ptd/mediaServer/entity/plex.ts";
import FnOS from "@ptd/mediaServer/entity/fnos.ts";
import Emby from "@ptd/mediaServer/entity/emby.ts";
import Jellyfin from "@ptd/mediaServer/entity/jellyfin.ts";

const poster = new Blob(["image"], { type: "image/png" });
const PlexCtor = Plex as unknown as new (config: any) => Plex;
const FnOSCtor = FnOS as unknown as new (config: any) => FnOS;
const EmbyCtor = Emby as unknown as new (config: any) => Emby;
const JellyfinCtor = Jellyfin as unknown as new (config: any) => Jellyfin;

describe("媒体海报令牌不进入 URL", () => {
  it("Plex 从认证头拉取海报并返回 Data URL", async () => {
    const client = new PlexCtor({
      id: "plex-1",
      type: "plex",
      name: "Plex",
      address: "https://plex.example",
      auth: { apikey: "private-plex-token" },
    });
    axiosMock.request.mockReset().mockResolvedValue({ data: poster });

    const url = await (client as any).getPoster("/library/metadata/1/thumb/1");

    expect(url).toMatch(/^data:image\/png;base64,/);
    const request = axiosMock.request.mock.calls[0][0];
    expect(request.url).toBe("/library/metadata/1/thumb/1");
    expect(JSON.stringify(request.url)).not.toContain("private-plex-token");
    expect(request.params?.["X-Plex-Token"]).toBeUndefined();
    expect(request.headers["X-Plex-Token"]).toBe("private-plex-token");
  });

  it("fnOS 海报 URL 不含 AccessToken，使用请求头拉取", async () => {
    const client = new FnOSCtor({
      id: "fnos-1",
      type: "fnos",
      name: "fnOS",
      address: "https://fnos.example",
      auth: { username: "user", password: "password" },
    });
    (client as any).login = vi.fn().mockResolvedValue({ apikey: "private-fnos-token", userId: "user-1" });
    (client as any).request = vi.fn().mockResolvedValue({ data: poster });

    const url = await (client as any).getPoster({ Id: "movie-1", ImageTags: { Primary: "tag-1" } });

    expect(url).toMatch(/^data:image\/png;base64,/);
    const [path, config] = (client as any).request.mock.calls[0];
    expect(path).toBe("/Items/movie-1/Images/Primary");
    expect(config.params).toEqual({ tag: "tag-1" });
    expect(`${path}${JSON.stringify(config)}`).not.toContain("private-fnos-token");
  });

  it("Plex 搜索海报以有界并发抓取，而不是逐张串行等待", async () => {
    const client = new PlexCtor({
      id: "plex-1",
      type: "plex",
      name: "Plex",
      address: "https://plex.example",
      auth: { apikey: "private-plex-token" },
    });
    (client as any).getServerIdentity = vi.fn(async () => "machine-1");
    let releasePosters!: () => void;
    const posterGate = new Promise<void>((resolve) => (releasePosters = resolve));
    const posterRequests: string[] = [];
    (client as any).request = vi.fn(async (url: string) => {
      if (url.startsWith("/library")) {
        return {
          data: {
            MediaContainer: {
              Metadata: [1, 2].map((id) => ({
                key: `/library/metadata/${id}`,
                title: `Movie ${id}`,
                type: "movie",
                thumb: `/thumb/${id}`,
                Genre: [],
              })),
            },
          },
        };
      }
      posterRequests.push(url);
      await posterGate;
      return { data: poster };
    });

    const pending = client.getSearchResult();
    try {
      await vi.waitFor(() => expect(posterRequests).toEqual(["/thumb/1", "/thumb/2"]), { timeout: 150 });
    } finally {
      releasePosters();
    }
    await pending;
  });

  it.each([
    ["Emby", EmbyCtor, "emby", "X-Emby-Token", "private-emby-token"],
    ["Jellyfin", JellyfinCtor, "jellyfin", "Authorization", 'MediaBrowser Token="private-jellyfin-token"'],
  ])("%s 通过认证头抓取受保护海报，失败时不影响搜索结果", async (_name, Ctor, type, header, expected) => {
    const server = new Ctor({
      id: "media-1",
      type,
      name: type,
      address: "https://media.example",
      auth: { apikey: type === "emby" ? "private-emby-token" : "private-jellyfin-token", userId: "" },
      timeout: 5000,
    });
    axiosMock.request.mockReset().mockImplementation(async (config: any) => {
      if (config.url === "/Items") {
        return {
          status: 200,
          data: {
            Items: ["one", "two"].map((Id) => ({
              Id,
              Name: Id,
              ServerId: "server",
              RunTimeTicks: 0,
              MediaType: "Movie",
            })),
          },
        };
      }
      if (config.url === "/Items/one/Images/Primary") return { data: poster };
      throw new Error("poster unavailable");
    });

    const result = await server.getSearchResult();
    expect(result.items).toHaveLength(2);
    expect(result.items[0].poster).toMatch(/^data:image\/png;base64,/);
    expect(result.items[1].poster).toBe("");
    const requests = axiosMock.request.mock.calls.map(([config]) => config);
    expect(requests.filter((request) => request.responseType === "blob")).toHaveLength(2);
    expect(requests[1].headers[header]).toBe(expected);
    expect(requests[1].url).not.toContain("private-");
    expect(requests[1].baseURL).not.toContain("private-");
  });
});
