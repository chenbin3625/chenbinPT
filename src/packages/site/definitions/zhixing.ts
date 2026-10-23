/**
 * @PTPPDefinitions https://github.com/chenbin3625/PT-Plugin-Plus/blob/dev/resource/sites/pt.zhixing.bjtu.edu.cn/config.json
 */
import urlJoin from "url-join";

import { createDocument, logMessage, siteErrorLogData } from "../utils";
import PrivateSite from "../schemas/AbstractPrivateSite.ts";
import { EResultParseStatus, type ISiteMetadata, type IUserInfo } from "../types";

export const siteMetadata: ISiteMetadata = {
  id: "zhixing",
  version: 1,

  name: "知行PT",
  description: "北京交通大学知行PT",
  tags: ["教育网", "综合", "影视"],
  timezoneOffset: "+0800",
  collaborator: ["wanicca", "Rhilip"],

  type: "private",
  // Info-46 / L-3：schemas/ 下没有 CGBTSource 引擎，实际基类是本文件导出的 default class（extends PrivateSite）。
  // schema 写真实基类名，避免「误删 default class 后静默回落裸 AbstractPrivateSite」且无类型错误。
  schema: "AbstractPrivateSite",
  urls: ["http://pt.zhixing.bjtu.edu.cn/"],

  category: [
    {
      name: "类别",
      key: "category",
      options: [
        { name: "全部", value: "" },
        { name: "电影", value: "movie" },
        { name: "剧集", value: "tv" },
        { name: "音乐", value: "music" },
        { name: "动漫", value: "comic" },
        { name: "游戏", value: "game" },
        { name: "综艺", value: "zongyi" },
        { name: "体育", value: "sports" },
        { name: "软件", value: "software" },
        { name: "学习", value: "study" },
        { name: "纪录片", value: "documentary" },
        { name: "其他", value: "other" },
      ],
      cross: false,
      generateRequestConfig: (options) => {
        // L-33：选「全部」时 value 是空串，模板串会生成 `/search//`（双斜杠）。
        // 空类目直接请求 `/search/`，与非空类目保持同一路径形状。
        const categoryPath = typeof options === "string" && options !== "" ? `${options}/` : "";
        return {
          requestConfig: {
            url: `/search/${categoryPath}`,
          },
        };
      },
    },
  ],
  search: {
    requestConfig: {
      url: "/search/",
    },
    requestConfigTransformer: ({ keywords, requestConfig }) => {
      const baseUrl = requestConfig!.url || "";
      if (keywords) {
        delete requestConfig!.params?.keywords;
        requestConfig!.url = urlJoin(baseUrl, `x${keywords}`);
      }

      return requestConfig!;
    },
    selectors: {
      rows: { selector: "table.torrenttable > tbody > tr:gt(0)" },
      id: { selector: ":self", attr: "id", filters: [{ name: "replace", args: [/^t/, ""] }] },
      title: { selector: "a[name='title']" },
      url: { selector: "a[name='title']", attr: "href" },
      link: { selector: "a[href*='/download/']", attr: "href" },
      time: {
        selector: " > td:nth-child(7)",
        filters: [{ name: "parseTime", args: ["MM-dd HH:mm", "yyyy-MM-dd HH:mm"] }],
      },
      size: { selector: " > td:nth-child(4)", filters: [{ name: "parseSize" }] },
      author: { selector: " > td:nth-child(11)" },
      seeders: { selector: " > td:nth-child(8)" },
      leechers: { selector: " > td:nth-child(9)" },
      completed: { selector: " > td:nth-child(10)" },
      comments: { selector: " > td:nth-child(5)" },
      category: {
        selector: "td.icon-td > img",
        attr: "src",
        filters: [(x: string) => x.split("/").at(-1)?.replace(".png", "")],
      },
      tags: [
        { name: "Free", selector: "img[src^='/static/images/btn_free.gif']", color: "blue" },
        { name: "50%", selector: "img[src^='/static/images/btn_50p.gif']", color: "orange" },
        { name: "30%", selector: "img[src^='/static/images/btn_30p.gif']", color: "indigo" },
      ],
    },
  },

  detail: {
    urlPattern: ["/torrents/(\\d+)"],
    selectors: {
      id: { selector: "a[href*='/download/']", attr: "href", filters: [{ name: "parseNumber" }] },
      title: { selector: "div.torrent-title h1", filters: [{ name: "replace", args: ["种子名称：", ""] }] },
      link: { selector: "a[href*='/download/']", attr: "href" },
    },
  },

  userInfo: {
    pickLast: ["id", "name"],
    process: [
      {
        requestConfig: { url: "/" },
        selectors: {
          id: {
            selector: "strong.vwmy > a[href*='/user/']:first",
            attr: "href",
            filters: [{ name: "split", args: ["/", 2] }],
          },
          name: { selector: "strong.vwmy > a[href*='/user/']:first" },
        },
      },
      {
        requestConfig: { url: "/user/$id$" },
        assertion: { id: "url" },
        selectors: {
          uploaded: { selector: ["p:contains('上传流量:')"], filters: [{ name: "parseSize" }] },
          downloaded: { selector: ["p:contains('下载流量:')"], filters: [{ name: "parseSize" }] },
          ratio: {
            selector: "p:contains('共享率')",
            filters: [
              { name: "replace", args: [/共享率: | (下载-虚拟下载小于20G则共享率为0)/, ""] },
              { name: "parseNumber" },
            ],
          },
          levelName: {
            selector: ["p:contains('用户组：')"],
            filters: [(query) => query.match(/用户组：([^ ]+)/)?.[1] ?? ""],
          },
          bonus: {
            selector: ["p:contains('总积分：')"],
            filters: [{ name: "parseNumber" }],
          },
          seedingBonus: {
            selector: ["p:contains('保种积分')"],
            filters: [{ name: "parseNumber" }],
          },
          joinTime: {
            selector: ["p:contains('注册时间：')"],
            filters: [{ name: "split", args: ["：", 1] }, { name: "parseTime" }],
          },
          seeding: {
            selector: ["p:contains('当前保种数量：')"],
            filters: [{ name: "parseNumber" }],
          },
          seedingSize: {
            selector: ["p:contains('当前保种容量：')"],
            filters: [{ name: "parseSize" }],
          },
          lastAccessAt: {
            selector: ["p:contains('上次IPv6访问时间：')", "p:contains('上次访问时间：')"],
            filters: [{ name: "split", args: ["：", 1] }, { name: "parseTime" }],
          },
        },
      },
    ],
  },
  levelRequirements: [
    { id: 0, name: "地狱使者", bonus: -999 },
    { id: 1, name: "武林新丁", bonus: -1 },
    { id: 2, name: "江湖小虾", bonus: 20 },
    { id: 3, name: "后起之秀", bonus: 100 },
    { id: 4, name: "武林高手", bonus: 200 },
    { id: 5, name: "风尘奇侠", bonus: 500 },
    { id: 6, name: "无双隐士", bonus: 1000 },
    { id: 7, name: "世外高人", bonus: 2000 },
    { id: 8, name: "江湖侠隐", bonus: 4000 },
    { id: 9, name: "无敌圣者", bonus: 7000 },
    { id: 10, name: "三界贤君", bonus: 12000 },
  ],
};

export default class Zhixing extends PrivateSite {
  protected async parseUserInfoForUserTorrent(
    type: "uploaded" | "seeding",
    userId: string,
  ): Promise<{ count: number; size: number }> {
    const retUserInfo = { count: 0, size: 0 };
    // L-34：终止条件原先只依赖「越界页返回空表」。若站点对越界页码回落到最后一页，
    // `tbody > tr` 数仍 > 1 → 永久循环；这里加页数上限、请求间隔，并对连续两页内容做去重判断。
    const MAX_PAGES = 50;
    let currentPage = 1;
    let previousPageSignature: string | undefined;
    while (currentPage <= MAX_PAGES) {
      // 批量抓取用户种子时逐页限速，避免触发站点 anti-flood
      await this.sleepAction(this.metadata.userInfo?.requestDelay ?? this.metadata.requestDelay ?? 0);
      const requestConfig = { url: `/user/${userId}/${type}/p${currentPage}` };
      const { data: TListString } = await this.request<string>(requestConfig);

      const TListDocument = createDocument(TListString);
      const table = TListDocument.querySelector("table.torrenttable");
      if (!table) {
        throw new Error(`用户${type}列表第 ${currentPage} 页缺少种子表格`);
      }
      if (table.querySelectorAll("tbody > tr").length <= 1) break;

      // 站点对越界页码回落最后一页时，连续两页的第一条数据行相同；此时停止，避免把同一页重复计数。
      // 注意 table.torrenttable 的第一个 tbody > tr 是表头（rows 选择器是 `tr:gt(0)`），
      // 必须取第 2 行作为「首条数据行」，否则每页表头相同会让循环在第一页后就误停。
      const dataRows = table.querySelectorAll("tbody > tr");
      const firstDataRowSignature = dataRows[1]?.outerHTML;
      if (firstDataRowSignature && firstDataRowSignature === previousPageSignature) break;
      previousPageSignature = firstDataRowSignature;

      const TList = await this.transformSearchPage(TListDocument, {
        searchEntry: this.metadata.search,
        requestConfig,
        keywords: "",
      });

      retUserInfo.count += TList.length;
      retUserInfo.size += TList.reduce((sum, torrent) => sum + (torrent.size || 0), 0);
      currentPage += 1;
    }

    return retUserInfo;
  }

  public override async getUserInfoResult(lastUserInfo: Partial<IUserInfo> = {}): Promise<IUserInfo> {
    const flushUserInfo: IUserInfo = await super.getUserInfoResult(lastUserInfo);

    if (flushUserInfo.status === EResultParseStatus.success && flushUserInfo.id) {
      try {
        const seedingInfo = await this.parseUserInfoForUserTorrent("seeding", flushUserInfo.id as string);
        const uploadedInfo = await this.parseUserInfoForUserTorrent("uploaded", flushUserInfo.id as string);
        flushUserInfo.seeding = seedingInfo.count;
        flushUserInfo.seedingSize = seedingInfo.size;
        flushUserInfo.uploads = uploadedInfo.count;
      } catch (error) {
        // L-35：做种/发布列表只是可选增强。super 已成功拿到 uploaded/downloaded/ratio/levelName，
        // 这里若把 status 改成错误态，UI 会把整条记录当失败（与 NexusPHP/Gazelle 对可选步骤只 warn 同构）。
        logMessage(
          `[Site] ${this.name} parseUserInfoForUserTorrent failed`,
          { site: this.metadata.id, error: siteErrorLogData(error) },
          "warn",
        );
      }
    }

    return flushUserInfo;
  }
}
