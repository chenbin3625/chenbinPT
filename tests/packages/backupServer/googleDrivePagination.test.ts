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
