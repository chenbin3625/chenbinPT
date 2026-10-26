import urlJoin from "url-join";
import { AuthType, createClient, type FileStat, type WebDAVClient } from "webdav";

import AbstractBackupServer from "../AbstractBackupServer.ts";
import { localSort } from "../utils";
import { logMessage } from "@ptd/site/utils/adapter.ts";
import type { IBackupConfig, IBackupData, IBackupFileInfo, IBackupFileListOption, IBackupMetadata } from "../type";

interface WebDAVConfig extends IBackupConfig {
  config: {
    address: string;
    loginName: string;
    loginPwd: string;
    digest?: boolean;
  };
}

export const serverConfig: WebDAVConfig = {
  name: "WebDAV",
  type: "WebDAV",
  config: { address: "http://127.0.0.1/webdav", loginName: "", loginPwd: "", digest: false },
};

export const serverMetaData: IBackupMetadata<WebDAVConfig> = {
  description: "WebDAV 是一种基于 HTTP 协议的文件传输协议，支持文件存储和共享功能。",
  requiredField: [
    { name: "地址", key: "address", type: "string" },
    { name: "用户名", key: "loginName", type: "string" },
    { name: "密码", key: "loginPwd", type: "string", secret: true },
    { name: "Digest", key: "digest", type: "boolean" },
  ],
};

/**
 * C2-B-9 / 复检 P2（D）：把远端返回/用户选择的 path 收敛成 WebDAV 根目录下的相对路径。
 *
 * 旧实现只删字面 `..`，`%2e%2e%2f` 这类编码形式仍可能在服务端解码后跳出备份根目录；
 * 只解码一次也挡不住多重编码（`..%252f..%252fetc` 解码一次变成 `..%2f..%2fetc`，服务端/客户端
 * 再解码一次就变成 `../../etc`）。这里**循环解码到不动点**（上限 5 次防解压炸弹式的超长编码），
 * 再逐段过滤 `.`/`..`/空段；反斜杠也按分隔符处理（部分服务端兼容 Windows 路径）。
 */
export function sanitizeWebdavPath(path: string): string {
  let decoded = path;
  for (let i = 0; i < 5; i++) {
    let next = decoded;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      break; // 非法百分号编码：停止解码，按当前内容过滤
    }
    if (next === decoded) {
      break; // 已到不动点
    }
    decoded = next;
  }

  return decoded
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment !== "" && segment !== "." && segment !== "..")
    .join("/");
}

export default class WebDAV extends AbstractBackupServer<WebDAVConfig> {
  protected version = "1.0.0";

  private server?: WebDAVClient;

  private getServer(): WebDAVClient {
    if (!this.server) {
      this.server = createClient(this.userConfig.address, {
        username: this.userConfig.loginName,
        password: this.userConfig.loginPwd,
        authType: this.userConfig.digest ? AuthType.Digest : undefined,
      });
    }
    return this.server;
  }

  async ping(): Promise<boolean> {
    try {
      // C2-B-2：webdav 客户端没有 timeout 配置项，统一用 withRequestTimeout 的 AbortSignal 兜底
      await this.withRequestTimeout((signal) => this.getServer().getDirectoryContents("/", { signal }));
      return true;
    } catch (e) {
      // P1-5：ping 失败由返回值 false 表达，但仍需记录原因（地址/账号错误、证书、网络不可达等）
      logMessage("[WebDAV] ping 失败", { error: e instanceof Error ? e.message : String(e) });
    }
    return false;
  }

  async list(options: IBackupFileListOption = {}): Promise<IBackupFileInfo[]> {
    const retFileList: IBackupFileInfo[] = [];

    const fileList = await this.withRequestTimeout(
      (signal) => this.getServer().getDirectoryContents("/", { glob: "*.zip", signal }) as Promise<FileStat[]>,
    );
    fileList.forEach((item) => {
      retFileList.push({
        filename: item.basename,
        path: item.filename,
        size: item.size,
        time: +new Date(item.lastmod),
      } as IBackupFileInfo);
    });

    return localSort(retFileList, options);
  }

  async addFile(fileName: string, file: IBackupData): Promise<boolean> {
    const fileBlob = await this.backupDataToZipBlob(file);
    // webdav 客户端（浏览器环境）只接受 string / ArrayBuffer / Uint8Array / Node 流，
    // 不接受 Blob（会被当成 JSON 序列化），因此这里必须整包转成 ArrayBuffer 一次并直接复用。
    const fileBuffer = await fileBlob.arrayBuffer();

    // C2-B-2：上传同样要有超时，否则大文件/挂死的服务端会卡住自动备份锁
    return await this.withRequestTimeout((signal) =>
      this.getServer().putFileContents(fileName, fileBuffer, { signal }),
    );
  }

  async getFile(path: string): Promise<IBackupData> {
    const safePath = sanitizeWebdavPath(path);
    const fileBuffer = await this.withRequestTimeout((signal) =>
      this.getServer().getFileContents(urlJoin("/", safePath), { signal }),
    );
    const data = new Blob([fileBuffer as ArrayBuffer]);

    return await this.zipBlobToBackupData(data);
  }

  async deleteFile(path: string): Promise<boolean> {
    const safePath = sanitizeWebdavPath(path);
    await this.withRequestTimeout((signal) => this.getServer().deleteFile(urlJoin("/", safePath), { signal }));
    return true;
  }
}
