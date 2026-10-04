import { defineExtensionStorage } from "@webext-core/storage";

import {
  IConfigPiniaStorageSchema,
  IMetadataPiniaStorageSchema,
  TUserInfoStorageSchema,
  TSearchResultSnapshotStorageSchema,
  TKeepUploadTaskStorageSchema,
} from "@/shared/types.ts";

export interface IExtensionStorageSchema {
  // 既可以被 pinia 使用，也可以被其他地方使用
  config: IConfigPiniaStorageSchema;

  metadata: IMetadataPiniaStorageSchema;

  userInfo: TUserInfoStorageSchema; // 用于存储用户信息
  searchResultSnapshot: TSearchResultSnapshotStorageSchema; // 用于存储搜索结果快照
  keepUploadTask: TKeepUploadTaskStorageSchema; // 用于存储辅种任务

  /**
   * 站点 host/name 索引（metadata.siteHostMap / siteNameMap 的独立副本）。
   *
   * 见 docs/performance-audit.md P2-17：content script 引导与右键菜单只需要这两个小表，
   * 但 metadata 可能数百 KB ~ MB 级、且会被用户信息刷新等高频写入反复失效，
   * 因此把索引单独存一份小 key，读取时不必反序列化整份 metadata。
   * 读取方在 key 缺失时回落读取 metadata（兼容旧数据/未重建过的用户）。
   */
  siteIndex: {
    siteHostMap: Record<string, string>;
    siteNameMap: Record<string, string>;
  };
}

export type TExtensionStorageKey = keyof IExtensionStorageSchema;

/**
 * 注意 extStore 不能在 offscreen 中使用，如果在 offscreen 中有需要，请使用 sw 提供的 sendMessage('getExtStorage' | 'setExtStorage')
 */
export const extStorage = defineExtensionStorage<IExtensionStorageSchema>(chrome.storage.local);
