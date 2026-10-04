/**
 * 此处存放一些 共享的类型定义，但是又不好归类到其他模块的类型定义
 */

import type { TBackupFields } from "./types/storages/metadata.ts";

// 代理转发所有 types 导出
export * from "./types/extends.ts";
export * from "./types/common/download.ts";
export * from "./types/common/nativeBridge.ts";
export * from "./types/storages/config.ts";
export * from "./types/storages/indexdb.ts";
export * from "./types/storages/metadata.ts";
export * from "./types/storages/runtime.ts";
export * from "./types/storages/other.ts";
export * from "./types/storages/keepUploadTask.ts";

export interface IRestoreOptions {
  fields?: TBackupFields[]; // 需要恢复的字段
  expandCookieMinutes?: number; // 是否延长 cookie 过期时间（单位：分钟），（小于0）表示不延长
  keepExistUserInfo?: boolean; // 是否保留现有的用户信息
  /**
   * 是否连备份里的 `metadata.backupServers`（备份服务器配置，含地址与凭据）一并恢复。
   *
   * **必须默认为 `false`**。见审查报告 S-1：恢复流程不校验备份内容，因此一份他人分享的
   * 备份 zip 可以植入一条指向攻击者 WebDAV/S3/Gist 的备份服务器记录（并带上
   * `enabled: true` + `backupInterval` + 攻击者挑选的 `backupFields`），随后自动备份会把
   * 本机的站点 passkey、会话 Cookie、下载器凭据**自动上传**到该端点。
   *
   * 因此：未显式传入（或传入 `false`）时必须剥离/停用备份中的备份服务器配置；
   * 只有用户在 UI 上明确确认后才可置为 `true`，且即便如此也不应采信备份里的
   * `backupFields`（上传字段应由本次会话决定）。
   */
  restoreBackupServers?: boolean;
}

/**
 * 备份恢复结果报告（见审查报告 S-1 / L-10）。
 *
 * 之所以放在共享类型里而不是留在 offscreen 侧：恢复的安全性提示必须能**跨上下文传到 UI**——
 * 「哪些字段被跳过、哪些被安全化」正是用户判断「这份备份是不是被人动过手脚」的唯一依据。
 * 若只写进日志（options 侧日志查看器已移除、offscreen 日志无人读取），这条提示等于不存在。
 */
export interface IRestoreReport {
  success: boolean;
  /** 实际写入成功的字段 */
  restored: string[];
  /** 被跳过的字段及原因（校验不通过、快照失败等） */
  skipped: Array<{ field: string; reason: string }>;
  /** 被安全化处理的说明（便于 UI 提示「备份里的某些内容没有被恢复」） */
  sanitized: string[];
  /** 写入中途失败时是否已成功回滚 */
  rolledBack: boolean;
}

export interface ILoggerItem {
  id?: string; // 日志 ID（自动生成）
  time?: number; // 日志时间（自动生成）
  level?: "log" | "trace" | "debug" | "info" | "warn" | "error"; // 日志级别（不传入时默认为 log）
  module?: string; // 产生该日志的模块
  msg: string; // 日志内容
  data?: any;
}
