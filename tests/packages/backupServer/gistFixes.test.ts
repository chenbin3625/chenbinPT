/**
 * C2-B-4 / C2-B-10：Gist 历史分页、删除提示、降级错误透传。
 *
 * - `/gists/{id}/commits` 是分页接口，旧实现只取 per_page=100 的第一页，
 *   备份超过 100 份后更早版本在恢复对话框消失；
 * - `deleteFile` 恒 false 且调用侧不记日志，保留策略永久静默失效；
 * - 恢复明文备份（manifest.encryption=false + 本机有密钥）时，BackupDowngradeError 被吞成
 *   "Failed to decrypt file."，用户不知道「清空密钥即可恢复」。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { md5Hex } from "./helpers/nodeCryptoOracle.ts";

const logMessageMock = vi.hoisted(() => vi.fn());
const axiosGetMock = vi.hoisted(() => vi.fn());

vi.mock("@ptd/site/utils/adapter.ts", () => ({ logMessage: logMessageMock }));
vi.mock("axios", async (importOriginal) => {
  const actual = await importOriginal<typeof import("axios")>();
  return {
    ...actual,
    default: { ...actual.default, get: axiosGetMock, request: vi.fn() },
  };
});

import Gist from "@ptd/backupServer/entity/Gist.ts";
import { encryptData, getBackupWarnings } from "@ptd/backupServer/utils.ts";

const GistCtor = Gist as unknown as new (config: any) => Gist;

const makeClient = () =>
  new GistCtor({ id: "gist-1", type: "Gist", name: "Gist", config: { gist_id: "gist-abc", access_token: "token" } });

function commit(version: string, deletions = 1) {
  return {
    version,
    committed_at: "2026-10-01T00:00:00Z",
    change_status: { total: deletions + 1, additions: 1, deletions },
  };
}

beforeEach(() => {
  logMessageMock.mockClear();
  (Gist as any).warnedDeleteUnsupported = false;
});

describe("C2-B-4：Gist 历史分页", () => {
  it("第一页满 100 条时继续翻页，直到不足一页为止", async () => {
    const client = makeClient();
    const fullPage = Array.from({ length: 100 }, (_, i) => commit(`v${i + 1}`));
    const request = vi
      .fn()
      .mockResolvedValueOnce({ data: fullPage })
      .mockResolvedValueOnce({ data: [commit("v101"), commit("v102")] });
    (client as any).request = request;

    const files = await client.list();

    expect(files).toHaveLength(102);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0][1].params).toMatchObject({ per_page: 100, page: 1 });
    expect(request.mock.calls[1][1].params).toMatchObject({ per_page: 100, page: 2 });
    // 按时间倒序（同一时间时保持相对顺序不重要，这里只校验数量与分页）
    expect(files[0].size).toBe("N/A");
  });

  it("不足一页时立即停止，不请求空页", async () => {
    const client = makeClient();
    const request = vi.fn().mockResolvedValue({ data: [commit("v1"), commit("v2")] });
    (client as any).request = request;

    await expect(client.list()).resolves.toHaveLength(2);
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe("C2-B-4：Gist 不支持删除时留下一次提示", () => {
  it("deleteFile 仍返回 false，但每个上下文只记录一次 warn", async () => {
    const client = makeClient();

    await expect(client.deleteFile("v1")).resolves.toBe(false);
    await expect(client.deleteFile("v2")).resolves.toBe(false);

    const unsupportedLogs = logMessageMock.mock.calls.filter(([msg]) => String(msg).includes("不支持删除"));
    expect(unsupportedLogs).toHaveLength(1);
    expect(unsupportedLogs[0][2]).toBe("warn");
  });
});

describe("C2-B-10：降级错误不能被通用解密失败文案吞掉", () => {
  it("manifest.encryption=false + 本机密钥时抛出可操作的降级错误", async () => {
    const client = makeClient();
    client.setEncryptionKey("real-user-key");

    const configContent = JSON.stringify({ lang: "zh_CN" });
    const manifest = {
      version: "v",
      time: 0,
      encryption: false,
      files: { config: { name: "config.json", hash: md5Hex(configContent) } },
    };
    (client as any).request = vi.fn().mockResolvedValue({
      data: {
        files: {
          "_manifest.json": { content: JSON.stringify(manifest), truncated: false },
          "config.json": { content: configContent, truncated: false },
        },
      },
    });

    await expect(client.getFile("v1")).rejects.toThrow(/unencrypted backup while a decryption key/i);
  });
});

/**
 * 复检 P2（C/H）：Gist 恢复路径的凭据外泄面与恢复提示。
 */
describe("复检 P2：Gist raw_url / 候选密钥顺序 / 缺失文件提示", () => {
  beforeEach(() => {
    axiosGetMock.mockReset();
    logMessageMock.mockClear();
  });

  it("truncated 文件用裸 axios 拉 raw_url，且不携带 Authorization 头", async () => {
    const client = makeClient();
    const configContent = JSON.stringify({ lang: "zh_CN" });
    const manifest = {
      version: "v",
      time: 0,
      encryption: false,
      files: { config: { name: "config.json", hash: md5Hex(configContent) } },
    };
    const rawUrl = "https://gist.githubusercontent.com/u/abc/raw/def/config.json";
    (client as any).request = vi.fn().mockResolvedValue({
      data: {
        files: {
          "_manifest.json": { content: JSON.stringify(manifest), truncated: false },
          // GitHub 对 >1MB 文件返回 truncated + 空 content，必须先拉 raw_url
          "config.json": { content: "", truncated: true, raw_url: rawUrl },
        },
      },
    });
    axiosGetMock.mockResolvedValue({ data: configContent });

    const result = await client.getFile("v1");

    expect(result.config).toEqual({ lang: "zh_CN" });
    expect(axiosGetMock).toHaveBeenCalledTimes(1);
    const [url, config] = axiosGetMock.mock.calls[0]!;
    expect(url).toBe(rawUrl);
    expect(config).toMatchObject({ responseType: "text" });
    // 关键：raw CDN 请求绝不能带 PAT
    expect(config).not.toHaveProperty("headers");
  });

  it("候选密钥按「真实密钥优先」，正确密钥恢复不再刷误导性 warn", async () => {
    const client = makeClient();
    client.setEncryptionKey("real-user-key");
    const encrypted = encryptData({ lang: "zh_CN" }, "real-user-key", "config");
    const manifest = {
      version: "v",
      time: 0,
      encryption: true,
      files: { config: { name: "config.json", hash: md5Hex(encrypted) } },
    };
    (client as any).request = vi.fn().mockResolvedValue({
      data: {
        files: {
          "_manifest.json": { content: JSON.stringify(manifest), truncated: false },
          "config.json": { content: encrypted, truncated: false },
        },
      },
    });

    const result = await client.getFile("v1");

    expect(result.config).toEqual({ lang: "zh_CN" });
    expect(logMessageMock.mock.calls.some(([msg]) => String(msg).includes("候选密钥解密失败"))).toBe(false);
  });

  it("manifest 引用缺失文件时给出 warning，而不是静默跳过", async () => {
    const client = makeClient();
    const manifest = {
      version: "v",
      time: 0,
      encryption: false,
      files: { config: { name: "config.json", hash: md5Hex("{}") } },
    };
    (client as any).request = vi.fn().mockResolvedValue({
      data: { files: { "_manifest.json": { content: JSON.stringify(manifest), truncated: false } } },
    });

    const result = await client.getFile("v1");

    expect(result.config).toBeUndefined();
    expect(getBackupWarnings(result).some((warning) => /config\.json/.test(warning))).toBe(true);
  });
});

describe("Gist addFile：仅清理上一份备份清单登记的文件，不误删 Gist 中其他文件", () => {
  beforeEach(() => {
    axiosGetMock.mockReset();
    logMessageMock.mockClear();
  });

  it("保留 Gist 中已有的 myscript.js 与 .keep. 文件，仅删除上一份 manifest 登记且本次未包含的旧备份文件", async () => {
    const client = makeClient();
    const prevManifest = {
      version: "Gist (v1)",
      time: 100,
      encryption: false,
      files: {
        config: { name: "config.json", hash: md5Hex("{}") },
        keepMarker: { name: "metadata.keep.json", hash: md5Hex("{}") },
      },
    };
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        data: {
          files: {
            "myscript.js": { content: "console.log('keep me');", truncated: false },
            "_manifest.json": { content: JSON.stringify(prevManifest), truncated: false },
            "config.json": { content: "{}", truncated: false },
            "metadata.keep.json": { content: "{}", truncated: false },
          },
        },
      })
      .mockResolvedValueOnce({ data: {} });
    (client as any).request = request;

    const ok = await client.addFile("backup-userinfo-only", { userInfo: { demo: {} } } as any);

    expect(ok).toBe(true);
    expect(request).toHaveBeenCalledTimes(2);
    const patchPayload = request.mock.calls[1][1].data.files as Record<string, unknown>;
    expect(patchPayload).toHaveProperty("_manifest.json");
    expect(patchPayload).toHaveProperty("userInfo.json");
    expect(patchPayload["config.json"]).toBeNull();
    expect(Object.hasOwn(patchPayload, "myscript.js")).toBe(false);
    expect(Object.hasOwn(patchPayload, "metadata.keep.json")).toBe(false);
  });

  it("目标 Gist 尚无 _manifest.json 时，不删除任何已有文件", async () => {
    const client = makeClient();
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        data: {
          files: {
            "myscript.js": { content: "console.log('standalone');", truncated: false },
            "notes.md": { content: "# Notes", truncated: false },
          },
        },
      })
      .mockResolvedValueOnce({ data: {} });
    (client as any).request = request;

    const ok = await client.addFile("first-backup", { userInfo: { demo: {} } } as any);

    expect(ok).toBe(true);
    const patchPayload = request.mock.calls[1][1].data.files as Record<string, unknown>;
    expect(Object.hasOwn(patchPayload, "myscript.js")).toBe(false);
    expect(Object.hasOwn(patchPayload, "notes.md")).toBe(false);
  });

  it("上一份 _manifest.json 被截断时通过裸 axios 拉取 raw_url 并仅清理清单内旧文件", async () => {
    const client = makeClient();
    const rawManifestUrl = "https://gist.githubusercontent.com/u/abc/raw/def/_manifest.json";
    const prevManifest = {
      version: "Gist (v1)",
      time: 100,
      encryption: false,
      files: {
        metadata: { name: "metadata.json", hash: md5Hex("{}") },
      },
    };
    axiosGetMock.mockResolvedValueOnce({ data: JSON.stringify(prevManifest) });
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        data: {
          files: {
            "myscript.js": { content: "console.log('keep');", truncated: false },
            "_manifest.json": { content: "", truncated: true, raw_url: rawManifestUrl },
            "metadata.json": { content: "{}", truncated: false },
          },
        },
      })
      .mockResolvedValueOnce({ data: {} });
    (client as any).request = request;

    const ok = await client.addFile("backup-truncated", { userInfo: { demo: {} } } as any);

    expect(ok).toBe(true);
    expect(axiosGetMock).toHaveBeenCalledTimes(1);
    expect(axiosGetMock.mock.calls[0][0]).toBe(rawManifestUrl);
    expect(axiosGetMock.mock.calls[0][1]).not.toHaveProperty("headers");
    const patchPayload = request.mock.calls[1][1].data.files as Record<string, unknown>;
    expect(patchPayload["metadata.json"]).toBeNull();
    expect(Object.hasOwn(patchPayload, "myscript.js")).toBe(false);
  });
});
