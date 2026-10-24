/**
 * 备份/同步用的密码学原语（基于 @noble/hashes + @noble/ciphers，全部同步 API）。
 *
 * 本模块替代了原先的 CryptoJS 4.2.0，**必须与其字节级兼容**：已有用户的备份文件（legacy OpenSSL /
 * `PTD-AES-HMAC-v1:` / `PTD-AES-HMAC-v2:`）、CookieCloud 服务端数据、Gist manifest 里的 MD5 都依赖这些细节。
 * 每个函数都注明了它对应的 CryptoJS 调用；行为由 tests/packages/backupServer/cryptoCompat.test.ts 的
 * golden fixture（用 CryptoJS 生成后硬编码）锁定。
 *
 * 有意保留的 CryptoJS 宽松行为（改掉会让「旧实现能读/会报什么错」发生变化）：
 * - Base64 解码：遇到第一个 `=` 即截断，非法字符按 0 处理，不跳过空白（{@link base64ToBytes}）；
 * - AES-CBC 解密：不足一块的尾部按 0 补齐；PKCS#7 只看最后一个字节、不校验其余填充字节，
 *   填充长度超过数据长度时得到空明文（{@link aesCbcDecrypt}）。错误口令因此通常表现为
 *   `Malformed UTF-8 data` 或空串（随后 JSON.parse 抛 SyntaxError），而不是「bad padding」。
 * - UTF-8：编码时孤立代理项抛 URIError（同 encodeURIComponent），解码非法序列抛 `Malformed UTF-8 data`，保留 BOM。
 *
 * 唯一的有意偏差：OpenSSL 格式的密文缺少 `Salted__` 头时，CryptoJS 会用**随机** salt 派生密钥
 * （结果不确定，几乎总是解密失败），这里改为确定性地抛错。
 */
import { cbc } from "@noble/ciphers/aes.js";
import { hmac } from "@noble/hashes/hmac.js";
import { md5 } from "@noble/hashes/legacy.js";
import { pbkdf2 } from "@noble/hashes/pbkdf2.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, randomBytes as nobleRandomBytes } from "@noble/hashes/utils.js";

export { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

const AES_BLOCK_SIZE = 16;
/** "Salted__"：OpenSSL `enc` / CryptoJS 口令加密输出的魔数 */
const OPENSSL_SALTED_MAGIC = new Uint8Array([0x53, 0x61, 0x6c, 0x74, 0x65, 0x64, 0x5f, 0x5f]);

// ---------------------------------------------------------------------------
// 编解码
// ---------------------------------------------------------------------------

const utf8Encoder = new TextEncoder();
/** fatal：非法序列直接抛错；ignoreBOM：保留开头的 U+FEFF（CryptoJS 的 decodeURIComponent 实现不会吞 BOM） */
const utf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** = `CryptoJS.enc.Utf8.parse`；字符串含孤立代理项时与 encodeURIComponent 一样抛 URIError */
export function utf8ToBytes(text: string): Uint8Array {
  if (typeof text !== "string") {
    throw new TypeError("utf8ToBytes expects a string");
  }
  if (!text.isWellFormed()) {
    throw new URIError("URI malformed");
  }
  return utf8Encoder.encode(text);
}

/** = `wordArray.toString(CryptoJS.enc.Utf8)`；非法 UTF-8 抛出与 CryptoJS 相同的 `Malformed UTF-8 data` */
export function bytesToUtf8(bytes: Uint8Array): string {
  try {
    return utf8Decoder.decode(bytes);
  } catch {
    throw new Error("Malformed UTF-8 data");
  }
}

/** = `wordArray.toString(CryptoJS.enc.Base64)`：标准字母表、带 `=` 填充 */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000; // 分块拼接，避免 String.fromCharCode(...大数组) 爆栈
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** 标准 Base64 字母表的反查表；不在字母表内的字符（含空白、`-`/`_`、非 ASCII）一律为 0，与 CryptoJS 一致 */
const BASE64_REVERSE = (() => {
  const table = new Uint8Array(128);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  for (let i = 0; i < alphabet.length; i++) {
    table[alphabet.charCodeAt(i)] = i;
  }
  return table;
})();

/**
 * = `CryptoJS.enc.Base64.parse`（**宽松**解码，逐位复刻）：
 * - 在第一个 `=` 处截断（之后的内容全部忽略）；
 * - 不在字母表中的字符按 0 参与解码（不报错、也不跳过），因此长度计算包含这些字符；
 * - 输出字节数 = floor(有效长度 × 6 / 8)。
 *
 * 规范的 Base64 输入下与标准解码完全一致；宽松部分只影响损坏/非规范输入，保留它是为了让
 * 「旧实现读成功的数据新实现也读成功、旧实现报错的数据新实现也报错」。
 */
export function base64ToBytes(base64: string): Uint8Array {
  const paddingIndex = base64.indexOf("=");
  const length = paddingIndex === -1 ? base64.length : paddingIndex;
  const out = new Uint8Array(Math.floor((length * 3) / 4));
  const value = (index: number) => {
    const code = base64.charCodeAt(index);
    return code < 128 ? BASE64_REVERSE[code] : 0;
  };

  let byteIndex = 0;
  for (let i = 0; i < length; i++) {
    const position = i % 4;
    if (position === 0) continue;
    // 与 CryptoJS parseLoop 同一公式：前一字符左移、当前字符右移后拼成一个字节
    out[byteIndex++] = ((value(i - 1) << (position * 2)) | (value(i) >>> (6 - position * 2))) & 0xff;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 摘要 / MAC / KDF
// ---------------------------------------------------------------------------

type TBytesOrText = Uint8Array | string;

const toBytes = (input: TBytesOrText): Uint8Array => (typeof input === "string" ? utf8ToBytes(input) : input);

/** = `CryptoJS.MD5(text).toString()`（字符串按 UTF-8 编码，输出小写 hex） */
export function md5Hex(text: string): string {
  return bytesToHex(md5(utf8ToBytes(text)));
}

/** = `CryptoJS.SHA256(text).toString()` */
export function sha256Hex(text: string): string {
  return bytesToHex(sha256(utf8ToBytes(text)));
}

/**
 * = `CryptoJS.HmacSHA256(message, key)`：字符串参数按 UTF-8 编码，Uint8Array（原 WordArray）按原始字节。
 * 注意参数顺序与 CryptoJS 相同：先 message、后 key。
 */
export function hmacSha256(message: TBytesOrText, key: TBytesOrText): Uint8Array {
  return hmac(sha256, toBytes(key), toBytes(message));
}

/** = `CryptoJS.HmacSHA256(message, key).toString()` */
export function hmacSha256Hex(message: TBytesOrText, key: TBytesOrText): string {
  return bytesToHex(hmacSha256(message, key));
}

/**
 * = `CryptoJS.PBKDF2(password, salt, { keySize: dkLen / 4, iterations, hasher: CryptoJS.algo.SHA256 })`。
 * 口令为字符串时按 UTF-8 编码；`keySize: 256 / 32`（8 个 32 位字）即 dkLen = 32 字节。
 */
export function pbkdf2Sha256(password: TBytesOrText, salt: Uint8Array, iterations: number, dkLen = 32): Uint8Array {
  return pbkdf2(sha256, toBytes(password), salt, { c: iterations, dkLen });
}

/**
 * OpenSSL `EVP_BytesToKey(MD5, count=1)`（= CryptoJS 字符串口令加密的默认 KDF `CryptoJS.kdf.OpenSSL`）：
 * D_i = MD5(D_{i-1} || password || salt)，拼接到 keyLen + ivLen 字节后切分。
 */
export function evpBytesToKey(
  passphrase: string,
  salt: Uint8Array,
  keyLen = 32,
  ivLen = 16,
): { key: Uint8Array; iv: Uint8Array } {
  const password = utf8ToBytes(passphrase);
  const blocks: Uint8Array[] = [];
  let derivedLength = 0;
  let previous = new Uint8Array(0);
  while (derivedLength < keyLen + ivLen) {
    previous = md5(concatBytes(previous, password, salt));
    blocks.push(previous);
    derivedLength += previous.length;
  }
  const material = concatBytes(...blocks);
  return { key: material.slice(0, keyLen), iv: material.slice(keyLen, keyLen + ivLen) };
}

/** 密码学安全随机数（globalThis.crypto.getRandomValues） */
export function randomBytes(length: number): Uint8Array {
  return nobleRandomBytes(length);
}

// ---------------------------------------------------------------------------
// AES-CBC
// ---------------------------------------------------------------------------

/**
 * = `CryptoJS.AES.encrypt(plaintext, keyWordArray, { iv }).ciphertext`：AES-CBC + PKCS#7。
 * key 长度决定 AES-128/192/256（本项目只用 32 字节 → AES-256）；字符串明文按 UTF-8 编码。
 */
export function aesCbcEncrypt(plaintext: TBytesOrText, key: Uint8Array, iv: Uint8Array): Uint8Array {
  return cbc(key, iv).encrypt(toBytes(plaintext));
}

/**
 * = `CryptoJS.AES.decrypt({ ciphertext }, keyWordArray, { iv })`，**逐位复刻 CryptoJS 的宽松语义**：
 * 1. 密文长度不是 16 的倍数时，尾部不完整的块按 0 补齐后解密（CryptoJS 的 `_process(flush)` 行为）；
 * 2. PKCS#7 去填充只读取「原始长度最后一个字节所在 32 位字」的最低字节作为填充长度，不校验其它填充字节；
 * 3. 填充长度 ≥ 数据长度时返回空明文（CryptoJS 的 sigBytes 变成 ≤0）。
 *
 * 因此错误密钥/损坏密文**不会**在这里抛错，而是得到垃圾或空字节，由调用方的 UTF-8 / JSON 解析报错，
 * 与旧实现的错误表现一致。v1/v2 备份在解密前已校验 HMAC，宽松去填充不会形成 padding oracle。
 */
export function aesCbcDecrypt(ciphertext: Uint8Array, key: Uint8Array, iv: Uint8Array): Uint8Array {
  const length = ciphertext.length;
  if (length === 0) {
    return new Uint8Array(0);
  }
  let blocks = ciphertext;
  if (length % AES_BLOCK_SIZE !== 0) {
    blocks = new Uint8Array(Math.ceil(length / AES_BLOCK_SIZE) * AES_BLOCK_SIZE);
    blocks.set(ciphertext);
  }
  const decrypted = cbc(key, iv, { disablePadding: true }).decrypt(blocks);
  // CryptoJS Pkcs7.unpad：words[(sigBytes - 1) >>> 2] & 0xff → 该 32 位大端字的最后一个字节
  const paddingLength = decrypted[(((length - 1) >>> 2) << 2) + 3];
  const plaintextLength = length - paddingLength;
  return plaintextLength > 0 ? decrypted.slice(0, plaintextLength) : new Uint8Array(0);
}

// ---------------------------------------------------------------------------
// OpenSSL `Salted__` 口令加密（CookieCloud 协议 / legacy 备份条目）
// ---------------------------------------------------------------------------

/**
 * = `CryptoJS.AES.encrypt(plaintext, passphrase).toString()`：
 * 随机 8 字节 salt → EVP_BytesToKey(MD5) 得到 32 字节 key + 16 字节 iv → AES-256-CBC + PKCS#7，
 * 输出 Base64("Salted__" + salt + ciphertext)。`salt` 参数仅供测试构造确定性数据。
 */
export function opensslEvpEncrypt(plaintext: string, passphrase: string, salt: Uint8Array = randomBytes(8)): string {
  const { key, iv } = evpBytesToKey(passphrase, salt);
  const ciphertext = aesCbcEncrypt(plaintext, key, iv);
  return bytesToBase64(concatBytes(OPENSSL_SALTED_MAGIC, salt, ciphertext));
}

/**
 * = `CryptoJS.AES.decrypt(encrypted, passphrase).toString(CryptoJS.enc.Utf8)`。
 *
 * 错误语义与 CryptoJS 相同：错误口令/损坏密文通常抛 `Malformed UTF-8 data`，或返回空串/垃圾串
 * （调用方随后的 JSON.parse 会抛 SyntaxError）。唯一偏差：缺少 `Salted__` 头时直接抛错
 * （CryptoJS 会用随机 salt 解密出不确定的垃圾，几乎总是同样以报错告终）。
 */
export function opensslEvpDecrypt(encrypted: string, passphrase: string): string {
  if (typeof encrypted !== "string") {
    throw new TypeError("OpenSSL ciphertext must be a Base64 string");
  }
  const raw = base64ToBytes(encrypted);
  const hasSaltedHeader =
    raw.length >= OPENSSL_SALTED_MAGIC.length && OPENSSL_SALTED_MAGIC.every((byte, i) => raw[i] === byte);
  if (!hasSaltedHeader) {
    throw new Error("Malformed OpenSSL ciphertext: missing Salted__ header");
  }
  // CryptoJS 在头部之后不足 8 字节 salt 时以 0 补齐；此时密文为空，最终得到空明文
  const salt = new Uint8Array(8);
  salt.set(raw.subarray(8, 16));
  const { key, iv } = evpBytesToKey(passphrase, salt);
  return bytesToUtf8(aesCbcDecrypt(raw.subarray(16), key, iv));
}
