import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  list: vi.fn(),
  deleteFile: vi.fn(async () => true),
}));

vi.mock("@/messages.ts", () => ({ onMessage: vi.fn(), sendMessage: mocks.sendMessage }));
vi.mock("@/offscreen/utils/logger.ts", () => ({ logger: vi.fn() }));
vi.mock("@/offscreen/utils/download.ts", () => ({ releaseBlobUrlWhenDownloadSettled: vi.fn() }));
vi.mock("@/offscreen/adapter/indexdb.ts", () => ({ ptdIndexDb: Promise.resolve({}) }));
vi.mock("@ptd/backupServer", () => ({
  getBackupServer: vi.fn(async () => ({ list: mocks.list, deleteFile: mocks.deleteFile })),
  getBackupServerMetaData: vi.fn(),
  entityList: [],
}));

describe("远端备份数量保留策略", () => {
  it("maxCount=1 时保护刚上传的文件，但删除另一份旧备份", async () => {
    const newest = {
      filename: "PTD_backup_20261006T1000.zip",
      path: "/newest.zip",
      time: new Date("2026-10-06T10:00:00").getTime(),
    };
    const older = {
      filename: "PTD_backup_20261005T1000.zip",
      path: "/older.zip",
      time: new Date("2026-10-05T10:00:00").getTime(),
    };
    mocks.sendMessage.mockImplementation(async (type: string) => {
      if (type === "getExtStorage") {
        return { backupServers: { server: { retention: { count: { enabled: true, maxCount: 1 } } } } };
      }
      return undefined;
    });
    mocks.list.mockResolvedValue([older, newest]);
    const { applyBackupRetention } = await import("@/offscreen/utils/backup.ts");

    const deleted = await applyBackupRetention("server", newest.filename);

    expect(deleted).toEqual([older]);
    expect(mocks.deleteFile).toHaveBeenCalledWith(older.path);
    expect(mocks.deleteFile).not.toHaveBeenCalledWith(newest.path);
  });
});
