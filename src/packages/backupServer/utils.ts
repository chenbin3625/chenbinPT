import JSZip from "jszip";
import CryptoJS from "crypto-js";
import PQueue from "p-queue";
import { formatDate, isValid, parse } from "date-fns";
import { EListOrderBy, EListOrderMode } from "./type";
import type {
  IBackupData,
  IBackupFileInfo,
  IBackupFileListOption,
  IBackupFileManifest,
  IBackupRetention,
  IBackupRetentionSampleRule,
} from "./type";
import { omit } from "es-toolkit";

import { createZipBlob } from "./zipStream.ts";

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
const BACKUP_CIPHER_PREFIX = "PTD-AES-HMAC-v1:";
const BACKUP_KDF_ITERATIONS = 100_000;

/** 恢复备份时逐文件解密/校验的并发上限（有界并发，避免大备份串行阻塞、也避免一次读入全部文件） */
const RESTORE_FILE_CONCURRENCY = 4;

/**
 * 备份服务器请求的默认超时（毫秒）。
 * 各 entity 之前都没有设置 timeout（axios 默认 0 = 永不超时），慢链路/对端挂死时会让备份流程永久 pending。
 */
export const DEFAULT_BACKUP_REQUEST_TIMEOUT = 60e3;

/** 备份服务器请求的超时时间：优先使用服务器配置里的数值 timeout，否则使用默认的 60s */
export function getBackupRequestTimeout(userConfig?: Record<string, any>): number {
  const configured = userConfig?.timeout;
  return typeof configured === "number" && configured > 0 ? configured : DEFAULT_BACKUP_REQUEST_TIMEOUT;
}

/** 时间窗口采样的默认规则（仅用于 UI 提示），单位为天 */
export const DEFAULT_BACKUP_RETENTION_SAMPLE_RULES = {
  day: { interval: 1, horizon: 7 },
  week: { interval: 7, horizon: 4 },
  month: { interval: 30, horizon: 6 },
  year: { interval: 365, horizon: 2 },
} as const satisfies Record<string, IBackupRetentionSampleRule>;

/** 一条保留规则 */
type TBackupRetentionPlan =
  | { type: "age"; keepAfter: number } // 保留 `keepAfter` 之后的全部备份
  | { type: "window"; interval: number; horizon: number; end: number }; // 保留若干时间窗口内各最新的一份备份

/**
 * 将用户配置的保留策略展开为一组有序的规则，顺序与 Borg 的 prune 语义一致：
 * 先按「按时间期限保留」整段保留，再按窗口宽度从大到小依次采样。
 *
 * 同一份备份只要被任意一条规则命中，就一定会被保留，
 * 因此叠加多条规则得到的清理结果总是「比单条规则更保守」的。
 *
 * @returns 若返回空数组，说明当前保留策略不会清理任何备份
 */
function getBackupRetentionPlan(retention?: IBackupRetention, now: number = Date.now()): TBackupRetentionPlan[] {
  const plans: TBackupRetentionPlan[] = [];

  const maxAge = retention?.time?.enabled ? (retention.time.maxAge ?? 0) : 0;
  if (maxAge > 0) {
    // 时间期限内的备份全部保留
    plans.push({ type: "age", keepAfter: now - maxAge * MILLISECONDS_PER_DAY });
  }

  if (retention?.sample?.enabled) {
    const samplePlans = Object.values(retention.sample.rules ?? {})
      .filter((rule) => !!rule && rule.interval > 0 && rule.horizon > 0)
      .map((rule) => ({ type: "window", interval: rule.interval, horizon: rule.horizon, end: now }) as const);

    // 窗口宽度更大的规则优先级更高，从而先在更长的时间窗口内选出需要保留的备份
    samplePlans.sort((a, b) => b.interval - a.interval);
    plans.push(...samplePlans);
  }

  return plans;
}

/**
 * 判断是否配置了会实际生效的保留策略（按时间期限 / 按数量 / 时间窗口采样）
 */
export function hasBackupRetentionToApply(retention?: IBackupRetention): boolean {
  if (retention?.time?.enabled && (retention.time.maxAge ?? 0) > 0) {
    return true;
  }
  if (retention?.count?.enabled && (retention.count.maxCount ?? 0) > 0) {
    return true;
  }
  return !!(
    retention?.sample?.enabled &&
    Object.values(retention.sample.rules ?? {}).some((rule) => rule && rule.interval > 0 && rule.horizon > 0)
  );
}

/**
 * 备份文件名：`PTD_backup_<yyyyMMddTHHmm>.zip`（本地时间，精确到分钟）。
 *
 * 生成（`getBackupFilename`）与保留策略过滤（`isBackupFilename`）必须共用这里的同一份格式定义：
 * 历史实现中生成用 `formatDate(..., "yyyyMMdd'T'HHmm")`（13 位、含字母 T），
 * 过滤却写成 `/^PTD_backup_\d{16}\.zip$/`（16 位纯数字），两者不一致导致保留策略永远匹配不到任何备份，
 * 自动清理完全失效、远端历史备份无限累积。
 */
const BACKUP_FILENAME_PREFIX = "PTD_backup_";
const BACKUP_FILENAME_SUFFIX = ".zip";
const BACKUP_FILENAME_DATE_FORMAT = "yyyyMMdd'T'HHmm";

/** 按约定的格式生成备份文件名 */
export function getBackupFilename(date: Date = new Date()): string {
  return `${BACKUP_FILENAME_PREFIX}${formatDate(date, BACKUP_FILENAME_DATE_FORMAT)}${BACKUP_FILENAME_SUFFIX}`;
}

/**
 * 判断一个文件名是否为本插件生成的备份文件（保留策略只应处理自己创建的文件，避免误删用户数据）。
 *
 * 校验严格对齐生成格式：用同一个格式解析后，再把解析结果按同一个格式格式化回来做往返比对。
 * 不能只依赖 date-fns 的 `parse`：它对不完整的输入过于宽松（如 `20261004T021` 也会被解析成 02:01）。
 */
export function isBackupFilename(filename: string): boolean {
  if (!filename.startsWith(BACKUP_FILENAME_PREFIX) || !filename.endsWith(BACKUP_FILENAME_SUFFIX)) {
    return false;
  }

  const datePart = filename.slice(BACKUP_FILENAME_PREFIX.length, filename.length - BACKUP_FILENAME_SUFFIX.length);
  const parsed = parse(datePart, BACKUP_FILENAME_DATE_FORMAT, new Date(0));
  return isValid(parsed) && formatDate(parsed, BACKUP_FILENAME_DATE_FORMAT) === datePart;
}

/**
 * 根据保留策略挑选出需要清理的备份文件，返回 `[需要清理的备份, 需要保留的备份]`
 *
 * 传入的 `files` 需要按备份时间从新到旧排序（即 `AbstractBackupServer.list()` 的返回结果）。
 */
export function pruneBackupFiles(
  files: IBackupFileInfo[],
  retention?: IBackupRetention,
  now: number = Date.now(),
): [IBackupFileInfo[], IBackupFileInfo[]] {
  const plans = getBackupRetentionPlan(retention, now);
  const maxCount = retention?.count?.enabled ? (retention.count.maxCount ?? 0) : 0;

  // 未配置有效的保留策略，则不清理任何备份
  if (plans.length === 0 && maxCount <= 0) {
    return [[], files];
  }

  const keptPaths = new Set<string>();
  const keptFiles: IBackupFileInfo[] = [];

  const keep = (file?: IBackupFileInfo) => {
    if (file && !keptPaths.has(file.path)) {
      keptPaths.add(file.path);
      keptFiles.push(file);
    }
  };

  for (const plan of plans) {
    if (plan.type === "age") {
      // 按时间期限保留：期限内的备份全部保留（正好等于期限的备份视为已过期）
      files.filter((file) => file.time > plan.keepAfter).forEach(keep);
      continue;
    }

    // 时间窗口采样：从最近的窗口开始向前逐个窗口，每个窗口内只保留最新的一份备份。
    // 使用备份自身的 time 计算窗口编号，避免时区与夏令时带来的偏差。
    const windowSize = plan.interval * MILLISECONDS_PER_DAY;
    let bucket = Math.floor((plan.end - 1) / windowSize);
    for (let i = 0; i < plan.horizon; i++) {
      keep(files.find((file) => Math.floor(file.time / windowSize) === bucket));
      bucket -= 1;
    }
  }

  // 按数量保留：保留最新的 maxCount 份备份
  if (maxCount > 0) {
    files.slice(0, maxCount).forEach(keep);
  }

  const deletedFiles = files.filter((file) => !keptPaths.has(file.path));

  return [deletedFiles, keptFiles];
}

function deriveAuthenticatedKeys(encryptionKey: string, salt: CryptoJS.lib.WordArray) {
  const material = CryptoJS.PBKDF2(encryptionKey, salt, {
    keySize: 256 / 32,
    iterations: BACKUP_KDF_ITERATIONS,
    hasher: CryptoJS.algo.SHA256,
  });
  return {
    cipherKey: CryptoJS.HmacSHA256("backup-encryption", material),
    macKey: CryptoJS.HmacSHA256("backup-authentication", material),
  };
}

function macMatches(actual: string, expected: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(expected)) return false;
  let difference = 0;
  for (let i = 0; i < expected.length; i++) {
    difference |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return difference === 0;
}

/** AES-CBC + HMAC-SHA256 format; legacy AES/OpenSSL payloads remain readable. */
function encryptDataWithKey(data: any, encryptionKey?: string, field = ""): string {
  const stringifyData = JSON.stringify(data);
  if (!encryptionKey) {
    return stringifyData;
  }

  const salt = CryptoJS.lib.WordArray.random(16);
  const iv = CryptoJS.lib.WordArray.random(16);
  const { cipherKey, macKey } = deriveAuthenticatedKeys(encryptionKey, salt);
  const ciphertext = CryptoJS.AES.encrypt(stringifyData, cipherKey, { iv }).ciphertext.toString(CryptoJS.enc.Base64);
  const saltBase64 = salt.toString(CryptoJS.enc.Base64);
  const ivBase64 = iv.toString(CryptoJS.enc.Base64);
  const mac = CryptoJS.HmacSHA256(`${field}.${saltBase64}.${ivBase64}.${ciphertext}`, macKey).toString();

  return `${BACKUP_CIPHER_PREFIX}${JSON.stringify({ salt: saltBase64, iv: ivBase64, ciphertext, mac })}`;
}

export function encryptData(data: any, encryptionKey?: string, field = ""): string {
  return encryptDataWithKey(data, encryptionKey, field);
}

/**
 * `JSON.parse` 的 reviver：丢弃 `__proto__` 键。
 *
 * 备份文件是**不可信输入**（用户可能恢复他人分享的 zip）。`JSON.parse('{"__proto__":{"x":1}}')`
 * 会建出一个**自有**属性 `__proto__`，随后任何 `{...obj}` 展开或 `target["__proto__"] = v`
 * 赋值都会顺着原型链写到 `Object.prototype` 上（见审查报告 B-22 的实测）。
 * 在 JSON 边界上直接丢掉该键，比在每个消费点分别设防更可靠。
 */
function stripProtoKeys(key: string, value: unknown): unknown {
  if (key === "__proto__") {
    return undefined;
  }
  return value;
}

export function decryptData<T = any>(data: string, encryptionKey?: string, field = ""): T {
  if (data.startsWith(BACKUP_CIPHER_PREFIX)) {
    if (!encryptionKey) {
      throw new Error("Backup encryption key is required");
    }

    let envelope: { salt: string; iv: string; ciphertext: string; mac: string };
    try {
      envelope = JSON.parse(data.slice(BACKUP_CIPHER_PREFIX.length));
    } catch {
      throw new Error("Invalid encrypted backup envelope");
    }

    if (
      !envelope ||
      typeof envelope.salt !== "string" ||
      typeof envelope.iv !== "string" ||
      typeof envelope.ciphertext !== "string" ||
      typeof envelope.mac !== "string"
    ) {
      throw new Error("Invalid encrypted backup envelope");
    }
    const salt = CryptoJS.enc.Base64.parse(envelope.salt);
    const iv = CryptoJS.enc.Base64.parse(envelope.iv);
    if (salt.sigBytes !== 16 || iv.sigBytes !== 16) {
      throw new Error("Invalid encrypted backup envelope");
    }
    const { cipherKey, macKey } = deriveAuthenticatedKeys(encryptionKey, salt);
    const actualMac = CryptoJS.HmacSHA256(
      `${field}.${envelope.salt}.${envelope.iv}.${envelope.ciphertext}`,
      macKey,
    ).toString();
    if (!macMatches(actualMac, envelope.mac)) {
      throw new Error("Backup integrity/authentication check failed");
    }

    const decrypted = CryptoJS.AES.decrypt(
      { ciphertext: CryptoJS.enc.Base64.parse(envelope.ciphertext) } as CryptoJS.lib.CipherParams,
      cipherKey,
      { iv },
    ).toString(CryptoJS.enc.Utf8);
    return JSON.parse(decrypted, stripProtoKeys) as T;
  }

  // Legacy AES/OpenSSL payloads remain readable for existing backups.
  if (!encryptionKey) {
    return JSON.parse(data, stripProtoKeys);
  }
  const legacyKey = CryptoJS.MD5(encryptionKey).toString().substring(0, 16);
  const decrypted = CryptoJS.AES.decrypt(data, legacyKey).toString(CryptoJS.enc.Utf8);
  return JSON.parse(decrypted, stripProtoKeys) as T;
}

export async function backupDataToJSZipBlob(data: IBackupData, encryptionKey?: string): Promise<Blob> {
  const isEncrypted = typeof encryptionKey === "string" && encryptionKey !== "";

  const manifest = {
    ...(data.manifest ?? {}),
    encryption: isEncrypted,
    time: new Date().getTime(),
    files: {},
  } as IBackupFileManifest;

  delete data.manifest; // 确保 manifest 不会被重复添加到 zip 中

  /**
   * 逐条目产出（生成器 = 惰性）：边加密边产出，调用方决定是立即写进 zip 流
   * 还是交给 JSZip 持有。manifest 必须最后产出（它的 files[*].hash 依赖前面每个条目的内容）。
   */
  function* buildZipEntries(): Generator<{ name: string; content: string }> {
    for (const [key, value] of Object.entries(data)) {
      const fileName = `${key}.json`;
      const fileContent = encryptDataWithKey(value, encryptionKey, key);
      // 这里的 MD5 是备份格式的一部分（manifest.files[*].hash），恢复时会用于校验，因此必须计算一次
      manifest.files[key] = { name: fileName, hash: CryptoJS.MD5(fileContent).toString() };
      yield { name: fileName, content: fileContent };
    }
    yield { name: "manifest.json", content: JSON.stringify(manifest) };
  }

  // 两条路径都用自带的流式写出器：逐条目成 Blob（内容进入 blob 存储后即可释放 JS 堆引用），
  // 峰值 ≈ 单条条目，而不是「全部内容 + 整包输出」（见 docs/performance-audit.md P1-25）。
  // - 加密备份：条目是不可压缩的 base64 密文 → STORE
  // - 未加密备份：JSON 压缩收益明显 → raw deflate（CompressionStream，浏览器原生实现）
  // 产物仍是标准 ZIP（JSZip 等任意实现可读，已有测试覆盖恢复路径）。
  return await createZipBlob(buildZipEntries(), { compress: !isEncrypted });
}

const isPlainObject = (value: unknown): value is Record<string, any> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * 恢复时被拒绝/被安全化的条目说明（见 S-1）。
 *
 * 刻意用**非枚举**属性携带：`backupDataToJSZipBlob` 是用 `Object.entries(data)` 遍历顶层键
 * 来生成条目的，普通字段会被写回下一个备份；非枚举属性既不会被遍历到，也不影响 structured clone。
 */
const BACKUP_WARNINGS_KEY = "__backupWarnings";

export function getBackupWarnings(data: IBackupData): string[] {
  const value = (data as Record<string, unknown>)[BACKUP_WARNINGS_KEY];
  return Array.isArray(value) ? (value as string[]) : [];
}

export function setBackupWarnings(data: IBackupData, warnings: string[]): void {
  Object.defineProperty(data, BACKUP_WARNINGS_KEY, {
    value: warnings,
    enumerable: false,
    writable: true,
    configurable: true,
  });
}

/**
 * 备份条目的**结构**校验（S-1 的第一道防线）。
 *
 * 备份文件是不可信输入，这里只判断「形状对不对」，不代替恢复侧的策略判断
 * （例如「backupServers 默认不恢复」由 offscreen 侧依据 `IRestoreOptions.restoreBackupServers` 执行）。
 * 形状不符的条目会被**丢弃并记录原因**，而不是让整次恢复失败——既不静默接受脏数据，
 * 也不让一个字段的问题毁掉整份可用备份。
 */
export function validateBackupPayload(key: string, value: unknown): string | null {
  switch (key) {
    case "metadata": {
      if (!isPlainObject(value)) return "metadata 不是对象";
      for (const container of [
        "sites",
        "solutions",
        "snapshots",
        "downloaders",
        "mediaServers",
        "backupServers",
      ] as const) {
        const child = value[container];
        if (typeof child !== "undefined" && !isPlainObject(child)) {
          return `metadata.${container} 不是对象`;
        }
      }
      const servers = value.backupServers;
      if (isPlainObject(servers)) {
        for (const [id, server] of Object.entries(servers)) {
          if (!isPlainObject(server)) return `metadata.backupServers.${id} 不是对象`;
          if (typeof server.type !== "string") return `metadata.backupServers.${id} 缺少 type`;
          if (server.config !== undefined && !isPlainObject(server.config)) {
            return `metadata.backupServers.${id}.config 不是对象`;
          }
        }
      }
      return null;
    }
    // 以下 4 个都是 Record<..., ...> 形状的 storage 表
    case "config":
    case "userInfo":
    case "searchResultSnapshot":
    case "keepUploadTask":
      return isPlainObject(value) ? null : `${key} 不是对象`;
    case "cookies":
      return isPlainObject(value) ? null : "cookies 不是对象";
    case "downloadHistory":
      return Array.isArray(value) ? null : "downloadHistory 不是数组";
    default:
      // 未知字段不判断形状（保持前向兼容），但仍会经过 decryptData 的 __proto__ 剥离
      return null;
  }
}

export async function jsZipBlobToBackupData(blob: Blob, encryptionKey?: string): Promise<IBackupData> {
  const zip = new JSZip();
  const zipContent = await zip.loadAsync(blob);
  const data = {} as IBackupData;

  // 首先解出 manifest.json 的内容
  const manifest = await zipContent
    .file("manifest.json")
    ?.async("string")
    .then((content) => {
      // manifest 同样是不可信输入：走同一套 __proto__ 剥离
      return JSON.parse(content, stripProtoKeys) as IBackupFileManifest;
    });

  if (manifest?.files) {
    if (!manifest.encryption && encryptionKey) {
      encryptionKey = "";
    }

    // 只解出 manifest 中记录的其他文件；多文件的解压/解密/校验改为有界并发
    const manifestFiles = Object.entries(omit(manifest.files ?? {}, ["manifest"]));
    const decryptedFiles: Record<string, any> = {};
    const queue = new PQueue({ concurrency: RESTORE_FILE_CONCURRENCY });
    const warnings: string[] = [];

    await Promise.all(
      manifestFiles.map(([fileKey, manifestFileData]) =>
        queue.add(async () => {
          // manifest.files[*] 的形状同样来自不可信输入，先确认能安全解构
          if (!isPlainObject(manifestFileData) || typeof manifestFileData.name !== "string") {
            warnings.push(`${fileKey}：manifest 中的条目缺少合法的文件名，已跳过`);
            return;
          }
          const { name: fileName, hash: manifestFileHash } = manifestFileData;
          const fileContent = await zipContent.file(fileName)?.async("string");
          if (!fileContent) {
            return;
          }

          const fileContentHash = CryptoJS.MD5(fileContent).toString();
          if (fileKey != "manifest" && fileContentHash !== manifestFileHash) {
            throw new Error(`File hash mismatch for ${fileName}.`);
          }

          let payload: unknown;
          try {
            payload = decryptData(fileContent, encryptionKey, fileKey);
          } catch (e) {
            throw new Error(`Failed to decrypt file: ${fileName}`);
          }

          // S-1：结构校验。形状不符的条目直接丢弃并记录原因，避免把不可信结构写进
          // chrome.storage（尤其是 metadata.backupServers——它是「恢复后被自动上传到哪」的决定因素）。
          const problem = validateBackupPayload(fileKey, payload);
          if (problem) {
            warnings.push(`${fileKey}：${problem}，已跳过该条目`);
            return;
          }

          decryptedFiles[fileKey] = payload;
        }),
      ),
    );

    // 按 manifest 的顺序写回，保证恢复结果的 key 顺序与并发前一致
    for (const [fileKey] of manifestFiles) {
      if (fileKey in decryptedFiles) {
        data[fileKey] = decryptedFiles[fileKey];
      }
    }

    setBackupWarnings(data, warnings);

    data.manifest = manifest; // 将 manifest 也添加到数据中
  } else {
    throw new Error("Manifest not found in the zip file");
  }

  return data;
}

/**
 * 恢复下载历史所需的最小 IndexedDB 事务接口。
 *
 * 这里使用结构化类型而不是直接引用 `idb` 的 `IDBPDatabase`：backupServer 包不需要感知 offscreen 侧的数据库实例，
 * 同时让「原子替换」这段逻辑可以在单测里用轻量 mock 覆盖（无需真实 IndexedDB 环境）。
 */
export interface IDownloadHistoryTransaction {
  store: {
    clear(): Promise<unknown>;
    put(value: any): Promise<unknown>;
  };
  done: Promise<unknown>;
}

/**
 * 用备份中的记录原子替换本机下载历史。
 *
 * - 先校验数据类型：zip 中缺少某个文件时 `jsZipBlobToBackupData` 只会跳过该 key（manifest 里却仍有它的名字），
 *   因此 `downloadHistory` 可能是 undefined。旧实现在 `clear()` 之后才 `.map(...)`，会先把本机历史清空、
 *   再抛错且不回滚，属于不可恢复的数据丢失。
 * - `clear` 与全部 `put` 放在同一个事务里按顺序执行：任一步失败都会由 IndexedDB 整体回滚，
 *   不会留下「已清空但未写入」的中间态。
 *
 * @param openTransaction 事务工厂，只在数据校验通过后才会被调用（数据非法时不会触碰数据库）
 * @returns 数据非法（未实际写入）时返回 false
 */
export async function replaceDownloadHistory(
  openTransaction: () => IDownloadHistoryTransaction,
  downloadHistory: unknown,
): Promise<boolean> {
  if (!Array.isArray(downloadHistory)) {
    return false;
  }

  const tx = openTransaction();
  await Promise.all([tx.store.clear(), ...downloadHistory.map((item) => tx.store.put(item)), tx.done]);
  return true;
}

export function localSort(files: IBackupFileInfo[], options: IBackupFileListOption): IBackupFileInfo[] {
  if (files.length > 0) {
    const orderMode: EListOrderMode = options.orderMode ?? EListOrderMode.desc;
    const orderBy: EListOrderBy = options.orderBy ?? EListOrderBy.time;

    files.sort((a, b) => {
      let compareRep = 0;
      switch (orderBy) {
        case EListOrderBy.name:
          compareRep = a.filename.localeCompare(b.filename);
          break;
        case EListOrderBy.size:
          if (a.size === "N/A" && b.size === "N/A") {
            compareRep = 0;
          } else if (a.size === "N/A") {
            return 1;
          } else if (b.size === "N/A") {
            return -1;
          } else {
            compareRep = a.size - b.size;
          }
          break;

        case EListOrderBy.time:
        default:
          compareRep = a.time - b.time;
          break;
      }

      return orderMode === EListOrderMode.desc ? -compareRep : compareRep;
    });
  }

  return files;
}
