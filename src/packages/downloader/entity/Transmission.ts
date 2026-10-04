import {
  AbstractBittorrentClient,
  CAddTorrentOptions,
  CustomPathDescription,
  CTorrent,
  TorrentClientConfig,
  TorrentClientMetaData,
  CTorrentFilterRules,
  CTorrentState,
  TorrentClientStatus,
  CAddTorrentResult,
  TorrentQueueDirection,
  TorrentSpeedLimit,
  CTorrentFile,
  CTorrentFileSelection,
  CTorrentPeer,
  CTorrentTracker,
  CTrackerState,
  TorrentFilePriority,
} from "../types";
import urlJoin from "url-join";
import axios, { type AxiosResponse, isAxiosError } from "axios";
import { getRemoteTorrentFile } from "../utils";
import { logMessage } from "@ptd/site/utils/adapter.ts";

export const clientConfig: TorrentClientConfig = {
  type: "Transmission",
  name: "Transmission",
  address: "http://localhost:9091/",
  username: "",
  password: "",
  timeout: 60 * 1e3,
};

// noinspection JSUnusedGlobalSymbols
export const clientMetaData: TorrentClientMetaData = {
  description: "Transmission 是一个跨平台的BitTorrent客户端，特点是硬件资源消耗极少，界面极度精简",
  warning: [
    "默认情况下，系统会请求 http://ip:port/transmission/rpc 这个路径，如果无法连接，请确认 `settings.json` 文件的 `rpc-url` 值；详情可参考：https://github.com/ronggang/PT-Plugin-Plus/issues/32",
  ],
  feature: {
    CustomPath: {
      allowed: true,
      description: CustomPathDescription,
    },
    DefaultAutoStart: {
      allowed: true,
    },
    Recheck: {
      allowed: true,
    },
    Queue: {
      allowed: true,
    },
    SpeedLimit: {
      allowed: true,
    },
    Label: {
      allowed: true,
    },
    BypassCSRF: {
      allowed: false,
    },
    FileList: {
      allowed: true,
    },
    FilePriority: {
      allowed: true,
    },
    PeerList: {
      allowed: true,
    },
    TrackerList: {
      allowed: true,
    },
    TrackerManage: {
      allowed: true,
    },
  },
};

// 这里只写出了部分我们需要的
interface rawTorrent {
  addedDate: number;
  id: number;
  hashString: string;
  isFinished: boolean;
  name: string;
  percentDone: number;
  uploadRatio: number;
  downloadDir: string;
  status: number;
  totalSize: number;
  leftUntilDone: number;
  labels: string[];
  /**
   * 注意：Transmission RPC 实际接受的字段名不带 " (B/s)" 后缀（rpc-spec.md 中旧命名为 rateDownload (B/s)，
   * 但实测 Transmission 4.x 返回的 key 为 rateDownload / rateUpload，带后缀的字段名会被静默忽略）
   */
  rateDownload: number;
  rateUpload: number;
  /**
   * Byte count of all data you've ever uploaded for this torrent.
   */
  uploadedEver: number;
  /**
   * Byte count of all the non-corrupt data you've ever downloaded for this torrent. If you deleted the files and downloaded a second time, this will be 2*totalSize.
   */
  downloadedEver: number;

  trackers: Array<{
    announce: string;
    id: string;
    scrape: string;
    sitename: string;
    tier: number;
  }>;
}

interface TransmissionBaseResponse<T = any> {
  arguments: T;
  result: "success" | string;
  tag?: number;
}

interface TransmissionTorrentGetResponse extends TransmissionBaseResponse {
  arguments: {
    torrents: rawTorrent[];
  };
}

interface TransmissionRawStats {
  downloadedBytes: number;
  filesAdded: number;
  secondsActive: number;
  sessionCount: number;
  uploadedBytes: number;
}

interface TransmissionStatsResponse extends TransmissionBaseResponse {
  arguments: {
    activeTorrentCount: number;
    "cumulative-stats": TransmissionRawStats;
    "current-stats": TransmissionRawStats;
    downloadSpeed: number;
    pausedTorrentCount: number;
    torrentCount: number;
    uploadSpeed: number;
  };
}

/**
 * `torrent-add` 的响应。
 *
 * 与 session-get / torrent-get / free-space 不同，`torrent-add` 的 `arguments` **可能缺省**：
 * - 失败时服务端只回 `result`（错误描述）与 `tag`，没有 `arguments`；
 * - 重复种子在旧服务器（rpc-version < 15）上同样只回 `result: "duplicate torrent"`，
 *   `torrent-duplicate` 是 Transmission 2.80 才加入的（见 rpc-spec 的 protocol versions 表）。
 *
 * 因此这里用 `Omit` 覆写成可选，而不是把基类的 `arguments` 改成可选：
 * 其余方法（`torrent-get` 取 `torrents`、`free-space` 取 `size-bytes` …）的 `arguments`
 * 是必需语义，改基类会让那些调用点丢掉类型保护。调用处也照此用可选链读取（见 addTorrent）。
 */
interface AddTorrentResponse extends Omit<TransmissionBaseResponse, "arguments"> {
  arguments?: {
    /** 新增成功时返回 */
    "torrent-added"?: {
      id: number;
      hashString: string;
      name: string;
    };
    /** 该种子已在库中时返回（与 torrent-added 互斥，同样是成功语义） */
    "torrent-duplicate"?: {
      id: number;
      hashString: string;
      name: string;
    };
  };
}

type TransmissionTorrentIds = number | Array<number | string> | "recently-active";

type TransmissionRequestMethod =
  | "session-get"
  | "session-stats"
  | "free-space"
  | "torrent-get"
  | "torrent-add"
  | "torrent-start"
  | "torrent-stop"
  | "torrent-remove"
  | "torrent-verify"
  | "torrent-set"
  | "queue-move-top"
  | "queue-move-up"
  | "queue-move-down"
  | "queue-move-bottom";

interface TransmissionAddTorrentOptions {
  "download-dir": string;
  filename: string;
  metainfo: string;
  paused: boolean;
  labels: string[]; // RPC Version >= 17，使用前需要判断
}

interface TransmissionTorrentFilterRules extends CTorrentFilterRules {
  ids?: TransmissionTorrentIds;
}

interface TransmissionTorrentArguments {
  ids?: TransmissionTorrentIds;
}

type TransmissionTorrentsField =
  | "activityDate"
  | "addedDate"
  | "bandwidthPriority"
  | "comment"
  | "corruptEver"
  | "creator"
  | "dateCreated"
  | "desiredAvailable"
  | "doneDate"
  | "downloadDir"
  | "downloadedEver"
  | "downloadLimit"
  | "downloadLimited"
  | "editDate"
  | "error"
  | "errorString"
  | "eta"
  | "etaIdle"
  | "files"
  | "fileStats"
  | "hashString"
  | "haveUnchecked"
  | "haveValid"
  | "honorsSessionLimits"
  | "id"
  | "isFinished"
  | "isPrivate"
  | "isStalled"
  | "labels"
  | "leftUntilDone"
  | "magnetLink"
  | "manualAnnounceTime"
  | "maxConnectedPeers"
  | "metadataPercentComplete"
  | "name"
  | "peer-limit"
  | "peers"
  | "peersConnected"
  | "peersFrom"
  | "peersGettingFromUs"
  | "peersSendingToUs"
  | "percentDone"
  | "pieces"
  | "pieceCount"
  | "pieceSize"
  | "priorities"
  | "queuePosition"
  | "rateDownload"
  | "rateUpload"
  | "recheckProgress"
  | "secondsDownloading"
  | "secondsSeeding"
  | "seedIdleLimit"
  | "seedIdleMode"
  | "seedRatioLimit"
  | "seedRatioMode"
  | "sizeWhenDone"
  | "startDate"
  | "status"
  | "trackers"
  | "trackerStats"
  | "totalSize"
  | "torrentFile"
  | "uploadedEver"
  | "uploadLimit"
  | "uploadLimited"
  | "uploadRatio"
  | "wanted"
  | "webseeds"
  | "webseedsSendingToUs";

interface TransmissionTorrentGetArguments extends TransmissionTorrentArguments {
  fields: TransmissionTorrentsField[];
}

interface TransmissionTorrentRemoveArguments extends TransmissionTorrentArguments {
  "delete-local-data"?: boolean;
}

// Transmission 文件优先级: 0=normal, -1=low, 1=high; wanted=false 即 skip
function mapTransmissionFilePriority(priority: number, wanted: boolean): TorrentFilePriority {
  if (!wanted) {
    return "skip";
  }
  switch (priority) {
    case -1:
      return "low";
    case 1:
      return "high";
    case 0:
    default:
      return "normal";
  }
}

// Transmission trackerStats: announceState 0=inactive 1=waiting 2=queued 3=active; lastAnnounceSucceeded 标志错误
function mapTransmissionTrackerState(tracker: {
  announceState: number;
  lastAnnounceSucceeded: boolean;
  isBackup: boolean;
}): CTrackerState {
  if (tracker.lastAnnounceSucceeded === false) {
    return CTrackerState.error;
  }
  if (tracker.announceState === 3) {
    return CTrackerState.working;
  }
  if (tracker.announceState === 1 || tracker.announceState === 2) {
    return CTrackerState.updating;
  }
  if (tracker.isBackup) {
    return CTrackerState.disabled;
  }
  return CTrackerState.unknown;
}

// noinspection JSUnusedGlobalSymbols
export default class Transmission extends AbstractBittorrentClient<TorrentClientConfig> {
  readonly version = "v0.1.0";

  private readonly torrentRequestFields: TransmissionTorrentsField[] = [
    "addedDate",
    "id",
    "hashString",
    "isFinished",
    "name",
    "percentDone",
    "uploadRatio",
    "downloadDir",
    "status",
    "totalSize",
    "leftUntilDone",
    "labels",
    "trackers",
    // 上传/下载速度与总量
    "rateDownload",
    "rateUpload",
    "uploadedEver",
    "downloadedEver",
  ];

  // 实例真实使用的rpc地址
  private readonly address: string;

  private sessionId = "";

  constructor(options: Partial<TorrentClientConfig> = {}) {
    super({ ...clientConfig, ...options });

    // 修正服务器地址
    let address = this.config.address;
    if (address.indexOf("rpc") === -1) {
      address = urlJoin(address, "/transmission/rpc");
    }
    this.address = address;
  }

  async ping(): Promise<boolean> {
    try {
      const { data } = await this.request<TransmissionBaseResponse>("session-get");
      return data.result === "success";
    } catch (e) {
      return false;
    }
  }

  protected async getClientVersionFromRemote(): Promise<string> {
    const {
      data: { arguments: sessionData },
    } = await this.request<TransmissionBaseResponse<{ version: string; "rpc-version": number }>>("session-get");
    return `${sessionData.version}, RPC ${sessionData["rpc-version"]}`;
  }

  override async getClientStatus(): Promise<TorrentClientStatus> {
    const retStatus: TorrentClientStatus = await super.getClientStatus();

    const statsReq = this.request<TransmissionStatsResponse>("session-stats");

    const {
      data: { arguments: statsData },
    } = await statsReq;
    retStatus.dlSpeed = statsData.downloadSpeed;
    retStatus.upSpeed = statsData.uploadSpeed;
    retStatus.dlData = statsData["current-stats"].downloadedBytes;
    retStatus.upData = statsData["current-stats"].uploadedBytes;

    return retStatus;
  }

  override async getClientFreeSpace(): Promise<number> {
    const {
      data: { arguments: sessionData },
    } = await this.request<
      TransmissionBaseResponse<{
        "download-dir": string;
        "download-dir-free-space"?: number;
      }>
    >("session-get");

    /**
     * 由于 download-dir-free-space 在 rpc-spec 中属于过时的方法，
     * 所以如果在 session-get 方法中，没有获取到该键值对，
     * 则进一步调用 free-space 方法
     *
     * @refs https://github.com/transmission/transmission/blob/790b0bb2b5d195e4c5652716f9e5f5c6003193ee/extras/rpc-spec.txt#L865-L866
     * @refs https://github.com/ronggang/transmission-web-control/blob/4e0c781669af2f27d959dce80cb4956303375568/src/tr-web-control/script/system.mobile.js#L149-L157
     */
    if (sessionData["download-dir-free-space"]) {
      return sessionData["download-dir-free-space"];
    } else {
      const { data } = await this.request<TransmissionBaseResponse<{ path: string; "size-bytes": number }>>(
        "free-space",
        { path: sessionData["download-dir"] },
      );
      return data.arguments["size-bytes"];
    }
  }

  async addTorrent(url: string, options: Partial<CAddTorrentOptions> = {}): Promise<CAddTorrentResult> {
    const addResult = { success: false } as CAddTorrentResult;

    const addTorrentOptions: Partial<TransmissionAddTorrentOptions> = {
      paused: options.addAtPaused ?? false,
    };

    const clientVersion = await this.getClientVersion();
    let supportLabelAtAdd = parseInt(clientVersion.match(/RPC (\d+)/)?.[1] || "0", 10) >= 17;

    // 处理链接
    if (url.startsWith("magnet:") || !options.localDownload) {
      addTorrentOptions.filename = url;
    } else {
      const torrent = await getRemoteTorrentFile({
        url,
        ...(options.localDownloadOption || {}),
      });

      addTorrentOptions.metainfo = torrent.metadata.base64();
    }

    if (options.savePath) {
      addTorrentOptions["download-dir"] = options.savePath;
    }

    let labels: string[] | undefined = undefined;
    if (options.label) {
      labels = options.label.split(",").map((label) => label.trim());
    }

    if (labels && supportLabelAtAdd) {
      addTorrentOptions.labels = labels;
    }

    try {
      const { data } = await this.request<AddTorrentResponse>("torrent-add", addTorrentOptions);

      /**
       * torrent-add 的 arguments 里只会有 torrent-added 或 torrent-duplicate：
       * 后者表示该种子已在库中，仍是成功语义（rpc-spec: torrent-add 的返回）。
       * 以前只读 torrent-added，遇到重复种子会抛 TypeError，导致历史记录被标记为失败、
       * 且后续的标签/限速设置被整段跳过。
       */
      const addedTorrent = data.arguments?.["torrent-added"] ?? data.arguments?.["torrent-duplicate"];
      const torrentId = addedTorrent?.id;

      // Transmission 3.0 以上才支持label
      if (!supportLabelAtAdd && labels && typeof torrentId !== "undefined") {
        try {
          await this.request("torrent-set", {
            ids: torrentId,
            labels: labels,
          });
        } catch (e) {
          // P1-5：旧版 Transmission 不支持添加时设置 label，这里补设置失败属良性降级（种子已添加），
          // 但记录原因，避免用户以为标签已生效。
          logMessage("[Transmission] 补充设置标签失败（种子已添加）", {
            torrentId,
            labels,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }

      // 设置上传速度限制 - 必须在添加后使用 torrent-set
      if (options.uploadSpeedLimit && options.uploadSpeedLimit > 0 && typeof torrentId !== "undefined") {
        try {
          await this.request("torrent-set", {
            ids: torrentId,
            uploadLimit: options.uploadSpeedLimit * 1024, // KB/s
            uploadLimited: true,
          });
        } catch (e) {
          // P1-5：限速设置失败不应让整个添加动作失败，但必须留下原因
          logMessage("[Transmission] 设置上传限速失败（种子已添加）", {
            torrentId,
            uploadSpeedLimit: options.uploadSpeedLimit,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }

      addResult.success = data.result === "success";
      if (!addResult.success) {
        addResult.message = data;
      }
    } catch (e) {
      // P1-5：把添加失败原因回传给调用方（会写入下载历史），不再静默失败
      addResult.message = e instanceof Error ? e.message : String(e);
      logMessage("[Transmission] 添加种子失败", { url, error: addResult.message }, "error");
    }

    return addResult;
  }

  async getAllTorrents(): Promise<CTorrent[]> {
    return await this.getTorrentsBy({});
  }

  override async getTorrentsBy(filter: TransmissionTorrentFilterRules): Promise<CTorrent[]> {
    const args: TransmissionTorrentGetArguments = {
      fields: this.torrentRequestFields,
    };

    if (filter.ids) {
      args.ids = filter.ids;
    }

    const { data } = await this.request<TransmissionTorrentGetResponse>("torrent-get", args);

    let returnTorrents: CTorrent[] = data.arguments.torrents.map((torrent) => {
      let state = CTorrentState.unknown;
      if (torrent.status === 6) {
        state = CTorrentState.seeding;
      } else if (torrent.status === 4) {
        state = CTorrentState.downloading;
      } else if (torrent.status === 0) {
        state = CTorrentState.paused;
      } else if (torrent.status === 2) {
        state = CTorrentState.checking;
      } else if (torrent.status === 3 || torrent.status === 5) {
        state = CTorrentState.queued;
      }

      return {
        id: torrent.id,
        infoHash: torrent.hashString,
        name: torrent.name,
        progress: torrent.percentDone * 100,
        isCompleted: torrent.leftUntilDone < 1,
        ratio: torrent.uploadRatio,
        dateAdded: torrent.addedDate,
        savePath: torrent.downloadDir,
        label: torrent.labels && torrent.labels.length ? torrent.labels[0] : undefined,
        state: state,
        totalSize: torrent.totalSize,
        uploadSpeed: torrent.rateUpload,
        downloadSpeed: torrent.rateDownload,
        totalUploaded: torrent.uploadedEver,
        totalDownloaded: torrent.downloadedEver,
        raw: torrent,
        clientId: this.config.id,
      } as CTorrent<rawTorrent>;
    });

    if (filter.complete) {
      returnTorrents = returnTorrents.filter((t: CTorrent) => t.isCompleted);
    }

    return returnTorrents;
  }

  async pauseTorrent(id: any): Promise<any> {
    const args: TransmissionTorrentArguments = {
      ids: id,
    };
    await this.request("torrent-stop", args);
    return true;
  }

  async removeTorrent(id: number, removeData: boolean | undefined): Promise<boolean> {
    const args: TransmissionTorrentRemoveArguments = {
      ids: id,
      "delete-local-data": removeData,
    };
    await this.request("torrent-remove", args);
    return true;
  }

  async resumeTorrent(id: any): Promise<boolean> {
    const args: TransmissionTorrentArguments = {
      ids: id,
    };
    await this.request("torrent-start", args);
    return true;
  }

  async getTorrentTrackers(torrent: CTorrent): Promise<string[]> {
    let trackers: rawTorrent["trackers"];
    if (Array.isArray(torrent.raw.trackers)) {
      trackers = torrent.raw.trackers;
    } else {
      const {
        data: { arguments: args },
      } = await this.request<TransmissionTorrentGetResponse>("torrent-get", {
        ids: [torrent.id],
        fields: ["trackers"],
      });
      trackers = args.torrents[0]?.trackers;
    }

    return (trackers ?? []).map((t) => t.announce);
  }

  // 重新校验种子（Transmission RPC: torrent-verify）
  override async recheckTorrent(id: any): Promise<boolean> {
    const args: TransmissionTorrentArguments = {
      ids: id,
    };
    await this.request("torrent-verify", args);
    return true;
  }

  // 调整种子在队列中的位置（Transmission RPC: queue-move-*）
  override async moveTorrentInQueue(id: any, direction: TorrentQueueDirection): Promise<boolean> {
    const methodMap: Record<TorrentQueueDirection, TransmissionRequestMethod> = {
      top: "queue-move-top",
      up: "queue-move-up",
      down: "queue-move-down",
      bottom: "queue-move-bottom",
    };
    const args: TransmissionTorrentArguments = {
      ids: id,
    };
    await this.request(methodMap[direction], args);
    return true;
  }

  // 设置单个种子的速度限制（单位 KiB/s，0 表示不限速；Transmission 使用 KB/s）
  override async setTorrentSpeedLimit(id: any, limits: TorrentSpeedLimit): Promise<boolean> {
    /**
     * torrent-set 只认 camelCase 键名（rpc-spec: uploadLimit/uploadLimited/downloadLimit/downloadLimited）；
     * Transmission 4/5 内部改名为 upload_limit/upload_limited，但兼容层只枚举 camelCase
     * （transmission/libtransmission/api-compat.cc），kebab-case 既不在规范里也不在兼容表里，
     * 会被服务端静默忽略且仍返回 success —— 即「限速没生效但 UI 报成功」。
     */
    const args: TransmissionTorrentArguments & {
      uploadLimit?: number;
      uploadLimited?: boolean;
      downloadLimit?: number;
      downloadLimited?: boolean;
    } = {
      ids: id,
    };

    if (typeof limits.upload !== "undefined") {
      args.uploadLimit = limits.upload;
      args.uploadLimited = limits.upload > 0;
    }

    if (typeof limits.download !== "undefined") {
      args.downloadLimit = limits.download;
      args.downloadLimited = limits.download > 0;
    }

    await this.request("torrent-set", args);
    return true;
  }

  // 设置单个种子的标签
  override async setTorrentLabel(id: any, label: string): Promise<boolean> {
    const args = {
      ids: id,
      labels: [label],
    };
    await this.request("torrent-set", args);
    return true;
  }

  // ─────────────────────────────────────────────
  // 文件级 / peers / tracker 管理（Transmission RPC）
  // ─────────────────────────────────────────────

  private getTorrentId(torrent: string | CTorrent): number | string {
    if (typeof torrent === "string") {
      return torrent;
    }
    return torrent.id;
  }

  // 文件列表: torrent-get files + fileStats
  override async getTorrentFiles(torrent: string | CTorrent): Promise<CTorrentFile[]> {
    const {
      data: { arguments: args },
    } = await this.request<
      TransmissionBaseResponse<{
        torrents: Array<{
          files: Array<{ name: string; length: number; bytesCompleted: number }>;
          fileStats: Array<{ bytesCompleted: number; wanted: boolean; priority: number }>;
        }>;
      }>
    >("torrent-get", {
      ids: [this.getTorrentId(torrent)],
      fields: ["files", "fileStats"],
    });

    const raw = args.torrents[0];
    const files = raw?.files ?? [];
    const fileStats = raw?.fileStats ?? [];

    return files.map((file, index) => {
      const stat = fileStats[index];
      const wanted = stat?.wanted ?? false;
      const priority = stat ? mapTransmissionFilePriority(stat.priority, stat.wanted) : "normal";
      return {
        index,
        name: file.name,
        path: file.name,
        size: file.length,
        progress: file.length > 0 ? ((stat?.bytesCompleted ?? 0) / file.length) * 100 : 0,
        priority,
        wanted,
        raw: { file, stat },
      } as CTorrentFile;
    });
  }

  // 文件优先级/选择: torrent-set files-wanted / files-unwanted / priority-*
  override async setTorrentFilePriority(
    torrent: string | CTorrent,
    selections: CTorrentFileSelection[],
  ): Promise<boolean> {
    if (selections.length === 0) {
      return true;
    }
    const wanted = selections.filter((s) => s.priority !== "skip");
    const unwanted = selections.filter((s) => s.priority === "skip");

    const args: Record<string, any> = { ids: this.getTorrentId(torrent) };
    if (unwanted.length) {
      args["files-unwanted"] = unwanted.map((s) => s.index);
    }
    if (wanted.length) {
      args["files-wanted"] = wanted.map((s) => s.index);

      const low = wanted.filter((s) => s.priority === "low").map((s) => s.index);
      const normal = wanted.filter((s) => s.priority === "normal").map((s) => s.index);
      // Transmission 无 highest，映射为 high
      const high = wanted.filter((s) => s.priority === "high" || s.priority === "highest").map((s) => s.index);
      if (low.length) args["priority-low"] = low;
      if (normal.length) args["priority-normal"] = normal;
      if (high.length) args["priority-high"] = high;
    }

    await this.request("torrent-set", args);
    return true;
  }

  // peer 列表: torrent-get peers
  override async getTorrentPeers(torrent: string | CTorrent): Promise<CTorrentPeer[]> {
    const {
      data: { arguments: args },
    } = await this.request<
      TransmissionBaseResponse<{
        torrents: Array<{
          peers: Array<{
            address: string;
            clientName?: string;
            flagStr?: string;
            isEncrypted?: boolean;
            isIncoming?: boolean;
            isUTP?: boolean;
            port?: number;
            progress?: number; // 0-1
            rateToClient?: number;
            rateToPeer?: number;
          }>;
        }>;
      }>
    >("torrent-get", {
      ids: [this.getTorrentId(torrent)],
      fields: ["peers"],
    });

    const peers = args.torrents[0]?.peers ?? [];

    return peers
      .filter((peer) => !!peer.address)
      .map((peer) => ({
        ip: peer.address,
        port: peer.port,
        client: peer.clientName,
        progress: (peer.progress ?? 0) * 100,
        downloadSpeed: peer.rateToClient ?? 0,
        uploadSpeed: peer.rateToPeer ?? 0,
        incoming: peer.isIncoming,
        encrypted: peer.isEncrypted,
        obfuscated: peer.isUTP,
        flags: peer.flagStr ? peer.flagStr.split("").filter(Boolean) : [],
        raw: peer,
      }));
  }

  // tracker 列表（带状态）: torrent-get trackerStats
  override async getTorrentTrackersDetail(torrent: string | CTorrent): Promise<CTorrentTracker[]> {
    const {
      data: { arguments: args },
    } = await this.request<
      TransmissionBaseResponse<{
        torrents: Array<{
          trackerStats: Array<{
            announce: string;
            announceState: number;
            downloadCount?: number;
            isBackup: boolean;
            lastAnnounceResult?: string;
            lastAnnounceSucceeded: boolean;
            lastAnnounceTime?: number;
            leechers?: number;
            seederCount?: number;
            tier?: number;
          }>;
        }>;
      }>
    >("torrent-get", {
      ids: [this.getTorrentId(torrent)],
      fields: ["trackerStats"],
    });

    const trackers = args.torrents[0]?.trackerStats ?? [];

    return trackers.map((tracker) => ({
      url: tracker.announce,
      tier: tracker.tier ?? 0,
      status: mapTransmissionTrackerState(tracker),
      statusMessage: tracker.lastAnnounceResult,
      seeds: tracker.seederCount,
      leeches: tracker.leechers,
      downloaded: tracker.downloadCount,
      lastAnnounce: tracker.lastAnnounceTime,
      enabled: !tracker.isBackup,
      raw: tracker,
    }));
  }

  // 新增 tracker: torrent-set trackerAdd
  override async addTorrentTracker(torrent: string | CTorrent, url: string): Promise<boolean> {
    await this.request("torrent-set", {
      ids: this.getTorrentId(torrent),
      trackerAdd: [url],
    });
    return true;
  }

  // 删除 tracker: torrent-set trackerRemove（接受 url 或 tracker id 字符串）
  override async removeTorrentTracker(torrent: string | CTorrent, url: string): Promise<boolean> {
    await this.request("torrent-set", {
      ids: this.getTorrentId(torrent),
      trackerRemove: [url],
    });
    return true;
  }

  async request<T>(method: TransmissionRequestMethod, args: any = {}): Promise<AxiosResponse<T>> {
    try {
      return await axios.post<T>(
        this.address,
        {
          method: method,
          arguments: args,
        },
        {
          auth: {
            username: this.config.username,
            password: this.config.password,
          },
          headers: {
            "X-Transmission-Session-Id": this.sessionId,
          },
          timeout: this.config.timeout,
        },
      );
    } catch (error: any) {
      if (isAxiosError(error) && error?.response?.status === 409) {
        this.sessionId = error.response.headers["x-transmission-session-id"]; // lower cased header in axios
        return await this.request<T>(method, args);
      } else {
        throw error;
      }
    }
  }
}
