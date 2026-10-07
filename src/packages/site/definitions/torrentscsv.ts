/**
 * @JackettDefinitions https://github.com/Jackett/Jackett/blob/master/src/Jackett.Common/Indexers/Definitions/TorrentsCSV.cs
 */
import type { ISiteMetadata } from "../types";

export const siteMetadata: ISiteMetadata = {
  version: 1,
  id: "torrentscsv",
  name: "Torrents-CSV",
  aka: ["TorrentsCSV"],
  description: "Torrents.csv is a self-hostable, open source torrent search engine and database",

  type: "public",
  urls: ["https://torrents-csv.com/"],
  legacyUrls: ["https://torrents-csv.ml/"],

  search: {
    keywordPath: "params.q",
    requestConfig: {
      url: "/service/search",
      responseType: "json",
      params: { size: 100 },
    },
    skipWhiteSpacePlaceholder: true,
    selectors: {
      rows: { selector: "torrents" },
      id: { selector: "id" },
      title: { selector: "name" },
      url: { text: "https://torrents-csv.com/" }, // 该站种子不存在独立介绍页
      link: {
        selector: "infohash",
        filters: [(q: string) => `magnet:?xt=urn:btih:${q}`],
      },
      time: { selector: "created_unix" },
      size: { selector: "size_bytes" },
      seeders: { selector: "seeders" },
      leechers: { selector: "leechers" },
      completed: { selector: "completed" },
    },
  },

  list: [
    {
      urlPattern: ["/search"],
      mergeSearchSelectors: false,
      selectors: {
        rows: { selector: "main.container div.card" },
        id: { selector: "a[href^='magnet']", attr: "href" },
        title: { selector: "a[href^='magnet']" },
        url: { text: "https://torrents-csv.com/" }, // 该站种子不存在独立介绍页
        link: { selector: "a[href^='magnet']", attr: "href" },
        // D-8：原选择器 `div:nth-child(1) > span:nth-child(2)` 写在 leechers 上，取到的其实是**做种数**（线上实测
        // 文本 "1.36k" 与 API 的 seeders 1357 一致），于是 leechers 恒等于 seeders。改为如实映射到 seeders；
        // 列表页下载数的位置无法确认，宁可不取也不给错数（搜索走 JSON API，不受影响）。站点用 k / m 缩写数量。
        seeders: {
          selector: "div.card-body > div.flex > div:nth-child(1) > span:nth-child(2)",
          filters: [
            (query: string) => {
              const match = String(query)
                .trim()
                .match(/^([\d.]+)\s*([km]?)$/i);
              if (!match) return 0;
              const scale = { "": 1, k: 1e3, m: 1e6 }[match[2].toLowerCase() as "" | "k" | "m"];
              return Math.round(parseFloat(match[1]) * scale);
            },
          ],
        },
        size: {
          selector: "div.card-body > div.flex > div:nth-child(2) > span:nth-child(2)",
          filters: [{ name: "parseSize" }],
        },
        time: {
          selector: "div.card-body > div.flex > div:nth-child(3) > span:nth-child(2)",
          filters: [{ name: "parseTime", args: ["yyyy-MM-dd"] }],
        },
      },
    },
  ],
};
