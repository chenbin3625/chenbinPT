/**
 * @see https://github.com/Novik/ruTorrent/blob/master/php/addtorrent.php
 * @see https://github.com/Rhilip/PT-Plugin/blob/master/src/script/client.js#L477_L543
 */
import {
  AbstractBittorrentClient,
  CAddTorrentOptions,
  CustomPathDescription,
  CTorrent,
  TorrentClientConfig,
  TorrentClientMetaData,
  CTorrentState,
  TorrentClientStatus,
  CAddTorrentResult,
  CTorrentFile,
  CTorrentFileSelection,
  CTorrentPeer,
  CTorrentTracker,
  CTrackerState,
  TorrentFilePriority,
} from "../types";
import axios, { AxiosRequestConfig, AxiosResponse } from "axios";
import { getRemoteTorrentFile } from "../utils";

export const clientConfig: TorrentClientConfig = {
  type: "ruTorrent",
  name: "ruTorrent",
  address: "https://myrut.com/rutorrent",
  username: "admin",
  password: "",
  timeout: 60 * 1e3,
};

// noinspection JSUnusedGlobalSymbols
export const clientMetaData: TorrentClientMetaData = {
  description: "rTorrent 的一款基于PHP的Web前端面板",
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
    // rTorrent 没有「单种限速」命令：d.set_upload_limit / d.set_download_limit 并不存在（会以 fault 返回），
    // 单种限速只能通过预先在 rtorrent.rc 里定义的 throttle 组（d.throttle_name.set）实现，无法按任意数值设置。
    SpeedLimit: {
      allowed: false,
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
    // tracker 增删需经 t.multicall 组合，边界多，暂保持只读
    TrackerManage: {
      allowed: false,
    },
  },
};

type torrentData = [
  string, // is_open
  string, // is_hash_checking
  string, // is_hash_checked
  string, // get_state
  string, // torrent_name
  string, // torrent_size
  string, // get_completed_chunks
  string, // get_size_chunks
  string, // torrent_downloaded
  string, // torrent_uploaded
  string, // ratio
  string, // torrent_ul
  string, // torrent_dl
  string, // get_chunk_size
  string, // torrent_label
  string, // peers_actual
  string, // get_peers_not_connected
  string, // get_peers_connected
  string, // seeds_actual
  string, // remaining
  string, // priority
  string, // state_changed
  string, // skip_total
  string, // get_hashing
  string, // get_hashed_chunks
  string, // base_path
  string, // created
  string, // tracker_focus
  string, // is_active
  string, // torrent_msg
  string, // torrent_comment
  string, // free_diskspace
  string, // private
  string, // multi_file
];

type statusData = [
  string, // up_total
  string, // down_total
  string, // upload_rate
  string, // download_rate
];

interface ListResponse {
  t: {
    [infoHash: string]: torrentData;
  };
  cid: number;
}

function iv(val: string | null): number {
  const v = val == null ? 0 : parseInt(val + "");
  return isNaN(v) ? 0 : v;
}

/**
 * XML-RPC 请求体是手写拼接的字符串，文本节点必须转义 `&`/`<`/`>`。
 * 否则标签、目录里含这些字符时服务端会返回 XML 解析 fault，
 * 表现为「操作静默无效但 UI 报成功」。
 */
function escapeXml(value: unknown): string {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function buildRequestXML(calls: Array<[string, string[]?]>): string {
  let retXML = '<?xml version="1.0" encoding="UTF-8"?>';
  retXML += "<methodCall><methodName>system.multicall</methodName><params><param><value><array><data>";
  for (const [method, params = []] of calls) {
    retXML += "<value><struct>";
    retXML += `<member><name>methodName</name><value><string>${escapeXml(method)}</string></value></member>`;
    retXML +=
      "<member><name>params</name><value><array><data>" +
      params.map((param) => `<value><string>${escapeXml(param)}</string></value>`).join("") +
      "</data></array></value></member>";
    retXML += "</struct></value>";
  }

  retXML += "</data></array></value></param></params></methodCall>";
  return retXML;
}

function parseResponseXML(resp: string): string[] {
  const parsedXML = new DOMParser().parseFromString(resp, "text/xml");
  // noinspection CssInvalidHtmlTagReference
  const dataNode = parsedXML.querySelectorAll("params > param > value > array > data > value > array > data > value");

  return Array.from(dataNode).map((node) => node.textContent!);
}

// XML-RPC value 通用解析（支持 string/int/i4/i8/double/boolean/array/struct）
interface XmlRpcArray extends Array<XmlRpcValue> {}
interface XmlRpcStruct {
  [key: string]: XmlRpcValue;
}
type XmlRpcValue = string | number | boolean | XmlRpcArray | XmlRpcStruct;

function parseXmlRpcValue(node: Element): XmlRpcValue {
  const typeNode = node.firstElementChild;
  if (!typeNode) {
    return node.textContent ?? "";
  }

  switch (typeNode.tagName) {
    case "array": {
      const dataNode = typeNode.querySelector(":scope > data");
      return Array.from(dataNode?.querySelectorAll(":scope > value") ?? []).map((value) => parseXmlRpcValue(value));
    }
    case "struct": {
      const result: Record<string, XmlRpcValue> = {};
      typeNode.querySelectorAll(":scope > member").forEach((member) => {
        const name = member.querySelector(":scope > name")?.textContent ?? "";
        const value = member.querySelector(":scope > value");
        result[name] = value ? parseXmlRpcValue(value) : "";
      });
      return result;
    }
    case "int":
    case "i4":
    case "i8":
      return parseInt(typeNode.textContent ?? "", 10);
    case "double":
      return parseFloat(typeNode.textContent ?? "");
    case "boolean":
      return typeNode.textContent === "1" || typeNode.textContent === "true";
    case "string":
    default:
      return typeNode.textContent ?? "";
  }
}

// 解析 XML-RPC 方法响应的第一个 param value
function parseXmlRpcResponse(xml: string): XmlRpcValue {
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  const valueNode = doc.querySelector("methodResponse params param value");
  return valueNode ? parseXmlRpcValue(valueNode) : [];
}

/**
 * 取出 system.multicall 中「单个调用」的返回值，并按行展开为数组。
 *
 * XML-RPC 规范要求 multicall 把每个调用的结果再包一层单元素数组，因此对
 * f/p/t.multicall 这类「返回值本身是数组」的调用，响应嵌套固定为三层：
 *
 *   [ [ [ row1, row2, ... ] ] ]     ← multicall 列表 / 单元素包装 / 调用的返回值
 *
 * parseXmlRpcResponse 停在最外层：只剥一层会拿到包装层，解构出的 path 是整行数组、
 * size 等是 undefined（文件 / Peers / Tracker 三个面板因此只剩一行假数据）。
 *
 * 这里固定剥两层，**不能**写成「长度为 1 就继续剥」的循环：
 * 每行数据本身也是数组，只有一行数据时循环会把数据行一起剥掉。
 */
function unwrapMultiCallRows(value: XmlRpcValue): XmlRpcValue[] {
  let current: XmlRpcValue = value;

  for (let depth = 0; depth < 2; depth++) {
    if (Array.isArray(current) && current.length === 1 && Array.isArray(current[0])) {
      current = current[0];
    }
  }

  return Array.isArray(current) ? current : [];
}

/**
 * 解析 system.multicall 响应并展开为数据行。
 *
 * 形状守卫：只保留「数组行，且首字段为字符串（f.path / p.address / t.url）」的项，
 * 从而丢弃两类异常数据：
 * - 调用失败时该项是 fault 结构（会被 parseXmlRpcValue 解析成对象）；
 * - 解包失败时首字段会是数组（包装层被当成数据行），也会被过滤。
 */
function parseMultiCallRows(xml: string): XmlRpcValue[][] {
  return unwrapMultiCallRows(parseXmlRpcResponse(xml)).filter(
    (row): row is XmlRpcValue[] => Array.isArray(row) && typeof row[0] === "string",
  );
}

/**
 * 判断 XML-RPC 响应是否含错误。
 *
 * 两种情况：
 * - 整个调用失败：`methodResponse` 下直接是 `fault` 节点；
 * - system.multicall 中单个调用失败：该项是含 faultCode / faultString 的 struct。
 */
function isXmlRpcFaultResponse(xml: string): boolean {
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  if (doc.querySelector("methodResponse > fault")) {
    return true;
  }

  const hasFaultStruct = (value: XmlRpcValue): boolean => {
    if (Array.isArray(value)) {
      return value.some(hasFaultStruct);
    }
    if (value !== null && typeof value === "object") {
      const struct = value as XmlRpcStruct;
      if ("faultCode" in struct || "faultString" in struct) {
        return true;
      }
      return Object.values(struct).some(hasFaultStruct);
    }
    return false;
  };

  return hasFaultStruct(parseXmlRpcResponse(xml));
}

/** ruTorrent 的 label 以 URL 编码存放在 d.custom1，但裸 `%` 会让解码抛错，此时退回原文 */
function decodeLabel(label: XmlRpcValue | undefined): string {
  const raw = label == null ? "" : String(label);
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

// 生成 system.multicall 请求（参数为 struct 数组），用于一次请求多个 rTorrent 调用
function buildSystemMulticallXML(calls: Array<{ methodName: string; params?: string[] }>): string {
  let retXML = '<?xml version="1.0" encoding="UTF-8"?>';
  retXML += "<methodCall><methodName>system.multicall</methodName><params><param><value><array><data>";
  for (const call of calls) {
    retXML += "<value><struct>";
    retXML += `<member><name>methodName</name><value><string>${escapeXml(call.methodName)}</string></value></member>`;
    retXML += "<member><name>params</name><value><array><data>";
    for (const param of call.params ?? []) {
      retXML += `<value><string>${escapeXml(param)}</string></value>`;
    }
    retXML += "</data></array></value></member>";
    retXML += "</struct></value>";
  }
  retXML += "</data></array></value></param></params></methodCall>";
  return retXML;
}

// noinspection JSUnusedGlobalSymbols
export default class RuTorrent extends AbstractBittorrentClient<TorrentClientConfig> {
  readonly version = "v0.0.1";

  constructor(options: Partial<TorrentClientConfig> = {}) {
    super({ ...clientConfig, ...options });
  }

  async request<T>(config: AxiosRequestConfig = {}): Promise<AxiosResponse<T>> {
    return await axios.request({
      baseURL: this.config.address,
      auth: {
        username: this.config.username,
        password: this.config.password,
      },
      timeout: this.config.timeout,
      ...config,
    });
  }

  async requestHttpRpc<T>(data: any = {}): Promise<AxiosResponse<T>> {
    return this.request<T>({
      method: "post",
      url: "/plugins/httprpc/action.php",
      data,
    });
  }

  /**
   * 鉴于ruTorrent请求 `php/getplugins.php` 页面获取信息为js格式，不好处理，
   * 故考虑请求 `/php/getsettings.php` 页面，如果返回json格式的信息则说明可连接
   */
  async ping(): Promise<boolean> {
    try {
      await this.request({
        url: "/php/getsettings.php",
        responseType: "json",
      });
    } catch (e) {
      return false;
    }
    return true;
  }

  protected async getClientVersionFromRemote(): Promise<string> {
    const postData = buildRequestXML([["system.client_version"], ["system.api_version"]]);
    const { data: responseXML } = await this.requestHttpRpc<string>(postData);
    const versionList = parseResponseXML(responseXML);

    return versionList.join("/");
  }

  override async getClientStatus(): Promise<TorrentClientStatus> {
    const postData = new URLSearchParams({ mode: "ttl" });
    const { data } = await this.requestHttpRpc<statusData>(postData);
    const [upData, dlData, upSpeed, dlSpeed] = data.map(iv);

    return {
      upData,
      dlData,
      upSpeed,
      dlSpeed,
    };
  }

  override async getClientFreeSpace(): Promise<number | "N/A"> {
    const {
      data: { free },
    } = await this.request<{ total: number; free: number }>({
      // 与其它端点一致：baseURL 已包含 `/rutorrent` 前缀，这里不能重复拼接
      url: "/plugins/diskspace/action.php",
    });
    return free;
  }

  async addTorrent(url: string, options: Partial<CAddTorrentOptions> = {}): Promise<CAddTorrentResult> {
    const addResult = { success: false } as CAddTorrentResult;

    let postData: URLSearchParams | FormData;
    if (url.startsWith("magnet:") || !options.localDownload) {
      postData = new URLSearchParams();
      postData.append("url", url);
    } else {
      postData = new FormData();

      const torrent = await getRemoteTorrentFile({
        url,
        ...(options.localDownloadOption || {}),
      });

      postData.append("torrent_file", torrent.metadata.blob(), torrent.name);
    }

    postData.append("json", "1"); // 让ruTorrent返回json
    // postData.append('fast_resume', '1') // 快速恢复，默认禁用

    if (options.savePath) {
      postData.append("dir_edit", options.savePath);
    }

    if (options.addAtPaused) {
      postData.append("torrents_start_stopped", "1");
    }

    if (options.label) {
      postData.append("label", options.label);
    }

    // Note: ruTorrent's addtorrent.php does not support upload_rate parameter
    // The uploadSpeedLimit feature is not implemented as it's not supported by the API

    const { data } = await this.request<{
      result: "Success" | "Failed" | "FailedFile";
    }>({
      method: "post",
      url: "/php/addtorrent.php",
      data: postData,
    });

    addResult.success = data.result === "Success";
    if (!addResult.success) {
      addResult.message = data;
    }

    return addResult;
  }

  async getAllTorrents(): Promise<CTorrent[]> {
    const postData = new URLSearchParams({ mode: "list" });
    const { data } = await this.requestHttpRpc<ListResponse>(postData);

    return Object.keys(data.t).map((infoHash: string) => {
      const rawTorrent = data.t[infoHash];

      const isOpen = iv(rawTorrent[0]);
      const isHashChecking = iv(rawTorrent[1]);
      const getState = iv(rawTorrent[3]);
      const getHashing = iv(rawTorrent[23]);
      const isActive = iv(rawTorrent[28]);
      // 错误态检测只读 [29]（`torrent_msg` = rTorrent 的 `d.get_message`）。上游一手证据：
      //   - rTorrent `src/core/download.cc:59-64`：`Download::receive_tracker_msg()` 里
      //     `m_message = "Tracker: [" + msg + "]"`，而 `m_message` 就是 `d.message` 命令
      //     （`command_download.cc:819` 的 `d.message`；注意 820 行是 `d.message.set`，
      //     且 rTorrent 侧**没有** `d.get_message`——那只是 ruTorrent 仍在请求的旧名）
      //     → tracker 消息落在 [29]。
      //   - ruTorrent 自己也用 [29] 判错误态：`js/rtorrent.js:1390,1399` 读 `values[29]`（`torrent.msg`），
      //     其哨兵串与下面的白名单逐字节相同。
      //
      // ⚠️ 不要改成 `[29] || [30]` 之类的回退：[30] 是 `d.custom2` = **Comment**
      // （ruTorrent `index.html` 的 `#cmt`="Comment" ← `d.comment`），而且 ruTorrent 发种时会把
      // 种子文件里的 comment 写进 custom2（`php/rtorrent.php:352`）。一旦回退到 [30]，
      // 任何**带 comment 的种子在停止后**（is_open=0 且 [29] 为空）都会被误判为 error。
      const torrentMsg = String(rawTorrent[29] ?? "");

      const chunksProcessing = isHashChecking === 0 ? iv(rawTorrent[6]) : iv(rawTorrent[24]);
      const TorrentDone = Math.floor((chunksProcessing / iv(rawTorrent[7])) * 1000);
      const isCompleted = TorrentDone >= 1000;

      const basePath = rawTorrent[25];
      const basePathPos = basePath.lastIndexOf("/");
      const savePath =
        basePath.substring(basePathPos + 1) === rawTorrent[4] ? basePath.substring(0, basePathPos) : basePath;

      let state = CTorrentState.unknown;
      if (isOpen !== 0) {
        if (getState === 0 || isActive === 0) {
          state = CTorrentState.paused;
        } else {
          state = isCompleted ? CTorrentState.seeding : CTorrentState.downloading;
        }
      } else if (getHashing !== 0) {
        state = CTorrentState.queued;
      } else if (isHashChecking !== 0) {
        state = CTorrentState.checking;
      } else if (torrentMsg.length && torrentMsg !== "Tracker: [Tried all trackers.]") {
        state = CTorrentState.error;
      }

      return {
        id: infoHash.toLowerCase(),
        infoHash,
        name: rawTorrent[4],
        state,
        dateAdded: parseInt(rawTorrent[21]),
        isCompleted,
        progress: TorrentDone / 10,
        // torrent_label = 14（15 是 peers_actual，此前会把 peer 数当成标签）
        label: decodeLabel(rawTorrent[14]),
        savePath,
        totalSize: iv(rawTorrent[5]),
        // rTorrent 的 `d.get_ratio`（= 元组里的 [10]）返回的是**千分比**而非倍数：
        // 上游实现是 `(1000 * upTotal) / bytesDone`，ruTorrent 自己的 UI 也按 `ratio / 1000` 显示。
        // 不除就会在 MyClient 的分享率列里放大 1000 倍（ratio 1.0 显示成 "1000.00" 且判定为达标变绿）。
        // 同仓先例：uTorrent.ts 的 `ratio: torrent[7] / 1000`（同类协议同样是千分比）。
        ratio: iv(rawTorrent[10]) / 1000,
        uploadSpeed: iv(rawTorrent[11]),
        downloadSpeed: iv(rawTorrent[12]),
        totalUploaded: iv(rawTorrent[9]),
        totalDownloaded: iv(rawTorrent[8]),
        raw: rawTorrent,
        clientId: this.config.id,
      } as CTorrent<torrentData>;
    });
  }

  async pauseTorrent(id: any): Promise<boolean> {
    const postData = new URLSearchParams({
      mode: "pause",
      hash: id.toUpperCase(),
    });
    await this.requestHttpRpc(postData);
    return true;
  }

  async removeTorrent(id: any, removeData: boolean = false): Promise<boolean> {
    const upId = id.toUpperCase();

    let postData: string | URLSearchParams;
    if (removeData) {
      postData = buildRequestXML([
        ["d.custom5.set", [upId, 1]],
        ["d.delete_tied", [upId]],
        ["d.erase", [upId]],
      ]);
    } else {
      postData = new URLSearchParams({
        mode: "remove",
        hash: upId,
      });
    }

    await this.requestHttpRpc(postData);
    return true;
  }

  async resumeTorrent(id: string): Promise<boolean> {
    const postData = new URLSearchParams({
      mode: "unpause",
      hash: id.toUpperCase(),
    });
    await this.requestHttpRpc(postData);
    return true;
  }

  async getTorrentTrackers(_torrent: string | CTorrent): Promise<string[]> {
    const trackers = await this.getTorrentTrackersDetail(_torrent);
    return trackers.map((tracker) => tracker.url);
  }

  // 重新校验种子（rTorrent: d.check_hash）
  override async recheckTorrent(id: any): Promise<boolean> {
    const postData = buildRequestXML([["d.check_hash", [id.toUpperCase()]]]);
    await this.requestHttpRpc(postData);
    return true;
  }

  // 设置单个种子的标签（rTorrent: d.custom1.set）
  override async setTorrentLabel(id: any, label: string): Promise<boolean> {
    const postData = buildRequestXML([["d.custom1.set", [id.toUpperCase(), label]]]);
    const { data: responseXML } = await this.requestHttpRpc<string>(postData);
    // 返回真实结果：httprpc 以 HTTP 200 + fault 报文返回失败，硬编码 true 会让「标签没设置上」显示成功
    return !isXmlRpcFaultResponse(responseXML);
  }

  // ─────────────────────────────────────────────
  // 文件级 / peers / tracker（rTorrent XML-RPC，经 ruTorrent httprpc 通道）
  // ─────────────────────────────────────────────

  private getTorrentHash(torrent: string | CTorrent): string {
    if (typeof torrent === "string") {
      return torrent;
    }
    return (torrent.infoHash ?? torrent.id) as string;
  }

  // 文件列表: f.multicall
  override async getTorrentFiles(torrent: string | CTorrent): Promise<CTorrentFile[]> {
    const hash = this.getTorrentHash(torrent).toUpperCase();
    const postData = buildRequestXML([
      ["f.multicall", [hash, "", "f.path=", "f.size_bytes=", "f.completed_chunks=", "f.size_chunks=", "f.priority="]],
    ]);
    const { data: responseXML } = await this.requestHttpRpc<string>(postData);
    // system.multicall 会把单个调用的返回值再包一层数组，这里必须多剥一层才能拿到数据行
    const files = parseMultiCallRows(responseXML);

    return files.map((file, index) => {
      const [path, size, completedChunks, totalChunks, priority] = file as [string, number, number, number, number];
      const filePriority = mapRtorrentFilePriority(Number(priority));
      const totalChunksNum = Number(totalChunks);

      return {
        index,
        name: String(path).split("/").pop() || String(path),
        path: String(path),
        size: Number(size),
        progress: totalChunksNum > 0 ? (Number(completedChunks) / totalChunksNum) * 100 : 0,
        priority: filePriority,
        wanted: filePriority !== "skip",
        raw: file,
      };
    });
  }

  // 文件优先级/选择（rTorrent: f.priority.set，一次 system.multicall 批量）
  override async setTorrentFilePriority(
    torrent: string | CTorrent,
    selections: CTorrentFileSelection[],
  ): Promise<boolean> {
    if (selections.length === 0) {
      return true;
    }
    const hash = this.getTorrentHash(torrent).toUpperCase();
    const calls = selections.map(({ index, priority }) => ({
      methodName: "f.priority.set",
      params: [`${hash}:f${index}`, String(mapTorrentFilePriorityToRtorrent(priority))],
    }));

    const postData = buildSystemMulticallXML(calls);
    await this.requestHttpRpc(postData);
    return true;
  }

  // peer 列表: p.multicall
  override async getTorrentPeers(torrent: string | CTorrent): Promise<CTorrentPeer[]> {
    const hash = this.getTorrentHash(torrent).toUpperCase();
    const postData = buildRequestXML([
      [
        "p.multicall",
        [
          hash,
          "",
          "p.address=",
          "p.port=",
          "p.client_version=",
          "p.completed_percent=",
          "p.down_rate=",
          "p.up_rate=",
          "p.is_incoming=",
          "p.is_encrypted=",
        ],
      ],
    ]);
    const { data: responseXML } = await this.requestHttpRpc<string>(postData);
    const peers = parseMultiCallRows(responseXML);

    return peers.map((peer) => {
      const [ip, port, client, completedPercent, downRate, upRate, incoming, encrypted] = peer as [
        string,
        number,
        string,
        number,
        number,
        number,
        number,
        number,
      ];
      return {
        ip: String(ip),
        port: Number(port),
        client: String(client),
        // p.completed_percent 为千分比 0-1000
        progress: Number(completedPercent) / 10,
        downloadSpeed: Number(downRate),
        uploadSpeed: Number(upRate),
        incoming: incoming === 1,
        encrypted: encrypted === 1,
        flags: [],
        raw: peer,
      };
    });
  }

  // tracker 列表（带状态）: t.multicall
  override async getTorrentTrackersDetail(torrent: string | CTorrent): Promise<CTorrentTracker[]> {
    const hash = this.getTorrentHash(torrent).toUpperCase();
    const postData = buildRequestXML([
      [
        "t.multicall",
        [
          hash,
          "",
          "t.url=",
          "t.is_enabled=",
          "t.is_open=",
          "t.scrape_complete=",
          "t.scrape_incomplete=",
          "t.scrape_time_last=",
          "t.group=",
        ],
      ],
    ]);
    const { data: responseXML } = await this.requestHttpRpc<string>(postData);
    const trackers = parseMultiCallRows(responseXML);

    return trackers.map((tracker) => {
      const [url, enabled, open, seeds, leeches, lastScrape, tier] = tracker as [
        string,
        number,
        number,
        number,
        number,
        number,
        number,
      ];
      const enabledNum = Number(enabled);
      const seedsNum = Number(seeds);
      const leechesNum = Number(leeches);
      const lastScrapeNum = Number(lastScrape);

      let status = CTrackerState.unknown;
      if (enabledNum === 0) {
        status = CTrackerState.disabled;
      } else if (Number(open) === 1) {
        status = CTrackerState.working;
      } else {
        status = CTrackerState.updating;
      }

      return {
        url: String(url),
        tier: Number(tier) || 0,
        status,
        seeds: seedsNum >= 0 ? seedsNum : undefined,
        leeches: leechesNum >= 0 ? leechesNum : undefined,
        lastAnnounce: lastScrapeNum > 0 ? lastScrapeNum : undefined,
        enabled: enabledNum === 1,
        raw: tracker,
      };
    });
  }
}

// rTorrent 文件优先级: 0=skip, 1=low, 2=normal, 3=high
function mapRtorrentFilePriority(priority: number): TorrentFilePriority {
  switch (priority) {
    case 0:
      return "skip";
    case 1:
      return "low";
    case 3:
      return "high";
    case 2:
    default:
      return "normal";
  }
}

function mapTorrentFilePriorityToRtorrent(priority: TorrentFilePriority): number {
  switch (priority) {
    case "skip":
      return 0;
    case "low":
      return 1;
    case "high":
    case "highest":
      return 3;
    case "normal":
    default:
      return 2;
  }
}
