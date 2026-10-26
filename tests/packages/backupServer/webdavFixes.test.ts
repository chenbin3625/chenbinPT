/**
 * C2-B-2 / C2-B-9：WebDAV 请求超时与路径清理。
 *
 * - webdav@5 的 `createClient` 没有 timeout 选项（只有逐方法 `signal`），服务端挂死会让
 *   `exportBackupData` 永不返回并卡住自动备份锁；修复为所有请求经 `withRequestTimeout`
 *   传入 AbortSignal。
 * - 路径清理旧实现只删字面 `..`，`%2e%2e%2f` 等编码形式仍可能跳出备份根目录。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@ptd/site/utils/adapter.ts", () => ({ logMessage: vi.fn() }));
vi.mock("webdav", () => ({ AuthType: { Digest: "digest" }, createClient: vi.fn() }));

import WebDAV, { sanitizeWebdavPath } from "@ptd/backupServer/entity/WebDAV.ts";

const WebDAVCtor = WebDAV as unknown as new (config: any) => WebDAV;

const serverConfig = {
  id: "webdav-timeout-test",
  type: "WebDAV",
  name: "WebDAV",
  config: { address: "https://dav.example.com/dav", loginName: "u", loginPwd: "p", digest: false },
};

function createServer(client: Record<string, any>) {
  const server = new WebDAVCtor(serverConfig);
  (server as any).server = client;
  (server as any).zipBlobToBackupData = vi.fn().mockResolvedValue({});
  return server;
}

describe("C2-B-2：WebDAV 请求带 AbortSignal", () => {
  it("ping / list / addFile / getFile / deleteFile 都把 signal 传给 webdav 客户端", async () => {
    const client = {
      getDirectoryContents: vi.fn().mockResolvedValue([]),
      putFileContents: vi.fn().mockResolvedValue(true),
      getFileContents: vi.fn().mockResolvedValue(new ArrayBuffer(0)),
      deleteFile: vi.fn().mockResolvedValue(undefined),
    };
    const server = createServer(client);
    (server as any).backupDataToZipBlob = vi.fn().mockResolvedValue(new Blob(["zip"]));

    await expect(server.ping()).resolves.toBe(true);
    await expect(server.list()).resolves.toEqual([]);
    await expect(server.addFile("a.zip", {} as any)).resolves.toBe(true);
    await expect(server.getFile("a.zip")).resolves.toEqual({});
    await expect(server.deleteFile("a.zip")).resolves.toBe(true);

    const optionsList = [
      client.getDirectoryContents.mock.calls[0]?.[1],
      client.putFileContents.mock.calls[0]?.[2],
      client.getFileContents.mock.calls[0]?.[1],
      client.deleteFile.mock.calls[0]?.[1],
    ];
    for (const options of optionsList) {
      expect(options?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("withRequestTimeout 超时后 abort，使挂死的请求 reject", async () => {
    const server = createServer({});

    const pending = (server as any).withRequestTimeout(
      (signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error(`aborted: ${(signal.reason as Error)?.message}`)));
        }),
      10,
    );

    await expect(pending).rejects.toThrow(/aborted: .*timeout after 10ms/);
  });
});

describe("C2-B-9：WebDAV 路径清理覆盖编码形式", () => {
  it.each([
    ["PTD_backup_20261004T0215_abc.zip", "PTD_backup_20261004T0215_abc.zip"],
    ["../../../etc/backup.zip", "etc/backup.zip"],
    ["..%2f..%2fetc%2fpasswd", "etc/passwd"],
    ["%2e%2e/%2e%2e/x", "x"],
    ["..\\..\\backup.zip", "backup.zip"],
    ["backups//2026//file.zip", "backups/2026/file.zip"],
    ["./backup.zip", "backup.zip"],
  ])("sanitizeWebdavPath(%s) → %s", (input, expected) => {
    expect(sanitizeWebdavPath(input)).toBe(expected);
  });

  it("非法百分号编码不抛错，按字面过滤", () => {
    expect(sanitizeWebdavPath("%zz/../backup.zip")).toBe("%zz/backup.zip");
  });

  it("getFile / deleteFile 使用清理后的路径", async () => {
    const client = {
      getFileContents: vi.fn().mockResolvedValue(new ArrayBuffer(0)),
      deleteFile: vi.fn().mockResolvedValue(undefined),
    };
    const server = createServer(client);

    await server.getFile("%2e%2e%2fetc%2fbackup.zip");
    expect(client.getFileContents.mock.calls[0]![0]).toBe("/etc/backup.zip");

    await server.deleteFile("..%2f..%2fother%2fbackup.zip");
    expect(client.deleteFile.mock.calls[0]![0]).toBe("/other/backup.zip");
  });
});

beforeEach(() => {
  vi.clearAllMocks();
});
