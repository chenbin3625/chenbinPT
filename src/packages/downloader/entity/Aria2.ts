/**
 * 使用 ws + rpc-secret 形式访问，
 * 原因在于如果发送metadata的话，使用 http 会空返回，
 * 但是允许用户填入 http:// 开头的地址
 */
import {
  CAddTorrentOptions,
  CustomPathDescription,
  CTorrent,
  DownloaderBaseConfig,
  TorrentClientMetaData,
  CTorrentState,
  TorrentClientStatus,
  AbstractBittorrentClient,
  CAddTorrentResult,
  TorrentQueueDirection,
  TorrentSpeedLimit,
  CTorrentFile,
  TorrentFilePriority,
} from "../types";
import { getRemoteTorrentFile } from "../utils";
import { logMessage } from "@ptd/site/utils/adapter.ts";
import urlJoin from "url-join";

export const clientConfig: DownloaderBaseConfig = {
  type: "Aria2",
  name: "Aria2",
  address: "http://localhost:6800/jsonrpc",
  password: "",
  timeout: 60 * 1e3,
};

export const clientMetaData: TorrentClientMetaData = {
  description: "Aria2是一款自由、跨平台命令行界面的下载管理器",
  warning: ["使用 WebSocket + `rpc-secret` 形式连接，请设置好 `rpc-secret` 配置项", "不支持使用用户名+密码的认证方式"],
  feature: {
    CustomPath: {
      allowed: true,
      description: CustomPathDescription,
    },
    DefaultAutoStart: {
      allowed: true,
    },
    Recheck: {
      allowed: false,
    },
    Queue: {
      allowed: true,
    },
    SpeedLimit: {
      allowed: true,
    },
    Label: {
      allowed: false,
    },
    BypassCSRF: {
      allowed: false,
    },
    // aria2 仅支持只读文件列表（无优先级/选择能力）
    FileList: {
      allowed: true,
    },
    FilePriority: {
      allowed: false,
    },
    PeerList: {
      allowed: false,
    },
    TrackerList: {
      allowed: false,
    },
    TrackerManage: {
      allowed: false,
    },
  },
};

type METHODS =
  | "aria2.addUri"
  | "aria2.addTorrent"
  | "aria2.getPeers"
  | "aria2.addMetalink"
  | "aria2.remove"
  | "aria2.pause"
  | "aria2.forcePause"
  | "aria2.pauseAll"
  | "aria2.forcePauseAll"
  | "aria2.unpause"
  | "aria2.unpauseAll"
  | "aria2.forceRemove"
  | "aria2.changePosition"
  | "aria2.tellStatus"
  | "aria2.getUris"
  | "aria2.getFiles"
  | "aria2.getServers"
  | "aria2.tellActive"
  | "aria2.tellWaiting"
  | "aria2.tellStopped"
  | "aria2.getOption"
  | "aria2.changeUri"
  | "aria2.changeOption"
  | "aria2.getGlobalOption"
  | "aria2.changeGlobalOption"
  | "aria2.purgeDownloadResult"
  | "aria2.removeDownloadResult"
  | "aria2.getVersion"
  | "aria2.getSessionInfo"
  | "aria2.shutdown"
  | "aria2.forceShutdown"
  | "aria2.getGlobalStat"
  | "aria2.saveSession"
  | "system.multicall"
  | "system.listMethods"
  | "system.listNotifications";

type multiCallParams = {
  methodName: METHODS;
  params: any[];
}[];

interface jsonRPCResponse<Data> {
  id: string;
  jsonrpc: "2.0";
  result: Data;
  error?: { code: number; message: string };
}

interface rawTask {
  bitfield: string;
  completedLength: number;
  connections: `${1 | 0}`;
  dir: string;
  downloadSpeed: number;
  files: {
    completedLength: number;
    index: number;
    length: number;
    path: string;
    selected: string;
    uris: {
      status: string;
      url: string;
    }[];
  }[];
  gid: string;
  numPieces: number;
  pieceLength: number;
  status:
    | "active" // active for currently downloading/seeding downloads.
    | "waiting" // waiting for downloads in the queue; download is not started.
    | "paused" // paused for paused downloads.
    | "error" // error for downloads that were stopped because of error.
    | "complete" // complete for stopped and completed downloads.
    | "removed"; // removed for the downloads removed by user.
  totalLength: number;
  uploadLength: number;
  uploadSpeed: number;

  // If it is a bittorrent
  bittorrent?: {
    announceList: string[][];
    comment: string;
    creationDate: number;
    info: {
      name: string;
    };
    mode: "single" | "multi";
  };
  infoHash?: string;
  seeder?: string;
  numSeeders?: number;
}

/** 默认的 WS 请求超时（可在下载器配置中通过 timeout 覆盖） */
const DEFAULT_METHOD_TIMEOUT = 30e3;

/**
 * `WebSocket.readyState` 的规范取值。
 * 这里用字面量而不是全局 `WebSocket.OPEN`：一是与规范一一对应更直观，
 * 二是测试替身不必再复刻这些常量。
 * （CONNECTING = 0 无需单独判断：只要不是 OPEN，就统一走「等 open / 重建」逻辑。）
 */
const WS_OPEN = 1;
const WS_CLOSING = 2;
const WS_CLOSED = 3;

interface IPendingRequest<T> {
  resolve: (value: jsonRPCResponse<T>) => void;
  reject: (reason?: any) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * 解包 system.multicall 中单项的返回值。
 *
 * aria2 对 multicall 的返回约定随传输层而不同（见 aria2 手册 system.multicall）：
 * - JSON-RPC：项可能被包成 `{ result: ... }`，也可能是裸返回值；
 * - XML-RPC 风格：项是只含一个元素的数组 `[result]`；
 * - 单项调用失败时该项是 fault 结构（`{ faultCode, faultString }`）或 null。
 *
 * 这里统一归一化为「结果本身」；无法识别（fault / 空值）时返回 undefined，由调用方兜底。
 */
function unwrapMultiCallResult<T>(item: unknown): T | undefined {
  let current: unknown = item;

  // 最多剥离 4 层包装（{ result } / XML-RPC 的单元素数组），防止异常数据造成死循环
  for (let depth = 0; depth < 4; depth++) {
    if (current === null || current === undefined) {
      return undefined;
    }

    if (Array.isArray(current)) {
      // XML-RPC 约定：项是只含一个元素的数组 [result]；裸数组结果（JSON-RPC）原样返回
      if (current.length === 1 && Array.isArray(current[0])) {
        current = current[0];
        continue;
      }
      return current as T;
    }

    if (typeof current === "object" && "result" in current) {
      current = (current as { result?: unknown }).result;
      continue;
    }

    return undefined; // fault 结构等无法识别的项
  }

  return undefined;
}

/** 从 system.multicall 的单项中取出任务数组（fault / 空值 / 非任务数组一律视为空列表） */
function unwrapMultiCallTasks(item: unknown): rawTask[] {
  const result = unwrapMultiCallResult<unknown>(item);
  return Array.isArray(result) ? (result as rawTask[]) : [];
}

export default class Aria2 extends AbstractBittorrentClient {
  readonly version = "v0.1.0";

  private _wsClient: WebSocket | null = null;
  /** 已规范化的 ws 地址（http→ws / https→wss），连接关闭后据此重建 */
  private readonly _wsUrl: string;
  /** 当前连接「已 OPEN」的 promise；连接关闭/建连失败时置空，下次发送时重建 */
  private _wsReady: Promise<WebSocket> | null = null;
  private _msgId = 0;

  /**
   * 以 msgId 为索引的待响应请求表。
   *
   * 历史上每次 `methodSend()` 都会 `addEventListener("message")` 且从不移除，监听器数量随
   * 调用次数线性增长；并且任何携带 error 的响应都会 reject 当时正在等待的请求（即使 id 不匹配）。
   * 现在统一由一个单例监听器按 msgId 派发，且每个请求都有超时。
   */
  private _pendingRequests = new Map<string, IPendingRequest<any>>();
  /** 实例是否已经被 dispose，dispose 后不再接受新的请求 */
  private _disposed = false;

  get msgId() {
    return this._msgId++;
  }

  constructor(options: Partial<DownloaderBaseConfig>) {
    super({ ...clientConfig, ...options });

    // 修正服务器地址
    let address = this.config.address;
    if (address.indexOf("jsonrpc") === -1) {
      address = urlJoin(address, "/jsonrpc");
    }
    this.config.address = address;

    // https -> wss , http -> ws
    this._wsUrl = address.replace(/^http/, "ws");

    // 与历史行为一致：构造时即建立连接，但「连接已 OPEN」的 promise 会一直保留，
    // 由 send 前统一等待（连接关闭后由 `_getOpenWsClient()` 负责重建）
    this._wsReady = this._connect();
  }

  /**
   * 建立一个新连接，返回「连接已 OPEN」的 promise。
   *
   * 连接关闭后由 `_getOpenWsClient()` 再次调用以重建，因此这里不做「一次性」假设。
   */
  private _connect(): Promise<WebSocket> {
    const ws = new WebSocket(this._wsUrl);
    this._wsClient = ws;

    // 单例监听器：只随连接注册一次
    ws.addEventListener("message", this._handleWsMessage);
    ws.addEventListener("close", this._handleWsClose);
    ws.addEventListener("error", this._handleWsClose);

    const ready = new Promise<WebSocket>((resolve, reject) => {
      if (ws.readyState === WS_OPEN) {
        resolve(ws);
        return;
      }

      const cleanup = () => {
        ws.removeEventListener("open", onOpen);
        ws.removeEventListener("close", onFail);
        ws.removeEventListener("error", onFail);
      };
      const onOpen = () => {
        cleanup();
        resolve(ws);
      };
      // 建连失败（或建连期间被关闭）：立刻失败，而不是让请求空等到超时
      const onFail = () => {
        cleanup();
        reject(new Error("Aria2 WebSocket disconnected"));
      };

      ws.addEventListener("open", onOpen);
      ws.addEventListener("close", onFail);
      ws.addEventListener("error", onFail);
    });

    /**
     * 建连失败而此刻又没有请求在等待时，不要让 rejection 泄漏成 unhandled rejection；
     * 这里挂一个空处理函数，真正的等待方仍然会从 ready 上拿到 rejection。
     */
    ready.catch(() => {});

    return ready;
  }

  /**
   * 取得一个处于 OPEN 状态的连接，必要时重建。
   *
   * 规范要求 readyState 为 CONNECTING 时 `send()` 抛 `InvalidStateError`（新实例的首个请求
   * 必然踩中），而 CLOSING/CLOSED 时 `send()` 会被静默丢弃（请求只能干等到超时），
   * 因此所有发送动作都必须先经过这里。
   *
   * 最多两轮：第一轮复用/等待连接，第二轮覆盖「连接在等待期间又被关闭」的情况。
   */
  private async _getOpenWsClient(): Promise<WebSocket> {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (this._disposed) {
        throw new Error("Aria2 client has been disposed");
      }

      if (this._wsClient?.readyState === WS_OPEN) {
        return this._wsClient;
      }

      let ready = this._wsReady;
      const state = this._wsClient?.readyState;
      // 需要重建连接：建连失败 / 已关闭 / 正在关闭（close 事件可能尚未派发）
      if (ready === null || state === WS_CLOSING || state === WS_CLOSED) {
        ready = this._connect();
      }

      try {
        const ws = await ready;
        if (ws.readyState === WS_OPEN) {
          return ws;
        }
        this._wsReady = null; // open 之后又立刻关闭，交给下一轮重建
      } catch (e) {
        this._wsReady = null;
        if (attempt > 0) {
          throw e;
        }
      }
    }

    throw new Error("Aria2 WebSocket is not open");
  }

  /** 单例 message 监听器：按 msgId 派发到对应的 pending 请求 */
  private _handleWsMessage = (event: MessageEvent) => {
    let data: jsonRPCResponse<any>;
    try {
      data = JSON.parse(event.data);
    } catch (e) {
      // 忽略无法解析的消息（例如服务端的通知事件）
      return;
    }

    // 无 id 的消息（aria2 的 notification）不属于任何请求，直接忽略
    if (data?.id === undefined || data?.id === null) {
      return;
    }

    const msgId = String(data.id);
    const pending = this._pendingRequests.get(msgId);
    if (!pending) {
      return;
    }

    this._pendingRequests.delete(msgId);
    clearTimeout(pending.timer);

    if (data.error) {
      // 错误只影响 id 匹配的那一个请求
      pending.reject(new Error(data.error?.message || "WS ERROR"));
    } else {
      // 保证消息一致性
      pending.resolve(data);
    }
  };

  /**
   * WS 断开 / 出错时，所有 pending 请求立刻失败，避免 UI 永久 loading。
   *
   * 同时清空 `_wsReady`：下一次 `methodSend()` 会据此重建连接（此前关闭后不再重连，
   * 所有后续请求都会被静默丢弃并挂到超时）。
   */
  private _handleWsClose = (event?: Event) => {
    // 重建后旧 socket 的 close/error 可能晚于新连接的建立到达，不能让它影响新连接
    if (event?.target != null && this._wsClient !== null && event.target !== this._wsClient) {
      return;
    }

    this._wsReady = null;

    const error = new Error("Aria2 WebSocket disconnected");
    for (const [msgId, pending] of this._pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this._pendingRequests.delete(msgId);
    }
  };

  /**
   * 关闭 WebSocket 并释放全部 pending 请求，实例不再使用时应调用
   */
  public dispose() {
    if (this._disposed) {
      return;
    }
    this._disposed = true;

    const ws = this._wsClient;
    if (ws) {
      ws.removeEventListener("message", this._handleWsMessage);
      ws.removeEventListener("close", this._handleWsClose);
      ws.removeEventListener("error", this._handleWsClose);
    }

    this._handleWsClose();

    try {
      ws?.close();
    } catch (e) {
      // P1-5：连接可能已处于 CLOSING/CLOSED 状态，关闭失败不影响 dispose 流程，
      // 仅记录原因，避免实例回收阶段静默吞掉异常。
      logMessage("[Aria2] 关闭 WebSocket 失败", {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  private async methodSend<T>(methodName: METHODS, params: any[] = []): Promise<jsonRPCResponse<T>> {
    if (this._disposed) {
      throw new Error("Aria2 client has been disposed");
    }

    let postParams;
    if (methodName === "system.multicall") {
      (params as multiCallParams).forEach((x) => {
        x.params = [`token:${this.config.password}`, ...x.params];
      });

      postParams = [params];
    } else {
      postParams = [`token:${this.config.password}`, ...params];
    }

    const msgId = String(this.msgId);
    const timeout = (this.config.timeout ?? 0) > 0 ? this.config.timeout! : DEFAULT_METHOD_TIMEOUT;

    const responsePromise = new Promise<jsonRPCResponse<T>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pendingRequests.delete(msgId);
        reject(new Error(`Aria2 request timeout: ${methodName}`));
      }, timeout);

      // 先登记再发送：响应可能在任何时刻到达
      this._pendingRequests.set(msgId, { resolve, reject, timer });
    });

    // 立刻挂一个「已处理」标记：下面的建连等待本身也可能超时（见 connectPromise 的 race），
    // 那种情况下我们会先抛错返回，而 responsePromise 的定时器随后才 reject —— 此刻没有
    // 任何 handler 挂在它上面，会产生 unhandled rejection。这里挂一个 no-op 处理函数，
    // 既不改变 responsePromise 自身的状态（后面 await 仍能拿到 rejection），也消除了该告警。
    responsePromise.catch(() => undefined);

    // 建连阶段同样要受 timeout 保护：半开 TCP（VPN 掉线/防火墙丢包）下 WebSocket 握手可能
    // 长时间既不 open 也不 close/error，只 await _getOpenWsClient() 会让调用方**永久挂起**
    // （表现为 UI 一直 loading），而上面那个定时器此时还没被 await 到。
    let connectTimer: ReturnType<typeof setTimeout> | undefined;
    const connectPromise = new Promise<never>((_, reject) => {
      connectTimer = setTimeout(() => reject(new Error(`Aria2 connect timeout: ${methodName}`)), timeout);
    });

    try {
      // 等连接可用再发送：CONNECTING 时 send() 会抛 InvalidStateError，
      // CLOSING/CLOSED 时 send() 会被静默丢弃
      const ws = await Promise.race([this._getOpenWsClient(), connectPromise]);
      clearTimeout(connectTimer);
      ws.send(
        JSON.stringify({
          method: methodName,
          id: msgId,
          params: postParams,
        }),
      );
    } catch (e) {
      clearTimeout(connectTimer);
      const pending = this._pendingRequests.get(msgId);
      if (pending) {
        clearTimeout(pending.timer);
        this._pendingRequests.delete(msgId);
      }
      throw e;
    }

    return await responsePromise;
  }

  async ping(): Promise<boolean> {
    try {
      const { result: pingData } = await this.methodSend<{
        version: string;
        enabledFeatures: string[];
      }>("aria2.getVersion");
      return pingData.version.includes(".");
    } catch (e) {
      return false;
    }
  }

  protected async getClientVersionFromRemote(): Promise<string> {
    const { result: versionData } = await this.methodSend<{
      version: string;
      enabledFeatures: string[];
    }>("aria2.getVersion");
    return versionData.version;
  }

  // Aria2 只能知道当前的传输速度，其他都不知道
  override async getClientStatus(): Promise<TorrentClientStatus> {
    const { result: statusData } = await this.methodSend<{
      downloadSpeed: string;
      uploadSpeed: string;
    }>("aria2.getGlobalStat");
    return {
      dlSpeed: Number(statusData.downloadSpeed),
      upSpeed: Number(statusData.uploadSpeed),
    };
  }

  async addTorrent(url: string, options: Partial<CAddTorrentOptions> = {}): Promise<CAddTorrentResult> {
    const addResult = { success: false } as CAddTorrentResult;

    const addOption: any = { pause: options.addAtPaused ?? false };

    if (options.savePath) {
      addOption.dir = options.savePath;
    }

    let method: "aria2.addUri" | "aria2.addTorrent";
    let params: any;
    if (url.startsWith("magnet:") || !options.localDownload) {
      // 链接 add_torrent_url
      method = "aria2.addUri";
      params = [[url], addOption];
    } else {
      // 文件 add_torrent_file
      method = "aria2.addTorrent";

      const torrent = await getRemoteTorrentFile({
        url,
        ...(options.localDownloadOption ?? {}),
      });

      params = [torrent.metadata.base64(), [], addOption];
    }

    try {
      // 注意：methodSend 返回的是整个 jsonRPCResponse，真正的 GID 在 result 中
      const { result: gid } = await this.methodSend<string>(method, params);

      // 设置上传速度限制 - 必须在添加后使用 aria2.changeOption
      if (options.uploadSpeedLimit && options.uploadSpeedLimit > 0) {
        try {
          await this.methodSend("aria2.changeOption", [
            gid,
            {
              "max-upload-limit": `${options.uploadSpeedLimit * 1024}K`,
            },
          ]);
        } catch (e) {
          // P1-5：限速是「附加能力」，设置失败不应让整个添加动作失败（种子已成功添加），
          // 但必须留下原因，否则用户会以为限速已生效。
          logMessage("[Aria2] 设置上传限速失败（种子已添加）", {
            gid,
            uploadSpeedLimit: options.uploadSpeedLimit,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }

      addResult.success = true;
    } catch (e) {
      // P1-5：把添加失败原因回传给调用方（会写入下载历史），与 Flood/Transmission/Deluge 行为保持一致
      addResult.message = e instanceof Error ? e.message : String(e);
      logMessage("[Aria2] 添加种子失败", { url, error: addResult.message }, "error");
    }

    return addResult;
  }

  async getAllTorrents(): Promise<CTorrent<rawTask>[]> {
    const torrents: CTorrent[] = [];
    const { result: tasks } = await this.methodSend<unknown[]>("system.multicall", [
      {
        methodName: "aria2.tellActive",
        params: [],
      },
      {
        methodName: "aria2.tellWaiting",
        params: [0, 1000],
      },
      {
        methodName: "aria2.tellStopped",
        params: [0, 1000],
      },
    ] as multiCallParams);

    (tasks ?? []).forEach((task) => {
      unwrapMultiCallTasks(task).forEach((rawTask) => {
        // 注意，我们只筛选bittorrent种子，对于其他类型的task，我们不做筛选
        if (rawTask?.bittorrent) {
          torrents.push(this.parseRawTorrent(rawTask));
        }
      });
    });

    return torrents;
  }

  override async getTorrent(id: string): Promise<CTorrent<rawTask>> {
    const { result: task } = await this.methodSend<rawTask>("aria2.tellStatus", [id]);
    return this.parseRawTorrent(task);
  }

  async pauseTorrent(id: string): Promise<boolean> {
    await this.methodSend<string>("aria2.pause", [id]);
    return true;
  }

  async removeTorrent(id: string, removeData?: boolean): Promise<boolean> {
    if (removeData) {
      throw new Error("Aria2 does not support deleting torrent data through this API");
    }
    await this.methodSend<string>("aria2.remove", [id]);
    await this.methodSend<"OK">("aria2.removeDownloadResult", [id]);
    return true;
  }

  async resumeTorrent(id: any): Promise<boolean> {
    await this.methodSend<string>("aria2.unpause", [id]);
    return true;
  }

  async getTorrentTrackers(_torrent: CTorrent): Promise<string[]> {
    return [];
  }

  // 调整任务在队列中的位置（aria2.changePosition）
  override async moveTorrentInQueue(id: any, direction: TorrentQueueDirection): Promise<boolean> {
    const positionMap: Record<TorrentQueueDirection, [number, "POS_SET" | "POS_CUR" | "POS_END"]> = {
      top: [0, "POS_SET"],
      up: [-1, "POS_CUR"],
      down: [1, "POS_CUR"],
      bottom: [0, "POS_END"],
    };
    const [pos, how] = positionMap[direction];
    await this.methodSend<string>("aria2.changePosition", [id, pos, how]);
    return true;
  }

  // 设置单个任务的速度限制（单位 KiB/s，0 表示不限速；aria2 使用 K 后缀）
  override async setTorrentSpeedLimit(id: any, limits: TorrentSpeedLimit): Promise<boolean> {
    const options: Record<string, string> = {};
    if (typeof limits.download !== "undefined") {
      options["max-download-limit"] = limits.download > 0 ? `${limits.download}K` : "0";
    }
    if (typeof limits.upload !== "undefined") {
      options["max-upload-limit"] = limits.upload > 0 ? `${limits.upload}K` : "0";
    }
    await this.methodSend("aria2.changeOption", [id, options]);
    return true;
  }

  private parseRawTorrent(rawTask: rawTask): CTorrent<rawTask> {
    // CTorrent.progress 的约定是 0-100（见 types.ts），而 aria2 返回的是字节数，这里换算成百分比；
    // totalLength 在获取元数据等阶段可能为 0，需要防御除零
    const totalLength = Number(rawTask.totalLength) || 0;
    const completedLength = Number(rawTask.completedLength) || 0;
    const progress = totalLength > 0 ? (completedLength / totalLength) * 100 : 0;
    let state = CTorrentState.unknown;
    switch (rawTask.status) {
      case "active":
        state = progress >= 100 ? CTorrentState.seeding : CTorrentState.downloading;
        break;

      case "error":
      case "removed":
        state = CTorrentState.error;
        break;

      case "complete":
      case "paused":
        state = CTorrentState.paused;
        break;

      case "waiting":
        state = CTorrentState.queued;
        break;
    }

    return {
      id: rawTask.gid,
      infoHash: rawTask.infoHash!,
      name: rawTask.bittorrent!.info.name,
      progress,
      isCompleted: progress >= 100,
      ratio: rawTask.uploadLength / rawTask.totalLength || 0,
      dateAdded: 0, // Aria2 不返回添加时间
      savePath: rawTask.dir,
      state,
      totalSize: Number(rawTask.totalLength),
      totalUploaded: Number(rawTask.uploadLength),
      totalDownloaded: Number(rawTask.completedLength),
      uploadSpeed: Number(rawTask.uploadSpeed),
      downloadSpeed: Number(rawTask.downloadSpeed),
      raw: rawTask,
      clientId: this.config.id,
    } as CTorrent<rawTask>;
  }

  // 文件列表（只读）: aria2.getFiles；aria2 无优先级概念，统一 normal
  override async getTorrentFiles(torrent: string | CTorrent): Promise<CTorrentFile[]> {
    const id = typeof torrent === "string" ? torrent : (torrent.id as string);
    const { result: files } = await this.methodSend<
      Array<{
        index: number;
        path: string;
        length: number;
        completedLength: number;
        selected: string; // "true" | "false"
      }>
    >("aria2.getFiles", [id]);

    return (files ?? []).map((file) => ({
      index: file.index,
      name: file.path.split(/[/\\]/).pop() || file.path,
      path: file.path,
      size: file.length,
      progress: file.length > 0 ? (file.completedLength / file.length) * 100 : 0,
      priority: "normal" as TorrentFilePriority,
      wanted: String(file.selected) === "true",
      raw: file,
    }));
  }
}
