/**
 * @PTPPDefinitions https://github.com/chenbin3625/PT-Plugin-Plus/blob/dev/resource/sites/pt.xauat6.edu.cn/config.json
 */
import { type ISiteMetadata } from "../types";

export const siteMetadata: ISiteMetadata = {
  // ...SchemaMetadata,
  version: 1,
  id: "xauat6",
  name: "溪涧草堂PT",
  description: "以热播电影，热播剧集，热播综艺为主，纪录，动漫，GTV，资料等资源为辅，多方面地为用户提供丰富的资源下载",
  tags: ["教育网", "影视", "综合"],
  collaborator: ["Rhilip"],
  timezoneOffset: "+0800",

  type: "private",
  schema: "NexusPHP",

  urls: ["http://pt.xauat6.edu.cn/"],

  isDead: true,

  // L-43：死站按 types/site.ts 的约定不再保留等级/分类配置（原 13 项分类字典已删除）。
};
