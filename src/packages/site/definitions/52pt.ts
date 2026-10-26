/**
 * @JackettDefinitions https://github.com/Jackett/Jackett/blob/master/src/Jackett.Common/Definitions/52pt.yml
 * @JackettIssue https://github.com/Jackett/Jackett/issues/6763
 * @PTPPDefinitions https://github.com/chenbin3625/PT-Plugin-Plus/blob/dev/resource/sites/52pt.site/config.json
 * @PDSDefinitions https://github.com/mantou568/pre-dessert-sites/blob/main/site_config/sites/52pt.json
 */
import type { ISiteMetadata, IUserInfo } from "../types";
import { CategoryInclbookmarked, CategoryIncldead, CategorySpstate, SchemaMetadata } from "../schemas/NexusPHP";
import NexusPHP from "../schemas/NexusPHP";

/**
 * E1-A4：原实现 `import { userInfoWithInvitesInUserDetailsPage } from "./kunlun"` 把 52pt 的整个 userInfo
 * 绑在一个已 isDead 的站点文件上：kunlun 被清理时 52pt 会在 import 阶段直接失败；且该对象是模块级共享
 * 可变对象，任何定义就地修改都会跨站生效。这里内联一份等价定义（同样基于 NexusPHP SchemaMetadata），
 * 使 52pt 不再依赖死站点文件。
 */
const userInfoWithInvites = {
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

export const siteMetadata: ISiteMetadata = {
  ...SchemaMetadata,

  version: 1,
  id: "52pt",
  name: "52PT",
  aka: ["我爱PT"],
  description: "低调地在这个PT校园快乐成长 快乐分享",
  tags: ["高清", "电影", "电视剧"],
  favicon: "./52pt.ico",

  collaborator: ["StarGazerQQD", "zhuweitung"],

  type: "private",
  schema: "NexusPHP",

  urls: ["uggcf://52cg.fvgr/"],

  category: [
    {
      name: "类型",
      key: "cat",
      options: [
        { name: "Movies/电影", value: 401 },
        { name: "Documentaries/纪录片", value: 404 },
        { name: "Animations/动漫(画)", value: 405 },
        { name: "TV Series/剧集", value: 402 },
        { name: "TV Shows/综艺", value: 403 },
        { name: "Music Videos/音乐MV(演唱会)", value: 406 },
      ],
      cross: { mode: "append" },
    },
    {
      name: "媒介",
      key: "medium",
      options: [
        { name: "Blu-ray DIY", value: 2 },
        { name: "Blu-ray Remux", value: 4 },
        { name: "Blu-ray原盘无中文", value: 11 },
        { name: "4K UHD无中文", value: 1 },
        { name: "2K原盘中字（国粤语）", value: 14 },
        { name: "4K原盘中字（国粤语）", value: 15 },
      ],
      cross: { mode: "append" },
    },
    {
      name: "编码",
      key: "codec",
      options: [
        { name: "H.264/AVC", value: 13 },
        { name: "H.265(HEVC)", value: 1 },
        { name: "MPEG-2", value: 4 },
        { name: "Other", value: 5 },
        { name: "X264", value: 11 },
        { name: "H.265", value: 14 },
      ],
      cross: { mode: "append" },
    },
    {
      name: "音频编码",
      key: "audiocodec",
      options: [
        { name: "DTS.HDMA", value: 4 },
        { name: "True.HD", value: 12 },
        { name: "TRUE.HD Atoms", value: 10 },
        { name: "DTS:X", value: 3 },
        { name: "AC3/DD", value: 6 },
        { name: "LPCM", value: 14 },
      ],
      cross: { mode: "append" },
    },
    {
      name: "分辨率",
      key: "standard",
      options: [
        { name: "2K/1080p", value: 1 },
        { name: "4K/2160P", value: 5 },
        { name: "1080i", value: 2 },
        { name: "1080P-3D", value: 4 },
        { name: "720p", value: 3 },
        { name: "others", value: 6 },
      ],
      cross: { mode: "append" },
    },
    {
      name: "制作组",
      key: "team",
      options: [
        { name: "52PT DIY/原盘小组", value: 6 },
        { name: "52PT REMUX/重编码小组", value: 7 },
        { name: "BeyondHD", value: 1 },
        { name: "HDSKY", value: 2 },
        { name: "TTG", value: 3 },
        { name: "MTeam", value: 8 },
      ],
      cross: { mode: "append" },
    },
    CategoryIncldead,
    CategorySpstate,
    CategoryInclbookmarked,
  ],

  levelRequirements: [
    {
      id: 0,
      name: "User",
      privilege: "新用户的默认级别",
    },
    {
      id: 1,
      name: "Power User",
      interval: "P4W",
      downloaded: "50GB",
      ratio: 1.05,
      privilege:
        '得到一个邀请名额；可以查看NFO文档；可以请求续种； 可以发送邀请；可以查看其它用户的种子历史(如果用户隐私等级未设置为"强")； 允许发布新的趣味盒内容及编辑自己发布的趣味盒内容;可以删除自己上传的字幕。',
    },
    {
      id: 2,
      name: "Elite User",
      interval: "P8W",
      downloaded: "120GB",
      ratio: 1.55,
      privilege: "Elite User及以上用户封存账号后不会被删除。",
    },
    {
      id: 3,
      name: "Crazy User",
      interval: "P15W",
      downloaded: "300GB",
      ratio: 2.05,
      privilege: "得到两个邀请名额；可以在做种/下载/发布的时候选择匿名模式。",
    },
    {
      id: 4,
      name: "Insane User",
      interval: "P25W",
      downloaded: "1536GB",
      ratio: 2.55,
      privilege: "可以查看普通日志。",
    },
    {
      id: 5,
      name: "Veteran User",
      interval: "P40W",
      downloaded: "2560GB",
      ratio: 3.05,
      isKept: true,
      privilege: "得到三个邀请名额；可以查看其它用户的评论、帖子历史。Veteran User及以上用户会永远保留账号。",
    },
    {
      id: 6,
      name: "Extreme User",
      interval: "P60W",
      downloaded: "3072GB",
      ratio: 3.55,
      isKept: true,
      privilege: "可以更新过期的外部信息；可以查看Extreme User论坛。",
    },
    {
      id: 7,
      name: "Ultimate User",
      interval: "P80W",
      downloaded: "4608GB",
      ratio: 4.05,
      isKept: true,
      privilege: "得到五个邀请名额。",
    },
    {
      id: 8,
      name: "Nexus Master",
      interval: "P100W",
      downloaded: "5632GB",
      ratio: 4.55,
      isKept: true,
      privilege: "得到十个邀请名额。",
    },
    // VIP/管理组等级
    // E1-A3：id 100-106 原先是「X等级，享受X权限」这类占位文案，不含真实权限信息，
    // 用户会把它们当站点规则读；真实权限以站点规则页为准，拿不到就省略 privilege（类型允许缺省）。
    {
      id: 100,
      name: "名誉校长",
      nameAka: ["名誉校长", "名誉校长(VIP)", "VIP", "贵宾"],
      groupType: "vip",
    },
    {
      id: 101,
      name: "离退休",
      nameAka: ["离退休", "离退休(Retiree)", "Retiree"],
      groupType: "manager",
    },
    {
      id: 102,
      name: "教员",
      nameAka: ["教员", "教员(Uploader)", "Uploader"],
      groupType: "manager",
    },
    {
      id: 103,
      name: "教授",
      nameAka: ["教授", "教授(Moderator)", "Moderator"],
      groupType: "manager",
    },
    {
      id: 104,
      name: "校长",
      nameAka: ["校长", "校长(Administrator)", "Administrator"],
      groupType: "manager",
    },
    {
      id: 105,
      name: "校区维护",
      nameAka: ["校区维护", "校区维护(Sysop)", "Sysop"],
      groupType: "manager",
    },
    {
      id: 106,
      name: "校区创始人",
      nameAka: ["校区创始人", "校区创始人(Staff Leader)", "Staff Leader"],
      groupType: "manager",
    },
  ],

  userInfo: userInfoWithInvites,
};

export default class Site52PT extends NexusPHP {
  // 重写等级匹配逻辑，使用严格匹配避免"校长"被"名誉校长"包含
  // E1-C11：读 this.metadata（构造函数里已与 userConfig.merge 合并）而不是模块常量 siteMetadata，
  // 否则用户自定义 levelRequirements 时「面板显示自定义等级表、判级仍用原始常量」。
  protected override guessUserLevelId(userInfo: Partial<IUserInfo>): number {
    if (!userInfo.levelName) return 0;

    const cleanedUserLevelName = userInfo.levelName.replace(/[\s _]+/g, "").toLowerCase();

    // 优先使用精确匹配，避免包含关系导致的错误匹配
    const exactLevel = this.metadata.levelRequirements?.find((level) => {
      const levelNames = [level.name, ...(level.nameAka ?? [])];
      return levelNames.some((name) => {
        const cleanedLevelName = name.replace(/[\s _]+/g, "").toLowerCase();
        // 使用精确匹配
        return cleanedLevelName === cleanedUserLevelName;
      });
    });

    if (exactLevel) {
      return exactLevel.id;
    }

    // 如果精确匹配失败，尝试包含匹配（但排除可能冲突的等级）
    const includeLevel = this.metadata.levelRequirements?.find((level) => {
      const levelNames = [level.name, ...(level.nameAka ?? [])];
      return levelNames.some((name) => {
        const cleanedLevelName = name.replace(/[\s _]+/g, "").toLowerCase();

        // 特殊处理：如果用户等级是"校长"，避免匹配到"名誉校长"
        if (cleanedUserLevelName === "校长" && cleanedLevelName.includes("名誉校长")) {
          return false;
        }

        // 特殊处理：如果用户等级是"名誉校长"，避免匹配到"校长"
        if (cleanedUserLevelName === "名誉校长" && cleanedLevelName === "校长") {
          return false;
        }

        return cleanedLevelName.includes(cleanedUserLevelName);
      });
    });

    if (includeLevel) {
      return includeLevel.id;
    }

    // 如果都失败，回退到父类的匹配逻辑
    return super.guessUserLevelId(userInfo as IUserInfo);
  }
}
