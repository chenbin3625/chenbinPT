/**
 * @JackettDefinitions https://github.com/Jackett/Jackett/blob/master/src/Jackett.Common/Definitions/ptying.yml
 * @PDSDefinitions https://github.com/mantou568/pre-dessert-sites/blob/main/site_config/sites/yinghua.json
 */
import type { ISiteMetadata } from "../types";
import {
  CategoryInclbookmarked,
  CategoryIncldead,
  CategorySpstate,
  SchemaMetadata,
  xiaomloveDefaultUserLevelRequirements,
} from "../schemas/NexusPHP";

/**
 * L-38：原先从已死亡站点 `kunlun.ts` 导入 `userInfoWithInvitesInUserDetailsPage`。
 * 死亡站点的约定是「注释或删除之后的所有配置项」，一旦有人照做，本文件的 import 就会断裂；
 * 且形成「死站文件承载活站配置」的隐性耦合。这里把共享片段内联到活站文件（内容与 kunlun 导出一致），
 * 站点可独立维护。
 */
const userInfoWithInvitesInUserDetailsPage: ISiteMetadata["userInfo"] = {
  ...SchemaMetadata.userInfo!,
  selectors: {
    ...SchemaMetadata.userInfo!.selectors!,
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
            return isNaN(num) ? 0 : num;
          } catch {
            return 0;
          }
        },
      ],
    },
  },
  process: [
    ...SchemaMetadata.userInfo!.process!.map((item) => {
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
  id: "yinguskg",
  name: "樱花",
  aka: ["YingUSKG", "ying.us.kg", "Ying"],
  description: "YingUSKG PT站点",
  tags: ["综合", "影视"],
  favicon: "./_default_nexusphp.png", // 使用NP架构默认图标

  type: "private",
  schema: "NexusPHP",

  urls: ["https://pt.ying.us.kg/"],

  category: [
    {
      name: "分类",
      key: "cat",
      options: [
        // D-9：原先这一段整块错位（与 kunlun.ts 的注释块逐字相同），选「动漫」实发 cat404、选「体育」实发 cat406。
        // 按 Jackett ptying.yml 的 categorymappings 校正
        { name: "电影", value: 401 },
        { name: "电视剧", value: 402 },
        { name: "综艺", value: 403 },
        { name: "纪录片", value: 404 },
        { name: "动漫", value: 405 },
        { name: "MV", value: 406 },
        { name: "体育", value: 407 },
        { name: "音频", value: 408 },
        { name: "其他", value: 409 },
        { name: "短剧", value: 410 },
      ],
      cross: { mode: "append" },
    },
    {
      name: "视频类",
      key: "medium",
      options: [
        { name: "UHD Blu-ray", value: 11 },
        { name: "Blu-ray", value: 1 },
        { name: "Remux", value: 3 },
        { name: "WEB-DL", value: 10 },
        { name: "Encode", value: 6 },
        { name: "HDTV", value: 5 },
        { name: "MiniBD", value: 4 },
        { name: "HD DVD", value: 7 },
        { name: "DVD", value: 8 },
        { name: "Other", value: 12 },
      ],
      cross: { mode: "append" },
    },
    {
      name: "分辨率",
      key: "standard",
      options: [
        { name: "4320P/8K/FUHD", value: 7 },
        { name: "2160P/4K/UHD", value: 8 },
        { name: "1080p/1080i/FHD", value: 1 },
        { name: "720p/720i/HD", value: 6 },
        { name: "360p/360i/SD", value: 5 },
        { name: "Other", value: 9 },
      ],
      cross: { mode: "append" },
    },
    {
      name: "音频类",
      key: "audiocodec",
      options: [
        { name: "DTS-HD MA", value: 1 },
        { name: "TrueHD Atmos", value: 2 },
        { name: "DTS-HD", value: 3 },
        { name: "TrueHD", value: 4 },
        { name: "DTS", value: 5 },
        { name: "AC-3", value: 6 },
        { name: "AAC", value: 7 },
        { name: "FLAC", value: 8 },
        { name: "APE", value: 9 },
        { name: "Other", value: 10 },
      ],
      cross: { mode: "append" },
    },
    {
      name: "制作组",
      key: "team",
      options: [
        { name: "HDS", value: 1 },
        { name: "CHD", value: 2 },
        { name: "MySiLU", value: 3 },
        { name: "WiKi", value: 4 },
        { name: "CMCT", value: 5 },
        { name: "FRDS", value: 6 },
        { name: "Other", value: 7 },
      ],
      cross: { mode: "append" },
    },
    CategoryIncldead,
    CategorySpstate,
    CategoryInclbookmarked,
  ],

  search: {
    ...SchemaMetadata.search!,
    advanceKeywordParams: {
      imdb: false, // 暂不支持IMDB搜索
    },
  },

  userInfo: userInfoWithInvitesInUserDetailsPage,

  levelRequirements: [...xiaomloveDefaultUserLevelRequirements],
};
