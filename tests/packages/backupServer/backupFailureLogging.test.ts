/**
 * SERVERSSOCIAL-3（P1-5）：失败必须记录原因。
 *
 * S3 / BackblazeB2 / DropBox / Gist 的 ping/addFile/deleteFile 之前把异常直接吞掉（或只 console.warn），
 * 自动备份日志只能留下「returned false」，用户无法区分 401/403、地址/凭据错误、配额超限还是网络不可达。
 * 这里断言每个失败分支都会经统一日志出口（logMessage）留下原因。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const logMessageMock = vi.hoisted(() => vi.fn());
const axiosMock = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), request: vi.fn() }));

vi.mock("@ptd/site/utils/adapter.ts", () => ({ logMessage: logMessageMock }));
vi.mock("axios", async (importOriginal) => {
  const actual = await importOriginal<typeof import("axios")>();
  return {
    ...actual,
    default: { ...actual.default, get: axiosMock.get, post: axiosMock.post, request: axiosMock.request },
  };
});

import BackblazeB2 from "@ptd/backupServer/entity/BackblazeB2.ts";
import CookieCloud from "@ptd/backupServer/entity/CookieCloud.ts";
import DropBox from "@ptd/backupServer/entity/DropBox.ts";
import Gist from "@ptd/backupServer/entity/Gist.ts";
import GoogleDrive from "@ptd/backupServer/entity/GoogleDrive.ts";
import S3 from "@ptd/backupServer/entity/S3.ts";

const S3Ctor = S3 as unknown as new (config: any) => S3;
const DropBoxCtor = DropBox as unknown as new (config: any) => DropBox;
const GistCtor = Gist as unknown as new (config: any) => Gist;
const B2Ctor = BackblazeB2 as unknown as new (config: any) => BackblazeB2;
const CookieCloudCtor = CookieCloud as unknown as new (config: any) => CookieCloud;
const GoogleDriveCtor = GoogleDrive as unknown as new (config: any) => GoogleDrive;

const s3Client = () =>
  new S3Ctor({
    id: "s3-1",
    type: "S3",
    name: "S3",
    config: { endpoint: "https://s3.example", region: "r", accessKeyId: "k", secretAccessKey: "s", bucket: "b" },
  });

const dropBoxClient = () =>
  new DropBoxCtor({ id: "db-1", type: "DropBox", name: "DropBox", config: { access_token: "t" } });

const gistClient = () =>
  new GistCtor({
    id: "gist-1",
    type: "Gist",
    name: "Gist",
    config: { gist_id: "g", access_token: "t" },
  });

const b2Client = () =>
  new B2Ctor({
    id: "b2-1",
    type: "BackblazeB2",
    name: "Backblaze B2",
    config: { applicationKeyId: "id", applicationKey: "key", bucketName: "bucket" },
  });

const cookieCloudClient = () =>
  new CookieCloudCtor({
    id: "cc-1",
    type: "CookieCloud",
    name: "CookieCloud",
    config: { address: "https://cookiecloud.example.com/", uuid: "uuid", password: "pass", headers: "" },
  });

const googleDriveClient = () =>
  new GoogleDriveCtor({
    id: "gd-1",
    type: "GoogleDrive",
    name: "GoogleDrive",
    config: { client_id: "id", client_secret: "secret", refresh_token: "token" },
  });

const lastLogMessage = () => logMessageMock.mock.calls.at(-1)?.[0] as string | undefined;

/** B2 的 getBucketId 在 try 之外，先注入已授权状态才能走到 try 里的失败分支 */
const primeB2 = (client: BackblazeB2) => {
  const anyClient = client as any;
  anyClient.authToken = "token";
  anyClient.apiUrl = "https://api.b2.example";
  anyClient.downloadUrl = "https://download.b2.example";
  anyClient.accountId = "account";
  anyClient.bucketId = "bucket-id";
  return anyClient;
};

describe("SERVERSSOCIAL-3：备份实体失败必须留下原因", () => {
  beforeEach(() => {
    logMessageMock.mockClear();
    axiosMock.get.mockReset();
    axiosMock.post.mockReset();
    axiosMock.request.mockReset();
  });

  it("S3：ping / addFile / deleteFile 失败都记录原因", async () => {
    const client = s3Client();
    const anyClient = client as any;
    anyClient.s3Request = vi.fn().mockRejectedValue(new Error("SignatureDoesNotMatch"));

    expect(await client.ping()).toBe(false);
    expect(lastLogMessage()).toBe("[S3] ping 失败");
    expect(logMessageMock.mock.calls.at(-1)?.[1]).toMatchObject({ error: "SignatureDoesNotMatch" });

    anyClient.backupDataToJSZipBlob = vi.fn().mockRejectedValue(new Error("zip boom"));
    expect(await client.addFile("a.zip", {} as any)).toBe(false);
    expect(lastLogMessage()).toBe("[S3] addFile 失败");

    expect(await client.deleteFile("a.zip")).toBe(false);
    expect(lastLogMessage()).toBe("[S3] deleteFile 失败");
  });

  it("DropBox：ping / addFile / deleteFile 失败都记录原因", async () => {
    const client = dropBoxClient();
    const anyClient = client as any;
    anyClient.request = vi.fn().mockRejectedValue(new Error("invalid_access_token"));

    expect(await client.ping()).toBe(false);
    expect(lastLogMessage()).toBe("[DropBox] ping 失败");
    expect(logMessageMock.mock.calls.at(-1)?.[1]).toMatchObject({ error: "invalid_access_token" });

    anyClient.backupDataToJSZipBlob = vi.fn().mockRejectedValue(new Error("zip boom"));
    expect(await client.addFile("a.zip", {} as any)).toBe(false);
    expect(lastLogMessage()).toBe("[DropBox] addFile 失败");

    expect(await client.deleteFile("a.zip")).toBe(false);
    expect(lastLogMessage()).toBe("[DropBox] deleteFile 失败");
  });

  it("Gist：ping / addFile 失败都记录原因", async () => {
    const client = gistClient();
    const anyClient = client as any;
    anyClient.request = vi.fn().mockRejectedValue(new Error("Bad credentials"));

    expect(await client.ping()).toBe(false);
    expect(lastLogMessage()).toBe("[Gist] ping 失败");

    expect(await client.addFile("a.zip", { config: {} } as any)).toBe(false);
    expect(lastLogMessage()).toBe("[Gist] addFile 失败");
  });

  it("BackblazeB2：ping / addFile / deleteFile 失败都记录原因", async () => {
    const pingClient = b2Client();
    (pingClient as any).authorize = vi.fn().mockRejectedValue(new Error("unauthorized_account_id"));
    expect(await pingClient.ping()).toBe(false);
    expect(lastLogMessage()).toBe("[BackblazeB2] ping 失败");

    const addClient = primeB2(b2Client());
    addClient.backupDataToJSZipBlob = vi.fn().mockResolvedValue(new Blob(["zip"]));
    axiosMock.post
      .mockResolvedValueOnce({ data: { uploadUrl: "https://upload.b2.example", authorizationToken: "t" } })
      .mockRejectedValueOnce(new Error("Upload quota exceeded"));
    expect(await addClient.addFile("a.zip", {} as any)).toBe(false);
    expect(lastLogMessage()).toBe("[BackblazeB2] addFile 失败");

    const deleteClient = primeB2(b2Client());
    axiosMock.post
      .mockResolvedValueOnce({ data: { files: [{ fileName: "a.zip", fileId: "f1" }], nextFileName: null } })
      .mockRejectedValueOnce(new Error("file not found"));
    expect(await deleteClient.deleteFile("a.zip")).toBe(false);
    expect(lastLogMessage()).toBe("[BackblazeB2] deleteFile 失败");
  });

  it("CookieCloud：ping 失败记录原因（旧实现只 console.warn）", async () => {
    const client = cookieCloudClient();
    (client as any).request = vi.fn().mockRejectedValue(new Error("ENOTFOUND cookiecloud.example.com"));

    expect(await client.ping()).toBe(false);
    expect(lastLogMessage()).toBe("[CookieCloud] ping 失败");
    expect(logMessageMock.mock.calls.at(-1)?.[1]).toMatchObject({
      error: "ENOTFOUND cookiecloud.example.com",
    });
  });

  it("GoogleDrive：deleteFile 非 404 失败记录原因，404 仍视为已删除", async () => {
    const client = googleDriveClient();
    const anyClient = client as any;

    // 覆盖非 404 失败：this.request 抛出的通用文案会丢掉服务端原因，这里断言日志里带的是 API message
    anyClient.request = vi.fn().mockRejectedValue({
      response: { data: { error: { message: "Insufficient Permission" } } },
    });
    expect(await client.deleteFile("a.zip")).toBe(false);
    expect(lastLogMessage()).toBe("[GoogleDrive] deleteFile 失败");
    expect(logMessageMock.mock.calls.at(-1)?.[1]).toMatchObject({ error: "Insufficient Permission" });

    logMessageMock.mockClear();
    anyClient.request = vi.fn().mockRejectedValue({
      response: { data: { error: { message: "File not found: abc123." } } },
    });
    expect(await client.deleteFile("a.zip")).toBe(true);
    expect(lastLogMessage()).toBeUndefined();
  });
});
