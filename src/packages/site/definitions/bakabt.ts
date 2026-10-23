/**
 * @JackettDefinitions https://github.com/Jackett/Jackett/blob/master/src/Jackett.Common/Indexers/Definitions/BakaBT.cs
 */
import PrivateSite from "../schemas/AbstractPrivateSite.ts";
import type { ISiteMetadata, ISearchInput, ITorrent } from "../types.ts";
import { definedFilters, buildCategoryOptionsFromDict } from "../utils.ts";

const categoryMap: Record<number, string> = {
  1: "Anime Series",
  2: "OVA",
  3: "Soundtrack",
  4: "Manga",
  5: "Anime Movie",
  6: "Live Action",
  7: "Artbook",
  8: "Music Video",
  9: "Light Novel",
};

export const siteMetadata: ISiteMetadata = {
  version: 1,
  id: "bakabt",
  name: "BakaBT",
  aka: ["BBT"],
  description: "BakaBT is a Private site for the Anime Community",
  tags: ["动漫"],
  timezoneOffset: "+0000",

  type: "private",
  schema: "AbstractPrivateSite",

  urls: ["uggcf://onxnog.zr/"],

  category: [
    {
      name: "类别",
      key: "category",
      options: buildCategoryOptionsFromDict(categoryMap),
      cross: { mode: "append", key: "c" },
    },
    {
      name: "成人内容",
      key: "hentai",
      notes: "请先在站点设置中启用 Browse -> Show adult content",
      options: [
        { name: "显示", value: 1 },
        { name: "不显示", value: 0 },
      ],
    },
  ],

  search: {
    keywordPath: "params.q",
    requestConfig: {
      url: "/browse.php",
      responseType: "document",
      params: {
        only: 0,
        incomplete: 1,
        lossless: 1,
        hd: 1,
        multiaudio: 1,
        bonus: 1,
        reorder: 1,
      },
    },
    advanceKeywordParams: {
      imdb: false,
    },
    selectors: {
      rows: {
        selector: ".torrents tr.torrent, .torrents tr.torrent_alt",
        filter: (rows: HTMLElement[] | null): HTMLElement[] | null => {
          if (!Array.isArray(rows)) return rows;
          return rows.filter((row) => {
            // E1b-C15：原实现用 `row.textContent === "Alternative versions: "` 精确比较（含尾随空格），
            // 站点只要改一个空格/换行，判定就恒为 false，被留下来的 torrent_alt 行会解析出标题为空的废条目。
            if (row.classList.contains("torrent_alt") && row.textContent?.trim() === "Alternative versions:") {
              return false;
            }
            return true;
          });
        },
      },
      id: { selector: ["a.title", "a.alt_title"], attr: "href", filters: [{ name: "split", args: ["/", 2] }] },
      title: { selector: ["a.title", "a.alt_title"], filters: [{ name: "trim" }] },
      subTitle: { selector: "span.tags" },
      url: { selector: ".peers a", attr: "href" },
      category: {
        text: "stub", // torrent_alt 行没有类别信息，会在后续方法处理
        selector: "span.torrent_icon",
        attr: "title",
      },
      time: {
        selector: ":self",
        elementProcess: (row: HTMLElement) => {
          // 对有 data-timestamp 属性的行直接返回时间戳
          if (row.dataset.timestamp) return parseInt(row.dataset.timestamp);

          // 其它版本行自身没有 data-timestamp 属性，需从子元素中获取
          const timeTd = row.querySelector(".added")! as HTMLElement;
          const timeSpan = timeTd.querySelector("span.datetime");
          if (timeSpan) {
            return parseInt((timeSpan as HTMLElement).dataset.timestamp!);
          }

          // 其它版本种子上传时间如为 today 或 yesterday，无法获取到时间戳，转为手动解析
          const currentDate = new Date();
          if (timeTd.textContent === "yesterday") {
            currentDate.setDate(currentDate.getDate() - 1);
          }
          return currentDate.getTime();
        },
      },
      size: { selector: ".size", filters: [{ name: "parseSize" }] },
      completed: {
        // E1b-C13：BakaBT 的 .peers 单元格文本形如 "123k / 12 / 3"（grabs / seeders / leechers），
        // 首段是 grabs 且可能带 k 缩写。原实现只 split + trim，得到 "123k" 字符串（ITorrent.completed 应为 number），
        // 排序/统计会得到 NaN。这里把 k 展开成数量级再转数字（兼容 "12.3k"）。
        selector: ".peers:first",
        filters: [
          { name: "split", args: ["/", 0] },
          { name: "trim" },
          (q: string) => {
            const text = String(q ?? "")
              .replace(/,/g, "")
              .trim();
            const value = Number.parseFloat(text);
            if (!Number.isFinite(value)) return 0;
            return /k$/i.test(text) ? Math.round(value * 1000) : value;
          },
        ],
      },
      seeders: { selector: ".peers a:nth-child(1)" },
      leechers: { selector: ".peers a:nth-child(2)" },
      tags: [
        {
          name: "Free",
          selector: "span.freeleech",
        },
        {
          name: "Bonus",
          selector: "span.bonus",
          color: "yellow",
        },
        {
          name: "Incomplete",
          selector: "span.incomplete",
          color: "black",
        },
        {
          name: "Hentai",
          selector: "span.hentai",
          color: "pink",
        },
      ],
    },
  },

  detail: {
    urlPattern: [/\/torrent\/(\d+)\/([^/]+)$/],
    selectors: {
      title: { selector: "div.title" },
      link: { selector: ".download_link", attr: "href" },
    },
  },

  userInfo: {
    pickLast: ["id"],
    process: [
      {
        requestConfig: { url: "/", responseType: "document" },
        selectors: {
          id: { selector: "a.username", attr: "href", filters: [{ name: "split", args: ["/", 2] }] },
        },
      },
      {
        requestConfig: { url: "/bonus.php", responseType: "document" },
        selectors: {
          bonusPerHour: { selector: "b.success", filters: [{ name: "parseNumber" }] },
        },
      },
      {
        requestConfig: { url: "/user/$id$/", responseType: "document" },
        assertion: { id: "url" },
        selectors: {
          name: { selector: "a.username" },
          levelName: {
            selector: "h2 > span",
            filters: [
              (query: string) => {
                // E1b-C16：原实现直接 `match(...)![2]`，文案不符合 "(X - Y)" 时 match 为 null，
                // 会抛 TypeError 让整次用户信息刷新变成 parseError；拿不到就退化为原始文本。
                const matched = query.match(/^\((.+?) - (.+?)\)$/);
                return matched ? matched[2] : query.trim();
              },
            ],
          },
          messageCount: { selector: "a[href='/inbox.php'] > strong", filters: [{ name: "parseNumber" }] },
          joinTime: {
            selector: "td:contains('Join date') + td > span.datetime",
            data: "timestamp",
            filters: [(query: string) => parseInt(query) * 1000],
          },
          lastAccessAt: {
            selector: "td:contains('Last seen') + td > span.datetime",
            data: "timestamp",
            filters: [(query: string) => parseInt(query) * 1000],
          },
          uploaded: {
            selector: "td:contains('Uploaded') + td",
            filters: [{ name: "split", args: ["-", 0] }, { name: "parseSize" }],
          },
          downloaded: {
            selector: "td:contains('Downloaded') + td",
            filters: [{ name: "split", args: ["-", 0] }, { name: "parseSize" }],
          },
          // E1-C2 / E15：站点用 "∞" 表示「无下载量（分享率无限）」。原实现把它映射成 -1 哨兵；
          // level.ts 的 fixRatio 现在会把 -1 视为 Infinity（D2 已修），但 -1 仍会被持久化进 userInfo
          // 并污染其它直接读取 ratio 的消费者（备份/导出/统计），语义上也不是真实分享率。
          // 因此这里不输出 ratio，交给引擎按 uploaded/downloaded 推导
          //（downloaded == 0 && uploaded > 0 → Infinity，UI 显示 ∞，等级判定同样正确）。
          bonus: { selector: "td:contains('Bonus Points') + td", filters: [{ name: "parseNumber" }] },
          uploads: { selector: "li#uploaded_tab > a", filters: [{ name: "parseNumber" }] },
          seeding: { selector: "li#active_tab > a", filters: [{ name: "parseNumber" }] },
          seedingSize: {
            selector: "div#tab_content > div#active table.torrents > tbody",
            elementProcess: (el: HTMLElement) => {
              const trs = el.querySelectorAll("tr");
              let seedingSize = 0;
              trs.forEach((tr) => {
                const sizeTd = tr.querySelector("td.size");
                if (!sizeTd) return;
                seedingSize += definedFilters.parseSize((sizeTd as HTMLElement).innerText);
              });
              return seedingSize;
            },
          },
        },
      },
    ],
  },

  levelRequirements: [
    {
      id: 1,
      name: "User",
    },
    {
      id: 2,
      name: "Power User",
      seedingSize: "25GB",
      downloaded: "25GB",
      ratio: 0.5,
      privilege: "View peer lists & report torrents; Access to RSS; Can make up to 5 torrent offers simultaneously.",
    },
  ],
};

export default class BakaBT extends PrivateSite {
  public override async transformSearchPage(
    doc: Document | object | any,
    searchConfig: ISearchInput,
  ): Promise<ITorrent[]> {
    const torrents = await super.transformSearchPage(doc, searchConfig);

    let lastCat: string | null = null;
    return torrents.map((tor) => {
      if (tor.category === "stub") {
        tor.category = lastCat ?? "";
        return tor;
      } else {
        lastCat = tor.category as string;
        return tor;
      }
    });
  }

  public override async getTorrentDownloadLink(torrent: ITorrent): Promise<string> {
    const link = await super.getTorrentDownloadLink(torrent);
    const mockRequestConfig = torrent.url?.startsWith("http") ? { url: torrent.url } : { baseURL: this.url };
    return this.fixLink(link, mockRequestConfig);
  }
}
