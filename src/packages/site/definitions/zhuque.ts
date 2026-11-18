/**
 * @PTPPDefinitions https://github.com/chenbin3625/PT-Plugin-Plus/blob/dev/resource/sites/zhuque.in/config.json
 * @PDSDefinitions https://github.com/mantou568/pre-dessert-sites/blob/main/site_config/sites/zhuque.json
 */
import type { AxiosRequestConfig, AxiosResponse } from "axios";

import {
  EResultParseStatus,
  NeedLoginError,
  type ISearchInput,
  type ISiteMetadata,
  type ITorrent,
  type ITorrentTag,
  type IUserInfo,
} from "../types";
import { retrieveStore } from "../utils/adapter.ts";
import PrivateSite from "../schemas/AbstractPrivateSite.ts";

const categoryMap: Record<number, string> = {
  501: "电影",
  502: "剧集",
  503: "动画",
  504: "节目",
  599: "其它",
};

const mediumMap: Record<number, string> = {
  301: "UHD Blu-ray",
  302: "UHD Blu-ray DIY",
  303: "Blu-ray",
  304: "Blu-ray DIY",
  305: "Remux",
  306: "Encode",
  307: "UHDTV",
  308: "HDTV",
  309: "WEB-DL",
  399: "Other",
};

const resolutionMap: Record<number, string> = {
  401: "720p",
  402: "1080i",
  403: "1080p",
  404: "2160p",
  499: "Other",
};

const videoCodingMap: Record<number, string> = {
  101: "H264",
  102: "H265",
  103: "x264",
  104: "x265",
  199: "Other",
};

const tagsMap: Record<number, string> = {
  601: "官方",
  602: "禁转",
  603: "国语",
  604: "中字",
  611: "杜比视界",
  613: "HDR10",
  614: "特效字幕",
  621: "完结",
  622: "分集",
};

export const siteMetadata: ISiteMetadata = {
  version: 1,
  id: "zhuque",
  name: "朱雀",
  aka: ["Zhuque"],
  description: "新架构的影视站点",
  tags: ["影视", "综合"],
  timezoneOffset: "+0800",

  type: "private",
  // Info-46：schemas/ 下没有 TNode 引擎，实际基类是本文件导出的 default class（extends PrivateSite）。
  // schema 写真实基类名，避免「误删 default class 后静默回落裸 AbstractPrivateSite」且无类型错误。
  schema: "AbstractPrivateSite",

  urls: ["uggcf://muhdhr.va/"],

  collaborator: ["hui-shao"],

  category: [
    {
      name: "分类",
      key: "category",
      keyPath: "data",
      options: Object.entries(categoryMap).map(([value, name]) => ({ name, value: Number(value) })),
      cross: { mode: "brackets" },
    },
    {
      name: "媒介",
      key: "medium",
      keyPath: "data",
      options: Object.entries(mediumMap).map(([value, name]) => ({ name, value: Number(value) })),
      cross: { mode: "brackets" },
    },
    {
      name: "分辨率",
      key: "resolution",
      keyPath: "data",
      options: Object.entries(resolutionMap).map(([value, name]) => ({ name, value: Number(value) })),
      cross: { mode: "brackets" },
    },
    {
      name: "视频编码",
      key: "videoCoding",
      keyPath: "data",
      options: Object.entries(videoCodingMap).map(([value, name]) => ({ name, value: Number(value) })),
      cross: { mode: "brackets" },
    },
    {
      name: "标签",
      key: "tags",
      keyPath: "data",
      options: Object.entries(tagsMap).map(([value, name]) => ({ name, value: Number(value) })),
      cross: { mode: "brackets" },
    },
  ],

  search: {
    keywordPath: "data.keyword",
    requestConfig: {
      url: "/api/torrent/advancedSearch",
      method: "POST",
      data: { page: 1, size: 100, type: "title" }, // 搜索标题和副标题
      responseType: "json",
    },

    selectors: {
      rows: { selector: "data.torrents" },
      id: { selector: "id" },
      title: { selector: "title" },
      subTitle: { selector: "subtitle" },
      url: { selector: "id", filters: [{ name: "prepend", args: ["/torrent/info/"] }] },
      link: { selector: "id", filters: [{ name: "prepend", args: ["/api/torrent/download/"] }] },
      time: { selector: "upload_time", filters: [(v: number) => v * 1000] },
      size: { selector: "size" },
      category: { selector: "category", filters: [(v: number) => categoryMap[v] ?? String(v)] },
      seeders: { selector: "seeding" },
      leechers: { selector: "leeching" },
      completed: { selector: "complete" },
      comments: { selector: "review" },

      progress: { selector: "progress" },
      ext_imdb: { selector: ["imdb_id"], filters: [{ name: "extImdbId" }] },
      // status 站点似乎未提供
      // tags 交由 parseTorrentRowForTags 处理
    },
  },

  searchEntry: {
    area_all: { name: "全部", enabled: true },
  },

  userInfo: {
    pickLast: ["id", "joinTime"],
    process: [
      {
        requestConfig: { url: "/api/plugins/ptppUserInfo", responseType: "json" },
        selectors: {
          id: { selector: "data.id" },
          name: { selector: "data.name" },
          levelName: { selector: "data.levelName" },
          joinTime: {
            selector: "data.joinTime",
            filters: [(v: string | number) => Number(v) * 1000],
          },
          uploaded: { selector: "data.uploaded" },
          downloaded: { selector: "data.downloaded" },
          trueDownloaded: { selector: "data.trueDownloaded" },
          bonus: { selector: "data.bonus" },
          seedingBonus: { selector: "data.seedingPoints" },
          bonusPerHour: { selector: "data.bonusPerHour" },
          uploads: { selector: "data.uploadCount" },
          seeding: { selector: "data.seeding" },
          seedingSize: { selector: "data.seedingSize" },
          messageCount: { selector: "data.messageCount" },
          csrfToken: { selector: "data.csrfToken" },
          lastAccessAt: {
            selector: "data.lastUpdateTime",
            filters: [(v: string | number) => Number(v) * 1000],
          },
          invites: { selector: "data.invites" },
        },
      },
    ],
  },

  levelRequirements: [
    {
      id: 1,
      name: "筑基",
      privilege: "入站初始等级",
    },
    {
      id: 2,
      name: "结丹",
      interval: "P5W",
      downloaded: "10GB",
      ratio: 2,
      privilege: "无",
    },
    {
      id: 3,
      name: "元婴",
      interval: "P10W",
      downloaded: "25GB",
      ratio: 2,
      privilege: "无",
    },
    {
      id: 4,
      name: "出窍",
      interval: "P15W",
      downloaded: "50GB",
      ratio: 2,
      privilege: "无",
    },
    {
      id: 5,
      name: "炼虚",
      interval: "P20W",
      downloaded: "100GB",
      ratio: 2,
      privilege: "无",
    },
    {
      id: 6,
      name: "合体",
      interval: "P25W",
      downloaded: "200GB",
      ratio: 4,
      privilege: "无",
    },
    {
      id: 7,
      name: "大乘",
      interval: "P30W",
      downloaded: "300GB",
      ratio: 6,
      privilege: "无",
    },
    {
      id: 8,
      name: "真仙",
      interval: "P35W",
      downloaded: "400GB",
      ratio: 8,
      privilege: "无",
    },
  ],
};

export default class Zhuque extends PrivateSite {
  private csrfTokenRequest?: Promise<string>;

  protected override async performRequestWithRetry<T>(axiosConfig: AxiosRequestConfig): Promise<AxiosResponse<T>> {
    // The user-info endpoint bootstraps CSRF and must not call token acquisition again.
    if (new URL(axiosConfig.url ?? "", axiosConfig.baseURL ?? this.url).pathname === "/api/plugins/ptppUserInfo") {
      return super.performRequestWithRetry<T>(axiosConfig);
    }

    const token = await this.getCsrfToken();
    const config = { ...axiosConfig, headers: { ...axiosConfig.headers, "x-csrf-token": token } };
    const response = await super.performRequestWithRetry<T>(config);
    if (response.status === 403 || response.status === 419) {
      const errorText = typeof response.data === "string" ? response.data : (JSON.stringify(response.data) ?? "");
      if (/csrf|cross.site.request.forgery/i.test(errorText)) {
        // A concurrent request may already have replaced this request's stale token.
        const current = await this.retrieveRuntimeSettings<unknown>("csrfToken");
        config.headers["x-csrf-token"] =
          typeof current === "string" && current.trim() && current.trim() !== token
            ? current.trim()
            : await this.getCsrfToken(true);
        return super.performRequestWithRetry<T>(config);
      }
    }
    return response;
  }

  protected override parseTorrentRowForTags(
    torrent: Partial<ITorrent>,
    row: Element | Document | object,
    searchConfig: ISearchInput,
  ): Partial<ITorrent> {
    const tags: ITorrentTag[] = [];

    // 处理促销情况
    const { uploadRate, downloadRate } = row as { uploadRate?: number; downloadRate?: number };
    switch (uploadRate) {
      case 2:
        tags.push({ name: "2xUp", color: "green" });
        break;
    }
    switch (downloadRate) {
      case 0:
        tags.push({ name: "Free", color: "blue" });
        break;
    }

    // 处理普通标签
    const tags_array = (row as { tags?: number[] }).tags ?? [];
    if (tags_array.length > 0) {
      for (const tagId of tags_array) {
        const tagName = tagsMap[tagId];
        if (tagName) {
          tags.push({ name: tagName });
        }
      }
    }

    torrent.tags = tags;
    return torrent;
  }

  public override async getUserInfoResult(lastUserInfo: Partial<IUserInfo> = {}): Promise<IUserInfo> {
    const userInfo = await super.getUserInfoResult(lastUserInfo);

    if (userInfo.status === EResultParseStatus.success && typeof userInfo.csrfToken !== "undefined") {
      await this.storeRuntimeSettings("csrfToken", userInfo.csrfToken);
      delete userInfo.csrfToken;
    }
    return userInfo;
  }

  private async getCsrfToken(refresh = false): Promise<string> {
    if (!refresh) {
      const cached = await this.retrieveRuntimeSettings<unknown>("csrfToken");
      if (typeof cached === "string" && cached.trim()) return cached.trim();
      const legacy = await retrieveStore("metadata", `lastUserInfo.${this.metadata.id}.csrfToken`);
      if (typeof legacy === "string" && legacy.trim()) {
        return this.storeRuntimeSettings("csrfToken", legacy.trim());
      }
    }

    this.csrfTokenRequest ??= (async () => {
      const response = await super.request<{ data?: { csrfToken?: unknown } }>({
        url: "/api/plugins/ptppUserInfo",
        method: "GET",
        responseType: "json",
      });
      const token = response.data?.data?.csrfToken;
      if (typeof token !== "string" || !token.trim()) {
        throw new NeedLoginError("Zhuque did not return a CSRF token; sign in again");
      }
      return this.storeRuntimeSettings("csrfToken", token.trim());
    })();
    try {
      return await this.csrfTokenRequest;
    } finally {
      this.csrfTokenRequest = undefined;
    }
  }
}
