import { describe, expect, it, vi } from "vitest";
import GoogleDrive from "@ptd/backupServer/entity/GoogleDrive.ts";

const GoogleDriveCtor = GoogleDrive as unknown as new (config: any) => GoogleDrive;

describe("GoogleDrive.list pagination", () => {
  it("末页没有 nextPageToken 时停止，且不再重用前一页令牌", async () => {
    const client = new GoogleDriveCtor({
      type: "GoogleDrive",
      config: { client_id: "id", client_secret: "secret", refresh_token: "token" },
    });
    (client as any).getScope = vi.fn().mockResolvedValue("appDataFolder");
    (client as any).getParentId = vi.fn().mockResolvedValue("appDataFolder");
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        data: {
          files: [{ name: "first.zip", id: "1", size: "10", createdTime: "2026-01-01" }],
          nextPageToken: "page-2",
        },
      })
      .mockResolvedValueOnce({
        data: { files: [{ name: "last.zip", id: "2", size: "20", createdTime: "2026-01-02" }] },
      });
    (client as any).request = request;

    await expect(client.list()).resolves.toMatchObject([{ filename: "first.zip" }, { filename: "last.zip" }]);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1][0].params.pageToken).toBe("page-2");
  });
});

describe("GoogleDrive.addFile upload strategy", () => {
  function createClient(zipBlob: { size: number; type: string }) {
    const client = new GoogleDriveCtor({
      type: "GoogleDrive",
      config: { client_id: "id", client_secret: "secret", refresh_token: "token" },
    });
    (client as any).getParentId = vi.fn().mockResolvedValue("parent-id");
    (client as any).backupDataToZipBlob = vi.fn().mockResolvedValue(zipBlob);
    return client;
  }

  it("小文件保持 multipart 上传", async () => {
    const blob = { size: 1024, type: "application/zip" };
    const client = createClient(blob);
    const request = vi.fn().mockResolvedValue({ data: { id: "file-1" } });
    (client as any).request = request;

    await expect(client.addFile("PTD_backup.zip", {} as any)).resolves.toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toMatchObject({
      method: "post",
      params: { uploadType: "multipart" },
    });
  });

  it("超过 4 MiB 的文件改走 resumable upload（先建会话再 PUT 整个 blob）", async () => {
    const blob = { size: 4 * 1024 * 1024 + 1, type: "application/zip" };
    const client = createClient(blob);
    const request = vi
      .fn()
      .mockResolvedValueOnce({ data: {}, headers: { location: "https://upload.example/session-1" } })
      .mockResolvedValueOnce({ data: { id: "file-2" } });
    (client as any).request = request;

    await expect(client.addFile("PTD_backup.zip", {} as any)).resolves.toBe(true);
    expect(request).toHaveBeenCalledTimes(2);

    // 第一步：JSON metadata + resumable 参数，并声明上传内容类型
    expect(request.mock.calls[0][0]).toMatchObject({
      method: "post",
      params: { uploadType: "resumable" },
      headers: {
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": "application/zip",
      },
      data: { name: "PTD_backup.zip", parents: ["parent-id"] },
    });

    // 第二步：把整个 blob 单次 PUT 到 Location
    expect(request.mock.calls[1][0]).toMatchObject({
      method: "put",
      url: "https://upload.example/session-1",
      headers: { "Content-Type": "application/zip" },
      data: blob,
    });
  });

  it("resumable 会话响应缺少 Location 时抛错（保留可诊断性）", async () => {
    const blob = { size: 4 * 1024 * 1024 + 1, type: "application/zip" };
    const client = createClient(blob);
    (client as any).request = vi.fn().mockResolvedValueOnce({ data: {}, headers: {} });

    await expect(client.addFile("PTD_backup.zip", {} as any)).rejects.toThrow(/missing Location header/);
  });
});
