/**
 * @JackettDefinitions https://github.com/Jackett/Jackett/blob/master/src/Jackett.Common/Definitions/ehentai.yml
 */
import BittorrentSite from "../schemas/AbstractBittorrentSite";
import { ITorrent, type ISiteMetadata } from "../types";

export const siteMetadata: ISiteMetadata = {
  version: 1,
  id: "ehentai",
  name: "E-Hentai",
  aka: ["EH"],
  description: "E-Hentai is a Public site for Hentai doujinshi, manga.",
  tags: ["漫画", "成人"],
  timezoneOffset: "+0000",

  type: "public",

  urls: ["uggcf://r-uragnv.bet/", "uggcf://rkuragnv.bet/"],

  search: {
    keywordPath: "params.search",
    requestConfig: {
      url: "/torrents.php",
      responseType: "document",
    },
    advanceKeywordParams: {
      imdb: false,
    },
    selectors: {
      rows: { selector: "table.itg > tbody > tr:has(td)" },
      // E2-09/E2b-12：原实现取图库列链接的文本（图库 id），同一图库的多个种子（不同分辨率）
      // 会共用同一个 id，插件的种子身份/下载历史按 site+id 记账时会相互覆盖。
      // 种子唯一位在 gallerytorrents 链接里：优先 gtid，其次 t（hash），最后才退回 gid。
      id: {
        selector: "a[href*='/gallerytorrents.php?gid=']",
        attr: "href",
        filters: [
          (href: string) => {
            // base 只用于解析相对链接，这里只读 searchParams，与主机无关；用中性地址，
            // 避免在 rot13 保护的成人站点定义里写出明文域名（上游 22573d1c 的静态校验）
            const parsed = URL.parse(href, "https://localhost/");
            return (
              parsed?.searchParams.get("gtid") ??
              parsed?.searchParams.get("t") ??
              parsed?.searchParams.get("gid") ??
              href
            );
          },
        ],
      },
      title: { selector: "a[href*='/gallerytorrents.php?gid=']" },
      url: { selector: "a[href*='/g/']", attr: "href" },
      link: { selector: "a[href*='/gallerytorrents.php?gid=']", attr: "href" },
      time: { selector: "td:first-child", filters: [{ name: "parseFuzzyTime" }] },
      size: { selector: "td:nth-child(4)", filters: [{ name: "parseSize" }] },
      seeders: { selector: "td:nth-child(5)" },
      leechers: { selector: "td:nth-child(6)" },
      completed: { selector: "td:nth-child(7)" },
    },
  },
};

export default class EHentai extends BittorrentSite {
  public override async getTorrentDownloadLink(torrent: ITorrent): Promise<string> {
    const dlPage = await this.request<Document>({ url: torrent.link, responseType: "document" });
    const link = this.getFieldData(dlPage.data, {
      selector: "a[href*='.torrent']:first-of-type",
      attr: "href",
    }) as string;

    // E2b-11：getFieldData 零命中时回落 ""，原实现直接把空串返回给调用方 ——
    // offscreen/utils/download.ts 的 isTrustedDownloadLink("") 会把它解析成站点根地址并通过白名单，
    // 最终把首页 HTML 当种子下载。这里改为明确失败，并复用父类追加 downloadLinkAppendix 的逻辑。
    if (!link) {
      throw new Error(`[PTD] site '${this.name}' cannot parse .torrent link (torrentId=${torrent.id ?? ""})`);
    }

    return super.getTorrentDownloadLink({ ...torrent, link });
  }
}
