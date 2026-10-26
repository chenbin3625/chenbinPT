import { beforeEach, describe, expect, it, vi } from "vitest";

const logMessage = vi.hoisted(() => vi.fn());
const post = vi.hoisted(() => vi.fn());
vi.mock("@ptd/site/utils/adapter.ts", () => ({ logMessage }));
vi.mock("axios", async (importOriginal) => {
  const actual = await importOriginal<typeof import("axios")>();
  return { ...actual, default: { ...actual.default, post } };
});

import BackblazeB2 from "@ptd/backupServer/entity/BackblazeB2.ts";

const B2Ctor = BackblazeB2 as unknown as new (config: any) => BackblazeB2;
const client = () => {
  const b2 = new B2Ctor({
    type: "BackblazeB2",
    config: { applicationKeyId: "id", applicationKey: "secret", bucketName: "bucket" },
  });
  (b2 as any).bucketId = "bucket-id";
  (b2 as any).authToken = "auth";
  (b2 as any).apiUrl = "https://api.example";
  return b2;
};

beforeEach(() => {
  post.mockReset();
  logMessage.mockReset();
});

describe("BackblazeB2 versions", () => {
  it("分页删除同名上传及隐藏版本，不触碰同前缀的其他文件", async () => {
    post.mockImplementation(async (url: string, body: any) => {
      if (url.endsWith("/b2_list_file_versions")) {
        return body.startFileName
          ? {
              data: {
                files: [{ fileName: "a.zip", fileId: "v3", action: "hide" }],
                nextFileName: null,
                nextFileId: null,
              },
            }
          : {
              data: {
                files: [
                  { fileName: "a.zip", fileId: "v1", action: "upload" },
                  { fileName: "a.zip.other", fileId: "other", action: "upload" },
                  { fileName: "a.zip", fileId: "v2", action: "upload" },
                ],
                nextFileName: "a.zip",
                nextFileId: "v3",
              },
            };
      }
      return { data: { fileId: body.fileId } };
    });

    expect(await client().deleteFile("a.zip")).toBe(true);
    expect(
      post.mock.calls.filter(([url]) => url.endsWith("/b2_delete_file_version")).map(([, body]) => body.fileId),
    ).toEqual(["v1", "v2", "v3"]);
    const pages = post.mock.calls.filter(([url]) => url.endsWith("/b2_list_file_versions"));
    expect(pages[1][1]).toMatchObject({ startFileName: "a.zip", startFileId: "v3" });
  });

  it("前置授权、取上传地址与 ZIP 构建失败均返回 false 并记录原因", async () => {
    const b2 = client();
    (b2 as any).bucketId = undefined;
    (b2 as any).getBucketId = vi.fn().mockRejectedValue(new Error("bucket denied"));
    expect(await b2.addFile("a.zip", {} as any)).toBe(false);
    expect(logMessage).toHaveBeenLastCalledWith("[BackblazeB2] addFile 失败", { error: "bucket denied" });

    (b2 as any).getBucketId = vi.fn().mockResolvedValue("bucket-id");
    post.mockRejectedValueOnce(new Error("upload URL denied"));
    expect(await b2.addFile("a.zip", {} as any)).toBe(false);
    expect(logMessage).toHaveBeenLastCalledWith("[BackblazeB2] addFile 失败", { error: "upload URL denied" });

    post.mockResolvedValueOnce({ data: { uploadUrl: "https://upload.example", authorizationToken: "upload" } });
    (b2 as any).backupDataToZipBlob = vi.fn().mockRejectedValue(new Error("zip failed"));
    expect(await b2.addFile("a.zip", {} as any)).toBe(false);
    expect(logMessage).toHaveBeenLastCalledWith("[BackblazeB2] addFile 失败", { error: "zip failed" });
  });

  it("删除部分版本失败时返回 false 并记录原因", async () => {
    post.mockResolvedValueOnce({
      data: {
        files: [
          { fileName: "a.zip", fileId: "v1" },
          { fileName: "a.zip", fileId: "v2" },
        ],
        nextFileName: null,
        nextFileId: null,
      },
    });
    post.mockResolvedValueOnce({ data: { fileId: "v1" } });
    post.mockRejectedValueOnce(new Error("delete denied"));
    expect(await client().deleteFile("a.zip")).toBe(false);
    expect(logMessage).toHaveBeenLastCalledWith("[BackblazeB2] deleteFile 失败", { error: "delete denied" });
  });
});
