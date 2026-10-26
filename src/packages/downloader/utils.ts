import axios, { AxiosRequestConfig } from "axios";
import parseTorrent, { Instance as TorrentInstance } from "parse-torrent";
import isValidFilename from "valid-filename";

// 复检 RB-5：日志脱敏复用统一实现（query 值 + **路径内凭据段**，如 Rartracker
// `/api/v1/torrents/download/{id}/{passkey}`）。该函数是纯函数、无浏览器依赖。
import { redactSensitiveUrls } from "@/shared/redact.ts";

export * from "./utils/adapter";

/**
 * 本文件原先使用 `urlencode` 的 `decode`，而 `urlencode` 会静态引入 `iconv-lite`（约 300KB），
 * 使得 content script 的共享 chunk 也被迫带上整套编码表。这里只用到 `utf-8` 与 `ascii` 两个分支，
 * 因此改为等价的本地实现，避免该依赖进入依赖图。
 *
 * 等价实现参考 urlencode@1.1.0 src/index.ts 的 decode()：
 *   - 未指定 charset / utf-8 → decodeURIComponent(str)
 *   - 其他 charset（本文件仅 ascii）→ 逐字节读入后交给 iconv-lite 解码
 */
function decodeUrlEncodedUtf8(str: string): string {
  return decodeURIComponent(str);
}

function decodeUrlEncodedAscii(str: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < str.length;) {
    if (str[i] === "%") {
      i++;
      bytes.push(parseInt(str.substring(i, i + 2), 16));
      i += 2;
    } else {
      bytes.push(str.charCodeAt(i));
      i++;
    }
  }

  // iconv-lite 的 ascii 解码会把 >= 0x80 的字节替换为 U+FFFD（与 Buffer 的 latin1 不同），
  // 非法/截断的 %xx 与原实现一样按 0 处理。
  return bytes.map((byte) => (byte >= 0x80 ? "\uFFFD" : String.fromCharCode(Number.isNaN(byte) ? 0 : byte))).join("");
}

/**
 * 字节 → 标准 base64（带 `=` 填充），与原先 `Buffer.toString("base64")` 输出逐字节一致。
 *
 * 不用 `Uint8Array.prototype.toBase64()`：扩展的最低浏览器版本虽然支持，但单测运行的 Node 24 尚未提供。
 * 分块拼接二进制串，避免 `String.fromCharCode(...大数组)` 爆栈（种子文件上限见 MAX_TORRENT_FILE_SIZE）。
 */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export interface ParsedTorrent {
  name: string;
  metadata: {
    blob: () => Blob;
    base64: () => string;
  };
  info: TorrentInstance;
}

const utf8FilenameRegex = /filename\*=UTF-8''([\w%\-\.]+)(?:; ?|$)/i;
const asciiFilenameRegex = /^filename=(["']?)(.*?[^\\])\1(?:; ?|$)/i;

const magnetUriV1Pattern = /xt(?:\.1)?=urn:btih:(?<hash>[a-z0-9]{32}(?:[a-z0-9]{8})?)/i;
const magnetUriV2Pattern = /xt(?:\.1)?=urn:btmh:1220(?<hash>[a-z0-9]{64})/i;

export function extractMagnetHash(magnetUri: string): string | null {
  // 先尝试使用 v1 模式匹配
  const v1Match = magnetUri.match(magnetUriV1Pattern);
  if (v1Match) {
    return v1Match.groups?.hash || null;
  }
  // 若 v1 匹配失败，再尝试使用 v2 模式匹配
  const v2Match = magnetUri.match(magnetUriV2Pattern);
  return v2Match?.groups?.hash || null;
}

/**
 * 将下载链接脱敏后再写日志（SEC-1）。
 *
 * PT 站的下载链接通常带 `passkey` / `torrent_pass` 等凭据参数，日志会被导出、粘贴到 issue；
 * 这里只保留「协议 + 主机 + 路径」，去掉 query/hash；磁链只保留 infoHash 相关字段。
 * 无法解析时返回固定占位符，避免把原文写进日志。
 */
export function sanitizeDownloadUrlForLog(url: unknown): string {
  const raw = typeof url === "string" ? url : "";
  if (!raw) {
    return "<empty>";
  }

  if (/^magnet:/i.test(raw)) {
    const hash = extractMagnetHash(raw);
    return hash ? `magnet:?xt=urn:btih:${hash}` : "magnet:<redacted>";
  }

  try {
    const parsed = new URL(raw);
    /**
     * 复检 RB-5：除了丢弃 query，还要抹掉**路径里的凭据段** —— 例如 Rartracker 的下载链接是
     * `/api/v1/torrents/download/{id}/{passkey}`（凭据在 pathname 里）。这里复用统一的
     * `redactSensitiveUrls`（query 值 + ≥20 位字母数字混合的路径段均替换为 `***`）。
     */
    return redactSensitiveUrls(`${parsed.protocol}//${parsed.host}${parsed.pathname}`);
  } catch {
    return "<invalid-url>";
  }
}

/** 单个种子文件的最大允许体积（PKG-3）：防止把明显不是种子的超大响应读进内存 */
const MAX_TORRENT_FILE_SIZE = 50 * 1024 * 1024;

export async function getRemoteTorrentFile(options: AxiosRequestConfig = {}): Promise<ParsedTorrent> {
  const req = await axios.request({
    ...options,
    responseType: "arraybuffer", // 统一以 ArrayBuffer 形式获取，方便后面转化
  });

  // PKG-3：加体积上限，避免误把大文件（视频/备份）当种子读进内存
  const contentLength = Number(req.headers["content-length"] ?? 0);
  const dataLength = (req.data as ArrayBuffer | undefined)?.byteLength ?? 0;
  if ((contentLength > 0 && contentLength > MAX_TORRENT_FILE_SIZE) || dataLength > MAX_TORRENT_FILE_SIZE) {
    throw new Error("Invalid Torrent From Server (response too large)");
  }

  /**
   * PKG-3：原先只接受 `octet-stream|x-bittorrent` 白名单，部分站点用
   * `application/force-download`、`application/x-download`、`application/x-torrent` 等会误报；
   * 这里改为「明确不是种子的类型（HTML/JSON/XML/纯文本）→ 直接报错，其余仍交给 parseTorrent 校验」。
   */
  const contentType = String(req.headers["content-type"] ?? "");
  if (contentType && /^(text\/|application\/(json|xml|xhtml\+xml))/i.test(contentType)) {
    throw new Error("Invalid Torrent From Server");
  }

  // parse-torrent 的入参是 ArrayBufferView（内部按 `ArrayBuffer.isView(torrentId)` 判定），
  // 裸 ArrayBuffer 会走到最后抛 `Invalid torrent identifier`，所以这里包一层零拷贝视图。
  // 原来用 `Buffer.from(req.data, "binary")` 只是为了拿到一个视图，改用 Uint8Array 后
  // 整个仓库不再依赖 buffer 垫片。
  const metaDataBytes = new Uint8Array(req.data);
  let parsedInfo: TorrentInstance;
  try {
    parsedInfo = (await parseTorrent(metaDataBytes)) as TorrentInstance;
  } catch {
    // parseTorrent 失败说明响应体不是合法种子（例如站点返回登录页/错误页）
    throw new Error("Invalid Torrent From Server");
  }

  /**
   * 设置种子名字
   * 如果服务器显式设置 content-disposition 头，则我们尊重服务器设置
   * 不然，文件名会被设置为解析后的种子名，缺省为 `1.torrent`
   */
  let torrentName = parsedInfo.name || "1.torrent";

  const disposition: string | null = req.headers["content-disposition"];
  if (disposition && disposition.includes("filename")) {
    let dispositionName = "";
    if (utf8FilenameRegex.test(disposition)) {
      dispositionName = decodeUrlEncodedUtf8(utf8FilenameRegex.exec(disposition)![1]);
    } else {
      // prevent ReDos attacks by anchoring the ascii regex to string start and
      // slicing off everything before 'filename='
      const filenameStart = disposition.toLowerCase().indexOf("filename=");
      if (filenameStart >= 0) {
        const partialDisposition = disposition.slice(filenameStart);
        const matches = asciiFilenameRegex.exec(partialDisposition);
        if (matches != null && matches[2]) {
          dispositionName = decodeUrlEncodedAscii(matches[2]); // 按照规范使用 ascii 转换
        }
      }
    }

    /**
     * hdsky 返回 filename="xxxxxxx.torrent" ; charset=utf-8 需要额外处理，同时此处包含了 trim
     * 注意，由于上面对该情况使用 ascii 转换，这样仍然会导致文件名出现异常
     */
    dispositionName = dispositionName.replace(/^[ "']+/, "").replace(/[ "']+$/, "");
    // 检查 dispositionName 是否合法
    if (isValidFilename(dispositionName)) torrentName = dispositionName;
  }

  if (!/\.torrent$/i.test(torrentName)) {
    torrentName = `${torrentName}.torrent`;
  }

  return {
    name: torrentName,
    metadata: {
      base64: () => bytesToBase64(metaDataBytes),
      blob: () => new Blob([req.data], { type: "application/x-bittorrent" }),
    },
    info: parsedInfo,
  } as ParsedTorrent;
}
