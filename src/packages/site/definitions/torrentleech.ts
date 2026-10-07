/**
 * @JackettDefinitions https://github.com/Jackett/Jackett/blob/master/src/Jackett.Common/Definitions/torrentleech.yml
 * @PTPPDefinitions https://github.com/chenbin3625/PT-Plugin-Plus/blob/dev/resource/sites/torrentleech.org/config.json
 */
import urlJoin from "url-join";
import { selectElements } from "../utils/selector";
import { mergeWith } from "es-toolkit";

import type { ISearchInput, ISiteMetadata, ITorrent, IUserInfo } from "../types";
import { EResultParseStatus } from "../types";
import { parseSizeString, createDocument, logMessage, siteErrorLogData } from "../utils";
import PrivateSite from "../schemas/AbstractPrivateSite.ts";

const categoryOptions = [
  { value: 8, name: "Movies :: Cam" },
  { value: 9, name: "Movies :: TS/TC" },
  { value: 11, name: "Movies :: DVDRip/DVDScreener" },
  { value: 37, name: "Movies :: WEBRip" },
  { value: 43, name: "Movies :: HDRip" },
  { value: 14, name: "Movies :: BlurayRip" },
  { value: 12, name: "Movies :: DVD-R" },
  { value: 13, name: "Movies :: Bluray" },
  { value: 47, name: "Movies :: 4K" },
  { value: 15, name: "Movies :: Boxsets" },
  { value: 29, name: "Movies :: Documentaries" },
  { value: 26, name: "TV :: Episodes" },
  { value: 32, name: "TV :: Episodes HD" },
  { value: 27, name: "TV :: Boxsets" },
  { value: 17, name: "Games :: PC" },
  { value: 42, name: "Games :: Mac" },
  { value: 18, name: "Games :: XBOX" },
  { value: 19, name: "Games :: XBOX360" },
  { value: 40, name: "Games :: XBOXONE" },
  { value: 20, name: "Games :: PS2" },
  { value: 21, name: "Games :: PS3" },
  { value: 39, name: "Games :: PS4" },
  { value: 22, name: "Games :: PSP" },
  { value: 28, name: "Games :: Wii" },
  { value: 30, name: "Games :: Nintendo DS" },
  { value: 48, name: "Games :: Nintendo Switch" },
  { value: 23, name: "Apps :: PC-ISO" },
  { value: 24, name: "Apps :: Mac" },
  { value: 25, name: "Apps :: Mobile" },
  { value: 33, name: "Apps :: 0-day" },
  { value: 38, name: "Education" },
  { value: 34, name: "Animation :: Anime" },
  { value: 35, name: "Animation :: Cartoons" },
  { value: 45, name: "Books :: EBooks" },
  { value: 46, name: "Books :: Comics" },
  { value: 31, name: "Music :: Audio" },
  { value: 16, name: "Music :: Music videos" },
  { value: 36, name: "Foreign :: Movies" },
  { value: 44, name: "Foreign :: TV Series" },
];

interface ITorrentLeechTorrent {
  fid: string;
  filename: string;
  name: string;
  addedTimestamp: string;
  categoryID: number;
  size: number;
  completed: number;
  seeders: number;
  leechers: number;
  numComments: number;
  tags: string;
  new: boolean;
  imdbID: string;
  rating: number;
  genres: string;
  tvmazeID: string;
  igdbID: string;
  animeID: string;
  download_multiplier: number;
  commentsDisabled: number;
}

interface IUploadsResponse {
  aaData: any[][];
  iTotalRecords: number;
  iTotalDisplayRecords: number;
  sEcho: number;
}

export const siteMetadata: ISiteMetadata = {
  id: "torrentleech",
  version: 1,
  name: "TorrentLeech",
  aka: ["TL"],
  description: "TorrentLeech (TL) is a Private Torrent Tracker for 0DAY / GENERAL. not here _ not scene",
  tags: ["综合"],
  timezoneOffset: "+0000",

  type: "private",
  schema: "AbstractPrivateSite",

  urls: [
    "https://www.torrentleech.org/",
    "https://www.torrentleech.cc/",
    "https://www.torrentleech.me/",
    "https://www.tleechreload.org/",
    "https://www.tlgetin.cc/",
  ],

  category: [
    {
      name: "Category",
      key: "category",
      options: categoryOptions,
      cross: { mode: "custom" },
      generateRequestConfig(value) {
        const categoryString = Array.isArray(value) ? value.join(",") : value;
        return {
          requestConfig: {
            url: `/torrents/browse/list/categories/${categoryString}/query`,
          },
        };
      },
    },
  ],

  search: {
    requestConfig: {
      url: "/torrents/browse/list/query",
      responseType: "json",
    },
    advanceKeywordParams: {
      imdb: { enabled: true },
    },

    requestConfigTransformer: ({ keywords, searchEntry, requestConfig }) => {
      const baseUrl = requestConfig!.url || "";
      if (keywords) {
        delete requestConfig!.params?.keywords; // 移除 AbstractBittorrentSite 自动添加的 keywords 参数

        // remove dashes at the beginning of keywords as they exclude search strings (see Jackett/Jackett#3096)
        keywords = keywords.replace(/(^|\s)-/, "");
        requestConfig!.url = urlJoin(baseUrl, `${keywords}`);
      }

      return requestConfig!;
    },
    selectors: {
      rows: { selector: "torrentList" },
      id: { selector: "fid" },
      title: { selector: "name" },
      url: { selector: "fid", filters: [{ name: "prepend", args: ["/torrent/"] }] },
      link: {
        selector: ":self",
        filters: [(row: ITorrentLeechTorrent) => "/download/" + row.fid + "/" + row.filename],
      },
      time: { selector: "addedTimestamp", filters: [{ name: "parseTime" }] },
      size: { selector: "size" },
      author: { selector: "uploader" },
      seeders: { selector: "seeders" },
      leechers: { selector: "leechers" },
      completed: { selector: "completed" }, // D-31：原先取的是评论数 numComments
      category: {
        selector: "categoryID",
        filters: [(categoryId: number) => categoryOptions.find((cat) => cat.value == categoryId)?.name ?? "Unknown"],
      },

      ext_imdb: { selector: "imdbID" },
      ext_tvmaze: {
        selector: "tvmazeID",
        filters: [
          (query: string) => {
            // Example: "e1234567" "s12345"
            // 只保留能直接用于 social 模块的 season id
            if (query.charAt(0) === "e") return null;
            return query.slice(1);
          },
        ],
      },
    },
  },

  list: [
    {
      urlPattern: ["/torrents/browse"],
      mergeSearchSelectors: false,
      selectors: {
        rows: { selector: "table.torrents tr.torrent" },
        id: { selector: ":self", data: "tid" },
        category: { selector: "a.category[data-ccid]", data: "ccid" },
        title: {
          selector: "div.name",
          elementProcess: (el) => {
            el?.querySelectorAll("span")?.forEach((span: HTMLSpanElement) => span?.remove()); // 移除 span 标签
            return el?.textContent?.trim() ?? "";
          },
        },
        url: { selector: "div.name a", attr: "href" },
        link: { selector: "a.download", attr: "href" },
        seeders: { selector: "td.td-seeders" },
        leechers: { selector: "td.td-leechers" },
        completed: { selector: "td.td-snatched" },
        size: { selector: "td.td-size", filters: [{ name: "parseSize" }] },
        time: { selector: "td.td-uploaded-time", filters: [{ name: "parseTime", args: ["yyyy-MM-ddHH:mm:ss"] }] },
      },
    },
  ],

  detail: {
    urlPattern: ["/torrent/\\d+"],
    selectors: {
      id: { selector: 'input[name="torrentID"]', attr: "value" },
      title: { selector: ["#torrentnameid", "#torrentName"] },
      link: { selector: "#detailsDownloadButton", attr: "href" },
    },
  },

  userInfo: {
    pickLast: ["id", "name"],
    process: [
      {
        requestConfig: { url: "/", responseType: "document" },
        selectors: {
          name: { selector: "span.centerTopBar span[onclick*='/profile/'][onclick*='view']" },
          uploaded: { selector: "span.centerTopBar div[title^='Uploaded'] span", filters: [{ name: "parseSize" }] },
          downloaded: { selector: "span.centerTopBar div[title^='Downloaded'] span", filters: [{ name: "parseSize" }] },
          bonus: { selector: "span.centerTopBar span.total-TL-points", filters: [{ name: "parseNumber" }] },
          messageCount: {
            text: "0",
            selector: "span.div-menu-item[onclick*='/notifications'] div.notificatinTooltip span.tooltip-title",
            filters: [{ name: "parseNumber" }],
          },
        },
      },
      {
        requestConfig: { url: "/profile/$name$", responseType: "document" },
        assertion: { name: "url" }, // 替换之前获取的用户名
        selectors: {
          id: {
            selector: "script:contains('userLogUserID')",
            filters: [(text: string) => text.match(/var userLogUserID = '(\d+)';/)?.[1] ?? ""],
          },
          levelName: { selector: "div.profile-details div.label-user-class" },
          joinTime: {
            selector: "table.profileViewTable td:contains('Registration date') + td",
            filters: [{ name: "parseTime", args: ["EEEE do MMMM yyyy" /* 'Saturday 6th May 2017' */] }],
          },
          lastAccessAt: {
            selector: "table.profileViewTable td:contains('Last visit') + td",
            filters: [
              // Friday 7th November 2025 12:04:58 PM (38 seconds ago)
              { name: "split", args: [" (", 0] },
              { name: "parseTime", args: ["EEEE do MMMM yyyy hh:mm:ss a"] },
            ],
          },
        },
      },
      // 获取用户上传的种子数量
      {
        requestConfig: {
          url: "/user/account/uploadedtorrents",
          method: "POST",
          responseType: "json",
          data: {
            sEcho: "1",
            iColumns: "6",
            sColumns: "categoryID,name,size,completed,seeders,leechers",
            iDisplayStart: "0",
            iDisplayLength: "50",
            mDataProp_0: "0",
            sSearch_0: "",
            bRegex_0: "false",
            bSearchable_0: "true",
            bSortable_0: "false",
            mDataProp_1: "1",
            sSearch_1: "",
            bRegex_1: "false",
            bSearchable_1: "true",
            bSortable_1: "false",
            mDataProp_2: "2",
            sSearch_2: "",
            bRegex_2: "false",
            bSearchable_2: "true",
            bSortable_2: "true",
            mDataProp_3: "3",
            sSearch_3: "",
            bRegex_3: "false",
            bSearchable_3: "true",
            bSortable_3: "true",
            mDataProp_4: "4",
            sSearch_4: "",
            bRegex_4: "false",
            bSearchable_4: "true",
            bSortable_4: "true",
            mDataProp_5: "5",
            sSearch_5: "",
            bRegex_5: "false",
            bSearchable_5: "true",
            bSortable_5: "true",
            sSearch: "",
            bRegex: "false",
            iSortCol_0: "0",
            sSortDir_0: "asc",
            iSortingCols: "1",
            userID: "$id$", // 使用动态获取的用户ID
          },
          headers: {
            Accept: "application/json, text/javascript, */*; q=0.01",
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            "X-Requested-With": "XMLHttpRequest",
          },
        },
        assertion: { id: "valid" }, // 确保有用户ID
        selectors: {
          uploads: {
            selector: ":self",
            filters: [(response: IUploadsResponse) => response.iTotalRecords || 0],
          },
        },
      },
    ],
  },

  noLoginAssert: {
    matchSelectors: ["div.login-container form[name='login-form']"],
  },

  levelRequirements: [
    {
      id: 0,
      name: "User",
      privilege: "",
    },
    {
      id: 1,
      name: "Power User",
      interval: "P2W",
      uploaded: "200GB",
      ratio: 1.1,
      privilege: "Increased Points: 3%, Minimum Seeding Time: 8 days",
    },
    {
      id: 2,
      name: "Super User",
      interval: "P12W",
      uploaded: "1TB",
      ratio: 2.0,
      privilege: "Increased Points: 5%, Minimum Seeding Time: 7 days",
    },
    {
      id: 3,
      name: "Extreme User",
      interval: "P24W",
      uploaded: "10TB",
      ratio: 5.0,
      privilege: "Increased Points: 6%, Minimum Seeding Time: 6 days",
    },
    {
      id: 4,
      name: "TL GOD",
      interval: "P52W",
      uploaded: "50TB",
      ratio: 8.0,
      privilege: "Increased Points: 8%, Minimum Seeding Time: 4 days",
    },
  ],
};

export default class TorrentLeech extends PrivateSite {
  public override async getUserInfoResult(lastUserInfo: Partial<IUserInfo> = {}): Promise<IUserInfo> {
    let flushUserInfo = await super.getUserInfoResult(lastUserInfo);

    // 导入用户做种信息
    if (
      flushUserInfo.status === EResultParseStatus.success &&
      (typeof flushUserInfo.seeding === "undefined" || typeof flushUserInfo.seedingSize === "undefined")
    ) {
      flushUserInfo = await this.parseUserInfoForSeedingStatus(flushUserInfo);
    }

    // 获取用户上传的详细信息（如果需要更多信息）
    if (
      flushUserInfo.status === EResultParseStatus.success &&
      flushUserInfo.id &&
      (typeof flushUserInfo.uploads === "undefined" || typeof flushUserInfo.uploads === "number")
    ) {
      flushUserInfo = await this.parseUserInfoForUploads(flushUserInfo);
    }

    return flushUserInfo;
  }

  protected override parseTorrentRowForTags(
    torrent: Partial<ITorrent>,
    row: ITorrentLeechTorrent,
    searchConfig: ISearchInput,
  ): Partial<ITorrent> {
    torrent.tags ??= [];
    if (row.tags?.includes("FREELEECH")) {
      torrent.tags.push({ name: "Free", color: "blue" });
    }
    // DEFS2-2 收尾（统一判据：站点是否全站 H&R，而非选择器形状）：
    // 本站属上游 fb79a2a7「feat: add default H&R tags with red color for global sites」(PR #336)
    // 明确列出的全站 H&R 站点——站点规则对**全部**下载都规定 H&R 义务，故对每一行无条件贴 H&R
    //（效果等价于恒真 selector:"*"，属刻意设计，不得按「恒真伪标签」删除；与 torrenting.ts 同一约定）。
    torrent.tags.push({ name: "H&R", color: "red" });

    return torrent;
  }

  // 获取做种信息
  protected async parseUserInfoForSeedingStatus(flushUserInfo: Partial<IUserInfo>): Promise<IUserInfo> {
    let seedStatus = { seeding: 0, seedingSize: 0 };

    const userName = flushUserInfo.name as string;
    const { data } = await this.request<string>({
      url: `/profile/${userName}/seeding`,
    });

    if (data && data.includes("profile-seedingTable")) {
      const userSeedingPage = createDocument(data);

      // 直接获取所有大小列的元素
      const sizeElements = selectElements(
        "table#profile-seedingTable > tbody > tr > td:nth-child(2)",
        userSeedingPage as Document,
      );

      // 做种数量就是大小元素的数量
      seedStatus.seeding = sizeElements.length;

      // 累加所有大小
      sizeElements.forEach((sizeElement) => {
        const sizeText = sizeElement.textContent?.trim() || "0";
        seedStatus.seedingSize += parseSizeString(sizeText);
      });
    }

    return mergeWith(flushUserInfo, seedStatus, (objValue, srcValue) => {
      return typeof srcValue === "undefined" ? objValue : srcValue;
    }) as IUserInfo;
  }

  // 获取用户上传的详细信息
  protected async parseUserInfoForUploads(flushUserInfo: Partial<IUserInfo>): Promise<IUserInfo> {
    const userId = flushUserInfo.id as string;

    if (!userId) {
      return flushUserInfo as IUserInfo;
    }

    try {
      // 获取完整的上传列表数据
      const { data } = await this.request<IUploadsResponse>({
        url: "/user/account/uploadedtorrents",
        method: "POST",
        data: {
          sEcho: "1",
          iColumns: "6",
          sColumns: "categoryID,name,size,completed,seeders,leechers",
          iDisplayStart: "0",
          iDisplayLength: "50",
          mDataProp_0: "0",
          sSearch_0: "",
          bRegex_0: "false",
          bSearchable_0: "true",
          bSortable_0: "false",
          mDataProp_1: "1",
          sSearch_1: "",
          bRegex_1: "false",
          bSearchable_1: "true",
          bSortable_1: "false",
          mDataProp_2: "2",
          sSearch_2: "",
          bRegex_2: "false",
          bSearchable_2: "true",
          bSortable_2: "true",
          mDataProp_3: "3",
          sSearch_3: "",
          bRegex_3: "false",
          bSearchable_3: "true",
          bSortable_3: "true",
          mDataProp_4: "4",
          sSearch_4: "",
          bRegex_4: "false",
          bSearchable_4: "true",
          bSortable_4: "true",
          mDataProp_5: "5",
          sSearch_5: "",
          bRegex_5: "false",
          bSearchable_5: "true",
          bSortable_5: "true",
          sSearch: "",
          bRegex: "false",
          iSortCol_0: "0",
          sSortDir_0: "asc",
          iSortingCols: "1",
          userID: userId,
        },
        headers: {
          Accept: "application/json, text/javascript, */*; q=0.01",
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          "X-Requested-With": "XMLHttpRequest",
        },
      });

      if (data && data.aaData) {
        const uploadsData = {
          uploads: data.iTotalRecords || 0,
          uploadsList: data.aaData.map((item: any[]) => ({
            category: item[0] || "",
            name: item[1] || "",
            size: item[2] || "",
            completed: item[3] || "",
            seeders: item[4] || "",
            leechers: item[5] || "",
          })),
        };

        return mergeWith(flushUserInfo, uploadsData, (objValue, srcValue) => {
          return typeof srcValue === "undefined" ? objValue : srcValue;
        }) as IUserInfo;
      }

      // DEFS3-4：接口 200 但响应里没有 aaData（字段改名 / 返回登录页 HTML）时，
      // 原先会直接跳出 try，uploads 保持 undefined 而用户无从区分「接口坏了」与「我真的没发种」；
      // 这里补一条可见告警（不改变 success 状态，因为发布数只是可选增强）。
      logMessage(
        `[Site] ${this.name} parseUserInfoForUploads: response has no aaData`,
        { site: this.metadata.id },
        "warn",
      );
    } catch (error) {
      // DEFS3-4：原先完全静默（既不记日志也不设 statusMsg），发布数/发布列表抓取失败时毫无痕迹。
      // 沿用 P1-2 的统一日志出口，把失败暴露到运行时日志里。
      logMessage(
        `[Site] ${this.name} parseUserInfoForUploads failed`,
        { site: this.metadata.id, error: siteErrorLogData(error) },
        "warn",
      );
    }

    return flushUserInfo as IUserInfo;
  }
}
