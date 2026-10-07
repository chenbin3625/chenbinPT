#!/usr/bin/env node
/**
 * 一条命令把构建产物打成**已签名且自校验通过**的 Chrome CRX3。
 *
 * 为什么自己实现 CRX3 而不是调用 Google Chrome：
 * 1) `--pack-extension` 依赖本机装了 Chrome、会启动浏览器进程、且只在桌面平台可用；
 *    CI（ubuntu-latest）与无头环境里不可靠。
 * 2) 依赖第三方打包库（crx/crx3）会把几十个包塞进 devDependencies，
 *    而 CRX3 的头结构本身只有约 60 行代码（magic + protobuf 头 + zip 载荷 + RSA-SHA256 签名）。
 *    实测：对同一个 zip + 同一把私钥，本文件的输出与 Chrome 自带 `--pack-extension`、
 *    以及 webext-buildtools-chrome-crx-builder@1.0.18（内部 crx3）**逐字节相同**
 *    （sha256 52e26a27…），并通过 openssl `dgst -verify` 的独立验签。
 *
 * 用法：
 *   npm run pack:crx                # 用现有 dist-chrome 打包到 build/extension.crx
 *   npm run pack:crx:build          # 先 vite build 再打包
 *   node scripts/pack-crx.mjs --zip build/extension-chrome.zip   # 直接签名已有 zip（与构建目录打包同口径）
 *   node scripts/pack-crx.mjs --help
 *
 * 发布流程（仓库不再有 CI 工作流，全部本地完成）：见 README「版本号规则」。
 * 私钥解析顺序：--key <path> → 环境变量 CRX_PRIVATE_KEY_FILE → 环境变量 CRX_PRIVATE_KEY
 * （PEM 内容或 base64 后的 PEM）→ 默认 build/chrome-extension-signing-key.pem。
 * 生成密钥对（PKCS#8，Chrome 打包要求 PKCS#8）：
 *   openssl genrsa -out build/chrome-extension-signing-key.pem 2048
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import JSZip from "jszip";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_KEY = "build/chrome-extension-signing-key.pem";
const DEFAULT_OUT = "build/extension.crx";
const DEFAULT_DIR = "dist-chrome";
const CRX_MAGIC = "Cr24";
const CRX_VERSION = 3;
/** CRX3 签名前缀：注意结尾的 \0 与随后 4 字节小端长度 */
const SIGNATURE_CONTEXT = "CRX3 SignedData\0";
/** Chrome 要求签名密钥至少 2048 位 */
const MIN_RSA_BITS = 2048;

// ---------------------------------------------------------------- 命令行参数

function parseArgs(argv) {
  const opts = { dir: DEFAULT_DIR, zip: null, out: DEFAULT_OUT, key: null, build: false, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} 需要一个值`);
      return v;
    };
    switch (arg) {
      case "--dir":
        opts.dir = next();
        break;
      case "--zip":
        opts.zip = next();
        break;
      case "--out":
        opts.out = next();
        break;
      case "--key":
        opts.key = next();
        break;
      case "--build":
        opts.build = true;
        break;
      case "--quiet":
        opts.quiet = true;
        break;
      case "-h":
      case "--help":
        opts.help = true;
        break;
      default:
        throw new Error(`未知参数 ${arg}（--help 查看用法）`);
    }
  }
  return opts;
}

const HELP = `
把构建产物打成已签名并自校验的 Chrome CRX3

用法：node scripts/pack-crx.mjs [options]

  --dir <path>   要打包的构建目录，默认 ${DEFAULT_DIR}
  --zip <path>   直接签名该 zip（与 --dir 二选一，优先于 --dir）
  --out <path>   输出 crx 路径，默认 ${DEFAULT_OUT}
  --key <path>   私钥 PEM；默认 ${DEFAULT_KEY}
                 也可用环境变量 CRX_PRIVATE_KEY_FILE 或 CRX_PRIVATE_KEY（PEM / base64）
  --build        打包前先执行 npm run build:dist
  --quiet        只打印结论
  -h, --help     显示本帮助
`;

// ---------------------------------------------------------------- 私钥

/** 读一个相对于仓库根的文件，缺失时给出可操作的报错而不是裸 ENOENT */
function readFileFromRoot(rel, what) {
  const abs = path.resolve(ROOT, rel);
  if (!fs.existsSync(abs)) throw new Error(`${what}不存在：${rel}（仓库根 ${ROOT}）`);
  return fs.readFileSync(abs);
}

function loadPrivateKey(opts) {
  if (opts.key) return { pem: readFileFromRoot(opts.key, "私钥文件").toString("utf8"), from: opts.key };

  const keyFile = process.env.CRX_PRIVATE_KEY_FILE;
  if (keyFile) {
    return { pem: readFileFromRoot(keyFile, "私钥文件").toString("utf8"), from: keyFile };
  }
  const inline = process.env.CRX_PRIVATE_KEY;
  if (inline) {
    const pem = inline.includes("-----BEGIN") ? inline : Buffer.from(inline, "base64").toString("utf8");
    return { pem, from: "环境变量 CRX_PRIVATE_KEY" };
  }

  const fallback = path.resolve(ROOT, DEFAULT_KEY);
  if (!fs.existsSync(fallback)) {
    throw new Error(
      `找不到私钥 ${DEFAULT_KEY}\n` +
        `  生成一对新密钥：\n` +
        `    openssl genrsa -out ${DEFAULT_KEY} 2048\n` +
        `    openssl rsa -in ${DEFAULT_KEY} -pubout -out build/chrome-extension-signing-key.pub`,
    );
  }
  return { pem: fs.readFileSync(fallback, "utf8"), from: DEFAULT_KEY };
}

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest();

/** 从私钥导出 SPKI DER 公钥与扩展 ID（= SHA256(公钥) 前 16 字节，十六进制映射到 a-p） */
function deriveKeyMaterial(pem) {
  let privateKey;
  try {
    privateKey = crypto.createPrivateKey(pem);
  } catch (e) {
    throw new Error(`私钥无法解析（需要 PEM 格式的 RSA 私钥）：${e.message}`);
  }
  if (privateKey.asymmetricKeyType !== "rsa") {
    throw new Error(`私钥类型是 ${privateKey.asymmetricKeyType}，CRX3 需要 RSA 私钥`);
  }
  const bits = privateKey.asymmetricKeyDetails?.modulusLength ?? 0;
  if (bits < MIN_RSA_BITS) {
    throw new Error(`RSA ${bits} 位太短，Chrome 要求至少 ${MIN_RSA_BITS} 位`);
  }
  const publicKeyDer = crypto.createPublicKey(privateKey).export({ type: "spki", format: "der" });
  const crxId = sha256(publicKeyDer).subarray(0, 16);
  const extensionId = [...crxId.toString("hex")].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
  return { privateKey, publicKeyDer, crxId, extensionId, bits };
}

// ---------------------------------------------------------------- 最小 protobuf 编码

function varint(value) {
  const bytes = [];
  let rest = value;
  while (rest > 0x7f) {
    bytes.push((rest & 0x7f) | 0x80);
    rest = Math.floor(rest / 128);
  }
  bytes.push(rest);
  return Buffer.from(bytes);
}

/** 编码 length-delimited 字段（wire type 2） */
function bytesField(fieldNumber, value) {
  return Buffer.concat([varint((fieldNumber << 3) | 2), varint(value.length), value]);
}

function u32le(value) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value);
  return buf;
}

// ---------------------------------------------------------------- 打包 zip

const SKIP = new Set([".DS_Store", "Thumbs.db"]);

function listFiles(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (SKIP.has(entry.name) || entry.name.startsWith("._")) continue;
    if (entry.isDirectory()) out.push(...listFiles(abs, base));
    else if (entry.isFile()) out.push({ abs, rel: path.relative(base, abs).split(path.sep).join("/") });
  }
  return out;
}

/** 把构建目录打成 zip（保持相对路径、用文件 mtime；与旧 CI 的打包口径一致） */
async function zipDir(dir) {
  const abs = path.resolve(ROOT, dir);
  if (!fs.existsSync(path.join(abs, "manifest.json"))) {
    throw new Error(`${dir} 下没有 manifest.json，先构建：npm run build:dist`);
  }
  const zip = new JSZip();
  const files = listFiles(abs).sort((a, b) => (a.rel < b.rel ? -1 : 1));
  for (const f of files) {
    zip.file(f.rel, fs.readFileSync(f.abs), { date: fs.statSync(f.abs).mtime, createFolders: false });
  }
  const buf = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
    platform: "UNIX",
  });
  return { buffer: buf, fileCount: files.length };
}

async function listZipEntries(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  return zip;
}

/** 校验 manifest 里引用的每个资源都在包内（防「装得上但点开空白」） */
async function checkManifestReferences(zip) {
  const manifestEntry = zip.file("manifest.json");
  if (!manifestEntry) throw new Error("zip 里没有 manifest.json");
  const manifestRaw = await manifestEntry.async("string");
  const manifest = JSON.parse(manifestRaw);
  const referenced = [];
  const bg = manifest.background ?? {};
  if (bg.service_worker) referenced.push(bg.service_worker);
  for (const s of bg.scripts ?? []) referenced.push(s);
  for (const cs of manifest.content_scripts ?? []) {
    for (const j of cs.js ?? []) referenced.push(j);
    for (const c of cs.css ?? []) referenced.push(c);
  }
  if (manifest.options_ui?.page) referenced.push(manifest.options_ui.page);
  for (const p of Object.values(manifest.icons ?? {})) referenced.push(p);
  for (const p of Object.values(manifest.action?.default_icon ?? {})) referenced.push(p);
  for (const war of manifest.web_accessible_resources ?? []) {
    for (const r of war.resources ?? []) if (!r.includes("*")) referenced.push(r);
  }
  const missing = [...new Set(referenced)].filter((p) => !zip.file(p));
  if (missing.length > 0) throw new Error(`manifest 引用的资源不在包内：${missing.join(", ")}`);

  // INFRA-2：manifest 的 name / description / action.default_title 都是 `__MSG_<key>__` 本地化字符串，
  // 而 `_locales/<default_locale>/messages.json` 是构建期由 generateWebextLocales 生成的。
  // 该插件过去生成失败只 console.warn/error 就继续，于是能打出一个「manifest 引用本地化、但包内没有
  // messages.json / 缺 key」的 CRX —— 装到浏览器才报错，而本脚本仍打印「✓ 自校验通过」。
  // 因此把本地化引用纳入自校验：缺文件或缺 key 都在这里失败。
  const msgKeys = [...new Set([...manifestRaw.matchAll(/__MSG_([A-Za-z0-9_@]+)__/g)].map((m) => m[1]))];
  if (msgKeys.length > 0) {
    const defaultLocale = manifest.default_locale ?? "en";
    const messagesPath = `_locales/${defaultLocale}/messages.json`;
    const messagesEntry = zip.file(messagesPath);
    if (!messagesEntry) {
      throw new Error(`manifest 使用了 __MSG_*__，但包里没有 ${messagesPath}（default_locale=${defaultLocale}）`);
    }
    const messages = JSON.parse(await messagesEntry.async("string"));
    const missingKeys = msgKeys.filter((k) => !messages[k]?.message);
    if (missingKeys.length > 0) {
      throw new Error(`${messagesPath} 缺少 manifest 引用的本地化键：${missingKeys.join(", ")}`);
    }
  }
  return { manifest, referencedCount: new Set(referenced).size };
}

// ---------------------------------------------------------------- CRX3 组装与校验

function buildCrx(zipBuffer, keyMaterial) {
  const { privateKey, publicKeyDer, crxId } = keyMaterial;
  const signedHeaderData = bytesField(1, crxId); // SignedData { bytes crx_id = 1 }
  const signatureInput = Buffer.concat([
    Buffer.from(SIGNATURE_CONTEXT, "latin1"),
    u32le(signedHeaderData.length),
    signedHeaderData,
    zipBuffer,
  ]);
  // crypto.sign('sha256', ...) 默认即 RSASSA-PKCS1-v1_5，与 CRX3 的 sha256_with_rsa 一致
  const signature = crypto.sign("sha256", signatureInput, privateKey);
  const proof = Buffer.concat([bytesField(1, publicKeyDer), bytesField(2, signature)]); // AsymmetricKeyProof
  const header = Buffer.concat([bytesField(2, proof), bytesField(10000, signedHeaderData)]); // CrxFileHeader
  return Buffer.concat([Buffer.from(CRX_MAGIC, "latin1"), u32le(CRX_VERSION), u32le(header.length), header, zipBuffer]);
}

function readVarint(buf, pos) {
  let result = 0;
  let shift = 0;
  let byte;
  do {
    byte = buf[pos++];
    result += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  } while (byte & 0x80);
  return [result, pos];
}

function readFields(buf) {
  const out = [];
  let pos = 0;
  while (pos < buf.length) {
    let key;
    [key, pos] = readVarint(buf, pos);
    const fieldNumber = key >> 3;
    const wireType = key & 7;
    if (wireType === 2) {
      let len;
      [len, pos] = readVarint(buf, pos);
      out.push({ fieldNumber, value: buf.subarray(pos, pos + len) });
      pos += len;
    } else if (wireType === 0) {
      let value;
      [value, pos] = readVarint(buf, pos);
      out.push({ fieldNumber, value });
    } else {
      throw new Error(`CRX 头里有不支持的 protobuf wire type ${wireType}`);
    }
  }
  return out;
}

/**
 * 复算式校验：完全按 Chrome 的规则重新解析落盘文件，
 * 逐项确认 结构 / 公钥归属 / crx_id / 签名 都正确——任一项不过就退出码 1。
 */
async function verifyCrx(crxBuffer, keyMaterial, zipFileCount) {
  const checks = [];
  const check = (name, ok, detail = "") => {
    checks.push({ name, ok, detail });
    return ok;
  };

  const magic = crxBuffer.subarray(0, 4).toString("latin1");
  const version = crxBuffer.readUInt32LE(4);
  const headerSize = crxBuffer.readUInt32LE(8);
  const header = crxBuffer.subarray(12, 12 + headerSize);
  const payload = crxBuffer.subarray(12 + headerSize);

  check("magic == Cr24", magic === CRX_MAGIC, magic);
  check("version == 3", version === CRX_VERSION, String(version));
  check("头部长度与实际一致", header.length === headerSize, `${headerSize} bytes`);
  check("载荷是 zip", payload.subarray(0, 2).toString("latin1") === "PK");

  const headerFields = readFields(header);
  const proofField = headerFields.find((f) => f.fieldNumber === 2);
  const signedHeaderData = headerFields.find((f) => f.fieldNumber === 10000)?.value;
  if (!proofField || !signedHeaderData) throw new Error("CRX 头缺少 sha256_with_rsa 证明或 signed_header_data");

  const proofFields = readFields(proofField.value);
  const embeddedPublicKey = proofFields.find((f) => f.fieldNumber === 1)?.value;
  const signature = proofFields.find((f) => f.fieldNumber === 2)?.value;
  const crxId = readFields(signedHeaderData).find((f) => f.fieldNumber === 1)?.value;

  check("包内公钥 == 私钥推导出的公钥", Buffer.compare(embeddedPublicKey, keyMaterial.publicKeyDer) === 0);
  check("crx_id == SHA256(公钥)[0:16]", Buffer.compare(crxId, sha256(embeddedPublicKey).subarray(0, 16)) === 0);
  const extensionId = [...crxId.toString("hex")].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
  check("扩展 ID 与私钥一致", extensionId === keyMaterial.extensionId, extensionId);

  const signatureInput = Buffer.concat([
    Buffer.from(SIGNATURE_CONTEXT, "latin1"),
    u32le(signedHeaderData.length),
    signedHeaderData,
    payload,
  ]);
  check(
    "RSA-SHA256 验签",
    crypto.verify("sha256", signatureInput, crypto.createPublicKey(keyMaterial.privateKey), signature),
  );

  const zip = await listZipEntries(payload);
  const payloadFileCount = Object.keys(zip.files).filter((n) => !zip.files[n].dir).length;
  check("载荷 zip 可解析且文件数一致", payloadFileCount === zipFileCount, `${payloadFileCount} files`);

  return { checks, extensionId };
}

// ---------------------------------------------------------------- 主流程

/**
 * 陈旧检查要跳过**构建自己生成**的文件。
 *
 * `public/_locales/` 正是这种情况：它由 `vite/plugin/generateWebextLocales.ts` 在构建期间写入
 * （所以它已在 .gitignore 里），而它写在 `dist-{chrome,firefox}` 里的 `manifest.json` **之后** ——
 * 于是每次全新构建完，「源码比产物新」都成立，警告必然误报。生成物不是输入，不该参与陈旧判断。
 * 2026-10-04 修复：此前每次发布都会看到这条无意义的警告。
 */
const STALE_SCAN_IGNORED = [path.join("public", "_locales")];

/** 源码比产物新时给出提醒（不阻断：产物可能来自其它步骤或机器） */
function warnIfStale(dir) {
  const marker = path.join(path.resolve(ROOT, dir), "manifest.json");
  if (!fs.existsSync(marker)) return null;
  const distTime = fs.statSync(marker).mtimeMs;
  const watched = ["src", "public", "vite", "package.json", "vite.config.ts"];
  let newest = 0;
  const walk = (p) => {
    const rel = path.relative(ROOT, p);
    if (STALE_SCAN_IGNORED.some((ig) => rel === ig || rel.startsWith(ig + path.sep))) return;
    const stat = fs.statSync(p);
    if (stat.isDirectory()) for (const e of fs.readdirSync(p)) walk(path.join(p, e));
    else newest = Math.max(newest, stat.mtimeMs);
  };
  for (const w of watched) {
    const abs = path.resolve(ROOT, w);
    if (fs.existsSync(abs)) walk(abs);
  }
  return newest > distTime ? new Date(newest).toLocaleString() : null;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(HELP.trim());
    return;
  }

  if (opts.build) {
    if (!opts.quiet) console.log("▶ 先构建：npm run build:dist");
    execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build:dist"], {
      cwd: ROOT,
      stdio: "inherit",
    });
  }

  // 1) 载荷
  let zipBuffer;
  let fileCount;
  if (opts.zip) {
    zipBuffer = readFileFromRoot(opts.zip, "zip 文件");
    const zip = await listZipEntries(zipBuffer);
    fileCount = Object.keys(zip.files).filter((n) => !zip.files[n].dir).length;
    if (!opts.quiet)
      console.log(`▶ 载荷：${opts.zip}（${(zipBuffer.length / 1024).toFixed(1)} KB，${fileCount} 个文件）`);
  } else {
    const stale = warnIfStale(opts.dir);
    if (stale)
      console.warn(`⚠ ${opts.dir} 里存在比源码更旧的产物（最新源码改动：${stale}），建议先 npm run build:dist`);
    const zipped = await zipDir(opts.dir);
    zipBuffer = zipped.buffer;
    fileCount = zipped.fileCount;
    if (!opts.quiet)
      console.log(`▶ 打包 ${opts.dir}（${fileCount} 个文件 → ${(zipBuffer.length / 1024).toFixed(1)} KB）`);
  }

  const zip = await listZipEntries(zipBuffer);
  const { manifest, referencedCount } = await checkManifestReferences(zip);
  if (!opts.quiet)
    console.log(`▶ manifest v${manifest.manifest_version} ${manifest.version}，引用资源 ${referencedCount} 项全部就位`);

  // 2) 私钥
  const { pem, from } = loadPrivateKey(opts);
  const keyMaterial = deriveKeyMaterial(pem);
  if (!opts.quiet) console.log(`▶ 私钥：${from}（RSA ${keyMaterial.bits} 位）`);

  // 3) 组装并落盘
  const crxBuffer = buildCrx(zipBuffer, keyMaterial);
  const outPath = path.resolve(ROOT, opts.out);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, crxBuffer);

  // 4) 自校验（对着落盘后的字节重新解析，而不是校验内存里的对象）
  const { checks, extensionId } = await verifyCrx(fs.readFileSync(outPath), keyMaterial, fileCount);

  const failed = checks.filter((c) => !c.ok);
  console.log("");
  for (const c of checks) {
    console.log(`  ${c.ok ? "✓" : "✗"} ${c.name}${c.detail ? `  [${c.detail}]` : ""}`);
  }
  console.log("");
  if (failed.length > 0) {
    console.error(`✗ 自校验失败（${failed.length}/${checks.length}），产物不可用：${outPath}`);
    process.exit(1);
  }
  console.log(`✓ 自校验通过（${checks.length}/${checks.length}）`);
  console.log(`  产物      ${opts.out}（${(crxBuffer.length / 1024 / 1024).toFixed(2)} MB）`);
  console.log(`  扩展 ID   ${extensionId}`);
  console.log(`  公钥指纹  ${sha256(keyMaterial.publicKeyDer).toString("hex")}`);
  console.log(`  crx sha256 ${sha256(crxBuffer).toString("hex")}`);
  console.log("");
  console.log("  注意：私钥决定扩展 ID（已在上面打印），换私钥 = 换一个扩展，老用户无法升级。");
  console.log("  请自行备份 build/chrome-extension-signing-key.pem（仓库不跟踪、也不要提交）。");
}

main().catch((e) => {
  console.error(`✗ ${e.message}`);
  process.exit(1);
});
