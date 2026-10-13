/**
 * @JackettDefinitions https://github.com/Jackett/Jackett/blob/master/src/Jackett.Common/Definitions/0magnet.yml
 * @JackettIssue https://github.com/Jackett/Jackett/issues/10738
 */
import { type ISearchInput, type ISiteMetadata } from "../types";
import { extractContent } from "../utils";

export const siteMetadata: ISiteMetadata = {
  version: 1,
  id: "0magnet",
  name: "0Magnet",
  aka: ["ØMagnet", "无极磁链"],
  description: "ØMagnet 是一个专注于高清电影和电视剧的私人种子站点，提供高质量的影视资源下载服务。",
  // E1-A1：本站是综合磁力搜索（同一文件的列表/详情选择器都按影视站描述），不是成人站；
  // 原先 tags 与搜索行的 category 都被硬编码成 "XXX"，会让所有结果被当成成人内容。
  tags: ["磁力", "影视"],

  type: "public",

  // from https://cili404.com/
  urls: [
    "uggcf://16znt.arg/",
    "uggcf://0zntarg.pbz/",
    // 英文站
    "uggcf://8pv.yv/",
    "uggcf://7znt.arg/",
    "uggcf://13znt.arg/",
    "uggcf://trgznt.arg/",
    // 中文站
    "uggcf://kpvyv.arg/",
    "uggcf://1pvyv.pbz/",
    "uggcf://pvyv.vasb/",
    "uggcf://pvyv.hx/",
    "uggcf://jhwv.zr/",
    "uggcf://0pvyv.pbz/",
    "uggcf://0pvyv.zl/",
  ],

  legacyUrls: ["uggcf://6znt.arg/", "uggcf://9znt.arg/", "uggcf://0znt.arg/"],

  search: {
    keywordPath: "params.q",
    requestConfig: {
      url: "/search",
    },
    requestConfigTransformer: (input: ISearchInput) => {
      if (!input.keywords) {
        input.requestConfig!.url = "/listing";
      }
      return input.requestConfig!;
    },
    selectors: {
      rows: { selector: "table.file-list > tbody > tr:has(td)" },
      id: { selector: "a", attr: "href" },
      title: {
        selector: "a",
        elementProcess: (element: HTMLAnchorElement) =>
          extractContent(element.innerHTML.split('<p class="sample">')[0]).trim(),
      },
      subTitle: { selector: "p.sample" },
      url: { selector: "a", attr: "href" },
      // link 需要访问后获取
      size: { selector: "td.result-meta > div:not(.result-date)", filters: [{ name: "parseSize" }] },
      time: { selector: "td.result-meta div.result-date", filters: [{ name: "parseTime", args: ["yyyy-MM-dd"] }] },
      // E1-A1：列表页没有分类选择器，不要硬编码成 "XXX"（会让每条结果都进成人分类）；
      // 归入 Other，等站点提供真实分类再按选择器解析（E1-A6 已记录 urlPattern 过宽，需真实页面确认）。
      category: { text: "Other" },
    },
  },

  list: [{ urlPattern: ["/listing", "/search"] }],

  detail: {
    urlPattern: ["/!"],
    selectors: {
      title: { selector: "h2.magnet-title" },
      // 列表页的 id 就是 `/!xxxx` 这段相对路径（search.selectors.id 取的是 a[href]），
      // 详情页没有等价链接元素，只能从 URL 里截出同一段，两边才会是同一个 id
      id: {
        selector: ":self",
        elementProcess: (element: Document) => (element.URL ?? "").match(/\/![^/?#]+/)?.[0] ?? element.URL ?? "",
      },
      link: { selector: "input#input-magnet", attr: "value" },
      // 与列表页的 category 保持一致（E1-A1：不按成人站硬编码 XXX）
      category: { text: "Other" },
      time: {
        selector: ["dt:contains('Date') + dd", "dt:contains('发布日期') + dd"],
        filters: [{ name: "parseTime" }],
      },
      size: {
        selector: ["dt:contains('Size') + dd", "dt:contains('文件大小') + dd"],
        filters: [{ name: "parseSize" }],
      },
    },
  },
};
