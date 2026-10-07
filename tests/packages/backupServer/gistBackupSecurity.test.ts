/**
 * Gist 备份实体的边界修复：
 *  - SERVERSSOCIAL-2：不再用非机密的 gist_id 派生「默认加密」密钥，未设置密钥时如实退化为明文并写 encryption:false；
 *  - SERVERSSOCIAL-5：_manifest.json 是不可信输入，解析时剥离 __proto__ 并做结构校验（与 zip 路径对齐）；
 *  - SERVERSSOCIAL-6：manifest 不再被当成一个数据条目写进 gist。
 */
import CryptoJS from "crypto-js";
import { describe, expect, it, vi } from "vitest";

const logMessageMock = vi.hoisted(() => vi.fn());
vi.mock("@ptd/site/utils/adapter.ts", () => ({ logMessage: logMessageMock }));

import Gist from "@ptd/backupServer/entity/Gist.ts";
import { decryptData, getBackupWarnings } from "@ptd/backupServer/utils.ts";

const GistCtor = Gist as unknown as new (config: any) => Gist;

const makeClient = (gistId = "gist-abc123") =>
  new GistCtor({
    id: "gist-1",
    type: "Gist",
    name: "Gist",
    config: { gist_id: gistId, access_token: "token" },
  });

/** 捕获 addFile 期间的请求，返回 PATCH 请求体里的 files 映射 */
async function runAddFile(client: Gist, file: Record<string, any>, fileName = "PTD_backup_20261006T2100.zip") {
  const requests: Array<{ url: string; config: any }> = [];
  (client as any).request = vi.fn(async (url: string, config: any = {}) => {
    requests.push({ url, config });
    // 远端当前为空 gist（没有需要清理的历史文件）
    return { data: { files: {} } };
  });

  const ok = await (client as any).addFile(fileName, file);
  const patch = requests.find((request) => request.config?.method === "PATCH");
  return { ok, files: patch?.config?.data?.files as Record<string, { content: string }> };
}

describe("SERVERSSOCIAL-2：Gist 默认加密不再由 gist_id 派生", () => {
  it("未设置备份加密密钥时写明文 JSON，并在 manifest 里如实写 encryption:false", async () => {
    logMessageMock.mockClear();
    const client = makeClient();
    const { ok, files } = await runAddFile(client, { config: { a: 1 }, manifest: { version: "v0" } });

    expect(ok).toBe(true);
    expect(Object.keys(files).sort()).toEqual(["_manifest.json", "config.json"]);

    const manifest = JSON.parse(files["_manifest.json"].content);
    expect(manifest.encryption).toBe(false);
    expect(manifest.files.config.name).toBe("config.json");
    // 明文内容（不含密文前缀），hash 与内容一致
    expect(files["config.json"].content).toBe(JSON.stringify({ a: 1 }));
    expect(manifest.files.config.hash).toBe(CryptoJS.MD5(files["config.json"].content).toString());
    // 明文上传必须在运行日志里留痕，而不是让用户以为受密钥保护
    expect(logMessageMock).toHaveBeenCalledWith(expect.stringContaining("明文"), undefined, "warn");
  });

  it("设置了真实密钥时用该密钥加密，且 gist_id 派生出的旧口令无法解密", async () => {
    logMessageMock.mockClear();
    const client = makeClient();
    client.setEncryptionKey("real-user-key");
    const { files } = await runAddFile(client, { config: { a: 1 } });

    const manifest = JSON.parse(files["_manifest.json"].content);
    expect(manifest.encryption).toBe(true);
    expect(manifest.files.config.name).toBe("config.txt");
    expect(logMessageMock).not.toHaveBeenCalled();

    const cipherText = files["config.txt"].content;
    expect(cipherText.startsWith("PTD-AES-HMAC-v1:")).toBe(true);
    expect(decryptData(cipherText, "real-user-key", "config")).toEqual({ a: 1 });
    // 旧实现的口令是 `${encryptionKey}|${gist_id}`；未设置密钥时退化为 `|<gist_id>`。
    // 新备份不得能用 gist_id 派生口令解开。
    expect(() => decryptData(cipherText, "|gist-abc123", "config")).toThrow();
    expect(() => decryptData(cipherText, "real-user-key|gist-abc123", "config")).toThrow();
  });

  it("旧备份仍可用 `|<gist_id>` 旧口令读取（向后兼容）", () => {
    const client = makeClient();
    const legacy = encryptWithGistKey({ a: 1 }, "|gist-abc123", "config");
    expect((client as any).decryptData(legacy, "config")).toEqual({ a: 1 });
  });
});

describe("SERVERSSOCIAL-2：Gist 恢复端尊重 manifest.encryption", () => {
  /** 构造 getFile 的远端文件映射（manifest + 条目文件） */
  const buildRemote = (manifest: Record<string, unknown>, fileContents: Record<string, string>) => {
    const client = makeClient();
    const files: Record<string, any> = {
      "_manifest.json": { content: JSON.stringify(manifest), truncated: false },
    };
    for (const [name, content] of Object.entries(fileContents)) {
      files[name] = { content, truncated: false, raw_url: "" };
    }
    (client as any).request = vi.fn(async () => ({ data: { files } }));
    return client;
  };

  it("配置了非空备份密钥时，manifest.encryption=false 的明文备份仍能读回", async () => {
    logMessageMock.mockClear();
    const configContent = JSON.stringify({ a: 1 });
    const client = buildRemote(
      {
        version: "v",
        time: 0,
        encryption: false,
        files: { config: { name: "config.json", hash: CryptoJS.MD5(configContent).toString() } },
      },
      { "config.json": configContent },
    );
    // 恢复对话框会用 configStore.backup.encryptionKey 自动填充 decryptKey，所以这里必须模拟「有密钥」
    client.setEncryptionKey("real-user-key");

    const result = await (client as any).getFile("v1");
    expect(result.config).toEqual({ a: 1 });
  });

  it("manifest 缺少 encryption 字段的历史备份仍按加密语义读取（向后兼容）", async () => {
    // 修复前无论是否设置密钥都用 `${key}|${gist_id}` 加密，旧备份没有 encryption 标志位
    const configContent = encryptWithGistKey({ a: 1 }, "real-user-key|gist-abc123", "config");
    const client = buildRemote(
      {
        version: "v",
        time: 0,
        files: { config: { name: "config.txt", hash: CryptoJS.MD5(configContent).toString() } },
      },
      { "config.txt": configContent },
    );
    client.setEncryptionKey("real-user-key");

    const result = await (client as any).getFile("v1");
    expect(result.config).toEqual({ a: 1 });
  });
});

function encryptWithGistKey(data: any, key: string, field: string): string {
  const salt = CryptoJS.lib.WordArray.random(16);
  const iv = CryptoJS.lib.WordArray.random(16);
  const material = CryptoJS.PBKDF2(key, salt, {
    keySize: 256 / 32,
    iterations: 100_000,
    hasher: CryptoJS.algo.SHA256,
  });
  const cipherKey = CryptoJS.HmacSHA256("backup-encryption", material);
  const macKey = CryptoJS.HmacSHA256("backup-authentication", material);
  const ciphertext = CryptoJS.AES.encrypt(JSON.stringify(data), cipherKey, { iv }).ciphertext.toString(
    CryptoJS.enc.Base64,
  );
  const saltBase64 = salt.toString(CryptoJS.enc.Base64);
  const ivBase64 = iv.toString(CryptoJS.enc.Base64);
  const mac = CryptoJS.HmacSHA256(`${field}.${saltBase64}.${ivBase64}.${ciphertext}`, macKey).toString();
  return `PTD-AES-HMAC-v1:${JSON.stringify({ salt: saltBase64, iv: ivBase64, ciphertext, mac })}`;
}

describe("SERVERSSOCIAL-6：manifest 不作为数据条目上传", () => {
  it("manifest 不被登记进 manifest.files，也不会生成 manifest.txt/json", async () => {
    const client = makeClient();
    const { files } = await runAddFile(client, {
      config: { a: 1 },
      cookies: {},
      manifest: { version: "v0", files: {} },
    });

    const manifest = JSON.parse(files["_manifest.json"].content);
    expect(Object.keys(manifest.files).sort()).toEqual(["config", "cookies"]);
    expect(files["manifest.json"]).toBeUndefined();
    expect(files["manifest.txt"]).toBeUndefined();
  });
});

describe("SERVERSSOCIAL-5：_manifest.json 按不可信输入处理", () => {
  const buildGetFileClient = (manifestFiles: Record<string, unknown>, fileContents: Record<string, string>) => {
    const client = makeClient();
    const manifestContent = JSON.stringify({
      version: "v",
      time: 0,
      encryption: false,
      files: manifestFiles,
      ["__proto__"]: { polluted: "yes" },
    });
    const files: Record<string, any> = {
      "_manifest.json": { content: manifestContent, truncated: false },
    };
    for (const [name, content] of Object.entries(fileContents)) {
      files[name] = { content, truncated: false, raw_url: "" };
    }
    (client as any).request = vi.fn(async () => ({ data: { files } }));
    return client;
  };

  it("剥离 manifest 中的 __proto__，不会污染 Object.prototype", async () => {
    const configContent = JSON.stringify({ a: 1 });
    const client = buildGetFileClient(
      { config: { name: "config.json", hash: CryptoJS.MD5(configContent).toString() } },
      { "config.json": configContent },
    );

    const result = await (client as any).getFile("v1");

    expect(result.config).toEqual({ a: 1 });
    expect(Object.hasOwn(result.manifest, "__proto__")).toBe(false);
    expect(({} as any).polluted).toBeUndefined();
  });

  it("形状不符的条目不写进结果，并记录可传递的告警", async () => {
    const configContent = JSON.stringify({ a: 1 });
    const badHistoryContent = JSON.stringify({ not: "an array" });
    const client = buildGetFileClient(
      {
        config: { name: "config.json", hash: CryptoJS.MD5(configContent).toString() },
        downloadHistory: {
          name: "downloadHistory.json",
          hash: CryptoJS.MD5(badHistoryContent).toString(),
        },
        broken: null,
      },
      { "config.json": configContent, "downloadHistory.json": badHistoryContent },
    );

    const result = await (client as any).getFile("v1");

    expect(result.config).toEqual({ a: 1 });
    expect(result.downloadHistory).toBeUndefined();

    const warnings = getBackupWarnings(result);
    expect(warnings.some((warning: string) => warning.includes("downloadHistory"))).toBe(true);
    expect(warnings.some((warning: string) => warning.includes("broken"))).toBe(true);
  });

  it("hash 不匹配时仍整份失败（不静默接受被篡改的数据）", async () => {
    const client = buildGetFileClient(
      { config: { name: "config.json", hash: CryptoJS.MD5("expected").toString() } },
      { "config.json": JSON.stringify({ a: 1 }) },
    );

    await expect((client as any).getFile("v1")).rejects.toThrow(/hash mismatch/i);
  });
});
