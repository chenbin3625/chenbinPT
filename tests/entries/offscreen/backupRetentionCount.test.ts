import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-07T00:00:00Z"));
    mocks.sendMessage.mockReset();
    mocks.list.mockReset();
    mocks.deleteFile.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("maxCount=1 时保护刚上传的文件，但删除另一份旧备份", async () => {
    const newest = {
      filename: "PTD_backup_20261006T1000.zip",
      path: "/newest.zip",
      time: new Date("2026-10-06T10:00:00Z").getTime(),
    };
    const older = {
      filename: "PTD_backup_20261005T1000.zip",
      path: "/older.zip",
      time: new Date("2026-10-05T10:00:00Z").getTime(),
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
    expect(mocks.deleteFile).toHaveBeenCalledTimes(1);
    expect(mocks.deleteFile).toHaveBeenCalledWith(older.path);
    expect(mocks.deleteFile).not.toHaveBeenCalledWith(newest.path);
  });

  it("keepFilename 时间早于最新备份时仍受保护（maxCount=1 下不被误删）", async () => {
    const newer = {
      filename: "PTD_backup_20261006T1000.zip",
      path: "/newer.zip",
      time: new Date("2026-10-06T10:00:00Z").getTime(),
    };
    const uploaded = {
      filename: "PTD_backup_20261005T1000.zip",
      path: "/uploaded.zip",
      time: new Date("2026-10-05T10:00:00Z").getTime(),
    };
    const oldest = {
      filename: "PTD_backup_20261004T1000.zip",
      path: "/oldest.zip",
      time: new Date("2026-10-04T10:00:00Z").getTime(),
    };
    mocks.sendMessage.mockImplementation(async (type: string) => {
      if (type === "getExtStorage") {
        return { backupServers: { server: { retention: { count: { enabled: true, maxCount: 1 } } } } };
      }
      return undefined;
    });
    mocks.list.mockResolvedValue([oldest, uploaded, newer]);
    const { applyBackupRetention } = await import("@/offscreen/utils/backup.ts");

    // pruneBackupFiles 在 maxCount=1 下会选中 uploaded 和 oldest 待删，
    // applyBackupRetention 的 keepFilename 保护逻辑必须滤掉 uploaded，仅删除 oldest
    const deleted = await applyBackupRetention("server", uploaded.filename);

    expect(deleted).toEqual([oldest]);
    expect(mocks.deleteFile).toHaveBeenCalledTimes(1);
    expect(mocks.deleteFile).toHaveBeenCalledWith(oldest.path);
    expect(mocks.deleteFile).not.toHaveBeenCalledWith(uploaded.path);
    expect(mocks.deleteFile).not.toHaveBeenCalledWith(newer.path);
  });
});
