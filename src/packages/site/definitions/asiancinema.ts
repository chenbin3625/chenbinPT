/**
 * @JackettDefinitions https://github.com/Jackett/Jackett/blob/master/src/Jackett.Common/Definitions/asiancinema.yml
 * @PTPPDefinitions https://github.com/chenbin3625/PT-Plugin-Plus/blob/dev/resource/sites/asiancinema.me/config.json
 */
import { SchemaMetadata, CategoryFree } from "../schemas/Unit3D.ts";
import { type ISiteMetadata } from "../types";
import { buildCategoryOptionsFromDict } from "../utils.ts";

const categoryMap: Record<number, string> = {
  1: "Movies",
  2: "TV",
  3: "Music",
};

export const siteMetadata: ISiteMetadata = {
  ...SchemaMetadata,
  version: 2,
  id: "asiancinema",
  name: "AsianCinema",
  aka: ["ACM"],
  description: "综合",
  tags: ["综合"],

  type: "private",
  schema: "Unit3D",

  urls: ["uggcf://rvtn.zbv/"],
  legacyUrls: ["uggcf://nfvnapvarzn.zr/"],

  category: [
    {
      name: "类别",
      key: "categoryIds",
      options: buildCategoryOptionsFromDict(categoryMap),
      cross: { mode: "brackets" },
    },
    {
      name: "规格",
      key: "typeIds",
      options: [
        { name: "Full Disc", value: 1 },
        { name: "Remux", value: 7 },
        { name: "WEB-DL", value: 9 },
        { name: "HDTV", value: 17 },
        { name: "UHDTV", value: 19 },
        { name: "SDTV", value: 13 },
        { name: "FLAC", value: 15 },
      ],
      cross: { mode: "brackets" },
    },
    {
      name: "分辨率",
      key: "resolutionIds",
      options: [
        { name: "2160p", value: 1 },
        { name: "1080i/p", value: 2 },
        { name: "720p", value: 3 },
        { name: "576i/p", value: 4 },
        { name: "480i/p", value: 5 },
        { name: "Other", value: 6 },
      ],
      cross: { mode: "brackets" },
    },
    CategoryFree,
  ],

  search: {
    ...SchemaMetadata.search,
    selectors: {
      ...SchemaMetadata.search!.selectors,
      category: {
        selector: ":self",
        data: "categoryId",
        filters: [(query: string) => categoryMap[Number(query)]],
      },
      tags: [
        ...SchemaMetadata.search!.selectors!.tags!,
        // DEFS2-2 复核（统一判据：站点是否全站 H&R）：本站属上游 fb79a2a7「feat: add default H&R tags with red
        // color for global sites」(PR #336) 明确列出的全站 H&R 站点——站点规则对**全部**下载都规定 H&R 义务，
        // 故用恒真 selector:"*" 表达「所有结果行都带 H&R」（与 torrenting.ts 同一约定）。
        // 第三波 hrs-sweep 把它当作恒真伪标签删除属过度改动，这里按上游设计恢复。
        { name: "H&R", selector: "*", color: "red" },
      ],
    },
  },

  levelRequirements: [
    {
      id: 0,
      name: "Leech",
    },
    {
      id: 1,
      name: "User",
      ratio: 0.4,
      privilege: "4 download slots",
    },
    {
      id: 2,
      name: "Power User",
      uploaded: "1TB",
      interval: "P1M",
      ratio: 0.4,
      uploads: 1,
      privilege: "10 download slots",
    },
    {
      id: 3,
      name: "Super User",
      uploaded: "5TB",
      interval: "P2M",
      ratio: 0.4,
      uploads: 5,
      privilege: "25 download slots",
    },
    {
      id: 4,
      name: "Extreme User",
      uploaded: "20TB",
      interval: "P3M",
      ratio: 0.4,
      uploads: 10,
      privilege: "50 download slots; Trusted member",
    },
    {
      id: 5,
      name: "Insane User",
      uploaded: "50TB",
      interval: "P6M",
      ratio: 0.4,
      uploads: 15,
      privilege: "50 download slots; Trusted member",
    },
    {
      id: 6,
      name: "Veteran",
      uploaded: "100TB",
      interval: "P1Y",
      ratio: 0.4,
      uploads: 20,
      privilege: "Special freeleech",
    },
    {
      id: 7,
      name: "Seeder",
      uploaded: "200TB",
      seedingSize: "20TB",
      interval: "P1M",
      averageSeedingTime: "P1M",
      ratio: 1.5,
      uploads: 5,
      privilege: "Trusted member",
    },
    {
      id: 8,
      name: "Archivist",
      uploaded: "400TB",
      seedingSize: "40TB",
      interval: "P3M",
      averageSeedingTime: "P2M",
      ratio: 1.5,
      uploads: 10,
      privilege: "Immunity from H&Rs & Special freeleech",
    },
  ],
};
