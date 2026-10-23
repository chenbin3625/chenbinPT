/**
 * @PDSDefinitions https://github.com/mantou568/pre-dessert-sites/blob/main/site_config/sites/sunny.json
 */
import { type AxiosRequestConfig, type AxiosResponse } from "axios";

import { ISearchInput, type ISiteMetadata, type ITorrent } from "../types";
import PrivateSite from "../schemas/AbstractPrivateSite.ts";

interface ISunnyPtResponse<T> {
  code: number;
  data: T;
  msg?: string;
}

interface ISunnyPtTorrent {
  id: number;
  title: string;
  subtitle: string;
  media_type: "movie" | "tv";
  category: { id: number; name: string };
  size: number;
  created_at: string;
  seeders: number;
  leechers: number;
  completed: number;
  imdb_id?: string;
  tmdb_id?: string;
  tags: string[];
  hit_and_run: boolean;
  promotion: { is_active: boolean; up_multiplier: number; down_multiplier: number; until: string };
  details_url: string;
}

export const siteMetadata: ISiteMetadata = {
  version: 2,
  id: "sunnypt",
  name: "Sunny",
  aka: ["SunnyPT", "阳光"],
  description: "The Ultimate File Sharing Experience",
  tags: ["影视", "综合"],
  timezoneOffset: "+0800",
  favicon: "./sunnypt.ico",

  collaborator: ["yanleichang"],

  type: "private",
  // Info-46：schemas/ 下没有 SunnyPT 引擎，实际基类是本文件导出的 default class（extends PrivateSite）。
  // schema 写成真实基类名，避免「误删 default class 后静默回落裸 AbstractPrivateSite」且无类型错误。
  schema: "AbstractPrivateSite",

  urls: ["uggcf://fhaalcg.gbc/"],

  userInputSettingMeta: [
    {
      name: "apiKey",
      label: "API Key",
      hint: "从站点设置页面获取 API Key",
      required: true,
    },
  ],

  // -----------------------------------------------------------------------
  // Torrent search — GET /api/v1/mp/torrents
  // -----------------------------------------------------------------------
  search: {
    keywordPath: "params.keyword",
    requestConfig: {
      method: "GET",
      url: "/torrents",
      responseType: "json",
      params: { page: 1, page_size: 100, sort: "created_at", order: "desc" },
    },
    selectors: {
      rows: { selector: "data.items" },
      id: { selector: "id" },
      title: { selector: "title" },
      subTitle: { selector: "subtitle" },
      category: { selector: "category.name" },
      url: { selector: "details_url" },
      time: { selector: "created_at", filters: [{ name: "parseTime" }] },
      size: { selector: "size" },
      seeders: { selector: "seeders" },
      leechers: { selector: "leechers" },
      completed: { selector: "completed" },
      ext_imdb: { selector: "imdb_id" },
      ext_tmdb: {
        selector: ":self",
        filters: [(raw: ISunnyPtTorrent) => (raw.tmdb_id ? `${raw.media_type}/${raw.tmdb_id}` : "")],
      },
    },
  },

  download: {
    requestConfig: {
      headers: {
        Accept: "application/x-bittorrent",
      },
    },
  },

  // -----------------------------------------------------------------------
  // User info — GET /api/v1/mp/profile
  // -----------------------------------------------------------------------
  userInfo: {
    pickLast: ["id", "name", "joinTime"],
    process: [
      {
        requestConfig: {
          method: "GET",
          url: "/profile",
          responseType: "json",
        },
        selectors: {
          id: { selector: "data.id" },
          name: { selector: "data.username" },
          // M-6：IUserInfo.joinTime 是毫秒时间戳；接口返回的 registered_at 是 ISO 字符串，
          // 不加 parseTime 会把字符串原样写进 joinTime，导致 utils/level.ts 的 interval（注册时长）
          // 门槛被判为已满足（E16 放大器），概览页也会展示非预期字符串。
          joinTime: { selector: "data.registered_at", filters: [{ name: "parseTime" }] },
          uploaded: { selector: "data.uploaded" },
          downloaded: { selector: "data.downloaded" },
          ratio: { selector: "data.ratio" },
          bonus: { selector: "data.bonus" },
          seeding: { selector: "data.seeding_count" },
          seedingSize: { selector: "data.seeding_size" },
          leeching: { selector: "data.leeching_count" },
          messageCount: { selector: "data.unread_messages" },
          levelName: { selector: "data.level" },
          levelId: { selector: "data.class" },
        },
      },
    ],
  },

  // L-7 / Info-39：SunnyPT 不是 NexusPHP 站点，原先直接展开 NexusPHP 的通用示例等级表
  // （Peasant/User/Power User… 含 interval: P4W、downloaded: 50GB、ratio: 1.05），
  // 「距下一等级还差什么」会按别站规则计算。等级 id（data.class）已由接口直接给出，
  // 省略 levelRequirements 不影响等级显示，也不会再展示错误的差距。
};

// ---------------------------------------------------------------------------
// SunnyPT site class — API-based site using X-API-Key authentication
// ---------------------------------------------------------------------------

export default class SunnyPT extends PrivateSite {
  /**
   * SunnyPT 公开集成 API 的地址。
   *
   * Info-8：域名以 rot13 写在 `urls` 中（用户可切换镜像），而 API 固定走 api.sunnypt.top，
   * 换域名时需要同时改这里与 `getTorrentDownloadLink` 里的 `sunnypt.top → api.sunnypt.top` 替换。
   * 未做 url 派生是因为 API 子域与页面域名不是简单拼接关系，需在产品层面确定镜像策略。
   */
  get apiBaseUrl(): string {
    return "https://api.sunnypt.top/api/v1/mp/";
  }

  /** Info-45：允许携带 X-API-Key 的 host（站点主域与 API 子域） */
  private static readonly apiCredentialHosts = new Set(["api.sunnypt.top", "sunnypt.top"]);

  /** 请求目标 host 是否属于 SunnyPT；无法解析时按「不属于」处理（宁可漏发凭据，不可误发） */
  private isSunnyPtRequest(axiosConfig: AxiosRequestConfig): boolean {
    try {
      const host = new URL(axiosConfig.url ?? "", axiosConfig.baseURL ?? this.apiBaseUrl).host;
      return SunnyPT.apiCredentialHosts.has(host);
    } catch {
      return false;
    }
  }

  /**
   * 覆写 request 方法，将所有请求指向 SunnyPT API：
   *   - baseURL 设为 https://api.sunnypt.top/api/v1/mp/
   *   - 统一添加 X-API-Key 认证头
   *   - 默认 responseType 为 json
   */
  public override async request<T>(
    axiosConfig: AxiosRequestConfig,
    checkLogin: boolean = true,
  ): Promise<AxiosResponse<T>> {
    axiosConfig.baseURL ??= this.apiBaseUrl;
    axiosConfig.responseType ??= "json";
    // Info-45：request() 是站点所有网络请求的唯一出口，包括用 API 返回的绝对 URL 下载 .torrent。
    // 只在目标 host 属于 SunnyPT 时附加 API Key；否则（CDN / 上游改版 / 被劫持的返回值）
    // 不发凭据，属于纵深防御。
    if (this.isSunnyPtRequest(axiosConfig)) {
      axiosConfig.headers = {
        ...(axiosConfig.headers ?? {}),
        "X-API-Key": this.userConfig.inputSetting?.apiKey ?? "",
      };
    }
    return super.request<T>(axiosConfig, checkLogin);
  }

  /**
   * SunnyPT API 正常响应为 { code: 0, data: ... }。
   * HTTP 200 + code === 0 视为已登录 / 请求成功。
   */
  protected override loggedCheck(raw: AxiosResponse<ISunnyPtResponse<unknown>>): boolean {
    return raw.status >= 200 && raw.status < 300 && raw.data?.code === 0;
  }

  /**
   * fixLink 应使用站点主页 URL 作为基址，而非 API 地址。
   * 这样 API 返回的相对详情页路径会被正确拼接为 https://sunnypt.top/...。
   */
  protected override fixLink(uri: string, requestConfig: AxiosRequestConfig): string {
    return super.fixLink(uri, { ...requestConfig, baseURL: this.url });
  }

  protected override parseTorrentRowForTags(
    torrent: Partial<ITorrent>,
    row: ISunnyPtTorrent,
    searchConfig: ISearchInput,
  ): Partial<ITorrent> {
    let torrentTags = torrent.tags ?? [];

    // 解析 promotion
    if (row.promotion?.is_active) {
      const { up_multiplier, down_multiplier } = row.promotion;
      if (up_multiplier == 1 && down_multiplier == 0) {
        torrentTags.push({ name: "Free" });
      } else if (up_multiplier == 2 && down_multiplier == 1) {
        torrentTags.push({ name: "2x" });
      } else if (up_multiplier == 2 && down_multiplier == 0) {
        torrentTags.push({ name: "2xFree" });
      } else if (up_multiplier == 1 && down_multiplier == 0.5) {
        torrentTags.push({ name: "50%" });
      } else if (up_multiplier == 2 && down_multiplier == 0.5) {
        torrentTags.push({ name: "2x50%" });
      } else if (up_multiplier == 1 && down_multiplier == 0.3) {
        torrentTags.push({ name: "30%" });
      }
    }

    if (row.hit_and_run) {
      torrentTags.push({ name: "H&R" });
    }

    if (row.tags && row.tags.length > 0) {
      torrentTags.push(...row.tags.map((tagName) => ({ name: tagName })));
    }

    torrent.tags = torrentTags;
    return torrent;
  }

  /**
   * SunnyPT 下载需要先通过 POST /torrents/{id}/download-token
   * 获取临时下载链接。
   */
  public override async getTorrentDownloadLink(torrent: ITorrent): Promise<string> {
    const response = await this.request<ISunnyPtResponse<{ download_url?: string }>>(
      {
        method: "POST",
        url: `/torrents/${encodeURIComponent(String(torrent.id))}/download-token`,
        responseType: "json",
      },
      false, // 不检查登录状态（token 端点即使未登录也有合理返回）
    );

    let downloadUrl = response.data?.data?.download_url ?? "";

    // 260729 api 返回的url并不能直接请求，需要做一层替换？是他们写的bug吗？先做一层兼容吧，也反馈给官方了。
    downloadUrl = downloadUrl.replace("https://sunnypt.top/", "https://api.sunnypt.top/");
    return downloadUrl;
  }
}
