/**
 * @PTPPDefinitions https://github.com/chenbin3625/PT-Plugin-Plus/blob/dev/resource/sites/sugoimusic.me/config.json
 */
import { type ISiteMetadata } from "../types";
// import { SchemaMetadata } from "../schemas/GazelleJSONAPI.ts";

export const siteMetadata: ISiteMetadata = {
  // ...SchemaMetadata,

  version: 1,
  id: "sugoimusic",
  name: "SugoiMusic",
  aka: ["SM"],
  description:
    "SugoiMusic is a private tracker focused on Asian music: music, concerts, PVs, variety & drama shows, Blu-ray/DVDs, and pictures.",
  tags: ["音乐", "亚洲音乐"],
  timezoneOffset: "+0800",
  collaborator: ["MewX"],

  type: "private",
  schema: "GazelleJSONAPI",

  urls: ["https://sugoimusic.me/"],

  isDead: true,

  /*
  search: {
    ...SchemaMetadata.search!,
    advanceKeywordParams: {
      imdb: false,
    },
  },

   */

  // L-43：死站按 types/site.ts 的约定不再保留等级/分类配置（原先 15 级规则表已删除，
  // 避免站点复活/改版后继续把过期规则当作有效信息源）。
};
