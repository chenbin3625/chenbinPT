import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import { legacyBackupEncrypt, md5Hex } from "./helpers/nodeCryptoOracle.ts";

import {
  backupDataToZipBlob,
  decryptData,
  encryptData,
  getBackupWarnings,
  zipBlobToBackupData,
  setBackupWarnings,
  validateBackupPayload,
} from "@ptd/backupServer/utils.ts";
import type { IBackupData } from "@ptd/backupServer";

/**
 * 备份文件是**不可信输入**（用户可能恢复他人分享的 zip）。
 *
 * 见审查报告 S-1：恢复流程原先不校验备份内容，因此一份恶意 zip 可以植入一条指向攻击者
 * WebDAV/S3/Gist 的 `metadata.backupServers` 记录（并带 `enabled: true` + `backupInterval`
 * + 攻击者挑选的 `backupFields`），随后自动备份会把本机的站点 passkey、会话 Cookie、
 * 下载器凭据**自动上传**到该端点。
 *
 * 本文件覆盖其中的**解析侧**防线：
 *  1. `decryptData` 在 JSON 边界剥离 `__proto__`（否则 `{...obj}` 展开会把键写到 Object.prototype）；
 *  2. `validateBackupPayload` 做结构校验，形状不符的条目会被丢弃并记录原因，
 *     而不是静默写进 chrome.storage；
 *  3. 合法备份**不被误拒**（否则等于静默丢用户数据）；
 *  4. 警告用非枚举属性携带，避免被 `backupDataToZipBlob` 的 `Object.entries` 写回下一个备份。
 *
 * 「backupServers 默认不恢复」的**策略**部分在 offscreen 侧依据
 * `IRestoreOptions.restoreBackupServers` 执行，不在本文件的覆盖范围内。
 */
describe("备份解析：不可信输入的防线（S-1）", () => {
  describe("JSON 边界剥离 __proto__", () => {
    it("顶层 __proto__ 不会成为自有属性，也不会污染 Object.prototype", () => {
      const parsed = decryptData<Record<string, unknown>>('{"ok":1,"__proto__":{"polluted":"yes"}}');

      expect(parsed.ok).toBe(1);
      expect(Object.hasOwn(parsed, "__proto__")).toBe(false);
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      expect((parsed as Record<string, unknown>).polluted).toBeUndefined();
    });

    it("嵌套层的 __proto__ 同样被剥离", () => {
      decryptData('{"a":{"__proto__":{"deepPolluted":"yes"}}}');
      expect(({} as Record<string, unknown>).deepPolluted).toBeUndefined();
    });

    it("正常 JSON 不受影响", () => {
      expect(decryptData('{"a":{"b":[1,2,3]}}')).toEqual({ a: { b: [1, 2, 3] } });
    });
  });

  it("加密结果带认证标签，篡改密文时拒绝解密", () => {
    const encrypted = encryptData({ secret: "value" }, "backup-key");
    expect(encrypted.startsWith("PTD-AES-HMAC-v1:")).toBe(true);

    const envelope = JSON.parse(encrypted.slice("PTD-AES-HMAC-v1:".length));
    envelope.mac = envelope.mac.replace(/^./, envelope.mac.startsWith("0") ? "1" : "0");
    const tampered = `PTD-AES-HMAC-v1:${JSON.stringify(envelope)}`;
    expect(() => decryptData(tampered, "backup-key")).toThrow(/integrity|authentication/i);
  });

  it("新格式往返且错误口令拒绝；旧 OpenSSL 格式仍可读", () => {
    const data = { config: { lang: "en" } };
    const current = encryptData(data, "backup-key");
    expect(decryptData(current, "backup-key")).toEqual(data);
    expect(() => decryptData(current, "wrong-key")).toThrow(/integrity|authentication/i);

    // 旧版条目：OpenSSL Salted__ 格式，口令 = MD5(key).hex 前 16 位（由独立 node:crypto 实现生成）
    const legacy = legacyBackupEncrypt(data, "backup-key");
    expect(decryptData(legacy, "backup-key")).toEqual(data);
  });

  it("已认证的条目不能被重命名为另一个备份字段", () => {
    const encrypted = encryptData({ lang: "en" }, "backup-key", "config");
    expect(decryptData(encrypted, "backup-key", "config")).toEqual({ lang: "en" });
    expect(() => decryptData(encrypted, "backup-key", "metadata")).toThrow(/integrity|authentication/i);
  });

  describe("结构校验：拒绝形状不符的条目", () => {
    it("metadata 本身不是对象 → 拒", () => {
      expect(validateBackupPayload("metadata", [])).not.toBeNull();
      expect(validateBackupPayload("metadata", "oops")).not.toBeNull();
      expect(validateBackupPayload("metadata", null)).not.toBeNull();
    });

    it("metadata.sites 不是对象 → 拒", () => {
      expect(validateBackupPayload("metadata", { sites: "oops" })).not.toBeNull();
    });

    it("backupServers 的形状问题逐项被拦下", () => {
      // 条目不是对象
      expect(validateBackupPayload("metadata", { backupServers: { evil: "not-an-object" } })).not.toBeNull();
      // 缺少 type —— 决定「用哪个客户端实现」的字段
      expect(validateBackupPayload("metadata", { backupServers: { evil: { config: {} } } })).not.toBeNull();
      // config 不是对象 —— 凭据就在这里
      expect(
        validateBackupPayload("metadata", { backupServers: { evil: { type: "WebDAV", config: "x" } } }),
      ).not.toBeNull();
    });

    it("其余 storage 表的形状", () => {
      expect(validateBackupPayload("config", [])).not.toBeNull();
      expect(validateBackupPayload("userInfo", "x")).not.toBeNull();
      expect(validateBackupPayload("searchResultSnapshot", 1)).not.toBeNull();
      expect(validateBackupPayload("keepUploadTask", null)).not.toBeNull();
      expect(validateBackupPayload("cookies", [])).not.toBeNull();
      expect(validateBackupPayload("downloadHistory", {})).not.toBeNull();
    });

    it("未知字段不判断形状（保持前向兼容）", () => {
      expect(validateBackupPayload("someFutureField", "anything")).toBeNull();
    });
  });

  describe("降级攻击防护（M-4）", () => {
    it("用户提供了解密密钥时，manifest.encryption=false 的明文备份不得静默恢复", async () => {
      const blob = await backupDataToZipBlob({ config: { lang: "zh_CN" } }, "");

      await expect(zipBlobToBackupData(blob, "user-secret")).rejects.toThrow(/downgrade|unencrypted|integrity/i);
    });
  });

  it.each(["missing", "empty"])(
    "manifest 引用的文件 %s 时跳过该条目并给出 warning（与 Gist 路径统一）",
    async (kind) => {
      const zip = new JSZip();
      zip.file(
        "manifest.json",
        JSON.stringify({
          encryption: false,
          files: { config: { name: "config.json", hash: md5Hex("") } },
        }),
      );
      if (kind === "empty") zip.file("config.json", "");

      // 复检 P2（H）：旧实现 throw 导致整份恢复失败；现在统一为「记录 warning、跳过该条目」，
      // 让恢复对话框能显示「少了哪一块数据」，其余字段仍可恢复。
      const restored = await zipBlobToBackupData(await zip.generateAsync({ type: "blob" }));
      expect(restored.config).toBeUndefined();
      expect(getBackupWarnings(restored).some((warning) => /config\.json/.test(warning))).toBe(true);
    },
  );

  it("复检 P2（G）：条目数超过上限时拒绝恢复", async () => {
    const zip = new JSZip();
    const files: Record<string, { name: string; hash: string }> = {};
    for (let i = 0; i < 513; i++) {
      const name = `f${i}.json`;
      const content = JSON.stringify({ i });
      zip.file(name, content);
      files[`f${i}`] = { name, hash: md5Hex(content) };
    }
    zip.file("manifest.json", JSON.stringify({ encryption: false, files }));

    await expect(zipBlobToBackupData(await zip.generateAsync({ type: "blob" }))).rejects.toThrow(/条目数超过上限/);
  });

  describe("fflate 读取路径（替换 JSZip 后的兼容性）", () => {
    it("读取 JSZip 以 DEFLATE 生成的旧备份", async () => {
      const content = JSON.stringify({ lang: "zh_CN" });
      const zip = new JSZip();
      zip.file("config.json", content);
      zip.file(
        "manifest.json",
        JSON.stringify({ encryption: false, files: { config: { name: "config.json", hash: md5Hex(content) } } }),
      );

      const restored = await zipBlobToBackupData(await zip.generateAsync({ type: "blob", compression: "DEFLATE" }));
      expect(restored.config).toEqual({ lang: "zh_CN" });
    });

    it("条目开头的 BOM 与 JSZip 一样原样参与 MD5 校验（不会被解码器吞掉）", async () => {
      const content = JSON.stringify({ lang: "zh_CN" });
      const zip = new JSZip();
      zip.file("config.json", "\ufeff" + content);
      // manifest 的 hash 按「去掉 BOM 后」的内容计算：只有当解码器吞掉 BOM 时校验才会通过
      zip.file(
        "manifest.json",
        JSON.stringify({ encryption: false, files: { config: { name: "config.json", hash: md5Hex(content) } } }),
      );

      await expect(zipBlobToBackupData(await zip.generateAsync({ type: "blob" }))).rejects.toThrow(/hash mismatch/);
    });

    it("中央目录声明的原始大小超过解压上限时拒绝恢复（不为其分配缓冲区）", async () => {
      const zip = new JSZip();
      zip.file("config.json", JSON.stringify({ lang: "zh_CN" }));
      zip.file("manifest.json", JSON.stringify({ encryption: false, files: { config: { name: "config.json" } } }));
      const bytes = await zip.generateAsync({ type: "uint8array", compression: "STORE" });

      // 把 config.json 在中央目录里的「原始大小」改成 300MB（伪造的 zip bomb 头）
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      for (let i = 0; i + 46 <= bytes.length; i++) {
        if (view.getUint32(i, true) !== 0x02014b50) continue;
        const nameLength = view.getUint16(i + 28, true);
        const name = new TextDecoder().decode(bytes.subarray(i + 46, i + 46 + nameLength));
        if (name === "config.json") view.setUint32(i + 24, 300 * 1024 * 1024, true);
      }

      await expect(zipBlobToBackupData(new Blob([bytes as unknown as BlobPart]))).rejects.toThrow(/解压体积超过上限/);
    });

    it("不是 zip 的文件给出明确错误", async () => {
      await expect(zipBlobToBackupData(new Blob(["not a zip"]))).rejects.toThrow();
    });
  });

  describe("结构校验：不能误拒合法备份", () => {
    const validMetadata = {
      sites: { mteam: { isOffline: false } },
      solutions: {},
      snapshots: {},
      downloaders: {},
      mediaServers: {},
      backupServers: {
        abc: {
          id: "abc",
          type: "WebDAV",
          enabled: true,
          backupFields: ["config"],
          config: { address: "https://example.test/dav", loginName: "u", loginPwd: "p" },
        },
      },
    };

    it("完整 metadata 通过", () => {
      expect(validateBackupPayload("metadata", validMetadata)).toBeNull();
    });

    it("只含部分容器字段也通过（老备份/裁剪过的备份）", () => {
      expect(validateBackupPayload("metadata", { sites: {} })).toBeNull();
      expect(validateBackupPayload("metadata", {})).toBeNull();
    });

    it("合法类型全部通过", () => {
      expect(validateBackupPayload("config", {})).toBeNull();
      expect(validateBackupPayload("userInfo", { mteam: { "2026-01-01": {} } })).toBeNull();
      expect(validateBackupPayload("searchResultSnapshot", {})).toBeNull();
      expect(validateBackupPayload("keepUploadTask", {})).toBeNull();
      expect(validateBackupPayload("cookies", { "a.test": [] })).toBeNull();
      expect(validateBackupPayload("downloadHistory", [])).toBeNull();
    });
  });

  describe("警告的携带方式", () => {
    it("L-15：告警能经过 JSON 语义的消息传递（从备份服务器恢复走 offscreen → options）", () => {
      const data: IBackupData = { config: {}, manifest: { version: "v0.0.10" } };
      setBackupWarnings(data, ["metadata：形状不符，已跳过该条目"]);

      const overTheWire = JSON.parse(JSON.stringify(data)) as IBackupData;
      expect(getBackupWarnings(overTheWire)).toEqual(["metadata：形状不符，已跳过该条目"]);
      // 告警挂在 manifest 上，而不是新的顶层条目（顶层键会被当成可恢复字段）
      expect(Object.keys(data)).toEqual(["config", "manifest"]);
    });

    it("导出新备份时不把上一次解析的告警写进 manifest", async () => {
      const data: IBackupData = { config: { a: 1 }, manifest: { version: "v0.0.10" } };
      setBackupWarnings(data, ["stale warning"]);

      const blob = await backupDataToZipBlob(data);
      const restored = await zipBlobToBackupData(blob);
      expect(restored.manifest?.version).toBe("v0.0.10");
      expect(getBackupWarnings(restored)).toEqual([]);
    });

    it("未设置时返回空数组", () => {
      expect(getBackupWarnings({})).toEqual([]);
    });
  });
});
