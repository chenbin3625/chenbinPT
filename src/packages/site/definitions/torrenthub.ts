/**
 * @PDSDefinitions https://github.com/mantou568/pre-dessert-sites/blob/main/site_config/sites/torrenthub.json
 */
import type { ISiteMetadata } from "../types";
// import { SchemaMetadata } from "../schemas/NexusPHP";

export const siteMetadata: ISiteMetadata = {
  // ...SchemaMetadata,
  version: 1,

  id: "torrenthub",
  name: "TorrentHub",
  description: "分享每个人的力量",
  tags: ["影视", "教育", "音乐"],
  timezoneOffset: "+0800",

  type: "private",
  schema: "NexusPHP",

  urls: ["https://torrenthub.club/"],

  // Domain Catched
  isDead: true,

  // L-43：死站按 types/site.ts 的约定不再保留等级/分类配置（插件对死亡站点停止一切交互，
  // 过期规则只会在站点复活/改版后成为错误信息源）。站点标识与 urls 保留，便于复活时重建。
};
