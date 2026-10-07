import urlJoin from "url-join";
import axios, { AxiosRequestConfig, AxiosResponse } from "axios";

import AbstractBackupServer from "../AbstractBackupServer.ts";
import { logMessage } from "@ptd/site/utils/adapter.ts";
import type { IBackupConfig, IBackupData, IBackupFileInfo, IBackupFileListOption, IBackupMetadata } from "../type";

interface OWSSConfig extends IBackupConfig {
  config: {
    address: string;
    authCode: string;
  };
}

interface OWSSResponse<T = any> {
  // 如果请求正常，则返回内容都在data中
  data?: T;

  /**
   * 发生错误时，可能有以下的各种返回形式，所以统一通过 !!data.data 判断是否请求成功
   * - {'error': {'code': 10004, 'msg': 'Invalid request id'}}
   * - {'code': 10003, 'msg': 'Invalid request'}
   * - {'code': 'MethodNotAllowed', 'message': 'POST is not allowed'}
   */
  error?: { code?: number; msg?: string };
  code?: number;
  msg?: string;
  message?: string;
}

/**
 * @link: https://github.com/ronggang/OWSS/blob/ce313a33f83ada521a5858cceef4a841c9531b4a/src/class/storage.ts#L133-L139
 */
interface OWSSRawList {
  name: string;
  time: number;
  type: "directory" | "file";
  size: number;
}

export const serverConfig: OWSSConfig = {
  name: "OWSS",
  type: "OWSS",
  config: { address: "http://127.0.0.1:8088/storage", authCode: "" },
};

export const serverMetaData: IBackupMetadata<OWSSConfig> = {
  description: "Open Web Simple Storage（OWSS），一个基于 nodejs 简单的 Web 存储微服务，可用于私人配置文件集中存储。",
  requiredField: [
    { name: "地址", key: "address", type: "string" },
    {
      name: "授权码",
      key: "authCode",
      type: "string",
      // SERVERSSOCIAL-8：OWSS 上游协议只支持把授权码放在 URL 路径里，无法改成请求头；
      // 服务端访问日志会看到它，所以至少在设置页明确提示。
      description: "OWSS首次部署时生成的授权码（会出现在请求 URL 路径中，服务端访问日志可见，建议仅在 HTTPS 下使用）",
      secret: true,
    },
  ],
};

/**
 * OWSS 客户端实现
 * @see: https://github.com/ronggang/OWSS
 */
export default class OWSS extends AbstractBackupServer<OWSSConfig> {
  protected version = "1.0.0";

  get address(): string {
    // 生成实际使用的访问链接
    // SERVERSSOCIAL-8：旧实现用 `address.indexOf("storage") === -1` 做全文子串判断。
    // 自建 OWSS 部署在 `https://storage.example.com`、`http://storage.local:8088` 或
    // `http://host/my-storage` 时会被误判为「已有 storage 段」而不补 `/storage`，
    // 随后所有请求都打到 `<地址>/<authCode>`：ping 恒 false、list 恒空，错误看起来像授权码问题。
    // 这里按**路径段**判断；authCode 先 trim，避免粘贴时的空白进入请求路径。
    let address = this.userConfig.address?.trim() ?? "";
    if (!/\/storage(?:\/|$)/.test(address)) {
      address = urlJoin(address, "storage");
    }
    const authCode = this.userConfig.authCode?.trim() ?? "";
    return urlJoin(address, authCode);
  }

  private async request<T>(config: AxiosRequestConfig): Promise<AxiosResponse<T>> {
    return await axios.request<T>({
      baseURL: this.address,
      timeout: 45e3,
      ...config,
    });
  }

  public async ping(): Promise<boolean> {
    try {
      const { data } = await this.request<OWSSResponse<OWSSRawList[]>>({
        url: "/list",
      });
      return Array.isArray(data.data);
    } catch (e) {
      // P1-5：ping 失败由返回值 false 表达，但保留失败原因便于排查（鉴权码、地址、网络等）
      logMessage("[OWSS] ping 失败", { error: e instanceof Error ? e.message : String(e) });
    }
    return false;
  }

  public async list(options: IBackupFileListOption = {}): Promise<IBackupFileInfo[]> {
    const { data: listData } = await this.request<OWSSResponse<OWSSRawList[]>>({
      url: "/list",
      params: options,
    });

    const backupFiles: IBackupFileInfo[] = [];

    if (listData.data) {
      listData.data.forEach((value) => {
        const { name: filename, time, size } = value;
        backupFiles.push({
          filename,
          time,
          size,
          path: filename,
        } as IBackupFileInfo);
      });
    }

    return backupFiles;
  }

  public async addFile(fileName: string, file: IBackupData): Promise<boolean> {
    const formData = new FormData();
    formData.append("name", fileName);
    formData.append("data", await this.backupDataToJSZipBlob(file), fileName);

    const { data } = await this.request<OWSSResponse<boolean>>({
      method: "post",
      url: "/add",
      data: formData,
    });
    return !!data.data;
  }

  public async deleteFile(path: string): Promise<boolean> {
    const { data } = await this.request<OWSSResponse<boolean>>({
      method: "post",
      url: urlJoin("/delete", path),
    });
    return !!data.data;
  }

  public async getFile(path: string): Promise<IBackupData> {
    const { data } = await this.request<Blob>({
      url: urlJoin("/get", path),
      responseType: "blob",
    });
    return await this.jsZipBlobToBackupData(data);
  }
}
