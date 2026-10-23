/**
 * @PTPPDefinitions https://github.com/chenbin3625/PT-Plugin-Plus/blob/dev/resource/sites/cnlang.org/config.json
 */
import { type ISiteMetadata } from "../types";

export const siteMetadata: ISiteMetadata = {
  version: 1,
  id: "cnlang",
  name: "国语视界",
  description: "国语视界音轨组，特效字幕组官方首发论坛，国语音轨和特效字幕的分享基地，蓝光DIY和4K电影爱好者的乐园。",
  tags: ["特效字幕", "国语音轨"],
  collaborator: ["fzlins"],

  type: "private",
  // E2b-03：`schemas/` 里没有 Discuz 引擎，index.ts 会按 type 静默回落 AbstractPrivateSite。
  // 死站只保留 urls/描述，不再声明不存在的 schema 名（复活后需按真实引擎重写）。

  urls: ["https://cnlang.org/"],

  // refs: https://github.com/chenbin3625/PT-Plugin-Plus/commit/1aa73d0f9b0afb4511c1be7810d7dafc4268cd4d
  isDead: true,
};
