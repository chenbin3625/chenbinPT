/**
 * 上游 765480dd（MediaBrowser 基类 + 媒体库条目信息增强）的移植回归。
 *
 * - utils：分辨率 / 码率 / 观看进度 / 库根 / providerIds 归一化、概览累加器
 * - Emby / Jellyfin：结构化 mediaInfo、详情接口路由、演职人员头像走认证头（令牌不进入 URL）
 * - 概览：只做统计不抓海报；Plex 的 maxItems 是跨全部媒体库的总上限
 * - fnOS：概览按视图分页并在服务端只取 Movie/Series
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AxiosError } from "axios";

const axiosMock = vi.hoisted(() => ({
  request: vi.fn(),
}));

vi.mock("axios", async (importOriginal) => {
  const actual = await importOriginal<typeof import("axios")>();
  return { ...actual, default: { ...actual.default, request: axiosMock.request } };
});
vi.mock("@ptd/site/utils/adapter.ts", () => ({ logMessage: vi.fn() }));

import {
  createOverviewAccumulator,
  formatBitrate,
  getPlayedPercentage,
  getPlayedState,
  getResolutionLabel,
  getRootPath,
  normalizeLanguage,
  normalizeProviderIds,
  parseResolutionFromTitle,
} from "@ptd/mediaServer";
import Emby from "@ptd/mediaServer/entity/emby.ts";
import Jellyfin from "@ptd/mediaServer/entity/jellyfin.ts";
import Plex from "@ptd/mediaServer/entity/plex.ts";
import FnOS from "@ptd/mediaServer/entity/fnos.ts";

const EmbyCtor = Emby as unknown as new (config: any) => Emby;
const JellyfinCtor = Jellyfin as unknown as new (config: any) => Jellyfin;
const PlexCtor = Plex as unknown as new (config: any) => Plex;
const FnOSCtor = FnOS as unknown as new (config: any) => FnOS;

const poster = new Blob(["image"], { type: "image/png" });

const mediaBrowserConfig = (type: "emby" | "jellyfin", userId = "") => ({
  id: "media-1",
  type,
  name: type,
  address: "https://media.example",
  auth: { apikey: `private-${type}-token`, userId },
  timeout: 5000,
});

/** 一条带完整媒体流的 Emby/Jellyfin 条目 */
const embyItem = (overrides: Record<string, unknown> = {}) => ({
  Id: "item-1",
  Name: "Movie",
  ServerId: "server-1",
  MediaType: "Video",
  Container: "mkv",
  RunTimeTicks: 72_000_000_000, // 2h
  Size: 4_000_000_000,
  ProviderIds: { Imdb: "tt0000001", Tmdb: "123" },
  ProductionYear: 2020,
  MediaSources: [
    {
      Path: "/volume1/media/Movies/movie.mkv",
      Container: "mkv",
      Size: 4_000_000_000,
      Name: "movie",
      MediaStreams: [
        {
          Type: "Video",
          Codec: "hevc",
          DisplayTitle: "4K HEVC",
          Width: 3840,
          Height: 2160,
          BitRate: 20_000_000,
          VideoRangeType: "DolbyVision",
        },
        {
          Type: "Audio",
          Codec: "truehd",
          DisplayLanguage: "English",
          Channels: 8,
          ChannelLayout: "7.1",
          IsDefault: true,
        },
        { Type: "Audio", Codec: "aac", Language: "und", Channels: 2 },
        { Type: "Subtitle", Codec: "srt", Language: "chi", IsExternal: true },
      ],
    },
  ],
  UserData: { IsFavorite: true, PlayCount: 1, PlaybackPositionTicks: 36_000_000_000, Played: false },
  ...overrides,
});

beforeEach(() => {
  vi.stubGlobal("__EXT_VERSION__", "v0.0.0");
  axiosMock.request.mockReset();
  (FnOS as any).sessionCache.clear();
  (FnOS as any).posterUrlCache.clear();
  (FnOS as any).posterUrlCacheBytes = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("mediaServer utils", () => {
  it("分辨率：以短边为准，并优先采用服务器 DisplayTitle 的说法", () => {
    expect(getResolutionLabel(1920, 1080)).toBe("1080p");
    // 以短边为准：848×464 推算得到 464p —— 所以才优先采用服务器 DisplayTitle 的说法（见 parseResolutionFromTitle）
    expect(getResolutionLabel(848, 464)).toBe("464p");
    expect(getResolutionLabel(3840, 2160)).toBe("4K");
    expect(getResolutionLabel()).toBeUndefined();
    expect(parseResolutionFromTitle("480p H264")).toBe("480p");
    expect(parseResolutionFromTitle("4k HEVC")).toBe("4K");
    expect(parseResolutionFromTitle("HEVC")).toBeUndefined();
  });

  it("码率 / 语言 / 库根", () => {
    expect(formatBitrate(8_200_000)).toBe("8.2 Mbps");
    expect(formatBitrate(320_000)).toBe("320 kbps");
    expect(formatBitrate(0)).toBeUndefined();
    expect(normalizeLanguage("und")).toBeUndefined();
    expect(normalizeLanguage(" chi ")).toBe("chi");
    expect(getRootPath("/volume1/media/Movies/x.mkv")).toBe("/volume1/media");
    expect(getRootPath("E:\\Media\\Movies\\x.mkv")).toBe("E:/Media");
  });

  it("观看进度与观看状态（替代上游的 MDI 图标名）", () => {
    expect(getPlayedPercentage(50, 100)).toBe(50);
    expect(getPlayedPercentage(undefined, 100, true)).toBe(100);
    expect(getPlayedPercentage()).toBeUndefined();
    expect(getPlayedState(100)).toBe("played");
    expect(getPlayedState(30)).toBe("partial");
    expect(getPlayedState(undefined, true)).toBe("played");
    expect(getPlayedState(0)).toBe("unplayed");
  });

  it("providerIds 键名统一为小写别名", () => {
    expect(normalizeProviderIds({ Imdb: "tt1", TheMovieDb: "2", Tvdb: "", TheTVDB: "3" })).toEqual({
      imdb: "tt1",
      tmdb: "2",
      tvdb: "3",
    });
    expect(normalizeProviderIds({})).toBeUndefined();
  });

  it("概览累加器：按体积分组、统计观看与从未观看", () => {
    const acc = createOverviewAccumulator();
    expect(acc.build("m", false)).toBeUndefined();

    const base = { server: "m", url: "", raw: {} };
    acc.add({ ...base, name: "A", size: 10, format: "mkv", user: { playedPercentage: 100, playCount: 3 } } as any);
    acc.add({ ...base, name: "B", size: 30, format: "mkv", user: { playedPercentage: 0 } } as any);
    acc.add({ ...base, name: "C", size: 5, format: "mp4", user: { playedPercentage: 40 } } as any);

    const overview = acc.build("m", true)!;
    expect(overview.totalItems).toBe(3);
    expect(overview.totalSize).toBe(45);
    expect(overview.truncated).toBe(true);
    expect(overview.byContainer).toEqual([
      { key: "mkv", count: 2, size: 40 },
      { key: "mp4", count: 1, size: 5 },
    ]);
    expect(overview.watch).toEqual({ watched: 1, partial: 1, unwatched: 1, totalPlays: 3 });
    expect(overview.neverWatched.map((e) => e.name)).toEqual(["B"]);
  });
});

describe("MediaBrowser（Emby / Jellyfin）条目映射", () => {
  it("Emby 扩展 Fields 返回 500 时回退基础字段请求", async () => {
    const server = new EmbyCtor(mediaBrowserConfig("emby"));
    const item = embyItem();
    axiosMock.request
      .mockRejectedValueOnce(
        new AxiosError("Request failed with status code 500", "ERR_BAD_RESPONSE", undefined, undefined, {
          status: 500,
          statusText: "Internal Server Error",
          headers: {},
          config: {} as any,
          data: {},
        }),
      )
      .mockImplementationOnce(async (config: any) => {
        if (config.responseType === "blob") return { data: poster };
        expect(config.params.Fields).toBe(
          "BasicSyncInfo,Path,Status,ExternalUrls,CommunityRating,MediaSources,DisplayPreferences,Genres,DateCreated,Overview,ExtraIds",
        );
        return { status: 200, data: { Items: [item] } };
      });

    const result = await server.getSearchResult("movie");

    expect(result.items).toHaveLength(1);
    expect(axiosMock.request.mock.calls[0][0].params.Fields).toContain("MediaSourceCount");
    expect(axiosMock.request.mock.calls.slice(0, 2)).toHaveLength(2);
  });

  it("Jellyfin 搜索 500 时不回退到 Emby 的 Fields 参数", async () => {
    const server = new JellyfinCtor(mediaBrowserConfig("jellyfin"));
    axiosMock.request.mockRejectedValue(
      new AxiosError("Request failed with status code 500", "ERR_BAD_RESPONSE", undefined, undefined, {
        status: 500,
        statusText: "Internal Server Error",
        headers: {},
        config: {} as any,
        data: {},
      }),
    );

    const result = await server.getSearchResult("movie");

    expect(result.items).toEqual([]);
    expect(axiosMock.request).toHaveBeenCalledTimes(1);
  });

  it("Emby 搜索结果带结构化 mediaInfo / providerIds / 观看深度，海报仍是 data URL", async () => {
    const server = new EmbyCtor(mediaBrowserConfig("emby"));
    axiosMock.request.mockImplementation(async (config: any) => {
      if (config.url === "/Items") return { status: 200, data: { Items: [embyItem()] } };
      if (config.url === "/Items/item-1/Images/Primary") return { data: poster };
      throw new Error(`unexpected ${config.url}`);
    });

    const result = await server.getSearchResult("movie");
    const [item] = result.items;

    expect(item.id).toBe("item-1");
    expect(item.poster).toMatch(/^data:image\/png;base64,/);
    expect(item.mediaInfo?.video).toMatchObject({ resolution: "4K", codec: "hevc", videoRange: "DolbyVision" });
    expect(item.mediaInfo?.audio).toEqual([
      expect.objectContaining({ language: "English", channels: 8, isDefault: true }),
      expect.objectContaining({ language: undefined, codec: "aac" }),
    ]);
    expect(item.mediaInfo?.subtitle).toEqual([expect.objectContaining({ language: "chi", isExternal: true })]);
    expect(item.providerIds).toEqual({ imdb: "tt0000001", tmdb: "123" });
    expect(item.path).toBe("/volume1/media/Movies/movie.mkv");
    expect(item.user).toMatchObject({ IsFavorite: true, playCount: 1, playedPercentage: 50, playbackPosition: 3600 });

    // 列表请求带上轻量字段，但不要 People（重字段只在详情里要）
    const listRequest = axiosMock.request.mock.calls[0][0];
    expect(listRequest.params.Fields).toContain("ProviderIds");
    expect(listRequest.params.Fields).not.toContain("People");
  });

  it("Jellyfin 的标签链接使用 10.9+ 的 /web/#/list 路由（无 .html）", async () => {
    const server = new JellyfinCtor(mediaBrowserConfig("jellyfin"));
    axiosMock.request.mockImplementation(async (config: any) => {
      if (config.url === "/Items") {
        return { status: 200, data: { Items: [embyItem({ GenreItems: [{ Name: "Drama", Id: 7 }] })] } };
      }
      return { data: poster };
    });

    const [item] = (await server.getSearchResult()).items;
    // url-join 会把 `/web/#/` 归一成 `/web#/`（移植前就是这样，Jellyfin Web 两种写法都能打开）
    expect(item.tags?.[0].url).toBe("https://media.example/web#/list?genreId=7&serverId=server-1");
    expect(item.tags?.[0].url).not.toContain("list.html");
    expect(item.url).toBe("https://media.example/web#/details?id=item-1&serverId=server-1");
  });

  it.each([
    ["Emby 有 userId", "emby", "user-1", "/Users/user-1/Items/item-1"],
    ["Emby 无 userId 退回 /Items?Ids=", "emby", "", "/Items"],
    ["Jellyfin 统一走 /Items?ids=", "jellyfin", "user-1", "/Items"],
  ] as const)("详情接口路由：%s", async (_name, type, userId, expectedUrl) => {
    const Ctor = type === "emby" ? EmbyCtor : JellyfinCtor;
    const server = new Ctor(mediaBrowserConfig(type, userId));
    const detailItem = embyItem({ People: [{ Name: "Actor", Role: "Lead", Id: "person-1", PrimaryImageTag: "t1" }] });
    axiosMock.request.mockImplementation(async (config: any) => {
      if (config.responseType === "blob") return { data: poster };
      return { status: 200, data: expectedUrl === "/Items" ? { Items: [detailItem] } : detailItem };
    });

    const detail = await server.getItemDetail("item-1");

    const detailRequest = axiosMock.request.mock.calls[0][0];
    expect(detailRequest.url).toBe(expectedUrl);
    expect(JSON.stringify(detailRequest.params)).toContain("People");
    if (type === "jellyfin") expect(detailRequest.params).toMatchObject({ ids: "item-1", userId: "user-1" });

    // 详情不重新拉海报（沿用列表的）；演职人员头像带认证头拉成 data URL，令牌不进入 URL
    expect(detail?.poster).toBe("");
    expect(detail?.people?.[0]).toMatchObject({ name: "Actor", role: "Lead" });
    expect(detail?.people?.[0].imageUrl).toMatch(/^data:image\/png;base64,/);
    const imageRequest = axiosMock.request.mock.calls.find(([config]) => config.responseType === "blob")![0];
    expect(imageRequest.url).toBe("/Items/person-1/Images/Primary");
    expect(imageRequest.params).toMatchObject({ tag: "t1" });
    expect(`${imageRequest.url}${JSON.stringify(imageRequest.params)}`).not.toContain("private-");
  });

  it("概览：分页遍历并就地聚合，不抓海报；服务器总数正好等于上限时不算截断", async () => {
    const server = new EmbyCtor(mediaBrowserConfig("emby"));
    axiosMock.request.mockImplementation(async (config: any) => {
      const start = config.params.startIndex as number;
      const items = [0, 1].map((i) => embyItem({ Id: `item-${start + i}` }));
      return { status: 200, data: { Items: items, TotalRecordCount: 4 } };
    });

    const overview = await server.getLibraryOverview({ pageSize: 2, maxItems: 4 });

    expect(overview?.totalItems).toBe(4);
    expect(overview?.truncated).toBe(false);
    expect(overview?.byResolution[0]).toMatchObject({ key: "4K", count: 4 });
    expect(axiosMock.request.mock.calls.every(([config]) => config.responseType !== "blob")).toBe(true);
  });
});

describe("Plex", () => {
  const plexConfig = () => ({
    id: "plex-1",
    type: "plex",
    name: "Plex",
    address: "https://plex.example",
    auth: { apikey: "private-plex-token" },
    timeout: 5000,
  });

  it("ping 打需要鉴权的 /library/sections（/identity 免鉴权会假成功）", async () => {
    const client = new PlexCtor(plexConfig());
    (client as any).request = vi.fn(async () => ({ status: 200, data: { MediaContainer: { Directory: [] } } }));

    await expect(client.ping()).resolves.toBe(true);
    expect((client as any).request).toHaveBeenCalledWith("/library/sections");
  });

  it("概览的 maxItems 是跨全部媒体库的总上限（上游按单库计数）", async () => {
    const client = new PlexCtor(plexConfig());
    const request = vi.fn(async (url: string, config?: any) => {
      if (url === "/identity") return { data: { MediaContainer: { machineIdentifier: "machine-1" } } };
      if (url === "/library/sections") {
        return { data: { MediaContainer: { Directory: [{ key: "1" }, { key: "2" }, { key: "3" }] } } };
      }
      const start = config.params["X-Plex-Container-Start"] as number;
      const size = config.params["X-Plex-Container-Size"] as number;
      const Metadata = Array.from({ length: size }, (_, i) => ({
        key: `/library/metadata/${url}-${start + i}`,
        title: `t${start + i}`,
        type: "movie",
        Media: [{ container: "mkv", Part: [{ size: 1 }] }],
      }));
      return { data: { MediaContainer: { Metadata } } };
    });
    (client as any).request = request;

    const overview = await client.getLibraryOverview({ pageSize: 2, maxItems: 3 });

    expect(overview?.totalItems).toBe(3);
    expect(overview?.truncated).toBe(true);
    // 第一个库翻 2 页（2 + 1 条）后就达到总上限，不再去请求第 2、3 个库
    const sectionCalls = request.mock.calls.filter(([url]) => url.startsWith("/library/sections/"));
    expect(sectionCalls.map(([url]) => url)).toEqual(["/library/sections/1/all", "/library/sections/1/all"]);
  });

  it("详情：解析 Guid → providerIds，人物头像经 PMS 转码代理并以认证头拉取", async () => {
    const client = new PlexCtor(plexConfig());
    axiosMock.request.mockImplementation(async (config: any) => {
      if (config.url === "/identity") return { data: { MediaContainer: { machineIdentifier: "machine-1" } } };
      if (config.responseType === "blob") return { data: poster };
      return {
        status: 200,
        data: {
          MediaContainer: {
            Metadata: [
              {
                ratingKey: "42",
                key: "/library/metadata/42",
                title: "Movie",
                type: "movie",
                Guid: [{ id: "imdb://tt0000042" }, { id: "tmdb://4242" }, { id: "plex://movie/abc" }],
                Role: [{ tag: "Actor", role: "Lead", thumb: "https://metadata-static.plex.tv/a.jpg", tagKey: "p1" }],
              },
            ],
          },
        },
      };
    });

    const detail = await client.getItemDetail("42");

    expect(detail?.id).toBe("42");
    expect(detail?.providerIds).toEqual({ imdb: "tt0000042", tmdb: "4242" });
    expect(detail?.people?.[0]).toMatchObject({ name: "Actor", role: "Lead", type: "Role" });
    expect(detail?.people?.[0].imageUrl).toMatch(/^data:image\/png;base64,/);
    expect(detail?.people?.[0].url).toContain(encodeURIComponent("/library/people/p1"));

    const imageRequest = axiosMock.request.mock.calls.find(([config]) => config.responseType === "blob")![0];
    expect(imageRequest.url).toBe("/photo/:/transcode");
    expect(imageRequest.params.url).toBe("https://metadata-static.plex.tv/a.jpg");
    expect(imageRequest.params["X-Plex-Token"]).toBeUndefined();
    expect(imageRequest.headers["X-Plex-Token"]).toBe("private-plex-token");
  });
});

describe("fnOS 概览", () => {
  it("多视图也按页拉取，并在服务端只取 Movie/Series；不抓海报", async () => {
    const client = new FnOSCtor({
      id: "fnos-1",
      type: "fnos",
      name: "fnOS",
      address: "https://fnos.example",
      auth: { username: "user", password: "password", parentId: "", apikey: "token", userId: "user-1" },
      timeout: 5000,
    });
    (client as any).getViewIds = vi.fn(async () => ["view-a", "view-b"]);
    const request = vi.fn(async (_url: string, config: any) => {
      const { ParentId, StartIndex, Limit } = config.params;
      const total = ParentId === "view-a" ? 3 : 1;
      const Items = Array.from({ length: Math.max(0, Math.min(Limit, total - StartIndex)) }, (_, i) => ({
        Id: `${ParentId}-${StartIndex + i}`,
        Name: "x",
        Type: "Movie",
        MediaSources: [{ Size: 10 }],
      }));
      return { status: 200, data: { Items } };
    });
    (client as any).request = request;

    const overview = await client.getLibraryOverview({ pageSize: 2 });

    expect(overview?.totalItems).toBe(4);
    expect(overview?.totalSize).toBe(40);
    for (const [, config] of request.mock.calls) {
      expect(config.params.IncludeItemTypes).toBe("Movie,Series");
      expect(config.params.Limit).toBe(2);
      expect(config.responseType).not.toBe("blob");
    }
  });
});
