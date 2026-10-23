/**
 * @PTPPDefinitions https://github.com/chenbin3625/PT-Plugin-Plus/blob/dev/resource/sites/dajiao.cyou/config.json
 * @PDSDefinitions https://github.com/mantou568/pre-dessert-sites/blob/main/site_config/sites/dajiao.json
 */
import type { ISiteMetadata } from "../types";

export const siteMetadata: ISiteMetadata = {
  version: 1,
  id: "dajiao",
  name: "DAJIAO",
  aka: ["打胶"],
  description: "打胶",
  tags: ["综合", "纪录片"],

  type: "private",
  schema: "NexusPHP",

  urls: ["https://dajiao.cyou/"],

  isDead: true,

  // E2b-04：死站不再保留生效的 officialGroupPattern（types/site.ts 建议死站只留 urls/描述）
  // officialGroupPattern: [/DJWEB|DJTV/i],
};
