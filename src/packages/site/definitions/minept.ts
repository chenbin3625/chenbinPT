import type { ISiteMetadata } from "../types";

export const siteMetadata: ISiteMetadata = {
  version: 1,
  id: "minept",
  name: "MINE.pt",
  aka: ["MINE", "地雷站", "矿站"],
  description: "国内首个使用meanTorrent架构站点",
  tags: ["影视", "综合"],

  type: "private",
  // I5：原为 `schema: "meanTorrent"`，但 schemas/ 下没有该实现（只有 Abstruct*/Unit3D/Gazelle/…），
  // 站点已 dead 且本文件没有 `...SchemaMetadata`，该 schema 名只会让静态校验报「回落 AbstractPrivateSite」。
  // 这里不再声明 schema，按 type 直接回落到 AbstractPrivateSite；若站点复活需按 meanTorrent 结构重写。

  urls: ["https://mine.pt/"],

  // refs: https://github.com/chenbin3625/PT-Plugin-Plus/commit/ef7a885c052a9dc23286fb54e33dbef3dd9431ed
  isDead: true,
};
