import { logMessage } from "@ptd/site/utils/adapter.ts";

import { IBackupConfig, IBackupData, IBackupFileInfo, IBackupFileListOption } from "./type.ts";
import { backupDataToJSZipBlob, decryptData, encryptData, jsZipBlobToBackupData } from "./utils.ts";

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
