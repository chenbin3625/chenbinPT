import urlJoin from "url-join";
import { toMerged } from "es-toolkit";

import axios, { AxiosError, AxiosRequestConfig, AxiosResponse } from "axios";
import { EResultParseStatus } from "@ptd/site";
import { mapWithConcurrency } from "@ptd/site/utils/helper.ts";
import {
  AbstractMediaServer,
  IMediaServerBaseConfig,
  IMediaServerItem,
  IMediaServerMetadata,
  IMediaServerOverview,
  IMediaServerOverviewOptions,
  IMediaServerSearchOptions,
  IMediaServerSearchResult,
} from "../types";
import { blobToDataUrl, createOverviewAccumulator, getResolutionLabel, normalizeLanguage } from "../utils.ts";

export const mediaServerMetaData: IMediaServerMetadata = {
  description: "Plex 是一款流行的媒体服务器软件，支持多种设备和平台，提供丰富的媒体管理和播放功能",
  warning: ["apikey 可通过在console面板中查看 localStorage 中的 myPlexAccessToken 值"],
  auth_field: ["apikey"],
} as const;

interface IPlexConfig extends IMediaServerBaseConfig {
  type: "plex";
  auth: {
    apikey: string;
  };
}

export const mediaServerConfig: IPlexConfig = {
  type: "plex",
  name: "Plex",
  address: "",
  auth: {
    apikey: "",
  },
  timeout: 5000,
};

interface IPlexJsonResponse<T = any> {
  MediaContainer: T;
  error?: string;
  code?: number;
  message?: string;
}

interface IPlexIdentityData {
  apiVersion: string;
  claimed: boolean;
  machineIdentifier: string;
  size: number;
  version: string;
}

interface IPlexSearchItem {
  addedAt: number;
  allowSync: boolean;
  type: "movie" | "show" | "season" | "episode";

  key: string;
  title: string;
  summary: string;
  thumb: string;

  librarySectionID: number;
  librarySectionTitle: string;
  librarySectionUUID: string;

  Genre: Array<{ tag: string }>;

  Media?: Array<{
    Part: Array<{
      container: string;
      duration: number;
      file: string;
      hasThumbnail: boolean;
      id: number;
      key: string;
      size: number;
      /** 媒体流明细（video / audio / subtitle） */
      Stream?: Array<{
        streamType: number; // 1=Video 2=Audio 3=Subtitle
        codec?: string;
        language?: string;
        languageCode?: string;
        displayTitle?: string;
        title?: string;
        channels?: number;
        audioChannelLayout?: string;
        width?: number;
        height?: number;
        bitrate?: number;
        frameRate?: string;
        profile?: string;
        /** 色彩转移特性：smpte2084=HDR10 / arib-std-b67=HLG */
        colorTrc?: string;
        /** 杜比视界 */
        doviPresent?: boolean;
        /** 外挂字幕会带 key */
        key?: string;
        selected?: boolean;
      }>;
    }>;
    aspectRatio: number;
    audioChannels: number;
    audioCodec: string;
    bitrate: number;
    container: string;
    duration: number;
    height: number;
    id: number;
    videoCodec: string;
    videoFrameRate: string;
    videoProfile: string;
    videoResolution: string;
    width: number;
  }>;

  audienceRating: number;
  duration: number;

  year: number;

  updatedAt: number;

  // —— 调研 A3–A6 / B7–B12 需要的字段 ——
  ratingKey?: string;
  /** 影评人评分（audienceRating 是观众评分） */
  rating?: number;
  /** 官方分级 */
  contentRating?: string;
  /** 制片公司 */
  studio?: string;
  tagline?: string;
  Label?: Array<{ tag: string }>;
  /** 外部标识：imdb://tt… / tmdb://… / tvdb://… */
  Guid?: Array<{ id: string }>;
  /** 最近观看时间（epoch 秒） */
  lastViewedAt?: number;
  /** 播放次数 */
  viewCount?: number;
  /** 已观看时长（毫秒） */
  viewOffset?: number;
  /** 集号 / 季号（剧集用） */
  index?: number;
  /** 剧集（show）维度字段：季/集条目上才有 */
  parentYear?: number;
  parentSummary?: string;
  parentThumb?: string;
  parentStudio?: string;
  /** 集数 / 已看集数（Plex 用 leaf 表示可播放的最小单元） */
  leafCount?: number;
  viewedLeafCount?: number;
  parentIndex?: number;
  /** 演职人员（详情接口才有） */
  Role?: Array<{ tag: string; role?: string; thumb?: string; tagKey?: string }>;
  Director?: Array<{ tag: string; thumb?: string; tagKey?: string }>;
}

interface IPlexRecentlyAddedItem extends Omit<IPlexSearchItem, "Media"> {
  parentTitle?: string; // 父标题，可能是系列名称
}

interface IPlexSearchData<T = IPlexSearchItem> {
  Metadata: T[];
  identifier: string;
  mediaTagPrefix: string;
  offset?: number;
  size: number;
  totalSize?: number;
}

export default class Plex extends AbstractMediaServer<IPlexConfig> {
  /**
   * SERVERSSOCIAL-4（M-18 同根因）：锚定去掉 Plex 前端入口 `/web`（及其后的 index.html / hash 路由），
   * 得到真正的 API 根地址。旧正则要求 `#` 后至少还有一个字符，
   * 于是官方给出的 `http://ip:32400/web`、`/web/index.html`（无 hash）都不会被剥离：
   * apiBaseUrl 变成 `…/web`（/identity 打到 /web/identity → 404），webBaseUrl 还会拼成 `…/web/web/index.html`。
   */
  private get serverAddress(): string {
    return this.config.address
      .trim()
      .replace(/#.*$/, "")
      .replace(/\/+$/, "")
      .replace(/\/web(?:\/index\.html|\/web)?(?:\/.*)?$/i, "");
  }

  get apiBaseUrl(): string {
    return this.serverAddress;
  }

  get webBaseUrl(): string {
    return `${this.serverAddress}/web/index.html`;
  }

  protected async request<T = any, D = any>(
    url: string,
    config: AxiosRequestConfig<D> = {},
  ): Promise<AxiosResponse<T, D>> {
    config.baseURL = this.apiBaseUrl;
    config.url = url;
    config.timeout ??= this.config.timeout; // 未额外传入 timeout 时，使用默认的 timeout
    config.method ??= "GET"; // 默认使用 GET 方法

    // 令牌不能出现在 URL（含海报请求），否则会进入代理访问日志。
    config.headers = {
      ...(config.headers ?? {}),
      "X-Plex-Token": this.config.auth.apikey,
    };

    config.responseType ??= "json";
    return axios.request<T>(config);
  }

  /**
   * 带认证头拉取图片并转成 data URL：
   * - 服务器本地相对路径（`/library/metadata/…`）直接请求；
   * - **外部绝对地址**（人物头像常是 `https://metadata-static.plex.tv/…`）→ 浏览器直连会被拦，
   *   改由 PMS 的 `/photo/:/transcode?url=…` 代理，只与本机服务器通信（上游同款做法）。
   */
  private async getPoster(thumb?: string, transcodeSize?: { width: number; height: number }): Promise<string> {
    if (!thumb) return "";
    try {
      const isExternal = /^https?:\/\//i.test(thumb);
      const response =
        isExternal || transcodeSize
          ? await this.request<Blob>("/photo/:/transcode", {
              responseType: "blob",
              params: {
                url: thumb,
                width: transcodeSize?.width ?? 240,
                height: transcodeSize?.height ?? 320,
                minSize: 1,
                upscale: 1,
              },
            })
          : await this.request<Blob>(thumb, { responseType: "blob" });
      return await blobToDataUrl(response.data);
    } catch {
      return "";
    }
  }

  private async getServerIdentity(): Promise<string | undefined> {
    const response = await this.request<IPlexJsonResponse<IPlexIdentityData>>("/identity");
    return response.data?.MediaContainer?.machineIdentifier;
  }

  public override async ping(): Promise<boolean> {
    // 注意：/identity 是 Plex 的**免鉴权**发现端点，token 填错也可能返回 machineIdentifier，
    // 会让「检查」假成功、随后搜索才 401。这里打一个需要鉴权的库列表接口（上游同步修正）。
    // C2-M-1：`ping()` 的契约是 Promise<boolean>：网络不可达、超时、令牌失效等一律返回 false 而不是 reject。
    try {
      const response = await this.request<IPlexJsonResponse<{ Directory?: unknown[] }>>("/library/sections");
      return response.status === 200 && Array.isArray(response.data?.MediaContainer?.Directory);
    } catch {
      return false;
    }
  }

  /**
   * 把 Plex 的 Guid 列表解析成 providerIds。
   *
   * 只认 imdb / tmdb / tvdb（含老 agent 的 `com.plexapp.agents.imdb://tt…` 形式），
   * `plex://`、`local://`、`hama://` 这类非目标 provider 直接丢弃 —— 否则会污染
   * providerIds（例如出现一个 `plex` 键）并让站点跳转失效。
   */
  private parseProviderIds(guids?: Array<{ id: string }>): Record<string, string> | undefined {
    if (!guids?.length) return undefined;

    const patterns: Array<[string, RegExp]> = [
      ["imdb", /(?:^|\/|:)(?:com\.plexapp\.agents\.)?imdb:\/\/(tt\d+)/i],
      ["tmdb", /(?:themoviedb|tmdb):\/\/(\d+)/i],
      ["tvdb", /(?:thetvdb|tvdb):\/\/(\d+)/i],
    ];

    const providerIds: Record<string, string> = {};
    for (const guid of guids) {
      for (const [provider, pattern] of patterns) {
        const matched = guid.id?.match(pattern);
        if (matched && !providerIds[provider]) providerIds[provider] = matched[1];
      }
    }
    return Object.keys(providerIds).length > 0 ? providerIds : undefined;
  }

  /**
   * 演职人员（只取详情接口返回的 Role / Director，限制条数避免 UI 过长）。
   * 头像带认证头拉成 data URL（经 PMS 转码代理缩成小图），令牌不进入 URL。
   */
  private async parsePeople(item: IPlexSearchItem): Promise<IMediaServerItem["people"]> {
    const people = [
      ...(item.Role ?? []).map((person) => ({ ...person, type: "Role" })),
      ...(item.Director ?? []).map((person) => ({ ...person, role: undefined, type: "Director" })),
    ].slice(0, 12);
    if (people.length === 0) return undefined;

    return await mapWithConcurrency(people, 4, async (person) => {
      const imageUrl = await this.getPoster(person.thumb, { width: 240, height: 320 });
      return {
        name: person.tag,
        role: person.role,
        type: person.type,
        imageUrl: imageUrl || undefined,
        url: this.getPlexPersonWebUrl(person.tagKey),
      };
    });
  }

  /**
   * Plex 演员（人物）的页面地址。
   *
   * 人物不是普通 item，页面形式为
   * `{webBaseUrl}#!/provider/tv.plex.provider.discover/details?key=%2Flibrary%2Fpeople%2F{tagKey}`；
   * `tagKey` 缺失（旧刮削器 / 本地人物）时返回 undefined —— chip 变成不可点，而不是给一个死链。
   */
  private getPlexPersonWebUrl(tagKey?: string): string | undefined {
    if (!tagKey) return undefined;
    const key = encodeURIComponent(`/library/people/${tagKey}`);
    return `${this.webBaseUrl}#!/provider/tv.plex.provider.discover/details?key=${key}`;
  }

  /** 制片公司：季/集条目上通常只有 parentStudio */
  private getPlexStudios(item: IPlexSearchItem): string[] | undefined {
    const studio = item.studio ?? (item as IPlexRecentlyAddedItem).parentStudio;
    return studio ? [studio] : undefined;
  }

  private getPlexPlayedPercentage(item: IPlexSearchItem): number | undefined {
    // 季/剧集：列表里没有 UserData，但 viewedLeafCount/leafCount 就是已看集数占比
    if (item.leafCount && typeof item.viewedLeafCount === "number") {
      return Math.min(100, Math.round((item.viewedLeafCount / item.leafCount) * 100));
    }

    if ((item.viewCount ?? 0) > 0 && !item.viewOffset) return 100;
    if (!item.viewOffset || !item.duration) return item.viewCount ? 100 : undefined;
    return Math.min(100, Math.max(0, Math.round((item.viewOffset / item.duration) * 100)));
  }

  /** 条目 id：优先 ratingKey；没有时从 `key`（`/library/metadata/123[/children]`）里取末段数字 */
  private getPlexItemId(item: IPlexSearchItem | IPlexRecentlyAddedItem): string {
    if (item.ratingKey) return String(item.ratingKey);
    const key = item.key.replace(/\/children$/, "");
    return key.match(/\/library\/metadata\/([^/]+)$/)?.[1] ?? key;
  }

  /**
   * 调研 B12：详情弹窗按需拉取单条目（`/library/metadata/{ratingKey}`，这个接口带 `Stream[]` 与 `Role[]`）。
   * 拉不到时返回 undefined，UI 静默降级。不重新拉海报（调用方沿用列表条目的海报）。
   */
  public override async getItemDetail(itemId: string): Promise<IMediaServerItem<IPlexSearchItem> | undefined> {
    try {
      // includeGuids：让详情带上 imdb/tmdb 等外部标识（站点搜索按钮依赖它）
      const response = await this.request<IPlexJsonResponse<IPlexSearchData>>(
        `/library/metadata/${encodeURIComponent(itemId)}`,
        { params: { includeGuids: 1 } },
      );
      const item = response.data?.MediaContainer?.Metadata?.[0];
      if (response.status === 200 && item) {
        const mediaItem = this.buildPlexMediaItem(item, await this.getServerIdentity());
        mediaItem.people = await this.parsePeople(item);
        return mediaItem as IMediaServerItem<IPlexSearchItem>;
      }
    } catch (e) {
      // 忽略：详情拿不到就只展示列表已有的信息
    }
    return undefined;
  }

  /**
   * 调研 C14 / C20：**按需**生成媒体库概览。
   * 遍历 `/library/sections` 的每个媒体库并分页取条目，就地聚合后只回传统计结果；只做统计，所以不抓海报。
   *
   * `maxItems` 是**跨全部媒体库**的总上限（上游按单个媒体库计数，库多时会超出上限）。
   */
  public override async getLibraryOverview(
    options: IMediaServerOverviewOptions = {},
  ): Promise<IMediaServerOverview | undefined> {
    const pageSize = Math.max(1, Math.min(options.pageSize ?? 200, 500));
    const maxItems = Math.max(pageSize, options.maxItems ?? 20000);
    const accumulator = createOverviewAccumulator();
    const identity = await this.getServerIdentity();

    const sectionsResponse =
      await this.request<IPlexJsonResponse<{ Directory?: Array<{ key: string; type: string }> }>>("/library/sections");
    const sections = sectionsResponse.data?.MediaContainer?.Directory ?? [];

    let scanned = 0;
    let truncated = false;
    for (const section of sections) {
      if (truncated) break;

      let startIndex = 0;
      while (true) {
        if (scanned >= maxItems) {
          truncated = true;
          break;
        }
        const limit = Math.min(pageSize, maxItems - scanned);
        const response = await this.request<IPlexJsonResponse<IPlexSearchData>>(
          `/library/sections/${encodeURIComponent(section.key)}/all`,
          { params: { "X-Plex-Container-Start": startIndex, "X-Plex-Container-Size": limit, includeGuids: 1 } },
        );
        const metadata = response.data?.MediaContainer?.Metadata ?? [];
        if (metadata.length === 0) break;

        for (const item of metadata) {
          if (!["movie", "show", "season"].includes(item.type)) continue;
          if (scanned >= maxItems) {
            truncated = true;
            break;
          }
          accumulator.add(this.buildPlexMediaItem(item, identity));
          scanned += 1;
        }
        if (truncated) break;
        // 翻页按服务器返回的原始条数前进（被类型过滤掉的条目也占位）
        startIndex += metadata.length;

        if (metadata.length < limit) break;
      }
    }

    return accumulator.build(this.config.id!, truncated);
  }

  /**
   * 单条目映射：搜索结果、详情与概览共用同一套字段。
   * 纯同步映射（不发请求）：海报与演职人员头像由调用方按需补上。
   */
  private buildPlexMediaItem(
    item: IPlexSearchItem | IPlexRecentlyAddedItem,
    serverIdentity: string | undefined,
  ): IMediaServerItem<IPlexSearchItem | IPlexRecentlyAddedItem> {
    const media = (item as IPlexSearchItem).Media?.[0];
    const part = media?.Part?.[0];
    const streams = part?.Stream ?? [];
    const videoStream = streams.find((stream) => stream.streamType === 1);
    const hasStreams = streams.length > 0;
    const isPlayed = (item.viewCount ?? 0) > 0;
    const detailUrl = `${this.webBaseUrl}#!/server/${serverIdentity}/details?key=${encodeURIComponent(item.key.replace(/\/children$/, ""))}`;

    return {
      server: this.config.id!,
      id: this.getPlexItemId(item),
      // @ts-expect-error
      // 原因：SearchItem / RecentlyAddedItem 联合类型下 title 等字段可选，取值为 string | undefined，运行时由类型定义兜底
      name: item.parentTitle ? `${item.parentTitle} (${item.title})` : item.title,
      url: detailUrl,
      type: item.type.charAt(0).toUpperCase() + item.type.slice(1),
      description: item.summary || (item as IPlexRecentlyAddedItem).parentSummary || "",
      format: media?.container ?? "",
      size: part?.size ?? 0,
      duration: item.duration ?? 0,
      poster: "",
      tags: item.Genre?.map((tag) => ({ name: tag.tag, url: "" })) ?? [],
      rating: item.audienceRating ?? "-",
      streams: streams
        .filter((stream) => stream.streamType === 1 || stream.streamType === 2 || stream.streamType === 3)
        .map((stream) => ({
          title: stream.displayTitle ?? stream.title ?? stream.language ?? stream.codec ?? "",
          type: stream.streamType === 1 ? "Video" : stream.streamType === 2 ? "Audio" : "Subtitle",
          format: stream.codec ?? "",
        })),
      // 调研 A2：Plex 的流明细来自 Media[].Part[].Stream[]
      mediaInfo:
        hasStreams || media
          ? {
              video: videoStream
                ? {
                    width: videoStream.width ?? media?.width,
                    height: videoStream.height ?? media?.height,
                    resolution: media?.videoResolution
                      ? `${media.videoResolution}`.replace(/k$/i, "K").replace(/^(\d+)$/, "$1p")
                      : getResolutionLabel(videoStream.width ?? media?.width, videoStream.height ?? media?.height),
                    codec: videoStream.codec ?? media?.videoCodec,
                    profile: videoStream.profile ?? media?.videoProfile,
                    videoRange: videoStream.doviPresent
                      ? "DolbyVision"
                      : videoStream.colorTrc === "smpte2084"
                        ? "HDR10"
                        : videoStream.colorTrc === "arib-std-b67"
                          ? "HLG"
                          : undefined,
                    bitrate: videoStream.bitrate ?? media?.bitrate,
                    frameRate: videoStream.frameRate ? Number(videoStream.frameRate) : undefined,
                  }
                : undefined,
              audio: streams
                .filter((stream) => stream.streamType === 2)
                .map((stream) => ({
                  title: stream.displayTitle ?? stream.title,
                  codec: stream.codec,
                  language: normalizeLanguage(stream.language ?? stream.languageCode),
                  channels: stream.channels,
                  channelLayout: stream.audioChannelLayout,
                  isDefault: stream.selected,
                })),
              subtitle: streams
                .filter((stream) => stream.streamType === 3)
                .map((stream) => ({
                  title: stream.displayTitle ?? stream.title,
                  codec: stream.codec,
                  language: normalizeLanguage(stream.language ?? stream.languageCode),
                  isExternal: !!stream.key,
                  isDefault: stream.selected,
                })),
            }
          : undefined,
      // 调研 A3 / A4
      path: part?.file,
      dateCreated: item.addedAt ? new Date(item.addedAt * 1000).toISOString() : undefined,
      // 调研 A5：上游在这里放了一个指回本条目 Plex 页面的「Plex」链接，与「访问」按钮重复，这里不再生成
      // 调研 B7–B12
      providerIds: this.parseProviderIds(item.Guid),
      productionYear: item.year ?? (item as IPlexRecentlyAddedItem).parentYear,
      officialRating: item.contentRating,
      criticRating: item.rating,
      studios: this.getPlexStudios(item),
      mediaSourceCount: (item as IPlexSearchItem).Media?.length,
      seriesName: (item as IPlexRecentlyAddedItem).parentTitle,
      childCount: item.leafCount,
      recursiveItemCount: item.leafCount,
      indexNumber: item.type === "episode" ? item.index : undefined,
      parentIndexNumber: item.type === "episode" ? item.parentIndex : undefined,
      isHd: media?.videoResolution ? media.videoResolution !== "sd" : undefined,
      width: media?.width ?? videoStream?.width,
      height: media?.height ?? videoStream?.height,
      labels: item.Label?.map((label) => label.tag),
      taglines: item.tagline ? [item.tagline] : undefined,
      user: {
        IsFavorite: false, // 搜索结果里 Plex 不返回收藏状态
        IsPlayed: isPlayed,
        playCount: item.viewCount,
        playbackPosition: item.viewOffset ? item.viewOffset / 1000 : undefined,
        playedPercentage: this.getPlexPlayedPercentage(item),
        lastPlayedDate: item.lastViewedAt ? new Date(item.lastViewedAt * 1000).toISOString() : undefined,
      },
      raw: item, // Store the raw data for reference
    };
  }

  public override async getSearchResult(
    keywords: string = "",
    config: IMediaServerSearchOptions = {},
  ): Promise<IMediaServerSearchResult> {
    // 预定义搜索结果
    const result: IMediaServerSearchResult<IPlexSearchItem | IPlexRecentlyAddedItem> = {
      status: EResultParseStatus.unknownError,
      items: [],
    };

    // 生成基本请求参数
    let requestConfig: AxiosRequestConfig = { params: {} };
    config.startIndex = requestConfig.params["X-Plex-Container-Start"] = config.startIndex ?? 0;
    config.limit = requestConfig.params["X-Plex-Container-Size"] = config.limit ?? 50;
    requestConfig = toMerged(requestConfig, this.config.defaultSearchExtraRequestConfig ?? {});

    try {
      // M-17：identity 请求必须在 try 内 —— 放在外面时服务器离线 / 地址填错 / 令牌失效会让整个调用 reject，
      // 调用方拿不到 status 与 errorMessage，媒体墙静默空白、没有任何提示
      const serverIdentity = await this.getServerIdentity();

      // 从服务器获取最新数据 /library/recentlyAdded
      let url = "/library/recentlyAdded";

      // 如果有 keywords 则进行搜索 /search?query=string   注意两个接口返回略有不同
      if (keywords !== "") {
        url = "/search";
        requestConfig.params.query = keywords;
      }

      const resp = await this.request<IPlexJsonResponse<IPlexSearchData>>(url, requestConfig);

      const items = resp?.data?.MediaContainer?.Metadata ?? [];
      result.items = await mapWithConcurrency(items, 5, async (item) => {
        const mediaItem = this.buildPlexMediaItem(item, serverIdentity);
        // 季/集条目常常只有 parentThumb
        mediaItem.poster = await this.getPoster(item.thumb ?? (item as IPlexRecentlyAddedItem).parentThumb);
        return mediaItem;
      });
      result.options = config;
      result.status = EResultParseStatus.success;
    } catch (e) {
      // C2-M-2：与 emby/jellyfin/fnos 对齐 —— 只有 401 是认证问题（needLogin），
      // 其余（超时、网络不可达、解析异常等）统一落 parseError，并把真实原因交给 UI。
      if (e instanceof AxiosError && e.response?.status === 401) {
        result.status = EResultParseStatus.needLogin;
      } else {
        result.status = EResultParseStatus.parseError;
      }
      result.errorMessage = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    }

    return result;
  }
}
