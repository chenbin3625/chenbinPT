/**
 * @JackettDefinitions https://github.com/Jackett/Jackett/blob/master/src/Jackett.Common/Definitions/anirena.yml
 */
import { type ISiteMetadata } from "../types";

export const siteMetadata: ISiteMetadata = {
  version: 1,
  id: "anirena",
  name: "AniRena",
  description: "AniRena is a Public torrent tracker for the latest anime and Japanese related torrents",
  tags: ["Anime"],

  type: "public",
  urls: ["uggcf://jjj.naveran.pbz/"],
  legacyUrls: ["uggcf://naveran.pbz/"],

  category: [
    {
      name: "Category",
      key: "t",
      options: [
        { name: "Raw Animes", value: 1 },
        { name: "Anime", value: 2 },
        { name: "Hentai", value: 3 },
        { name: "Drama", value: 4 },
        { name: "DVD/ISO", value: 5 },
        { name: "Hentai-Game", value: 6 },
        { name: "Manga", value: 7 },
        { name: "Audio", value: 8 },
        { name: "Anime Music Videos", value: 9 },
        { name: "Non-English", value: 10 },
        { name: "Other", value: 11 },
      ],
      cross: false,
    },
  ],

  search: {
    keywordPath: "params.q",
    requestConfig: { url: "/" },
    // D-2：站点已改版，旧选择器（div.full2 / torrents_small_* / a[nohref]）全部 0 命中，搜索恒为「无结果」。
    // 以下按现布局 table.tl-table（与 Jackett anirena.yml 一致）
    selectors: {
      rows: { selector: "table.tl-table > tbody > tr:not(:has(div.tl-empty-state))" },
      id: {
        selector: "a[title='Download Torrent']",
        attr: "href",
        // 站点没有独立的种子 id 字段：以下载链接里的数字（或整个链接）作为唯一标识
        filters: [(href: string) => href?.match(/(\d+)(?!.*\d)/)?.[1] ?? href],
      },
      title: { selector: "a.tl-torrent-name" },
      url: { selector: "a.tl-torrent-name", attr: "href" },
      link: { selector: "a[title='Download Torrent']", attr: "href" },
      time: { selector: "td.col-date", filters: [{ name: "parseTime", args: ["yyyy-MM-dd HH:mm"] }] },
      size: { selector: "td.col-size", filters: [{ name: "parseSize" }] },
      seeders: { selector: "td.col-se" },
      leechers: { selector: "td.col-le" },
      completed: { selector: "td.col-dl" },
      category: { selector: "td.col-cat", attr: "title" },
    },
  },
};
