/**
 * @JackettDefinitions https://github.com/Jackett/Jackett/blob/master/src/Jackett.Common/Definitions/datascene-api.yml
 * @PDSDefinitions https://github.com/mantou568/pre-dessert-sites/blob/main/site_config/sites/datascene.json
 */
import { type ISiteMetadata } from "../types";
import { CategoryFree, SchemaMetadata } from "../schemas/Unit3D.ts";

export const siteMetadata: ISiteMetadata = {
  ...SchemaMetadata,

  version: 1,
  id: "datascene",
  name: "DataScene",
  aka: ["DS"],
  description:
    "DataScene（DS）是一个罗马尼亚私有站点，提供电影/剧集/综合资源。支持 Unit3D 官方 JSON API（api/torrents/filter）。",
  tags: ["影视", "综合"],
  timezoneOffset: "+0200", // EET，参考 Jackett datascene-api.yml 对 created_at 追加的 +02:00

  type: "private",
  schema: "Unit3D",

  urls: ["uggcf://qngnfprar.klm/"],
  legacyUrls: ["uggcf://qngnfprar.arg/"],

  category: [
    {
      // E2-06：这些选项在请求里都写入同一个 `params.categoryIds`（cross.key），而构造器
      // （options/utils/searchSolutionConfig.ts 的 brackets 分支）对同一路径是整体 set，
      // 分成多个分组时跨组多选会被后一组覆盖，只按最后一组过滤。
      // 因此合并成一个分组（用名称前缀区分电影/剧集/其它），多选才能一次写入数组。
      name: "分类",
      key: "categoryIds",
      options: [
        { name: "电影 · Movie HD", value: 1 },
        { name: "电影 · Movie HD Ro", value: 23 },
        { name: "电影 · Movie 4K", value: 11 },
        { name: "电影 · Movie 4K Ro", value: 12 },
        { name: "电影 · Movie Bluray", value: 14 },
        { name: "电影 · Movie Bluray Ro", value: 15 },
        { name: "电影 · Movie DVD", value: 27 },
        { name: "电影 · Movie DVD Ro", value: 28 },
        { name: "电影 · Movie SD", value: 19 },
        { name: "电影 · Movie SD Ro", value: 20 },
        { name: "剧集 · TV HD", value: 2 },
        { name: "剧集 · TV HD Ro", value: 18 },
        { name: "剧集 · TV SD", value: 26 },
        { name: "剧集 · TV SD Ro", value: 10 },
        { name: "剧集 · TV DVD", value: 31 },
        { name: "剧集 · TV DVD Ro", value: 32 },
        { name: "剧集 · TV 4K", value: 29 },
        { name: "剧集 · TV 4K Ro", value: 30 },
        { name: "剧集 · TV Pack", value: 22 },
        { name: "剧集 · TV Pack Ro", value: 33 },
        { name: "其它 · Game", value: 4 },
        { name: "其它 · Music", value: 3 },
        { name: "其它 · Music Video", value: 21 },
        { name: "其它 · Mobile", value: 7 },
        { name: "其它 · Linux", value: 24 },
        { name: "其它 · E-Book", value: 8 },
        { name: "其它 · Sport", value: 25 },
        { name: "其它 · Application", value: 5 },
        { name: "其它 · Anime", value: 13 },
        { name: "其它 · XXX", value: 6 },
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
        // 站点新版 Unit3D 列表使用 data-table 样式（参考 PDS datascene.json）
        // 保留 SchemaMetadata 默认的 filter（只保留含 /torrents/{id} 链接的行）
        ...SchemaMetadata.search!.selectors!.rows,
        selector: "table.data-table > tbody > tr",
      },
    },
  },
};
