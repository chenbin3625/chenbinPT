import { defineExtensionMessaging } from "@webext-core/messaging";
import type {
  IAdvancedSearchRequestConfig,
  ISearchResult,
  ISiteUserConfig,
  ITorrent,
  IUserInfo,
  TSiteID,
  getFaviconMetadata,
} from "@ptd/site";
import type {
  ISocialInformation,
  ISocialRecommendationItem,
  ISocialRecommendationsResult,
  TSupportSocialSite$1,
} from "@ptd/social";
import type { IMediaServerId, IMediaServerSearchOptions, IMediaServerSearchResult } from "@ptd/mediaServer";
import type { IBackupData, IBackupFileInfo } from "@ptd/backupServer";
import type {
  CTorrent,
  CTorrentFile,
  CTorrentFileSelection,
  CTorrentPeer,
  CTorrentTracker,
  TorrentClientMetaData,
  TorrentClientStatus,
  TorrentQueueDirection,
  TorrentSpeedLimit,
} from "@ptd/downloader";

// 可序列化的种子信息，用于辅种检测
export interface ITorrentInfoForVerification {
  infoHash: string;
  name: string;
  length: number;
  files: Array<{
    path: string;
    length: number;
  }>;
}

import type { TExtensionStorageKey, IExtensionStorageSchema } from "@/storage.ts";
import {
  ILoggerItem,
  IRestoreOptions,
  IRestoreReport,
  ITorrentDownloadMetadata,
  TTorrentDownloadKey,
  IDownloaderMetadata,
  ISearchData,
  TSearchSnapshotKey,
  TBackupFields,
  TTorrentDownloadStatus,
  IDownloadTorrentOption,
  IDownloadTorrentResult,
  AugmentedRequired,
  IKeepUploadTask,
  TKeepUploadTaskKey,
  BridgeStatus,
} from "@/shared/types.ts";

import { isDebug } from "~/helper.ts";
import { toSerializable } from "@/shared/messagesSerializable.ts";
import { parsePath } from "@/shared/storagePath.ts";

/**
 * 把消息处理函数类型收窄为可调用类型，用于满足 `Parameters` / `ReturnType` 的泛型约束。
 * 对本来就是函数的消息处理函数是恒等映射（不改变入参与返回值，无参消息仍是 undefined）。
 */
type TMessageCallable<T> = T extends (...args: any[]) => any ? T : (...args: any[]) => any;

/**
 * 跨上下文消息契约。
 *
 * ⚠️ 不要给这个接口加字符串索引签名（例如 `interface ProtocolMap extends Record<string, (data: any) => any>`）：
 * 那会让任意消息名都能通过类型检查、参数与返回值退化为 any，整份消息表失去编译期保护。
 * createMessageWrapper 依赖 `TMessageCallable` 在「无索引签名」的前提下推导 payload 与返回值。
 */
interface ProtocolMap {
  // 1. 与 chrome 相关的功能，需要在 service worker 中注册，主要供 offscreen, options 使用
  ping<T extends any>(data?: T): T extends undefined ? "pong" : T;
  ensureOffscreenDocument(): void;
  openOptionsPage(url?: string | { path: string; query?: Record<string, any> }): void;

  // 1.1 chrome.downloads
  downloadFile(downloadOptions: chrome.downloads.DownloadOptions): number;

  // 1.2 chrome.storage
  getExtStorage<T extends TExtensionStorageKey>(key: T): IExtensionStorageSchema[T];
  setExtStorage<T extends TExtensionStorageKey>(data: { key: T; value: IExtensionStorageSchema[T] }): void;
  /**
   * 只取指定路径的值（而不是整份对象），避免把数百 KB 的 metadata/userInfo 通过消息传回调用方。
   * 见 docs/performance-audit.md P0-2。
   */
  getExtStoragePath<T extends TExtensionStorageKey>(data: {
    key: T;
    path: string | Array<string | number>;
    defaultValue?: any;
  }): any;
  /**
   * 局部更新：在 service worker 内「读 → 改指定路径 → 写回」，避免大对象跨上下文往返与并发读改写。
   * `remove: true` 表示删除该路径。
   */
  patchExtStoragePath<T extends TExtensionStorageKey>(data: {
    key: T;
    path: string | Array<string | number>;
    value?: any;
    remove?: boolean;
  }): void;

  // 1.3 chrome.declarativeNetRequest
  updateDNRSessionRules(data: { rule: chrome.declarativeNetRequest.Rule; extOnly?: boolean }): void;
  removeDNRSessionRuleById(data: chrome.declarativeNetRequest.Rule["id"]): void;

  // 1.4 chrome.alarms
  reDownloadTorrent(data: AugmentedRequired<IDownloadTorrentOption, "downloadId" | "leftInterval">): void;

  // 1.5 chrome.cookies
  getAllCookies(data: chrome.cookies.GetAllDetails): chrome.cookies.Cookie[];
  setCookie(data: chrome.cookies.SetDetails): void;
  getCookie(data: chrome.cookies.CookieDetails): chrome.cookies.Cookie | null;
  removeCookie(data: chrome.cookies.CookieDetails | chrome.cookies.SetDetails): chrome.cookies.CookieDetails;
  checkAndExtendCookies(url: string): void;

  // 1.6 chrome.notifications
  showNotification(data: { options: chrome.notifications.NotificationOptions; timeout?: number }): void;

  // 1.7 chrome.contextMenus
  addContextMenu(data: chrome.contextMenus.CreateProperties): string;
  removeContextMenu(data: string): void;
  clearContextMenus(): void;

  // 2. 在 offscreen 中注册，涉及页面解析等功能，主要供 options 使用
  logger(data: ILoggerItem): void;
  getLogger(): ILoggerItem[];
  clearLogger(): void;

  // 2.1 站点基础 ( utils/site )
  getSiteUserConfig(data: { siteId: TSiteID; flush?: boolean }): ISiteUserConfig;
  getSiteFavicon(data: { site: TSiteID | getFaviconMetadata; flush?: boolean }): string;
  clearSiteFaviconCache(): void;

  // 2.2 站点搜索、搜索快照 ( utils/search )
  getSiteSearchResult(data: {
    siteId: TSiteID;
    keyword?: string;
    searchEntry?: IAdvancedSearchRequestConfig;
    autoDetectOfficialGroupFromTitle?: boolean;
  }): ISearchResult;
  getMediaServerSearchResult(data: {
    mediaServerId: IMediaServerId;
    keywords?: string;
    options?: IMediaServerSearchOptions;
  }): IMediaServerSearchResult;
  getSearchResultSnapshotData(snapshotId: TSearchSnapshotKey): ISearchData;
  saveSearchResultSnapshotData(data: { snapshotId: TSearchSnapshotKey; data: ISearchData }): void;
  removeSearchResultSnapshotData(snapshotId: TSearchSnapshotKey): void;

  // 2.3 下载器、下载历史 ( utils/download )
  getDownloaderConfig(downloaderId: string): IDownloaderMetadata;
  getDownloaderVersion(downloaderId: string): string;
  getDownloaderStatus(downloaderId: string): TorrentClientStatus;
  getTorrentDownloadLink(torrent: ITorrent): string;
  getTorrentInfoForVerification(torrent: ITorrent): ITorrentInfoForVerification;

  getClientTorrents(downloaderId: string): CTorrent[];
  getClientTorrentTrackers(data: { downloaderId: string; torrent: CTorrent }): string[];
  deleteClientTorrent(data: { downloaderId: string; id: any; removeData?: boolean }): boolean;
  pauseClientTorrent(data: { downloaderId: string; id: any }): boolean;
  resumeClientTorrent(data: { downloaderId: string; id: any }): boolean;
  recheckClientTorrent(data: { downloaderId: string; id: any }): boolean;
  moveClientTorrentInQueue(data: { downloaderId: string; id: any; direction: TorrentQueueDirection }): boolean;
  setClientTorrentSpeedLimit(data: { downloaderId: string; id: any; limits: TorrentSpeedLimit }): boolean;
  setClientTorrentLabel(data: { downloaderId: string; id: any; label: string }): boolean;

  // 下载器能力元数据（feature 声明，UI 据此渲染文件/peers/tracker 面板）
  getDownloaderMetaData(downloaderId: string): TorrentClientMetaData | undefined;

  // 文件级 / peers / tracker 管理
  getClientTorrentFiles(data: { downloaderId: string; torrent: CTorrent }): CTorrentFile[];
  setClientTorrentFilePriority(data: {
    downloaderId: string;
    torrent: CTorrent;
    selections: CTorrentFileSelection[];
  }): boolean;
  getClientTorrentPeers(data: { downloaderId: string; torrent: CTorrent }): CTorrentPeer[];
  getClientTorrentTrackersDetail(data: { downloaderId: string; torrent: CTorrent }): CTorrentTracker[];
  addClientTorrentTracker(data: { downloaderId: string; torrent: CTorrent; url: string }): boolean;
  removeClientTorrentTracker(data: { downloaderId: string; torrent: CTorrent; url: string }): boolean;

  downloadTorrent(data: IDownloadTorrentOption): IDownloadTorrentResult;

  getDownloadHistory(): ITorrentDownloadMetadata[];
  getDownloadHistoryById(downloadId: TTorrentDownloadKey): ITorrentDownloadMetadata;
  setDownloadHistoryStatus(data: { downloadId: TTorrentDownloadKey; status: TTorrentDownloadStatus }): void;
  deleteDownloadHistoryById(downloadId: TTorrentDownloadKey): void;
  clearDownloadHistory(): void;

  // 2.4 用户信息 ( utils/userInfo )
  getSiteUserInfoResult(data: TSiteID | { siteId: TSiteID; queueConcurrency?: number }): IUserInfo;
  setSiteLastUserInfo(userInfo: IUserInfo): void;
  cancelUserInfoQueue(): void;
  getSiteUserInfo(siteId: TSiteID): Record<string, IUserInfo>;
  removeSiteUserInfo(data: { siteId: TSiteID; date: string[] }): void;

  // 2.5 社交信息 ( utils/socialInformation )
  getSocialInformation(data: { site: TSupportSocialSite$1; sid: string }): ISocialInformation;
  // 判断 URL 命中的社交站点（供 content-script 引导做轻量预筛，避免把 social 包打进引导，见 issue #1467）
  matchSocialPage(url: string): TSupportSocialSite$1 | null;
  getSocialRecommendations(data?: {
    flush?: boolean;
    enrichment?: "all" | "none" | "visible";
  }): ISocialRecommendationsResult;
  getSocialRecommendationItem(data: { item: ISocialRecommendationItem; enrichment?: "all" | "visible" }): {
    item: ISocialRecommendationItem;
  };
  clearSocialInformationCache(): void;

  // 2.6 备份/恢复 ( utils/backup )
  exportBackupData(data: { backupServerId: string | "local"; backupFields: TBackupFields[] }): boolean;
  getBackupHistory(data: string): IBackupFileInfo[];
  deleteBackupHistory(data: { backupServerId: string; path: string }): boolean;
  applyBackupRetention(data: { backupServerId: string; keepFilename?: string }): IBackupFileInfo[];
  /**
   * 恢复备份。
   *
   * 返回**结构化报告**而不是 `boolean`：S-1 的安全提示必须让用户看到「哪些字段被跳过、
   * 哪些被安全化」（例如备份里的 `backupServers` 因未显式确认而被剥离）——只回传成功与否
   * 会让这条提示无处呈现（options 侧日志查看器已移除、offscreen 日志无人读取）。
   */
  restoreBackupData(data: { restoreData: IBackupData; restoreOptions?: IRestoreOptions }): IRestoreReport;
  getRemoteBackupData(data: { backupServerId: string; path: string; decryptKey?: string }): IBackupData;

  // 2.7 辅种任务 ( utils/keepUploadTask )
  getKeepUploadTasks(): IKeepUploadTask[];
  getKeepUploadTaskById(taskId: TKeepUploadTaskKey): IKeepUploadTask;
  createKeepUploadTask(task: IKeepUploadTask): void;
  updateKeepUploadTask(task: IKeepUploadTask): void;
  deleteKeepUploadTask(taskId: TKeepUploadTaskKey): void;
  clearKeepUploadTasks(): void;

  // 2.8 Lightweight list queries (for CLI discovery)
  getSiteList(): Array<{ id: string; name: string; url: string; offline: boolean }>;
  getDownloaderList(): Array<{ id: string; name: string; type: string; enabled: boolean; address: string }>;

  // 2.9 Native messaging bridge control
  nativeBridgeGetStatus(): BridgeStatus;
  nativeBridgeSetEnabled(data: boolean): BridgeStatus;
  nativeBridgeReconnect(): BridgeStatus;
}

/**
 * 由 offscreen document 处理的消息。
 *
 * options/content-script/background 在发送这些消息前必须先让 service worker
 * 确认 offscreen 已创建；否则扩展刚重载、SW 刚唤醒或首次创建发生竞态时，
 * Chrome 会以 "The message port closed before a response was received" 结束调用。
 */
const offscreenMessageTypes = new Set<keyof ProtocolMap>([
  "logger",
  "getLogger",
  "clearLogger",
  "getSiteUserConfig",
  "getSiteFavicon",
  "clearSiteFaviconCache",
  "getSiteSearchResult",
  "getMediaServerSearchResult",
  "getSearchResultSnapshotData",
  "saveSearchResultSnapshotData",
  "removeSearchResultSnapshotData",
  "getDownloaderConfig",
  "getDownloaderVersion",
  "getDownloaderStatus",
  "getTorrentDownloadLink",
  "getTorrentInfoForVerification",
  "getClientTorrents",
  "getClientTorrentTrackers",
  "deleteClientTorrent",
  "pauseClientTorrent",
  "resumeClientTorrent",
  "recheckClientTorrent",
  "moveClientTorrentInQueue",
  "setClientTorrentSpeedLimit",
  "setClientTorrentLabel",
  "getDownloaderMetaData",
  "getClientTorrentFiles",
  "setClientTorrentFilePriority",
  "getClientTorrentPeers",
  "getClientTorrentTrackersDetail",
  "addClientTorrentTracker",
  "removeClientTorrentTracker",
  "downloadTorrent",
  "getDownloadHistory",
  "getDownloadHistoryById",
  "setDownloadHistoryStatus",
  "deleteDownloadHistoryById",
  "clearDownloadHistory",
  "getSiteUserInfoResult",
  "setSiteLastUserInfo",
  "cancelUserInfoQueue",
  "getSiteUserInfo",
  "removeSiteUserInfo",
  "getSocialInformation",
  "matchSocialPage",
  "getSocialRecommendations",
  "getSocialRecommendationItem",
  "clearSocialInformationCache",
  "exportBackupData",
  "getBackupHistory",
  "deleteBackupHistory",
  "applyBackupRetention",
  "restoreBackupData",
  "getRemoteBackupData",
  "getKeepUploadTasks",
  "getKeepUploadTaskById",
  "createKeepUploadTask",
  "updateKeepUploadTask",
  "deleteKeepUploadTask",
  "clearKeepUploadTasks",
  "getSiteList",
  "getDownloaderList",
]);

// 全局消息处理函数映射
const messageMaps: Partial<ProtocolMap> = {};

// Content scripts must retain search/download access, but must not call administrative
// endpoints that expose whole storage, cookies, or backup and browser rule controls.
const extensionPageOnlyMessages = new Set<keyof ProtocolMap>([
  "getExtStorage",
  "setExtStorage",
  "patchExtStoragePath",
  "getDownloaderConfig",
  "getAllCookies",
  "getCookie",
  "setCookie",
  "removeCookie",
  "restoreBackupData",
  "exportBackupData",
  "getRemoteBackupData",
  "deleteBackupHistory",
  "applyBackupRetention",
  "saveSearchResultSnapshotData",
  "removeSearchResultSnapshotData",
  "setSiteLastUserInfo",
  "removeSiteUserInfo",
  "setDownloadHistoryStatus",
  "deleteDownloadHistoryById",
  "clearDownloadHistory",
  "createKeepUploadTask",
  "updateKeepUploadTask",
  "deleteKeepUploadTask",
  "clearKeepUploadTasks",
  "updateDNRSessionRules",
  "removeDNRSessionRuleById",
  "nativeBridgeGetStatus",
  "nativeBridgeSetEnabled",
  "nativeBridgeReconnect",
]);

function isExtensionPageSender(sender: chrome.runtime.MessageSender | undefined): boolean {
  const extensionBase = chrome.runtime.getURL("");
  return sender?.id === chrome.runtime.id && typeof sender.url === "string" && sender.url.startsWith(extensionBase);
}

function isContentScriptStoragePathAllowed(data: unknown): boolean {
  if (!data || typeof data !== "object") return false;
  const { key, path } = data as { key?: unknown; path?: unknown };
  if (typeof path !== "string" && !Array.isArray(path)) return false;
  if (Array.isArray(path) && !path.every((part) => typeof part === "string" || typeof part === "number")) {
    return false;
  }
  const parts = parsePath(path as string | Array<string | number>);
  if (parts.length === 1) {
    return (
      (key === "config" && parts[0] === "contentScript") ||
      ((key === "siteIndex" || key === "metadata") && parts[0] === "siteHostMap")
    );
  }
  return (
    key === "metadata" &&
    parts.length === 3 &&
    parts[0] === "sites" &&
    typeof parts[1] === "string" &&
    parts[2] === "allowContentScript"
  );
}

/**
 * 允许在「连接类错误」后自动重试的**只读**消息白名单（缺陷清单 B-9）。
 *
 * 为什么必须显式维护、且默认是「白名单」而不是「黑名单」：
 * - 现在的重试是**原样重发**，对非幂等 RPC 等价于 at-least-once：offscreen 已经完成操作、
 *   但在回包前被回收时会执行两次。例如 `downloadTorrent` 每次消息都新铸 `downloadId`
 *   （见 offscreen/utils/download.ts），于是重复下载 + 重复历史记录；
 *   `createKeepUploadTask` / `restoreBackupData` / `deleteClientTorrent` 同理。
 * - 漏掉一个只读消息的代价只是「offscreen 被回收时这次请求失败一次」（用户重试即可），
 *   而误把写类消息放进来的代价是**静默重复执行用户操作**。两者代价不对称，所以默认不重试。
 * - 写类消息若确实需要重试，必须由**调用方**提供幂等键（例如 `downloadTorrent` 的 `downloadId`、
 *   辅种任务的 `taskId`）并自行去重后再调用；消息层拿不到业务语义，无法做去重。
 *
 * 维护方式：新增消息时显式判断它是否只读；忘归类时的默认行为是「不重试」（失败可见，不静默重复）。
 * 本集合必须是 `offscreenMessageTypes` 的子集 —— 非 offscreen 消息本来就不会进入这段重试逻辑，
 * 该子集关系由 tests/entries/messagesOffscreenReady.test.ts 守卫。
 */
export const retryableOffscreenMessageTypes = new Set<keyof ProtocolMap>([
  // 1.x / 2.x 日志读取（logger / clearLogger 都是写，不在此列）
  "getLogger",
  // 2.1 站点基础信息
  "getSiteUserConfig",
  "getSiteFavicon",
  // 2.2 站点搜索与搜索快照：这里只列**读**，saveSearchResultSnapshotData /
  // removeSearchResultSnapshotData 会改持久化数据，不在白名单内
  "getSiteSearchResult",
  "getMediaServerSearchResult",
  "getSearchResultSnapshotData",
  // 2.3 下载器 / 下载历史的只读查询（所有 set/pause/resume/recheck/move/delete/add/remove 都不在此列）
  "getDownloaderConfig",
  "getDownloaderVersion",
  "getDownloaderStatus",
  "getTorrentDownloadLink",
  "getTorrentInfoForVerification",
  "getClientTorrents",
  "getClientTorrentTrackers",
  "getDownloaderMetaData",
  "getClientTorrentFiles",
  "getClientTorrentPeers",
  "getClientTorrentTrackersDetail",
  "getDownloadHistory",
  "getDownloadHistoryById",
  // 2.4 用户信息：getSiteUserInfoResult 会向站点重新取一次数据并做幂等写回，
  // 但重复执行只等于「再刷新一次」，没有额外的用户可见副作用
  "getSiteUserInfoResult",
  "getSiteUserInfo",
  // 2.5 社交信息只读查询（clearSocialInformationCache 是写，不在此列）
  "getSocialInformation",
  "matchSocialPage",
  "getSocialRecommendations",
  "getSocialRecommendationItem",
  // 2.6 备份只读查询。注意 exportBackupData / restoreBackupData / deleteBackupHistory /
  // applyBackupRetention 都会改本地或远端数据，**明确不在**此列（restoreBackupData 重复执行会覆盖用户配置）
  "getBackupHistory",
  "getRemoteBackupData",
  // 2.7 辅种任务只读查询（create / update / delete / clear 都是写，不在此列）
  "getKeepUploadTasks",
  "getKeepUploadTaskById",
  // 2.8 轻量列表查询（CLI 发现用）
  "getSiteList",
  "getDownloaderList",
]);

/**
 * 是否为「可安全自动重试」的只读消息。
 * 不在白名单里的消息（尤其是写类消息）在连接类错误后直接失败，由调用方决定是否重试。
 */
export function isRetryableOffscreenMessageType(type: keyof ProtocolMap): boolean {
  return retryableOffscreenMessageTypes.has(type);
}

/**
 * 为 sendMessage 和 onMessage 创建一个包装器
 * 如果 sendMessage 和 onMessage 对应的 type 是在同一个 tab 中创建的，则直接调用，不然传递给 chrome.{runtime, tab}.sendMessage
 * 有效避免 chrome 中 background 是 server worker + offscreen, 而 firefox 中是 background script
 * 而导致的 chrome.runtime.sendMessage 无响应的问题
 */
function createMessageWrapper<PM extends ProtocolMap>(original: {
  sendMessage: <K extends keyof PM>(
    type: K,
    data: Parameters<TMessageCallable<PM[K]>>[0],
  ) => Promise<ReturnType<TMessageCallable<PM[K]>>>;
  onMessage: <K extends keyof PM>(
    type: K,
    handler: (message: {
      data: Parameters<TMessageCallable<PM[K]>>[0];
      sender?: chrome.runtime.MessageSender;
    }) => void | Promise<ReturnType<TMessageCallable<PM[K]>>>,
  ) => void;
}) {
  let offscreenReadyPromise: Promise<void> | null = null;

  /**
   * 判定「offscreen 尚未就绪 / 消息端口断开」这一类**传输层**错误。
   *
   * 只承认浏览器给出的连接类文案。**不能再收 `no response`**（缺陷清单 B-9 第 2 点）：
   * `@webext-core/messaging` 在没有回包时会抛 `Error("No response")`，但 handler 内部抛出的
   * 任意错误只要文本命中该串（例如站点/下载器返回 "no response from server"）也会被判成连接错误，
   * 于是一次业务失败被当成通道故障，触发一次多余的整段重发（对写类消息就是重复执行）。
   * 收敛判据后，「没有回包」退化为调用方可见的失败 —— 比「把业务错误当通道故障重试」安全得多。
   */
  function isOffscreenConnectionError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /message port closed|receiving end does not exist|could not establish connection/i.test(message);
  }

  async function ensureOffscreenReady(): Promise<void> {
    if (offscreenReadyPromise) {
      return offscreenReadyPromise;
    }

    const localHandler = messageMaps.ensureOffscreenDocument as
      ((message: { data: undefined }) => void | Promise<void>) | undefined;
    const pending = localHandler
      ? Promise.resolve(localHandler({ data: undefined }))
      : (original.sendMessage as any)("ensureOffscreenDocument", undefined);

    offscreenReadyPromise = Promise.resolve(pending).catch((error) => {
      offscreenReadyPromise = null;
      throw error;
    });
    return offscreenReadyPromise;
  }

  // 包装后的 onMessage：将异步处理函数存入 messageMaps
  const wrappedOnMessage = <K extends keyof PM>(
    type: K,
    handler: (message: {
      data: Parameters<TMessageCallable<PM[K]>>[0];
      sender?: chrome.runtime.MessageSender;
    }) => void | Promise<ReturnType<TMessageCallable<PM[K]>>>,
  ) => {
    // @ts-expect-error
    messageMaps[type] = handler;
    original.onMessage(type, (message) => {
      if (
        (extensionPageOnlyMessages.has(type as keyof ProtocolMap) ||
          (type === "getExtStoragePath" && !isContentScriptStoragePathAllowed(message.data))) &&
        !isExtensionPageSender(message.sender)
      ) {
        throw new Error(`Permission denied for message sender: ${String(type)}`);
      }
      return handler(message);
    });
  };

  // 包装后的 sendMessage：优先使用 messageMaps 中的异步处理函数
  const wrappedSendMessage = async <K extends keyof PM>(
    type: K,
    data: Parameters<TMessageCallable<PM[K]>>[0],
  ): Promise<ReturnType<TMessageCallable<PM[K]>>> => {
    // @ts-expect-error
    const localHandler = messageMaps[type] as TMessageCallable<PM[K]> | undefined;

    // 解代理：避免 Vue 响应式 Proxy 或其他不可结构化克隆的对象进入消息链路引发 DataCloneError。
    // 原实现用 JSON 往返做深拷贝（见 issue #1431），现改为递归解代理，语义对齐但不再产生
    // 整份字符串与二次拷贝（见 docs/performance-audit.md P1-1）。
    if (typeof data !== "undefined") {
      data = toSerializable(data);
    }

    if (localHandler) {
      return await localHandler({ data }); // 执行本地异步处理
    }

    const needsOffscreen = offscreenMessageTypes.has(type as keyof ProtocolMap);
    if (needsOffscreen) {
      try {
        await ensureOffscreenReady();
      } catch (error) {
        if (!isOffscreenConnectionError(error)) {
          throw error;
        }
        offscreenReadyPromise = null;
        await ensureOffscreenReady();
      }
    }

    try {
      return await original.sendMessage(type, data); // 执行远程异步调用
    } catch (error) {
      /**
       * 只有「只读消息 + 传输层连接错误」才允许**原样重发**（缺陷清单 B-9）。
       *
       * 重发是 at-least-once：offscreen 可能已经完成操作、只是在回包前被回收，
       * 因此写类消息（downloadTorrent / createKeepUploadTask / restoreBackupData / deleteClientTorrent …）
       * 一律不自动重试，让失败在调用方可见 —— 需要幂等的调用方必须自带幂等键并在调用方去重。
       */
      if (
        !needsOffscreen ||
        !isRetryableOffscreenMessageType(type as keyof ProtocolMap) ||
        !isOffscreenConnectionError(error)
      ) {
        throw error;
      }

      // 只读消息：offscreen 可能在扩展重载或异常后被回收，清掉缓存、重建并只重试一次。
      offscreenReadyPromise = null;
      await ensureOffscreenReady();
      return await original.sendMessage(type, data);
    }
  };

  return {
    sendMessage: wrappedSendMessage,
    onMessage: wrappedOnMessage,
  };
}

export const { sendMessage, onMessage } = createMessageWrapper(
  defineExtensionMessaging<ProtocolMap>({
    logger: isDebug ? console : undefined,
  }),
);
