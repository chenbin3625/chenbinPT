/**
 * @JackettDefinitions https://github.com/Jackett/Jackett/blob/master/src/Jackett.Common/Indexers/Definitions/NebulanceAPI.cs
 * @PTPPDefinitions https://github.com/chenbin3625/PT-Plugin-Plus/blob/dev/resource/sites/nebulance.io/config.json
 */
import { ISiteMetadata, ITorrent, ISearchInput, ETorrentStatus, type TSchemaMetadataListSelectors } from "../types";
import { selectElements } from "../utils/selector";
import Gazelle, { SchemaMetadata, top10PageList } from "../schemas/Gazelle.ts";
import {
  createDocument,
  parseValidTimeStringInZone,
  buildCategoryOptionsFromList,
  type timezoneOffset,
} from "../utils.ts";

const nblTimezoneOffset = -11;
const showPageRegex = /\/torrents\.php\?(?:.*&)?showid=\d+/;

/**
 * DEFS2-3：详情（种子组）页 overlay 里的 "Uploaded: YYYY-MM-DD HH:MM" 是站点墙上时间，
 * 必须按站点时区 -11:00 换算成绝对时间戳；原实现先 parseValidTimeString（按宿主时区解析）再手工 -11h，
 * 结果会随用户所在时区漂移（UTC+8 宿主约偏 -19h）。
 * 解析失败时返回 0（与 datetime.ts 的失败安全值约定一致），不再把字符串当时间戳往下传。
 */
export const parseNblOverlayTime = (dateStr: string, offset: timezoneOffset): number => {
  const parsed = parseValidTimeStringInZone(dateStr, [], offset);
  return typeof parsed === "number" ? parsed : 0;
};

function createOverlayDocument(overlayScriptEl: Element): Document {
  const overlayDocRawStr = overlayScriptEl.textContent.match(/"(.*)"/s)![1];
  return createDocument(JSON.parse(`"${overlayDocRawStr}"`));
}

export const siteMetadata: ISiteMetadata = {
  ...SchemaMetadata,
  version: 1,
  id: "nebulance",
  name: "Nebulance",
  aka: ["NBL"],
  description: "Nebulance is a Private site. At Nebulance we will change the way you think about TV.",
  tags: ["电视剧"],
  timezoneOffset: `${nblTimezoneOffset}00`,

  type: "private",
  schema: "Gazelle",

  urls: ["uggcf://arohynapr.vb/"],

  category: [
    {
      name: "Category",
      key: "filter_cat",
      options: [
        { name: "Episode", value: 1 },
        { name: "Season", value: 3 },
      ],
      cross: { mode: "appendQuote" },
    },
    {
      name: "Tags",
      key: "taglist",
      options: buildCategoryOptionsFromList([
        ["1080p", "2160p", "4k", "720p", "h264", "h265", "hdr", "dovi", "atmos"],
        ["action", "adventure", "comedy", "crime", "drama", "episode", "family", "fantasy"],
        ["history", "horror", "music", "mystery", "sci.fi", "thriller", "children"],
        ["amzn.sourced", "apple.tv", "atvp.sourced", "bbc.one", "disney+"],
        ["dsnp.sourced", "nf.sourced", "paramount+", "prime.video"],
        ["nogrp.release", "p2p", "remux", "scene", "sdtv", "season", "subtitles", "webdl", "webrip"],
      ]),
      cross: { mode: "comma" },
    },
  ],

  search: {
    ...SchemaMetadata.search,
    keywordPath: "params.searchtext",
    requestConfig: {
      url: "/torrents.php",
      responseType: "document",
      params: {
        order_by: "time",
        order_way: "desc",
        tags_type: 1,
      },
    },
    advanceKeywordParams: {
      imdb: false, // 只有 API 支持 IMDb 作为搜索参数
      tvmaze: {
        requestConfigTransformer: ({ keywords, requestConfig }) => {
          const params = {
            action: "show",
            showid: keywords,
          };
          return { ...requestConfig, params };
        },
      },
    },
    selectors: {
      ...SchemaMetadata.search!.selectors!,
      id: { selector: "a[href*='torrents.php?id=']", data: "browseId" },
      title: { selector: "a[href*='torrents.php?id=']", data: "src" },
      size: { selector: "a[href*='torrents.php?id=']", data: "filesize" },
      url: { selector: "a[href*='torrents.php?id=']", attr: "href" },
      link: { selector: "a[href*='torrents.php?action=download']", attr: "href" },
      subTitle: { selector: "div.tags" },
      category: {
        selector: "div.tags",
        elementProcess: (el: HTMLElement) => {
          // 类型只有 Episode 和 Season
          if (el.querySelector("a[href*='taglist=season']")) {
            return "Season";
          } else if (el.querySelector("a[href*='taglist=episode']")) {
            return "Episode";
          }
          return "Other";
        },
      },
      progress: {
        selector: ".Seeding",
        filters: [(query: any) => (query ? 100 : 0)],
      },
      status: {
        selector: "a[href*='torrents.php?id=']",
        attr: "class",
        filters: [
          (query: string) => {
            if (query.includes("Seeding")) {
              return ETorrentStatus.seeding;
            } else if (query.includes("Snatched")) {
              return ETorrentStatus.inactive;
            }
            return ETorrentStatus.unknown;
          },
        ],
      },
      // DEFS2-2 / DEFS1-2 同根因：原先只有一条 selector:"*" 的 H&R 标签（对任意行恒真 → 整站结果全被标 H&R）；
      // 列表页没有 H&R 徽标（hnrUnsatisfied 是账号维度数据），故删除这条恒真标签。
      // 但 `tags: []` 会连 Gazelle 共享 tags 一起覆盖掉（Gazelle.ts 的 strong:contains('Freeleech!') → Free），
      // 等于把「恒真 H&R」换成「什么标签都没有」；这里改为展开共享 tags，保留引擎对 Freeleech 的真实检测。
      tags: [...(SchemaMetadata.search!.selectors!.tags ?? [])],

      ext_tvmaze: {
        selector: "a[href*='showid=']",
        attr: "href",
        filters: [{ name: "querystring", args: ["showid"] }],
      },
    },
  },

  list: [
    {
      urlPattern: [/\/torrents\.php(?!.*(?:\bid=|torrentid=|showid=))/],
      selectors: {
        time: {
          text: 0,
          selector: "span.time",
          // DEFS2-3：parseTTL 已产出绝对毫秒戳（datetime.ts 的 parseTimeToLiveToDate），
          // 再叠加宿主 getTimezoneOffset 与 -11h 会把发布时间平移（UTC+8 宿主约 -19h）。
          filters: [{ name: "parseTTL" }],
        },
      },
    },
    {
      urlPattern: [showPageRegex],
      selectors: {
        keywords: { selector: "div#showinfobox span.size4" },
      },
    },
    {
      ...top10PageList,
      selectors: {
        ...top10PageList.selectors!,
        title: {
          selector: "> td > script",
          elementProcess: (el: HTMLElement) => {
            const overlayDoc = createOverlayDocument(el);
            const lastTd = selectElements("td:last", overlayDoc)[0];
            return lastTd.textContent.trim();
          },
        },
        size: {}, // from innerText
      },
    },
  ],

  detail: {
    urlPattern: ["/torrents\\.php\\?id=\\d+"],
    selectors: {
      title: { selector: ["div:has(.mediainfo) > a:first"], filters: [{ name: "split", args: [" ", 0] }] },
      link: { selector: ["a:contains('Download')"], attr: "href" },
    },
  },

  userInfo: {
    pickLast: ["id", "name", "joinTime"],
    process: [
      {
        requestConfig: { url: "/ajax.php", params: { action: "index" }, responseType: "json" },
        fields: ["id", "name"],
      },
      {
        requestConfig: { url: "/user.php", responseType: "document" },
        assertion: { id: "params.id" },
        fields: [
          "joinTime",
          "messageCount",
          "levelName",
          "lastAccessAt",
          "hnrUnsatisfied",
          "downloaded",
          "uploaded",
          "ratio",
          "uploads",
          "snatches",
          "bonus",
          "bonusPerHour",
          "seeding",
          "seedingSize",
        ],
      },
      // TODO hnrPreWarning
    ],
    selectors: {
      ...SchemaMetadata!.userInfo!.selectors!,
      id: { selector: "response.id" },
      name: { selector: "response.username" },
      joinTime: {
        selector: "li:contains('Joined') > span.time",
        attr: "title",
        filters: [{ name: "parseTime", args: ["MMM d yyyy, HH:mm"] }],
      },
      levelName: {
        ...SchemaMetadata!.userInfo!.selectors!.levelName!,
        selector: "li:contains('Class:')",
      },
      lastAccessAt: {
        selector: "li:contains('Last Seen') > span.time",
        attr: "title",
        filters: [{ name: "parseTime", args: ["MMM d yyyy, HH:mm"] }],
      },
      hnrUnsatisfied: {
        selector: "li:contains('HnRs')",
        filters: [{ name: "split", args: ["[", 0] }, { name: "parseNumber" }],
      },
      downloaded: { selector: "li:contains('Downloaded: ')", filters: [{ name: "parseSize" }] },
      uploaded: { selector: "li:contains('Uploaded: ')", filters: [{ name: "parseSize" }] },
      ratio: { text: "N/A" },
      uploads: { selector: "li:contains('Uploaded') > span:nth-child(2)", filters: [{ name: "parseNumber" }] },
      snatches: {
        selector: "li:contains('Snatched') > span:nth-child(2)",
        filters: [{ name: "parseNumber" }],
      },
      bonus: { selector: "a[href='bonus.php']:first", filters: [{ name: "parseNumber" }] },
      bonusPerHour: { selector: "li:contains('Cubits per hour')", filters: [{ name: "parseNumber" }] },
      seeding: { selector: "li:contains('Seeding') > span", filters: [{ name: "parseNumber" }] },
      seedingSize: { selector: "li:contains('Seeding Size')", filters: [{ name: "parseSize" }] },
    },
  },

  levelRequirements: [
    {
      id: 1,
      name: "Colonial",
    },
    {
      id: 2,
      name: "Ensign",
      interval: "P4W",
      uploaded: "100GB",
      snatches: 100,
      bonus: 100000,
      privilege: "Access to recruitment forum",
    },
    {
      id: 3,
      name: "Flattop",
      interval: "P8W",
      uploaded: "250GB",
      snatches: 250,
      bonus: 250000,
      privilege: "Can add tags",
    },
    {
      id: 4,
      name: "Nugget",
      interval: "P16W",
      uploaded: "500GB",
      snatches: 500,
      bonus: 500000,
      privilege: "Can view uploaders; Can edit own torrents after edit timelock",
    },
    {
      id: 5,
      name: "Raptor",
      interval: "P32W",
      uploaded: "1TB",
      snatches: 1000,
      bonus: 850000,
    },
    {
      id: 6,
      name: "Viper",
      interval: "P64W",
      uploaded: "2.5TB",
      uploads: 50,
      snatches: 2500,
      bonus: 2500000,
      privilege: "Can download multiple torrents at once aka (DownThemAll)",
    },
    {
      id: 7,
      name: "Orion",
      interval: "P100W",
      uploaded: "8.5TB",
      uploads: 150,
      snatches: 8500,
      bonus: 3000000,
      privilege: "Can view ratio; Can view downloaded",
    },
    {
      id: 8,
      name: "Valkyrie",
      interval: "P150W",
      uploaded: "100TB",
      uploads: 300,
      snatches: 35000,
      bonus: 250000000,
      privilege: "Can view the site stats page; Can use advanced bbcode tags",
    },
  ],
};

const groupPageSelectors: TSchemaMetadataListSelectors & { rows: { selector: string } } = {
  rows: { selector: "table.torrent_table tr.torrent" },
  subTitle: { selector: "a.codecs[href*='torrents.php?id=']" },
  size: { selector: "> td:nth-child(2)", filters: [{ name: "parseSize" }] },
  url: { selector: "a[href*='torrents.php?id=']", attr: "href" },
  link: { selector: "a[href*='torrents.php?action=download']", attr: "href" },
  seeders: { selector: "> td:nth-child(4)" },
  leechers: { selector: "> td:nth-child(5)" },
  completed: { selector: "> td:nth-child(3)" },
};

const categorySelector = {
  selector: "div.showname",
  filters: [
    (query: string) => {
      if (!query) {
        return "";
      }
      return query.match(/E\d{2}/) ? "Episode" : "Season";
    },
  ],
};

export default class Nebulance extends Gazelle {
  /**
   * Nebulance 特性：搜索 TVMaze id 会直接跳转到详情（种子组）页面
   * 需要判断当前页面类型以选择对应的解析方式
   */
  public override async transformSearchPage(doc: Document | any, searchConfig: ISearchInput): Promise<ITorrent[]> {
    const parsedListPageUrl = doc.URL || location.href;
    if (!showPageRegex.test(parsedListPageUrl)) {
      return super.transformSearchPage(doc, searchConfig);
    }

    const torrents: ITorrent[] = [];

    const trs = selectElements(groupPageSelectors.rows.selector, doc);
    const patchedSearchConfig = {
      ...searchConfig,
      searchEntry: {
        ...searchConfig.searchEntry!,
        selectors: groupPageSelectors,
      },
    };

    const tvMazeId = this.getFieldData(doc, {
      selector: "a[href*='www.tvmaze.com/shows/']",
      attr: "href",
      filters: [{ name: "extTvmazeId" }],
    });
    let currentCategory = "";

    for (const tr of trs) {
      try {
        const overlayScriptEl = selectElements("div.tagssh > script", tr)[0];
        const overlayDoc = createOverlayDocument(overlayScriptEl);
        const title = selectElements("table.overlay tr:nth-child(3) > td", overlayDoc)[0].textContent;

        const rightTd = selectElements("td.rightOverlay", overlayDoc)[0];
        const dateStr = rightTd.textContent.match(/Uploaded:\s*([0-9-]+\s+[0-9:]+)/)![1];
        const time = parseNblOverlayTime(dateStr, this.metadata.timezoneOffset!);

        const cat = this.getFieldData(tr, categorySelector);
        if (cat) currentCategory = cat;

        const torrent = (await this.parseWholeTorrentFromRow(
          {
            title,
            time,
            // DEFS2-2：不要给整个种子组的每一行硬写 H&R；列表/overlay 都没有 H&R 徽标
            tags: [],
            category: currentCategory,
            ext_tvmaze: tvMazeId,
          },
          tr,
          patchedSearchConfig,
        )) as ITorrent;
        torrents.push(torrent);
      } catch (e) {
        console.debug(`[PTD] site '${this.name}' parseWholeTorrentFromRow Error:`, e, tr);
      }
    }

    return torrents;
  }

  public override async getTorrentDownloadLink(torrent: ITorrent): Promise<string> {
    // 种子链接格式是 torrent.php?id=123（无种子组）
    return this.getTorrentDownloadLinkFactory("id")(torrent);
  }
}
