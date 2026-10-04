import { matchesSelector, selectElements } from "../utils/selector";
import { toMerged } from "es-toolkit";

import PrivateSite from "./AbstractPrivateSite";
import {
  parseValidTimeString,
  parseSizeString,
  parseTimeToLiveToDate,
  mapWithConcurrency,
  logMessage,
  siteErrorLogData,
} from "../utils";
import {
  ETorrentStatus,
  EResultParseStatus,
  NoTorrentsError,
  type ISiteMetadata,
  type ITorrent,
  type ISearchInput,
  type IUserInfo,
} from "../types";

/**
 * Gazelle 常用工具函数
 */
export const GazelleUtils = {
  /**
   * 提取种子属性并过滤
   * @param tags
   * @param tagKeywords
   * @param delimiter
   * @returns filtered tags
   */
  extractTags(tags: string, tagKeywords: string[] = [], delimiter: string = " / "): string {
    const tagParts = tags.split(delimiter);
    if (tagParts.length < 1) return "";

    return GazelleUtils.filterTags(tagParts, tagKeywords).join(delimiter);
  },

  /**
   * 过滤种子属性
   * @param tagParts
   * @param tagKeywords
   * @returns filtered tags
   */
  filterTags(tagParts: string[], tagKeywords: string[] = []): string[] {
    const commonTagKeywords = ["Freeleech", "Neutral", "Seeding", "Snatched", "Reported", "Trumpable"];
    const filteredParts: string[] = [];
    // 只保留种子自身属性
    tagParts.forEach((tag) => {
      if (![...tagKeywords, ...commonTagKeywords].some((keyword) => tag.toLowerCase().includes(keyword.toLowerCase())))
        filteredParts.push(tag.trim());
    });
    return filteredParts;
  },

  /**
   * 生成 title 的 elementProcess
   * @param tdSelector
   * @param extractTagsFunc
   * @returns elementProcess
   */
  genTitleElementProcess({
    tdSelector = "td:has(a[href*='torrents.php?id=']):has(.tags)",
    extractTagsFunc,
  }: {
    tdSelector?: string;
    extractTagsFunc?: (tags: string) => string;
  } = {}) {
    const extractTags = extractTagsFunc ?? GazelleUtils.extractTags;
    return (row: HTMLElement): string => {
      // 匹配信息格
      const cell = row.querySelector(tdSelector);
      // E-10：站点模板（或非种子行）可能没有该单元格，缺失时按「本行没有标题」降级；
      // 下一行的 torrentLink 同样有守卫，这里缺了守卫会在 cell!.cloneNode 直接抛 TypeError。
      if (!cell) return "";

      const clone = cell.cloneNode(true) as HTMLElement;

      // 对于 Gazelle，一般第一个种子页链接对应的 <a> 会包含标题
      const torrentLink = clone.querySelector("a[href*='torrents.php?id=']");
      if (!torrentLink) return "";
      const title = torrentLink.textContent;

      // 移除标题行及之前的元素，只保留后面的属性文本
      let node = torrentLink.previousSibling;
      while (node) {
        const prev = node.previousSibling;
        node.remove();
        node = prev;
      }
      torrentLink.remove();
      clone.querySelectorAll("span").forEach((e) => e.remove());

      let prop = "";
      // [WEB] [2026] [2026.01.01] [WEB / FLAC / Freeleech!]
      const matches = Array.from(clone.textContent.trim().matchAll(/\[([^\]]+)\]/g));
      if (matches.length > 0) {
        prop = matches
          .map((m) => {
            const tags = extractTags(m[1]);
            return tags ? `[${tags}]` : "";
          })
          .filter(Boolean)
          .join(" ");
      }

      // 获取艺术家信息
      const artistEls = Array.from(row.querySelectorAll("a[href*='artist.php']"));
      const artists = artistEls
        .map((el) => el.textContent.trim())
        .filter(Boolean)
        .join(" & ");

      return [artists && `${artists} -`, title, prop].filter(Boolean).join(" ");
    };
  },
};

const baseRowSelector = { selector: "table.torrent_table tr:gt(0)" };
const baseTimeSelector = {
  text: 0,
  elementProcess: (element: HTMLElement) => {
    let time: number | string = 0;
    try {
      const AccurateTimeAnother = element.querySelector("span[title], time[title]");
      if (AccurateTimeAnother) {
        time = parseValidTimeString(AccurateTimeAnother.getAttribute("title")!);
      } else if (element.getAttribute("title")) {
        time = parseValidTimeString(element.getAttribute("title")!);
      } else {
        // 2 mins ago or Just now
        time = element.innerText.trim();
        if (time.toLowerCase().includes("just now")) {
          time = "0 seconds";
        }
        time = parseTimeToLiveToDate(time);
      }
    } catch (e) {
      // P1-5：时间字段解析失败时回落为已获取的原始值（0 或原始文本），保持既有行为不抛出。
      // 该函数对每一行种子都会执行，属于高频良性降级路径，因此刻意只用 console.debug，
      // 不写入 logger 通道，避免一次搜索就刷满日志环形缓冲。
      console.debug("[PTD] Gazelle parse row time failed, fallback to raw value:", time, e);
    }
    return time;
  },
};

const detailAttr = "isDetailPage";

type TList = Required<ISiteMetadata>["list"][number];

export const commonPagesList: TList = {
  urlPattern: [/\/torrents\.php(?!.*(?:\bid=|torrentid=))/, "/collages\\.php\\?id=\\d+", "/artist\\.php\\?id=\\d+"],
};

export const detailPageList: TList = {
  urlPattern: [/\/torrents\.php\?(?:.*&)?(\bid|torrentid)=\d+/],
  selectors: {
    // 从整个页面获取种子组信息
    keywords: { selector: ["span[dir='ltr']"] },
    title: { selector: ["div > h2"] },

    rows: {
      ...baseRowSelector,
      // 向第一个 row 添加属性，用于表示匹配到了详情页
      filter: (rows: HTMLElement[] | null): HTMLElement[] | null => {
        if (Array.isArray(rows) && rows.length > 0) {
          rows[0].dataset[detailAttr] = "1";
        }
        return rows;
      },
    },
    time: {
      ...baseTimeSelector,
      selector: "+tr span.time", // 在下一个 tr 里（tr.torrentdetails)
    },
  },
};

export const top10PageList: TList = {
  urlPattern: ["/top10\\.php"],
  excludeUrlPattern: [/\/top10\.php\?type=(?!torrents\b).*/], // 只解析种子 Top 10
  selectors: {
    rows: {
      ...baseRowSelector,
      /**
       * 不同站点的 Top 10 种子行可能使用不同的 class，但基本上都是单种行样式
       * 为了保证这些行都能被搜索方法解析，统一替换为单种行的 class
       */
      filter: (rows: HTMLElement[] | null): HTMLElement[] | null => {
        if (Array.isArray(rows)) {
          rows.forEach((row) => {
            row.className = "torrent";
          });
        }
        return rows;
      },
    },
  },
};

type boxName = "stats" | "community" | "personal";

const BoxName: Record<boxName, string[]> = {
  stats: ["Stats", "Statistics"],
  personal: ["Personal"],
  community: ["Community"],
} as const;

function genStatBoxSelector(section: string | string[], itemSel: string | string[], suffixSel?: string): string[] {
  const sections = ([] as string[]).concat(section);
  const itemSels = ([] as string[]).concat(itemSel);
  return sections.flatMap((s) =>
    itemSels.map(
      (iSel) => `div:contains('${s}') + ul.stats > li:contains('${iSel}')${suffixSel ? ` ${suffixSel}` : ""}`,
    ),
  );
}

/**
 * Gazelle 模板默认配置，对于大多数GZ站点都通用
 * 如果站点支持 JSON API 且数据完整，则应该使用 GazelleJSONAPI
 */
export const SchemaMetadata: Partial<ISiteMetadata> = {
  version: 0,
  search: {
    keywordPath: "params.searchstr",
    requestConfig: {
      url: "/torrents.php",
      responseType: "document",
      params: { searchsubmit: 1 },
    },
    selectors: {
      // seeders, leechers 等信息由 transformSearchPage 根据搜索结果自动生成
      rows: baseRowSelector,
      id: {
        // 优先从下载链接获取 id，可以确保获取到的是种子 id 而不是种子组 id
        selector: ["a[href*='torrents.php?action=download']:first", "a[href*='torrents.php?id=']"],
        attr: "href",
        filters: [{ name: "querystring", args: ["torrentid", "id"] }],
      },
      title: {
        selector: ":self",
        elementProcess: GazelleUtils.genTitleElementProcess(),
      },
      subTitle: {
        selector: [".tags", "> td:has(a[href*='torrents.php']) a:not(span a):last"],
        switchFilters: {
          // 对应单种行，直接返回 tags
          ".tags": [],
          // 对应组内种子，提取并返回种子属性
          "> td:has(a[href*='torrents.php']) a:not(span a):last": [GazelleUtils.extractTags],
        },
      },
      url: {
        selector: ["a[href*='torrents.php?id=']", "a[href*='torrents.php?torrentid=']"],
        attr: "href",
      },
      link: { selector: "a[href*='torrents.php?action=download']:first", attr: "href" },
      // TODO category: {}
      time: baseTimeSelector,
      progress: { text: 0 },
      status: { text: ETorrentStatus.unknown },
      tags: [{ selector: "strong:contains('Freeleech!')", name: "Free", color: "blue" }],
    },
  },

  list: [
    {
      ...commonPagesList,
    },
    {
      ...detailPageList,
    },
    {
      ...top10PageList,
    },
  ],

  userInfo: {
    pickLast: ["id"],
    process: [
      {
        requestConfig: { url: "/index.php", responseType: "document" },
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
          "messageCount",
          "uploaded",
          "downloaded",
          "ratio",
          "levelName",
          "bonus",
          "joinTime", // Gazelle 基础项
          "lastAccessAt",
          "seeding",
          "seedingSize",
          "uploads",
        ],
      },
    ],
    selectors: {
      // "page": "/index.php",
      id: {
        selector: ["a.username[href*='user.php']:first"],
        attr: "href",
        filters: [{ name: "querystring", args: ["id"] }],
      },
      name: {
        selector: ["a.username[href*='user.php']:first"],
      },
      messageCount: {
        selector: ":self",
        elementProcess: (doc: Document) => {
          const notifRegex = /have (\d+|a) new/;
          let messages = 0;

          const parseMessage = (el: Element) => {
            const match = el.textContent.match(notifRegex);
            messages += match ? (match[1] === "a" ? 1 : parseInt(match[1])) : 0;
          };

          // 1. Traditional
          const alert = doc.querySelector("#alerts");
          if (alert) {
            const alerts = alert.querySelectorAll("a[href*='inbox.php'], a[href*='staffpm.php']");
            alerts.forEach(parseMessage);
          }

          // 2. Pop-Up
          if (!alert || !messages) {
            const notifSpans = doc.querySelectorAll(
              ".noty-notification[data-noty-url*='inbox.php'], .noty-notification[data-noty-url*='staffpm.php']",
            );
            notifSpans.forEach(parseMessage);
          }

          return messages;
        },
      },
      // "page": "/user.php?id=$user.id$",
      uploaded: {
        selector: genStatBoxSelector(BoxName.stats, "Uploaded"),
        filters: [{ name: "parseSize" }],
      },
      downloaded: {
        selector: genStatBoxSelector(BoxName.stats, "Downloaded"),
        filters: [{ name: "parseSize" }],
      },
      ratio: {
        selector: genStatBoxSelector(BoxName.stats, "Ratio:"),
        filters: [{ name: "parseNumber" }],
      },
      levelName: {
        selector: genStatBoxSelector(BoxName.personal, "Class:"),
        filters: [{ name: "split", args: [":", 1] }],
      },
      bonus: {
        selector: genStatBoxSelector(BoxName.stats, "Bonus Points:"),
        filters: [{ name: "parseNumber" }],
      },
      joinTime: {
        selector: genStatBoxSelector(BoxName.stats, "Joined:", "> span"),
        attr: "title",
        filters: [{ name: "parseTime" }],
      },
      lastAccessAt: {
        selector: genStatBoxSelector(BoxName.stats, ["Last seen", "Last Seen"], "> span"),
        attr: "title",
        filters: [{ name: "parseTime" }],
      },
      uploads: {
        selector: genStatBoxSelector(BoxName.community, "Uploaded"),
        filters: [{ name: "parseNumber" }],
      },
    },
  },
};

export class GazelleBase extends PrivateSite {
  // 合成下载链接所需的用户级凭据（authkey/torrent_pass）的实例内缓存，见 getDownloadAuthParams
  private _downloadAuthParams?: { authkey: string; torrentPass: string };

  // Gazelle 通用做种量获取方法，用于先前方法没获取到 seedingSize 的情况
  protected async getSeedingSize(userId: number, sizeIndex: number = 0): Promise<Partial<IUserInfo>> {
    const userSeedingTorrent: Partial<IUserInfo> = { seedingSize: 0 };
    const maxPages = 50; // 硬上限，防止分页信息异常时无限翻页
    const concurrency = 4;

    // 保证并发请求之间仍然满足站点 requestDelay 的请求间隔
    const throttle = this.createRequestThrottle(this.metadata.userInfo?.requestDelay);

    // 首页：获取总页数，并解析 size 列下标
    await throttle();
    const firstPageDocument = await this.getUserTorrentList(userId, 1);

    // 更新最大页数
    const rawPageCount = this.getFieldData(firstPageDocument, {
      // https://github.com/WhatCD/Gazelle/blob/63b337026d49b5cf63ce4be20fdabdc880112fa3/classes/format.class.php#L296
      selector: ["a[href*='torrents.php?page=']:contains('Last'):first"],
      attr: "href",
      filters: [{ name: "querystring", args: ["page"] }, (query: string) => (query ? parseInt(query) : -1)],
    });
    // 原实现在拿不到 Last 链接时会退化为只解析首页
    const pageCount =
      typeof rawPageCount === "number" && Number.isFinite(rawPageCount)
        ? Math.max(1, Math.min(rawPageCount, maxPages))
        : 1;

    if (sizeIndex === 0) {
      const targetTd: Element = this.getFieldData(firstPageDocument, {
        selector: [
          "tr.colhead > td > a:contains('Size')",
          "tr.colhead > td > a[href*='Size']",
          "tr.colhead > td > a[href*='size']", // OPS
          "tr.colhead > td > a[href*='s4']", // JPS
        ],
        elementProcess: (el: Element) => el.parentNode,
      });
      if (targetTd && targetTd.parentNode) {
        const allTds = Array.from(targetTd.parentNode.children);
        sizeIndex = allTds.indexOf(targetTd as Element);
      } else {
        return userSeedingTorrent;
      }
    }

    // 按行收集每页的做种体积，最后按页序累加，保证浮点累加顺序与串行实现一致
    const collectSeedingSizes = (TListDocument: Document): number[] => {
      const sizes: number[] = [];
      const torrentAnothers = selectElements("tr.torrent", TListDocument);
      torrentAnothers.forEach((element) => {
        const sizeAnother = selectElements(`td:nth-child(${sizeIndex + 1})`, element);
        // 该行没有对应列（colspan / 结构异常）时 Sizzle 返回空数组，
        // 空数组的 length >= 0 恒为真会让 sizeAnother[0] 变成 undefined 并抛出 TypeError，
        // 从而整次用户信息刷新失败，因此这里必须要求真正取到了元素。
        if (sizeAnother && sizeAnother.length > 0) {
          sizes.push(parseSizeString((sizeAnother[0] as HTMLElement).innerText.trim().replace(/,/g, "")));
        }
      });
      return sizes;
    };

    const pageSizes: number[][] = [collectSeedingSizes(firstPageDocument)];
    if (pageCount > 1) {
      const restPages = Array.from({ length: pageCount - 1 }, (_, index) => index + 2);
      pageSizes.push(
        ...(await mapWithConcurrency(restPages, concurrency, async (page) => {
          await throttle();
          return collectSeedingSizes(await this.getUserTorrentList(userId, page));
        })),
      );
    }

    for (const sizes of pageSizes) {
      for (const size of sizes) {
        userSeedingTorrent.seedingSize! += size;
      }
    }

    return userSeedingTorrent;
  }

  // 起始页面为 1
  // https://github.com/WhatCD/Gazelle/blob/63b337026d49b5cf63ce4be20fdabdc880112fa3/sections/torrents/user.php#L29-L35
  protected async getUserTorrentList(userId: number, page: number = 1, type: string = "seeding"): Promise<Document> {
    const { data: TListDocument } = await this.request<Document>({
      url: "/torrents.php",
      params: { userid: userId, page, type },
      responseType: "document",
    });
    return TListDocument;
  }

  protected getTorrentDownloadLinkFactory(torrentIdParam: string): (torrent: ITorrent) => Promise<string> {
    return async (torrent: ITorrent): Promise<string> => {
      const raw = await super.getTorrentDownloadLink(torrent);
      const url = URL.parse(raw);
      if (!url) return raw;

      const params = url.searchParams;
      if (params.get("action") === "download") return raw; // 已经是站点给出的真实下载链接（通常已带 authkey/torrent_pass）

      // 对 Gazelle 站点，如果前端拖拽功能发来的种子链接是 torrent.php?${torrentIdParam}=123 的形式，
      const torrentId = params.get(torrentIdParam);
      if (!torrentId) return raw;

      const downloadURL = new URL(url.pathname, this.url);
      downloadURL.searchParams.set("action", "download");
      downloadURL.searchParams.set("id", torrentId);

      // E-8：合成链接必须带上用户级凭据 authkey/torrent_pass，
      // 否则 Gazelle 会返回登录页 HTML，跟随重定向的下载器会把 HTML 当种子保存。
      // 抓取凭据时用去掉用户后缀的页面 URL：后缀是给下载端点用的，页面请求不需要它。
      const appendix = this.userConfig.downloadLinkAppendix ?? "";
      const pageUrl = appendix && raw.endsWith(appendix) ? raw.slice(0, -appendix.length) : raw;

      const { authkey, torrentPass } = await this.getDownloadAuthParams(pageUrl);
      if (authkey) downloadURL.searchParams.set("authkey", authkey);
      if (torrentPass) downloadURL.searchParams.set("torrent_pass", torrentPass);

      if (!authkey && !torrentPass) {
        logMessage(
          `[Site] ${this.name} synthesized torrent download link without authkey/torrent_pass`,
          { site: this.metadata.id, url: downloadURL.pathname },
          "warn",
        );
      }

      // 合成出来的是一个全新的 URL（base 已把用户后缀追加在了被丢弃的 raw 上），
      // 这里必须补一次，否则用户配置的 downloadLinkAppendix 在合成路径上静默失效。
      return appendix ? `${downloadURL.toString()}${appendix}` : downloadURL.toString();
    };
  }

  /**
   * 获取合成下载链接所需的用户级凭据（authkey / torrent_pass）。
   *
   * Gazelle 的下载鉴权依赖这两个参数，站点上任意一条真实下载链接都带着它们，
   * 因此优先从传入页面上真实存在的下载链接里提取；结果在实例内缓存，避免一次会话内重复请求。
   * 取不到时返回空值，由调用方按「无凭据」处理（与修复前行为一致，不会因为抓取失败而抛错）。
   */
  protected async getDownloadAuthParams(pageUrl?: string): Promise<{ authkey: string; torrentPass: string }> {
    if (this._downloadAuthParams) return this._downloadAuthParams;

    const noAuthParams = { authkey: "", torrentPass: "" };
    try {
      const { data } = await this.request<Document>({
        url: pageUrl ?? this.metadata.search?.requestConfig?.url ?? "/torrents.php",
        responseType: "document",
      });

      const realLink = this.getFieldData(
        data,
        this.metadata.search?.selectors?.link ?? {
          selector: ["a[href*='torrents.php?action=download']"],
          attr: "href",
        },
      ) as string;

      const realLinkParams = URL.parse(realLink ?? "")?.searchParams;
      const authkey = realLinkParams?.get("authkey") ?? "";
      const torrentPass = realLinkParams?.get("torrent_pass") ?? "";
      if (authkey && torrentPass) {
        this._downloadAuthParams = { authkey, torrentPass };
        return this._downloadAuthParams;
      }
    } catch (e) {
      logMessage(
        `[Site] ${this.name} getDownloadAuthParams failed`,
        { site: this.metadata.id, error: siteErrorLogData(e) },
        "debug",
      );
    }

    return noAuthParams;
  }
}

export default class Gazelle extends GazelleBase {
  protected get torrentClasses(): Record<"group" | "unGroupTorrent", string[]> {
    return {
      group: ["group", "group_redline"], // 种子组行
      unGroupTorrent: ["torrent", "torrent_redline"], // 单种行
    };
  }

  protected guessSearchFieldIndexConfig(): Record<string, string[]> {
    return {
      time: ["a[href*='order_by=time']"], // 发布时间
      size: ["a[href*='order_by=size']", "td:contains('Size')"], // 大小
      seeders: ["a[href*='order_by=seeders']", "[alt='Seeders']", "img[src*='seeders']"], // 做种数
      leechers: ["a[href*='order_by=leechers']", "[alt='Leechers']", "img[src*='leechers']"], // 下载数
      completed: ["a[href*='order_by=snatched']", "[alt='Snatches']", "img[src*='snatched']"], // 完成数
    } as Record<keyof ITorrent, string[]>;
  }

  public override async transformSearchPage(doc: Document, searchConfig: ISearchInput): Promise<ITorrent[]> {
    // 每次页面解析开始时重建行级选择器缓存
    this.resetRowElementQueryCache();

    let { keywords, searchEntry, requestConfig } = searchConfig;

    // 自动生成的选择器写入局部副本，避免写回共享的 metadata.search.selectors (P2-15)
    searchEntry = { ...searchEntry, selectors: { ...(searchEntry?.selectors ?? {}) } };

    // 如果配置文件没有传入 search 的选择器，则我们自己生成
    const legacyTableSelector = "table.torrent_table:last";

    // 生成 rows的
    if (!searchEntry!.selectors?.rows) {
      searchEntry!.selectors!.rows = {
        selector: `${legacyTableSelector} tr:gt(0)`,
      };
    }

    // 对于 Gazelle ，一般来说，表的第一行应该是标题行，即 ` > tr:nth-child(1)`
    const headSelector = `${legacyTableSelector} tr:first > td`;
    const headAnother = selectElements(headSelector, doc) as HTMLTableCellElement[];
    let colSpan = 0;

    // 原实现外层循环缺少 break（last-match-wins），这里反序遍历、命中即跳出，结果等价且只需扫描一次
    // guessSearchFieldIndexConfig() 提到循环外只调用一次
    const guessSearchFieldIndexEntries = Object.entries(this.guessSearchFieldIndexConfig()).reverse();

    headAnother.forEach((element, elementIndex) => {
      // 比较好处理的一些元素，都是可以直接获取的
      let updateSelectorField: string | undefined;
      colSpan += Math.max(0, element.colSpan - 1); // 处理 colspan 的情况 (Gazelle-fork)
      for (const [dectField, dectSelector] of guessSearchFieldIndexEntries) {
        let matched = false;
        for (const dectFieldElement of dectSelector) {
          if (selectElements(dectFieldElement, element).length > 0 || matchesSelector(element, dectFieldElement)) {
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
            selector: [`> td:eq(${elementIndex + colSpan})`],
          },
          // @ts-expect-error
          // 原因：同上，读取同一个动态字段（可能不存在，故用 ?? {} 兜底）
          searchEntry.selectors[updateSelectorField] ?? {},
        );
      }
    });

    const rowsSelector = searchEntry!.selectors!.rows;
    let trs = this.findElementsBySelectors(rowsSelector.selector, doc) as HTMLTableRowElement[];
    if (rowsSelector.filter) {
      trs = rowsSelector.filter(trs);
    }

    // 如果没有搜索到种子，则抛出 NoTorrentsError
    if (trs.length === 0) {
      throw new NoTorrentsError();
    }

    // 如果是详情页，直接返回当前种子组的种子
    // 这个属性由 detailPageList.rows.filter 负责添加
    if (trs[0].dataset[detailAttr] === "1") {
      return this.transformGroupTorrents(doc.documentElement, trs, {
        keywords,
        searchEntry,
        requestConfig,
      });
    }

    // 遍历数据行
    const torrents: ITorrent[] = [];
    const groupClasses = [...this.torrentClasses.group, ...this.torrentClasses.unGroupTorrent];
    for (let i = 0; i < trs.length; i++) {
      const tr = trs[i];
      const nextTr = trs[i + 1];

      /**
       * 种子组信息行 + 组内种子行，顺序排列
       * <tr class="group">...</tr>
       * <tr class="group_torrent groupid_${id}">...</tr>
       */
      if (
        this.torrentClasses.group.some((className) => tr.classList.contains(className)) &&
        !(nextTr && groupClasses.some((className) => nextTr.classList.contains(className))) // 空组
      ) {
        // 取出此组内的所有种子
        const groupTorrentEls = getElUntilClass(trs, i, groupClasses);
        i += groupTorrentEls.length - 1;
        const groupTorrents = await this.transformGroupTorrents(tr, groupTorrentEls, {
          keywords,
          searchEntry,
          requestConfig,
        });
        torrents.push(...groupTorrents);
        continue;
      }

      /**
       * 单种行
       * <tr class="torrent">...</tr>
       */
      if (this.torrentClasses.unGroupTorrent.some((className) => tr.classList.contains(className))) {
        const torrent = await this.transformUnGroupTorrent(tr, { keywords, searchEntry, requestConfig });
        if (torrent) torrents.push(torrent);
      }

      // 其它没匹配到的 tr 可能包括站点自定义的非种子行，或者使用了别的自定义 class
      // 对于第二种情况，需要将对应 class 添加到 torrentClasses 中，或者在站点定义中覆盖相关方法
    }

    return torrents;
  }

  /**
   * 从种子组行获取种子组信息（标题等）
   * @param group
   * @param searchConfig
   * @returns 获取到的种子组信息
   */
  protected getTorrentGroupInfo(group: HTMLElement, searchConfig: ISearchInput): Partial<ITorrent> {
    /**
     * WhatCD/Gazelle 中可以从种子组行中获取到 title 和 category 信息 (.cats_col > .cats_music)
     * https://github.com/WhatCD/Gazelle/blob/63b337026d49b5cf63ce4be20fdabdc880112fa3/sections/torrents/browse.php#L565
     * 对于 Gazelle-fork，如有其它信息需要获取可以自行覆盖方法
     */
    return this.getFieldsData(group, searchConfig.searchEntry!.selectors!, ["title", "category"]);
  }

  protected async transformGroupTorrents(
    group: HTMLElement,
    torrentEls: HTMLTableRowElement[],
    searchConfig: ISearchInput,
  ): Promise<ITorrent[]> {
    // 获取组信息
    // E-10：组行与单种行的结构不同（部分站点自定义模板下可能取不到组信息），
    // 这里与下面的逐行解析保持一致降级为「记日志 + 用空组信息继续」，
    // 否则异常会逃出本方法，让整页搜索变成 parseError。
    let partTorrent: Partial<ITorrent> = {};
    try {
      partTorrent = this.getTorrentGroupInfo(group, searchConfig);
    } catch (e) {
      logMessage(
        `[Site] ${this.name} getTorrentGroupInfo failed`,
        { site: this.metadata.id, error: siteErrorLogData(e) },
        "warn",
      );
    }

    /**
     * 适配添加了 rowspan 的情况 (Gazelle-fork)
     * <tr class="group">
     *   <td class="poster_wraper" rowspan="2">
     *   ...
     * </tr>
     * <tr class="group_torrent groupid_${id}">...</tr>
     */
    let rowSpan = 0;
    if (group instanceof HTMLTableRowElement) {
      rowSpan = Array.from(group.querySelectorAll<HTMLTableCellElement>("td[rowspan]")).reduce(
        (acc, td) => acc + (td.rowSpan > 1 ? 1 : 0),
        0,
      );
    }

    const torrents: ITorrent[] = [];
    for (const groupTorrentEl of torrentEls) {
      // 对 link 结果做个检查，检查通过的再进入 parseRowToTorrent
      const link = this.getFieldData(groupTorrentEl, searchConfig.searchEntry!.selectors!.link!);
      if (!link) continue;

      // 处理 colspan 的情况
      // https://github.com/WhatCD/Gazelle/blob/63b337026d49b5cf63ce4be20fdabdc880112fa3/sections/torrents/browse.php#L644
      let padding = rowSpan;
      const colSpanTd = groupTorrentEl.querySelector<HTMLTableCellElement>("td[colspan]");
      if (colSpanTd) {
        padding += Math.max(0, colSpanTd.colSpan - 1);
      }

      for (let i = 0; i < padding; i++) {
        // 补全前面的单元格，使后续的 selector 能正常生效
        groupTorrentEl.insertCell(0);
      }

      try {
        const torrent = (await this.parseWholeTorrentFromRow(
          { ...partTorrent, link },
          groupTorrentEl,
          searchConfig,
        )) as ITorrent;
        torrents.push(torrent);
      } catch (e) {
        console.debug(`[PTD] site '${this.name}' parseWholeTorrentFromRow Error:`, e, groupTorrentEl);
      }
    }

    return torrents;
  }

  protected async transformUnGroupTorrent(
    torrentEl: HTMLTableRowElement,
    searchConfig: ISearchInput,
  ): Promise<ITorrent | null> {
    // 对 link 结果做个检查，检查通过的再进入 parseRowToTorrent
    const link = this.getFieldData(torrentEl, searchConfig!.searchEntry!.selectors!.link!);
    if (!link) return null;

    // 处理 colspan 的情况 (Gazelle-fork)
    const colSpanTd = torrentEl.querySelector<HTMLTableCellElement>("td[colspan]");
    if (colSpanTd) {
      for (let i = 0; i < colSpanTd.colSpan - 1; i++) {
        // 补全前面的单元格，使后续的 selector 能正常生效
        torrentEl.insertCell(0);
      }
    }

    try {
      const torrent = (await this.parseWholeTorrentFromRow({ link }, torrentEl, searchConfig)) as ITorrent;
      return torrent;
    } catch (e) {
      console.debug(`[PTD] site '${this.name}' parseWholeTorrentFromRow Error:`, e, torrentEl);
    }
    return null;
  }

  public override async getTorrentDownloadLink(torrent: ITorrent): Promise<string> {
    // 种子链接格式是 torrent.php?torrentid=123
    return this.getTorrentDownloadLinkFactory("torrentid")(torrent);
  }

  public override async getUserInfoResult(lastUserInfo: Partial<IUserInfo> = {}): Promise<IUserInfo> {
    const flushUserInfo = await super.getUserInfoResult(lastUserInfo);

    // E-2：按 NexusPHP 的既有模式加 status === success 守卫 + try/catch。
    // 基础抓取失败（needLogin/网络/CF）时 id 仍会从 pickLast 保留，
    // 若不判断状态就会对刚失败的站点再发 1-50 个请求，且这里抛错会逃出
    // 「总返回 IUserInfo」的方法契约（调用方 offscreen/utils/userInfo.ts 无 try/catch）。
    if (flushUserInfo.status === EResultParseStatus.success && flushUserInfo.id && !flushUserInfo.seedingSize) {
      try {
        return toMerged(flushUserInfo, await this.getSeedingSize(flushUserInfo.id as number));
      } catch (e) {
        logMessage(
          `[Site] ${this.name} getSeedingSize failed`,
          { site: this.metadata.id, error: siteErrorLogData(e) },
          "warn",
        );
      }
    }

    return flushUserInfo;
  }
}

function getElUntilClass<T extends Element>(allEl: T[], currentIndex: number, classNames: string[]): T[] {
  const result: T[] = [];

  for (let i = currentIndex; i < allEl.length; i++) {
    const el = allEl[i];
    result.push(el);

    const nextEl = allEl[i + 1];
    if (nextEl && classNames.some((className) => nextEl.classList.contains(className))) {
      break;
    }
  }

  return result;
}
