/**
 * @JackettDefinitions https://github.com/Jackett/Jackett/blob/master/src/Jackett.Common/Indexers/Definitions/DesiGaane.cs
 */
import { type ISiteMetadata } from "../types";
import { SchemaMetadata } from "../schemas/GazelleJSONAPI.ts";

export const siteMetadata: ISiteMetadata = {
  ...SchemaMetadata,

  version: 1,
  id: "desigaane",
  name: "DesiGaane",
  aka: ["DG"],
  description: "DesiGaane is a private tracker focused on Indian music",
  tags: ["音楽", "印度音乐"],
  timezoneOffset: "+0000",
  collaborator: [], // 若你知道协作者 ID，请填入

  type: "private",
  schema: "GazelleJSONAPI",

  urls: ["https://desigaane.rocks/"],

  search: {
    ...SchemaMetadata.search!,
    advanceKeywordParams: {
      imdb: false,
    },
  },

  levelRequirements: [
    {
      id: 1,
      name: "User",
      privilege: "None",
    },
    {
      id: 2,
      name: "Member",
      interval: "P1W",
      uploaded: "10GB",
      ratio: 0.6,
      privilege: "Invites",
    },
    {
      id: 3,
      name: "Power User",
      interval: "P2W",
      uploads: 5,
      uploaded: "25GB",
      ratio: 0.65,
      privilege: "",
    },
    {
      id: 4,
      name: "Elite",
      interval: "P4W",
      uploads: 50,
      uploaded: "100GB",
      ratio: 0.65,
      privilege: "",
    },
    {
      id: 5,
      // D-14：5/6/7 级原先是三份逐字相同的模板占位（uploads 500 / 500GB / 0.65 / P8W，还带着「例如 10」注释），
      // 会被当成真实门槛参与判级。站点的真实要求无公开来源，这里只保留等级名（用 levelName 精确匹配），不再编造门槛。
      name: "Torrent Master",
      privilege: "",
    },
    {
      id: 6,
      name: "Power TM",
      privilege: "",
    },
    {
      id: 7,
      name: "Elite TM",
      privilege: "",
    },
  ],
};
