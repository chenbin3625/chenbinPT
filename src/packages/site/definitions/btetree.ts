/**
 * @JackettDefinitions https://github.com/Jackett/Jackett/blob/master/src/Jackett.Common/Definitions/btetree.yml
 */
import type { ISearchInput, ISiteMetadata, ITorrent } from "../types";
import BittorrentSite from "../schemas/AbstractBittorrentSite.ts";
import { parseValidTimeString, parseValidTimeStringInZone } from "../utils/datetime.ts";

const torrentYearMap = [
  // year, min torrent_id in this year
  [2004, 2204],
  [2005, 10368],
  [2006, 21306],
  [2007, 502958],
  [2008, 512029],
  [2009, 521346],
  [2010, 531218],
  [2011, 541379],
  [2012, 551321],
  [2013, 561096],
  [2014, 569309],
  [2015, 577205],
  [2016, 584158],
  [2017, 590609],
  [2018, 597003],
  [2019, 603585],
  [2020, 608148],
  [2021, 611609],
  [2022, 614780],
  [2023, 617776],
  [2024, 621061],
  [2025, 623102],
  [2026, 625197],
];

export const siteMetadata: ISiteMetadata = {
  version: 1,
  id: "btetree",
  name: "BT.etree",
  description: "BT.etree is a Public Tracker dedicated to Bootleg FLAC MUSIC",
  tags: ["音乐"],
  timezoneOffset: "-0500",

  type: "public",
  urls: ["https://bt.etree.org/"],

  search: {
    keywordPath: "params.searchzzzz",
    requestConfig: {
      params: { cat: 0 },
    },
    advanceKeywordParams: {
      imdb: false,
    },
    selectors: {
      rows: { selector: 'table[bgcolor="#CCCCCC"] tbody tr:gt(0)' }, // 不要第一行
      id: {
        selector: "td:nth-child(2) a.details_link",
        attr: "href",
        filters: [{ name: "querystring", args: ["torrentId"] }],
      },
      title: { selector: "td:nth-child(2) a.details_link b" },
      url: { selector: "td:nth-child(2) a.details_link", attr: "href" },
      link: { selector: "td:nth-child(3) a", attr: "href" },
      time: { selector: "td:nth-child(5)" },
      size: { selector: "td:nth-child(6)", filters: [{ name: "parseSize" }] },
      author: { selector: "td:nth-child(1)" },
      seeders: { selector: "td:nth-child(8)" },
      leechers: { selector: "td:nth-child(9)" },
      completed: { selector: "td:nth-child(7)", filters: [{ name: "parseNumber" }] },
      category: { text: "Music" },
    },
  },

  list: [{ urlPattern: [/\/$/, "/index.php"], mergeSearchSelectors: true }],
  detail: {
    urlPattern: ["/details.php"],
    selectors: {
      title: { selector: "td.heading:contains('Show') + td" },
      link: { selector: "a.index[href^='download.php/']", attr: "href" },
    },
  },
};

export default class BtEtree extends BittorrentSite {
  /**
   * 这个站的 time 格式为 MM/dd HH:mm ，缺少 year 信息，所以需要hack下时间解析的方法
   * @param torrent
   * @param row
   * @param searchConfig
   * @protected
   */
  protected parseTorrentRowForTime(torrent: Partial<ITorrent> = {}, row: Element, searchConfig: ISearchInput) {
    // 如果还没解析出来id，则强行解析一次，以保证能拿到id
    if (!torrent.id) {
      torrent.id = this.getFieldData(row, searchConfig!.searchEntry!.selectors!.id!);
    }
    const torrentId = Number.parseInt(String(torrent.id ?? ""), 10);

    // 按照默认方式获取 MM/dd HH:mm 信息
    const torrentTimeByString = this.getFieldData(row, searchConfig!.searchEntry!.selectors!.time!);

    // E1b-C3 / E1b-C26：年份只能靠 torrentId 阈值表反推，原实现有两个定时炸弹：
    // ① id 解析失败（NaN）时 `NaN < testTid` 恒为 false，循环不会 break，年份会被一路覆盖到表末（2026）；
    // ② 表只维护到 2026，2027 年起的新种子（id 只会更大）全部被算成 2026，发布时间整体早一年。
    // 因此：id 有效时查表，超出表末 / id 不可用时按「当前 UTC 年」兜底，并在 MM/dd 晚于今天时回退一年（跨年）。
    const now = new Date();
    const currentYear = now.getUTCFullYear();
    const currentMonth = now.getUTCMonth() + 1;
    const currentDay = now.getUTCDate();

    const inferFallbackYear = (): number => {
      const dateMatch = String(torrentTimeByString).match(/^\s*(\d{1,2})\/(\d{1,2})/);
      if (!dateMatch) {
        return currentYear;
      }
      const month = Number.parseInt(dateMatch[1], 10);
      const day = Number.parseInt(dateMatch[2], 10);
      // 列表只给 MM/dd：晚于今天说明是上一年的种子（12/31 的种子会出现在 1 月的列表里）
      if (month > currentMonth || (month === currentMonth && day > currentDay)) {
        return currentYear - 1;
      }
      return currentYear;
    };

    // 首先尝试查表得到 year
    let torrentYear = inferFallbackYear(); // id 不可用时的兜底，不再落到表末年份
    if (Number.isFinite(torrentId) && torrentId > 0) {
      torrentYear = 2003; // 2003年之前的都归为2003年
      for (const [testYear, testTid] of torrentYearMap) {
        if (!Number.isFinite(testTid)) {
          continue;
        }
        if (torrentId < testTid) {
          break;
        }
        torrentYear = testYear;
      }

      const lastMappedTid = torrentYearMap[torrentYearMap.length - 1][1];
      if (torrentId >= lastMappedTid) {
        // 超出阈值表覆盖范围（表只维护到某一年的起步 id），按当前年份推断
        torrentYear = inferFallbackYear();
      }
    }

    // SITECORE-1：站点的 MM/dd HH:mm 是对应年度的墙上时间，按 metadata.timezoneOffset 解析；
    // 未声明时区时退回原有的宿主时区解析，避免直接得到 0
    torrent.time = (
      this.metadata.timezoneOffset
        ? parseValidTimeStringInZone(
            `${torrentYear}/${torrentTimeByString}`,
            ["yyyy/MM/dd HH:mm"],
            this.metadata.timezoneOffset,
          )
        : parseValidTimeString(`${torrentYear}/${torrentTimeByString}`, ["yyyy/MM/dd HH:mm"])
    ) as number;
    return torrent;
  }
}
