import { logMessage } from "@ptd/site/utils/adapter.ts";

import { IBackupConfig, IBackupData, IBackupFileInfo, IBackupFileListOption } from "./type.ts";
import {
  backupDataToJSZipBlob,
  decryptData,
  encryptData,
  getBackupRequestTimeout,
  jsZipBlobToBackupData,
} from "./utils.ts";

export default abstract class AbstractBackupServer<T extends IBackupConfig> {
  protected abstract version: string;

  protected config: T;
  protected _encryptionKey?: string;

  protected constructor(config: T) {
    this.config = config;
  }

  get userConfig(): T["config"] {
    return this.config.config;
  }

  // 默认情况下，我们使用 外部设置的加密密钥， subclass 可以覆写 从而使用 userConfig 等其他地方的值
  get encryptionKey() {
    return this._encryptionKey;
  }

  public setEncryptionKey(key: string): void {
    this._encryptionKey = key;
  }

  /**
   * 验证服务器可用性
   */
  public abstract ping(): Promise<boolean>;

  /**
   * 获取资源列表
   * @param options
   */
  public abstract list(options?: IBackupFileListOption): Promise<IBackupFileInfo[]>;

  public abstract addFile(fileName: string, file: IBackupData): Promise<boolean>;

  /**
   * 获取（下载）一个文件
   * @param path
   * @returns 返回一个 binary 数据
   */
  public abstract getFile(path: string): Promise<IBackupData>;

  public abstract deleteFile(path: string): Promise<boolean>;

  protected encryptData(data: any): string {
    return encryptData(data, this.encryptionKey);
  }

  protected decryptData<T = any>(data: string): T {
    return decryptData(data, this.encryptionKey);
  }

  protected async backupDataToJSZipBlob(data: IBackupData): Promise<Blob> {
    return await backupDataToJSZipBlob(data, this.encryptionKey);
  }

  protected async jsZipBlobToBackupData(blob: Blob): Promise<IBackupData> {
    return await jsZipBlobToBackupData(blob, this.encryptionKey);
  }

  /**
   * C2-B-2：统一的请求超时包装。
   *
   * 有些后端客户端不支持 timeout 选项（webdav@5 的 `createClient` 只有逐方法 `signal`），
   * 服务端挂死时请求会永远 pending，把自动备份锁一并卡死。这里用 AbortController 兜底：
   * 超时后 abort，由调用方 catch 并记录失败原因。
   */
  protected async withRequestTimeout<T>(
    executor: (signal: AbortSignal) => Promise<T>,
    timeout: number = getBackupRequestTimeout(this.userConfig),
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error(`[${this.config.type}] request timeout after ${timeout}ms`)),
      timeout,
    );
    try {
      return await executor(controller.signal);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * P1-5：失败必须记录原因。
   *
   * 各实体的 ping/addFile/deleteFile 用返回值 `false` 表达失败，但历史实现里 catch 直接吞掉异常，
   * 自动备份日志只能留下「returned false」，用户无法区分 401/403、地址填错、网络不可达还是配额超限。
   * 统一收敛到这里，避免再有实体漏掉（SERVERSSOCIAL-3）。
   */
  protected logBackupFailure(action: string, error: unknown): void {
    logMessage(`[${this.config.type}] ${action} 失败`, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
