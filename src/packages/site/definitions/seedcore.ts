/**
 * @JackettDefinitions https://github.com/Jackett/Jackett/blob/master/src/Jackett.Common/Definitions/seedcore-api.yml
 *
 * SeedCore（ROT）—— 罗马尼亚私有综合站（MOVIES / TV / GENERAL）。
 *
 * 站点为 **UNIT3D 9.2.0（custom）**，Jackett 侧走 JSON API（`api/torrents/filter` + `Authorization: Bearer`），
 * 本文件照此实现搜索；用户信息 / 详情页 / 标签等逻辑仍由 Unit3D 引擎提供（同 concertos、huno 的处理）。
 *
 * 更名与迁移：Jackett 的 `seedcore-api.yml` 声明 `replaces: [rotorrent-api]`，并把
 * https://rotorrent.info/ 列为 legacylink —— 即本站原名 **Rot**orrent（缩写 ROT），现域为 seedcore.net。
 * 因此本定义一并覆盖 rotorrent.info（旧域进 legacyUrls）。
 *
 * ✅ 2026-11-11 实测：https://seedcore.net/ → 302 到 /login，标题「SeedCore.net - Login」，站点在线
 * （响应头带 Cloudflare）。⚠️ 无账号，选择器与参数取自 Jackett 定义，**未经真机搜索验证**；
 * API Key 在 My Settings → API Key 页生成（见下方 hint）。
 */
import type { AxiosRequestConfig, AxiosResponse } from "axios";
import {
  NoUserInputError,
  type ISearchCategoryOptions,
  type ISearchInput,
  type ISiteMetadata,
  type ITorrent,
  type ITorrentTag,
} from "../types";
import { isElementNode } from "../schemas/AbstractBittorrentSite";
import Unit3D, { freeleechFactorMap, type IUnit3DRawTorrent, pick, SchemaMetadata } from "../schemas/Unit3D.ts";

// 取自 Jackett seedcore-api.yml 的 categorymappings（该表注明来自 torznab caps）
const categories: ISearchCategoryOptions[] = [
  { name: "Movies", value: 1 },
  { name: "TV", value: 2 },
  { name: "Music", value: 3 },
  { name: "Games", value: 4 },
  { name: "XXX", value: 5 },
  { name: "Video", value: 6 },
  { name: "Other", value: 7 },
];

export const siteMetadata: ISiteMetadata = {
  ...SchemaMetadata,

  version: 1,
  id: "seedcore",
  name: "SeedCore",
  aka: ["ROT", "Rotorrent"],
  description: "SeedCore (SC) is a ROMANIAN Private Torrent Tracker for MOVIES / TV / GENERAL",
  tags: ["影视", "综合"],

  type: "private",
  schema: "Unit3D",

  urls: ["https://seedcore.net/"],
  // 原名 Rotorrent，官网迁移后旧域仍指向同一站点（Jackett legacylinks）
  legacyUrls: ["https://rotorrent.info/"],

  userInputSettingMeta: [
    {
      name: "apikey",
      label: "API Key",
      hint: "在 SeedCore 的 My Settings → API Key 页面生成；搜索时以 Authorization: Bearer 发送",
      required: true,
    },
  ],

  category: [
    {
      name: "分类",
      key: "categories",
      options: categories,
      cross: { mode: "brackets", key: "categories" }, // UNIT3D API：&categories[]=1&categories[]=2
    },
  ],

  search: {
    ...SchemaMetadata.search,
    keywordPath: "params.name",
    requestConfig: {
      url: "/api/torrents/filter",
      responseType: "json",
      params: { perPage: 100 },
    },
    advanceKeywordParams: {
      ...SchemaMetadata.search.advanceKeywordParams,
      imdb: {
        requestConfigTransformer: ({ requestConfig: config }) => {
          if (config?.params?.name) {
            // UNIT3D 的 imdbId 参数使用不带 tt 前缀的数字 ID
            config.params.imdbId = String(config.params.name).replace(/^tt/i, "");
            delete config.params.name;
          }
          return config!;
        },
      },
    },
    selectors: {
      // JSON 响应可能带 data 包装，沿用多候选路径（同 concertos）
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
      category: { selector: ["category.name", "attributes.category.name"] },
      size: { selector: ["size", "attributes.size"] },
      time: { selector: ["created_at", "attributes.created_at"], filters: [{ name: "parseTime" }] },
      author: {
        selector: ["uploader.username", "uploader.name", "attributes.uploader.username", "attributes.uploader.name"],
      },
      seeders: { selector: ["seeders", "attributes.seeders"] },
      leechers: { selector: ["leechers", "attributes.leechers"] },
      completed: { selector: ["times_completed", "attributes.times_completed", "completed", "attributes.completed"] },
      ext_imdb: { selector: ["imdb_id", "attributes.imdb_id"], filters: [{ name: "extImdbId" }] },
      ext_tmdb: { selector: ["tmdb_id", "attributes.tmdb_id"] },
      ext_tvdb: { selector: ["tvdb_id", "attributes.tvdb_id"] },
    },
  },

  list: [
    {
      ...SchemaMetadata.list![0],
      mergeSearchSelectors: false,
      selectors: SchemaMetadata.search.selectors,
    },
    ...SchemaMetadata.list!.slice(1),
  ],
};

export default class SeedCore extends Unit3D {
  public override async request<T>(
    axiosConfig: AxiosRequestConfig,
    checkLogin: boolean = true,
  ): Promise<AxiosResponse<T>> {
    // 只向 API 搜索请求发送 Token，不把凭据附到用户页 / 下载请求上
    if (axiosConfig.url === "/api/torrents/filter") {
      const token = this.userConfig.inputSetting?.apikey?.trim();
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

  protected override parseTorrentRowForTags(
    torrent: Partial<ITorrent>,
    row: Element | Document | object,
    searchInput: ISearchInput,
  ): Partial<ITorrent> {
    // HTML 列表页仍走 Unit3D 默认的 DOM 标签选择器
    if (isElementNode(row)) {
      return super.parseTorrentRowForTags(torrent, row, searchInput);
    }

    const raw = row as IUnit3DRawTorrent;
    const tags: ITorrentTag[] = [];

    const featured = pick(raw, "featured", false);
    const freeleech = String(pick(raw, "freeleech", ""));
    const doubleUpload = pick(raw, "double_upload", false);
    const internal = pick(raw, "internal", false);

    if (featured) {
      torrent.downloadVolumeFactor = 0;
      torrent.uploadVolumeFactor = 2;
      tags.push({ name: "精选", color: "deep-purple" });
    } else {
      const downloadVolumeFactor = freeleechFactorMap[freeleech];
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
