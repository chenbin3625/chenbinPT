/**
 * @see https://deluge.readthedocs.io/en/latest/reference/webapi.html
 */
import {
  CAddTorrentOptions,
  CustomPathDescription,
  CTorrent,
  DownloaderBaseConfig,
  TorrentClientMetaData,
  CTorrentFilterRules,
  CTorrentState,
  TorrentClientStatus,
  AbstractBittorrentClient,
  CAddTorrentResult,
  TorrentSpeedLimit,
  CTorrentFile,
  CTorrentFileSelection,
  CTorrentPeer,
  CTorrentTracker,
  CTrackerState,
  TorrentFilePriority,
} from "../types";
import urlJoin from "url-join";
import axios from "axios";
import { getRemoteTorrentFile, sanitizeDownloadUrlForLog } from "../utils";
import { logMessage } from "@ptd/site/utils/adapter.ts";

export const clientConfig: DownloaderBaseConfig = {
  type: "Deluge",
  name: "Deluge",
  address: "http://localhost:8112/",
  password: "",
  timeout: 60 * 1e3,
};

// noinspection JSUnusedGlobalSymbols
export const clientMetaData: TorrentClientMetaData = {
  description: "Deluge 是一个通过PyGTK建立图形界面的BitTorrent客户端",
  warning: [
    "仅支持Deluge Web，非Deluge Daemon的直接支持，具体原因请见 issue #207",
    "注意：由于 Deluge 验证机制限制，第一次测试连接成功后，后续测试无论密码正确与否都会提示成功。",
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
      allowed: false,
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
      // Deluge 没有 Highest 档（上游 FILE_PRIORITY 只有 Skip/Low/Normal/High），不声明会让 UI
      // 提供「最高」档并在映射时静默降级成 High（DOWNLOADER-1）
      unsupportedPriorities: ["highest"],
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
  // refs: https://github.com/deluge-torrent/deluge/blob/6ec1479cdbbfed269844041d1001de657594d6da/deluge/core/torrent.py#L121-L148
  advanceAddTorrentOptions: [
    {
      name: "自动管理",
      key: "auto_managed",
      type: "boolean",
      defaultValue: false,
      description: "Set torrent to auto managed mode, i.e. will be started or queued automatically.",
    },
    {
      name: "完成后自动移动",
      key: "move_completed",
      type: "boolean",
      defaultValue: false,
      description: "Move the torrent when downloading has finished.",
    },
    {
      name: "预分配存储",
      key: "pre_allocate_storage",
      type: "boolean",
      defaultValue: false,
      description: "When adding the torrent should all files be pre-allocated.",
    },
    {
      name: "先下载首尾文件块",
      key: "prioritize_first_last_pieces",
      type: "boolean",
      defaultValue: false,
      description: "Prioritize the first and last pieces of the torrent.",
    },
    {
      name: "达到分享率时自动删除",
      key: "remove_at_ratio",
      type: "boolean",
      defaultValue: false,
      description: "Remove torrent when ratio is reached.",
    },
    {
      name: "发种模式",
      key: "seed_mode",
      type: "boolean",
      defaultValue: false,
      description: "Assume that all files are present for this torrent (Only used when adding a torent).",
    },
    {
      name: "顺序下载",
      key: "sequential_download",
      type: "boolean",
      defaultValue: false,
      description: "Download the pieces of the torrent in order.",
    },
    {
      name: "超级做种模式",
      key: "super_seeding",
      type: "boolean",
      defaultValue: false,
      description: "Enable super seeding/initial seeding.",
    },
  ],
};

const DelugeAdvanceAddTorrentOptionsBooleanKey = clientMetaData
  .advanceAddTorrentOptions!.filter((x) => x.type === "boolean")
  .map((x) => x.key) as [
  "auto_managed",
  "move_completed",
  "pre_allocate_storage",
  "prioritize_first_last_pieces",
  "remove_at_ratio",
  "seed_mode",
  "sequential_download",
  "super_seeding",
];
type TDelugeAdvanceAddTorrentOptionsBooleanKey = (typeof DelugeAdvanceAddTorrentOptionsBooleanKey)[number];
type TDelugeAdvanceAddTorrentOptionsKey = TDelugeAdvanceAddTorrentOptionsBooleanKey | string;

type DelugeMethod =
  | "auth.login"
  | "web.update_ui"
  | "web.connected"
  | "web.get_hosts"
  | "web.connect"
  | "core.get_torrents_status"
  | "core.add_torrent_url"
  | "core.add_torrent_magnet"
  | "core.add_torrent_file"
  | "core.get_free_space"
  | "core.get_session_status"
  | "core.remove_torrent"
  | "core.pause_torrent"
  | "core.resume_torrent"
  | "core.force_recheck"
  | "core.set_torrent_options"
  | "core.set_torrent_file_priorities"
  | "core.set_torrent_trackers"
  | "daemon.info"
  | "core.get_libtorrent_version"
  | "label.set_torrent";

/**
 * deluge-web 的错误体：develop（2.x）为 `{ message, code }`，部分旧版本/插件直接给字符串。
 * code 1 = Not authenticated（见 deluge/ui/web/json_api.py 的 NotAuthorizedError 分支）。
 */
type DelugeError = string | { message?: unknown; code?: number };

interface DelugeDefaultResponse<T = any> {
  /**
   * mostly usless id that increments with every request
   */
  id: number;
  error: null | DelugeError;
  result: T;
}

/** 归一化 deluge-web 的 error 字段，并标出「会话失效」这一可重登重试的情形 */
function normalizeDelugeError(error: DelugeError): { message: string; notAuthenticated: boolean } {
  if (typeof error === "string") {
    return { message: error, notAuthenticated: /not authenticated/i.test(error) };
  }

  const message = error?.message == null ? "Unknown error" : String(error.message);
  return { message, notAuthenticated: error?.code === 1 || /not authenticated/i.test(message) };
}

/**
 * Deluge 文件优先级：数值来自上游 deluge-web 的 FILE_PRIORITY（DOWNLOADER-1）
 *
 * deluge/ui/web/js/deluge-all/Deluge.js：
 *   {0:'Skip',1:'Low',2:'Low',3:'Low',4:'Normal',5:'High',6:'High',7:'High'}，
 *   反查为 {Skip:0,Low:1,Normal:4,High:7}，且 deluge/core/torrent.py 允许 [0..7]。
 * 旧实现在这里把 1 当 Normal、2 当 High、5 当 Highest，导致下发与回读整体错位。
 */
function mapDelugeFilePriority(priority: number): TorrentFilePriority {
  switch (priority) {
    case 0:
      return "skip";
    case 1:
    case 2:
    case 3:
      return "low";
    case 5:
    case 6:
    case 7:
      return "high";
    case 4:
    default:
      return "normal";
  }
}

function mapTorrentFilePriorityToDeluge(priority: TorrentFilePriority): number {
  switch (priority) {
    case "skip":
      return 0;
    case "low":
      return 1;
    case "normal":
      return 4;
    case "high":
    // Deluge 无 Highest 档；UI 已通过 unsupportedPriorities 隐藏该档，这里按 High 兜底（DOWNLOADER-1）
    case "highest":
      return 7;
    default:
      return 4;
  }
}

// Deluge tracker_status 为自由文本，按关键词归一化
function mapDelugeTrackerState(status: string | undefined): { state: CTrackerState; message?: string } {
  const text = status ?? "";
  const lower = text.toLowerCase();
  if (lower.includes("error")) {
    return { state: CTrackerState.error, message: status };
  }
  if (lower.includes("updating")) {
    return { state: CTrackerState.updating, message: status };
  }
  if (lower.includes("disabled")) {
    return { state: CTrackerState.disabled, message: status };
  }
  if (text.length === 0) {
    return { state: CTrackerState.unknown };
  }
  return { state: CTrackerState.working, message: status };
}

type DelugeTorrentField =
  | "comment"
  | "active_time"
  | "is_seed"
  | "hash"
  | "upload_payload_rate"
  | "move_completed_path"
  | "private"
  | "total_payload_upload"
  | "paused"
  | "seed_rank"
  | "seeding_time"
  | "max_upload_slots"
  | "prioritize_first_last"
  | "distributed_copies"
  | "download_payload_rate"
  | "message"
  | "num_peers"
  | "max_download_speed"
  | "max_connections"
  | "compact"
  | "ratio"
  | "total_peers"
  | "total_size"
  | "total_wanted"
  | "state"
  | "file_priorities"
  | "max_upload_speed"
  | "remove_at_ratio"
  | "tracker"
  | "save_path"
  | "progress"
  | "time_added"
  | "tracker_host"
  | "total_uploaded"
  | "files"
  | "total_done"
  | "num_pieces"
  | "tracker_status"
  | "total_seeds"
  | "move_on_completed"
  | "next_announce"
  | "stop_at_ratio"
  | "file_progress"
  | "move_completed"
  | "piece_length"
  | "all_time_download"
  | "move_on_completed_path"
  | "num_seeds"
  | "peers"
  | "name"
  | "trackers"
  | "total_payload_download"
  | "is_auto_managed"
  | "seeds_peers_ratio"
  | "queue"
  | "num_files"
  | "eta"
  | "stop_ratio"
  | "is_finished"
  | "label"; // if they don't have the label plugin it shouldn't fail

interface DelugeRawTorrent {
  hash: string;
  name: string;
  progress: number;
  ratio: number;
  time_added: number;
  save_path: string;
  label?: string;
  state: "Downloading" | "Seeding" | "Active" | "Paused" | "Queued" | "Checking" | "Error";
  total_size: number;
  upload_payload_rate: number;
  download_payload_rate: number;
  total_uploaded: number;
  total_done: number;
  private?: boolean;
  trackers?: Array<{ url: string; tier: number }>;
}

interface DelugeTorrentFilterRules extends CTorrentFilterRules {
  hash?: string;
  state?: string;
}

/**
 * core.add_torrent_url / core.add_torrent_file 返回新种子的 hash 字符串（失败时为 null），
 * 但部分 Deluge 版本会包一层数组（`[hash]` 或 `[[torrent_id, hash]]`），这里统一取出 hash。
 */
function extractAddedTorrentHash(result: any): string | undefined {
  if (typeof result === "string") {
    return result;
  }

  if (!Array.isArray(result) || result.length === 0) {
    return undefined;
  }

  const first = result[0];
  if (typeof first === "string") {
    return first;
  }

  if (Array.isArray(first) && typeof first[1] === "string") {
    return first[1];
  }

  return undefined;
}

// noinspection JSUnusedGlobalSymbols
export default class Deluge extends AbstractBittorrentClient {
  readonly version = "v0.1.0";

  /**
   * deluge-web 的认证依赖登录后下发的 `_session_id` Cookie（见 deluge/ui/web/auth.py），
   * 必须复用同一个开启 withCredentials 的 axios 实例，否则登录成功后 Cookie 不会留存，
   * 每个请求都会得到 `{ error: { code: 1, message: "Not authenticated" } }`。
   * 扩展已声明全量 host permission，跨域携带 Cookie 不受 SameSite 限制。
   */
  private readonly sessionedAxios = axios.create({ withCredentials: true });

  private readonly address: string;
  private _msgId: number;
  private isLogin = false;
  /** 登录单飞去重（PKG-1）：并发首请求共享同一次 auth.login */
  private loginPromise: Promise<boolean> | null = null;

  private torrentRequestField: DelugeTorrentField[] = [
    "hash",
    "name",
    "progress",
    "ratio",
    "time_added",
    "save_path",
    "label",
    "state",
    "total_size",
    "private",
    "trackers",
    // DE-3：映射读取了这些字段就必须真正请求它们，否则 Deluge 只返回请求过的 key，
    // 列表里的速度/流量列会恒为 undefined。
    "upload_payload_rate",
    "download_payload_rate",
    "total_uploaded",
    "total_done",
  ];

  constructor(options: Partial<DownloaderBaseConfig>) {
    super({ ...clientConfig, ...options });
    this._msgId = 0;

    // 修正服务器地址（复检 RB：非法 URL 不能抛 TypeError 让实例构造失败；解析失败按「无路径」处理）
    let address = this.config.address;
    let pathname = "";
    try {
      pathname = new URL(address).pathname.toLowerCase();
    } catch {
      pathname = "";
    }
    if (!pathname.includes("json")) {
      address = urlJoin(address, "/json");
    }
    this.address = address;
  }

  async ping(): Promise<boolean> {
    try {
      if (!(await this.login())) {
        return false;
      }
      // DE-4：登录成功不代表 deluge-web 已连接到 deluged；测试连接必须反映真实可用性
      return await this.ensureWebConnected();
    } catch (e) {
      return false;
    }
  }

  protected async getClientVersionFromRemote(): Promise<string> {
    const version = await this.request<string>("daemon.info");
    const ltVersion = await this.request<string>("core.get_libtorrent_version");
    return `${version} (lt ${ltVersion})`;
  }

  override async getClientStatus(): Promise<TorrentClientStatus> {
    const statusKeys = ["download_rate", "upload_rate", "total_download", "total_upload"] as const;
    const statusData = await this.request<Record<(typeof statusKeys)[number], number>>("core.get_session_status", [
      statusKeys,
    ]);

    return {
      upSpeed: statusData.upload_rate,
      dlSpeed: statusData.download_rate,
      upData: statusData.total_upload,
      dlData: statusData.total_download,
    };
  }

  override async getClientFreeSpace(): Promise<number> {
    return await this.request<number>("core.get_free_space");
  }

  async addTorrent(url: string, options: Partial<CAddTorrentOptions> = {}): Promise<CAddTorrentResult> {
    const addResult = { success: false } as CAddTorrentResult;

    try {
      const delugeOptions: any = {
        add_paused: options.addAtPaused ?? false,
      };
      const advanceAddTorrentOptions = (options.advanceAddTorrentOptions ?? {}) as Record<
        TDelugeAdvanceAddTorrentOptionsKey,
        any
      >;

      if (options.savePath) {
        delugeOptions.download_location = options.savePath;
      }

      if (options.uploadSpeedLimit && options.uploadSpeedLimit > 0) {
        // Upload speed limit in KB/s for Deluge
        delugeOptions.max_upload_speed = options.uploadSpeedLimit * 1024;
      }

      // 处理高级选项（Boolean类型）
      for (const key of DelugeAdvanceAddTorrentOptionsBooleanKey) {
        if (advanceAddTorrentOptions[key] === true) {
          delugeOptions[key] = advanceAddTorrentOptions[key];
        }
      }

      // 由于Deluge添加链接和种子的方法名不一样，分开处理
      let method: "core.add_torrent_file" | "core.add_torrent_url" | "core.add_torrent_magnet";
      let params: any;
      if (url.startsWith("magnet:")) {
        // DE-2：磁链必须用 core.add_torrent_magnet。
        // 上游 deluge/core/core.py 的 add_torrent_url() 会把参数当 HTTP 地址去 download_file()，
        // 收到 magnet: 会直接抛异常，导致推送磁链必然失败。
        method = "core.add_torrent_magnet";
        params = [url, delugeOptions];
      } else if (!options.localDownload) {
        // 链接 add_torrent_url（http/https .torrent 直链）
        method = "core.add_torrent_url";
        params = [url, delugeOptions];
      } else {
        // 文件 add_torrent_file
        method = "core.add_torrent_file";

        const torrent = await getRemoteTorrentFile({
          url,
          ...(options.localDownloadOption || {}),
        });

        params = ["", torrent.metadata.base64(), delugeOptions];
      }

      const result = await this.request<any>(method, params);
      if (result !== null && options.label) {
        try {
          const torrentHash = extractAddedTorrentHash(result);
          if (!torrentHash) {
            throw new Error("Deluge 未返回新种子的 hash，无法设置标签");
          }
          await this.request("label.set_torrent", [torrentHash, options.label]);
        } catch (e) {
          // P1-5：Deluge 可能未启用 Label 插件，设置标签失败属预期内降级（种子已添加），
          // 但记录原因，避免用户以为标签已生效。
          logMessage("[Deluge] 设置标签失败（种子已添加）", {
            label: options.label,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }

      addResult.success = result !== null;

      if (!addResult.success) {
        addResult.message = result;
      } else {
        this.invalidateSuggestListCache();
      }
    } catch (e) {
      // P1-5：把添加失败原因回传给调用方（会写入下载历史），不再静默失败。
      // SEC-1：日志里的 URL 必须脱敏（PT 站下载链接通常带 passkey）。
      addResult.message = e instanceof Error ? e.message : String(e);
      logMessage("[Deluge] 添加种子失败", { url: sanitizeDownloadUrlForLog(url), error: addResult.message }, "error");
    }

    return addResult;
  }

  async getAllTorrents(): Promise<CTorrent<DelugeRawTorrent>[]> {
    return await this.getTorrentsBy({});
  }

  override async getTorrentsBy(filter: DelugeTorrentFilterRules): Promise<CTorrent<DelugeRawTorrent>[]> {
    // N-4：不要改写调用方传入的 filter 对象（以前直接 delete/filter.ids = ...），
    // 否则调用方复用同一个对象时会把上一次的 hash/state 残留带进来。
    const rpcFilter: Record<string, any> = {};
    if (filter.ids) {
      rpcFilter.hash = filter.ids;
    }
    // DE-6：不再把 complete 翻译成 state="Seeding"（会漏掉「已完成但暂停」的种子）；
    // 改成拉全量后按 progress 本地筛选。
    const wantCompleteOnly = filter.complete === true;

    const torrents = await this.request<Record<string, DelugeRawTorrent>>("core.get_torrents_status", [
      rpcFilter,
      this.torrentRequestField,
    ]);

    let returnTorrents = Object.values(torrents).map((torrent) => {
      // normalize state to enum；DE-6：Allocating/Moving 也映射掉，不再落 unknown
      let state = CTorrentState.unknown;
      switch (String(torrent.state)) {
        case "Allocating":
          state = CTorrentState.queued;
          break;
        case "Moving":
          state = CTorrentState.checking;
          break;
        default:
          if (Object.keys(CTorrentState).includes(torrent.state.toLowerCase())) {
            state = CTorrentState[torrent.state.toLowerCase() as keyof typeof CTorrentState];
          }
          break;
      }

      return {
        id: torrent.hash,
        infoHash: torrent.hash,
        isCompleted: torrent.progress >= 100,
        dateAdded: torrent.time_added,
        name: torrent.name,
        progress: torrent.progress,
        ratio: torrent.ratio,
        savePath: torrent.save_path,
        state,
        totalSize: torrent.total_size,
        uploadSpeed: torrent.upload_payload_rate,
        downloadSpeed: torrent.download_payload_rate,
        totalUploaded: torrent.total_uploaded,
        totalDownloaded: torrent.total_done,
        isPrivate: torrent.private,
        trackerUrls: (torrent.trackers ?? []).map((tracker) => tracker.url).filter(Boolean),
        raw: torrent,
        clientId: this.config.id,
      } as CTorrent<DelugeRawTorrent>;
    });

    if (wantCompleteOnly) {
      returnTorrents = returnTorrents.filter((torrent) => torrent.isCompleted);
    }

    return returnTorrents;
  }

  async pauseTorrent(id: any): Promise<boolean> {
    try {
      // DE-1：Deluge 的 pause_torrent 没有返回值（上游 core.py 返回 None → JSON null），
      // 不能把 result 当布尔返回；request 未抛错即视为成功。
      await this.request("core.pause_torrent", [id]);
      return true;
    } catch (e) {
      return false;
    }
  }

  async removeTorrent(id: string, removeData = false): Promise<boolean> {
    try {
      // core.remove_torrent 是少数有返回值（bool）的 RPC，保留真实结果
      const result = await this.request<boolean>("core.remove_torrent", [id, removeData]);
      this.invalidateSuggestListCache();
      return result !== false;
    } catch (e) {
      return false;
    }
  }

  async resumeTorrent(id: any): Promise<boolean> {
    try {
      // DE-1：resume_torrent 同样无返回值
      await this.request("core.resume_torrent", [id]);
      return true;
    } catch (e) {
      return false;
    }
  }

  async getTorrentTrackers(torrent: CTorrent): Promise<string[]> {
    let rawTrackers: Array<{ url: string; tier: number }>;
    if (typeof torrent === "object" && Array.isArray(torrent.raw?.trackers)) {
      rawTrackers = torrent.raw.trackers;
    } else {
      const hash = torrent.infoHash || (torrent.id as string);
      const result = await this.request<Record<string, Required<DelugeRawTorrent>>>("core.get_torrents_status", [
        { hash },
        ["trackers"],
      ]);

      const torrentData = Object.values(result)[0];
      rawTrackers = torrentData?.trackers;
    }

    if (!rawTrackers) return [];

    return rawTrackers.map((t) => t.url);
  }

  // 重新校验种子
  override async recheckTorrent(id: any): Promise<boolean> {
    try {
      // N-1：上游 core.force_recheck(torrent_ids: List[str]) 会遍历参数，
      // 传单字符串会把 hash 逐字符当成 torrent id → KeyError。这里必须传数组。
      // DE-1：force_recheck 无返回值，request 未抛错即成功。
      await this.request("core.force_recheck", [[id]]);
      return true;
    } catch (e) {
      return false;
    }
  }

  // 设置单个种子的速度限制（单位 KiB/s，0 表示不限速；Deluge 使用 KiB/s，-1 表示不限速）
  override async setTorrentSpeedLimit(id: any, limits: TorrentSpeedLimit): Promise<boolean> {
    try {
      const options: Record<string, number> = {};
      if (typeof limits.download !== "undefined") {
        options.max_download_speed = limits.download > 0 ? limits.download : -1;
      }
      if (typeof limits.upload !== "undefined") {
        options.max_upload_speed = limits.upload > 0 ? limits.upload : -1;
      }
      // DE-1：set_torrent_options 无返回值
      await this.request("core.set_torrent_options", [id, options]);
      return true;
    } catch (e) {
      return false;
    }
  }

  // 设置单个种子的标签
  override async setTorrentLabel(id: any, label: string): Promise<boolean> {
    try {
      // DE-1：Label 插件的 set_torrent 无返回值（deluge_label/core.py 末尾无 return）
      await this.request("label.set_torrent", [id, label]);
      this.invalidateSuggestListCache();
      return true;
    } catch (e) {
      return false;
    }
  }

  // ─────────────────────────────────────────────
  // 文件级 / peers / tracker 管理（Deluge WebAPI）
  // ─────────────────────────────────────────────

  private getTorrentHash(torrent: string | CTorrent): string {
    if (typeof torrent === "string") {
      return torrent;
    }
    return (torrent.infoHash || (torrent.id as string)) as string;
  }

  // 文件列表: core.get_torrents_status fields files/file_progress/file_priorities
  override async getTorrentFiles(torrent: string | CTorrent): Promise<CTorrentFile[]> {
    const hash = this.getTorrentHash(torrent);
    const result = await this.request<Record<string, any>>("core.get_torrents_status", [
      { hash },
      ["files", "file_progress", "file_priorities"],
    ]);
    const torrentData: any = Object.values(result)[0];
    const files: Array<{ index: number; path: string; size: number }> = torrentData?.files ?? [];
    const fileProgress: number[] = torrentData?.file_progress ?? [];
    const filePriorities: number[] = torrentData?.file_priorities ?? [];

    return files.map((file, index) => {
      // 优先级缺失时按 Normal(4) 兜底：旧实现用 1，在新映射里 1 已被上游定义为 Low（DOWNLOADER-1）
      const priority = mapDelugeFilePriority(filePriorities[index] ?? 4);
      return {
        index: file.index ?? index,
        name: file.path.split(/[/\\]/).pop() || file.path,
        path: file.path,
        size: file.size,
        progress: (fileProgress[index] ?? 0) * 100,
        priority,
        wanted: priority !== "skip",
        raw: { file, progress: fileProgress[index], priority: filePriorities[index] },
      };
    });
  }

  // 文件优先级/选择: core.set_torrent_file_priorities（全量数组，先读后改）
  override async setTorrentFilePriority(
    torrent: string | CTorrent,
    selections: CTorrentFileSelection[],
  ): Promise<boolean> {
    if (selections.length === 0) {
      return true;
    }
    const hash = this.getTorrentHash(torrent);

    const result = await this.request<Record<string, { file_priorities?: number[] }>>("core.get_torrents_status", [
      { hash },
      ["file_priorities"],
    ]);
    const priorities = (Object.values(result)[0]?.file_priorities ?? []).slice();

    for (const selection of selections) {
      if (selection.index >= 0 && selection.index < priorities.length) {
        priorities[selection.index] = mapTorrentFilePriorityToDeluge(selection.priority);
      }
    }

    try {
      await this.request<boolean>("core.set_torrent_file_priorities", [hash, priorities]);
      return true;
    } catch (e) {
      return false;
    }
  }

  // peer 列表: core.get_torrents_status fields peers
  override async getTorrentPeers(torrent: string | CTorrent): Promise<CTorrentPeer[]> {
    const hash = this.getTorrentHash(torrent);
    const result = await this.request<Record<string, any>>("core.get_torrents_status", [{ hash }, ["peers"]]);
    const peers: Array<{
      client?: string;
      country?: string;
      down_speed?: number;
      encrypted?: boolean;
      ip?: string;
      port?: number;
      progress?: number; // 0-1
      seed?: boolean;
      up_speed?: number;
    }> = Object.values(result)[0]?.peers ?? [];

    return peers
      .filter((peer) => !!peer.ip)
      .map((peer) => ({
        ip: peer.ip!,
        port: peer.port,
        client: peer.client,
        progress: (peer.progress ?? 0) * 100,
        downloadSpeed: peer.down_speed ?? 0,
        uploadSpeed: peer.up_speed ?? 0,
        encrypted: peer.encrypted,
        preferred: peer.seed,
        country: peer.country,
        raw: peer,
      }));
  }

  // tracker 列表（带状态）: core.get_torrents_status fields trackers/tracker_status/tracker_host
  override async getTorrentTrackersDetail(torrent: string | CTorrent): Promise<CTorrentTracker[]> {
    const hash = this.getTorrentHash(torrent);
    const result = await this.request<Record<string, any>>("core.get_torrents_status", [
      { hash },
      ["trackers", "tracker_status", "tracker_host"],
    ]);
    const torrentData: any = Object.values(result)[0];
    const trackers: Array<{ url: string; tier: number }> = torrentData?.trackers ?? [];
    const trackerStatus: string | undefined = torrentData?.tracker_status;
    const trackerHost: string | undefined = torrentData?.tracker_host;

    /**
     * DE-5：`tracker_status` 只描述「当前 tracker」（tracker_host）的一条文本；
     * 以前给所有 tracker 都套同一状态，3 个 tracker 的种子会全部显示 error/working。
     * 这里只对 host 匹配的 tracker 套状态，其余为 unknown；host 信息缺失时退化到第一个（保持旧行为可用）。
     */
    const matchIndexes = trackers
      .map((tracker, index) => {
        if (!trackerHost) {
          return -1;
        }
        try {
          const urlHost = new URL(tracker.url).hostname.toLowerCase();
          const host = trackerHost.toLowerCase().split(":")[0];
          return urlHost === host || urlHost.endsWith(`.${host}`) ? index : -1;
        } catch {
          return -1;
        }
      })
      .filter((index) => index >= 0);
    const statusIndexes = matchIndexes.length > 0 ? matchIndexes : [0];

    return trackers.map((tracker, index) => {
      const applies = statusIndexes.includes(index);
      const { state, message } = applies
        ? mapDelugeTrackerState(trackerStatus)
        : { state: CTrackerState.unknown, message: undefined };
      return {
        url: tracker.url,
        tier: tracker.tier ?? 0,
        status: state,
        statusMessage: message,
        enabled: state !== CTrackerState.disabled,
        raw: tracker,
      };
    });
  }

  // 新增 tracker: core.set_torrent_trackers（全量替换，先读后加）
  override async addTorrentTracker(torrent: string | CTorrent, url: string): Promise<boolean> {
    try {
      const hash = this.getTorrentHash(torrent);
      const current = await this.getTorrentTrackersDetail(hash);
      if (current.some((t) => t.url === url)) {
        return true;
      }

      const nextTier = current.length ? Math.max(...current.map((t) => t.tier)) + 1 : 0;
      await this.request("core.set_torrent_trackers", [
        hash,
        [...current.map((t) => ({ url: t.url, tier: t.tier })), { url, tier: nextTier }],
      ]);
      return true;
    } catch (e) {
      return false;
    }
  }

  // 删除 tracker: core.set_torrent_trackers（全量替换，先读后删）
  override async removeTorrentTracker(torrent: string | CTorrent, url: string): Promise<boolean> {
    try {
      const hash = this.getTorrentHash(torrent);
      const current = await this.getTorrentTrackersDetail(hash);
      const rest = current.filter((t) => t.url !== url);
      if (rest.length === current.length) {
        return true;
      }

      await this.request("core.set_torrent_trackers", [hash, rest.map((t) => ({ url: t.url, tier: t.tier }))]);
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * 登录单飞（PKG-1）：并发首请求共享同一次 auth.login。
   * `force` 用于会话失效后的强制重登。
   */
  private async ensureLogin(force = false): Promise<boolean> {
    if (!force && this.isLogin) {
      return true;
    }
    if (!this.loginPromise) {
      this.loginPromise = this.login().finally(() => {
        this.loginPromise = null;
      });
    }
    return await this.loginPromise;
  }

  private async login(): Promise<boolean> {
    try {
      /**
       * P1-8（复检）：登录请求自身必须 `skipAuthRetry=true`。
       *
       * `request()` 在响应被判 notAuthenticated（code 1）时会走「清登录态 → `ensureLogin(true)` → 重试」；
       * 而 login() 内部又是通过 `request()` 发 `auth.login`。若 deluge-web 被反向代理/魔改后**对 auth.login
       * 本身也回 code 1**，就会出现：login() → request(auth.login) → ensureLogin(true) → 复用
       * `this.loginPromise`（正等待 login() 完成）→ 自死锁，且实例生命周期内所有请求都 join 这个永不
       * resolve 的 promise（"砖化"）。传 skipAuthRetry 后登录失败直接抛错 → 返回 false，不会挂起。
       */
      this.isLogin = await this.request<boolean>("auth.login", [this.config.password], true);
      return this.isLogin;
    } catch (e) {
      this.isLogin = false;
      return false;
    }
  }

  /**
   * DE-4：deluge-web 是代理，auth.login 成功只代表 Web 认证通过。
   * 若 Web 未连接到 deluged（daemon 重启后未自动重连等），core.* 调用会以 "Unknown method" 失败，
   * 而「测试连接」却仍显示成功。ping 时显式检查并尝试建立连接。
   */
  private async ensureWebConnected(): Promise<boolean> {
    try {
      if (await this.request<boolean>("web.connected")) {
        return true;
      }
      const hosts = await this.request<any[][]>("web.get_hosts");
      const hostId = hosts?.[0]?.[0];
      if (hostId == null) {
        return false;
      }
      await this.request("web.connect", [hostId]);
      return await this.request<boolean>("web.connected");
    } catch (e) {
      return false;
    }
  }

  private async request<T>(method: DelugeMethod, params: any[] = [], skipAuthRetry = false): Promise<T> {
    // 防止循环调用：请求前若未登录（或已被判定为会话失效）先登录
    if (!this.isLogin && method !== "auth.login") {
      if (!(await this.ensureLogin())) {
        throw new Error("Deluge: 登录失败（密码错误，或 deluge-web 未连接到 daemon）");
      }
    }

    const response = await this.sessionedAxios.post<DelugeDefaultResponse<T>>(
      this.address,
      {
        id: this._msgId++,
        method: method,
        params: params,
      },
      {
        responseType: "json",
        timeout: this.config.timeout,
      },
    );

    const error = response.data?.error;

    /**
     * deluge-web 用 HTTP 200 + 响应体里的 `error` 报错，只看 `result` 会把失败当成成功
     * （`result` 为 null 时，调用方 `Object.values(null)` 直接 TypeError、
     * removeTorrent/pauseTorrent 返回 null 被当作成功），用户也看不到 "Not authenticated"。
     */
    if (error) {
      const { message, notAuthenticated } = normalizeDelugeError(error);

      // 会话 Cookie 失效（code 1 / Not authenticated）：重登一次再重试
      if (notAuthenticated && !skipAuthRetry) {
        this.isLogin = false;
        if (await this.ensureLogin(true)) {
          return await this.request<T>(method, params, true);
        }
      }

      throw new Error(`Deluge: ${message}`);
    }

    return response.data.result;
  }
}
