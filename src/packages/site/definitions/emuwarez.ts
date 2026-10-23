/**
 * @JackettDefinitions https://github.com/Jackett/Jackett/blob/master/src/Jackett.Common/Definitions/emuwarez.yml
 * @PDSDefinitions https://github.com/mantou568/pre-dessert-sites/blob/main/site_config/sites/e_muwarez.json
 */
import { type ISiteMetadata } from "../types";
import { CategoryFree, SchemaMetadata } from "../schemas/Unit3D.ts";

export const siteMetadata: ISiteMetadata = {
  ...SchemaMetadata,

  version: 1,
  id: "emuwarez",
  name: "eMuwarez",
  aka: ["eMz"],
  // E2b-24：描述原先声称走 Unit3D 官方 JSON API，但下面的 search 仍是 `/torrents/` + document 抓取
  // （requestConfig.url/responseType 未改），描述与实现漂移会误导排障方向，这里按实际实现描述。
  description: "eMuwarez（eMz）是一个西班牙私有站点，提供电影/剧集/音乐/游戏/软件资源。",
  tags: ["影视", "音乐", "游戏", "软件", "综合"],

  type: "private",
  schema: "Unit3D",

  urls: ["https://emuwarez.com/"],
  legacyUrls: ["https://emuwarez.it/"],

  category: [
    {
      name: "类别",
      key: "categoryIds",
      options: [
        { name: "Películas", value: 1 },
        { name: "Series", value: 2 },
        { name: "Documentales", value: 4 },
        { name: "Musica", value: 5 },
        { name: "Juegos", value: 6 },
        { name: "Software", value: 7 },
      ],
      cross: { mode: "brackets" },
    },
    CategoryFree,
  ],

  search: {
    ...SchemaMetadata.search,
    selectors: {
      ...SchemaMetadata.search!.selectors!,
      rows: {
        // 站点新版 Unit3D 列表使用 data-table 样式（参考 PDS e_muwarez.json）
        ...SchemaMetadata.search!.selectors!.rows,
        selector: "table.data-table > tbody > tr",
      },
    },
  },
};
