/**
 * @JackettDefinitions https://github.com/Jackett/Jackett/blob/master/src/Jackett.Common/Definitions/aidoruonline.yml
 */
import { omit, toMerged } from "es-toolkit";
import { ETorrentStatus, EResultParseStatus, type ISiteMetadata, type IUserInfo, NeedLoginError } from "../types";
import PrivateSite from "../schemas/AbstractPrivateSite";
import {
  buildCategoryOptionsFromList,
  classifySiteError,
  createDocument,
  logMessage,
  parseSizeString,
  siteErrorLogData,
} from "../utils";

export const siteMetadata: ISiteMetadata = {
  id: "aidoruonline",
  version: 1,
  name: "Aidoru!Online",
  tags: ["偶像"],
  collaborator: ["hyuan280"],

  type: "private",
  schema: "AidoruOnline",

  urls: ["uggcf://nvqbeh-bayvar.zr/"],

  category: [
    {
      name: "类别",
      key: "pcat",
      options: buildCategoryOptionsFromList(["Show All", "48G", "Games", "Stardust", "Other"]),
    },
    {
      name: "规格",
      key: "scat",
      options: [
        { name: "BD/DVDISO", value: "1" },
        { name: "BD/DVD-RIP", value: "2" },
        { name: "TV", value: "3" },
        { name: "Perf", value: "4" },
        { name: "PV", value: "5" },
        { name: "Webstream", value: "6" },
        { name: "Image", value: "7" },
        { name: "Audio", value: "8" },
        { name: "Album", value: "9" },
        { name: "Single", value: "10" },
        { name: "Radio", value: "11" },
        { name: "Misc", value: "12" },
      ],
      cross: { mode: "comma" },
    },
    {
      name: "标签",
      key: "tag",
      options: [
        { name: "Resurrected", value: "resd" }, // Torrents dead for over 6 months brought back to life
        { name: "Freeleech", value: "fl" },
        { name: "Subtitled", value: "subbed" },
      ],
      cross: { mode: "custom" },
      generateRequestConfig: (selectedOptions) => {
        const params: Record<string, any> = {};
        (selectedOptions as Array<number | string>).forEach((value) => {
          params[value] = "1";
        });
        return { requestConfig: { params } };
      },
    },
    {
      name: "搜索类型",
      key: "typ",
      options: [
        { name: "Name", value: "name" }, // Torrents dead for over 6 months brought back to life
        { name: "Description", value: "descr" },
        { name: "Name & Descr", value: "both" },
      ],
    },
    {
      name: "活跃度",
      key: "deadlive",
      options: [
        { name: "Active Transfers", value: 0 },
        { name: "Include Dead", value: 1 },
        { name: "Only Dead", value: 2 },
        { name: "Need Seed", value: 3 },
      ],
    },
  ],

  search: {
    //get_ttable.php?pcat=Show+All&typ=name&scat=&subbed=&fl=&resd=&p=0&searchstr=&deadlive=0
    requestConfig: {
      url: "/get_ttable.php",
      params: {
        // E1-B1：原值抄自 Jackett 的原始 URL（`?pcat=Show+All`，`+` 在查询串里表示空格）。
        // 本引擎把 params 交给 axios 编码，`+` 会变成 `%2B`，服务端拿到字面量 `Show+All`（不存在的分类），
        // 默认（不选分类）搜索因此为空。分类选项的真实值是 "Show All"，这里保持一致。
        pcat: "Show All",
        typ: "name",
        scat: "",
        subbed: "",
        fl: "",
        resd: "",
        p: 0,
        searchstr: "",
        deadlive: 0,
      },
    },
    keywordPath: "params.searchstr",
    selectors: {
      rows: { selector: "tr.t-row" },
      id: {
        selector: ["a[href*='torrents-details.php?id=']:not([href*='#'])"],
        attr: "href",
        filters: [(query: string) => query.match(/torrents-details\.php\?id=(\d+)/)![1]],
      },
      title: { selector: ["a[href*='torrents-details.php?id=']:not([href*='#']) b"] },
      url: { selector: ["a[href*='torrents-details.php?id=']:not([href*='#'])"], attr: "href" },
      link: { selector: ["a[href*='download.php?id=']"], attr: "href" },
      time: {
        selector: ["td.ttable_timestamp"],
        // SITECORE-1：站点墙上时间交给具名 parseTime，由 runQueryFilters 按 metadata.timezoneOffset 换算
        filters: [{ name: "parseTime", args: ["MMddyy HH:mm:ss"] }],
      },
      size: { selector: ["td.ttable_size"], filters: [{ name: "parseSize" }] },
      author: { selector: ["a[href*='account-details.php?id=']"] },
      seeders: { selector: ["font[color='green'] > b"], filters: [{ name: "parseNumber" }] },
      leechers: { selector: ["font[color='#ff0000'] > b"], filters: [{ name: "parseNumber" }] },
      completed: { selector: ["font[color='black'] > b"], filters: [{ name: "parseNumber" }] },
      comments: { selector: ["a.comment-link"], filters: [{ name: "parseNumber" }] },
      category: {
        selector: ["a.category-link"],
        filters: [(query: string) => query.split(":")[1].trim()],
      },
      tags: [
        {
          name: "Free",
          selector: "img[title='freeleech']",
          color: "blue",
        },
        {
          name: "sub",
          selector: "img[title='subtitled']",
          color: "orange",
        },
      ],
      status: {
        selector: ":self",
        elementProcess: (element: any) => {
          if (!element) return ETorrentStatus.unknown;
          if (element.querySelector("td.ttable_seeding font[color='green']")) {
            return ETorrentStatus.seeding; // 做种!
          }
          if (element.querySelector("td.ttable_seeding font[color='#ff0000']")) {
            return ETorrentStatus.downloading; // 吸血!
          }
          if (element.querySelector("td.ttable_seeding font[color='black']")) {
            return ETorrentStatus.completed; // 撤种!
          }
          return ETorrentStatus.unknown;
        },
      },
      progress: {
        selector: ":self",
        elementProcess: (element: any) => {
          if (!element) return null;
          if (
            element.querySelector("td.ttable_seeding font[color='green']") ||
            element.querySelector("td.ttable_seeding font[color='black']")
          ) {
            return 100;
          }
          return null;
        },
      },
    },
  },

  userInfo: {
    pickLast: ["id", "name", "joinTime"],
    selectors: {
      // "/forum/usercp.php"
      id: {
        selector: ["a[href*='member.php?action=profile']"],
        attr: "href",
        filters: [(query: string) => query.match(/uid=(\d+)/)![1]],
      },
      // "/account.php"
      name: { selector: ["td.prof-lbl:contains('Username:') + td"] },
      joinTime: {
        selector: ["td.prof-lbl:contains('Joined:') + td"],
        filters: [{ name: "parseTime" }],
      },
      uploaded: {
        selector: ["td.prof-lbl:contains('Uploaded:') + td"],
        filters: [{ name: "parseSize" }],
      },
      downloaded: {
        selector: ["td.prof-lbl:contains('Downloaded:') + td"],
        filters: [{ name: "parseSize" }],
      },
      levelName: { selector: ["td.prof-lbl:contains('User Class:') + td"] },
      // E1-C2 / E15：站点用 "---" 表示「无下载量（分享率无限）」。原实现把它映射成 -1 哨兵；
      // level.ts 的 fixRatio 现在会把 -1 视为 Infinity（D2 已修），但 -1 仍会被持久化进 userInfo
      // 并污染其它直接读取 ratio 的消费者（备份/导出/统计），语义上也不是真实分享率。
      // 因此这里不输出 ratio，交给引擎按 uploaded/downloaded 推导
      //（downloaded == 0 && uploaded > 0 → Infinity，UI 显示 ∞，等级判定同样正确）。
      uploads: {
        selector: ["td.prof-lbl:contains('Uploads:') + td"],
        filters: [{ name: "parseNumber" }],
      },
      seeding: {
        selector: ["span[id='seed-count']"],
        filters: [{ name: "parseNumber" }],
      },
      seedingPage: {
        selector: ["div[id='seed-search-stat']"],
        // E1-B2：文案形如 "Page 1 / 3"，原正则 `/Page (\d+) \//` 取的是**当前页**（1），
        // 不是斜杠后的总页数（3），多页做种体积只统计第一页；改为取 `/` 后的总页数。
        filters: [(query: string) => parseInt(query?.match(/Page\s+\d+\s*\/\s*(\d+)/)?.[1] ?? "0")],
      },
      // 没有积分系统
      bonus: { text: "0" },
      // "/get_account_peers.php"
      seedingSize: {
        selector: ":self",
        elementProcess: (element: any) => {
          if (!element) return 0;
          const tr_elements = element.querySelectorAll("tr");

          let sumSizes: number = 0;
          tr_elements.forEach((tr: any) => {
            // 获取当前 tr 下的所有 td
            const tdElements = tr.querySelectorAll("td");
            // 第 4 个 td（索引 3）是文件大小
            if (tdElements.length >= 4) {
              const sixthTd = tdElements[3];
              const sizeText = sixthTd.textContent?.trim() || "";
              sumSizes += parseSizeString(sizeText.replace(/,/g, ""));
            }
          });

          return sumSizes;
        },
      },
    },
  },

  // TODO userInfo 中的messageCount 等其他字段

  list: [
    {
      urlPattern: ["/(index.php|torrents-search.php)$"],
    },
  ],

  detail: {
    urlPattern: ["/torrents-details\\.php\\?id=\\d+"],
    selectors: {
      title: { selector: ["div.myFrame td:contains('Name:') + td"] },
      id: {
        selector: ["a[href*='download.php?id=']"],
        attr: "href",
        filters: [(query: string) => query.match(/id=(\d+)/)![1]],
      },
      link: {
        selector: ["a[href*='download.php?id=']"],
        attr: "href",
      },
    },
  },

  levelRequirements: [
    {
      id: 1,
      name: "Member",
      privilege: "Can download, upload torrents；Ratio effects availability of new torrents",
    },
    {
      id: 2,
      name: "Sharer ",
      uploads: 50,
      averageSeedingTime: "PT20H",
      interval: "P6M",
      privilege:
        "Can download, upload torrents；Ratio has no effect on availability of new torrents；Notification and highlighting of new comments",
    },
    {
      id: 3,
      name: "Distributor",
      uploads: 500,
      averageSeedingTime: "P5D",
      ratio: 1.0,
      privilege:
        "Can download, upload torrents；Ratio has no effect on availability of new torrents；Notification and highlighting of new comments；Can view peers on torrents；Can view user list of who completed downloading a torrent",
    },
    {
      id: 4,
      name: "Uploader",
      privilege: "user who uploads new content to the site on a regular basis",
    },
    {
      id: 5,
      name: "Uploader+",
      privilege: "uploader who has a low freeleech ratio",
    },
  ],
};

export default class AidoruOnline extends PrivateSite {
  public override async getUserInfoResult(lastUserInfo: Partial<IUserInfo> = {}): Promise<IUserInfo> {
    let flushUserInfo: IUserInfo = {
      status: EResultParseStatus.unknownError,
      updateAt: +new Date(),
      site: this.metadata.id,
    };

    if (!this.allowQueryUserInfo) {
      flushUserInfo.status = EResultParseStatus.passParse;
      return flushUserInfo;
    }

    try {
      let id: number;
      if (lastUserInfo !== null && lastUserInfo.id) {
        id = lastUserInfo.id as number;
      } else {
        // 如果没有 id 信息，则访问一次 用户CP页面
        id = await this.getUserIdFromUserCP();
      }
      flushUserInfo.id = id;

      // 导入基本 Details 页面获取到的用户信息
      flushUserInfo = toMerged(flushUserInfo, await this.getUserInfoFromDetailsPage());
      flushUserInfo = await this.getUserSeedingFields(flushUserInfo);

      // 如果前面没有获取到用户等级的id，则尝试通过定义的 levelRequirements 来获取
      if (this.metadata.levelRequirements && flushUserInfo.levelName && typeof flushUserInfo.levelId === "undefined") {
        flushUserInfo.levelId = this.guessUserLevelId(flushUserInfo as IUserInfo);
      }

      flushUserInfo.status = EResultParseStatus.success;
    } catch (e) {
      // E1-C4：不整段重写基类错误处理——复用 classifySiteError（网络/5xx 可重试、needLogin 单独映射）
      // 并把 statusMsg / 日志透传出去，避免网络错误被报成「解析失败」且 UI 无原因可看。
      const { status, statusMsg, retryable } = classifySiteError(e);
      flushUserInfo.status = status;
      flushUserInfo.statusMsg = statusMsg;
      logMessage(
        `[Site] ${this.name} getUserInfoResult failed (status=${EResultParseStatus[status]}, retryable=${retryable})`,
        { site: this.metadata.id, status, retryable, error: siteErrorLogData(e) },
        retryable ? "warn" : "error",
      );
    }

    return flushUserInfo;
  }

  protected async getUserIdFromUserCP(): Promise<number> {
    await this.sleepAction(this.metadata.userInfo?.requestDelay);

    const { data: indexDocument } = await this.request<Document>(
      {
        url: "/forum/usercp.php",
        responseType: "document",
      },
      true,
    );
    // 获取所有包含href属性的元素
    const allHrefElements = indexDocument.querySelectorAll("[href]");
    const allHrefs = Array.from(allHrefElements).map((el) => el.getAttribute("href"));
    // 检查是否有包含login的href
    const hasLoginHref = allHrefs.some((href) => href && href.toLowerCase().includes("action=login"));
    if (hasLoginHref) {
      throw new NeedLoginError("检测到包含action=login的链接，需要重新登录");
    }

    return this.getFieldData(indexDocument, this.metadata.userInfo?.selectors?.id!);
  }

  protected async getUserInfoFromDetailsPage(): Promise<Partial<IUserInfo>> {
    await this.sleepAction(this.metadata.userInfo?.requestDelay);

    const { data: userDetailDocument } = await this.request<Document>({
      url: "/account.php",
      responseType: "document",
    });

    if (!userDetailDocument || !userDetailDocument.title) {
      throw new NeedLoginError("请求未获取到数据，需要重新登录");
    }

    const selectors = this.metadata.userInfo?.selectors!;
    const selectorFields = Object.keys(omit(selectors, ["id", "seedingSize"]));
    // E1-C4 / H-6：基类 getUserInfoResult 会用 checkUserInfoSelectorMatches 做「零命中」与关键字段守卫；
    // 本定义整体重写了 getUserInfoResult，必须在这里复刻，否则改版/软错误页会被静默标成 success 并写入空值。
    // 该检查在关键字段（uploaded/downloaded）未命中时会直接抛错，其余字段由下面的 declared/matched 兜底。
    const matches = this.checkUserInfoSelectorMatches(userDetailDocument, selectors, selectorFields);
    if (matches.declared > 0 && matches.matched === 0) {
      throw new Error(
        `用户信息页未命中任何字段（${matches.declared} 个 selector 全部落空），页面可能已改版或不是用户信息页`,
      );
    }

    return this.getFieldsData(userDetailDocument, selectors, selectorFields) as Partial<IUserInfo>;
  }

  protected async getUserSeedingFields(flushUserInfo: IUserInfo): Promise<IUserInfo> {
    await this.sleepAction(this.metadata.userInfo?.requestDelay);

    flushUserInfo.seedingSize = 0;
    if (flushUserInfo && flushUserInfo.seedingPage) {
      for (let p = 0; p < flushUserInfo.seedingPage; p++) {
        const { data: userDetailText } = await this.request<Document>({
          url: `/get_account_peers.php?uid=&p=${p}&type=seed&searchstr=`,
          responseType: "text",
        });
        // 请求获取的是tr片段，添加表头再解析
        const wrappedHTML = `<table><tbody>${userDetailText}</tbody></table>`;

        // A-17：改用共享的 createDocument（唯一一处裸 new DOMParser()）——
        // 它是「解析环境」的唯一决定点，将来站点包若在 background 而非 offscreen 执行时不会单独失效。
        const userDetailDocument = createDocument(wrappedHTML);

        // A-15：getFieldData 未命中时返回字符串 ""，而 `0 + "" === "0"` 会让后续每次 += 变成字符串拼接，
        // 于是 seedingSize 静默变成 "0"+"1234" 这类脏值。这里逐页强制转成数字再累加。
        const pageSeedingSize = Number(
          this.getFieldData(userDetailDocument, this.metadata.userInfo?.selectors?.seedingSize!),
        );
        flushUserInfo.seedingSize += Number.isFinite(pageSeedingSize) ? pageSeedingSize : 0;
      }
    }

    return flushUserInfo;
  }

  // E1-B3：原先这里在 `super.getTorrentDownloadLink()` 之后判断 `!link.includes("download.php")`，
  // 但行内 link 选择器就是 `a[href*='download.php?id=']`，super 要么抛错、要么返回含 download.php 的链接，
  // 该分支恒为 false（死代码），不会覆盖任何真实场景。确认站点不存在中间页后删除该覆写，行为不变。
}
