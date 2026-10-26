/**
 * @PDSDefinitions https://github.com/mantou568/pre-dessert-sites/blob/main/site_config/sites/darkland.json
 */
import { type ISiteMetadata } from "../types";
import { CategoryFree, SchemaMetadata } from "../schemas/Unit3D.ts";

export const siteMetadata: ISiteMetadata = {
  ...SchemaMetadata,

  version: 1,
  id: "darkland",
  name: "Darkland",
  tags: ["影视", "综合"],

  type: "private",
  schema: "Unit3D",

  urls: ["https://darkland.top/"],

  category: [
    {
      // E2-06：这些选项在请求里都写入同一个 `params.categoryIds`（cross.key），而构造器
      // （options/utils/searchSolutionConfig.ts 的 brackets 分支）对同一路径是整体 set，
      // 分成多个分组时「电影 + 剧集」同时勾选会被后一组覆盖，只按最后一组过滤。
      // 因此合并成一个分组（用名称前缀区分电影/剧集/动画/其它），多选才能一次写入数组。
      name: "分类",
      key: "categoryIds",
      options: [
        { name: "电影 · 戈尔 Gore", value: 1 },
        { name: "电影 · 动作 Action", value: 2 },
        { name: "电影 · 惊悚 Thriller", value: 4 },
        { name: "电影 · 文艺 Literary", value: 7 },
        { name: "电影 · 悬疑 Suspense", value: 8 },
        { name: "电影 · 犯罪 Crime", value: 13 },
        { name: "电影 · 剧情 Drama", value: 16 },
        { name: "电影 · 恐怖 Horror", value: 18 },
        { name: "电影 · 情色 Erotic", value: 21 },
        { name: "电影 · 科幻 Sci-Fi", value: 24 },
        { name: "剧集 · 剧集 TV", value: 30 },
        { name: "动画 · 动画 Animation", value: 12 },
        { name: "其它 · 纪录 Documentary", value: 15 },
        { name: "其它 · 短片 Short", value: 20 },
        { name: "其它 · 其它 Other", value: 29 },
      ],
      cross: { mode: "brackets" },
    },
    CategoryFree,
  ],

  search: {
    ...SchemaMetadata.search,
    selectors: {
      ...SchemaMetadata.search.selectors!,
      rows: {
        ...SchemaMetadata.search.selectors!.rows,
        selector: "table.data-table > tbody > tr[data-torrent-id]",
      },
    },
  },
};
