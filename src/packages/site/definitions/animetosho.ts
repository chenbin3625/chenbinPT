/**
 * @JackettDefinitions https://github.com/Jackett/Jackett/blob/master/src/Jackett.Common/Definitions/animetosho-xyz.yml
 */
import { type ISiteMetadata } from "../types";

export const siteMetadata: ISiteMetadata = {
  version: 1,
  id: "animetosho",
  name: "AnimeTosho",
  aka: ["AT", "アニメ等所"],
  description:
    "AnimeTosho (AT) is an automated service that provides torrent files, magnet links and DDL for all anime releases",
  tags: ["动画", "漫画"],

  type: "public",

  urls: ["https://animetosho.org/"],

  category: [
    {
      name: "Sort",
      key: "order",
      options: [
        { name: "Newest first", value: "" },
        { name: "Oldest first", value: "date-a" },
        { name: "Smallest first", value: "size-a" },
        { name: "Sort: Largest first", value: "size-d" },
      ],
    },
  ],

  search: {
    keywordPath: "params.q",
    requestConfig: { url: "/search" },

    requestConfigTransformer: ({ keywords, requestConfig }) => {
      if (!keywords) {
        requestConfig!.url = "/";
      }
      return requestConfig!;
    },

    selectors: {
      rows: { selector: "div.home_list_entry" },
      id: {
        selector: "div.link a",
        attr: "href",
        filters: [(q: string) => q.match(/\.([nd\d]+)$/)![1]],
      },
      title: { selector: "div.link a" },
      url: { selector: "div.link a", attr: "href" },
      link: {
        selector: ['div.links > a[href$=".torrent"]', 'div.links > a[href^="magnet:?xt="]'],
        attr: "href",
      },
      time: {
        selector: "div.date",
        attr: "title",
        filters: [
          (q: string) => {
            // 03/06/2011 08:17
            // Today 01:59
            // Yesterday 23:39
            q = q.replace("Date/time submitted: ", "");
            // E1-B4：站点时间是 UTC，而原实现用 `format(new Date())` / `subDays` 取**宿主时区**的今天/昨天，
            // 宿主与 UTC 不同日的时段（如 UTC+8 的 00:00–08:00）会把 Today 补成宿主日期，发布时间偏一天。
            // 这里按 UTC 日历日补全，时区换算仍交给紧随其后的具名 parseTime（按 metadata.timezoneOffset）。
            const now = new Date();
            const utcToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
            const utcDate = (date: Date) =>
              [
                String(date.getUTCDate()).padStart(2, "0"),
                String(date.getUTCMonth() + 1).padStart(2, "0"),
                date.getUTCFullYear(),
              ].join("/");
            q = q.replace("Today", utcDate(utcToday));
            q = q.replace("Yesterday", utcDate(new Date(utcToday.getTime() - 86_400_000)));
            return q;
          },
          { name: "parseTime", args: ["dd/MM/yyyy HH:mm"] },
        ],
      },
      size: { selector: "div.size" },
      seeders: {
        text: 0,
        selector: 'span[title*="Seeders"]',
        attr: "title",
        filters: [(q: string) => q.match(/Seeders: (\d+)/)?.[1] ?? "0"],
      },
      leechers: {
        text: 0,
        selector: 'span[title*="Leechers"]',
        attr: "title",
        filters: [(q: string) => q.match(/Leechers: (\d+)/)?.[1] ?? "0"],
      },
      category: { text: "Anime" },
    },
  },

  list: [
    {
      urlPattern: [/\.org\/$/, /\/\?page=/, "/?filter", "/search"],
      excludeUrlPattern: ["/view/"],
      mergeSearchSelectors: true,
      selectors: {
        keywords: { selector: 'input[name="q"]', attr: "value" },
      },
    },
  ],

  detail: {
    urlPattern: ["/view/"],
    selectors: {
      title: { selector: "h2#title" },
      link: { selector: ['a[href$=".torrent"]', 'a[href^="magnet:?xt="]'], attr: "href" },
    },
  },
};
