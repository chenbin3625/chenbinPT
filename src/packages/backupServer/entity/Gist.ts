/**
 * 使用 Github Gist 进行备份
 *
 *
 * 使用方法：
 *  1. 获取 gist_id： 在 https://gist.github.com/ 创建一个 secret gist 。
 *                   gist 的名称（为了方便辨识 可以填写 PTD backup） 和 文件内容 都任意填写即可，
 *                   你会获得 类似 https://gist.github.com/<userName>/<gist_id> 的地址
 *  2. 获取 access_token: 参照官方文档（ https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#creating-a-fine-grained-personal-access-token ）
 *                       创建一个 Fine-grained personal access tokens ， Repository access 为 Public repositories
 *                       并在下方 Permissions - Account permissions 中找到 Gists 并将其设置为 Read And Write
 *                       注意，根据你创建的 gist 用户设置 Resource owner 并 按照需要设置 Expiration
 *                       你会获得 以 github_pat_ 开头的字符串
 *
 * 注意：
 * 1. Gist 不支持删除历史记录，如果需要删除，请在 github 上手动删除对应 gist，并创建一个新的。
 */

import axios, { AxiosRequestConfig } from "axios";
import CryptoJS from "crypto-js";
import { omit } from "es-toolkit";
import AbstractBackupServer from "../AbstractBackupServer.ts";
import {
  getBackupRequestTimeout,
  BackupDowngradeError,
  localSort,
  decryptData,
  encryptData,
  setBackupWarnings,
  stripProtoKeys,
  validateBackupPayload,
} from "../utils.ts";
import { logMessage } from "@ptd/site/utils/adapter.ts";
import {
  IBackupConfig,
  IBackupData,
  IBackupFileInfo,
  IBackupFileListOption,
  IBackupFileManifest,
  IBackupMetadata,
} from "../type.ts";

interface GistConfig extends IBackupConfig {
  config: {
    gist_id: string;
    access_token: string;
  };
}

export const serverConfig: GistConfig = {
  name: "Gist",
  type: "Gist",
  config: { gist_id: "", access_token: "" },
};

export const serverMetaData: IBackupMetadata<GistConfig> = {
  description: "Gist 是 GitHub 提供的一个代码片段分享平台，支持文件存储和共享功能。",
  requiredField: [
    {
      name: "Gist ID",
      key: "gist_id",
      type: "string",
      description: "填入 https://gist.github.com/<userName>/<gist_id> 的地址中 gist_id 部分，创建一个 secret gist 即可",
    },
    {
      name: "Access Token",
      key: "access_token",
      type: "string",
      secret: true,
      description:
        "创建一个 Fine-grained personal access tokens ， Repository access 为 Public repositories 并在下方 Permissions - Account permissions 中找到 Gists 并将其设置为 Read And Write",
    },
  ],
};

interface IGistCommitHistory {
  committed_at: string;
  version: string;
  change_status: { total: number; additions: number; deletions: number };
}

interface IGistBackupFileManifest extends IBackupFileManifest {
  fileName: string;
}

export default class Gist extends AbstractBackupServer<GistConfig> {
  protected version = "0.0.1";

  /** C2-B-4：Gist 不支持删除历史，删除尝试的提示每个上下文只打一次 */
  private static warnedDeleteUnsupported = false;

  protected async request<T>(url: string, config: AxiosRequestConfig = {}) {
    const headers = {
      ...(config.headers ?? {}),
      Authorization: `Bearer ${this.userConfig.access_token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    return axios.request<T>({
      timeout: getBackupRequestTimeout(this.userConfig),
      ...config,
      baseURL: `https://api.github.com/gists/${this.userConfig.gist_id}`,
      url,
      headers,
    });
  }

  async ping(): Promise<boolean> {
    try {
      const pingReq = await this.request<{ url?: string }>("");
      return typeof pingReq.data?.url === "string";
    } catch (e) {
      // SERVERSSOCIAL-3（P1-5）：旧实现只写 console.warn，生产环境看不到；失败原因要能定位（gist_id/token 错误等）
      this.logBackupFailure("ping", e);
    }
    return false;
  }

  async list(options: IBackupFileListOption = {}): Promise<IBackupFileInfo[]> {
    const retFileList = [] as IBackupFileInfo[];

    // C2-B-4：GitHub `/commits` 是分页接口（per_page 最大 100）。旧实现只取第一页，
    // 备份超过 100 份后更早的版本在恢复对话框里直接消失。这里按页拉取，最多 1000 份（10 页）防止异常账号拖死请求。
    const PER_PAGE = 100;
    const MAX_PAGES = 10;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const listReq = await this.request<IGistCommitHistory[]>("/commits", {
        params: { per_page: PER_PAGE, page },
      });
      const commits = listReq.data ?? [];

      for (const datum of commits) {
        // 假定了 每次更新记录 都会产生 deletions， 如果 deletions = 0 则说明是 第一次创建，应该过滤掉 （实际并不一定）
        if (datum.change_status?.deletions > 0) {
          retFileList.push({
            filename: datum.version,
            path: datum.version,
            time: new Date(datum.committed_at).getTime(),
            size: "N/A",
          });
        }
      }

      if (commits.length < PER_PAGE) break;
    }

    return localSort(retFileList, options);
  }

  async addFile(fileName: string, file: IBackupData): Promise<boolean> {
    // SERVERSSOCIAL-2：不再用非机密的 gist_id 派生「默认加密」密钥（旧实现等于用字面量 `|<gist_id>`
    // 当口令，知道 gist 链接的人都能解密，而 manifest 仍宣称 encryption: true）。
    // 未设置备份加密密钥时如实退化为明文 JSON（与 backupDataToJSZipBlob 的 zip 路径一致），
    // 并在 manifest 里写 encryption: false，不再伪造「已加密」。
    const hasEncryptionKey = typeof this.encryptionKey === "string" && this.encryptionKey !== "";
    if (!hasEncryptionKey) {
      // SERVERSSOCIAL-2：明文上传必须留痕，避免用户以为 gist 上的备份受密钥保护
      logMessage("[Gist] 未设置备份加密密钥，本次备份将以明文 JSON 上传", undefined, "warn");
    }

    let patchFile = {} as Record<string, { content: string } | null>;

    const manifest = {
      version: `${this.config.type} (${this.version})`,
      time: new Date().getTime(),
      ...(file.manifest ?? {}),

      encryption: hasEncryptionKey,
      fileName,
      files: {},
    } as IGistBackupFileManifest;

    const writeFile = {} as Record<string, { content: string } | null>;
    // SERVERSSOCIAL-6：backupData 里一定带 manifest，它只是元数据、不是可恢复条目；
    // 不排除就会额外生成 manifest.txt 并登记进 manifest.files，恢复时被当成未知字段。
    for (const [key, value] of Object.entries(omit(file, ["manifest"]))) {
      const writeFileName = `${key}.${manifest.encryption ? "txt" : "json"}`;
      const fileContent = hasEncryptionKey ? encryptData(value, this.encryptionKey, key) : JSON.stringify(value);
      manifest.files[key] = { name: writeFileName, hash: CryptoJS.MD5(fileContent).toString() };
      writeFile[writeFileName] = { content: fileContent };
    }

    patchFile["_manifest.json"] = { content: JSON.stringify(manifest, null, 2) };
    patchFile = { ...patchFile, ...writeFile };

    try {
      const currentGistStatus = await this.request<{ files: Record<string, { content: string }> }>("");
      const currentGistFileKeys = Object.keys(currentGistStatus.data?.files ?? {});

      // 如果用户初次编辑的时候添加了任意的文件，我们需要进行删除，不然会遗留了不需要的文件
      for (const currentGistFileKey of currentGistFileKeys) {
        if (typeof patchFile[currentGistFileKey] === "undefined" && !currentGistFileKey.includes(".keep.")) {
          patchFile[currentGistFileKey] = null;
        }
      }

      await this.request("", {
        method: "PATCH",
        data: {
          description: fileName,
          files: patchFile,
        },
      });
      return true;
    } catch (e) {
      // SERVERSSOCIAL-3（P1-5）：上传失败必须留下原因（token 权限不足、gist 被删、网络中断等）
      this.logBackupFailure("addFile", e);
      return false;
    }
  }

  async getFile(path: string): Promise<IBackupData> {
    const {
      data: { files = {} },
    } = await this.request<{ files: Record<string, { content: string; truncated: boolean; raw_url: string }> }>(
      `/${path}`,
    );

    const fileManifestContent = files?.["_manifest.json"]?.content;
    if (!fileManifestContent) {
      throw new Error("This file is not valid.");
    }

    const result = {} as IBackupData;
    const warnings: string[] = [];

    // SERVERSSOCIAL-5：_manifest.json 是不可信输入（他人分享/被篡改的 gist），
    // 与 zip 路径 jsZipBlobToBackupData 对齐，解析时剥离 __proto__
    const manifest = JSON.parse(fileManifestContent, stripProtoKeys) as IGistBackupFileManifest;
    for (const [key, value] of Object.entries((manifest.files ?? {}) as Record<string, unknown>)) {
      // manifest.files[*] 的形状同样来自不可信输入，先确认能安全解构（否则解构 null 会抛 TypeError）
      if (typeof value !== "object" || value === null || typeof (value as any).name !== "string") {
        warnings.push(`${key}：manifest 中的条目缺少合法的文件名，已跳过`);
        continue;
      }
      const { hash: manifestContentHash, name: fileName } = value as { hash: string; name: string };

      const fileEntry = files[fileName];
      // 复检 P2（H）：manifest 引用了备份里不存在的文件 → 与 zip 路径统一为「warning + 跳过」
      if (!fileEntry) {
        warnings.push(`${key}：备份中缺少 ${fileName}，已跳过该条目`);
        continue;
      }

      let fileRawContent = fileEntry.content;
      /**
       * 复检 P2（C）：`raw_url` 指向 `gist.githubusercontent.com`，它不是 api.github.com，
       * 不应携带 `Authorization: Bearer <PAT>`（把长期凭据发给内容 CDN 属于凭据外泄面）。
       * 这里改用裸 axios 拉取：GitHub gist 的 raw URL 本身带签名，无需额外鉴权。
       *
       * 注意：GitHub 对 >1MB 的文件返回 `truncated: true` 且内联 content 可能为空，
       * 因此必须先拉 raw_url，再判断内容是否为空（旧实现 `if (content)` 会跳过这类文件）。
       */
      if (fileEntry.truncated && typeof fileEntry.raw_url === "string" && fileEntry.raw_url.length > 0) {
        const rawContentReq = await axios.get<string>(fileEntry.raw_url, {
          responseType: "text",
          timeout: getBackupRequestTimeout(this.userConfig),
        });
        fileRawContent = rawContentReq.data;
      }

      if (!fileRawContent) {
        warnings.push(`${key}：备份中 ${fileName} 内容为空，已跳过该条目`);
        continue;
      }

      {
        const fileContentHash = CryptoJS.MD5(fileRawContent).toString();
        if (fileContentHash !== manifestContentHash) {
          throw new Error(`File hash mismatch for ${fileName}.`);
        }

        let payload: unknown;
        try {
          // SERVERSSOCIAL-2：生产端在未设置备份密钥时会如实写 manifest.encryption=false + 明文 JSON，
          // 但消费端旧实现无条件走 this.decryptData（候选密钥取自本机配置的加密密钥与 gist_id）。
          // 一旦用户配置了非空备份密钥（恢复对话框会自动带上），明文既不以密文前缀开头、也过不了
          // legacy AES，于是一律抛「Failed to decrypt file.」——同一份备份走本地 zip 路径却正常。
          // 这里对齐 zip 姊妹路径的守卫（utils.ts jsZipBlobToBackupData 的 `!manifest.encryption && encryptionKey`）：
          // 显式 false 时按明文 JSON 解析；字段缺失时保持旧的解密语义，兼容修复前的历史备份。
          if (manifest.encryption === false && this.encryptionKey) {
            throw new BackupDowngradeError(
              "Refusing to restore an unencrypted backup while a decryption key was provided",
            );
          }
          payload =
            manifest.encryption === false
              ? decryptData(fileRawContent, undefined, key)
              : this.decryptData(fileRawContent, key);
        } catch (e) {
          // C2-B-10：降级保护的可操作提示不能被通用文案吞掉（用户清空解密密钥即可恢复明文备份）
          if (e instanceof BackupDowngradeError) {
            throw e;
          }
          throw new Error(`Failed to decrypt file.`);
        }

        // SERVERSSOCIAL-5：与 zip 路径同一套结构校验，形状不符的条目丢弃并记录原因，
        // 而不是把不可信结构原样交给上层
        const problem = validateBackupPayload(key, payload);
        if (problem) {
          warnings.push(`${key}：${problem}，已跳过该条目`);
          continue;
        }

        result[key] = payload;
      }
    }

    result.manifest = manifest;
    setBackupWarnings(result, warnings); // 警告挂在 manifest 上，可经消息传递到恢复对话框
    return result;
  }

  // Gist 不支持删除历史记录！我们直接返回 false 表示删除失败即可！
  async deleteFile(path: string): Promise<boolean> {
    // C2-B-4：deleteFile 恒 false 时，调用侧的保留策略（applyBackupRetention）只会静默跳过、
    // 不留下任何原因。这里每个 Gist 实例只提示一次（避免对每个候选文件刷日志）。
    if (!Gist.warnedDeleteUnsupported) {
      Gist.warnedDeleteUnsupported = true;
      logMessage("[Gist] 不支持删除历史备份，保留策略对本后端不生效", { path }, "warn");
    }
    return false;
  }

  protected override encryptData(data: any): string {
    // SERVERSSOCIAL-2：不再把非机密的 gist_id 拼进口令（旧实现未设置密钥时等价于用字面量
    // `|<gist_id>` 加密）。这里只使用用户真实设置的备份加密密钥；未设置时 encryptData 退化为明文 JSON。
    return encryptData(data, this.encryptionKey);
  }

  protected override decryptData<T = any>(data: string, field = ""): T {
    /**
     * SERVERSSOCIAL-2：`|<gist_id>` 候选密钥仅为兼容修复前上传的旧备份（它们确实是用它加密的），
     * 新备份不再使用该密钥派生方式。
     *
     * 复检 P2（H）：候选顺序调整为「真实密钥优先」——否则每次恢复新备份都会先用错误的 `|<gist_id>`
     * 试一次、失败后再回退，既多一次 PBKDF2/AES，又在日志里刷一条误导性的
     * 「使用候选密钥解密失败」（用户会以为备份损坏或密钥错误）。
     * 空密钥不进入候选（避免把明文 JSON 当成可解密数据、或对 undefined 做 MD5）。
     */
    const decryptKeys = [this.encryptionKey, `${this.encryptionKey ?? ""}|${this.userConfig.gist_id}`].filter(
      (key): key is string => typeof key === "string" && key.length > 0,
    );

    for (const key of decryptKeys) {
      try {
        return decryptData(data, key, field) as T;
      } catch (e) {
        // 多密钥依次尝试属正常控制流；全部失败时下方仍会抛出。
        logMessage("[Gist] 使用候选密钥解密失败，尝试下一个密钥", {
          gistId: this.userConfig.gist_id,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    throw new Error("Failed to decrypt data with provided keys.");
  }
}
