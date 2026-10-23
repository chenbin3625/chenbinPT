/**
 * C2 修复回归（backupServer 杂项）：
 * - C2-B-7：CookieCloud.deleteFile 不再写入多余 `cookie` 字段，且不产生空名/无时间的幽灵历史
 * - C2-B-8：localSort 返回副本，不就地修改调用方数组
 * - C2-B-11：DropBox ping 改用备份功能本身就依赖的 files/list_folder（不需要 account_info.read）
 */
import CryptoJS from "crypto-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const axiosMock = vi.hoisted(() => ({ request: vi.fn() }));

vi.mock("@ptd/site/utils/adapter.ts", () => ({ logMessage: vi.fn() }));
vi.mock("axios", async (importOriginal) => {
  const actual = await importOriginal<typeof import("axios")>();
  return { ...actual, default: { ...actual.default, request: axiosMock.request } };
});

import CookieCloud from "@ptd/backupServer/entity/CookieCloud.ts";
import DropBox from "@ptd/backupServer/entity/DropBox.ts";
import { localSort } from "@ptd/backupServer/utils.ts";
import { EListOrderMode } from "@ptd/backupServer";

const CookieCloudCtor = CookieCloud as unknown as new (config: any) => CookieCloud;
const DropBoxCtor = DropBox as unknown as new (config: any) => DropBox;

const cookieCloudConfig = {
  id: "cc-1",
  type: "CookieCloud",
  name: "CookieCloud",
  config: { address: "https://cookiecloud.example.com/", uuid: "uuid", password: "pass", headers: "" },
};

beforeEach(() => {
  axiosMock.request.mockReset();
  (CookieCloud as any).fileCache.clear();
});

describe("C2-B-7：CookieCloud.deleteFile 清空语义", () => {
  it("上传的是空 cookie_data、空 ptd_data，manifest 有 fileName 与 time，且不写入多余的 cookie 字段", async () => {
    axiosMock.request.mockResolvedValue({ data: { action: "done" } });
    const server = new CookieCloudCtor(cookieCloudConfig);

    await expect(server.deleteFile("")).resolves.toBe(true);

    const requestData = axiosMock.request.mock.calls[0][0] as any;
    const key = CryptoJS.MD5("uuid-pass").toString().substring(0, 16);
    const decrypted = JSON.parse(CryptoJS.AES.decrypt(requestData.data.encrypted, key).toString(CryptoJS.enc.Utf8));

    expect(decrypted.cookie_data).toEqual({});
    expect(decrypted.ptd_data).toEqual({});
    expect(decrypted.ptd_data.cookie).toBeUndefined();
    expect(decrypted.manifest.fileName).toBe("");
    expect(typeof decrypted.manifest.time).toBe("number");
  });

  it("删除后 list 不再返回空文件名的幽灵条目", async () => {
    const server = new CookieCloudCtor(cookieCloudConfig);
    (server as any).getFile = vi.fn().mockResolvedValue({ cookies: {}, manifest: { fileName: "", time: 1 } });

    await expect(server.list()).resolves.toEqual([]);
  });

  it("正常备份仍然在 list 中返回一条", async () => {
    const server = new CookieCloudCtor(cookieCloudConfig);
    (server as any).getFile = vi
      .fn()
      .mockResolvedValue({ cookies: {}, manifest: { fileName: "PTD_backup_x.zip", time: 123, size: "N/A" } });

    await expect(server.list()).resolves.toEqual([{ filename: "PTD_backup_x.zip", path: "", time: 123, size: "N/A" }]);
  });
});

describe("C2-B-8：localSort 不就地修改入参", () => {
  it("返回新数组，原数组顺序保持不变", () => {
    const input = [
      { filename: "older.zip", path: "older.zip", time: 10, size: 1 },
      { filename: "newer.zip", path: "newer.zip", time: 100, size: 2 },
    ];
    const snapshot = input.map((item) => item.filename);

    const sorted = localSort(input, {});

    expect(sorted).not.toBe(input);
    expect(sorted.map((item) => item.filename)).toEqual(["newer.zip", "older.zip"]);
    expect(input.map((item) => item.filename)).toEqual(snapshot);
  });

  it("asc 模式同样不修改入参", () => {
    const input = [
      { filename: "a.zip", path: "a.zip", time: 2, size: 1 },
      { filename: "b.zip", path: "b.zip", time: 1, size: 1 },
    ];
    localSort(input, { orderMode: EListOrderMode.asc });
    expect(input.map((item) => item.filename)).toEqual(["a.zip", "b.zip"]);
  });
});

describe("C2-B-11：DropBox ping 使用 files/list_folder", () => {
  it("成功时返回 true，且请求打到 files/list_folder（不需要 account_info.read）", async () => {
    const client = new DropBoxCtor({ id: "db-1", type: "DropBox", name: "DropBox", config: { access_token: "t" } });
    (client as any).request = vi.fn().mockResolvedValue({ data: { entries: [] } });

    await expect(client.ping()).resolves.toBe(true);
    expect((client as any).request.mock.calls[0][0].url).toBe("https://api.dropboxapi.com/2/files/list_folder");
  });

  it("失败时返回 false", async () => {
    const client = new DropBoxCtor({ id: "db-1", type: "DropBox", name: "DropBox", config: { access_token: "t" } });
    (client as any).request = vi.fn().mockRejectedValue(new Error("invalid_access_token"));

    await expect(client.ping()).resolves.toBe(false);
  });
});
