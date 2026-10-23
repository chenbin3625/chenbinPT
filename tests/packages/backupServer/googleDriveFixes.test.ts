/**
 * C2-B-6：GoogleDrive 限流重试与错误原因保留。
 *
 * - 旧实现只匹配精确文案 `Rate Limit Exceeded`，最常见的 `User Rate Limit Exceeded` / 429 不重试；
 * - 非限流错误被泛化成 `Network Error: 403`，丢掉服务端 message；
 * - 抛出的错误不带 `response`，导致 deleteFile 的「文件已不存在 → 视为成功」幂等分支失效。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const axiosMock = vi.hoisted(() => ({ request: vi.fn(), post: vi.fn(), get: vi.fn() }));
const sleepMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("@ptd/site/utils/adapter.ts", () => ({ logMessage: vi.fn() }));
vi.mock("~/helper.ts", () => ({ sleep: sleepMock }));
vi.mock("axios", async (importOriginal) => {
  const actual = await importOriginal<typeof import("axios")>();
  return {
    ...actual,
    default: { ...actual.default, request: axiosMock.request, post: axiosMock.post, get: axiosMock.get },
  };
});

import GoogleDrive from "@ptd/backupServer/entity/GoogleDrive.ts";

const GoogleDriveCtor = GoogleDrive as unknown as new (config: any) => GoogleDrive;

/** 直接注入 token，避免测试走到 oauth 请求 */
function createClient() {
  const client = new GoogleDriveCtor({
    id: "gd-1",
    type: "GoogleDrive",
    name: "GoogleDrive",
    config: { client_id: "id", client_secret: "secret", refresh_token: "token" },
  });
  (client as any).accessInformation = {
    access_token: "access-token",
    expires_in: 3599,
    scope: "https://www.googleapis.com/auth/drive",
    expired_at: Date.now() + 1_000_000,
  };
  return client as any;
}

const rateLimitAxiosError = (message: string, status = 403, reason = "userRateLimitExceeded") => ({
  response: {
    status,
    statusText: status === 429 ? "Too Many Requests" : "Forbidden",
    headers: {},
    data: { error: { code: status, message, errors: [{ domain: "usageLimits", reason, message }] } },
  },
});

beforeEach(() => {
  axiosMock.request.mockReset();
  axiosMock.post.mockReset();
  axiosMock.get.mockReset();
  sleepMock.mockReset().mockResolvedValue(undefined);
});

describe("C2-B-6：限流重试", () => {
  it("`User Rate Limit Exceeded` 会重试（旧实现不会）", async () => {
    const client = createClient();
    axiosMock.request
      .mockRejectedValueOnce(rateLimitAxiosError("User Rate Limit Exceeded"))
      .mockResolvedValueOnce({ data: { files: [] } });

    await expect(client.request({ url: "https://www.googleapis.com/drive/v3/files" })).resolves.toBeTruthy();
    expect(axiosMock.request).toHaveBeenCalledTimes(2);
    expect(sleepMock).toHaveBeenCalledTimes(1);
  });

  it("HTTP 429 即使文案不同也会重试", async () => {
    const client = createClient();
    axiosMock.request
      .mockRejectedValueOnce(rateLimitAxiosError("Too many requests", 429, "rateLimitExceeded"))
      .mockResolvedValueOnce({ data: { files: [] } });

    await expect(client.request({ url: "https://www.googleapis.com/drive/v3/files" })).resolves.toBeTruthy();
    expect(axiosMock.request).toHaveBeenCalledTimes(2);
  });

  it("非限流错误不重试，且保留服务端 message 与 response", async () => {
    const client = createClient();
    axiosMock.request.mockRejectedValue({
      response: {
        status: 403,
        statusText: "Forbidden",
        headers: {},
        data: { error: { code: 403, message: "Insufficient Permission", errors: [] } },
      },
    });

    await expect(client.request({ url: "https://www.googleapis.com/drive/v3/files" })).rejects.toThrow(
      /Insufficient Permission/,
    );
    expect(axiosMock.request).toHaveBeenCalledTimes(1);
    expect(sleepMock).not.toHaveBeenCalled();
  });

  it("deleteFile 对 File not found 仍视为已删除（request 现在会把 response 带进抛出的错误）", async () => {
    const client = createClient();
    axiosMock.request.mockRejectedValue({
      response: {
        status: 404,
        statusText: "Not Found",
        headers: {},
        data: { error: { code: 404, message: "File not found: abc.", errors: [] } },
      },
    });

    await expect(client.deleteFile("abc")).resolves.toBe(true);
  });
});
