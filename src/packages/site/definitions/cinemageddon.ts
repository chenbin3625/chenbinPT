/**
 * @JackettDefinitions https://github.com/Jackett/Jackett/blob/master/src/Jackett.Common/Definitions/cinemageddon.yml
 * @PTPPDefinitions https://github.com/chenbin3625/PT-Plugin-Plus/blob/dev/resource/sites/cinemageddon.net/config.json
 */

import { selectElements } from "../utils/selector";

import { type ISiteMetadata } from "../types";
import { parseSizeString } from "../utils/filesize.ts";

const category: Record<number, string> = {
  1: "Action",
  2: "Horror",
  3: "Martial Arts",
  4: "Comedy",
  5: "Other",
  6: "Hidden Gems",
  7: "Sci-Fi",
  8: "Gore",
  9: "Exploitation",
  11: "OST",
  12: "XXX",
  13: "Thriller",
  14: "Adventure",
  15: "Documentary",
  16: "Western",
  17: "Family",
  18: "Drama",
  19: "Ebooks",
  20: "Softcore",
  21: "Tinfoil Hat",
  22: "Trailers",
} as const;

export const siteMetadata: ISiteMetadata = {
  version: 1,
  id: "cinemageddon",
  name: "Cinemageddon",
  description: "Cinemageddon is a Private Torrent Tracker for B-movies",
  tags: ["影视"],
  timezoneOffset: "-0700", // FIXME 按照 Jackett 的情况修正
  collaborator: ["DXV5"],

  type: "private",

  urls: ["uggcf://pvarzntrqqba.arg/"],
  category: [
    {
      name: "Category",
      key: "c",
      options: Object.entries(category).map(([key, name]) => ({ value: Number(key), name })),
      cross: { mode: "append" },
    },
  ],

  search: {
    keywordPath: "params.search",
    requestConfig: {
      url: "/browse.php",
      params: { proj: 0 },
    },

    advanceKeywordParams: {
      imdb: { enabled: true },
    },

    selectors: {
      rows: { selector: 'table.torrenttable > tbody > tr:has(a[href*="browse.php?cat="])' },
      id: { selector: 'a[href*="details.php?id="]', attr: "href", filters: [{ name: "querystring", args: ["id"] }] },
      title: { selector: 'a[href*="details.php?id="]' },
      url: { selector: 'a[href*="details.php?id="]', attr: "href" },
      link: { selector: 'a[href*="download.php?id="]', attr: "href" },
      time: {
        selector: "td:nth-child(4)",
        filters: [
          // E2-08/E2-34：单元格日期与时间之间以空格/<br> 分隔（getFieldData 会把换行归一成空格），
          // 原格式串 `yyyy-MM-ddHH:mm:ss XXX` 缺空格永远解析失败，只是靠「手工追加 -07:00 后走
          // 显式时区后缀分支」碰巧得到正确结果。这里改为「归一化 + 具名 parseTime」，
          // 时区只由 metadata.timezoneOffset（-0700，与 Jackett 的 `append " -07:00"` 一致）提供。
          (query: string) => query.trim().replace(/^(\d{4}-\d{2}-\d{2})\s*(\d{2}:\d{2}:\d{2})/, "$1 $2"),
          { name: "parseTime", args: ["yyyy-MM-dd HH:mm:ss"] },
        ],
      },
      size: { selector: "td:nth-child(5)", filters: [{ name: "parseSize" }] },
      author: { selector: "td:eq(8)" },
      category: {
        selector: 'a[href*="browse.php?cat="]',
        attr: "href",
        filters: [{ name: "querystring", args: ["cat"] }, (cat: string) => category[Number(cat)] || "Other"],
      },
      seeders: { selector: "td:nth-child(7)" },
      leechers: { selector: "td:nth-child(8)" },
      completed: { selector: "td:nth-child(6)" },
      ext_imdb: { selector: 'a[href*="imdb.com/title/"]', attr: "href" },
      tags: [
        { selector: 'img[src$="/golden10.gif"]', name: "2xFree" },
        { selector: 'img[src$="/golden1.gif"]', name: "grey coin" },
        { selector: 'img[src$="/golden2.gif"]', name: "silver coin" },
        { selector: 'img[src$="/golden3.gif"]', name: "gold coin" },
      ],
    },
  },

  userInfo: {
    pickLast: ["id", "name"],
    process: [
      {
        requestConfig: { url: "/" },
        selectors: {
          id: {
            selector: ".statusbar a[href*='/userdetails.php?id=']",
            attr: "href",
            filters: [{ name: "querystring", args: ["id"] }],
          },
          name: {
            selector: ".statusbar a[href*='/userdetails.php?id=']",
          },
        },
      },
      {
        requestConfig: { url: "/userdetails.php" },
        assertion: { id: "params.id" },
        selectors: {
          uploaded: {
            selector: ["td.clx > .frames td.rowhead:contains('Uploaded') + td:first"],
            filters: [{ name: "parseSize" }],
          },
          downloaded: {
            selector: ["td.clx > .frames td.rowhead:contains('Downloaded') + td:first"],
            filters: [{ name: "parseSize" }],
          },
          levelName: {
            selector: "td.clx > .frames td.rowhead:contains('Class') + td:first",
          },
          messageCount: {
            selector: ["div.alert a[href*='messages.php']"],
            filters: [{ name: "parseNumber" }],
          },
          bonus: {
            selector: ["a[href='/credits.php']"],
            filters: [{ name: "parseNumber" }],
          },
          joinTime: {
            selector: "td.clx > .frames td.rowhead:contains('Join') + td:first",
            filters: [{ name: "split", args: [" (", 0] }, { name: "parseTime" }],
          },
          // FIXME 我对这两块情况暂时存疑，不过先抄过来吧
          seeding: {
            selector: ["div#ka2 table:first"],
            elementProcess: (table: HTMLTableElement) => {
              const trAnothers = selectElements("tr:gt(0)", table);
              return trAnothers.length;
            },
          },
          seedingSize: {
            // E2-02：这里必须定位到 <table> 本身（与上面的 seeding 相同）。原 selector
            // `div#ka2 table:first tr:not(:eq(0))` 的首个命中是 <tr>，elementProcess 里
            // `selectElements("tr:gt(0)", tr)` 找不到后代行，做种体积恒为 0。
            selector: ["div#ka2 table:first"],
            elementProcess: (table: HTMLTableElement) => {
              let seedingSize = 0;
              const trAnothers = selectElements("tr:gt(0)", table);
              trAnothers.forEach((trAnother) => {
                const sizeAnother = selectElements("td:eq(2)", trAnother)[0] as HTMLTableCellElement | undefined;
                // A-17：colspan/结构异常的行没有第 3 列时 selectElements 返回空数组，
                // 直接取 [0].innerText 会抛 TypeError 并让整次用户信息刷新失败，故跳过该行。
                if (!sizeAnother) return;
                seedingSize += parseSizeString(sizeAnother.innerText.trim());
              });
              return seedingSize;
            },
          },
        },
      },
    ],
  },

  levelRequirements: [
    // E2-15：站点默认等级（新用户）没有条目时，levelName 匹配失败又因 id1 带门槛而落到 -1「未知等级」，
    // 等级面板与「距下一级」都失效。这里补一个无门槛的入口级；后续等级 id 顺延保持单调。
    {
      id: 0,
      name: "User",
      privilege: "所有新用户的默认等级",
    },
    {
      id: 1,
      name: "Power User",
      uploaded: "25GB",
      downloaded: "20GB",
      ratio: 1.2,
      privilege: "Maximum of 8 concurrent downloads",
    },
    {
      id: 2,
      name: "CG Superfan",
      uploaded: "200GB",
      downloaded: "20GB",
      ratio: 1.5,
      privilege: "Maximum of 12 concurrent downloads",
    },
  ],
};
