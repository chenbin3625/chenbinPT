/**
 * C2-B-1：旧版（legacy OpenSSL 格式）加密 zip 备份必须仍可恢复。
 *
 * 历史实现（引入 `PTD-AES-HMAC-v1:` 之前）：
 * - `manifest.encryption === true`，但没有 `encryptionFormat`；
 * - 每个条目是 `CryptoJS.AES.encrypt(JSON.stringify(data), MD5(key).slice(0, 16))` 的 OpenSSL 字符串（无封套、无 MAC）。
 *
 * 修复前 `zipBlobToBackupData` 对「manifest 声称加密但无 v2 标记」的情况传 `allowLegacy: false`，
 * 导致这类历史备份恢复时一律抛 BackupDowngradeError（输对密钥也没用）。本用例走**完整恢复路径**，
 * 防止 `decryptData` 单测通过、恢复路径却不可用的假阳性。
 */
import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import { backupDataToZipBlob, zipBlobToBackupData } from "@ptd/backupServer/utils.ts";

import { legacyBackupEncrypt, md5Hex } from "./helpers/nodeCryptoOracle.ts";

const ENCRYPTION_KEY = "legacy-user-key";

/**
 * 复刻旧版本 utils.ts 的加密实现（OpenSSL 格式 + MD5 前 16 位作为口令）。
 * 用独立的 node:crypto 实现生成，与被测的解密实现互不依赖（字节级等价性见 cryptoCompat.test.ts）。
 */
function legacyEncrypt(data: unknown, encryptionKey: string): string {
  return legacyBackupEncrypt(data, encryptionKey);
}

/** 构造旧版本导出的 zip：manifest.encryption=true、无 encryptionFormat/kdf、条目为 legacy 密文 */
async function buildLegacyBackupZip(payloads: Record<string, unknown>, encryptionKey: string): Promise<Blob> {
  const zip = new JSZip();
  const files: Record<string, { name: string; hash: string }> = {};

  for (const [fileKey, payload] of Object.entries(payloads)) {
    const fileName = `${fileKey}.json`;
    const content = legacyEncrypt(payload, encryptionKey);
    zip.file(fileName, content);
    files[fileKey] = { name: fileName, hash: md5Hex(content) };
  }

  zip.file(
    "manifest.json",
    JSON.stringify({ encryption: true, time: Date.now(), version: "chenbinPT (v0.0.7)", files }),
  );

  return await zip.generateAsync({ type: "blob" });
}

describe("C2-B-1：legacy 加密 zip 备份恢复", () => {
  it("完整恢复路径（zipBlobToBackupData）能解出旧版 OpenSSL 条目", async () => {
    const origin = {
      config: { lang: "zh_CN", backup: { encryptionKey: ENCRYPTION_KEY } },
      userInfo: { mteam: { "2026-01-01": { uploaded: 1 } } },
    };
    const blob = await buildLegacyBackupZip(origin, ENCRYPTION_KEY);

    const restored = await zipBlobToBackupData(blob, ENCRYPTION_KEY);

    expect(restored.config).toEqual(origin.config);
    expect(restored.userInfo).toEqual(origin.userInfo);
    expect(restored.manifest?.encryption).toBe(true);
  });

  it("密钥错误时仍然拒绝（不能因为放开 legacy 就吞掉解密失败）", async () => {
    const blob = await buildLegacyBackupZip({ config: { lang: "zh_CN" } }, ENCRYPTION_KEY);

    await expect(zipBlobToBackupData(blob, "wrong-key")).rejects.toThrow(/Failed to decrypt file/);
  });

  it("manifest 声称加密、条目却是明文时拒绝（legacy 解密失败仍会报错）", async () => {
    const zip = new JSZip();
    const content = JSON.stringify({ lang: "zh_CN" });
    zip.file("config.json", content);
    zip.file(
      "manifest.json",
      JSON.stringify({
        encryption: true,
        files: { config: { name: "config.json", hash: md5Hex(content) } },
      }),
    );
    const blob = await zip.generateAsync({ type: "blob" });

    await expect(zipBlobToBackupData(blob, ENCRYPTION_KEY)).rejects.toThrow(/Failed to decrypt file/);
  });

  it("新格式（v2）篡改仍然被 MAC 拒绝（放开 legacy 不影响认证性）", async () => {
    const origin = { config: { secret: "value" } };
    const blob = await backupDataToZipBlob(origin, ENCRYPTION_KEY);

    // 对照组：未篡改的 v2 备份走完整恢复路径可以正常解密
    const restored = await zipBlobToBackupData(blob, ENCRYPTION_KEY);
    expect(restored.config).toEqual(origin.config);

    // 拆包确认产物是 v2 封套格式，只篡改 MAC 并同步更新 manifest.files.config.hash
    // 使前置 MD5 校验通过，从而真正验证 zipBlobToBackupData -> decryptData 的 v2 MAC 校验分支
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    const manifestRaw = await zip.file("manifest.json")?.async("string");
    const configRaw = await zip.file("config.json")?.async("string");
    expect(manifestRaw).toBeDefined();
    expect(configRaw).toBeDefined();

    const manifest = JSON.parse(manifestRaw!);
    expect(manifest.encryptionFormat).toBe("PTD-AES-HMAC-v2");
    expect(configRaw!.startsWith("PTD-AES-HMAC-v2:")).toBe(true);

    const envelope = JSON.parse(configRaw!.slice("PTD-AES-HMAC-v2:".length));
    envelope.mac = envelope.mac.replace(/^./, envelope.mac.startsWith("0") ? "1" : "0");
    const tamperedConfig = `PTD-AES-HMAC-v2:${JSON.stringify(envelope)}`;

    zip.file("config.json", tamperedConfig);
    manifest.files.config.hash = md5Hex(tamperedConfig);
    zip.file("manifest.json", JSON.stringify(manifest));
    const tamperedBlob = await zip.generateAsync({ type: "blob" });

    await expect(zipBlobToBackupData(tamperedBlob, ENCRYPTION_KEY)).rejects.toThrow(
      /Failed to decrypt file: config\.json/,
    );
  });
});
