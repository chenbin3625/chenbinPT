/**
 * CookieCloud是一个和自架服务器同步Cookie的小工具，可以将浏览器的Cookie及Local storage同步到手机和云端，它内置端对端加密。
 * homepage: https://github.com/easychen/CookieCloud
 *
 * 我们可以利用它的API来作为一个简单的备份服务器。
 * 需要配置：
 *   - url: CookieCloud 服务器地址
 *   - uuid: 你在该 CookieCloud 的身份识别信息，注意，插件仅同步已添加站点的cookies，所以尽量和该 CookieCloud 上使用的其他 uuid 不同
 *   - password: CookieCloud 下用于加解密的密码，
 * 注意：
 *  1. CookieCloud 不支持历史记录，所以 list 方法只返回当前的情况
 *  2. CookieCloud 不支持删除记录，当调用 delete 时，我们会更新服务器数据为 { cookie_data: {} }
 *  3. 我们不向 CookieCloud 提供 local_storage_data，实际上 我们提交的数据格式为 { cookie_data, ptd_data, metadata }
 *     这样可以 在为其他需要 CookieCloud 支持的环境提供直接支持的同时，存储插件独有的数据
 *  4. 使用公用 CookieCloud 可能存在数据丢失、泄露的风险，同时 CookieCloud Server 也有备份文件大小的限制
 */

import CryptoJS from "crypto-js";
import axios, { AxiosRequestConfig } from "axios";
import AbstractBackupServer from "../AbstractBackupServer.ts";
import { getBackupRequestTimeout, validateBackupPayload } from "../utils";
import { logMessage } from "@ptd/site/utils/adapter.ts";
import type {
  IBackupConfig,
  IBackupData,
  IBackupFileInfo,
  IBackupFileListOption,
  IBackupFileManifest,
  IBackupMetadata,
} from "../type.ts";

interface CookieCloudConfig extends IBackupConfig {
  config: {
    address: string;
    uuid: string;
    password: string;
    headers: string;
  };
}

export const serverConfig: CookieCloudConfig = {
  name: "CookieCloud",
  type: "CookieCloud",
  config: { address: "https://cookiecloud.example.com/", uuid: "", password: "", headers: "" },
};

export const serverMetaData: IBackupMetadata<CookieCloudConfig> = {
  description:
    "CookieCloud是一个和自架服务器同步Cookie的小工具，可以将浏览器的Cookie同步到手机和云端，它内置端对端加密。",
  requiredField: [
    { name: "地址", key: "address", type: "string" },
    {
      name: "UUID",
      key: "uuid",
      type: "string",
      description: "CookieCloud 的身份识别信息，建议不与其他已使用的UUID相同",
    },
    {
      name: "密码",
      key: "password",
      type: "string",
      description: "CookieCloud 后端强制加密，且不使用全局加密的密钥",
      secret: true,
    },
    {
      name: "Headers",
      key: "headers",
      type: "strings",
      description: "CookieCloud 的鉴权 Headers，如果没有，请留空。如果有，则一行一个，格式为 key: value",
    },
  ],
};

interface ICookieCloudManifest extends IBackupFileManifest {
  encryption: true;
  fileName: string;
  path: string;
  time: number;
  size: "N/A";
}

interface ICookieCloudFile {
  cookie_data: Record<string, chrome.cookies.Cookie[]>;
  local_storage_data: {};
  ptd_data: Omit<IBackupData, "manifest" | "cookies">;
  manifest: ICookieCloudManifest;
  integrity?: string;
  integritySalt?: string;
}

function cookieCloudIntegrityKey(password: string, salt: string): CryptoJS.lib.WordArray {
  return CryptoJS.PBKDF2(password, CryptoJS.enc.Base64.parse(salt), {
    keySize: 256 / 32,
    iterations: 100_000,
    hasher: CryptoJS.algo.SHA256,
  });
}

export default class CookieCloud extends AbstractBackupServer<CookieCloudConfig> {
  protected version = "0.0.1";

  /**
   * CookieCloud 只有一个数据对象（path 无意义），且每次 getFile 都要下载整份密文并做 AES 解密，
   * 而 list() 只需要 manifest 的几个字段。这里做进程内短 TTL 缓存，让 list() 与随后的恢复
   * （或同一次会话里的重复读取）复用同一次下载+解密结果。
   */
  private static fileCache = new Map<string, { createAt: number; promise: Promise<IBackupData> }>();
  private static readonly FILE_CACHE_TTL = 30e3;
  private static readonly FILE_CACHE_MAX_SIZE = 4;

  override get encryptionKey() {
    return this.userConfig.password!;
  }

  private get fileCacheKey(): string {
    return [this.userConfig.address, this.userConfig.uuid, this.userConfig.password].join("|");
  }

  private async request<T>(url: string, config: AxiosRequestConfig = {}) {
    const headers = {
      ...(config.headers ?? {}),
      "Content-Type": "application/json",
    };

    if (this.userConfig.headers?.trim().length > 0) {
      let extraHeaderPairs = this.userConfig.headers?.trim().split("\n");
      extraHeaderPairs.forEach((extraHeaderPair, index) => {
        let extraHeaderPairKV = String(extraHeaderPair).split(":");
        if (extraHeaderPairKV?.length > 1) {
          // @ts-expect-error
          // 原因：header 名来自用户配置文本，headers 对象没有字符串索引签名
          headers[extraHeaderPairKV[0]] = extraHeaderPairKV[1];
        }
      });
    }

    return axios.request<T>({
      baseURL: this.userConfig.address,
      url,
      timeout: getBackupRequestTimeout(this.userConfig),
      ...config,
      headers,
    });
  }

  public async ping(): Promise<boolean> {
    try {
      const pingResp = await this.request<string>("", { responseType: "text" });
      return pingResp.data?.includes("Hello World!API ROOT =") || false;
    } catch (e) {
      console?.warn(e);
    }
    return false;
  }

  public async addFile(fileName: string, file: IBackupData): Promise<boolean> {
    // 不就地修改传入的 file：缓存命中时 getFile() 会返回同一个对象引用，而上传失败并不会清空缓存，
    // 旧实现 `delete file.cookies` / `delete file.manifest` 会让之后的读取（以及别处对同一对象的复用）
    // 永远丢掉 cookies 与 manifest。这里改为解构出需要的部分，重新构造上传数据。
    const { cookies, manifest: fileManifest, ...ptdData } = file;

    const manifest = {
      ...(fileManifest ?? {}),
      encryption: true,
      fileName,
      path: "",
      size: "N/A",
      files: {}, // 这里我们制空，减少上传体积
    } as ICookieCloudManifest;

    const fileData: ICookieCloudFile = {
      cookie_data: cookies ?? {},
      local_storage_data: {}, // 我们不支持 local_storage_data
      ptd_data: ptdData, // 其他的数据直接放在 ptd_data 里
      manifest,
    };

    // 按照 CookieCloud 的流程对数据进行加密
    const theKey = CryptoJS.MD5(`${this.userConfig.uuid}-${this.userConfig.password}`).toString().substring(0, 16);
    fileData.integritySalt = CryptoJS.lib.WordArray.random(16).toString(CryptoJS.enc.Base64);
    fileData.integrity = CryptoJS.HmacSHA256(
      JSON.stringify({
        cookie_data: fileData.cookie_data,
        local_storage_data: fileData.local_storage_data,
        ptd_data: fileData.ptd_data,
        manifest: fileData.manifest,
      }),
      cookieCloudIntegrityKey(`${this.userConfig.uuid}-${this.userConfig.password}`, fileData.integritySalt),
    ).toString();
    const encryptedFileData = CryptoJS.AES.encrypt(JSON.stringify(fileData), theKey).toString();

    try {
      const updateResp = await this.request<{ action: "done" | "error" }>("/update", {
        method: "POST",
        data: { uuid: this.userConfig.uuid, encrypted: encryptedFileData },
      });
      if (updateResp.data.action === "done") {
        // 服务器数据已变化，作废本地短 TTL 缓存
        CookieCloud.fileCache.delete(this.fileCacheKey);
        return true;
      }
    } catch (e) {
      // P1-5：写入失败由返回值 false 表达，但必须记录原因（服务器不可达、uuid/password 错误、
      // 加密数据超过服务端体积限制等），否则用户只能看到「备份失败」而无法定位。
      logMessage("[CookieCloud] 上传备份数据失败", {
        uuid: this.userConfig.uuid,
        error: e instanceof Error ? e.message : String(e),
      });
    }

    return false;
  }

  public async deleteFile(path: string): Promise<boolean> {
    return await this.addFile("", { cookie: {} }); // 直接更新数据为 { cookie_data: {} }
  }

  public async getFile(path: string): Promise<IBackupData> {
    const cacheKey = this.fileCacheKey;
    const cached = CookieCloud.fileCache.get(cacheKey);
    if (cached && Date.now() - cached.createAt < CookieCloud.FILE_CACHE_TTL) {
      return await cached.promise;
    }

    const promise = this.fetchFile();

    CookieCloud.fileCache.set(cacheKey, { createAt: Date.now(), promise });
    if (CookieCloud.fileCache.size > CookieCloud.FILE_CACHE_MAX_SIZE) {
      const oldestKey = CookieCloud.fileCache.keys().next().value;
      if (oldestKey !== undefined && oldestKey !== cacheKey) {
        CookieCloud.fileCache.delete(oldestKey);
      }
    }

    try {
      return await promise;
    } catch (e) {
      // 失败不缓存，下一次调用重新下载
      if (CookieCloud.fileCache.get(cacheKey)?.promise === promise) {
        CookieCloud.fileCache.delete(cacheKey);
      }
      throw e;
    }
  }

  private async fetchFile(): Promise<IBackupData> {
    const fileResp = await this.request<{ encrypted: string }>(`/get/${this.userConfig.uuid}`);
    if (fileResp.data?.encrypted) {
      const theKey = CryptoJS.MD5(`${this.userConfig.uuid}-${this.userConfig.password}`).toString().substring(0, 16);
      const decrypted = CryptoJS.AES.decrypt(fileResp.data.encrypted, theKey).toString(CryptoJS.enc.Utf8);
      const parsed = JSON.parse(decrypted, (key, value) =>
        key === "__proto__" ? undefined : value,
      ) as ICookieCloudFile;

      if (parsed.integrity) {
        if (typeof parsed.integritySalt !== "string") {
          throw new Error("CookieCloud backup integrity salt is missing");
        }
        const expectedIntegrity = CryptoJS.HmacSHA256(
          JSON.stringify({
            cookie_data: parsed.cookie_data,
            local_storage_data: parsed.local_storage_data,
            ptd_data: parsed.ptd_data,
            manifest: parsed.manifest,
          }),
          cookieCloudIntegrityKey(`${this.userConfig.uuid}-${this.userConfig.password}`, parsed.integritySalt),
        ).toString();
        if (expectedIntegrity !== parsed.integrity) {
          throw new Error("CookieCloud backup integrity check failed");
        }
      }

      if (!parsed.ptd_data || typeof parsed.ptd_data !== "object" || Array.isArray(parsed.ptd_data)) {
        throw new Error("Invalid CookieCloud backup payload");
      }
      for (const [key, value] of Object.entries(parsed.ptd_data)) {
        const problem = validateBackupPayload(key, value);
        if (problem) {
          throw new Error(`Invalid CookieCloud backup field ${key}: ${problem}`);
        }
      }
      const retFile = parsed.ptd_data as IBackupData;
      retFile.cookies = parsed.cookie_data;

      // 重新构建 manifest.files
      const fileMap: Record<string, any> = {};
      for (const [key, value] of Object.entries(retFile)) {
        if (typeof value === "object") {
          fileMap[key] = true;
        }
      }

      retFile.manifest = parsed.manifest as ICookieCloudManifest;
      retFile.manifest.files = fileMap;

      // 尝试从响应头中解出 CookieCloud 的备份大小
      retFile.manifest.size = parseInt(<string>fileResp.headers?.["content-length"] ?? "0") || "N/A";

      return retFile;
    }

    throw new Error("No data found");
  }

  public async list(options: IBackupFileListOption = {}): Promise<IBackupFileInfo[]> {
    const list = [] as IBackupFileInfo[];

    // list() 与恢复流程共用同一份 getFile 结果（短 TTL），避免为读 manifest 再全量下载+解密一次
    const file = await this.getFile("");
    if (file.manifest) {
      list.push({
        filename: file.manifest.fileName,
        path: "",
        time: file.manifest.time!,
        size: file.manifest.size ?? "N/A",
      });
    }

    return list;
  }
}
