import type { AxiosResponse } from "axios";

import { GazelleBase } from "./Gazelle";
import { classifySiteError, extractContent, logMessage, parseTimeWithZone, siteErrorLogData } from "../utils";
import {
  EResultParseStatus,
  type IElementQuery,
  type IUserInfo,
  type ITorrent,
  type ISiteMetadata,
  type ISearchInput,
} from "../types";

/**
 * @refs: https://github.com/WhatCD/Gazelle/blob/63b337026d49b5cf63ce4be20fdabdc880112fa3/sections/ajax/index.php#L16
 */
type apiType =
  | "upload_section"
  | "preview"
  | "torrent_info"
  | "stats"
  | "checkprivate"
  | "torrent"
  | "torrentgroup"
  | "torrentgroupalbumart"
  | "tcomments"
  | "user"
  | "forum"
  | "top10"
  | "browse"
  | "usersearch"
  | "requests"
  | "artist"
  | "inbox"
  | "subscriptions"
  | "index"
  | "bookmarks"
  | "announcements"
  | "notifications"
  | "request"
  | "loadavg"
  | "better"
  | "password_validate"
  | "similar_artists"
  | "userhistory"
  | "votefavorite"
  | "wiki"
  | "send_recommendation"
  | "get_friends"
  | "news_ajax"
  | "community_stats"
  | "user_recents"
  | "collage"
  | "raw_bbcode"
  | "get_user_notifications"
  | "clear_user_notification"
  | "pushbullet_devices";

/**
 * @refs: https://github.com/WhatCD/Gazelle/blob/63b337026d49b5cf63ce4be20fdabdc880112fa3/classes/util.php#L167-L187
 */
export interface jsonResponse {
  status: "success" | "failure" | "error";
  response: any;
  error?: string;
}

/**
 * @refs: https://github.com/WhatCD/Gazelle/blob/63b337026d49b5cf63ce4be20fdabdc880112fa3/sections/ajax/info.php#L96-L115
 */
export interface infoJsonResponse extends jsonResponse {
  response: {
    username: string;
    id: number;
    authkey: string;
    passkey: string;
    notifications: {
      messages: number;
      notifications: number;
      newAnnouncement: boolean;
      newBlog: boolean;
      newSubscriptions: boolean;
    };
    userstats: {
      uploaded: number;
      downloaded: number;
      ratio: number;
      requiredratio: number;
      class: string;
    };
  };
}

/**
 * @refs: https://github.com/WhatCD/Gazelle/blob/63b337026d49b5cf63ce4be20fdabdc880112fa3/sections/ajax/browse.php
 */
export interface baseBrowseResult {
  groupId: number;
  groupName: string;
  tags: string[];
  groupTime: string;
}

export interface partTorrent {
  torrentId: number;
  fileCount: number;
  size: number;
  snatches: number;
  seeders: number;
  leechers: number;
  isFreeleech: boolean;
  isNeutralLeech: boolean;
  isPersonalFreeleech: boolean;
  canUseToken: boolean;
  hasSnatched: boolean;
}

export interface groupTorrent extends partTorrent {
  editionId: number;
  artists: { id: number; name: string; aliasid: number }[];
  remastered: boolean;
  remasterYear: number;
  remasterCatalogueNumber: string;
  remasterTitle: string;
  media: string;
  encoding: string;
  format: string;
  hasLog: boolean;
  logScore: number;
  hasCue: boolean;
  scene: boolean;
  vanityHouse: boolean;
  time: string;
}

export interface groupBrowseResult extends baseBrowseResult {
  artist: string;
  cover: string;
  bookmarked: boolean;
  vanityHouse: boolean;
  groupYear: number;
  releaseType: string | null;
  maxSize: number;
  totalSnatched: number;
  totalSeeders: number;
  totalLeechers: number;
  torrents: groupTorrent[];
}

export interface torrentBrowseResult extends baseBrowseResult, partTorrent {
  category: string;
}

/**
 * @refs: https://github.com/WhatCD/Gazelle/blob/63b337026d49b5cf63ce4be20fdabdc880112fa3/sections/ajax/browse.php
 */
export interface browseJsonResponse extends jsonResponse {
  response: {
    currentPage: number;
    pages: number;
    results: (groupBrowseResult | torrentBrowseResult)[];
  };
}

export interface userJsonResponse extends jsonResponse {
  response: {
    username: string;
    avatar: string;
    isFriend: boolean;
    profileText: string;
    stats: {
      joinedDate: string;
      lastAccess: string;
      uploaded: number;
      downloaded: number;
      ratio: string;
      requiredRatio: number;
      bonusPoints: number | null;
      bonusPointsPerHour: number | null;
      bonusSeedingPointsPerHour: number | null;
      seedingSize: number | null;
    };
    ranks: {
      uploaded: number;
      downloaded: number;
      uploads: number;
      requests: number;
      bounty: number;
      posts: number;
      artists: number;
      overall: number;
    };
    personal: {
      class: string;
      paranoia: number;
      paranoiaText: "Off" | "Very Low" | "Low" | "High" | "Very high";
      donor: boolean;
      warned: boolean;
      enabled: boolean;
      passkey: string;
    };
    community: {
      posts: number;
      torrentComments: number | null;
      artistComments: number | null;
      collageComments: number | null;
      requestComments: number | null;
      collagesStarted: number | null;
      collagesContrib: number | null;
      requestsFilled: number | null;
      bountyEarned: number | null;
      requestsVoted: number | null;
      bountySpent: number | null;
      perfectFlacs: number | null;
      uploaded: number | null;
      groups: number | null;
      seeding: number | null;
      leeching: number | null;
      snatched: number | null;
      invited: number | null;
      artistsAdded: number | null;
    };
  };
}

export const SchemaMetadata: Partial<ISiteMetadata> = {
  version: 0,
  search: {
    keywordPath: "params.searchstr",
    requestConfig: {
      url: "/ajax.php",
      responseType: "json",
      params: {
        action: "browse",
      },
    },
  },
  userInfo: {
    selectors: {
      // "/ajax.php?action=index"
      id: {
        selector: ["response.id"],
      },
      name: {
        selector: ["response.username"],
      },
      messageCount: {
        selector: ["response.notifications.messages"],
      },
      uploaded: {
        selector: ["response.userstats.uploaded"],
      },
      downloaded: {
        selector: ["response.userstats.downloaded"],
      },
      ratio: {
        selector: ["response.userstats.ratio"],
      },
      levelName: {
        selector: ["response.userstats.class"],
      },
      bonus: {
        selector: ["response.userstats.bonusPoints"],
      },
      bonusPerHour: {
        selector: ["response.userstats.bonusPointsPerHour", "response.userstats.seedingBonusPointsPerHour"],
      },
      seedingSize: {
        selector: ["response.userstats.seedingSize"], // GazellePW
      },

      // "/ajax.php?action=user&id=$user.id$"
      joinTime: {
        selector: ["response.stats.joinedDate"],
        filters: [{ name: "parseTime" }],
      },
      seeding: {
        selector: ["response.community.seeding"],
      },
      uploads: {
        selector: ["response.community.uploaded"],
      },
      perfectFlacs: {
        selector: ["response.community.perfectFlacs"],
      },
      groups: {
        selector: ["response.community.groups"],
      },
      invited: {
        selector: ["response.community.invited"],
      },
      lastAccessAt: {
        selector: ["response.stats.lastAccess"],
        filters: [{ name: "parseTime" }],
      },
    },
  },
};

export default class GazelleJSONAPI extends GazelleBase {
  // 凭据通过 runtimeSettings 持久化（带过期时间），避免每次搜索重建实例后都重新请求 /ajax.php?action=index
  private static readonly authKeyCacheKey = "authKey";
  private static readonly authKeyCacheTtl = 12 * 60 * 60; // 12 小时

  protected async requestApi<T extends jsonResponse>(
    action: apiType,
    params: { [key: string]: any },
  ): Promise<AxiosResponse<T>> {
    return await this.request<T>({
      url: "/ajax.php",
      params: { action, ...params },
    });
  }

  protected async requestApiInfo(): Promise<infoJsonResponse> {
    const { data: apiInfo } = await this.requestApi<infoJsonResponse>("index", {});
    return apiInfo;
  }

  /**
   * H-7：Gazelle 的 ajax.php 对账号停用 / ratio watch / 限流 / 无权限等情况返回 HTTP 200 +
   * `{ status: "failure", error: "..." }`。用户信息路径若不看 status，getFieldsData 会在空 response 上
   * 取到一堆默认值，于是 failure 被写成 success 并整份覆盖当日记录。
   * 与搜索路径（transformSearchPage 的 E-3 守卫）保持同一判据。
   */
  protected assertApiSuccess<T extends jsonResponse>(doc: T | undefined, action: string): T {
    if (doc?.status !== "success") {
      throw new Error(`Gazelle API ${action} error: ${doc?.error ?? doc?.status ?? "unknown"}`);
    }
    return doc;
  }

  /**
   * H-6 家族（GazelleJSONAPI）：与 AbstractPrivateSite / Unit3D 的零命中判据对齐。
   *
   * 本 schema 的 userInfo 选择器全是 `response.*` 形式的 JSON path，而 assertApiSuccess 只看 `status`，
   * 因此 `/ajax.php?action=index|user` 返回 HTTP 200 + `{status:"success"}`（没有 response 对象，
   * 服务端软错误 / 站点改版）时，getFieldsData 会把所有字段回落成 ""；若照常标 success，
   * 已解析的 uploaded/downloaded/ratio/bonus/seedingSize 会被一次刷新静默替换成空值/0，
   * 并写进当日历史与 metadata.lastUserInfo。
   *
   * 触发条件：本次请求涉及的 selector 字段数 > 0，且真正命中数为 0（成功响应里至少要有 response.id /
   * response.userstats.* 之类的真实值）。命中判定看原始值，因此「字段确实存在且值为 0」仍是命中。
   */
  protected assertUserInfoFieldsMatched(doc: object, fields: (keyof IUserInfo)[]): void {
    const selectors = (this.metadata.userInfo?.selectors ?? {}) as Record<string, IElementQuery | undefined>;

    let declaredSelectorFields = 0;
    let matchedSelectorFields = 0;
    for (const field of fields) {
      const elementQuery = selectors[field as string];
      if (!elementQuery) continue;

      declaredSelectorFields++;
      if (this.hasFieldMatch(doc, elementQuery)) {
        matchedSelectorFields++;
      }
    }

    if (declaredSelectorFields > 0 && matchedSelectorFields === 0) {
      // noinspection ExceptionCaughtLocallyJS
      throw new Error(
        `用户信息接口未命中任何字段（${declaredSelectorFields} 个 selector 全部落空），接口可能已改版或返回了缺少 response 的软错误响应`,
      );
    }
  }

  /**
   * L-3：实例级记忆（含空凭据）。空凭据刻意不写 12h 持久缓存，但若连实例内也不记，
   * 一页 N 条结果就会各发一次 /ajax.php?action=index（每个 transform*Torrent 都会调用本方法）。
   */
  private _authKeyPromise?: Promise<{ authkey: string; passkey: string }>;

  protected getAuthKey(): Promise<{ authkey: string; passkey: string }> {
    this._authKeyPromise ??= this.loadAuthKey().catch((error) => {
      this._authKeyPromise = undefined; // 请求失败不记忆，下次重试
      throw error;
    });
    return this._authKeyPromise;
  }

  private async loadAuthKey(): Promise<{ authkey: string; passkey: string }> {
    const currentTime = Math.floor(Date.now() / 1000);

    const cachedAuthKey = await this.retrieveRuntimeSettings<{
      authkey?: string;
      passkey?: string;
      expiry?: number;
    }>(GazelleJSONAPI.authKeyCacheKey);

    if (
      typeof cachedAuthKey?.authkey === "string" &&
      cachedAuthKey.authkey.trim().length > 0 &&
      typeof cachedAuthKey?.passkey === "string" &&
      cachedAuthKey.passkey.trim().length > 0 &&
      typeof cachedAuthKey?.expiry === "number" &&
      Number.isFinite(cachedAuthKey.expiry) &&
      cachedAuthKey.expiry > currentTime
    ) {
      return { authkey: cachedAuthKey.authkey.trim(), passkey: cachedAuthKey.passkey.trim() };
    }

    const apiInfo = await this.requestApiInfo();
    const authKey = {
      authkey: (apiInfo.response.authkey ?? "").trim(),
      passkey: (apiInfo.response.passkey ?? "").trim(),
    };

    // 空凭据不写入持久化缓存：否则后续 12 小时内的下载链接都会复用空 authkey/passkey；
    // 读取侧本来就有非空校验，因此跳过写缓存即可。
    if (authKey.authkey.length > 0 && authKey.passkey.length > 0) {
      await this.storeRuntimeSettings(GazelleJSONAPI.authKeyCacheKey, {
        ...authKey,
        expiry: currentTime + GazelleJSONAPI.authKeyCacheTtl,
      });
    }

    return authKey;
  }

  protected async transformUnGroupTorrent(group: torrentBrowseResult): Promise<ITorrent> {
    const { authkey, passkey } = await this.getAuthKey();

    const tags: { name: string; color: string }[] = [];
    if (group.isFreeleech || group.isPersonalFreeleech) {
      tags.push({ name: "Free", color: "blue" });
    }
    if (group.isNeutralLeech) {
      tags.push({ name: "Neutral", color: "cyan" });
    }

    return {
      site: this.metadata.id, // 补全种子的 site 属性
      id: group.torrentId,
      title: extractContent(group.groupName),
      subTitle: group.tags.join(", "),
      url: `${this.url}torrents.php?id=${group.groupId}&torrentid=${group.torrentId}`,
      link: `${this.url}torrents.php?action=download&id=${group.torrentId}&authkey=${authkey}&torrent_pass=${passkey}`,
      time: parseTimeWithZone(group.groupTime, this.metadata.timezoneOffset),
      size: group.size,
      author: "",
      seeders: group.seeders,
      leechers: group.leechers,
      completed: group.snatches,
      tags,
      category: group.category,
    } as ITorrent;
  }

  protected async transformGroupTorrent(group: groupBrowseResult, torrent: groupTorrent): Promise<ITorrent> {
    const { authkey, passkey } = await this.getAuthKey();

    const tags: { name: string; color: string }[] = [];
    if (torrent.isFreeleech || torrent.isPersonalFreeleech) {
      tags.push({ name: "Free", color: "blue" });
    }
    if (torrent.isNeutralLeech) {
      tags.push({ name: "Neutral", color: "cyan" });
    }

    const artistField = group.artist ? `${group.artist} - ` : "";
    return {
      site: this.metadata.id, // 补全种子的 site 属性
      id: torrent.torrentId,
      title: `${artistField}${extractContent(group.groupName)} [${group.groupYear}] [${group.releaseType}]`,
      subTitle:
        `${torrent.format} / ${torrent.encoding} / ${torrent.media}` +
        (torrent.hasLog ? ` / Log(${torrent.logScore})` : "") +
        (torrent.hasCue ? " / Cue" : "") +
        (torrent.remastered ? ` / ${torrent.remasterYear}` : "") +
        (torrent.remasterTitle ? ` / ${extractContent(torrent.remasterTitle)}` : "") +
        (torrent.scene ? " / Scene" : ""),
      url: `${this.url}torrents.php?id=${group.groupId}&torrentid=${torrent.torrentId}`,
      link: `${this.url}torrents.php?action=download&id=${torrent.torrentId}&authkey=${authkey}&torrent_pass=${passkey}`,
      time: parseTimeWithZone(torrent.time, this.metadata.timezoneOffset),
      size: torrent.size,
      author: "",
      seeders: torrent.seeders,
      leechers: torrent.leechers,
      completed: torrent.snatches,
      category: group.releaseType || "",
      tags,
    } as ITorrent;
  }

  public override async transformSearchPage(
    doc: browseJsonResponse | any,
    searchConfig: ISearchInput,
  ): Promise<ITorrent[]> {
    const torrents: ITorrent[] = [];

    // E-3：status 非 success（账号停用 / ratio watch / 限流等）时 Gazelle 会在 error 里给出原因，
    // 之前静默返回空数组会被上层当成「搜索成功但 0 结果」，错误信息被丢弃、用户只看到「无结果」。
    if (doc?.status !== "success") {
      throw new Error(`Gazelle API error: ${doc?.error ?? doc?.status ?? "unknown"}`);
    }

    // doc.response 缺失时不能直接 .results，否则会抛 TypeError 掩盖上面的原始错误
    const rows = doc.response?.results ?? [];
    for (const group of rows) {
      if ("torrents" in group) {
        // is groupBrowseResult
        for (const rawTorrent of group.torrents) {
          const torrent: ITorrent = await this.transformGroupTorrent(group, rawTorrent);
          torrents.push(torrent);
        }
      } else {
        const torrent: ITorrent = await this.transformUnGroupTorrent(group);
        torrents.push(torrent);
      }
    }

    return torrents;
  }

  public override async getTorrentDownloadLink(torrent: ITorrent): Promise<string> {
    // 种子链接格式是 torrent.php?torrentid=123
    return this.getTorrentDownloadLinkFactory("torrentid")(torrent);
  }

  public override async getUserInfoResult(lastUserInfo: Partial<IUserInfo> = {}): Promise<IUserInfo> {
    let flushUserInfo: IUserInfo = {
      status: EResultParseStatus.unknownError,
      updateAt: +new Date(),
      site: this.metadata.id,
    };

    if (!this.allowQueryUserInfo) {
      flushUserInfo.status = EResultParseStatus.passParse;
      return flushUserInfo;
    }

    try {
      flushUserInfo = { ...flushUserInfo, ...(await this.getUserBaseInfo()) };
      if (flushUserInfo.id) {
        flushUserInfo = {
          ...flushUserInfo,
          ...(await this.getUserExtendInfo(flushUserInfo.id as number)),
        };

        if (!flushUserInfo.seedingSize) {
          // M-8 / L-4：做种体积兜底失败不作废已解析的字段（见 GazelleBase.mergeSeedingSizeSafely）
          flushUserInfo = await this.mergeSeedingSizeSafely(flushUserInfo);
        }

        // 清理数据
        flushUserInfo = this.cleanupUserInfo(flushUserInfo);
      }

      if (this.metadata.levelRequirements && flushUserInfo.levelName && typeof flushUserInfo.levelId === "undefined") {
        flushUserInfo.levelId = this.guessUserLevelId(flushUserInfo as IUserInfo);
      }

      flushUserInfo.status = EResultParseStatus.success;
    } catch (error) {
      // 与 AbstractBittorrentSite / AbstractPrivateSite 保持一致：区分网络/服务端错误与解析失败，
      // 并把错误信息透传到 statusMsg，避免网络错误被误标为 parseError 且没有可展示原因。
      const { status, statusMsg, retryable } = classifySiteError(error);
      flushUserInfo.status = status;
      flushUserInfo.statusMsg = statusMsg;

      logMessage(
        `[Site] ${this.name} getUserInfoResult failed (status=${EResultParseStatus[status]}, retryable=${retryable})`,
        {
          site: this.metadata.id,
          status,
          retryable,
          error: siteErrorLogData(error),
        },
        retryable ? "warn" : "error",
      );
    }

    return flushUserInfo;
  }

  protected async getUserBaseInfo(): Promise<Partial<IUserInfo>> {
    const apiInfo = this.assertApiSuccess(await this.requestApiInfo(), "index");

    const fields = [
      "id",
      "name",
      "messageCount",
      "uploaded",
      "downloaded",
      "ratio",
      "levelName",
      "bonus",
      "bonusPerHour",
      "seedingSize",
    ] as (keyof IUserInfo)[];

    // H-6 家族：`{status:"success"}` 但没有 response 时不能把全空字段当成功写回（见 assertUserInfoFieldsMatched）
    this.assertUserInfoFieldsMatched(apiInfo, fields);

    return this.getFieldsData(apiInfo, this.metadata.userInfo!.selectors!, fields) as Partial<IUserInfo>;
  }

  protected async getUserExtendInfo(userId: number): Promise<Partial<IUserInfo>> {
    await this.sleepAction(this.metadata.userInfo?.requestDelay);

    const { data } = await this.requestApi<userJsonResponse>("user", {
      id: userId,
    });
    const apiUser = this.assertApiSuccess(data, "user");

    const fields = [
      "joinTime",
      "seeding",
      "uploads",
      "perfectFlacs",
      "groups",
      "invited",
      "lastAccessAt",
    ] as (keyof IUserInfo)[];

    // H-6 家族：action=user 同样只查了 status，零命中时 joinTime/lastAccessAt 等会被空值覆盖
    this.assertUserInfoFieldsMatched(apiUser, fields);

    return this.getFieldsData(apiUser, this.metadata.userInfo!.selectors!, fields) as Partial<IUserInfo>;
  }

  protected cleanupUserInfo(flushUserInfo: IUserInfo): IUserInfo {
    if (!flushUserInfo.bonus) {
      delete flushUserInfo.bonus;
    }
    if (!flushUserInfo.bonusPerHour) {
      delete flushUserInfo.bonusPerHour;
    }
    if (!flushUserInfo.perfectFlacs) {
      delete flushUserInfo["perfectFlacs"];
    }

    return flushUserInfo;
  }
}
