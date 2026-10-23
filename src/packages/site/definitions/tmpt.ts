/**
 * @PDSDefinitions https://github.com/mantou568/pre-dessert-sites/blob/main/site_config/sites/tmpt.json
 */
import type { ISiteMetadata } from "../types";

export const siteMetadata: ISiteMetadata = {
  //...SchemaMetadata,

  version: 1,
  id: "tmpt",
  name: "唐门",
  description: "欢迎来到唐门",
  tags: ["综合", "影视"],
  collaborator: ["Exception"],

  type: "private",
  schema: "NexusPHP",

  urls: ["https://tmpt.top/"],

  // dead in 2026-03-23 ( from savept.icu
  isDead: true,

  // L-43：死站按 types/site.ts 的约定不再保留等级/分类配置（原先展开的通用 NPHP 示例等级表已删除）。
};
