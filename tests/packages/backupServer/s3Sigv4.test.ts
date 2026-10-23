/**
 * C2-B-5：S3 SigV4 签名正确性 + 不把 `host` 当作请求头发送。
 *
 * - 用 AWS 官方 SigV4 文档样例（GET examplebucket.s3.amazonaws.com/test.txt）校验签名实现；
 * - 修复点：`host` 只参与 canonical request / SignedHeaders，不进入 axios 请求头 ——
 *   否则全局 unsafe-header 拦截器会为每条 S3 请求安装一条 DNR(SET host) 会话规则。
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@ptd/site/utils/adapter.ts", () => ({ logMessage: vi.fn() }));

import S3 from "@ptd/backupServer/entity/S3.ts";

const S3Ctor = S3 as unknown as new (config: any) => S3;

const AWS_ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE";
const AWS_SECRET_ACCESS_KEY = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
/** SHA-256 of empty string */
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
/** AWS SigV4 官方样例的期望签名（GET https://examplebucket.s3.amazonaws.com/test.txt，20130524T000000Z） */
const AWS_DOC_SIGNATURE = "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41";

function createClient(overrides: Record<string, unknown> = {}) {
  return new S3Ctor({
    id: "s3-1",
    type: "S3",
    name: "S3",
    config: {
      endpoint: "https://s3.amazonaws.com",
      region: "us-east-1",
      accessKeyId: AWS_ACCESS_KEY_ID,
      secretAccessKey: AWS_SECRET_ACCESS_KEY,
      bucket: "examplebucket",
      pathPrefix: "",
      forcePathStyle: false,
      ...overrides,
    },
  });
}

describe("C2-B-5：S3 SigV4 与 AWS 官方样例一致", () => {
  it("GET object 的 Authorization 签名与文档一致", async () => {
    const client = createClient() as any;
    const url = client.objectUrl("test.txt");
    expect(url).toBe("https://examplebucket.s3.amazonaws.com/test.txt");

    const headers = await client.buildAuthHeaders(
      "GET",
      url,
      "",
      { range: "bytes=0-9", "x-amz-content-sha256": EMPTY_SHA256 },
      EMPTY_SHA256,
      new Date("2013-05-24T00:00:00Z"),
    );

    expect(headers.Authorization).toContain(AWS_DOC_SIGNATURE);
    expect(headers.Authorization).toContain("SignedHeaders=host;range;x-amz-content-sha256;x-amz-date");
  });

  it("host 只参与签名，不出现在发给 axios 的请求头里", async () => {
    const client = createClient() as any;
    const headers = await client.buildAuthHeaders(
      "GET",
      client.objectUrl("test.txt"),
      "",
      { "x-amz-content-sha256": EMPTY_SHA256 },
      EMPTY_SHA256,
      new Date("2013-05-24T00:00:00Z"),
    );

    expect(headers.host).toBeUndefined();
    expect(Object.keys(headers).map((key) => key.toLowerCase())).not.toContain("host");
    expect(headers["x-amz-content-sha256"]).toBe(EMPTY_SHA256);
    expect(headers["x-amz-date"]).toBe("20130524T000000Z");
  });

  it("forcePathStyle 下 host 也不进请求头，且签名仍包含 path-style 的 canonical URI", async () => {
    const client = createClient({ endpoint: "http://127.0.0.1:9000", forcePathStyle: true }) as any;
    const url = client.objectUrl("PTD_backup_test.zip");
    expect(url).toBe("http://127.0.0.1:9000/examplebucket/PTD_backup_test.zip");

    const headers = await client.buildAuthHeaders(
      "PUT",
      url,
      "",
      { "content-type": "application/zip", "x-amz-content-sha256": EMPTY_SHA256 },
      EMPTY_SHA256,
      new Date("2026-10-23T00:00:00Z"),
    );

    expect(headers.host).toBeUndefined();
    expect(headers.Authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\//);
  });
});

/**
 * 复检 P2（F）：canonical headers 大小写归一 + canonical URI 的 RFC3986 编码。
 */
describe("F：SigV4 canonical URI / canonical headers", () => {
  it("canonical URI 对 + ! ' ( ) * 空格 与中文做 RFC3986 编码，且保留 /", () => {
    const client = createClient() as any;
    const encode = client.constructor.encodeCanonicalUri as (path: string) => string;

    expect(encode("/")).toBe("/");
    // `new URL()` 已经编码的 %20 不能二次编码成 %2520
    expect(encode("/my%20backups/a.zip")).toBe("/my%20backups/a.zip");
    expect(encode("/a+b.zip")).toBe("/a%2Bb.zip");
    expect(encode("/a'b(c)d*e!f.zip")).toBe("/a%27b%28c%29d%2Ae%21f.zip");
    expect(encode("/中文/海报.jpg")).toBe("/%E4%B8%AD%E6%96%87/%E6%B5%B7%E6%8A%A5.jpg");
    // 非法百分号编码不抛错，按字面编码
    expect(encode("/a%zz.zip")).toBe("/a%25zz.zip");
  });

  it("objectUrl 用同一套编码，prefix 含空格/加号时请求 URL 与签名一致", () => {
    const client = createClient({ pathPrefix: "my backups" }) as any;
    // 调用方（addFile/getFile）负责拼 keyPrefix，objectUrl 只负责按段编码
    expect(client.objectUrl(`${client.keyPrefix}a+b.zip`)).toBe(
      "https://examplebucket.s3.amazonaws.com/my%20backups/a%2Bb.zip",
    );
  });

  it("extraHeaders 大小写混用时，SignedHeaders 按小写排序", async () => {
    const client = createClient() as any;
    const headers = await client.buildAuthHeaders(
      "PUT",
      client.objectUrl("test.txt"),
      "",
      { "Content-Type": "application/zip", "x-amz-content-sha256": EMPTY_SHA256 },
      EMPTY_SHA256,
      new Date("2026-10-23T00:00:00Z"),
    );

    // 小写排序：content-type < host < x-amz-content-sha256 < x-amz-date
    expect(headers.Authorization).toContain("SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date");
    // 实际发送的 header 名统一小写
    expect(headers["content-type"]).toBe("application/zip");
    expect(headers["Content-Type"]).toBeUndefined();
  });
});
