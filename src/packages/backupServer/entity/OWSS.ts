import urlJoin from "url-join";
import axios, { AxiosRequestConfig, AxiosResponse } from "axios";

import AbstractBackupServer from "../AbstractBackupServer.ts";
import { getBackupRequestTimeout } from "../utils.ts";
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
      timeout: getBackupRequestTimeout(this.userConfig),
      ...config,
    });
  }

  /**
   * C2-B-3：OWSS 的错误响应是 HTTP 200 + `{error}` / `{code,msg}`（见 OWSSResponse 注释），
   * axios 不会 reject。旧实现直接 `data.data` 取值 → list 静默返回 []、addFile/deleteFile 静默 false，
   * 用户/自动备份日志完全看不到原因。这里统一校验并抛出可读错误。
   */
  private expectData<T>(resp: OWSSResponse<T>, action: string): T {
    if (resp?.error) {
      throw new Error(`OWSS ${action} failed: ${resp.error.msg ?? JSON.stringify(resp.error)}`);
    }
    if (resp?.code !== undefined) {
      throw new Error(`OWSS ${action} failed: [${String(resp.code)}] ${resp.message ?? resp.msg ?? ""}`.trim());
    }
    if (resp?.msg || resp?.message) {
      throw new Error(`OWSS ${action} failed: ${resp.msg ?? resp.message}`);
    }
    if (resp?.data === undefined || resp?.data === null) {
      throw new Error(`OWSS ${action} failed: empty response`);
    }
    return resp.data;
  }

  public async ping(): Promise<boolean> {
    try {
      const { data } = await this.request<OWSSResponse<OWSSRawList[]>>({
        url: "/list",
        params: { page: 1, pageSize: 1 },
      });
      return Array.isArray(this.expectData(data, "ping"));
    } catch (e) {
      // P1-5：ping 失败由返回值 false 表达，但保留失败原因便于排查（鉴权码、地址、网络等）
      logMessage("[OWSS] ping 失败", { error: e instanceof Error ? e.message : String(e) });
    }
    return false;
  }

  public async list(options: IBackupFileListOption = {}): Promise<IBackupFileInfo[]> {
    try {
      const { data: listData } = await this.request<OWSSResponse<OWSSRawList[]>>({
        url: "/list",
        // C2-B-3：上游 `/list` 默认 `page=1&pageSize=10`（OWSS storage.ts getResourceList 默认参数），
        // 不显式传 pageSize=-1 时最多只返回 10 条，导致历史备份不可见、保留策略永远看不到更老的文件。
        params: { ...options, page: 1, pageSize: -1 },
      });

      const rawList = this.expectData(listData, "list");
      if (!Array.isArray(rawList)) {
        throw new Error("OWSS list failed: data is not an array");
      }

      return rawList.map(
        ({ name: filename, time, size }) => ({ filename, time, size, path: filename }) as IBackupFileInfo,
      );
    } catch (e) {
      this.logBackupFailure("list", e);
      throw e;
    }
  }

  public async addFile(fileName: string, file: IBackupData): Promise<boolean> {
    try {
      const formData = new FormData();
      formData.append("name", fileName);
      formData.append("data", await this.backupDataToZipBlob(file), fileName);

      const { data } = await this.request<OWSSResponse<boolean>>({
        method: "post",
        url: "/add",
        data: formData,
      });
      const result = this.expectData(data, "addFile");
      if (!result) {
        throw new Error("OWSS addFile failed: server rejected the upload");
      }
      return true;
    } catch (e) {
      // SERVERSSOCIAL-3：失败必须记录原因（地址/授权码/体积限制/网络等）
      this.logBackupFailure("addFile", e);
      return false;
    }
  }

  public async deleteFile(path: string): Promise<boolean> {
    try {
      const { data } = await this.request<OWSSResponse<boolean>>({
        method: "post",
        url: urlJoin("/delete", path),
      });
      const result = this.expectData(data, "deleteFile");
      if (!result) {
        throw new Error("OWSS deleteFile failed: server rejected the request");
      }
      return true;
    } catch (e) {
      this.logBackupFailure("deleteFile", e);
      return false;
    }
  }

  public async getFile(path: string): Promise<IBackupData> {
    try {
      const { data } = await this.request<Blob>({
        url: urlJoin("/get", path),
        responseType: "blob",
      });
      return await this.zipBlobToBackupData(data);
    } catch (e) {
      this.logBackupFailure("getFile", e);
      throw e;
    }
  }
}
