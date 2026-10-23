/**
 * @PTPPDefinitions https://github.com/chenbin3625/PT-Plugin-Plus/blob/dev/resource/sites/bwtorrents.tv/config.json
 * @JackettDefinitions https://github.com/Jackett/Jackett/blob/master/src/Jackett.Common/Definitions/bwtorrents.yml
 * @Issue https://github.com/chenbin3625/chenbinPT/issues/143
 */
import type { ISiteMetadata } from "../types";

// 站点分类非常多（U-232/AEON 系），此处只列出常用的影视主分类；其余分类可由用户在站点内筛选
const categoryMap: Record<number, string> = {
  113: "宝莱坞-抢鲜版",
  114: "宝莱坞-4K Ultra HD",
  115: "宝莱坞-原盘 BluRay",
  116: "宝莱坞-1080p BluRay",
  117: "宝莱坞-720p BluRay",
  118: "宝莱坞-Remux",
  119: "宝莱坞-WEB-DL 原盘",
  120: "宝莱坞-1080p WEB",
  121: "宝莱坞-DVD 原盘",
  122: "宝莱坞-DVDRip",
  123: "宝莱坞-SDRip",
  124: "宝莱坞-3D",
  125: "宝莱坞-网络剧",
  126: "好莱坞-4K Ultra HD",
  127: "好莱坞-原盘 BluRay",
  128: "好莱坞-1080p BluRay",
  129: "好莱坞-720p BluRay",
  130: "好莱坞-BluRay Remux",
  131: "好莱坞-WEB-DL 原盘",
  132: "好莱坞-1080p WEB",
  133: "好莱坞-DVD 原盘",
  134: "好莱坞-DVDRip",
  135: "好莱坞-3D",
  136: "好莱坞-抢鲜版",
  137: "马拉雅拉姆语电影",
  140: "旁遮普语电影",
  141: "卡纳达语电影",
  142: "拉莱坞电影",
  143: "博杰普尔语电影",
  144: "马拉地语电影",
  145: "孟加拉语电影",
  146: "电视剧-Colors",
  147: "电视剧-综合",
  148: "电视剧-Life OK",
  149: "电视剧-巴基斯坦剧",
  150: "电视剧-Sab TV",
  151: "电视剧-Sony",
  152: "电视剧-Star Bharat",
  153: "电视剧-Star Plus",
  154: "电视剧-Zee TV",
  155: "电视剧-体育",
  156: "电视剧-纪录片",
  157: "电视剧-好莱坞剧集",
  158: "电视剧-其他剧集",
  175: "电子书",
  176: "游戏-PC",
  177: "游戏-主机",
  178: "动漫",
  179: "软件",
  180: "移动端资源",
  187: "成人",
  190: "宝莱坞-合集",
  194: "好莱坞-合集",
  195: "电视剧-合集",
};

export const siteMetadata: ISiteMetadata = {
  id: "bwtorrents",
  version: 1,
  name: "BWT",
  aka: ["BwTorrents"],
  description: "BwTorrents (BWT) is an INDIAN Private Torrent Tracker for MOVIES / TV",
  tags: ["综合", "印度"],
  timezoneOffset: "+0530",

  type: "private",
  schema: "AbstractPrivateSite",

  urls: ["uggcf://ojgbeeragf.gi/", "uggcf://ojgbeeragf.pp/", "uggcf://ojgbeeragf.klm/", "uggcf://ojgbeeragf.hf/"],
  legacyUrls: [
    "uggcf://ojgbeeragf.sha/",
    "uggcf://ojgbeeragf.pb/",
    "uggcf://jjj.ojgbeeragf.yvsr/",
    "uggcf://jjj.ojgbeeragf.ceb/",
    "uggcf://ojgbeeragf.yvir/",
  ],

  category: [
    {
      name: "类别",
      key: "c",
      options: Object.entries(categoryMap).map(([value, name]) => ({ name, value })),
      cross: { mode: "append" },
    },
    {
      name: "状态",
      key: "incldead",
      options: [
        { name: "全部", value: 1 },
        { name: "仅死种", value: 2 },
        { name: "仅免费", value: 3 },
      ],
    },
    {
      name: "搜索范围",
      key: "blah",
      options: [
        { name: "仅标题", value: 0 },
        { name: "仅描述", value: 1 },
        { name: "标题+描述", value: 2 },
      ],
    },
  ],

  search: {
    requestConfig: {
      url: "/index.php",
      params: {
        blah: 0,
        incldead: 1,
      },
    },
    keywordPath: "params.search",
    skipNonLatinCharacters: true,
    advanceKeywordParams: {
      imdb: false,
    },
    selectors: {
      rows: { selector: "table[width='1200'] > tbody > tr:has(a[href^='download.php/'])" },
      id: {
        selector: "a[href^='details.php?id=']",
        attr: "href",
        filters: [{ name: "querystring", args: ["id"] }],
      },
      title: { selector: "a[href^='details.php?id='] b" },
      url: { selector: "a[href^='details.php?id=']", attr: "href" },
      link: { selector: "a[href^='download.php/']", attr: "href" },
      category: {
        selector: "a[href^='index.php?cat=']",
        attr: "href",
        filters: [{ name: "querystring", args: ["cat"] }, (catId: string) => categoryMap[+catId] ?? catId],
      },
      time: {
        selector: "td:nth-child(5)",
        filters: [
          // E2-08：单元格的日期与时间之间可能以空格/<br> 分隔（getFieldData 会把换行归一成空格），
          // 原格式串 `dd-MM-yyyyHH:mm:ss` 缺空格会解析失败并回落到原生 Date，
          // 而 V8 会把 `10-03-2024` 当成 MM-DD-YYYY（日/月颠倒）。这里先归一成「日期 时间」再按站点时区解析。
          (query: string) => query.trim().replace(/^(\d{2}-\d{2}-\d{4})\s*(\d{2}:\d{2}:\d{2})/, "$1 $2"),
          { name: "parseTime", args: ["dd-MM-yyyy HH:mm:ss"] },
        ],
      },
      size: { selector: "td:nth-child(6)" },
      seeders: { selector: "td:nth-child(8)" },
      leechers: { selector: "td:nth-child(9)" },
      // E2-01：原实现与 leechers 取同一列（td:nth-child(9)），「完成数」恒等于「下载者数」，
      // 比缺失更误导（Jackett 的 grabs 也是同一列，属上游同源错误）。真实表头列号尚未确认，
      // 这里不再猜测列号：先不声明 completed，等拿到登录态页面表头后再补正确的列。
      tags: [
        {
          name: "Free",
          selector: "font[color='red']:contains('[FreeLeech]')",
          color: "blue",
        },
      ],
    },
  },

  detail: {
    urlPattern: ["/details\\.php\\?id="],
    selectors: {
      link: { selector: "a[href^='download.php/']", attr: "href" },
    },
  },

  userInfo: {
    pickLast: ["id", "name"],
    process: [
      {
        requestConfig: { url: "/index.php" },
        selectors: {
          id: {
            selector: "a[href*='userdetails.php']",
            attr: "href",
            filters: [{ name: "querystring", args: ["id"] }],
          },
          name: { selector: "a[href*='userdetails.php']" },
        },
      },
      {
        requestConfig: { url: "/userdetailsmore.php" },
        assertion: { id: "params.id" },
        selectors: {
          uploaded: {
            selector: "td.rowhead:contains('Uploaded') + td",
            filters: [{ name: "parseSize" }],
          },
          downloaded: {
            selector: "td.rowhead:contains('Downloaded') + td",
            filters: [{ name: "parseSize" }],
          },
          levelName: { selector: "td.rowhead:contains('Class') + td" },
          joinTime: {
            selector: "td.rowhead:contains('Join') + td",
            elementProcess: (element: HTMLElement) => (element.textContent ?? "").split(" (")[0].trim() || undefined,
            filters: [{ name: "parseTime" }],
          },
          seeding: { selector: "img[title='Torrents seeding'] + font span" },
          bonus: { selector: "a[title='Bonus Points'] font", filters: [{ name: "parseNumber" }] },
        },
      },
    ],
  },

  levelRequirements: [
    { id: 1, name: "User" },
    { id: 2, name: "Power User" },
    // E2-16：VIP 属于 vip 组（types/userinfo.ts 约定 vip=100-199），放在 id 3（user 组区间）
    // 会让 VIP 用户被当成普通第 3 级显示，也会被 getMaxUserLevelId 算进 user 阶梯。
    { id: 100, name: "VIP", groupType: "vip" },
  ],
};
