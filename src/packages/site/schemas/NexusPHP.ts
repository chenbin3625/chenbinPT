import { selectElements } from "../utils/selector";
import { mergeWith, toMerged, omit } from "es-toolkit";
import { set } from "es-toolkit/compat";

import PrivateSite from "./AbstractPrivateSite";
import {
  EResultParseStatus,
  ETorrentStatus,
  type IElementQuery,
  type ILevelRequirement,
  type ISearchCategories,
  type ISearchInput,
  type ISiteMetadata,
  type ITorrent,
  type ITorrentTag,
  type IUserInfo,
} from "../types";
import {
  createDocument,
  definedFilters,
  extractContent,
  parseSizeString,
  parseTimeToLiveToDate,
  parseValidTimeString,
  sizePattern,
} from "../utils";

export const CategoryIncldead: ISearchCategories = {
  name: "显示断种/活种？",
  key: "incldead",
  options: [
    { name: "全部", value: 0 },
    { name: "仅活种", value: 1 },
    { name: "仅断种", value: 2 },
  ],
  cross: false,
};

export const CategorySpstate: ISearchCategories = {
  name: "促销种子？",
  key: "spstate",
  options: [
    { name: "全部", value: 0 },
    { name: "普通", value: 1 },
    { name: "免费", value: 2 },
    { name: "2X", value: 3 },
    { name: "2X免费", value: 4 },
    { name: "50%", value: 5 },
    { name: "2X 50%", value: 6 },
    { name: "30%", value: 7 },
  ],
  cross: false,
};

export const CategoryInclbookmarked: ISearchCategories = {
  name: "显示收藏？",
  key: "inclbookmarked",
  options: [
    { name: "全部", value: 0 },
    { name: "仅收藏", value: 1 },
    { name: "仅未收藏", value: 2 },
  ],
  cross: false,
};

export const baseUserIdSelector: string[] = [
  /**
   * 优先使用 #info_block 中的链接，因为部分站点可能会在其他位置放置一个指向其他用户详情页的链接，导致获取到其他用户的 id 和 name
   * refs: https://github.com/xiaomlove/nexusphp/blob/3dae3aec8d8340d48f9bf544479aa4dac4456cb6/include/functions.php#L2706-L2710
   */
  "#info_block a[href*='userdetails.php'][href*='id=']:first",
  // 原PTPP使用的选择器
  "a[href*='userdetails.php'][class*='Name']:first",
  "a[href*='userdetails.php']:first",
];

export const baseTitleQuery: IElementQuery = {
  selector: [
    "a[href^='details.php?id='][title]:has(b)",
    "a[href*='details.php?id='][href*='hit']",
    "a[href*='hit'][title]",
    "a[href*='hit']:has(b)",
  ],
};

export const baseLinkQuery: IElementQuery = {
  selector: ['a[href*="download.php?id="]:has(> img[alt="download"])'],
  attr: "href",
} as const;

export function createUserBonusSelectorFn(bonusKeys: string[]): IElementQuery {
  const bonusRegExp = new RegExp(`(${bonusKeys.join("|")}).+?([\\d.]+)`);
  return {
    selector: [
      ...bonusKeys.map(
        (bonusKey) =>
          "td.rowhead" +
          // 防止 &nbsp; 影响
          bonusKey
            .split(" ")
            .map((x) => `:contains('${x}')`)
            .join("") +
          ` + td`,
      ),
      ...bonusKeys.map((bonusKey) => `td.rowfollow:contains('${bonusKey}')`),
    ],
    filters: [
      (query: string) => {
        query = query.replace(/,/g, "");
        if (bonusRegExp.test(query)) {
          query = query.match(bonusRegExp)![2];
          return parseFloat(query);
        } else if (/[\d.]+/.test(query)) {
          return parseFloat(query.match(/[\d.]+/)![0]);
        }
        return query;
      },
    ],
  };
}

const parseProgressElement = (element: HTMLElement) => {
  const progressElement = element.parentElement?.querySelector("div");
  if (!progressElement) return null;
  const progressTitle = progressElement.getAttribute("title");
  const parts = progressTitle?.split(" ");
  if (!parts || parts.length != 2) return null;
  const status = parts[0];
  const progress = parts[1];
  return { status: status, progress: progress };
};

/**
 * 处理 NexusPHP 中 DiffInSection 的 HnR，例如 [xx区: 0/0/10 yy区: 0/0/10 ...]
 * refs: https://github.com/xiaomlove/nexusphp/blob/php8/app/Repositories/HitAndRunRepository.php#L445
 * @param element HTMLElement，由选择器匹配到，选择器通常是 "#info_block a[href*='myhr.php']:last"
 */
export const parseSectionedHitAndRunElement = (element: HTMLElement) => {
  const textContent = element.textContent || "";
  const preWarningCount = [...textContent.matchAll(/\s(\d+)\//g)]
    .map((m) => parseInt(m[1] || "0", 10)) // m[1] 是捕获组
    .filter(Number.isFinite)
    .reduce((acc, val) => acc + val, 0);

  const fontElements = element.querySelectorAll("font[color*='red']") ?? [];
  const unsatisfiedCount = Array.from(fontElements)
    .map((e) => parseInt(e.textContent?.trim() || "0", 10))
    .filter(Number.isFinite)
    .reduce((acc, val) => acc + val, 0);

  return { hnrPreWarning: preWarningCount || 0, hnrUnsatisfied: unsatisfiedCount || 0 };
};

/**
 * 原实现：序列化整行 innerHTML 后按 "<br>" 切分，取最后一段并二次解析。
 * 仅在无法用直接子节点等价切分（存在嵌套 <br>）时作为回落使用。
 */
const legacySubTitleRemoveExtraElement = (element: HTMLElement, removeSelectors: string[], self: boolean): string => {
  const testSubTitle = element.parentElement!.innerHTML.split("<br>");
  if (testSubTitle && testSubTitle.length > 1) {
    const subTitleHtml = testSubTitle[testSubTitle.length - 1];

    // 移除 removeSelectors 的内容
    const div = document.createElement("div");
    div.innerHTML = subTitleHtml;
    for (const removeSelectorsKey of removeSelectors) {
      div.querySelectorAll(removeSelectorsKey).forEach((el) => (self ? el : el.parentElement!).remove());
    }
    return extractContent(div.innerHTML).trim();
  }
  return "";
};

/**
 * Create an element processor to extract a cleaned subtitle string from a torrent title element.
 *
 * This factory returns a function which, given an HTMLElement that belongs to a title row,
 * will inspect its parent's child nodes, find the last direct `<br>` child, and take the
 * nodes after it as the subtitle. It then removes any nodes matching `removeSelectors` from
 * that fragment before returning the cleaned text content. If no subtitle fragment is found,
 * it returns an empty string.
 *
 * 相比原实现（序列化整行 innerHTML + 两次 HTML 解析），这里直接读取 childNodes 的文本，
 * 仅在需要剥离元素时才把尾部节点克隆到一个临时容器内处理。
 *
 * @param removeSelectors - Array of CSS selectors to remove from the subtitle fragment. Defaults to [].
 * @param self - When true (default) remove the matched element itself; when false remove its parent element instead.
 * @returns A function that accepts the matched title element and returns the cleaned subtitle string.
 */
export const subTitleRemoveExtraElement =
  (removeSelectors: string[] = [], self: boolean = true) =>
  (element: HTMLElement) => {
    const parent = element.parentElement!;
    const childNodes = parent.childNodes;

    // 原实现按 innerHTML 中的字面量 "<br>" 切分并取最后一段：
    // 只有「无属性的 <br>」在序列化后才是字面量 "<br>"，带属性的 <br class="..."> 不是切分点
    let lastBrIndex = -1;
    let directPlainBrCount = 0;
    for (let i = 0; i < childNodes.length; i++) {
      const node = childNodes[i];
      if (node.nodeName === "BR" && (node as Element).attributes.length === 0) {
        directPlainBrCount += 1;
        lastBrIndex = i;
      }
    }

    // 统计整棵子树中无属性 <br> 的数量，用于判断是否存在嵌套的切分点
    let allPlainBrCount = 0;
    for (const br of parent.getElementsByTagName("br")) {
      if (br.attributes.length === 0) {
        allPlainBrCount += 1;
      }
    }

    if (lastBrIndex === -1) {
      // 没有无属性的直接 <br> 子节点：序列化结果中不含字面量 "<br>" 时原实现返回 ""
      if (allPlainBrCount === 0) {
        return "";
      }
      // 切分点全部是嵌套的 <br>，无法用直接子节点等价切分，回落原实现
      return legacySubTitleRemoveExtraElement(element, removeSelectors, self);
    }

    if (allPlainBrCount !== directPlainBrCount) {
      // 存在嵌套的 <br> 切分点，回落原实现保证行为一致
      return legacySubTitleRemoveExtraElement(element, removeSelectors, self);
    }

    if (removeSelectors.length === 0) {
      // 无需剥离元素时，直接拼接尾部节点的文本
      let text = "";
      for (let i = lastBrIndex + 1; i < childNodes.length; i++) {
        text += childNodes[i].textContent ?? "";
      }
      return text.trim();
    }

    // 需要剥离元素时，把尾部节点克隆到临时容器内再移除，等价于"解析尾部 HTML 片段 → 删除匹配元素 → 取文本"
    const div = document.createElement("div");
    for (let i = lastBrIndex + 1; i < childNodes.length; i++) {
      div.appendChild(childNodes[i].cloneNode(true));
    }
    for (const removeSelectorsKey of removeSelectors) {
      div.querySelectorAll(removeSelectorsKey).forEach((el) => (self ? el : el.parentElement!).remove());
    }
    return (div.textContent || div.innerText).trim();
  };

/**
 * From:
 * - https://github.com/xiaomlove/nexusphp/blob/ee30a70cb9e81628ca6721883aaddab58f789891/app/Models/User.php#L61-L68
 * - https://github.com/xiaomlove/nexusphp/blob/ee30a70cb9e81628ca6721883aaddab58f789891/config/allconfig.php#L20-L51
 */
export const xiaomloveDefaultUserLevelRequirements: ILevelRequirement[] = [
  {
    id: 1,
    name: "Peasant",
    privilege:
      "被降级的用户，他们有30天时间来提升分享率，否则他们会被踢。不能发表趣味盒内容;不能申请友情链接;不能上传字幕。",
  },
  {
    id: 2,
    name: "User",
    privilege: "新用户的默认级别。只能在每周六中午12点至每周日晚上11点59分发布种子。",
  },
  {
    id: 3,
    name: "Power User",
    interval: "P4W",
    seedingBonus: 40000,
    downloaded: "50GB",
    ratio: 1.05,
    privilege:
      "得到一个邀请名额;可以直接发布种子;可以查看NFO文档;可以查看用户列表;可以请求续种;可以发送邀请;" +
      "可以查看排行榜;可以查看其它用户的种子历史(如果用户隐私等级未设置为”强”);可以删除自己上传的字幕。",
  },
  {
    id: 4,
    name: "Elite User",
    interval: "P8W",
    seedingBonus: 80000,
    downloaded: "120GB",
    ratio: 1.55,
    privilege: "Elite User及以上用户封存账号后不会被删除。",
  },
  {
    id: 5,
    name: "Crazy User",
    interval: "P15W",
    seedingBonus: 150000,
    downloaded: "300GB",
    ratio: 2.05,
    privilege: "得到两个邀请名额;可以在做种/下载/发布的时候选择匿名模式。",
  },
  {
    id: 6,
    name: "Insane User",
    interval: "P25W",
    seedingBonus: 250000,
    downloaded: "500GB",
    ratio: 2.55,
    privilege: "可以查看普通日志。",
  },
  {
    id: 7,
    name: "Veteran User",
    interval: "P40W",
    seedingBonus: 400000,
    downloaded: "750GB",
    ratio: 3.05,
    isKept: true,
    privilege: "得到三个邀请名额；可以查看其它用户的评论、帖子历史。Veteran User及以上用户会永远保留账号。",
  },
  {
    id: 8,
    name: "Extreme User",
    interval: "P60W",
    seedingBonus: 600000,
    downloaded: "1024GB",
    ratio: 3.55,
    isKept: true,
    privilege: "可以更新过期的外部信息；可以查看Extreme User论坛。",
  },
  {
    id: 9,
    name: "Ultimate User",
    interval: "P80W",
    seedingBonus: 800000,
    downloaded: "1536GB",
    ratio: 4.05,
    isKept: true,
    privilege: "得到五个邀请名额。",
  },
  {
    id: 10,
    name: "Nexus Master",
    interval: "P100W",
    seedingBonus: 1000000,
    downloaded: "3072GB",
    ratio: 4.55,
    isKept: true,
    privilege: "得到十个邀请名额。",
  },
  {
    id: 100,
    groupType: "vip",
    name: "VIP",
    nameAka: ["贵宾", "贵宾(VIP)"],
    privilege: "和Nexus Master拥有相同权限并被认为是精英成员。免除自动降级。",
  },
  {
    id: 200,
    groupType: "manager",
    name: "Retiree",
    nameAka: ["养老族", "养老族(Retiree)"],
    privilege: "退休后的管理组成员。",
  },
  {
    id: 201,
    groupType: "manager",
    name: "Uploader",
    nameAka: ["发布员", "发布员(Uploader)"],
    privilege: "专注的发布者。免除自动降级；可以查看匿名用户的真实身份。",
  },
  {
    id: 202,
    groupType: "manager",
    name: "Moderator",
    nameAka: ["总版主", "总版主(Moderator)"],
    privilege:
      "可以查看管理组信箱、举报信箱；管理趣味盒内容、投票内容；可以编辑或删除任何发布的种子；可以管理候选；可以管理论坛帖子、用户评论；" +
      "可以查看机密日志；可以删除任何字幕；可以管理日志中的代码、史册；可以查看用户的邀请记录；可以管理用户帐号的一般信息。" +
      "不能管理友情链接、最近消息、论坛版块；不能将种子设为置顶或促销；不能查看用户IP或Email等机密信息；不能删除账号。",
  },
  {
    id: 203,
    groupType: "manager",
    name: "Administrator",
    nameAka: ["管理员", "管理员(Administrator)"],
    privilege: "除了不能改变站点设定、管理捐赠外，可以做任何事。",
  },
  {
    id: 204,
    groupType: "manager",
    name: "Sysop",
    nameAka: ["维护开发员", "维护开发员(Sysop)"],
    privilege: "网站开发/维护人员，可以改变站点设定，不能管理捐赠。",
  },
  {
    id: 205,
    groupType: "manager",
    name: "Staff Leader",
    nameAka: ["主管", "主管(Staff Leader)"],
    privilege: "网站主管，可以做任何事。",
  },
];

export const defaultUserLevelRequirements = xiaomloveDefaultUserLevelRequirements.map((level) => {
  return omit(level, ["bonus"]);
}) as ILevelRequirement[];

/**
 * NexusPHP 模板默认配置，对于大多数NPHP站点都通用
 * @protected
 */
export const SchemaMetadata: Pick<
  ISiteMetadata,
  "version" | "schema" | "type" | "timezoneOffset" | "search" | "list" | "userInfo" | "detail"
> = {
  version: 0,
  schema: "NexusPHP",
  type: "private",
  timezoneOffset: "+0800", // NPHP 一般都是国内用，时区多为 +0800
  search: {
    keywordPath: "params.search",
    requestConfig: {
      url: "/torrents.php",
      params: { notnewword: 1 },
    },
    advanceKeywordParams: {
      imdb: {
        requestConfigTransformer: ({ requestConfig: config }) => {
          set(config!, "params.search_area", 4); // params "&search_area=4"
          return config!;
        },
      },
    },
    selectors: {
      // row 等信息由 transformSearchPage 根据搜索结果自动生成
      link: baseLinkQuery, // 种子下载链接
      url: {
        ...baseLinkQuery,
        filters: [
          { name: "querystring", args: ["id"] },
          { name: "prepend", args: ["/details.php?id="] },
        ],
      }, // 种子页面链接
      id: {
        ...baseLinkQuery,
        filters: [{ name: "querystring", args: ["id"] }],
      },
      title: {
        ...baseTitleQuery,
        text: "",
        elementProcess: (element) => {
          return (element.getAttribute("title") || element.textContent || "").trim();
        },
      },
      subTitle: {
        ...baseTitleQuery,
        text: "",
        elementProcess: subTitleRemoveExtraElement(["a, span, img"], true),
      },
      progress: {
        ...baseTitleQuery,
        elementProcess: (element) => {
          const parsedProgress = parseProgressElement(element);
          if (!parsedProgress) return "0";
          return parseFloat(parsedProgress.progress);
        },
      },
      status: {
        ...baseTitleQuery,
        text: ETorrentStatus.unknown,
        elementProcess: (element) => {
          const parsedProgress = parseProgressElement(element);
          if (!parsedProgress) return ETorrentStatus.unknown;
          switch (parsedProgress.status) {
            case "leeching":
              return ETorrentStatus.downloading;
            case "seeding":
              return ETorrentStatus.seeding;
            case "inactivity":
              return parsedProgress.progress == "100%" ? ETorrentStatus.completed : ETorrentStatus.inactive;
          }
          return ETorrentStatus.unknown;
        },
      },
      category: {
        text: "Other",
        selector: ["a:first"],
        elementProcess: (element: HTMLElement) => {
          let category = "Other";
          const categoryImgAnother = element.querySelector("img:nth-child(1)"); // img:first
          if (categoryImgAnother) {
            category = categoryImgAnother.getAttribute("title") || categoryImgAnother.getAttribute("alt") || category;
          } else {
            return element.textContent || category;
          }

          return category.trim();
        },
      },
      time: {
        text: 0,
        elementProcess: (element: HTMLElement) => {
          let time: number | string = 0;
          try {
            const AccurateTimeAnother = element.querySelector("span[title], time[title]");
            if (AccurateTimeAnother) {
              time = AccurateTimeAnother.getAttribute("title")!;
            } else {
              time = extractContent(element.innerHTML.replace("<br>", " "));
            }

            if (time.match(/\d+[分时天月年]/g)) {
              time = parseTimeToLiveToDate(time);
            } else {
              time = parseValidTimeString(time);
            }
          } catch (e) {
            // P1-5：时间字段解析失败时回落为原始值（time 仍可能是字符串），保持既有行为不抛出。
            // 每行种子都会执行，属高频良性降级路径，故只用 console.debug 避免刷满 logger 缓冲。
            console.debug("[PTD] NexusPHP parse row time failed, fallback to raw value:", time, e);
          }
          return time as number;
        },
      },
      ext_douban: {
        selector: ["span[data-doubanid]", "a[href*='douban.com']"],
        elementProcess: (element: HTMLAnchorElement | HTMLSpanElement) => {
          if (element.tagName.toLowerCase() === "span") {
            return element.dataset.doubanid || "";
          } else if (element.tagName.toLowerCase() === "a") {
            return (element as HTMLAnchorElement).getAttribute("href") || "";
          }
          return "";
        },
        filters: [{ name: "extDoubanId" }],
      },
      ext_imdb: {
        selector: ["span[data-imdbid]", "a[href*='imdb.com']"],
        elementProcess: (element: HTMLAnchorElement | HTMLSpanElement) => {
          if (element.tagName.toLowerCase() === "span") {
            return element.dataset.imdbid || "";
          } else if (element.tagName.toLowerCase() === "a") {
            return (element as HTMLAnchorElement).getAttribute("href") || "";
          }
          return "";
        },
        filters: [{ name: "extImdbId" }],
      },
      tags: [
        { name: "H&R", selector: "img.hitandrun", color: "black" },
        { name: "Free", selector: "img.pro_free", color: "blue" },
        { name: "2xFree", selector: "img.pro_free2up", color: "green" },
        { name: "2xUp", selector: "img.pro_2up", color: "lime" },
        { name: "2x50%", selector: "img.pro_50pctdown2up", color: "light-green" },
        { name: "30%", selector: "img.pro_30pctdown", color: "indigo" },
        { name: "50%", selector: "img.pro_50pctdown", color: "deep-orange-darken-1" },
      ],
    },
  },

  list: [
    {
      urlPattern: ["/torrents.php", "/special.php"],
    },
  ],

  detail: {
    urlPattern: ["/details.php"],

    selectors: {
      title: {
        selector: ["h1#top", "html > body > title"],
        switchFilters: {
          "h1#top": [
            (title: string) => {
              // 详情页标题形如 "{torrentName}\u00A0\u00A0\u00A0{附加信息}"：NexusPHP 核心用的是
              // `htmlspecialchars($row["name"]).($sp_torrent ? "&nbsp;&nbsp;&nbsp;".$sp_torrent : "")`
              // （details.php），即分隔符是 **U+00A0**，不是 ASCII 空格。
              //
              // B-2 的结论曾两次被误读，最终核实（按内容而非行号定位，hexdump 到 `c2 a0 2b`）：
              // 原实现 `/^(.+?)\u00A0+.+$/` 里的 `+` 是**量词**（一个或多个 U+00A0），
              // 因此它本来就能正确切分（lazy 的 `.+?` 会停在第一段 U+00A0 前）。
              // 一度被"更正"为 `\s{3}`，那反而引入回归：单个 U+00A0 分隔的标题不再切分，
              // 且含 3 个连续 ASCII 空格的标题会被新截断。故此处保持原语义，只把注释写清楚。
              let titleMatch = title.match(/^(.+?)\u00A0+.+$/);
              if (titleMatch && titleMatch.length >= 2) {
                return titleMatch[1].trim();
              }
              return title;
            },
          ],

          "html > body > title": [
            (title: string) => {
              // {siteName} :: 种子详情 "{torrentName}" - Powered by NexusPHP
              // 注意：该正则只有 1 个捕获组，因此下面是 `>= 2` + `[1]`；
              // 早先写成 `>= 3` + `[2]` 导致这个兜底过滤器永远走空、直接返回带后缀的原始串。
              let titleMatch = title.match(/"(.+)" - Powered by NexusPHP$/);
              if (titleMatch && titleMatch.length >= 2) {
                return titleMatch[1].trim();
              }
              return title;
            },
          ],
        },
      },
      link: {
        selector: [
          'a[href*="download.php?id="][href*="&downhash="]',
          'a[href*="download.php?id="][href*="&passkey="]',
          'a[href*="download.php?downhash="]',
          // 如果上面三个都没拿到，则尝试使用nphp默认的下载链接selector
          'a[href*="download.php?id="]',
        ],
        attr: "href",
      },
    },
  },

  userInfo: {
    /**
     * 我们认为NPHP站的 id 的情况永远不变（实质上对于所有站点都应该是这样的）
     * 部分 NPHP 站点允许修改 name，所以 name 不能视为不变 ！！！
     */
    pickLast: ["id"],
    selectors: {
      // "page": "/index.php",
      id: {
        selector: baseUserIdSelector,
        attr: "href",
        filters: [{ name: "querystring", args: ["id"] }],
      },

      // "page": "/userdetails.php?id=$user.id$",
      name: {
        selector: baseUserIdSelector,
      },
      messageCount: {
        text: 0,
        selector: "td[style*='background: red'] a[href*='messages.php']",
        filters: [
          (query: string | number) => {
            const queryMatch = String(query || "").match(/(\d+)/); // query 有时会直接传入 0
            return queryMatch && queryMatch.length >= 2 ? parseInt(queryMatch[1]) : 0;
          },
        ],
      },
      uploaded: {
        text: 0,
        selector: [
          "td.rowhead:contains('传输') + td",
          "td.rowhead:contains('傳送') + td",
          "td.rowhead:contains('Transfers') + td",
          "td.rowfollow:contains('分享率')",
        ],
        filters: [
          (query: string) => {
            const queryMatch = query.replace(/,/g, "").match(/(上[传傳]量|Uploaded).+?([\d.]+ ?[ZEPTGMK]?i?B)/);
            return queryMatch && queryMatch.length === 3 ? parseSizeString(queryMatch[2]) : 0;
          },
        ],
      },
      trueUploaded: {
        text: 0,
        selector: [
          "td.rowhead:contains('传输') + td",
          "td.rowhead:contains('傳送') + td",
          "td.rowhead:contains('Transfers') + td",
          "td.rowfollow:contains('分享率')",
        ],
        filters: [
          (query: string) => {
            const queryMatch = query
              .replace(/,/g, "")
              .match(/((?:实际|真实)上传量|(?:實際|真實)上傳量|(?:Real|Actual) Uploaded).+?([\d.]+ ?[ZEPTGMK]?i?B)/);
            return queryMatch && queryMatch.length === 3 ? parseSizeString(queryMatch[2]) : 0;
          },
        ],
      },
      downloaded: {
        text: 0,
        selector: [
          "td.rowhead:contains('传输') + td",
          "td.rowhead:contains('傳送') + td",
          "td.rowhead:contains('Transfers') + td",
          "td.rowfollow:contains('分享率')",
        ],
        filters: [
          (query: string) => {
            const queryMatch = query.replace(/,/g, "").match(/(下[载載]量|Downloaded).+?([\d.]+ ?[ZEPTGMK]?i?B)/);
            return queryMatch && queryMatch.length === 3 ? parseSizeString(queryMatch[2]) : 0;
          },
        ],
      },
      trueDownloaded: {
        text: 0,
        selector: [
          "td.rowhead:contains('传输') + td",
          "td.rowhead:contains('傳送') + td",
          "td.rowhead:contains('Transfers') + td",
          "td.rowfollow:contains('分享率')",
        ],
        filters: [
          (query: string) => {
            const queryMatch = query
              .replace(/,/g, "")
              .match(/((?:实际|真实)下载量|(?:實際|真實)下載量|(?:Real|Actual) Downloaded).+?([\d.]+ ?[ZEPTGMK]?i?B)/);
            return queryMatch && queryMatch.length === 3 ? parseSizeString(queryMatch[2]) : 0;
          },
        ],
      },
      levelName: {
        selector: [
          "td.rowhead:contains('等级') + td > img",
          "td.rowhead:contains('等級')  + td > img",
          "td.rowhead:contains('Class')  + td > img",
        ],
        attr: "title",
      },
      isDonor: {
        text: false,
        selector: ["h1:has(img[src^='pic/flag']) img[alt='Donor']"],
        elementProcess: () => true,
      },
      bonus: createUserBonusSelectorFn([
        // 官方语言包
        // refs: https://github.com/search?q=repo%3Axiaomlove%2Fnexusphp+row_karma_points+path%3A%2F%5Elang%5C%2F%2F&type=code
        "魔力值",
        "Karma Points",
        // "Karma Poeng",
        // "Punti Karma",
        // "Pontos de Karma",
        // "Karma body",
        // "Karma Punten",
        // "Punkty Karmy",
        // "Karma Punkte",
        // "Karma Pisteet",
        // "Очки Кармы",
        // "Puncte Karma",
        // "Πόντοι Κάρμα",
        // "Karma Poäng",
        // "カルマポイント",

        // 特殊站点适配（此处仅保留因历史原因遗留的适配，其他请在站点配置中覆写）
        // "麦粒", // nwsuaf6 ( dead )
        "星焱", // tmpt
        "魅力值",
        "沙粒",

        // 回落 fallback
        "魔力",
      ]),
      seedingBonus: createUserBonusSelectorFn(["做种积分", "Seeding Points", "做種積分", "保种积分"]),
      joinTime: {
        selector: ["td.rowhead:contains('加入日期') + td", "td.rowhead:contains('Join'):contains('date') + td"],
        filters: [
          (query: string) => {
            query = query.split(" (")[0];
            return parseValidTimeString(query);
          },
        ],
      },
      hnrPreWarning: {
        // example: H&R: 2/1/5
        text: 0,
        selector: ["#info_block a[href*='myhr.php']:last"],
        filters: [
          (query: string | number) => {
            const queryMatch = String(query || "").match(/\d+/);
            return queryMatch && queryMatch.length >= 1 ? parseInt(queryMatch[0]) : 0;
          },
        ],
      },
      hnrUnsatisfied: {
        text: 0,
        selector: ["#info_block a[href*='myhr.php']:last"],
        filters: [
          (query: string | number) => {
            const queryMatch = String(query || "").match(/\d+\s*\/\s*(\d+)/);
            return queryMatch && queryMatch.length >= 2 ? parseInt(queryMatch[1]) : 0;
          },
        ],
      },

      bonusPerHour: {
        selector: [
          "#outer td[rowspan]",
          "div:contains('你当前每小时能获取'):last",
          "div:contains('You are currently getting'):last",
          "div:contains('你當前每小時能獲取'):last",
        ],
        filters: [{ name: "parseNumber" }],
      },

      lastAccessAt: {
        selector: [
          "td.rowhead:contains('最近动向') + td",
          "td.rowhead:contains('最近動向') + td",
          "td.rowhead:contains('Last Action') + td",
        ],
        filters: [{ name: "split", args: ["(", 0] }, { name: "parseTime" }],
      },

      /**
       * 如果指定 seeding 和 seedingSize，则会尝试从 "/userdetails.php?id=$user.id$" 页面获取，
       * 否则将使用方法 parseUserInfoForSeedingStatus 进行获取
       *
       */
      // seeding: { }
      // seedingSize: { }
    },
    process: [
      {
        requestConfig: { url: "/index.php", responseType: "document" },
        fields: ["id"],
      },
      {
        requestConfig: { url: "/userdetails.php", responseType: "document" },
        assertion: { id: "params.id" },
        fields: [
          "name",
          "messageCount",
          "uploaded",
          "trueUploaded",
          "downloaded",
          "trueDownloaded",
          "levelName",
          "bonus",
          "seedingBonus",
          "joinTime",
          "seeding",
          "seedingSize",
          "hnrUnsatisfied",
          "hnrPreWarning",
          "lastAccessAt",
          "isDonor",
        ],
      },
      {
        requestConfig: { url: "/mybonus.php", responseType: "document" },
        fields: ["bonusPerHour", "seedingBonusPerHour"],
      },
    ],
    /**
     * donorConfig 配置捐赠者（黄星）的特殊权限
     * - isAccountKept: false（NexusPHP 默认黄星不免疫不活跃）
     * - bonusPerHourMultiplier: 2（NexusPHP 默认时魔 2 倍） 站点配置中，如果能直接使用 selector 选出正确的时魔，则此系数应设为 1
     */
    donorConfig: {
      isAccountKept: false,
      bonusPerHourMultiplier: 2,
    },
  },
};

export default class NexusPHP extends PrivateSite {
  protected guessSearchFieldIndexConfig(): Record<string, string[]> {
    return {
      author: ['a[href*="sort=9"]'], // 发布者
      comments: ["img.comments"], // 评论数
      completed: ["img.snatched"], // 完成数
      leechers: ["img.leechers"], // 下载数
      seeders: ["img.seeders"], // 种子数
      size: ["img.size"], // 大小
      time: ["img.time"], // 发布时间 （仅生成 selector， 后面会覆盖）
    } as Record<keyof ITorrent, string[]>;
  }

  protected get customTagsLocaterSelector(): string {
    return "table.torrentname";
  }

  public override async transformSearchPage(
    doc: Document | object | any,
    searchConfig: ISearchInput,
  ): Promise<ITorrent[]> {
    let { keywords, searchEntry, requestConfig } = searchConfig;

    // 返回是 Document 的情况才自动生成 row 选择器以及其他属性的选择器
    if (doc instanceof Document) {
      // 自动生成的选择器写入局部副本，避免写回共享的 metadata.search.selectors (P2-15)
      searchEntry = { ...searchEntry, selectors: { ...(searchEntry?.selectors ?? {}) } };

      // 如果配置文件没有传入 search 的选择器，则我们自己生成
      const legacyTableSelector = "table.torrents:last";

      // 对于NPHP，一般来说，表的第一行应该是标题行，即 `> tbody > tr:nth-child(1)` ，但是也有部分站点为 `> thead > tr`
      const legacyTableHasThead = selectElements(`${legacyTableSelector} > thead > tr`, doc).length > 0;

      if (!searchEntry!.selectors!.rows) {
        searchEntry!.selectors!.rows = {
          // 对于有thead的站点，认为 > tbody > tr 均为种子信息，而无 thead 的站点则为 > tbody > tr:gt(0)
          selector: `${legacyTableSelector} > tbody > tr` + (legacyTableHasThead ? "" : ":gt(0)"),
        };
      }

      // 开始遍历我们的head行，并设置其他参数
      const headSelector =
        legacyTableSelector + (legacyTableHasThead ? " > thead > tr > th" : " > tbody > tr:eq(0) > td");
      const headAnother = selectElements(headSelector, doc) as HTMLElement[];

      // 原实现外层循环缺少 break（last-match-wins），这里反序遍历、命中即跳出，结果等价且只需扫描一次
      // guessSearchFieldIndexConfig() 提到循环外只调用一次
      const guessSearchFieldIndexEntries = Object.entries(this.guessSearchFieldIndexConfig()).reverse();

      headAnother.forEach((element, elementIndex) => {
        // 比较好处理的一些元素，都是可以直接获取的
        let updateSelectorField;
        if (/(cat|类型|類型|分类|分類|Тип)/gi.test(element.innerText)) {
          updateSelectorField = "category";
        } else {
          for (const [dectField, dectSelector] of guessSearchFieldIndexEntries) {
            let matched = false;
            for (const dectFieldElement of dectSelector) {
              if (selectElements(dectFieldElement, element).length > 0) {
                matched = true;
                break;
              }
            }
            if (matched) {
              updateSelectorField = dectField;
              break;
            }
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

  public override async getUserInfoResult(lastUserInfo: Partial<IUserInfo> = {}): Promise<IUserInfo> {
    let flushUserInfo = await super.getUserInfoResult(lastUserInfo);

    // 导入用户做种信息
    if (
      flushUserInfo.status === EResultParseStatus.success &&
      (typeof flushUserInfo.seeding === "undefined" || typeof flushUserInfo.seedingSize === "undefined")
    ) {
      await this.sleepAction(this.metadata.userInfo?.requestDelay);
      flushUserInfo = (await this.parseUserInfoForSeedingStatus(flushUserInfo)) as IUserInfo;
    }

    // 导入用户发布信息
    if (flushUserInfo.status === EResultParseStatus.success && typeof flushUserInfo.uploads === "undefined") {
      await this.sleepAction(this.metadata.userInfo?.requestDelay);
      flushUserInfo = (await this.parseUserInfoForUploads(flushUserInfo)) as IUserInfo;
    }

    // 处理捐赠者的特殊配置
    if (flushUserInfo.status === EResultParseStatus.success) {
      const donorConfig = this.metadata.userInfo?.donorConfig;
      if (flushUserInfo.isDonor === true && typeof flushUserInfo.bonusPerHour === "number") {
        const bonusPerHourMultiplier = donorConfig?.bonusPerHourMultiplier ?? 1;
        flushUserInfo.bonusPerHour *= bonusPerHourMultiplier;
      }
    }

    return flushUserInfo;
  }

  /**
   * 鉴于NexusPHP这里使用ajax交互，如果强行指定 responseType: 'document' ，
   * 由于返回字段并不是 valid-html, 此时会解析失败（即 data = undefined ），
   * 所以此处不指定 responseType，而是返回文本形式的 string，交由 getUserSeedingStatus
   * 生成 Document
   *
   * @param userId
   * @param type
   * @protected
   */
  protected async requestUserSeedingPage(userId: number, type: string = "seeding"): Promise<string | null> {
    const { data } = await this.request<string>({
      url: "/getusertorrentlistajax.php",
      params: { userid: userId, type },
    });
    return data || null;
  }

  protected async parseUserInfoForSeedingStatus(flushUserInfo: Partial<IUserInfo>): Promise<Partial<IUserInfo>> {
    const userId = flushUserInfo.id as number;
    const userSeedingRequestString = await this.requestUserSeedingPage(userId);

    let seedStatus = { seeding: 0, seedingSize: 0 };
    if (userSeedingRequestString && userSeedingRequestString?.includes("<table")) {
      const userSeedingDocument = createDocument(userSeedingRequestString);
      /**
       * #1060 HUDBT 等站点可能存在 seeding table 中也有 "xx | xx" 的文本，但并非我们需要的做种和做种大小信息
       * 所以需要找到和 table 平级的 div 中包含 " | " 的文本，才认为是我们需要的做种和做种大小信息
       * https://github.com/xiaomlove/nexusphp/blob/09b785902f5da87de7fa45dd5409eee37f78bc89/public/getusertorrentlistajax.php#L357-L358
       */
      const divSeeding = selectElements("div:has( ~ table) > div:contains(' | ')", userSeedingDocument);
      if (divSeeding.length > 0 && divSeeding[0].textContent) {
        const seedingText = divSeeding[0].textContent.split("|");
        seedStatus.seeding = definedFilters.parseNumber(seedingText[0]);
        seedStatus.seedingSize = definedFilters.parseSize(seedingText[1]);
      } else {
        const trAnothers = selectElements("table:last tr:not(:eq(0))", userSeedingDocument);
        if (trAnothers.length > 0) {
          seedStatus.seeding = trAnothers.length;

          // 根据自动判断应该用 td.rowfollow:eq(?)
          let sizeIndex = 2;
          const tdAnothers = selectElements("> td", trAnothers[0]);
          for (let i = 0; i < tdAnothers.length; i++) {
            if (sizePattern.test((tdAnothers[i] as HTMLElement).innerText)) {
              sizeIndex = i;
              break;
            }
          }

          trAnothers.forEach((trAnother) => {
            // E-4：`td:eq(N)` 对少列的行（colspan 表头/表尾、结构异常行）会返回空数组，
            // 直接取 [0] 再 .innerText 会抛 TypeError 并让整次用户信息刷新失败，
            // 因此与 Gazelle 的同款循环一样必须先确认取到了元素。
            const sizeElement = selectElements(`td:eq(${sizeIndex})`, trAnother)[0] as HTMLElement | undefined;
            if (!sizeElement) return;

            seedStatus.seedingSize += parseSizeString(sizeElement.innerText.trim());
          });
        }
      }
    }

    flushUserInfo = mergeWith(flushUserInfo, seedStatus, (objValue, srcValue) => {
      return typeof srcValue === "undefined" ? objValue : srcValue;
    });

    return flushUserInfo;
  }

  protected async parseUserInfoForUploads(flushUserInfo: Partial<IUserInfo>): Promise<Partial<IUserInfo>> {
    const userId = flushUserInfo.id as number;
    const userUploadsRequestString = await this.requestUserSeedingPage(userId, "uploaded");
    flushUserInfo.uploads = 0;

    if (
      // 先按关键字匹配
      userUploadsRequestString &&
      /<b>\d+<\/b>(条记录| records|條記錄)|No record.|没有记录|沒有記錄/.test(userUploadsRequestString)
    ) {
      flushUserInfo.uploads = Number(userUploadsRequestString.match(/<b>(\d+)<\/b>(条记录| records|條記錄)/)?.[1] ?? 0);
    } else if (userUploadsRequestString && userUploadsRequestString?.includes("<table")) {
      // 未匹配到关键字，则从表格中解析
      const userUploadsDocument = createDocument(userUploadsRequestString);
      const divSeeding = selectElements("div:has( ~ table) > div:contains(' | ')", userUploadsDocument);
      if (divSeeding.length > 0 && divSeeding[0].textContent) {
        const seedingText = divSeeding[0].textContent.split("|");
        flushUserInfo.uploads = definedFilters.parseNumber(seedingText[0]);
      } else {
        const trAnothers = selectElements("table:last tr:not(:eq(0))", userUploadsDocument);
        flushUserInfo.uploads = trAnothers.length;
      }
    }

    return flushUserInfo;
  }

  protected override parseTorrentRowForTags(
    torrent: Partial<ITorrent>,
    row: Element | Document,
    searchConfig: ISearchInput,
  ): Partial<ITorrent> {
    super.parseTorrentRowForTags(torrent, row, searchConfig);

    // 新版 NPHP 支持自定义的tag
    const customTags = row.querySelectorAll(
      `${this.customTagsLocaterSelector} span[style*='background-color'][style*='color'][title]`,
    );
    if (customTags.length > 0) {
      const tags: ITorrentTag[] = torrent.tags || [];
      customTags.forEach((element) => {
        const htmlElement = element as HTMLElement;
        const tagName = htmlElement.textContent;
        let tagColor = htmlElement.style.backgroundColor;

        // 处理渐变色 linear-gradient(45deg, rgb(248, 87, 86), rgb(249, 166, 95)) 的情况，取第一个非白色的 rgb 颜色作为标签颜色
        if (tagColor === "" && htmlElement.style.backgroundImage?.startsWith("linear-gradient")) {
          const gradientMatch = htmlElement.style.backgroundImage.match(/rgb\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\)/g);

          if (gradientMatch && gradientMatch.length > 0) {
            for (const rgb of gradientMatch) {
              // 简单的过滤掉白色
              if (rgb.trim() !== "rgb(255, 255, 255)") {
                tagColor = rgb.trim();
                break;
              }
            }
          }
        }

        if (tagName && tagColor) {
          tags.push({ name: tagName, color: tagColor });
        }
      });

      torrent.tags = tags;
    }

    return torrent;
  }

  public override async getTorrentDownloadLink(torrent: ITorrent): Promise<string> {
    // 如果没有 link 属性，则尝试以 (url->)id->link 的方式生成
    if (!torrent.link) {
      if (!torrent.id && torrent.url) {
        try {
          const urlMatch = new URL(torrent.url, this.url).searchParams.get("id");
          if (urlMatch) {
            torrent.id ??= urlMatch;
          }
        } catch {
          // Invalid detail URLs fall through to the existing URL-based identity fallback.
        }
      }

      if (torrent.id) {
        const mockRequestConfig = torrent.url?.startsWith("http") ? { url: torrent.url } : { baseURL: this.url };
        torrent.link = this.fixLink(`/download.php?id=${torrent.id}`, mockRequestConfig);
      }
    }

    // 对 NPHP 站点，如果前端拖拽功能发来的种子链接是 details.php?id=123 的形式，
    if (torrent.link && torrent.link.includes("/details.php")) {
      torrent.link = torrent.link.replace(/details\.php\?id=(\d+)/, "download.php?id=$1").replace(/&hit=1/, ""); // hit=1 是为了统计下载次数
    }

    return super.getTorrentDownloadLink(torrent);
  }
}
