/**
 * 流式 ZIP 写出器测试（见 docs/performance-audit.md P1-25）。
 *
 * 关键点：备份 zip 现在由自带的 `createZipBlob` 产出（加密=STORE，未加密=raw deflate），
 * 因此必须证明：
 * 1. CRC-32 实现正确（用标准向量 `123456789` → 0xCBF43926 校验）；
 * 2. 产物是**标准 ZIP**，能被真实恢复路径 `jsZipBlobToBackupData`（JSZip）完整读回；
 * 3. 备份格式约定不变：文件名仍为 `<key>.json` + `manifest.json`，
 *    manifest 中有 `files[*].{name,hash}`（MD5）与 `encryption: true`，解密后数据与原始一致；
 * 4. 未加密路径仍走 JSZip + DEFLATE，且两条路径都能往返。
 */
import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import { backupDataToJSZipBlob, jsZipBlobToBackupData } from "@ptd/backupServer/utils.ts";
import { crc32, createZipBlob } from "@ptd/backupServer/zipStream.ts";

function makeBackupData(): any {
  return {
    config: { lang: "zh_CN", tableBehavior: { MyData: { itemsPerPage: 10 } } },
    metadata: {
      sites: { mteam: { url: "https://mteam.example", merge: { name: "M-Team" } } },
      siteHostMap: { "mteam.example": "mteam" },
    },
    userInfo: { mteam: { "2026-10-04": { uploaded: 123456789, ratio: 1.5, seeding: [1, 2, 3] } } },
  };
}

describe("crc32：标准向量", () => {
  it('"123456789" → 0xCBF43926（CRC-32/ISO-HDLC 标准校验值）', () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });

  it("空数据 → 0", () => {
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
});

describe("createZipBlob：标准 ZIP 容器", () => {
  it("产出的 zip 能被 JSZip 读取，内容与 CRC/大小一致", async () => {
    const blob = await createZipBlob([
      { name: "a.json", content: '{"hello":"世界"}' },
      { name: "b.json", content: "plain text" },
    ]);

    const zip = await JSZip.loadAsync(blob);
    expect(Object.keys(zip.files).sort()).toEqual(["a.json", "b.json"]);
    expect(await zip.file("a.json")!.async("string")).toBe('{"hello":"世界"}');
    expect(await zip.file("b.json")!.async("string")).toBe("plain text");
  });

  it("空条目集合也能产出合法 zip", async () => {
    const blob = await createZipBlob([]);
    const zip = await JSZip.loadAsync(blob);
    expect(Object.keys(zip.files)).toEqual([]);
  });

  it("接受 Uint8Array 内容", async () => {
    const blob = await createZipBlob([{ name: "bin.dat", content: new Uint8Array([1, 2, 3, 255]) }]);
    const zip = await JSZip.loadAsync(blob);
    expect(Array.from(await zip.file("bin.dat")!.async("uint8array"))).toEqual([1, 2, 3, 255]);
  });

  it("压缩模式（raw deflate）：内容可被 JSZip 读回，且压缩后体积更小", async () => {
    const content = JSON.stringify({ data: "x".repeat(20000) });
    const stored = await createZipBlob([{ name: "a.json", content }], { compress: false });
    const deflated = await createZipBlob([{ name: "a.json", content }], { compress: true });

    expect(deflated.size).toBeLessThan(stored.size);

    const zip = await JSZip.loadAsync(deflated);
    expect(await zip.file("a.json")!.async("string")).toBe(content);
  });

  it("多条目 + 跨 64KiB 的内容：中央目录偏移与大小都正确", async () => {
    const entries = Array.from({ length: 10 }, (_, i) => ({
      name: `entry-${i}.json`,
      content: `${i}:`.repeat(i === 5 ? 40000 : 10), // 其中一条约 80KB，跨越单次写入边界
    }));

    const blob = await createZipBlob(entries);
    const zip = await JSZip.loadAsync(blob);

    expect(Object.keys(zip.files).sort()).toEqual(entries.map((e) => e.name).sort());
    for (const entry of entries) {
      expect(await zip.file(entry.name)!.async("string")).toBe(entry.content);
    }
  });
});

describe("加密备份走流式写出器后的往返（真实恢复路径）", () => {
  const encryptionKey = "test-encryption-key";

  it("导出 → 恢复：数据完全一致，manifest 约定不变", async () => {
    const data = makeBackupData();
    const blob = await backupDataToJSZipBlob(JSON.parse(JSON.stringify(data)), encryptionKey);

    // 产物是标准 zip：条目名与格式约定不变
    const zip = await JSZip.loadAsync(blob);
    const manifestRaw = await zip.file("manifest.json")!.async("string");
    const manifest = JSON.parse(manifestRaw);
    expect(manifest.encryption).toBe(true);
    expect(Object.keys(manifest.files).sort()).toEqual(["config", "metadata", "userInfo"]);
    for (const key of Object.keys(manifest.files)) {
      expect(manifest.files[key].name).toBe(`${key}.json`);
      expect(manifest.files[key].hash).toMatch(/^[a-f0-9]{32}$/); // MD5 hex
    }

    const restored: any = await jsZipBlobToBackupData(blob, encryptionKey);
    expect(restored.config).toEqual(data.config);
    expect(restored.metadata).toEqual(data.metadata);
    expect(restored.userInfo).toEqual(data.userInfo);
  }, 15_000);

  it("密钥错误时恢复必须失败（条目仍受 AES 保护）", async () => {
    const blob = await backupDataToJSZipBlob(makeBackupData(), encryptionKey);
    await expect(jsZipBlobToBackupData(blob, "wrong-key")).rejects.toBeTruthy();
  });
});

describe("未加密备份仍走 JSZip + DEFLATE 且可往返", () => {
  it("导出 → 恢复数据一致，manifest.encryption 为 false", async () => {
    const data = makeBackupData();
    const blob = await backupDataToJSZipBlob(JSON.parse(JSON.stringify(data)), "");
    const zip = await JSZip.loadAsync(blob);
    const manifest = JSON.parse(await zip.file("manifest.json")!.async("string"));
    expect(manifest.encryption).toBe(false);

    const restored: any = await jsZipBlobToBackupData(blob, "");
    expect(restored.config).toEqual(data.config);
    expect(restored.metadata).toEqual(data.metadata);
    expect(restored.userInfo).toEqual(data.userInfo);
  });
});
