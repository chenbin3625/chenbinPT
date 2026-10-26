/**
 * @JackettDefinitions https://github.com/Jackett/Jackett/blob/master/src/Jackett.Common/Definitions/onlyencodes-api.yml
 */
import type { ISiteMetadata } from "../types";
import { CategoryFree, SchemaMetadata } from "../schemas/Unit3D.ts";
import { buildCategoryOptionsFromDict } from "../utils.ts";

const categoryMap: Record<number, string> = {
  1: "Movie",
  2: "TV Show",
};

export const siteMetadata: ISiteMetadata = {
  ...SchemaMetadata,
  version: 1,
  id: "onlyencodes",
  name: "OnlyEncodes+",
  aka: ["OE"],
  description: "Encodes Live Here, Now with More!",
  tags: ["影视"],

  type: "private",
  schema: "Unit3D",

  urls: ["uggcf://baylrapbqrf.pp/"],

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
        { name: "x265 Encode", value: 10 },
        { name: "x264 Encode", value: 15 },
        { name: "AV1 Encode", value: 14 },
        { name: "Full Disks", value: 19 },
        { name: "Remux", value: 20 },
        { name: "WEB-DL", value: 21 },
        { name: "Other/Unknown", value: 16 },
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
      ...SchemaMetadata.search.selectors,
      category: {
        selector: ":self",
        data: "categoryId",
        // L5：categoryMap 未命中时不要留下 undefined（分类列变空且无告警），回落到原始 id。
        filters: [(query: number | string) => categoryMap[Number(query)] ?? (query === "" ? undefined : query)],
      },
      tags: [
        ...SchemaMetadata.search.selectors!.tags!,
        // DEFS2-2：原先这里的 H&R 用 selector:"*"（对任意行恒真），会把整站搜索结果全部标成 H&R；
        // 列表页没有 H&R 徽标，故删除该标签、只保留引擎共享 tags。
      ],
    },
  },

  // L6：本表是「上传量阶梯」与「做种量阶梯」交替的两条路径（与 darkpeers 的
  // PowerUser/Seeder、SuperUser/Collector 同型）：id 6/8/9/11 等特殊等级以 seedingSize(+averageSeedingTime)
  // 为主、uploaded 只是入门门槛，因此 uploaded 在 id 5→6、10→11 处回落并非笔误；
  // getNextLevelUnMet 只会列出未满足的键（这些等级列出的是 seedingSize，而不是「再传 1TiB」）。
  // 未核对站点规则页前不要把它改成单调递增的上传阶梯。
  levelRequirements: [
    {
      id: 0,
      name: "Leech",
      privilege: "无限下载槽 上传种子",
    },
    {
      id: 1,
      name: "User",
      ratio: 0.4,
      privilege: "无限下载槽 上传种子",
    },
    {
      id: 2,
      name: "Explorer",
      interval: "P1M",
      ratio: 0.4,
      uploaded: "1TiB",
      privilege: "无限下载槽 上传种子",
    },
    {
      id: 3,
      name: "Trailblazer",
      interval: "P2M",
      ratio: 0.4,
      uploaded: "5TiB",
      seedingSize: "100GiB",
      privilege: "无限下载槽 上传种子 发送邀请",
    },
    {
      id: 4,
      name: "Adventurer",
      interval: "P3M",
      ratio: 0.4,
      uploaded: "20TiB",
      seedingSize: "100GiB",
      privilege: "无限下载槽 上传种子 发送邀请",
    },
    {
      id: 5,
      name: "Legendary",
      interval: "P6M",
      ratio: 0.4,
      uploaded: "50TiB",
      seedingSize: "100GiB",
      privilege: "无限下载槽 上传种子 发送邀请",
    },
    {
      id: 6,
      name: "Eternal",
      interval: "P1M",
      ratio: 0.4,
      uploaded: "1TiB",
      seedingSize: "5TiB",
      averageSeedingTime: "P1M",
      privilege: "无限下载槽 上传种子 发送邀请 免疫HR",
    },
    {
      id: 7,
      name: "Ascendan",
      interval: "P1Y",
      ratio: 0.4,
      uploaded: "100TiB",
      seedingSize: "100GiB",
      privilege: "无限下载槽 上传种子 发送邀请 免疫HR 站免",
    },
    {
      id: 8,
      name: "Video Virtuoso",
      interval: "P3M",
      ratio: 0.4,
      uploaded: "1TiB",
      seedingSize: "10TiB",
      averageSeedingTime: "P2M",
      privilege: "无限下载槽 上传种子 发送邀请 免疫HR 站免",
    },
    {
      id: 9,
      name: "Encode Lover",
      interval: "P6M",
      ratio: 0.4,
      uploaded: "1TiB",
      seedingSize: "20TiB",
      averageSeedingTime: "P3M",
      privilege: "无限下载槽 上传种子 发送邀请 免疫HR 站免 2x上传",
    },
    {
      id: 10,
      name: "BeachBum",
      interval: "P2M",
      ratio: 1,
      uploaded: "100TiB",
      seedingSize: "20TiB",
      averageSeedingTime: "P6D",
      privilege: "无限下载槽 上传种子 发送邀请 免疫HR 站免 2x上传",
    },
    {
      id: 11,
      name: "OnlyKings",
      interval: "P3M",
      ratio: 1,
      uploaded: "1TiB",
      seedingSize: "10TiB",
      averageSeedingTime: "P2M",
      uploads: 35,
      privilege: "无限下载槽 上传种子 发送邀请 免疫HR 站免 2x上传",
    },
    {
      id: 12,
      name: "OnlyCoinSpender",
      interval: "P1Y",
      ratio: 1,
      uploaded: "908.59TiB",
      seedingSize: "5TiB",
      averageSeedingTime: "P2DT7H33M20S",
      privilege: "无限下载槽 上传种子 发送邀请 免疫HR 站免 2x上传",
    },
  ],
};
