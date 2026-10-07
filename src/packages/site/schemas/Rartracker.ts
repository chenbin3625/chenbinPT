/**
 * Rartracker 架构基类
 * 适用于基于 rartracker (https://github.com/swetorrentking/rartracker) 的站点
 * 站点使用 AngularJS SPA，数据通过 JSON API（/api/v1/）获取
 */
import type { AxiosRequestConfig } from "axios";
import type { ISiteMetadata, ITorrent } from "../types";
import PrivateSite from "./AbstractPrivateSite";
import { GB } from "../utils";

export const statusRequestConfig: AxiosRequestConfig = {
  url: "/api/v1/status",
  responseType: "json",
};

export const SchemaMetadata: Partial<ISiteMetadata> = {
  version: 0,
  schema: "Rartracker",
  type: "private",

  search: {
    keywordPath: "params.searchText",
    requestConfig: {
      url: "/api/v1/torrents",
      responseType: "json",
      params: {
        limit: 100,
        index: 0,
        section: "all",
        extendedSearch: false,
        watchview: false,
      },
    },
    advanceKeywordParams: {
      imdb: { enabled: true },
    },
    selectors: {
      rows: { selector: ":self" },
      id: { selector: "id" },
      title: { selector: "name" },
      url: { selector: "id", filters: [(id: number) => `/torrent/${id}/`] },
      time: { selector: "added" },
      size: { selector: "size" },
      seeders: { selector: "seeders" },
      leechers: { selector: "leechers" },
      comments: { selector: "comments" },
      category: { selector: "category" },
    },
  },

  userInfo: {
    pickLast: ["id", "joinTime"],
    process: [
      {
        // 第一步：从 /api/v1/status 获取当前用户基本信息
        requestConfig: statusRequestConfig,
        selectors: {
          id: { selector: "user.id" },
          name: { selector: "user.username" },
          uploaded: { selector: "user.uploaded" },
          downloaded: { selector: "user.downloaded" },
          messageCount: { selector: "user.newMessages" },
          bonus: { selector: "user.bonuspoang" },
          seedingSize: {
            selector: "user.currentGbSeed",
            filters: [(query: number) => query * GB],
          },
        },
      },
      {
        // 第二步：从 /api/v1/users/{id} 获取详细信息
        requestConfig: {
          url: "/api/v1/users/$id$",
          responseType: "json",
        },
        assertion: { id: "url" },
        selectors: {
          joinTime: { selector: "added", filters: [{ name: "parseTime" }] },
          lastAccessAt: { selector: "last_access", filters: [{ name: "parseTime" }] },
          uploaded: { selector: "uploaded" },
          downloaded: { selector: "downloaded" },
          trueDownloaded: { selector: "downloaded_real" },
          bonus: { selector: "bonuspoang" },
        },
      },
    ],
  },
};

export default class Rartracker extends PrivateSite {
  // passkey 通过 runtimeSettings 持久化（带过期时间），避免每次搜索重建实例后都重新请求 /api/v1/status
  private static readonly passKeyCacheKey = "passKey";
  private static readonly passKeyCacheTtl = 12 * 60 * 60; // 12 小时

  // SITECORE-5：实例级记忆（含空 passkey）。空 passkey 刻意不写 12h 持久缓存（见 loadPassKey），
  // 但若连实例内也不记，一页 N 条搜索结果就会各发一次 /api/v1/status（外加一次 getExtStoragePath IPC），
  // 有被 WAF 判刷站的风险。与 GazelleJSONAPI.getAuthKey 的 L-3 修复同构；请求失败不记忆，下次重试。
  private _passKeyPromise?: Promise<string>;

  // 从 /api/v1/status 获取 passkey，用于构建种子下载链接
  private async getPassKey(): Promise<string> {
    this._passKeyPromise ??= this.loadPassKey().catch((error) => {
      this._passKeyPromise = undefined; // 请求失败不记忆，下次重试
      throw error;
    });
    return this._passKeyPromise;
  }

  private async loadPassKey(): Promise<string> {
    const currentTime = Math.floor(Date.now() / 1000);

    const cachedPassKey = await this.retrieveRuntimeSettings<{ passkey?: string; expiry?: number }>(
      Rartracker.passKeyCacheKey,
    );

    if (
      typeof cachedPassKey?.passkey === "string" &&
      cachedPassKey.passkey.trim().length > 0 &&
      typeof cachedPassKey?.expiry === "number" &&
      Number.isFinite(cachedPassKey.expiry) &&
      cachedPassKey.expiry > currentTime
    ) {
      return cachedPassKey.passkey.trim();
    }

    const { data: statResp } = await this.request<{ user: { passkey: string } }>(statusRequestConfig);
    const passKey = (statResp.user.passkey ?? "").trim();

    // 空 passkey 不写入持久化缓存：否则后续 12 小时内的下载链接都会复用空凭据；
    // 读取侧本来就有非空校验，因此跳过写缓存即可。实例级记忆由 getPassKey 负责。
    if (passKey.length > 0) {
      await this.storeRuntimeSettings(Rartracker.passKeyCacheKey, {
        passkey: passKey,
        expiry: currentTime + Rartracker.passKeyCacheTtl,
      });
    }

    return passKey;
  }

  protected async parseTorrentRowForLink(torrent: Partial<ITorrent>): Promise<Partial<ITorrent>> {
    const passkey = await this.getPassKey();
    torrent.link = `/api/v1/torrents/download/${torrent.id}/${passkey}`;
    return torrent;
  }
}
