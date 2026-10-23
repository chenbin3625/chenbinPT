/**
 * C2-B-3：OWSS 错误处理与分页。
 *
 * 上游 OWSS 用 HTTP 200 + `{error}` / `{code,msg}` 表达错误，axios 不会 reject：
 * 旧实现 list 静默返回 []、addFile/deleteFile 静默 false，用户与自动备份日志都看不到原因。
 * 另外上游 `/list` 默认 `pageSize=10`（storage.ts getResourceList 默认参数），
 * 不显式传 `pageSize=-1` 时最多只能看到 10 份历史备份。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const logMessageMock = vi.hoisted(() => vi.fn());
const axiosMock = vi.hoisted(() => ({ request: vi.fn() }));

vi.mock("@ptd/site/utils/adapter.ts", () => ({ logMessage: logMessageMock }));
vi.mock("axios", async (importOriginal) => {
  const actual = await importOriginal<typeof import("axios")>();
  return { ...actual, default: { ...actual.default, request: axiosMock.request } };
});

import OWSS from "@ptd/backupServer/entity/OWSS.ts";

const OWSSCtor = OWSS as unknown as new (config: any) => OWSS;

const makeClient = () =>
  new OWSSCtor({
    id: "owss-1",
    type: "OWSS",
    name: "OWSS",
    config: { address: "http://127.0.0.1:8088/storage", authCode: "auth-code" },
  });

const lastLogMessage = () => logMessageMock.mock.calls.at(-1)?.[0] as string | undefined;

beforeEach(() => {
  logMessageMock.mockClear();
  axiosMock.request.mockReset();
});

describe("C2-B-3：OWSS 分页", () => {
  it("list 显式请求全部文件（page=1&pageSize=-1），不接受服务端默认的 10 条上限", async () => {
    axiosMock.request.mockResolvedValue({
      data: { data: [{ name: "PTD_backup_a.zip", time: 1, size: 2, type: "file" }] },
    });

    const files = await makeClient().list({ orderBy: "time" as any, orderMode: "desc" as any });

    expect(files).toEqual([{ filename: "PTD_backup_a.zip", path: "PTD_backup_a.zip", time: 1, size: 2 }]);
    expect(axiosMock.request.mock.calls[0][0].params).toMatchObject({ page: 1, pageSize: -1 });
  });
});

describe("C2-B-3：OWSS 错误不再静默", () => {
  it("list 收到 error 响应时抛错并记录原因", async () => {
    axiosMock.request.mockResolvedValue({ data: { error: { code: 10004, msg: "Invalid request id" } } });

    await expect(makeClient().list()).rejects.toThrow(/Invalid request id/);
    expect(lastLogMessage()).toBe("[OWSS] list 失败");
  });

  it("list 收到 {code,msg} 响应时抛错并记录原因", async () => {
    axiosMock.request.mockResolvedValue({ data: { code: 10003, msg: "Invalid request" } });

    await expect(makeClient().list()).rejects.toThrow(/10003/);
    expect(lastLogMessage()).toBe("[OWSS] list 失败");
  });

  it("addFile 失败返回 false 并记录原因", async () => {
    axiosMock.request.mockResolvedValue({ data: { code: "MethodNotAllowed", message: "POST is not allowed" } });

    await expect(makeClient().addFile("a.zip", { config: {} } as any)).resolves.toBe(false);
    expect(lastLogMessage()).toBe("[OWSS] addFile 失败");
    expect(logMessageMock.mock.calls.at(-1)?.[1]).toMatchObject({ error: expect.stringContaining("MethodNotAllowed") });
  });

  it("deleteFile 失败返回 false 并记录原因", async () => {
    axiosMock.request.mockResolvedValue({ data: { error: { msg: "Invalid request" } } });

    await expect(makeClient().deleteFile("a.zip")).resolves.toBe(false);
    expect(lastLogMessage()).toBe("[OWSS] deleteFile 失败");
  });

  it("ping 在错误响应下返回 false 并记录原因", async () => {
    axiosMock.request.mockResolvedValue({ data: { error: { msg: "Invalid request id" } } });

    await expect(makeClient().ping()).resolves.toBe(false);
    expect(lastLogMessage()).toBe("[OWSS] ping 失败");
  });
});
