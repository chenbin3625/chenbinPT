/**
 * CryptoJS → @noble/* 迁移的字节级兼容性锁定。
 *
 * 期望值全部来自 ./fixtures/cryptoGolden.ts：它是用**迁移前**的 CryptoJS 4.2.0 实现（原 utils.ts /
 * CookieCloud.ts 原样代码，随机数替换为固定 salt/iv）一次性生成后硬编码的，代表「旧版本写出的数据」
 * 和「旧版本给出的结果（含错误信息）」。新实现必须原样复现，不得为了让测试通过而改 golden。
 *
 * 覆盖：
 * - 原语：MD5 / SHA256 / HMAC-SHA256（字符串 key 与字节 key）/ PBKDF2 / EVP_BytesToKey / AES-CBC（含宽松去填充）、
 *   CryptoJS 宽松 Base64 解码、UTF-8 编解码的错误语义；
 * - 备份：`PTD-AES-HMAC-v1:`、`PTD-AES-HMAC-v2:`（zip + manifest）、legacy OpenSSL `Salted__` 条目；
 * - CookieCloud：上传密文、integrity、读取、错误口令 / 篡改的报错；
 * - Gist manifest 的 MD5；（exttorrents 的 SHA256 见 tests/packages/site/definitions/exttorrentsDigest.test.ts）
 * - 随机数路径双向验证：新实现加密 → 独立 node:crypto oracle 解密；oracle（旧格式生产端）加密 → 新实现解密。
 */
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@ptd/site/utils/adapter.ts", () => ({ logMessage: vi.fn() }));
vi.mock("axios", async (importOriginal) => {
  const actual = await importOriginal<typeof import("axios")>();
  return { ...actual, default: { ...actual.default, request: vi.fn(), get: vi.fn() } };
});

import axios from "axios";

import {
  aesCbcDecrypt,
  aesCbcEncrypt,
  base64ToBytes,
  bytesToBase64,
  bytesToHex,
  bytesToUtf8,
  evpBytesToKey,
  hexToBytes,
  hmacSha256Hex,
  md5Hex,
  opensslEvpDecrypt,
  opensslEvpEncrypt,
  pbkdf2Sha256,
  sha256Hex,
  utf8ToBytes,
} from "@ptd/backupServer/crypto.ts";
import CookieCloud from "@ptd/backupServer/entity/CookieCloud.ts";
import Gist from "@ptd/backupServer/entity/Gist.ts";
import {
  BackupDowngradeError,
  backupDataToJSZipBlob,
  decryptData,
  encryptData,
  getBackupWarnings,
  jsZipBlobToBackupData,
} from "@ptd/backupServer/utils.ts";

import { GOLDEN } from "./fixtures/cryptoGolden.ts";
import * as oracle from "./helpers/nodeCryptoOracle.ts";

const G = GOLDEN;
const IN = GOLDEN.inputs;
/** 运行时 hex 解析（不依赖被测模块的 hexToBytes，避免自证） */
const hex = (value: string) => new Uint8Array(Buffer.from(value, "hex"));

/**
 * 确定性随机数：按顺序把给定 hex 依次填进 `crypto.getRandomValues`，并断言调用次数与长度
 * 与旧实现的随机数消耗顺序一致（顺序不同则 golden 必然对不上）。
 */
async function withDeterministicRandom<T>(chunks: string[], fn: () => T | Promise<T>): Promise<T> {
  const queue = [...chunks];
  const spy = vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation(((array: Uint8Array) => {
    const next = queue.shift();
    if (next === undefined) throw new Error("deterministic random queue exhausted");
    if (array.length !== next.length / 2) {
      throw new Error(`random length mismatch: requested ${array.length}, fixture ${next.length / 2}`);
    }
    array.set(hex(next));
    return array;
  }) as typeof globalThis.crypto.getRandomValues);
  try {
    const result = await fn();
    expect(queue).toEqual([]);
    return result;
  } finally {
    spy.mockRestore();
  }
}

/** 统一捕获结果或错误（与 golden 生成脚本的 errOf 相同的形状） */
function outcome(fn: () => unknown): { ok: unknown } | { name: string; message: string } {
  try {
    return { ok: fn() };
  } catch (e: any) {
    return { name: e?.name, message: e?.message };
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("原语：与 CryptoJS 输出逐字节一致", () => {
  it("MD5 / SHA256（字符串按 UTF-8，含中文与 emoji）", () => {
    IN.HASH_INPUTS.forEach((input, i) => {
      expect(md5Hex(input)).toBe(G.md5[i]);
      expect(sha256Hex(input)).toBe(G.sha256[i]);
    });
  });

  it("HmacSHA256(message, key)：字符串 key 按 UTF-8，字节 key（原 WordArray）按原始字节", () => {
    expect(hmacSha256Hex("message 消息", "key 密钥")).toBe(G.hmacStrKey);
    expect(hmacSha256Hex("backup-encryption", hex(IN.KEY32))).toBe(G.hmacBytesKey);
  });

  it("PBKDF2-SHA256(keySize: 256/32 = 32 字节, 100k) → HMAC 派生 cipherKey / macKey", () => {
    const material = pbkdf2Sha256(IN.PASSWORD, hex(IN.SALT1), 100_000, 32);
    expect(bytesToHex(material)).toBe(G.pbkdf2);
    expect(hmacSha256Hex("backup-encryption", material)).toBe(G.cipherKey);
    expect(hmacSha256Hex("backup-authentication", material)).toBe(G.macKey);
  });

  it("EVP_BytesToKey(MD5, 1 次迭代)：32 字节 key + 16 字节 iv", () => {
    const { key, iv } = evpBytesToKey("0123456789abcdef", hex(IN.OSSL_SALT1));
    expect(bytesToHex(key)).toBe(G.evp.key);
    expect(bytesToHex(iv)).toBe(G.evp.iv);
  });

  it("AES-CBC + PKCS7：key 长度决定 AES-256 / AES-128；空明文与整块明文都补一整块", () => {
    expect(bytesToBase64(aesCbcEncrypt("hello 世界", hex(IN.KEY32), hex(IN.IV1)))).toBe(G.aes256);
    expect(bytesToBase64(aesCbcEncrypt("hello 世界", hex(IN.KEY16), hex(IN.IV1)))).toBe(G.aes128);
    expect(bytesToBase64(aesCbcEncrypt("", hex(IN.KEY32), hex(IN.IV1)))).toBe(G.aesEmpty);
    expect(bytesToBase64(aesCbcEncrypt("0123456789abcdef", hex(IN.KEY32), hex(IN.IV1)))).toBe(G.aes16);
  });

  it("AES-CBC 解密复刻 CryptoJS 的宽松语义（不完整块补 0、只看最后一个填充字节、溢出得空串）", () => {
    for (const { ciphertext, plaintext } of G.rawDecrypt) {
      expect(bytesToHex(aesCbcDecrypt(hex(ciphertext), hex(IN.KEY32), hex(IN.IV1))), ciphertext).toBe(plaintext);
    }
    // 其中 17 字节的截断密文在 CryptoJS 下「成功」解出 11 字节——锁定这一非直观行为
    expect(G.rawDecrypt.some((c) => c.ciphertext.length === 34 && c.plaintext.length === 22)).toBe(true);
  });

  it("Base64 解码复刻 CryptoJS 的宽松语义（遇 `=` 截断、非法字符按 0、不跳过空白）", () => {
    for (const { input, hex: expected } of G.base64Lenient) {
      expect(bytesToHex(base64ToBytes(input)), JSON.stringify(input)).toBe(expected);
    }
  });

  it("UTF-8：保留 BOM 与 NUL；非法序列抛 `Malformed UTF-8 data`；孤立代理项抛 URIError", () => {
    expect(bytesToUtf8(hex("efbbbf41004243"))).toBe(G.utf8Bom);
    expect(() => bytesToUtf8(hex("c328"))).toThrow(new Error("Malformed UTF-8 data"));
    expect(() => bytesToUtf8(hex("eda080"))).toThrow("Malformed UTF-8 data"); // UTF-8 编码的代理项
    expect(() => utf8ToBytes("a\ud800b")).toThrow(URIError);
    expect(() => md5Hex("a\udfff")).toThrow(URIError);
    expect(bytesToHex(utf8ToBytes("é🔑"))).toBe("c3a9f09f9491");
    expect(bytesToHex(hexToBytes("00ff"))).toBe("00ff");
  });

  it("OpenSSL `Salted__` 口令加密（CookieCloud / legacy）：指定 salt 时与 CryptoJS 输出一致", () => {
    expect(G.legacyKey).toBe(md5Hex(IN.PASSWORD).substring(0, 16));
    expect(opensslEvpEncrypt(JSON.stringify(IN.DATA), G.legacyKey, hex(IN.OSSL_SALT1))).toBe(G.legacy);
    expect(opensslEvpEncrypt("", G.legacyKey, hex(IN.OSSL_SALT2))).toBe(G.legacyEmpty);
    expect(opensslEvpEncrypt("7", G.legacyKey, hex(IN.OSSL_SALT3))).toBe(G.legacySmall);
    expect(opensslEvpDecrypt(G.legacy, G.legacyKey)).toBe(JSON.stringify(IN.DATA));
    expect(G.legacy.startsWith("U2FsdGVkX1")).toBe(true); // Base64("Salted__")
  });
});

describe("PTD-AES-HMAC-v1 备份条目", () => {
  it("加密：固定 salt/iv 时输出与旧实现逐字节一致（随机数消耗顺序 salt → iv）", async () => {
    const withField = await withDeterministicRandom([IN.SALT1, IN.IV1], () =>
      encryptData(IN.DATA, IN.PASSWORD, "config"),
    );
    expect(withField).toBe(G.v1Config);
    const noField = await withDeterministicRandom([IN.SALT2, IN.IV2], () => encryptData({ a: 1 }, "backup-key"));
    expect(noField).toBe(G.v1NoField);
  });

  it("解密旧实现写出的条目；错误口令 / 字段重命名 / 缺密钥的报错与旧实现一致", () => {
    expect(decryptData(G.v1Config, IN.PASSWORD, "config")).toEqual(IN.DATA);
    expect(decryptData(G.v1NoField, "backup-key")).toEqual({ a: 1 });
    expect(outcome(() => decryptData(G.v1Config, "wrong", "config"))).toEqual(G.v1Errors.wrongPassword);
    expect(outcome(() => decryptData(G.v1Config, IN.PASSWORD, "metadata"))).toEqual(G.v1Errors.wrongField);
    expect(outcome(() => decryptData(G.v1Config, undefined, "config"))).toEqual(G.v1Errors.noKey);
  });

  it("密文被篡改（MAC 不变）时先被 MAC 拒绝；iv 长度不对时报封套非法", () => {
    const envelope = JSON.parse(G.v1Config.slice("PTD-AES-HMAC-v1:".length));
    const tampered = {
      ...envelope,
      ciphertext: (envelope.ciphertext[0] === "A" ? "B" : "A") + envelope.ciphertext.slice(1),
    };
    expect(() => decryptData(`PTD-AES-HMAC-v1:${JSON.stringify(tampered)}`, IN.PASSWORD, "config")).toThrow(
      "Backup integrity/authentication check failed",
    );
    const shortIv = { ...envelope, iv: "AAAA" };
    expect(() => decryptData(`PTD-AES-HMAC-v1:${JSON.stringify(shortIv)}`, IN.PASSWORD, "config")).toThrow(
      "Invalid encrypted backup envelope",
    );
  });

  it("双向：新实现随机加密 → 独立 oracle 校验 MAC 并解密；oracle 加密 → 新实现解密", () => {
    const fresh = encryptData(IN.DATA, IN.PASSWORD, "userInfo");
    expect(oracle.authenticatedDecrypt(fresh, IN.PASSWORD, "userInfo")).toEqual(IN.DATA);
    expect(oracle.authenticatedDecrypt(G.v1Config, IN.PASSWORD, "config")).toEqual(IN.DATA);

    const fromOracle = oracle.v1Encrypt(
      IN.DATA,
      IN.PASSWORD,
      "config",
      Buffer.from(IN.SALT1, "hex"),
      Buffer.from(IN.IV1, "hex"),
    );
    expect(fromOracle).toBe(G.v1Config); // oracle 本身与旧实现一致
    expect(decryptData(oracle.v1Encrypt({ z: "随机" }, IN.PASSWORD, "f"), IN.PASSWORD, "f")).toEqual({ z: "随机" });
  });
});

describe("PTD-AES-HMAC-v2 zip 备份", () => {
  const v2Input = () =>
    ({
      config: IN.DATA,
      userInfo: { mteam: { "2026-10-04": { uploaded: 123456789, ratio: 1.5 } } },
      manifest: { version: "chenbinPT (v0.0.10)" },
    }) as any;

  it("导出：manifest（含 kdf.salt 与每个条目的 MD5）与条目密文与旧实现逐字节一致", async () => {
    vi.useFakeTimers({ now: IN.FIXED_NOW, toFake: ["Date"] });
    const blob = await withDeterministicRandom([IN.BACKUP_SALT, IN.IV_CONFIG, IN.IV_USERINFO], () =>
      backupDataToJSZipBlob(v2Input(), IN.PASSWORD),
    );
    vi.useRealTimers();

    const zip = await JSZip.loadAsync(blob);
    expect(await zip.file("manifest.json")!.async("string")).toBe(G.v2.manifest);
    expect(await zip.file("config.json")!.async("string")).toBe(G.v2.config);
    expect(await zip.file("userInfo.json")!.async("string")).toBe(G.v2.userInfo);
  });

  /** 用旧实现写出的条目原样拼一个 zip（= 现有用户手里的备份文件） */
  async function goldenV2Zip(overrides: Record<string, string> = {}): Promise<Blob> {
    const zip = new JSZip();
    const files = {
      "manifest.json": G.v2.manifest,
      "config.json": G.v2.config,
      "userInfo.json": G.v2.userInfo,
      ...overrides,
    };
    for (const [name, content] of Object.entries(files)) zip.file(name, content);
    return await zip.generateAsync({ type: "blob" });
  }

  it("恢复旧实现写出的 v2 备份；错误密钥的报错与旧实现一致", async () => {
    const restored: any = await jsZipBlobToBackupData(await goldenV2Zip(), IN.PASSWORD);
    expect({ config: restored.config, userInfo: restored.userInfo }).toEqual(G.v2Restore.ok);
    expect(getBackupWarnings(restored)).toEqual([]);
    await expect(jsZipBlobToBackupData(await goldenV2Zip(), "wrong")).rejects.toThrow(G.v2WrongKey.message);
  });

  it("独立 oracle 也能解出 v2 条目（manifest 级 salt + 条目字段名参与 MAC）", () => {
    const salt = JSON.parse(G.v2.manifest).kdf.salt as string;
    expect(oracle.authenticatedDecrypt(G.v2.config, IN.PASSWORD, "config", salt)).toEqual(IN.DATA);
  });

  it("v2 manifest 中混入无封套的 legacy 条目 → BackupDowngradeError（不被通用解密失败吞掉）", async () => {
    const manifest = JSON.parse(G.v2.manifest);
    manifest.files.config.hash = oracle.md5Hex(G.legacy);
    const blob = await goldenV2Zip({ "manifest.json": JSON.stringify(manifest), "config.json": G.legacy });
    await expect(jsZipBlobToBackupData(blob, IN.PASSWORD)).rejects.toBeInstanceOf(BackupDowngradeError);
  });
});

describe("legacy OpenSSL `Salted__` 备份条目（v1 之前的格式）", () => {
  it("解密旧实现写出的条目", () => {
    expect(outcome(() => decryptData(G.legacy, IN.PASSWORD))).toEqual(G.legacyOk);
    expect(oracle.legacyBackupEncrypt(IN.DATA, IN.PASSWORD, Buffer.from(IN.OSSL_SALT1, "hex"))).toBe(G.legacy);
  });

  it("空明文 / 截断 / 位翻转 / 非法字符 / 提前出现 `=`：结果与报错与旧实现完全一致", () => {
    expect(outcome(() => decryptData(G.legacyEmpty, IN.PASSWORD))).toEqual(G.legacyEmptyResult);
    for (const [kind, corrupted] of Object.entries(G.legacyCorrupt)) {
      const expected = G.legacyCorruptResults[kind as keyof typeof G.legacyCorruptResults];
      expect(
        outcome(() => decryptData(corrupted, IN.PASSWORD)),
        kind,
      ).toEqual(expected);
    }
  });

  it("错误口令：与旧实现一样按密钥确定性地抛 `Malformed UTF-8 data` / JSON SyntaxError，或「成功」解出垃圾值", () => {
    // 旧实现依赖的是「解密 → UTF-8 解码 → JSON.parse」整条链路报错，而不是 padding 校验；
    // 极少数错误口令会在 CryptoJS 宽松去填充下解出合法 JSON（如数字 1），这里一并锁定。
    for (const [ciphertext, table] of [
      [G.legacy, G.legacyWrongPw],
      [G.legacySmall, G.legacySmallWrongPw],
    ] as const) {
      for (const [category, cases] of Object.entries(table)) {
        for (const { pw, r } of cases as ReadonlyArray<{ pw: string; r: unknown }>) {
          expect(
            outcome(() => decryptData(ciphertext, pw)),
            `${category} ${pw}`,
          ).toEqual(r);
        }
      }
    }
    expect(Object.keys(G.legacyWrongPw).sort()).toEqual(["empty", "malformed", "ok", "syntax"]);
  });

  it("allowLegacy:false 时抛 BackupDowngradeError", () => {
    expect(outcome(() => decryptData(G.legacy, IN.PASSWORD, "", { allowLegacy: false }))).toEqual(G.legacyDowngrade);
  });

  it("缺少 `Salted__` 头（明文 / 其他格式）时确定性地报错（CryptoJS 此时用随机 salt，结果不确定）", () => {
    expect(() => decryptData(JSON.stringify({ lang: "zh_CN" }), IN.PASSWORD)).toThrow(/Salted__/);
    expect(() => opensslEvpDecrypt("AAAAAAAAAAAAAAAAAAAAAA==", "k")).toThrow(/Salted__/);
  });

  it("完整恢复路径：旧版 zip（encryption:true、无 encryptionFormat）可恢复，并提示未做完整性校验", async () => {
    const zip = new JSZip();
    zip.file("config.json", G.legacy);
    zip.file(
      "manifest.json",
      JSON.stringify({ encryption: true, files: { config: { name: "config.json", hash: oracle.md5Hex(G.legacy) } } }),
    );
    const restored: any = await jsZipBlobToBackupData(await zip.generateAsync({ type: "blob" }), IN.PASSWORD);
    expect(restored.config).toEqual(IN.DATA);
    expect(getBackupWarnings(restored).some((w) => w.includes("config.json") && w.includes("MAC"))).toBe(true);
  });
});

describe("CookieCloud 协议", () => {
  const CookieCloudCtor = CookieCloud as unknown as new (config: any) => CookieCloud;
  const ccConfig = {
    id: "cc",
    type: "CookieCloud",
    name: "CookieCloud",
    config: { address: "https://cookiecloud.example.com/", uuid: "test-uuid", password: "test-password", headers: "" },
  };
  const backupInput = () =>
    ({
      cookies: { "mteam.example": [{ name: "sid", value: "secret" }] },
      manifest: { time: 1, version: "test", files: {} },
      config: { lang: "zh_CN" },
      metadata: { sites: { mteam: { url: "https://mteam.example" } } },
    }) as any;
  const respondWith = (encrypted: string) =>
    vi.mocked(axios.request).mockResolvedValue({ data: { encrypted }, headers: {} } as any);

  beforeEach(() => {
    vi.mocked(axios.request).mockReset();
    (CookieCloud as any).fileCache.clear();
  });

  it("口令 = MD5(`uuid-password`).hex 前 16 位；integrity 密钥 = PBKDF2-SHA256(…, salt, 100k)", () => {
    expect(G.ccKey).toBe(md5Hex("test-uuid-test-password").substring(0, 16));
    expect(G.ccKey).toBe(oracle.cookieCloudPassphrase("test-uuid", "test-password"));
    const salt = base64ToBytes(bytesToBase64(hex(IN.CC_INTEGRITY_SALT)));
    expect(bytesToHex(pbkdf2Sha256("test-uuid-test-password", salt, 100_000, 32))).toBe(G.ccIntegrityKey);
  });

  it("上传：固定 integritySalt / OpenSSL salt / 时间时，密文与旧实现逐字节一致（随机数顺序 integritySalt → salt）", async () => {
    vi.mocked(axios.request).mockResolvedValue({ data: { action: "done" } } as any);
    vi.useFakeTimers({ now: IN.FIXED_NOW, toFake: ["Date"] });
    const ok = await withDeterministicRandom([IN.CC_INTEGRITY_SALT, IN.OSSL_SALT4], () =>
      new CookieCloudCtor(ccConfig).addFile("PTD_backup_20261004T0215.zip", backupInput()),
    );
    vi.useRealTimers();

    expect(ok).toBe(G.cc.ok);
    const request = vi.mocked(axios.request).mock.calls[0]![0] as any;
    expect(request.data).toEqual({ uuid: G.cc.uuid, encrypted: G.cc.encrypted });

    // 独立 OpenSSL 实现（≈ CookieCloud 服务端 / 官方扩展）能解出同一份明文，integrity 也能独立复算
    const plaintext = oracle.opensslDecrypt(request.data.encrypted, G.ccKey);
    expect(plaintext).toBe(G.cc.plaintext);
    const parsed = JSON.parse(plaintext);
    const { integrity, integritySalt, ...rest } = parsed;
    expect(oracle.cookieCloudIntegrity(JSON.stringify(rest), "test-uuid-test-password", integritySalt)).toBe(integrity);
  });

  it("deleteFile（清空远端）的密文同样与旧实现一致", async () => {
    vi.mocked(axios.request).mockResolvedValue({ data: { action: "done" } } as any);
    vi.useFakeTimers({ now: IN.FIXED_NOW, toFake: ["Date"] });
    await withDeterministicRandom([IN.CC_INTEGRITY_SALT2, IN.OSSL_SALT2], () =>
      new CookieCloudCtor(ccConfig).deleteFile(""),
    );
    vi.useRealTimers();
    expect((vi.mocked(axios.request).mock.calls[0]![0] as any).data.encrypted).toBe(G.ccDelete);
  });

  it("读取旧实现上传的数据（含 integrity）", async () => {
    respondWith(G.cc.encrypted);
    expect(JSON.parse(JSON.stringify(await new CookieCloudCtor(ccConfig).getFile("")))).toEqual(G.ccRead.ok);
  });

  it("读取不带 integrity 的旧数据（官方扩展 / 旧版 PTD 写出）", async () => {
    respondWith(G.ccLegacy);
    expect(JSON.parse(JSON.stringify(await new CookieCloudCtor(ccConfig).getFile("")))).toEqual(G.ccLegacyRead.ok);
  });

  it("错误密码抛 `Malformed UTF-8 data`；篡改后 integrity 校验失败——与旧实现报错一致", async () => {
    respondWith(G.cc.encrypted);
    const wrong = new CookieCloudCtor({ ...ccConfig, config: { ...ccConfig.config, password: "nope" } });
    await expect(wrong.getFile("")).rejects.toThrow(new Error(G.ccWrongPw.message));

    (CookieCloud as any).fileCache.clear();
    respondWith(G.ccTampered);
    await expect(new CookieCloudCtor(ccConfig).getFile("")).rejects.toThrow(G.ccTamperedRead.message);
  });

  it("双向：新实现随机加密 → oracle 解密；oracle 加密（第三方客户端）→ 新实现解密", async () => {
    const fresh = opensslEvpEncrypt('{"k":"值"}', G.ccKey);
    expect(oracle.opensslDecrypt(fresh, G.ccKey)).toBe('{"k":"值"}');

    const plain = JSON.stringify({
      cookie_data: {},
      local_storage_data: {},
      ptd_data: { config: { a: 1 } },
      manifest: {},
    });
    respondWith(oracle.opensslEncrypt(plain, G.ccKey));
    const result: any = await new CookieCloudCtor(ccConfig).getFile("");
    expect(result.config).toEqual({ a: 1 });
  });
});

describe("Gist manifest 的 MD5", () => {
  it("manifest.files[*].hash = MD5(条目内容).hex（明文与加密条目）；恢复时用同一算法校验", async () => {
    const GistCtor = Gist as unknown as new (config: any) => Gist;
    const client = new GistCtor({ id: "g", type: "Gist", name: "Gist", config: { gist_id: "gid", access_token: "t" } });
    client.setEncryptionKey(IN.PASSWORD);
    const requests: any[] = [];
    (client as any).request = vi.fn(async (_url: string, config: any = {}) => {
      requests.push(config);
      return { data: { files: {} } };
    });

    await client.addFile("x.zip", { config: { lang: "zh_CN" }, metadata: {} } as any);
    const files = requests.find((r) => r.method === "PATCH").data.files;
    const manifest = JSON.parse(files["_manifest.json"].content);
    for (const [, entry] of Object.entries<any>(manifest.files)) {
      expect(entry.hash).toBe(oracle.md5Hex(files[entry.name].content));
    }
    expect(md5Hex(G.v2.config)).toBe(JSON.parse(G.v2.manifest).files.config.hash);
  });
});
