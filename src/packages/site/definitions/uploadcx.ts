/**
 * @JackettDefinitions https://github.com/Jackett/Jackett/blob/master/src/Jackett.Common/Definitions/uploadcx.yml
 */
import { type ISiteMetadata } from "../types";
import { CategoryFree, SchemaMetadata } from "../schemas/Unit3D.ts";
import { buildCategoryOptionsFromDict } from "../utils.ts";

const categoryMap: Record<number, string> = {
  1: "Movies",
  2: "TV",
};

export const siteMetadata: ISiteMetadata = {
  ...SchemaMetadata,
  version: 1,
  id: "uploadcx",
  name: "ULCX",
  description: "upload.cx",
  tags: ["影视"],

  type: "private",
  schema: "Unit3D",

  urls: ["uggcf://hcybnq.pk/"],

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
        { name: "Remux", value: 2 },
        { name: "Encode", value: 3 },
        { name: "WEB-DL", value: 4 },
        { name: "WEBRip", value: 5 },
        { name: "HDTV", value: 6 },
      ],
      cross: { mode: "brackets" },
    },
    {
      name: "分辨率",
      key: "resolutionIds",
      options: [
        { name: "4320p", value: 1 },
        { name: "2160p", value: 2 },
        { name: "1080p", value: 3 },
        { name: "1080i", value: 4 },
        { name: "720p", value: 5 },
        { name: "576p", value: 6 },
        { name: "576i", value: 7 },
        { name: "480p", value: 8 },
        { name: "480i", value: 9 },
        { name: "Other", value: 10 },
      ],
      cross: { mode: "brackets" },
    },
    CategoryFree,
  ],

  search: {
    ...SchemaMetadata.search,
    skipNonLatinCharacters: true,
    selectors: {
      ...SchemaMetadata.search!.selectors,
      category: {
        selector: ":self",
        data: "categoryId",
        filters: [(query: string) => categoryMap[Number(query)]],
      },
      // DEFS3-5：这里原本追加了 `{ name: "H&R", selector: "*" }`。`*` 对每一行恒为真，
      // 会让每条结果都被打上红色 H&R（「排除 H&R」筛选会把整站结果滤掉），而 Unit3D 的搜索结果
      // 列表页并不渲染 H&R 状态（H&R 是「用户 × 种子」的历史状态，没有可用的真实选择器）。
      // 故直接沿用 Unit3D 引擎的 tags，不再伪造全站 H&R 标签。
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
      ratio: 0.6,
      privilege: "10下载槽 发送邀请",
    },
    {
      id: 2,
      name: "Member",
      interval: "P2W",
      ratio: 0.6,
      uploaded: "1TiB",
      privilege: "15下载槽 发送邀请",
    },
    {
      id: 3,
      name: "Power User",
      interval: "P1M",
      ratio: 1,
      uploaded: "3TiB",
      privilege: "20下载槽 发送邀请",
    },
    {
      id: 4,
      name: "Elite",
      interval: "P1M",
      ratio: 1.05,
      uploaded: "10TiB",
      privilege: "25下载槽 发送邀请 自动通过候选",
    },
    {
      id: 5,
      name: "Seeder",
      interval: "P2M",
      ratio: 1,
      seedingSize: "5TiB",
      averageSeedingTime: "P1M",
      privilege: "25下载槽 发送邀请 免疫HR 自动通过候选",
    },
    {
      id: 6,
      name: "Archivist",
      interval: "P3M",
      ratio: 1,
      seedingSize: "10TiB",
      averageSeedingTime: "P1M",
      privilege: "无限下载槽 发送邀请 站免 免疫HR 自动通过候选",
    },
    {
      id: 7,
      name: "Master",
      interval: "P4M",
      ratio: 1.1,
      uploaded: "50TiB",
      seedingSize: "20TiB",
      averageSeedingTime: "P3M",
      privilege: "无限下载槽 发送邀请 站免 免疫HR 自动通过候选",
    },
    {
      id: 8,
      name: "Veteran",
      interval: "P5M",
      ratio: 1.1,
      uploaded: "100TiB",
      seedingSize: "30TiB",
      averageSeedingTime: "P4M",
      privilege: "无限下载槽 发送邀请 站免 免疫HR 自动通过候选",
    },
  ],
};
