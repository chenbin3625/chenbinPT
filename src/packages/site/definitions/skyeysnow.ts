import { selectElements } from "../utils/selector";
import { logMessage, siteErrorLogData } from "../utils";
import { toMerged } from "es-toolkit";
import type { AxiosRequestConfig } from "axios";

import PrivateSite from "../schemas/AbstractPrivateSite.ts";
import { EResultParseStatus, ETorrentStatus, NoTorrentsError, type ISiteMetadata, type IUserInfo } from "../types";

export const siteMetadata: ISiteMetadata = {
  id: "skyeysnow",
  version: 1,
  name: "SkyeySnow",
  aka: ["天雪"],
  description: "这是一个高清动漫的完全非盈利论坛，高清动漫是一个很小的圈子 论坛方向为DVD/BDRip和BDMV&BDMV用字幕相关。",
  tags: ["动漫"],
  timezoneOffset: "+0800",
  collaborator: ["栽培者", "MewX", "fzlins", "zhuweitung", "Rhilip"],
  type: "private",
  schema: "Discuz", // 后面再看看需要不需要拆分成 schemas
  urls: ["uggcf://jjj.fxlrl2.pbz/", "uggcf://fxlrlfabj.pbz/"],
  category: [
    {
      name: "分类",
      key: "category",
      options: [
        { name: "Source:BDMV", value: "11_8" },
        { name: "Source:DVDISO", value: "11_9" },
        { name: "Source:Others", value: "11_10" },
        { name: "Source:Live/演唱会", value: "11_11" },
        { name: "Source:真人周边", value: "11_12" },
        { name: "Rip:BDRip", value: "10_6" },
        { name: "Rip:DVDRip", value: "10_7" },
        { name: "Rip:Others", value: "10_2" },
        { name: "Rip:Live/演唱会", value: "10_3" },
        { name: "Rip:真人周边", value: "10_4" },
        { name: "字幕:BDMV用字幕", value: "16_19" },
        { name: "字幕:BD用简易字幕", value: "16_130" },
        { name: "字幕:BD用链接字幕", value: "16_20" },
        // { name: "字幕:新字幕区", value: "119" },  不支持新字幕区（因为不是 torrent list）
        { name: "音乐:Lossless", value: "15_18" },
        { name: "音乐:Lossy", value: "15_17" },
        { name: "音乐:cd付mv", value: "15_59_47" },
        { name: "音乐:cd付mvrip", value: "15_59_48" },
        { name: "演唱会:RAW", value: "2_11" },
        { name: "演唱会:RAW-RIP", value: "2_3" },
        { name: "演唱会:RAW(真人周边", value: "3_12" },
        { name: "演唱会:RAW-RIP(真人周边)", value: "3_4" },
        { name: "演唱会:RAW(其他)", value: "3_10" },
        { name: "演唱会:RAW-RIP(其他)", value: "3_2" },
      ],
      cross: { mode: "append", key: "cat_" },
    },
  ],
  search: {
    requestConfig: {
      url: "/forum.php",
      params: {
        // 虽然在站点搜索时构造的链接中含有 &formhash= ，但实际后端并不验证该字段
        mod: "torrents",
      },
    },
    keywordPath: "params.search",
    advanceKeywordParams: {
      imdb: false,
      douban: false,
      anidb: {
        requestConfigTransformer: ({ requestConfig }) => {
          if (requestConfig?.params?.search) {
            requestConfig.params.search = "$" + requestConfig.params.search;
          }

          return requestConfig!;
        },
      },
    },
    selectors: {
      rows: { selector: "table.torrents > tbody > tr:gt(0)" },
      id: {
        selector: 'a[href^="/forum.php?mod=viewthread"]',
        attr: "href",
        filters: [{ name: "querystring", args: ["tid"] }],
      }, // 帖子id
      title: { selector: "td.torrent_title > a[title]", attr: "title" },
      url: { selector: 'a[href^="/forum.php?mod=viewthread"]', attr: "href" },
      link: { selector: 'a[href^="/download.php?id="]', attr: "href" }, // 种子id
      time: {
        selector: " > td:nth-child(3)",
        filters: [{ name: "parseTime", args: ["yyyy-MM-dd HH:mm:ss", "yyyy-MM-dd\nHH:mm:ss"] }],
      },
      size: { selector: "> td:nth-child(4)", filters: [{ name: "parseSize" }] },
      author: { selector: "> td:nth-last-child(1)" },
      category: { selector: "> td:nth-child(1)" },
      seeders: { selector: " > td:nth-child(5)" },
      leechers: { selector: " > td:nth-child(6)" },
      completed: { selector: " > td:nth-child(7)" },
      comments: { text: "N/A" },
      ext_anidb: {
        selector: 'span[style="float:right;font-style:italic"] > a[href*="torrents&search=%24"]:nth-child(1)', // 取第一个 anidbid
      },
      progress: {
        selector: ["div.tline1, div.tline2"],
        attr: "style",
        filters: [
          (query: string) => {
            const queryMatch = query.match(/width:([ \d.]+)%/);
            return queryMatch && queryMatch.length >= 2 ? parseFloat(queryMatch[1]) : null;
          },
        ],
      },
      status: {
        selector: ":self",
        elementProcess: (tr: HTMLElement) => {
          const statusAnothers = selectElements("> td:eq(4), > td:eq(5), > td:eq(6)", tr);
          const statusStyle: (string | null)[] = statusAnothers.map((e) => e.getAttribute("style"));
          if (statusStyle[0]) {
            return ETorrentStatus.seeding;
          } else if (statusStyle[2]) {
            return ETorrentStatus.completed;
          } else if (statusStyle[1]) {
            return ETorrentStatus.downloading;
          } else {
            return ETorrentStatus.unknown;
          }
        },
      },
    },
  },

  list: [
    {
      urlPattern: [/\/forum\.php\?mod=torrents/],
    },
  ],

  detail: {
    urlPattern: [/\/forum\.php\?mod=viewthread/],
    selectors: {
      title: { selector: ["span#thread_subject"] },
      id: {
        selector: ['div.pi a[href*="download.php?id="]'],
        attr: "href",
        filters: [{ name: "querystring", args: ["id"] }],
      },
      link: {
        selector: ['div.pi a[href*="download.php?id="][href*="&passkey="]', 'div.pi a[href*="download.php?id="]'],
        attr: "href",
      },
    },
  },

  userInfo: {
    pickLast: ["id", "name"],
    process: [
      {
        requestConfig: { url: "/" },
        selectors: {
          id: {
            selector: ".vwmy a",
            attr: "href",
            filters: [{ name: "querystring", args: ["uid"] }],
          },
          name: { selector: ".vwmy a" },
          messageCount: {
            selector: ["a.a.showmenu.new"],
            filters: [{ name: "parseNumber" }],
          },
        },
      },
      {
        requestConfig: { url: "/home.php", params: { mod: "space" } },
        assertion: { id: "params.uid" },
        selectors: {
          uploaded: {
            selector: "#psts li:contains('上传量')",
            filters: [
              (query: string) => {
                const queryMatch = query.replace(/[\s,]/g, "").match(/上传量.+\/\s*([\d.]+[ZEPTGMK]?i?B)/i);
                return queryMatch && queryMatch.length >= 2 ? queryMatch[1] : query;
              },
              { name: "parseSize" },
            ],
          },
          downloaded: {
            selector: "#psts li:contains('下载量')",
            filters: [
              (query: string) => {
                const queryMatch = query.replace(/[\s,]/g, "").match(/下载量.+\/\s*([\d.]+[ZEPTGMK]?i?B)/i);
                return queryMatch && queryMatch.length >= 2 ? queryMatch[1] : query;
              },
              { name: "parseSize" },
            ],
          },
          trueUploaded: {
            selector: '#psts li:contains("实际上传")',
            filters: [
              (query: string) => {
                const queryMatch = query.replace(/[\s,]/g, "").match(/实际上传.+?([\d.]+[ZEPTGMK]?i?B)/i);
                return queryMatch && queryMatch.length >= 2 ? queryMatch[1] : query;
              },
              { name: "parseSize" },
            ],
          },
          trueDownloaded: {
            selector: '#psts li:contains("实际下载")',
            filters: [
              (query: string) => {
                const queryMatch = query.replace(/[\s,]/g, "").match(/实际下载.+\/\s*([\d.]+[ZEPTGMK]?i?B)/i);
                return queryMatch && queryMatch.length >= 2 ? queryMatch[1] : query;
              },
              { name: "parseSize" },
            ],
          },
          levelName: {
            selector: "a[href='home.php?mod=spacecp&ac=usergroup']",
            filters: [(query: string) => query.replace("用户组: ", "").trim()],
          },
          ratio: {
            selector: "ul.bbda",
            filters: [
              (query: string) => {
                const queryMatch = query.match(/分享率\s*([\d.]+)/);
                return queryMatch && queryMatch.length >= 2 ? parseFloat(queryMatch[1]) : 0;
              },
            ],
          },
          bonus: {
            selector: "#ratio",
            filters: [{ name: "parseNumber" }],
          },
          joinTime: {
            selector: "#pbbs > li:contains('注册时间')",
            filters: [
              (query: string) => query.replace("注册时间", "").trim(),
              { name: "parseTime", args: ["yyyy-MM-dd HH:mm"] },
            ],
          },
          lastAccessAt: {
            selector: "#pbbs > li:contains('最后访问')",
            filters: [
              (query: string) => query.replace("最后访问", "").trim(),
              { name: "parseTime", args: ["yyyy-MM-dd HH:mm"] },
            ],
          },
        },
      },
    ],
  },

  levelRequirements: [
    {
      id: 1,
      name: "Lv.1 白露",
      bonus: 1000,
      privilege: "自定义头衔；允许发短消息；允许加好友；允许设置回帖奖励；允许参与点评；",
    },
    {
      id: 2,
      name: "Lv.2 秋分",
      bonus: 3000,
      privilege: "",
    },
    {
      id: 3,
      name: "Lv.3 霜降",
      bonus: 5000,
      privilege: "",
    },
    {
      id: 4,
      name: "Lv.4 小雪",
      bonus: 10000,
      privilege: "",
    },
    {
      id: 5,
      name: "Lv.5 大雪",
      bonus: 30000,
      privilege: "",
    },
    {
      id: 6,
      name: "Lv.6 小寒",
      bonus: 100000,
      privilege: "",
    },
    {
      id: 7,
      name: "Lv.7 大寒",
      bonus: 300000,
      privilege: "",
    },
    {
      id: 8,
      name: "Lv.8 立春",
      bonus: 1000000,
      privilege: "",
    },
  ],
};

export default class Skyeysnow extends PrivateSite {
  /** 单次用户信息刷新最多翻的页数，防止页码解析异常时变成请求风暴 */
  private static readonly maxPageCount = 50;

  public override async getUserInfoResult(lastUserInfo: Partial<IUserInfo> = {}): Promise<IUserInfo> {
    let flushUserInfo = await super.getUserInfoResult(lastUserInfo);
    if (flushUserInfo.status == EResultParseStatus.success) {
      // Skyeysnow 的 seeding, seedingSize, uploads 需要额外处理。
      // 这两个追加请求都是「可选信息」：失败/超时只记 warn，不能抛异常（否则会丢弃
      // super 已解析好的 uploaded/downloaded/ratio/levelName 等字段）。
      const seedAndUploadsStatus: Partial<Pick<IUserInfo, "seeding" | "seedingSize" | "uploads">> = {};
      const requestDelay = this.metadata.userInfo?.requestDelay ?? 1000;

      // 遍历 /forum.php?mod=torrents&cat_5up=on&page=<page> 页面，获取 seeding 和 seedingSize
      try {
        let currentPage = 1; // Discuz 页码从 1 开始
        let pageCount = 1;
        let requestedPages = 0;

        while (currentPage <= pageCount && currentPage <= Skyeysnow.maxPageCount) {
          await this.sleepAction(requestDelay);
          const requestConfig = {
            url: "/forum.php",
            params: { mod: "torrents", cat_5up: "on", page: currentPage },
            responseType: "document",
          } as AxiosRequestConfig;

          const { data: pageDocument } = await this.request<Document>(requestConfig);
          requestedPages++;

          // 更新最大页数
          if (currentPage === 1) {
            const detectedCount = this.getFieldData(pageDocument, {
              selector: ["a[onclick*='page=']:contains('-'):last"],
              attr: "onclick", // javascript:ajax_refreash('/torrents_list_ajax.php?mod=torrents&diy=&page=250',)
              filters: [(query: string) => parseInt(query.match(/page=(\d+)/)?.[1] ?? "1", 10)],
            });
            pageCount = typeof detectedCount === "number" && detectedCount > 0 ? detectedCount : 1;
            if (pageCount > Skyeysnow.maxPageCount) {
              logMessage(
                `[Site] ${this.name} seeding pages truncated`,
                { site: this.metadata.id, pageCount, maxPageCount: Skyeysnow.maxPageCount },
                "warn",
              );
            }
          }

          // 因为这个页面其实是搜索页面，所以我们可以直接使用 search 的解析器来解析
          try {
            const thisPageTorrents = await this.transformSearchPage(pageDocument, {
              searchEntry: this.metadata.search,
              requestConfig,
              keywords: "",
            });
            seedAndUploadsStatus.seeding = (seedAndUploadsStatus.seeding ?? 0) + thisPageTorrents.length;
            seedAndUploadsStatus.seedingSize =
              (seedAndUploadsStatus.seedingSize ?? 0) +
              thisPageTorrents.reduce((acc, torrent) => {
                return acc + (torrent.size ?? 0);
              }, 0);
          } catch (e) {
            break; // 这里常见的报错为 NoTorrentsError， 这种情况可以直接跳出循环
          }

          currentPage++;
        }

        // 请求成功过才写 seeding/seedingSize：全部请求失败时保留旧值，而不是写入假的 0
        if (requestedPages > 0) {
          seedAndUploadsStatus.seeding ??= 0;
          seedAndUploadsStatus.seedingSize ??= 0;
        }
      } catch (e) {
        logMessage(
          `[Site] ${this.name} parseUserInfoForSeedingStatus failed`,
          { site: this.metadata.id, error: siteErrorLogData(e) },
          "warn",
        );
      }

      // 通过 /forum.php?mod=torrents&search=#<uid> 获取 uploads
      try {
        await this.sleepAction(requestDelay);
        const uploadsRequestConfig = {
          url: "/forum.php",
          params: { mod: "torrents", search: `#${flushUserInfo.id!}` },
          responseType: "document",
        } as AxiosRequestConfig;
        const { data: uploadsDocument } = await this.request<Document>(uploadsRequestConfig);
        const uploads = await this.parseUploadsCount(uploadsDocument, uploadsRequestConfig);
        if (typeof uploads === "number") {
          seedAndUploadsStatus.uploads = uploads;
        } else {
          logMessage(`[Site] ${this.name} cannot determine uploads count`, { site: this.metadata.id }, "warn");
        }
      } catch (e) {
        logMessage(
          `[Site] ${this.name} parseUserInfoForUploads failed`,
          { site: this.metadata.id, error: siteErrorLogData(e) },
          "warn",
        );
      }

      // 合并数据
      flushUserInfo = toMerged(flushUserInfo, seedAndUploadsStatus);
    }

    return flushUserInfo;
  }

  /**
   * 计算发布种子数（uploads）。
   *
   * 站点分页控件的区间文本（如 `241-250`）末端就是总条数，这是原有实现的意图；
   * 但只有一页时页面上没有分页控件，原实现会回落到 `0`（用户发布 1~20 个种子时恒显示 0）。
   * 此时退化为「该页解析到的种子条数」（单页即全部）。
   *
   * REVIEW-FINDINGS site-defs：解析到「表结构存在但没有数据行」时返回 0（真实 0 发布）；
   * 只有软错误页/登录页/改版（连 `table.torrents` 都不存在）或行解析失败才返回 undefined，
   * 由调用方保留 uploads 未设置并在上层记 warn，避免把「没拿到页面」伪装成 0。
   */
  protected async parseUploadsCount(
    uploadsDocument: Document,
    requestConfig: AxiosRequestConfig,
  ): Promise<number | undefined> {
    const rangeText = this.getFieldData(uploadsDocument, {
      selector: ["a[onclick*='page=']:contains('-'):last"],
    });
    const rangeMatch = String(rangeText ?? "").match(/(\d+)\s*-\s*(\d+)/);
    if (rangeMatch) {
      const count = parseInt(rangeMatch[2], 10);
      if (!isNaN(count)) {
        return count;
      }
    }

    try {
      const torrents = await this.transformSearchPage(uploadsDocument, {
        searchEntry: this.metadata.search,
        requestConfig,
        keywords: "",
      });
      return torrents.length;
    } catch (e) {
      // `NoTorrentsError` = 行选择器零命中；只有确认页面本体仍是种子列表（避免登录页/软错误页被当成空榜）
      // 时才把「零行」解释为 0 发布。
      if (e instanceof NoTorrentsError && selectElements("table.torrents", uploadsDocument).length > 0) {
        return 0;
      }
      return undefined;
    }
  }
}
