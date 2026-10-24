/**
 * 测试专用的「独立实现」密码学 oracle：只用 Node 内置 `node:crypto`（OpenSSL），
 * 与被测的 `@ptd/backupServer/crypto.ts`（@noble/*）互不依赖。
 *
 * 用途：替代测试里原先直接 import 的 CryptoJS——
 * - 复刻**历史格式**的生产端（旧版 legacy OpenSSL `Salted__`、v1 封套、CookieCloud 协议），
 *   用来构造「旧版本写出的数据」，验证新实现能读；
 * - 独立解密新实现写出的数据，验证旧格式/第三方客户端（CookieCloud 官方扩展、openssl CLI）能读。
 *
 * 这些函数故意写成最直白的 OpenSSL 调用（严格 PKCS#7、严格 Base64），不复刻 CryptoJS 的宽松行为：
 * 宽松解码的兼容性由 cryptoCompat.test.ts 的 golden fixture 单独锁定。
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";

const OPENSSL_MAGIC = Buffer.from("Salted__", "latin1");

export function md5Hex(text: string): string {
  return createHash("md5").update(text, "utf8").digest("hex");
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** OpenSSL EVP_BytesToKey(MD5, 1 iteration) → 32 字节 key + 16 字节 iv（CryptoJS 字符串口令的默认 KDF） */
export function evpBytesToKey(passphrase: string, salt: Buffer): { key: Buffer; iv: Buffer } {
  const password = Buffer.from(passphrase, "utf8");
  const blocks: Buffer[] = [];
  let prev = Buffer.alloc(0);
  while (Buffer.concat(blocks).length < 48) {
    prev = createHash("md5")
      .update(Buffer.concat([prev, password, salt]))
      .digest();
    blocks.push(prev);
  }
  const material = Buffer.concat(blocks);
  return { key: material.subarray(0, 32), iv: material.subarray(32, 48) };
}

/** 等价于 `CryptoJS.AES.encrypt(plaintext, passphrase).toString()`（Base64("Salted__" + salt + ct)） */
export function opensslEncrypt(plaintext: string, passphrase: string, salt: Buffer = randomBytes(8)): string {
  const { key, iv } = evpBytesToKey(passphrase, salt);
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([OPENSSL_MAGIC, salt, ciphertext]).toString("base64");
}

/** 严格的 OpenSSL `Salted__` 解密（等价于 `openssl enc -d -aes-256-cbc -md md5 -a`） */
export function opensslDecrypt(encrypted: string, passphrase: string): string {
  const raw = Buffer.from(encrypted, "base64");
  if (!raw.subarray(0, 8).equals(OPENSSL_MAGIC)) {
    throw new Error("oracle: missing Salted__ header");
  }
  const { key, iv } = evpBytesToKey(passphrase, raw.subarray(8, 16));
  const decipher = createDecipheriv("aes-256-cbc", key, iv);
  return Buffer.concat([decipher.update(raw.subarray(16)), decipher.final()]).toString("utf8");
}

/** 旧版（v1 之前）备份条目口令：MD5(encryptionKey).hex 的前 16 个字符 */
export function legacyBackupPassphrase(encryptionKey: string): string {
  return md5Hex(encryptionKey).substring(0, 16);
}

/** 复刻旧版本 utils.ts 的 legacy 条目加密（OpenSSL 格式、无封套、无 MAC） */
export function legacyBackupEncrypt(data: unknown, encryptionKey: string, salt?: Buffer): string {
  return opensslEncrypt(JSON.stringify(data), legacyBackupPassphrase(encryptionKey), salt);
}

/** CookieCloud 协议口令：MD5(`${uuid}-${password}`).hex 的前 16 个字符 */
export function cookieCloudPassphrase(uuid: string, password: string): string {
  return md5Hex(`${uuid}-${password}`).substring(0, 16);
}

/** PBKDF2-SHA256(100k) → HMAC 派生 cipherKey / macKey（v1/v2 备份格式） */
export function deriveBackupKeys(encryptionKey: string, salt: Buffer): { cipherKey: Buffer; macKey: Buffer } {
  const material = pbkdf2Sync(Buffer.from(encryptionKey, "utf8"), salt, 100_000, 32, "sha256");
  return {
    cipherKey: createHmac("sha256", material).update("backup-encryption", "utf8").digest(),
    macKey: createHmac("sha256", material).update("backup-authentication", "utf8").digest(),
  };
}

/** 复刻 `PTD-AES-HMAC-v1:` 条目的生产端（可指定 salt/iv 以便构造确定性数据） */
export function v1Encrypt(
  data: unknown,
  encryptionKey: string,
  field = "",
  salt: Buffer = randomBytes(16),
  iv: Buffer = randomBytes(16),
): string {
  const { cipherKey, macKey } = deriveBackupKeys(encryptionKey, salt);
  const cipher = createCipheriv("aes-256-cbc", cipherKey, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(data), "utf8"), cipher.final()]).toString("base64");
  const saltBase64 = salt.toString("base64");
  const ivBase64 = iv.toString("base64");
  const mac = createHmac("sha256", macKey)
    .update(`${field}.${saltBase64}.${ivBase64}.${ciphertext}`, "utf8")
    .digest("hex");
  return `PTD-AES-HMAC-v1:${JSON.stringify({ salt: saltBase64, iv: ivBase64, ciphertext, mac })}`;
}

/** 独立校验 MAC 并解密 `PTD-AES-HMAC-v1:` / `PTD-AES-HMAC-v2:` 条目（v2 需传入 manifest 的 salt） */
export function authenticatedDecrypt(entry: string, encryptionKey: string, field = "", manifestSalt?: string): unknown {
  const isV2 = entry.startsWith("PTD-AES-HMAC-v2:");
  const envelope = JSON.parse(entry.slice("PTD-AES-HMAC-v1:".length));
  const saltBase64: string = isV2 ? manifestSalt! : envelope.salt;
  const { cipherKey, macKey } = deriveBackupKeys(encryptionKey, Buffer.from(saltBase64, "base64"));
  const mac = createHmac("sha256", macKey)
    .update(`${field}.${saltBase64}.${envelope.iv}.${envelope.ciphertext}`, "utf8")
    .digest("hex");
  if (mac !== envelope.mac) {
    throw new Error("oracle: MAC mismatch");
  }
  const decipher = createDecipheriv("aes-256-cbc", cipherKey, Buffer.from(envelope.iv, "base64"));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8"));
}

/** CookieCloud integrity：HMAC-SHA256(JSON, PBKDF2-SHA256(`${uuid}-${password}`, salt, 100k, 32)) */
export function cookieCloudIntegrity(message: string, passphrase: string, saltBase64: string): string {
  const key = pbkdf2Sync(Buffer.from(passphrase, "utf8"), Buffer.from(saltBase64, "base64"), 100_000, 32, "sha256");
  return createHmac("sha256", key).update(message, "utf8").digest("hex");
}
