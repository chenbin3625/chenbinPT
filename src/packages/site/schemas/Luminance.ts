import { toMerged } from "es-toolkit";
import { ETorrentStatus, type ISiteMetadata, type IUserInfo, type ITorrent, type ISearchInput } from "../types";
import { GazelleBase } from "./Gazelle";
import { parseSizeString, definedFilters } from "../utils";
import { matchesSelector, selectElements } from "../utils/selector";

export const SchemaMetadata: Partial<ISiteMetadata> = {
  version: 0,
  search: {
    requestConfig: {
      url: "/torrents.php",
      responseType: "document",
      params: {
        action: "advanced",
      },
    },
    keywordPath: "params.title",
    selectors: {
      rows: { selector: "table#torrent_table:last tr:gt(0)" },
      id: {
        selector: ["a[href*='torrents.php?id=']"],
        attr: "href",
        filters: [(query: string) => query.match(/torrents\.php\?id=(\d+)/)![1]],
      },
      title: { selector: ["a[href*='torrents.php?id=']"] },
      subTitle: {
        // 将站点的大量标签做为副标题
        selector: ["div.tags"],
        elementProcess: (element: any) => {
          if (!element) return "";
          // 查找所有a元素
          const a_elements = element.querySelectorAll("a[href]");
          // 提取所有a元素中的文本内容
          const allText = Array.from(a_elements)
            .map((a: any) => (a.textContent || a.innerText || "").trim())
            .filter((text) => text.length > 0)
            .join(", ");

          return allText;
        },
      },
      url: { selector: ["a[href*='torrents.php?id=']"], attr: "href" },
      link: { selector: ["a[href*='torrents.php?action=download']"], attr: "href" },
      time: { selector: ["span.time[title]"], attr: "title", filters: [{ name: "parseTime" }] },
      // category: {},
      status: {
        selector: ["a[href*='torrents.php?action=download'] span"],
        text: ETorrentStatus.unknown,
        case: {
          "span.icon_disk_seed": ETorrentStatus.seeding, // 做种!
          "span.icon_disk_leech": ETorrentStatus.downloading, // 吸血!
          "span.icon_disk_grabbed": ETorrentStatus.inactive, // 未完成!
        },
      },
      progress: {
        selector: ["a[href*='torrents.php?action=download'] span"],
        text: 0,
        case: {
          "span.icon_disk_seed": 100,
        },
      },
      tags: [
        {
          name: "Free",
          selector:
            "span.icon[title*='Freeleech'], img[alt='Freeleech'], img[src*='freedownload.gif'], i.unlimited_leech",
          color: "blue",
        },
        {
          name: "2xUp",
          selector: "span.icon[title*='DoubleSeed'], img[alt='DoubleSeed'], img[src*='doubleseed.gif']",
          color: "lime",
        },
      ],
    },
  },

  userInfo: {
    pickLast: ["id"],
    process: [
      {
        requestConfig: { url: "/", responseType: "document" },
        fields: ["id"],
      },
      {
        requestConfig: {
          url: "/user.php",
          params: {/* id: flushUserInfo.id */},
          responseType: "document",
        },
        assertion: { id: "params.id" },
        fields: [
          "name",
          "joinTime",
          "lastAccessAt",
          "uploaded",
          "downloaded",
          "levelName",
          "bonus",
          "ratio",
          "uploads",
          "bonusPerHour",
          "seeding",
          "seedingSize",
          "messageCount",
          "posts",
        ],
      },
    ],
    selectors: {
      // "/user.php?id="
      id: {
        selector: ["a.username"],
        attr: "href",
        filters: [{ name: "querystring", args: ["id"] }],
      },
      name: { selector: ["a.username"] },
      joinTime: {
        selector: ["ul.stats > li:contains('Joined:') > span.time"],
        attr: "title",
        filters: [{ name: "parseTime" }],
      },
      lastAccessAt: {
        selector: ["ul.stats > li:contains('Last Seen:') > span"],
        attr: "title",
        filters: [{ name: "parseTime" }],
      },
      uploaded: {
        selector: ["ul.stats > li:contains('Uploaded:')"],
        filters: [(query: string) => parseSizeString(query.split(":")[1].trim().replace(/,/g, "") || "0")],
      },
      downloaded: {
        selector: ["ul.stats > li:contains('Downloaded:')"],
        filters: [(query: string) => parseSizeString(query.split(":")[1].trim().replace(/,/g, "") || "0")],
      },
      levelName: {
        selector: ["span.rank", "ul.stats > li:contains('Class:')"],
        switchFilters: {
          "ul.stats > li:contains('Class:')": [{ name: "split", args: [":", 1] }],
        },
      },
      bonus: {
        selector: ["div[id='bonusdiv'] > h4", "h4:contains('Credits:')"],
        filters: [(query: string) => parseFloat(query.split(":")[1].trim().replace(/,/g, "") || "0")],
      },
      ratio: {
        selector: ["ul.stats > li:contains('Ratio:') > span"],
        filters: [
          (query: string) => {
            if (query === "∞") return -1; // Infinity 不能通过 sendMessage 传递，会导致无返回，使用 -1 替代，前端会自动处理的
            const ratioStr = query.replace(/,/g, "");
            return definedFilters.parseNumber(ratioStr);
          },
        ],
      },
      uploads: {
        selector: ["ul.stats > li[title]:contains('Uploaded:')"],
        filters: [{ name: "split", args: ["[", 0] }, { name: "parseNumber" }],
      },
      bonusPerHour: {
        // 没找到显示的地方，通过log计算出来
        selector: ["div[id='bonuslog']"],
        elementProcess: (element: HTMLElement) => {
          if (!element) return 0;

          // E-5：innerHTML 序列化出来的换行标签是 <br>（不带斜杠），
          // 早先按字面量 "<br/>" split 永远不生效，find 会检查整段日志并取到任意一条记录；
          // 改按 /<br\s*\/?>/i 切分后才真正逐行查找，且要求该行确实含 "hrs"。
          const logLine = element.innerHTML.split(/<br\s*\/?>/i).find((log) => log.includes("hrs"));
          // 符号必须纳入捕获组：扣款行 "-500.0 credits" 若丢掉负号会得到正收益（错误的时魔）
          const creditsMatch = logLine?.match(/\|\s*([+-]?[\d.,]+)\s*credits\s*\|/);
          const credits = creditsMatch ? parseFloat(creditsMatch[1].replace(/,/g, "")) : 0;
          return credits / 24;
        },
      },
      seeding: {
        selector: ["a[id='nav_seeding'] span[id='nav_seeding_r']", "ul.stats > li:contains('Seeding:')"],
        switchFilters: {
          "a[id='nav_seeding'] span[id='nav_seeding_r']": [
            (query: string) => parseInt(query.trim().replace(/,/g, "") || "0"),
          ],
          "ul.stats > li:contains('Seeding:')": [{ name: "split", args: ["(", 0] }, { name: "parseNumber" }],
        },
      },
      seedingSize: { selector: "ul.stats > li:contains('Seeding Size:')", filters: [{ name: "parseSize" }] },
      messageCount: {
        selector: ":self",
        elementProcess: (doc: Document) => {
          // https://github.com/Empornium/Luminance/blob/23b568c157a58f36305cf447a3617bf2e4a2ca2e/application/Templates/snippets/header_bottom.html.twig#L93
          const messageEls = selectElements("a[onmousedown*='inbox'], a[onmousedown*='staffpm']", doc);
          return messageEls.reduce((sum, el) => sum + definedFilters.parseNumber(el.textContent), 0);
        },
      },
      posts: { selector: "ul.stats > li:contains('Forum Posts:')", filters: [{ name: "parseNumber" }] },
    },
  },

  list: [
    {
      urlPattern: ["/torrents\\.php(?!\\?id=\\d+$)"],
    },
  ],

  detail: {
    urlPattern: ["/torrents\\.php\\?id=\\d+"],
    selectors: {
      title: { selector: ["#content > .details > h2", "table.torrent_table tr[id] strong"] },
      id: {
        selector: ["a[href*='/torrents.php?action=download']"],
        attr: "href",
        filters: [(query: string) => query.match(/id=(\d+)/)![1]],
      },
      link: {
        selector: ["a[href*='/torrents.php?action=download']"],
        attr: "href",
      },
    },
  },
};

export default class Luminance extends GazelleBase {
  protected guessSearchFieldIndexConfig(): Record<string, string[]> {
    return {
      size: ["td:has(a[href*='order_by=size'])", "td:contains('Size')"], // 大小
      seeders: ["td:has(a[href*='order_by=seeders'])"], // 种子数
      leechers: ["td:has(a[href*='order_by=leechers'])"], // 下载数
      completed: ["td:has(a[href*='order_by=snatched'])"], // 完成数
      comments: ["td:contains('Comm')", "td:has(i.fa-comment)"], // 评论数
      author: ["td:contains('Uploader')"], // 上传者
    } as Record<keyof ITorrent, string[]>;
  }

  public override async transformSearchPage(
    doc: Document | object | any,
    searchConfig: ISearchInput,
  ): Promise<ITorrent[]> {
    let { keywords, searchEntry, requestConfig } = searchConfig;

    // 返回是 Document 的情况才自动生成选择器
    if (doc instanceof Document) {
      // 自动生成的选择器写入局部副本，避免写回共享的 metadata.search.selectors (P2-15)
      searchEntry = { ...searchEntry, selectors: { ...(searchEntry?.selectors ?? {}) } };

      // 如果配置文件没有传入 search 的选择器，则我们自己生成
      const legacyTableSelector = "table#torrent_table:last";

      // 生成 rows的
      if (!searchEntry!.selectors?.rows) {
        searchEntry!.selectors!.rows = {
          selector: `${legacyTableSelector} tr:gt(0)`,
        };
      }

      // 对于 Luminance，一般来说，表的第一行应该是标题行，即 ` > tr:nth-child(1)`
      const headSelector = `${legacyTableSelector} tr:first > td`;
      const headAnother = selectElements(headSelector, doc) as HTMLElement[];

      // 原实现外层循环缺少 break（last-match-wins），这里反序遍历、命中即跳出，结果等价且只需扫描一次
      // guessSearchFieldIndexConfig() 提到循环外只调用一次
      const guessSearchFieldIndexEntries = Object.entries(this.guessSearchFieldIndexConfig()).reverse();

      headAnother.forEach((element, elementIndex) => {
        // 比较好处理的一些元素，都是可以直接获取的
        let updateSelectorField;
        for (const [dectField, dectSelector] of guessSearchFieldIndexEntries) {
          let matched = false;
          for (const dectFieldElement of dectSelector) {
            if (matchesSelector(element, dectFieldElement)) {
              matched = true;
              break;
            }
          }
          if (matched) {
            updateSelectorField = dectField;
            break;
          }
        }

        if (updateSelectorField) {
          // @ts-expect-error
          // 原因：updateSelectorField 是运行时推断出的动态字段名，selectors 的类型没有字符串索引签名
          searchEntry.selectors[updateSelectorField] = toMerged(
            {
              selector: [`> td:eq(${elementIndex})`],
            },
            // @ts-expect-error
            // 原因：同上，读取同一个动态字段（可能不存在，故用 || {} 兜底）
            searchEntry.selectors[updateSelectorField] || {},
          );
        }
      });
    }

    // !!! 其他一些比较难处理的，我们把他 hack 到 parseWholeTorrentFromRow 中 !!!
    return await super.transformSearchPage(doc, { keywords, searchEntry, requestConfig });
  }

  public override async getTorrentDownloadLink(torrent: ITorrent): Promise<string> {
    // 种子链接格式是 torrent.php?id=123
    return this.getTorrentDownloadLinkFactory("id")(torrent);
  }

  protected async parseUserInfoForSeedingSize(
    flushUserInfo: Partial<IUserInfo>,
    dataDocument: Document,
  ): Promise<Partial<IUserInfo>> {
    // 对有 Seeding Size 行的站点直接解析对应元素
    let seedingSize =
      this.metadata.userInfo?.selectors?.seedingSize &&
      this.getFieldData(dataDocument, this.metadata.userInfo.selectors.seedingSize); // 在 elementQuery 内进行大小解析

    flushUserInfo.seedingSize = seedingSize;

    if (!seedingSize) {
      // 否则则尝试解析做种列表计算获取（M-10 / L-4：失败不作废其它字段，见 GazelleBase.mergeSeedingSizeSafely）
      flushUserInfo = await this.mergeSeedingSizeSafely(flushUserInfo);
    }

    return flushUserInfo;
  }
}
