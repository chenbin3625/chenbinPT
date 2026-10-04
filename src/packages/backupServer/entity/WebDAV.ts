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
      await this.getServer().getDirectoryContents("/");
      return true;
    } catch (e) {
      // P1-5：ping 失败由返回值 false 表达，但仍需记录原因（地址/账号错误、证书、网络不可达等）
      logMessage("[WebDAV] ping 失败", { error: e instanceof Error ? e.message : String(e) });
    }
    return false;
  }

  async list(options: IBackupFileListOption = {}): Promise<IBackupFileInfo[]> {
    const retFileList: IBackupFileInfo[] = [];

    const fileList = (await this.getServer().getDirectoryContents("/", {
      glob: "*.zip",
    })) as FileStat[];
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
    const fileBlob = await this.backupDataToJSZipBlob(file);
    // webdav 客户端（浏览器环境）只接受 string / ArrayBuffer / Uint8Array / Node 流，
    // 不接受 Blob（会被当成 JSON 序列化），因此这里必须整包转成 ArrayBuffer 一次并直接复用。
    const fileBuffer = await fileBlob.arrayBuffer();

    return await this.getServer().putFileContents(fileName, fileBuffer);
  }

  async getFile(path: string): Promise<IBackupData> {
    const fileBuffer = await this.getServer().getFileContents(urlJoin("/", path));
    const data = new Blob([fileBuffer as ArrayBuffer]);

    return await this.jsZipBlobToBackupData(data);
  }

  async deleteFile(path: string): Promise<boolean> {
    await this.getServer().deleteFile(urlJoin("/", path));
    return true;
  }
}
