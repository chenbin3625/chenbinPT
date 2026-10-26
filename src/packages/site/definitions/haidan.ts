/**
 * @JackettDefinitions https://github.com/Jackett/Jackett/blob/master/src/Jackett.Common/Definitions/haidan.yml
 * @PTPPDefinitions https://github.com/chenbin3625/PT-Plugin-Plus/blob/dev/resource/sites/haidan.video/config.json
 * @PDSDefinitions https://github.com/mantou568/pre-dessert-sites/blob/main/site_config/sites/haidan.json
 */
import { type ISiteMetadata, ETorrentStatus } from "../types";
import { CategoryInclbookmarked, CategoryIncldead, CategorySpstate, SchemaMetadata } from "../schemas/NexusPHP.ts";

/**
 * REVIEW-FINDINGS site-defs #6：与 kunlun（已死亡站点）解耦。原先直接
 * `import { userInfoWithInvitesInUserDetailsPage } from "./kunlun.ts"`，把活站配置绑在死站文件上
 * （kunlun 被清理时本文件在 import 阶段即失败），且该对象是模块级共享可变对象。
 * 这里内联一份等价定义（基于 NexusPHP SchemaMetadata，只在 userdetails 页追加 invites 字段），
 * 与 52pt / yinguskg 的处理方式一致；选择器逐字取自 kunlun 原导出，未做猜测。
 */
const userInfoWithInvitesInUserDetailsPage = {
  ...SchemaMetadata.userInfo,
  selectors: {
    ...SchemaMetadata.userInfo.selectors!,
    invites: {
      selector: [
        "td.rowhead:contains('邀请') + td",
        "td.rowhead:contains('Invites') + td",
        "td.rowhead:contains('Available') + td",
        "td:contains('邀请')",
        "td:contains('邀請')",
        "td:contains('Invites')",
        "td:contains('Available')",
      ],
      filters: [
        (query: string) => {
          if (!query?.trim()) return 0;
          try {
            // 匹配 "Available: 5" 格式
            const availableMatch = query.match(/Available:\s*(\d+)/i);
            if (availableMatch) return parseInt(availableMatch[1], 10) || 0;

            // 匹配纯数字
            const num = parseInt(query.match(/\d+/)?.[0] || "0", 10);
            return Number.isNaN(num) ? 0 : num;
          } catch {
            return 0;
          }
        },
      ],
    },
  },
  process: [
    ...SchemaMetadata.userInfo.process!.map((item) => {
      // 在用户详情页面添加 invites 字段
      if (item.requestConfig.url === "/userdetails.php") {
        return {
          ...item,
          fields: [...(item.fields || []), "invites"],
        };
      }
      return item;
    }),
  ],
};

const linkQuery = {
  selector: ['a[href*="download.php?id="]'],
  attr: "href",
};

/**
 * E3-11：向上查找带指定类名的祖先。
 *
 * 旧实现用递归 + `element.classList.contains`：`document`（HTML 元素之上还有 Document 节点）不是空值、
 * `classList` 却是 `undefined`，因此任何一行缺少 `.group_content` 祖先（改版 / 置顶行 / 结构异常行）都会抛
 * `TypeError: Cannot read properties of undefined (reading 'contains')`，该行解析失败；整页都这样时
 * `transformSearchPage` 直接报 parseError。改为循环 + `parentElement`（到 `<html>` 自然结束）+ 可选链，
 * 找不到时返回 `null`，由调用点兜底成空串。
 */
function findParentByClass(element: Element | null | undefined, className: string): HTMLElement | null {
  for (let el: Element | null = element ?? null; el; el = el.parentElement) {
    if (el.classList?.contains(className)) {
      return el as HTMLElement;
    }
  }
  return null;
}

export const siteMetadata: ISiteMetadata = {
  ...SchemaMetadata,

  version: 1,
  id: "haidan",
  name: "海胆",
  aka: ["海胆之家", "HaiDan"],
  tags: ["电影", "电视剧", "影视", "综合"],

  collaborator: ["rsj", "zhuweitung"],

  type: "private",
  schema: "NexusPHP",

  urls: ["uggcf://jjj.unvqna.pp/"],

  legacyUrls: ["uggcf://jjj.unvqna.ivqrb/"],

  category: [
    {
      name: "类型",
      key: "cat",
      options: [
        { name: "Documentaries(纪录片)", value: 404 },
        { name: "Movies(电影)", value: 401 },
        { name: "Animations(动画片)", value: 405 },
        { name: "TV Series(电视剧)", value: 402 },
        { name: "TV Shows(综艺)", value: 403 },
        { name: "Music Videos(MV)", value: 406 },
        { name: "Sports(体育)", value: 407 },
        { name: "Misc(其他)", value: 409 },
        { name: "HQ Audio(音乐)", value: 408 },
      ],
      cross: { mode: "comma" },
    },
    {
      ...CategorySpstate,
      cross: { mode: "comma" },
    },
    CategoryIncldead,
    CategoryInclbookmarked,
  ],

  search: {
    ...SchemaMetadata.search,
    selectors: {
      ...SchemaMetadata.search.selectors!,
      rows: { selector: ".torrent_wrap" },
      link: linkQuery,
      url: {
        ...linkQuery,
        filters: [
          { name: "querystring", args: ["id"] },
          { name: "prepend", args: ["/details.php?id="] },
        ],
      },
      id: {
        ...linkQuery,
        filters: [{ name: "querystring", args: ["id"] }],
      },
      title: {
        selector: ":self",
        elementProcess: (element: HTMLElement) => {
          const group = findParentByClass(element, "group_content");
          return group?.querySelector(".name_col > .name > .video_name")?.textContent?.trim() || "";
        },
      },
      subTitle: {
        selector: [".torrent_name_col a[href*='details.php']"],
      },
      time: {
        selector: [".time_col span[title]"],
        attr: "title",
        filters: [{ name: "parseTime" }], // T-1：过滤器名是 parseTime（其实现为 parseValidTimeString），旧名会被静默跳过
      },
      size: { selector: ".video_size", filters: [{ name: "parseSize" }] },
      author: { selector: [".time_col>i, .time_col>.username-center"] },
      seeders: { selector: ".seeder_col" },
      leechers: { selector: ".leecher_col" },
      completed: { selector: ".snatched_col" },

      /**
       * 进度信息位于 `.torrent_wrap > .poster > progress[data-label]`（原生 progress 元素，
       * 百分比以 "100%" 的形式放在 data-label 属性上，元素本身无文本内容）。
       *
       * 取 `.torrent_wrap` 作为行（而非 `.torrent_item`），使 progress 成为行内普通后代，
       * 无需再手动上溯父级。组头那一行是 `.torrent_wrap` 的兄弟节点、不在其内部，
       * 因此 `.video_size` 等既有选择器不受影响。
       *
       * 100% 映射为 seeding 而非 completed：本项目里 completed 源自 NexusPHP 的
       * `inactivity` + 100%，含义是「已完成但当前未在做种」。实测该站点仅在活跃做种时
       * 渲染 progress[data-label]（下载完成但未做种的种子不显示），故 100% 对应 seeding，
       * 才与其它站点对同一种子的显示一致。
       */
      progress: {
        selector: "progress[data-label]",
        attr: "data-label",
        filters: [(query: string) => parseFloat(/([\d.]+)\s*%/.exec(query)?.[1] ?? "NaN")],
      },
      status: {
        selector: "progress[data-label]",
        attr: "data-label",
        filters: [
          (query: string) => {
            const percent = parseFloat(/([\d.]+)\s*%/.exec(query)?.[1] ?? "NaN");
            if (isNaN(percent)) {
              return ETorrentStatus.unknown;
            }
            return percent >= 100 ? ETorrentStatus.seeding : ETorrentStatus.downloading;
          },
        ],
      },

      tags: [
        ...SchemaMetadata.search.selectors!.tags!,
        { name: "官方", selector: "label:contains('官方')", color: "#ff0000" },
        { name: "中字", selector: "label:contains('中字')", color: "#0000ff" },
        { name: "外语", selector: "label:contains('外语')", color: "#004040" },
        { name: "禁转", selector: "label:contains('禁转')", color: "#800040" },
        { name: "DIY", selector: "label:contains('DIY')", color: "#0080ff" },
        { name: "国语", selector: "label:contains('国语')", color: "#8000ff" },
        { name: "原盘", selector: "label:contains('原盘')", color: "#0080c0" },
        { name: "粤语", selector: "label:contains('粤语')", color: "#00ff00" },
        { name: "HDR", selector: "label:contains('HDR')", color: "#d4ff00" },
        { name: "杜比视界", selector: "label:contains('杜比视界')", color: "#e20ae6" },
      ],
    },
  },

  userInfo: {
    ...userInfoWithInvitesInUserDetailsPage,
    selectors: {
      ...userInfoWithInvitesInUserDetailsPage.selectors,
      levelId: {
        selector: ["td.rowhead:contains('等级') + td > img"],
        attr: "src",
        filters: [
          (query: string) => {
            const match = query.match(/\/class\/(\d+)\.gif/);
            return match ? parseInt(match[1]) - 1 : 0;
          },
        ],
      },
      levelName: {
        selector: ["td.rowhead:contains('等级') + td > img"],
        attr: "title",
        filters: [
          (query: string) => {
            if (query && query.includes(")")) {
              return query.split(")")[1].trim();
            }
            return query || "";
          },
        ],
      },
      seedingBonus: {
        selector: ["td.rowhead:contains('等级积分') + td"],
        filters: [
          (query: string) => {
            query = query.replace(/[,\s]/g, "");
            return parseFloat(query.split("[")[0]);
          },
        ],
      },
    },
  },

  levelRequirements: [
    {
      id: 0,
      name: "User",
      privilege: "新用户的默认级别，仅能下载免费种子，可以直接发布种子",
    },
    {
      id: 1,
      name: "Power User",
      interval: "P2W",
      downloaded: "50GB",
      ratio: 1.0,
      seedingBonus: 100,
      privilege: "允许购买邀请码，可以直接发布种子，可以删除自己上传的字幕。",
    },
    {
      id: 2,
      name: "Elite User",
      interval: "P4W",
      downloaded: "50GB",
      ratio: 1.0,
      seedingBonus: 200,
      privilege: "Elite User允许发送邀请码，并拥有低于该等级以下权限。",
    },
    {
      id: 3,
      name: "Crazy User",
      interval: "P8W",
      downloaded: "50GB",
      ratio: 1.0,
      seedingBonus: 500,
      privilege: "查看种子结构，并拥有低于该等级以下权限。",
    },
    {
      id: 4,
      name: "Insane User",
      interval: "P16W",
      downloaded: "50GB",
      ratio: 1.0,
      seedingBonus: 1000,
      privilege: "发布趣味盒，并拥有低于该等级以下权限。",
    },
    {
      id: 5,
      name: "Veteran User",
      interval: "P28W",
      downloaded: "50GB",
      ratio: 1.0,
      seedingBonus: 2000,
      isKept: true,
      privilege: "Veteran User永远保留账号，并拥有低于该等级以下权限。",
    },
    {
      id: 6,
      name: "Extreme User",
      interval: "P32W",
      downloaded: "50GB",
      ratio: 1.0,
      seedingBonus: 5000,
      isKept: true,
      privilege: "查看日志权限，并拥有低于该等级以下权限。",
    },
    {
      id: 7,
      name: "Ultimate User",
      interval: "P40W",
      downloaded: "50GB",
      ratio: 1.0,
      seedingBonus: 8000,
      isKept: true,
      privilege: "查看排行榜，并拥有低于该等级以下权限",
    },
    {
      id: 8,
      name: "Nexus Master",
      interval: "P52W",
      downloaded: "50GB",
      ratio: 1.0,
      seedingBonus: 10000,
      isKept: true,
      privilege: "允许匿名，拥有发布主题推荐权限，并拥有低于该等级以下权限",
    },
    // VIP以上等级通过系统智能识别机制自动处理，不在此处配置详细权限信息
  ],
};
