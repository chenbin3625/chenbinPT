import { intersection, isEqual, toMerged } from "es-toolkit";
import { formatDate } from "date-fns";
import { entityList, getBackupServer, getBackupServerMetaData, IBackupData, IBackupFileInfo } from "@ptd/backupServer";
import {
  backupDataToJSZipBlob,
  getBackupFilename,
  hasBackupRetentionToApply,
  isBackupFilename,
  pruneBackupFiles,
  replaceDownloadHistory,
} from "@ptd/backupServer/utils.ts";
import AbstractBackupServer from "@ptd/backupServer/AbstractBackupServer.ts";

import { onMessage, sendMessage } from "@/messages.ts";
import type { IExtensionStorageSchema, TExtensionStorageKey } from "@/storage.ts";
import { BackupFields } from "@/shared/types.ts";
import type {
  IRestoreOptions,
  IRestoreReport,
  IMetadataPiniaStorageSchema,
  TBackupFields,
  TBackupServerKey,
  IConfigPiniaStorageSchema,
  TUserInfoStorageSchema,
} from "@/shared/types.ts";

import { logger } from "./logger.ts";
import { releaseBlobUrlWhenDownloadSettled } from "./download.ts";
import { ptdIndexDb } from "../adapter/indexdb.ts";

export const storageKey = [
  "config",
  "metadata",
  "userInfo",
  "searchResultSnapshot",
  "keepUploadTask",
] as TExtensionStorageKey[];

export async function createBackupData(backupFields: TBackupFields[] = []): Promise<IBackupData> {
  const backupData: IBackupData = {};

  // 备份已添加站点的Cookie
  if (backupFields.includes("cookies")) {
    const cookies = {} as Required<IBackupData>["cookies"];
    const siteHostMap =
      ((await sendMessage("getExtStoragePath", {
        key: "metadata",
        path: "siteHostMap",
        defaultValue: {},
      })) as Record<string, string>) ?? {};

    // 每个 host 一条消息，串行会明显拖慢备份；这里做有界并发（见 docs/performance-audit.md P2-8）
    const siteHosts = Object.keys(siteHostMap);
    const COOKIE_CONCURRENCY = 5;
    for (let i = 0; i < siteHosts.length; i += COOKIE_CONCURRENCY) {
      const batch = siteHosts.slice(i, i + COOKIE_CONCURRENCY);
      const results = await Promise.all(
        batch.map(async (siteHost) => ({
          siteHost,
          cookies: await sendMessage("getAllCookies", { domain: siteHost }),
        })),
      );
      for (const { siteHost, cookies: siteHostCookies } of results) {
        if (siteHostCookies.length > 0) {
          cookies[siteHost] = siteHostCookies;
        }
      }
    }

    backupData.cookies = cookies;
  }

  // 处理直接从 chrome.storage.local 读取的字段
  for (const field of storageKey) {
    if (backupFields.includes(field as TBackupFields)) {
      backupData[field] = await sendMessage("getExtStorage", field);
    }
  }

  // 备份下载历史
  if (backupFields.includes("downloadHistory")) {
    backupData["downloadHistory"] = await (await ptdIndexDb).getAll("download_history");
  }

  backupData.manifest = {
    time: new Date().getTime(),
    version: `chenbinPT (${__EXT_VERSION__})`,
  };

  logger({
    msg: `A Backup data created at ${formatDate(backupData.manifest.time!, "yyyy-MM-dd HH:mm:ss")}`,
    data: Object.keys(backupData),
  });
  return backupData;
}

export async function getBackupServerInstance(backupServerId: TBackupServerKey): Promise<AbstractBackupServer<any>> {
  logger({ msg: `Get backup server instance for ID: ${backupServerId}` });
  const metadataStore = (await sendMessage("getExtStorage", "metadata")) as IMetadataPiniaStorageSchema;
  const backupServerConfig = metadataStore.backupServers[backupServerId];
  return await getBackupServer(backupServerConfig);
}

/**
 * 依据备份服务器的保留策略清理历史备份文件
 *
 * - `keepFilename`：本次刚刚上传的备份文件名，永远不会被清理（避免因服务器端 `list()` 结果滞后或时钟偏差而删除刚创建的备份）
 * - 注意：`list()` 返回的备份列表可能包含非本插件创建的文件，因此我们仅处理文件名符合
 *   `PTD_backup_yyyyMMddTHHmm.zip`（由 `getBackupFilename()` 生成）规则的文件，避免误删用户的其他数据。
 */
export async function applyBackupRetention(
  backupServerId: TBackupServerKey,
  keepFilename?: string,
): Promise<IBackupFileInfo[]> {
  const metadataStore = (await sendMessage("getExtStorage", "metadata")) as IMetadataPiniaStorageSchema;
  const retention = metadataStore.backupServers[backupServerId]?.retention;

  if (!hasBackupRetentionToApply(retention)) {
    return [];
  }

  const backupServerInstance = await getBackupServerInstance(backupServerId);
  const list = (await backupServerInstance.list()) ?? [];

  const backupFiles = list.filter((item) => isBackupFilename(item.filename)).sort((a, b) => b.time - a.time); // 按备份时间从新到旧排序
  const [candidates] = pruneBackupFiles(backupFiles, retention);
  const deletedFiles = candidates.filter((item) => item.filename !== keepFilename);

  const actuallyDeletedFiles: IBackupFileInfo[] = [];
  for (const file of deletedFiles) {
    try {
      if (await backupServerInstance.deleteFile(file.path)) {
        actuallyDeletedFiles.push(file);
      }
    } catch (e) {
      logger({
        msg: `Failed to delete expired backup [${file.filename}] of [${backupServerId}]: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }

  if (actuallyDeletedFiles.length > 0) {
    logger({
      msg: `Retention policy removed ${actuallyDeletedFiles.length} of ${backupFiles.length} backup(s) of [${backupServerId}]`,
      data: { deleted: actuallyDeletedFiles.map((item) => item.filename) },
    });
  }

  return actuallyDeletedFiles;
}

onMessage("applyBackupRetention", async ({ data: { backupServerId, keepFilename } }) => {
  return await applyBackupRetention(backupServerId, keepFilename);
});

export async function exportBackupData(
  backupServerId: string | "local",
  backupFields: TBackupFields[] = [],
): Promise<boolean> {
  const backupData = await createBackupData(backupFields);
  const backupFilename = getBackupFilename();

  const configStore = (await sendMessage("getExtStorage", "config")) as IConfigPiniaStorageSchema;
  const encryptionKey = configStore?.backup?.encryptionKey ?? "";

  logger({ msg: `Exporting backup data to ${backupServerId}`, data: { backupFields, backupFilename } });
  if (backupServerId === "local") {
    const jsZipBlob = await backupDataToJSZipBlob(backupData, encryptionKey);
    // blob: URL 必须释放（见 L-5）：早期实现在这里**从不** revoke，每导出一次本地备份就泄漏一份 zip 的内存。
    // 下载被接受后交给释放器，等下载读完（或超时兜底）再 revoke。
    const blobUrl = URL.createObjectURL(jsZipBlob);
    try {
      const chromeDownloadId = await sendMessage("downloadFile", {
        url: blobUrl,
        filename: backupFilename,
        conflictAction: "uniquify",
      });
      releaseBlobUrlWhenDownloadSettled(blobUrl, chromeDownloadId);
    } catch (e) {
      // 下载未被接受：没有别的地方会再引用这个 blob，立即释放
      URL.revokeObjectURL(blobUrl);
      throw e;
    }
    return true;
  } else {
    const backupServerInstance = await getBackupServerInstance(backupServerId);
    backupServerInstance.setEncryptionKey(encryptionKey);
    const backupStatus = await backupServerInstance.addFile(backupFilename, backupData);

    // 更新最后一次备份时间
    if (backupStatus) {
      // 只写 lastBackupAt 这一条路径，由 service worker 内部串行完成「读 → 改 → 写」。
      // 原先的 getExtStorage + 改整份对象 + setExtStorage 是跨上下文读改写：与 options 侧保存站点/下载器、
      // 用户信息刷新等并发时会用旧快照覆盖掉对方刚写入的数据。
      await sendMessage("patchExtStoragePath", {
        key: "metadata",
        path: ["backupServers", backupServerId, "lastBackupAt"],
        value: new Date().getTime(),
      });

      // 备份成功后，按照保留策略清理历史备份
      await applyBackupRetention(backupServerId, backupFilename).catch((e) => {
        logger({
          msg: `Failed to apply the backup retention policy of [${backupServerId}]: ${e instanceof Error ? e.message : String(e)}`,
        });
      });
    }

    return backupStatus;
  }
}

onMessage("exportBackupData", async ({ data: { backupServerId, backupFields } }) => {
  return await exportBackupData(backupServerId, backupFields);
});

/**
 * 恢复结果报告（见 S-1 / L-10）：哪些字段写入成功、哪些被跳过/被安全化。
 *
 * 类型定义在 `@/shared/types.ts` —— 报告要跨上下文回传给 UI（`restoreBackupData` 消息的返回类型
 * 就是它），因此不能只留在 offscreen 侧；这里只做转发，保持既有导入方不受影响。
 */
export type { IRestoreReport };

/** 只认「非 null、非数组的对象」，用于校验来自备份文件（不可信）的结构 */
function isPlainObject(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** 协议里定义过的备份字段名（`BackupFields` 的运行时集合，用于把不可信字符串收窄成 `TBackupFields`） */
const BACKUP_FIELD_SET = new Set<string>(BackupFields);

function isBackupField(field: string): field is TBackupFields {
  return BACKUP_FIELD_SET.has(field);
}

function isRestorableCookies(value: unknown): value is Required<IBackupData>["cookies"] {
  return isPlainObject(value) && Object.values(value).every((cookies) => Array.isArray(cookies));
}

/**
 * metadata 的最小形状校验（见 S-1）。
 *
 * 只校验会导致后续代码崩溃或越权的关键结构：备份可以来自任何地方（他人分享的 zip），
 * 而恢复是直接整份写库，没有 schema 校验就等于把库交给备份文件。
 *
 * @returns 不合法时返回原因（调用方跳过整个字段），合法时返回 null
 */
function validateMetadataShape(metadata: unknown): string | null {
  if (!isPlainObject(metadata)) {
    return `expected a plain object, got ${Array.isArray(metadata) ? "array" : typeof metadata}`;
  }

  for (const key of [
    "sites",
    "solutions",
    "snapshots",
    "downloaders",
    "mediaServers",
    "backupServers",
    "lastUserInfo",
    "siteHostMap",
    "siteNameMap",
  ]) {
    const value = metadata[key];
    if (typeof value !== "undefined" && !isPlainObject(value)) {
      return `"${key}" must be an object, got ${Array.isArray(value) ? "array" : typeof value}`;
    }
  }

  return null;
}

/**
 * 安全化恢复进来的 metadata（见 S-1）。
 *
 * 三条规则：
 * 1. `backupServers` 默认不恢复，且**始终保留本机已有条目**——metadata 是整份写入，
 *    若直接用恢复数据里的 `backupServers`，本机配置会被静默删除（这也是「剥离该 key」不能写成 delete 的原因）。
 * 2. `type` 未注册的服务器条目直接丢弃（其构造会失败，且无法判断它是否可信）。
 * 3. 显式允许恢复时只导入不含凭据的配置，不覆盖本机现有服务器；
 *    恢复的服务器一律停用且没有自动上传字段。
 *
 * 说明：这里与任务描述有一处收敛——条目级问题（非法 type）按「安全化」处理而不是跳过整个 metadata 字段。
 * 理由是条目级问题只影响那一条服务器，不应让用户的站点/搜索方案/下载器整份恢复失败；
 * 顶层形状不合法（如 `sites` 是字符串）时仍然跳过整个字段，绝不写入半成品。
 */
async function sanitizeRestoredMetadata(
  restoredMetadata: IMetadataPiniaStorageSchema,
  options: { restoreBackupServers: boolean; report: IRestoreReport },
): Promise<IMetadataPiniaStorageSchema> {
  const { restoreBackupServers, report } = options;

  const existingMetadata = ((await sendMessage("getExtStorage", "metadata")) ?? {}) as IMetadataPiniaStorageSchema;
  const existingServers = existingMetadata.backupServers ?? {};
  const restoredServers = restoredMetadata.backupServers ?? {};

  const mergedServers: IMetadataPiniaStorageSchema["backupServers"] = { ...existingServers };

  if (!restoreBackupServers) {
    const restoredCount = Object.keys(restoredServers).length;
    if (restoredCount > 0) {
      report.sanitized.push(
        `backupServers: 默认不恢复（丢弃备份中的 ${restoredCount} 个服务器配置，保留本机的 ${Object.keys(existingServers).length} 个）`,
      );
    }
    return { ...restoredMetadata, backupServers: mergedServers };
  }

  for (const [restoredId, restoredServer] of Object.entries(restoredServers)) {
    if (!isPlainObject(restoredServer)) {
      report.sanitized.push(`backupServers["${restoredId}"]: 已丢弃（条目不是对象）`);
      continue;
    }

    const serverType = (restoredServer as { type?: unknown }).type;
    if (typeof serverType !== "string" || !entityList.includes(serverType)) {
      report.sanitized.push(
        `backupServers["${restoredId}"]: 已丢弃（type "${String(serverType)}" 不是已注册的备份服务器类型）`,
      );
      continue;
    }

    // 不可信备份不能通过同 ID 覆盖本机服务器（尤其不能覆盖本机密钥和已确认的自动备份设置）。
    if (Object.hasOwn(mergedServers, restoredId)) {
      report.sanitized.push(`backupServers["${restoredId}"]: 已跳过（与本机服务器 ID 冲突）`);
      continue;
    }

    // 复用本机相同「type + config」条目的 ID，避免同一台服务器出现重复条目（refs: issue #1024）
    const duplicatedEntry = Object.entries(existingServers).find(
      ([existingId, existingServer]) =>
        existingId !== restoredId && // ID 相同（自定义 ID 或同设备重复恢复）无需处理，直接以本机为准覆盖
        existingServer.type === serverType &&
        isEqual(existingServer.config, restoredServer.config),
    );
    const targetId = duplicatedEntry?.[0] ?? restoredId;
    if (duplicatedEntry) {
      report.sanitized.push(`backupServers["${restoredId}"]: 已跳过（本机已有相同的服务器）`);
      continue;
    }

    let serverMetaData: Awaited<ReturnType<typeof getBackupServerMetaData>>;
    try {
      serverMetaData = await getBackupServerMetaData(serverType);
    } catch {
      report.sanitized.push(`backupServers["${restoredId}"]: 已丢弃（无法验证备份服务器字段）`);
      continue;
    }
    const config = isPlainObject(restoredServer.config) ? restoredServer.config : {};
    const safeConfig: Record<string, string | number | boolean> = {};
    for (const field of serverMetaData.requiredField) {
      const key = String(field.key);
      const value = config[key];
      if (
        !field.secret &&
        !/pass(word|wd|key)?|secret|token|auth|credential/i.test(key) &&
        (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
      ) {
        safeConfig[key] = value;
      }
    }

    const sanitizedServer = {
      id: targetId,
      name: typeof restoredServer.name === "string" ? restoredServer.name : serverType,
      type: serverType,
      config: safeConfig,
      backupFields: [] as TBackupFields[],
      enabled: false,
    };
    report.sanitized.push(
      `backupServers["${targetId}"].backupFields: 已清空；凭据已剥离且自动备份已停用，请手工重新配置`,
    );

    mergedServers[targetId] = sanitizedServer;
  }

  return { ...restoredMetadata, backupServers: mergedServers };
}

/**
 * 恢复备份数据。
 *
 * 安全语义见 `IRestoreOptions.restoreBackupServers`（S-1）：默认 **不**恢复备份里的备份服务器配置，
 * 且即便显式要求恢复，也不采信备份里的 `backupFields`（上传字段不得由备份文件决定）。
 */
export async function restoreBackupData(
  restoreData: IBackupData, // 已经解密了的数据
  restoreOptions: IRestoreOptions = {},
): Promise<IRestoreReport> {
  const {
    fields = [],
    expandCookieMinutes = -1,
    keepExistUserInfo = true,
    restoreBackupServers = false,
  } = restoreOptions;

  const report: IRestoreReport = { success: false, restored: [], skipped: [], sanitized: [], rolledBack: false };

  const restoreDataExistFields = Object.keys(restoreData.manifest?.files ?? {});

  // 备份的 manifest.files 是**不可信输入**（他人分享的 zip）：先把键名收敛成协议定义过的字段，
  // 未知字段既不参与恢复、也不影响其它字段，只在报告里留痕（S-1）。
  const unknownBackupFields = restoreDataExistFields.filter((field) => !isBackupField(field));
  if (unknownBackupFields.length > 0) {
    report.sanitized.push(`备份 manifest 里的未知字段已被忽略: ${JSON.stringify(unknownBackupFields)}`);
  }

  const restoreFields: TBackupFields[] = intersection(fields, restoreDataExistFields).filter(isBackupField);
  let cookiesToRestore: Required<IBackupData>["cookies"] | undefined;
  if (restoreFields.includes("cookies")) {
    if (isRestorableCookies(restoreData.cookies)) {
      cookiesToRestore = restoreData.cookies;
    } else {
      report.skipped.push({ field: "cookies", reason: "invalid data in backup, local cookies kept" });
      logger({
        msg: `Skip restoring cookies: invalid data in backup (expected a record of cookie arrays, got ${typeof restoreData.cookies})`,
        level: "warn",
      });
    }
  }

  /**
   * 阶段 1：全部校验/构造到内存，**不写任何 key**（见 L-10）。
   *
   * 早期实现边遍历边 `setExtStorage`，任何一个字段中途失败（或校验不通过）都会留下
   * 「一半备份一半现状」的混合状态，且用户看不出哪些字段没恢复。现在先把待写入的内容全部算出来，
   * 校验不通过的字段只记报告、不写库。
   */
  type TPendingStorageWrite = {
    key: TExtensionStorageKey;
    value: IExtensionStorageSchema[TExtensionStorageKey];
    field: string;
  };

  const pendingWrites: TPendingStorageWrite[] = [];

  for (const field of storageKey.toReversed()) {
    if (!restoreFields.includes(field as TBackupFields)) {
      continue;
    }

    let fieldData = restoreData[field] as IExtensionStorageSchema[typeof field];
    if (!fieldData) {
      report.skipped.push({ field, reason: "empty value in backup" });
      continue;
    }

    if (field === "userInfo" && keepExistUserInfo) {
      const userInfoStore = ((await sendMessage("getExtStorage", "userInfo")) ?? {}) as TUserInfoStorageSchema;
      fieldData = toMerged(fieldData, userInfoStore);
    }

    if (field === "config") {
      // M-19：备份加密密钥一律沿用本机的，不接受备份文件里的值。
      // 恢复他人分享的备份时，若把 config.backup.encryptionKey 换成对方已知的值，之后所有自动备份
      // 都会用这把密钥加密 —— 配合任何一条上传通道，对方就能解开本机凭据。本机未设置时保持未设置。
      const localConfig = (await sendMessage("getExtStorage", "config")) as IConfigPiniaStorageSchema | undefined;
      const restoredConfig = fieldData as IConfigPiniaStorageSchema;
      const backupKey = restoredConfig?.backup?.encryptionKey;
      const localKey = localConfig?.backup?.encryptionKey;
      if (isPlainObject(restoredConfig?.backup) && backupKey !== localKey) {
        fieldData = {
          ...restoredConfig,
          backup: { ...restoredConfig.backup, encryptionKey: localKey ?? "" },
        } as IExtensionStorageSchema[typeof field];
        report.sanitized.push("config.backup.encryptionKey：沿用本机的备份加密密钥，未采用备份文件中的值");
      }
    }

    if (field === "metadata") {
      const validationError = validateMetadataShape(fieldData);
      if (validationError) {
        report.skipped.push({ field, reason: validationError });
        logger({ msg: `Skip restoring metadata: ${validationError}`, level: "warn" });
        continue;
      }
      fieldData = (await sanitizeRestoredMetadata(fieldData as IMetadataPiniaStorageSchema, {
        restoreBackupServers,
        report,
      })) as IExtensionStorageSchema[typeof field];
    }

    pendingWrites.push({ key: field, value: fieldData, field });

    /**
     * 恢复 metadata 后必须同步重建 siteIndex（见 docs/performance-audit.md P2-17 的独立索引 key）。
     *
     * content script / 右键菜单只有在 siteIndex 缺失时才会回落到 metadata（见 content-script/index.ts），
     * 而 background/utils/siteIndex.ts 只在启动时「按需生成缺失的索引」、不会覆盖已存在的 key；
     * 若不重建，恢复后站点 host/name 索引仍是恢复前那份，会挂错站点或不挂载。
     * 这里按**安全化之后**的 metadata 派生（与 siteIndex.ts 的派生规则一致），不修改 siteIndex.ts 本身。
     */
    if (field === "metadata") {
      const restoredMetadata = fieldData as IMetadataPiniaStorageSchema;
      pendingWrites.push({
        key: "siteIndex",
        value: {
          siteHostMap: restoredMetadata.siteHostMap ?? {},
          siteNameMap: restoredMetadata.siteNameMap ?? {},
        },
        field: "siteIndex",
      });
    }
  }

  /**
   * 阶段 2：写入前快照旧值。
   *
   * 拿不到快照的 key 一律不写：没有快照就无法回滚，宁可不恢复该字段（记进报告）。
   */
  const snapshots = new Map<TExtensionStorageKey, IExtensionStorageSchema[TExtensionStorageKey]>();
  for (const { key, field } of pendingWrites) {
    if (snapshots.has(key)) {
      continue;
    }
    try {
      snapshots.set(key, await sendMessage("getExtStorage", key));
    } catch (e) {
      report.skipped.push({
        field,
        reason: `failed to snapshot current value: ${e instanceof Error ? e.message : String(e)}`,
      });
      logger({ msg: `Skip restoring ${field}: failed to snapshot current value`, level: "warn" });
    }
  }

  /**
   * 阶段 3：顺序写入；任一步失败则按相反顺序回滚已写入的 key（见 L-10）。
   */
  const written: Array<{
    key: TExtensionStorageKey;
    snapshot: IExtensionStorageSchema[TExtensionStorageKey];
    field: string;
  }> = [];
  try {
    for (const { key, value, field } of pendingWrites) {
      if (!snapshots.has(key)) {
        continue; // 阶段 2 已记录跳过原因
      }

      await sendMessage("setExtStorage", { key, value });
      written.push({ key, snapshot: snapshots.get(key)!, field });
      report.restored.push(field);
    }

    // 最后替换 IndexedDB 历史：该操作自身是原子事务，失败时上面的 storage 写入仍可回滚。
    if (restoreFields.includes("downloadHistory")) {
      const db = await ptdIndexDb;
      const restored = await replaceDownloadHistory(
        () => db.transaction("download_history", "readwrite"),
        restoreData.downloadHistory,
      );
      if (restored) {
        report.restored.push("downloadHistory");
      } else {
        report.skipped.push({ field: "downloadHistory", reason: "invalid data in backup, local history kept" });
        logger({
          msg: `Skip restoring download history: invalid data in backup (expected an array, got ${typeof restoreData.downloadHistory})`,
        });
      }
    }
    report.success = true;
  } catch (e) {
    logger({
      msg: `Failed to restore storage fields, rolling back ${written.length} written key(s)`,
      level: "error",
      data: e instanceof Error ? e.message : String(e),
    });

    let rollbackOk = true;
    const failedRollbackFields: string[] = [];
    for (const { key, snapshot, field } of written.toReversed()) {
      try {
        await sendMessage("setExtStorage", { key, value: snapshot });
      } catch (rollbackError) {
        rollbackOk = false;
        failedRollbackFields.push(field);
        logger({
          msg: `Failed to roll back ${field} after a failed restore`,
          level: "error",
          data: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
        });
      }
    }
    report.rolledBack = rollbackOk;
    report.restored = failedRollbackFields;
    report.success = false;
  }

  // 报告「跳过/安全化」的细节，便于定位「恢复后为什么少了一些东西」
  if (report.skipped.length > 0 || report.sanitized.length > 0) {
    logger({
      msg: `Restore finished with sanitization: ${report.restored.length} field(s) restored, ${report.skipped.length} skipped, ${report.sanitized.length} sanitized`,
      data: { restored: report.restored, skipped: report.skipped, sanitized: report.sanitized },
    });
  }

  if (!report.success) {
    return report; // 写入失败（已回滚）：不再恢复 Cookie，避免在一个失败的恢复上继续叠加改动
  }

  // 恢复已添加站点的Cookie
  if (cookiesToRestore) {
    const now = new Date().getTime() / 1000;

    const allCookies = Object.values(cookiesToRestore).flatMap((cookieData) => cookieData);
    const COOKIE_RESTORE_CONCURRENCY = 8;
    for (let i = 0; i < allCookies.length; i += COOKIE_RESTORE_CONCURRENCY) {
      await Promise.all(
        allCookies.slice(i, i + COOKIE_RESTORE_CONCURRENCY).map(async (cookie) => {
          // 延长 cookie 过期时间
          if (expandCookieMinutes > 0) {
            cookie.expirationDate = Math.max(cookie.expirationDate ?? 0, now) + expandCookieMinutes * 60;
          }

          await sendMessage("setCookie", cookie as unknown as chrome.cookies.SetDetails);
        }),
      );
    }
    report.restored.push("cookies");
  }

  return report;
}

onMessage("restoreBackupData", async ({ data: { restoreData, restoreOptions = {} } }) => {
  // 直接把结构化报告回传给 UI：S-1 的安全提示（哪些字段被跳过、哪些被安全化）必须让用户看到，
  // 只回传 success 的话这条提示等于不存在（options 侧日志查看器已移除、offscreen 日志无人读取）。
  // 另注：本消息是**写类消息**，按 B-9 的裁决不在自动重试白名单里（重复执行会覆盖用户配置）。
  return await restoreBackupData(restoreData, restoreOptions);
});

export async function getBackupHistory(backupServerId: string): Promise<IBackupFileInfo[]> {
  const backupServerInstance = await getBackupServerInstance(backupServerId);
  return await backupServerInstance.list();
}

onMessage("getBackupHistory", async ({ data: backupServerId }) => {
  return await getBackupHistory(backupServerId);
});

export async function deleteBackupHistory(backupServerId: string, path: string): Promise<boolean> {
  const backupServerInstance = await getBackupServerInstance(backupServerId);
  return await backupServerInstance.deleteFile(path);
}

onMessage("deleteBackupHistory", async ({ data: { backupServerId, path } }) => {
  return await deleteBackupHistory(backupServerId, path);
});

export async function getRemoteBackupData(
  backupServerId: string,
  path: string,
  decryptKey: string = "",
): Promise<IBackupData> {
  const backupServerInstance = await getBackupServerInstance(backupServerId);
  backupServerInstance.setEncryptionKey(decryptKey);
  return await backupServerInstance.getFile(path);
}

onMessage("getRemoteBackupData", async ({ data: { backupServerId, path, decryptKey = "" } }) => {
  return await getRemoteBackupData(backupServerId, path, decryptKey);
});
