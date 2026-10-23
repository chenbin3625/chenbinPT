/**
 * @PDSDefinitions https://github.com/mantou568/pre-dessert-sites/blob/main/site_config/sites/tosky.json
 */
import type { ISiteMetadata } from "../types";

export const siteMetadata: ISiteMetadata = {
  version: 1,
  id: "tosky",
  name: "ToSky",
  tags: ["综合"],

  type: "private",
  schema: "NexusPHP",

  urls: ["https://t.tosky.club/"],

  isDead: true,

  // L-43：死站按 types/site.ts 的约定不再保留等级/分类配置（插件对死亡站点停止一切交互，
  // 过期规则只会在站点复活/改版后成为错误信息源）。站点标识与 urls 保留，便于复活时重建。
};
