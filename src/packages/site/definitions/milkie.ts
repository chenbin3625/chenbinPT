/**
 * @JackettDefinitions https://github.com/Jackett/Jackett/blob/master/src/Jackett.Common/Definitions/milkie.yml
 */
import type { ISiteMetadata, ITorrent } from "../types";
import { AxiosRequestConfig, AxiosResponse } from "axios";
import PrivateSite from "../schemas/AbstractPrivateSite";

const categoryMap: Record<number, string> = {
  1: "Movies",
  2: "TV",
  3: "Music",
  4: "Games",
  5: "Ebook",
  6: "Apps",
  7: "Adult",
};

export const siteMetadata: ISiteMetadata = {
  id: "milkie",
  version: 1,
  name: "Milkie",
  aka: ["ME", "奶昔"],
  description: "Milkie.cc (ME) is Private Torrent Tracker for 0DAY / GENERAL",
  tags: ["综合"],
  timezoneOffset: "+0200",

  type: "private",
  schema: "AbstractPrivateSite",

  urls: ["uggcf://zvyxvr.pp/"],

  category: [
    {
      name: "类别",
      key: "categories",
      options: Object.entries(categoryMap).map(([value, name]) => ({ name, value })),
      cross: { mode: "comma" },
    },
  ],

  search: {
    keywordPath: "params.query",
    requestConfig: {
      url: "/api/v1/torrents",
      params: {
        ps: 50,
      },
    },
    advanceKeywordParams: {
      imdb: false,
    },
    selectors: {
      rows: { selector: "torrents" },
      id: { selector: "id" },
      title: { selector: "releaseName" },
      url: { selector: "id", filters: [{ name: "prepend", args: ["/browse/"] }] },
      // L5 同型：categoryMap 只登记 1~7，站点新增分类时原写法返回 undefined（分类列变空且无告警）
      category: {
        selector: "category",
        filters: [(catId: number) => categoryMap[catId] ?? (catId ? String(catId) : undefined)],
      },
      time: {
        selector: "createdAt",
        filters: [{ name: "split", args: ["+", 0] }],
      },
      size: { selector: "size" },
      leechers: { selector: "leechers" },
      seeders: { selector: "seeders" },
      completed: { selector: "downloaded" },

      // API 存在此字段，但大部分时间为 null
      ext_imdb: { selector: "externals.imdb" },
    },
  },

  list: [
    {
      urlPattern: [/\/browse(\?.*)?$/],
      mergeSearchSelectors: false,
      selectors: {
        rows: { selector: "tor-browse-list > div > tor-torrent-release" },
        id: { selector: "a.mat-caption", attr: "href", filters: [{ name: "split", args: ["/", 2] }] },
        title: { selector: "a.mat-caption", attr: "title" },
        url: { selector: "a.mat-caption", attr: "href" },
        link: { selector: "a.mat-icon-button", attr: "href" },
        time: { selector: "span.date", attr: "title", filters: [{ name: "parseTime" }] },
        size: { selector: "div.size > span" },
        completed: { selector: "div.nos > span:nth-child(1)" },
        seeders: { selector: "div.nos > span:nth-child(2)" },
        leechers: { selector: "div.nos > span:nth-child(3)" },
      },
    },
  ],

  detail: {
    urlPattern: ["/browse/"],
    selectors: {
      title: { selector: "tor-details-page h1" },
      link: { selector: "tor-torrent-details a.download", attr: "href" },
    },
  },

  userInfo: {
    pickLast: ["name", "joinTime"],
    process: [
      {
        requestConfig: {
          url: "/api/v1/auth",
        },
        selectors: {
          name: { selector: "user.displayName" },
          uploaded: { selector: "user.uploaded" },
          downloaded: { selector: "user.downloaded" },
          joinTime: { selector: "user.createdAt", filters: [{ name: "parseTime" }] },
          // L3：原先用常量 `levelName: { text: "Early bird" }` 占位，导致所有账号（含新注册用户）
          // 都显示 Early bird，且常量不参与 hasFieldMatch 命中统计、也无法被 guessUserLevelId 修正。
          // /api/v1/auth 不返回等级，本站也没有 levelRequirements，因此这里不再声明 levelName
          // （类型允许缺省，UI 会隐藏等级行）；待确认站点等级字段后再补真实 selector。
        },
      },
    ],
  },

  userInputSettingMeta: [
    {
      name: "token",
      label: "Token",
      hint: "在 https://milkie.cc/settings/security 获取 API key",
      required: true,
    },
  ],
};

export default class Milkie extends PrivateSite {
  public override async request<T>(
    axiosConfig: AxiosRequestConfig,
    checkLogin: boolean = true,
  ): Promise<AxiosResponse<T>> {
    // L4：只填默认值，不覆盖调用方显式声明的 responseType（详情页/下载校验这类需要 document/blob 的路径
    // 会静默拿到无法解析的 JSON）。本站搜索/用户信息请求本身都已显式声明 responseType。
    axiosConfig.responseType ??= "json";

    // 在请求的 headers 中添加 存取令牌
    axiosConfig.headers = {
      ...(axiosConfig.headers ?? {}),
      "x-milkie-auth": this.userConfig.inputSetting?.token ?? "",
    };

    return super.request<T>(axiosConfig, checkLogin);
  }

  protected parseTorrentRowForLink(torrent: Partial<ITorrent>): Partial<ITorrent> {
    // M3：不要预生成带 API token 的链接。torrent.link 会被写入搜索结果缓存/历史（IndexedDB）、
    // 出现在「复制下载链接」并随搜索结果导出/分享 —— 把与 x-milkie-auth 同一把 key 拼进 link
    // 等于把整站 API 凭据复制到所有派生物。token 改为只在真正发请求的配置里注入（见下方覆写）。
    torrent.link = `/api/v1/torrents/${torrent.id}/torrent`;
    return torrent;
  }

  public override async getTorrentDownloadRequestConfig(torrent: ITorrent): Promise<AxiosRequestConfig> {
    const config = await super.getTorrentDownloadRequestConfig(torrent);
    // M3：下载请求由 downloader 侧的 getRemoteTorrentFile 直接发出，不经过本站 request()，
    // 因此这里显式带上 key 查询参数（与旧行为等价，只是不再写进 torrent.link）。
    config.params = {
      ...(config.params ?? {}),
      key: this.userConfig.inputSetting?.token ?? "",
    };
    return config;
  }
}
