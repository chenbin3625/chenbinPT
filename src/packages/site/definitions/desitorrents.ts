/**
 * @PTPPDefinitions https://github.com/chenbin3625/PT-Plugin-Plus/blob/dev/resource/sites/torrent.desi/config.json
 * @JackettDefinitions https://github.com/Jackett/Jackett/blob/master/src/Jackett.Common/Definitions/desitorrents-api.yml
 * @Issue https://github.com/chenbin3625/chenbinPT/issues/143
 *
 * 站点为 UNIT3D 9.2.0 (custom)，Jackett 侧已改走 API v1（api/v1/torrents/filter）。
 * 保留 Unit3D 引擎，覆写 JSON API 认证、促销解析与 HTML /torrents 列表规则；注意 API v1
 * 响应带 data 包装，故 rows 等字段沿用多候选路径以兼容两种结构。
 */
import type { AxiosRequestConfig, AxiosResponse } from "axios";
import { NoUserInputError, type ISearchInput, type ISiteMetadata, type ITorrent, type ITorrentTag } from "../types";
import { isElementNode } from "../schemas/AbstractBittorrentSite.ts";
import Unit3D, { SchemaMetadata, freeleechFactorMap, pick, type IUnit3DRawTorrent } from "../schemas/Unit3D.ts";

const categoryMap: Record<number, string> = {
  1: "电影",
  2: "剧集",
  3: "音乐",
};

export const siteMetadata: ISiteMetadata = {
  ...SchemaMetadata,

  version: 2,
  id: "desitorrents",
  name: "DesiTorrents",
  aka: ["Desitorrents"],
  description: "DesiTorrents is an INDIAN Private Torrent Tracker for MOVIES / TV",
  tags: ["影视", "综合", "印度"],
  timezoneOffset: "+0530",

  type: "private",
  schema: "Unit3D",

  urls: ["https://torrent.desi/", "https://desitorrents.tv/", "https://desitorrents.rocks/"],

  userInputSettingMeta: [
    {
      name: "token",
      label: "API Key",
      hint: "在 DesiTorrents 的 My Settings → API Key 页面获取",
      required: true,
    },
  ],

  category: [
    {
      name: "类别",
      key: "categories",
      options: Object.entries(categoryMap).map(([value, name]) => ({ name, value })),
      cross: { mode: "brackets" },
    },
    {
      name: "仅免费",
      key: "free",
      options: [{ name: "仅免费种子", value: 100 }],
      cross: { mode: "brackets" },
    },
  ],

  search: {
    ...SchemaMetadata.search,
    keywordPath: "params.name",
    requestConfig: {
      url: "/api/v1/torrents/filter",
      responseType: "json",
      params: {
        perPage: 100,
      },
    },
    selectors: {
      // API v1 响应带 data 包装，沿用多候选路径；不展开 DOM 版 SchemaMetadata.search.selectors（避免在 JSON 行上求值 DOM tags）
      rows: { selector: ["data.data", "data", "torrents.data", "torrents"] },
      id: { selector: ["id", "attributes.id"] },
      title: { selector: ["name", "attributes.name"] },
      url: {
        selector: ":self",
        filters: [
          (row: any) => {
            const id = row?.id ?? row?.attributes?.id;
            return id ? `/torrents/${id}` : "";
          },
        ],
      },
      link: { selector: ["download_link", "attributes.download_link"] },
      category: {
        selector: ["category_id", "attributes.category_id"],
        filters: [(catId: number) => categoryMap[+catId] ?? String(catId)],
      },
      size: { selector: ["size", "attributes.size"] },
      time: { selector: ["created_at", "attributes.created_at"], filters: [{ name: "parseTime" }] },
      author: {
        selector: ["uploader.username", "uploader.name", "attributes.uploader.username", "attributes.uploader.name"],
      },
      seeders: { selector: ["seeders", "attributes.seeders"] },
      leechers: { selector: ["leechers", "attributes.leechers"] },
      completed: { selector: ["times_completed", "attributes.times_completed", "completed", "attributes.completed"] },
      comments: { text: 0 }, // 列表接口不返回评论数
      ext_imdb: { selector: ["imdb_id", "attributes.imdb_id"], filters: [{ name: "extImdbId" }] },
      ext_tmdb: { selector: ["tmdb_id", "attributes.tmdb_id"] },
      // 促销与内部标签交由 parseTorrentRowForTags 处理
    },
  },

  list: [
    // /torrents 页面是 HTML，禁止合并上面的 JSON API search.selectors
    {
      ...SchemaMetadata.list[0],
      mergeSearchSelectors: false,
      selectors: SchemaMetadata.search.selectors,
    },
    ...SchemaMetadata.list.slice(1),
  ],

  levelRequirements: [
    { id: 1, name: "User" },
    { id: 2, name: "PowerUser", interval: "P4W", uploaded: "1TB" },
    { id: 3, name: "SuperUser", interval: "P8W", uploaded: "5TB" },
    { id: 4, name: "ExtremeUser", interval: "P13W", uploaded: "20TB" },
    { id: 5, name: "InsaneUser", interval: "P26W", uploaded: "50TB" },
    { id: 6, name: "Veteran", interval: "P52W", uploaded: "100TB" },
  ],
};

function normalizeFreeleechKey(raw: unknown): string {
  if (typeof raw === "boolean") {
    return raw ? "100%" : "0%";
  }
  if (typeof raw === "number") {
    return `${raw}%`;
  }
  const str = String(raw ?? "").trim();
  return /^\d+$/.test(str) ? `${str}%` : str;
}

export default class DesiTorrents extends Unit3D {
  public override async request<T>(
    axiosConfig: AxiosRequestConfig,
    checkLogin: boolean = true,
  ): Promise<AxiosResponse<T>> {
    // 仅给 API 请求附带 Bearer Token，避免影响用户信息等 HTML 页面抓取
    if ((axiosConfig.url ?? "").includes("/api/")) {
      const token = this.userConfig.inputSetting?.token?.trim();
      if (!token) {
        throw new NoUserInputError("API Key");
      }
      axiosConfig.headers = {
        ...(axiosConfig.headers ?? {}),
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      };
    }

    return super.request<T>(axiosConfig, checkLogin);
  }

  /** JSON API 返回结构化促销字段，HTML 列表页则交回父类 DOM 选择器解析 */
  protected override parseTorrentRowForTags(
    torrent: Partial<ITorrent>,
    row: Element | Document | object,
    searchConfig: ISearchInput,
  ): Partial<ITorrent> {
    if (isElementNode(row)) {
      return super.parseTorrentRowForTags(torrent, row, searchConfig);
    }

    const raw = row as IUnit3DRawTorrent;
    const tags: ITorrentTag[] = [];

    const featured = Boolean(pick(raw, "featured", false));
    const freeleechKey = normalizeFreeleechKey(pick(raw, "freeleech", ""));
    const doubleUpload = Boolean(pick(raw, "double_upload", false));
    const internal = Boolean(pick(raw, "internal", false));

    if (featured) {
      torrent.downloadVolumeFactor = 0;
      torrent.uploadVolumeFactor = 2;
      tags.push({ name: "精选", color: "deep-purple" });
    } else {
      const downloadVolumeFactor = freeleechFactorMap[freeleechKey];
      if (downloadVolumeFactor !== undefined) {
        torrent.downloadVolumeFactor = downloadVolumeFactor;
      }
      torrent.uploadVolumeFactor = doubleUpload ? 2 : 1;
    }

    if (internal) {
      tags.push({ name: "官方", color: "blue-darken-2" });
    }

    torrent.tags = tags;
    return torrent;
  }
}
