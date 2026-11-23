/**
 * @JackettDefinitions https://github.com/Jackett/Jackett/blob/master/src/Jackett.Common/Definitions/anibt.yml
 */
import { type IElementQuery, type ISiteMetadata } from "../types";

/**
 * 在命名空间感知的 XML 文档（application/xml）中，CSS 转义选择器 `anibt\:...` 无法匹配
 * 实际 `localName` 为无前缀名称的 `<anibt:...>` 元素，因此改用 DOM 原生标签遍历提取文本。
 * 每次调用返回独立闭包，避免被静态校验误判为重复选择器。
 */
function xmlNamespaceText(tagName: string): IElementQuery {
  const lowerTag = tagName.toLowerCase();
  const [prefix = "", localName = lowerTag] = lowerTag.split(":");
  return {
    selector: ":self",
    elementProcess: (item: Element) => {
      const direct = item.getElementsByTagName(tagName)[0];
      if (direct) {
        return direct.textContent?.trim() ?? "";
      }
      const all = item.getElementsByTagName("*");
      for (let i = 0; i < all.length; i++) {
        const el = all[i];
        const elTag = (el.tagName || "").toLowerCase();
        const elLocal = (el.localName || "").toLowerCase();
        if (elTag === lowerTag || (prefix && el.prefix?.toLowerCase() === prefix && elLocal === localName)) {
          return el.textContent?.trim() ?? "";
        }
      }
      return undefined;
    },
  };
}

export const siteMetadata: ISiteMetadata = {
  version: 1,
  id: "anibt",
  name: "Anibt",
  aka: ["AniBT"],
  description: "Anibt is a CHINESE Public aggregate indexer for ANIME",
  tags: ["动漫"],

  type: "public",
  urls: ["https://anibt.net/"],
  timezoneOffset: "+0800", // feed 的 pubDate 为 +0800

  category: [
    {
      // 分类决定读取哪条 feed（对应 Jackett 的 5 个 path），key 为 #url 时该值直接写入 requestConfig.url
      name: "分类",
      key: "#url",
      options: [
        { name: "Anime", value: "/rss/magnets.xml" },
        { name: "Manga", value: "/rss/other/manga.xml" },
        { name: "Music", value: "/rss/other/music.xml" },
        { name: "Raw", value: "/rss/other/raw.xml" },
        { name: "Stage", value: "/rss/other/stage.xml" },
      ],
    },
  ],

  search: {
    // Jackett 的 inputs: q={{ .Keywords }}（以及 sortField/sortOrder 两个用户配置，这里不开放）
    keywordPath: "params.q",
    requestConfig: { url: "/rss/magnets.xml", responseType: "document" }, // application/xml 的 torznab 风格 feed
    selectors: {
      rows: { selector: "rss > channel > item" },
      id: { selector: "guid" },
      title: { selector: "title" },
      // Jackett 的 description 取 animeTitle（原名，如「名侦探光之美少女！」）
      subTitle: xmlNamespaceText("anibt:animeTitle"),
      // Jackett 的 details 取 <link>；二者取值相同，这里用扩展字段避免 description 内嵌内容造成的选择歧义
      url: xmlNamespaceText("anibt:releasePageUrl"),
      link: { selector: "enclosure", attr: "url" },
      time: { selector: "pubDate", filters: [{ name: "parseTime" }] },
      size: xmlNamespaceText("anibt:fileSize"), // 精确字节数
      // 该 feed 没有 <category> 元素，Jackett 用 anibt:type 兜底
      category: xmlNamespaceText("anibt:type"),
      // seeders / leechers：站点不提供（Jackett 里是硬编码的 1），留空
    },
  },
};
