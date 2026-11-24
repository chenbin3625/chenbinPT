/**
 * @PTPPDefinitions https://github.com/chenbin3625/PT-Plugin-Plus/blob/dev/resource/sites/torrent.desi/config.json
 * @JackettDefinitions https://github.com/Jackett/Jackett/blob/master/src/Jackett.Common/Definitions/desitorrents-api.yml
 * @Issue https://github.com/chenbin3625/chenbinPT/issues/143
 *
 * 站点为 UNIT3D 9.2.0 (custom)：登录页带 `Powered By FLX` 标记与自定义 `_auth` 主题，
 * 但页面路由仍是 Unit3D 9.2.0 那一套（`/users/{name}`、`/users/{name}/earnings` 均存在，
 * 未登录一律 302 到 `/login`）。
 *
 * - `/api/v1/torrents/filter` 与 `/api/torrents/filter` 挂在 Unit3D 的 `auth:api`（Laravel `token` driver）下，
 *   必须携带个人 API Key（Bearer Token）。
 * - `/api/v1/user` 存在（该站 `/api/user` 为 404），用户信息先用 `/api/v1/user` 取核心字段，
 *   再尽力用登录态的资料页补充 HTML 才有的字段（失败不影响核心数据）。
 * - 保留 HTML `/torrents` 列表页规则与 `isElementNode(row)` 防护，防止页面助手误走 JSON 解析。
 */
import urlJoin from "url-join";
import type { AxiosRequestConfig, AxiosResponse } from "axios";
import { toMerged } from "es-toolkit";

import { isElementNode } from "../schemas/AbstractBittorrentSite.ts";
import Unit3D, {
  CategoryFree,
  freeleechFactorMap,
  type IUnit3DRawTorrent,
  pick,
  SchemaMetadata,
} from "../schemas/Unit3D.ts";
import {
  EResultParseStatus,
  NeedLoginError,
  NoUserInputError,
  type ISearchInput,
  type ISiteMetadata,
  type ITorrent,
  type ITorrentTag,
  type IUserInfo,
} from "../types";
import { buildCategoryOptionsFromDict } from "../utils.ts";

const categoryMap: Record<number, string> = {
  1: "电影",
  2: "剧集",
  3: "音乐",
};

/** `/api/v1/user` 的响应（Unit3D 9.2.0 `App\Http\Resources\UserResource::withoutWrapping()`） */
interface IUnit3DApiUser {
  username: string;
  group: string;
  uploaded: string;
  downloaded: string;
  ratio: string;
  buffer: string;
  seeding: number;
  leeching: number;
  seedbonus: string;
  hit_and_runs: number;
}

/** 只有登录态资料页 HTML 才提供的字段（API 的 10 个字段里没有这些） */
const profileOnlyFields = ["id", "seedingSize", "averageSeedingTime", "joinTime", "lastAccessAt", "invites"] as const;

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
      hint: "在站点 个人设置（My Settings）→ API Key 页面获取 API Key 并填入此处；检索接口与用户信息接口都要求该 Key（站点未登录访问 `api/v1/*` 一律 401）",
      required: true,
    },
  ],

  category: [
    {
      name: "类别",
      key: "categories",
      options: buildCategoryOptionsFromDict(categoryMap),
      cross: { mode: "brackets" }, // 站点构造为 &categories[]=1&categories[]=2
    },
    CategoryFree,
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
      // API v1 响应带 data 包装，沿用多候选路径；不展开 DOM 版 SchemaMetadata.search.selectors（避免在 JSON 行上求值 DOM tags）
      rows: { selector: ["data.data", "data", "torrents.data", "torrents"] },
      id: { selector: ["id", "attributes.id"] },
      title: { selector: ["name", "attributes.name"] },
      url: {
        selector: ":self",
        filters: [
          (row: object) => {
            const id = pick(row, "id");
            return id ? `/torrents/${id}` : "";
          },
        ],
      },
      link: { selector: ["download_link", "attributes.download_link"] },
      category: {
        selector: ":self",
        filters: [(row: object) => categoryMap[Number(pick(row, "category_id"))] ?? "Other"],
      },
      size: { selector: ["size", "attributes.size"] },
      time: {
        selector: ["created_at", "attributes.created_at"],
        // API 返回带 Z 的 ISO 8601 时间，先转成绝对时间戳，避免 parseTime 再次套用站点 +0530 偏移
        filters: [
          (value: string | number) => {
            const timestamp = typeof value === "number" ? value : new Date(value).getTime();
            return Number.isNaN(timestamp) ? undefined : timestamp;
          },
        ],
      },
      // API 的 uploader 通常为字符串（匿名时为 "Anonymous"），也兼容对象格式
      author: {
        selector: [
          "uploader.username",
          "uploader.name",
          "attributes.uploader.username",
          "attributes.uploader.name",
          "uploader",
          "attributes.uploader",
        ],
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
    // Unit3D 的 `api/*` 是 auth:api（Laravel token driver），浏览器 Cookie 对它们无效，
    // 必须带个人 API Key；也只在这些请求上附带凭据，避免泄漏到 HTML 页面与下载跳转。
    if ((axiosConfig.url ?? "").startsWith("/api/")) {
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

  public override async getUserInfoResult(lastUserInfo: Partial<IUserInfo> = {}): Promise<IUserInfo> {
    let flushUserInfo: IUserInfo = {
      status: EResultParseStatus.unknownError,
      updateAt: +new Date(),
      site: this.metadata.id,
    };

    if (!this.allowQueryUserInfo) {
      flushUserInfo.status = EResultParseStatus.passParse;
      return flushUserInfo;
    }

    try {
      // 1. 核心字段取自 API：不依赖站点主题的 HTML 结构，也不依赖 Cookie
      const { data: apiUser } = await this.request<IUnit3DApiUser>({
        url: "/api/v1/user",
        responseType: "json",
      });

      flushUserInfo = toMerged(
        flushUserInfo,
        this.getFieldsData(apiUser, {
          name: { selector: "username" },
          levelName: { selector: "group" },
          uploaded: { selector: "uploaded", filters: [{ name: "parseSize" }] },
          downloaded: { selector: "downloaded", filters: [{ name: "parseSize" }] },
          ratio: { selector: "ratio", filters: [{ name: "parseNumber" }] },
          bonus: { selector: "seedbonus", filters: [{ name: "parseNumber" }] },
          seeding: { selector: "seeding", filters: [{ name: "parseNumber" }] },
          leeching: { selector: "leeching", filters: [{ name: "parseNumber" }] },
        }),
      );

      // 2. 登录态资料页只用来补充 API 没有的字段；任何失败都不应让整条用户信息变成 parseError
      if (flushUserInfo.name) {
        try {
          const { data: profileDocument } = await this.request<Document>({
            url: urlJoin("/users", encodeURIComponent(flushUserInfo.name)),
            responseType: "document",
          });

          const profileSelectors = this.metadata.userInfo!.selectors!;
          const extraFields = this.getFieldsData(profileDocument, profileSelectors, [
            ...profileOnlyFields,
          ] as (keyof typeof profileSelectors)[]);

          for (const [key, value] of Object.entries(extraFields)) {
            if (value === undefined || value === null || value === "") {
              continue;
            }
            (flushUserInfo as Record<string, unknown>)[key] = value;
          }
        } catch {
          // 资料页不可用时（未登录 / 主题改版）保持 API 结果
        }
      }

      // 如果前面没有获取到用户等级的 id，则尝试通过定义的 levelRequirements 来获取
      if (this.metadata.levelRequirements && flushUserInfo.levelName && typeof flushUserInfo.levelId === "undefined") {
        flushUserInfo.levelId = this.guessUserLevelId(flushUserInfo as IUserInfo);
      }

      flushUserInfo.status = EResultParseStatus.success;
    } catch (e) {
      flushUserInfo.status = EResultParseStatus.parseError;

      if (e instanceof NeedLoginError) {
        flushUserInfo.status = EResultParseStatus.needLogin;
      } else if (e instanceof NoUserInputError) {
        flushUserInfo.status = EResultParseStatus.noUserInput;
      }
    }

    return flushUserInfo;
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

    // UNIT3D 的 freeleech 是「免费比例」（0~100），下载计费比例 = 1 - free/100
    const freeleechKey = normalizeFreeleechKey(pick(raw, "freeleech", "0%"));
    const freePercent = Number(freeleechKey.replace("%", ""));
    if (freeleechKey !== "" && Number.isFinite(freePercent) && freePercent >= 0 && freePercent <= 100) {
      torrent.downloadVolumeFactor =
        freeleechFactorMap[freeleechKey] ?? Math.round((1 - freePercent / 100) * 100) / 100;
    }

    // double_upload 是布尔值，false 表示已知的「正常」（1），不是未知
    torrent.uploadVolumeFactor = pick(raw, "double_upload", false) ? 2 : 1;

    // featured 只是首页精选，不参与计费（计费只看 free 与 doubleup），这里只打徽章
    if (pick(raw, "featured", false)) {
      tags.push({ name: "精选", color: "deep-purple" });
    }

    if (pick(raw, "internal", false)) {
      tags.push({ name: "官方", color: "blue-darken-2" });
    }

    torrent.tags = tags;
    return torrent;
  }
}
