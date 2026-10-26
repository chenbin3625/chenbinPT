/**
 * WebDAV 备份文件路径清理回归（缺陷清单 M-9）。
 *
 * 缺陷：`getFile` / `deleteFile` 把调用方给的 `path` 原样交给 `urlJoin("/", path)`，
 * 含 `../` 的路径会逃出备份根目录（读/删到 WebDAV 上的任意文件）。
 * 修复后先把 `..` 段与重复斜杠清掉再拼接；这里断言真正传给 WebDAV 客户端的路径，
 * 并保留一条「正常文件名不受影响」的对照组。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@ptd/site/utils/adapter.ts", () => ({ logMessage: vi.fn() }));
vi.mock("webdav", () => ({ AuthType: { Digest: "digest" }, createClient: vi.fn() }));

import WebDAV, { sanitizeWebdavPath } from "@ptd/backupServer/entity/WebDAV.ts";

/** 实体构造函数在基类中是 protected（应用侧通过 getBackupServer() 创建），测试里用一次类型断言绕过可见性 */
const WebDAVCtor = WebDAV as unknown as new (config: any) => WebDAV;

const serverConfig = {
  id: "webdav-test",
  type: "WebDAV",
  name: "WebDAV",
  config: { address: "https://dav.example.com/dav", loginName: "u", loginPwd: "p", digest: false },
};

function createServer() {
  const server = new WebDAVCtor(serverConfig);
  const client = {
    getFileContents: vi.fn().mockResolvedValue(new ArrayBuffer(0)),
    deleteFile: vi.fn().mockResolvedValue(true),
  };
  // getServer() 会复用已存在的实例，直接注入替身即可绕开真实 WebDAV 客户端
  (server as any).server = client;
  (server as any).zipBlobToBackupData = vi.fn().mockResolvedValue({});
  return { server, client };
}

describe("WebDAV.getFile / deleteFile：路径清理（M-9）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("getFile 去掉 ../ 后再拼到根路径（不能读到根目录之外）", async () => {
    const { server, client } = createServer();

    await server.getFile("../../../etc/backup.zip");

    expect(client.getFileContents).toHaveBeenCalledTimes(1);
    expect(client.getFileContents.mock.calls[0]![0]).toBe("/etc/backup.zip");
  });

  it("deleteFile 同样清理路径", async () => {
    const { server, client } = createServer();

    await expect(server.deleteFile("../../other/backup.zip")).resolves.toBe(true);

    expect(client.deleteFile).toHaveBeenCalledTimes(1);
    expect(client.deleteFile.mock.calls[0]![0]).toBe("/other/backup.zip");
  });

  it("重复斜杠被折叠，嵌套目录仍然保留", async () => {
    const { server, client } = createServer();

    await server.getFile("backups//2026//PTD_backup.zip");

    expect(client.getFileContents.mock.calls[0]![0]).toBe("/backups/2026/PTD_backup.zip");
  });

  it("对照组：正常备份文件名原样使用", async () => {
    const { server, client } = createServer();

    await server.getFile("PTD_backup_20261004T021500.zip");

    expect(client.getFileContents.mock.calls[0]![0]).toBe("/PTD_backup_20261004T021500.zip");
  });

  /**
   * 复检 P2（D）：单次解码挡不住多重编码。
   * `..%252f..%252fetc%252fpasswd` 解码一次得到 `..%2f..%2fetc%2fpasswd`，
   * 若不继续解码就会作为「合法段」传给客户端，服务端再解码一次即变成 `../../etc/passwd`。
   */
  it("多重编码的 ../ 也会被逐层解码并清理（getFile / deleteFile）", async () => {
    const { server, client } = createServer();

    await server.getFile("..%252f..%252fetc%252fpasswd");
    expect(client.getFileContents.mock.calls[0]![0]).toBe("/etc/passwd");

    await server.deleteFile("..%252f..%252fetc%252fpasswd");
    expect(client.deleteFile.mock.calls[0]![0]).toBe("/etc/passwd");
  });

  it("三层编码同样收敛到不动点（纯函数）", () => {
    expect(sanitizeWebdavPath("..%25252f..%25252fetc%25252fpasswd")).toBe("etc/passwd");
    expect(sanitizeWebdavPath("a%2520b/PTD_backup.zip")).toBe("a b/PTD_backup.zip");
  });
});
