/**
 * CookieCloud.addFile 不得就地修改传入对象（数据完整性回归）。
 *
 * 历史缺陷：`getFile()` 的 30s 短 TTL 缓存会把同一个对象引用返回给所有调用方，而 `addFile()` 会
 * 就地 `delete file.cookies` / `delete file.manifest`。上传失败时缓存不会被清空，于是之后任何读取
 * 拿到的都是缺了 cookies/manifest 的残对象（恢复下载/导出会直接丢数据）。
 *
 * 回归要点：
 * 1. 无论上传成功还是失败，传入对象都必须保持原样；
 * 2. 上传内容仍要把 cookies 放进 `cookie_data`、`ptd_data` 中不再重复包含 cookies/manifest；
 * 3. 上传成功后仍要作废 30s 缓存（保持既有行为）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cookieCloudPassphrase, opensslDecrypt, opensslEncrypt } from "./helpers/nodeCryptoOracle.ts";

vi.mock("axios", async (importOriginal) => {
  const actual = await importOriginal<typeof import("axios")>();
  return { ...actual, default: { ...actual.default, request: vi.fn() } };
});
vi.mock("@ptd/site/utils/adapter.ts", () => ({ logMessage: vi.fn() }));

import axios from "axios";

import CookieCloud, { serverMetaData } from "@ptd/backupServer/entity/CookieCloud.ts";

const serverConfig = {
  id: "cookiecloud-test",
  type: "CookieCloud",
  name: "CookieCloud",
  config: {
    address: "https://cookiecloud.example.com/",
    uuid: "test-uuid",
    password: "test-password",
    headers: "",
  },
};

const cacheKey = ["https://cookiecloud.example.com/", "test-uuid", "test-password"].join("|");

/** 实体构造函数在基类中是 protected（应用侧通过 getBackupServer() 创建），测试里用一次类型断言绕过可见性 */
const CookieCloudCtor = CookieCloud as unknown as new (config: any) => CookieCloud;
const createServer = () => new CookieCloudCtor(serverConfig);
const backupFilename = "PTD_backup_20261004T0215.zip";

function makeBackupData() {
  return {
    cookies: { "mteam.example": [{ name: "sid", value: "secret" }] },
    manifest: { time: 1, version: "test", files: { cookies: { name: "cookies.json", hash: "abc" } } },
    config: { lang: "zh_CN" },
    metadata: { sites: { mteam: { url: "https://mteam.example" } } },
  } as any;
}

function decryptUploadedPayload(): any {
  const requestData = vi.mocked(axios.request).mock.calls[0]![0] as any;
  // 用独立的 OpenSSL 实现解密：即 CookieCloud 服务端 / 官方扩展读取的格式
  const key = cookieCloudPassphrase("test-uuid", "test-password");
  const decrypted = opensslDecrypt(requestData.data.encrypted, key);
  return JSON.parse(decrypted);
}

beforeEach(() => {
  vi.mocked(axios.request).mockReset();
  (CookieCloud as any).fileCache.clear();
});

describe("CookieCloud.addFile：不修改传入的备份数据对象", () => {
  it("上传成功：传入对象保持原样，上传内容格式不变", async () => {
    const server = createServer();
    const data = makeBackupData();
    const snapshot = JSON.parse(JSON.stringify(data));

    vi.mocked(axios.request).mockResolvedValue({ data: { action: "done" } } as any);
    await expect(server.addFile(backupFilename, data)).resolves.toBe(true);

    // 关键回归：原实现会在这里丢掉 cookies / manifest
    expect(data).toEqual(snapshot);

    const uploaded = decryptUploadedPayload();
    expect(uploaded.cookie_data).toEqual(snapshot.cookies);
    expect(uploaded.ptd_data.cookies).toBeUndefined();
    expect(uploaded.ptd_data.manifest).toBeUndefined();
    expect(uploaded.ptd_data.config).toEqual(snapshot.config);
    expect(uploaded.ptd_data.metadata).toEqual(snapshot.metadata);
    expect(uploaded.manifest.fileName).toBe(backupFilename);
    expect(uploaded.manifest.encryption).toBe(true);
    expect(uploaded.manifest.files).toEqual({});
    expect(uploaded.integrity).toMatch(/^[a-f0-9]{64}$/);
    expect(uploaded.integritySalt).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
  });

  it("上传失败：返回 false，且传入对象（可能是 getFile 的缓存对象）仍然完整", async () => {
    const server = createServer();
    const data = makeBackupData();
    const snapshot = JSON.parse(JSON.stringify(data));

    vi.mocked(axios.request).mockRejectedValue(new Error("network down"));
    await expect(server.addFile(backupFilename, data)).resolves.toBe(false);

    expect(data).toEqual(snapshot);
    expect(data.cookies).toBeDefined();
    expect(data.manifest).toBeDefined();
  });

  it("上传成功后仍然作废短 TTL 缓存", async () => {
    const server = createServer();
    (CookieCloud as any).fileCache.set(cacheKey, { createAt: Date.now(), promise: Promise.resolve({}) });
    expect((CookieCloud as any).fileCache.has(cacheKey)).toBe(true);

    vi.mocked(axios.request).mockResolvedValue({ data: { action: "done" } } as any);
    await expect(server.addFile(backupFilename, makeBackupData())).resolves.toBe(true);

    expect((CookieCloud as any).fileCache.has(cacheKey)).toBe(false);
  });
});

describe("CookieCloud 自定义认证 Headers", () => {
  it("保留值中的冒号、修剪空白，并声明 Headers 为敏感字段", async () => {
    const server = new CookieCloudCtor({
      ...serverConfig,
      config: { ...serverConfig.config, headers: " Authorization : Bearer one:two:three\r\nX-Api-Key: abc:def" },
    });
    vi.mocked(axios.request).mockResolvedValue({ data: "Hello World!API ROOT =" } as any);

    expect(await server.ping()).toBe(true);
    expect(vi.mocked(axios.request).mock.calls[0][0].headers).toMatchObject({
      Authorization: "Bearer one:two:three",
      "X-Api-Key": "abc:def",
    });
    expect(serverMetaData.requiredField.find((field) => field.key === "headers")?.secret).toBe(true);
  });
});

describe("CookieCloud 恢复不可信 JSON", () => {
  it("解密时剥离嵌套 __proto__ 键", async () => {
    const raw =
      '{"cookie_data":{},"ptd_data":{"metadata":{"sites":{"__proto__":{"polluted":"yes"}}}},"manifest":{"files":{},"version":"1"}}';
    const key = cookieCloudPassphrase("test-uuid", "test-password");
    vi.mocked(axios.request).mockResolvedValue({
      data: { encrypted: opensslEncrypt(raw, key) },
      headers: {},
    } as any);

    const result = await createServer().getFile("");

    expect(Object.hasOwn(result.metadata.sites, "__proto__")).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("新写入的 payload 经篡改后拒绝恢复", async () => {
    const key = cookieCloudPassphrase("test-uuid", "test-password");
    vi.mocked(axios.request)
      .mockResolvedValueOnce({ data: { action: "done" } } as any)
      .mockImplementationOnce(async (_request) => {
        const uploaded = decryptUploadedPayload();
        uploaded.ptd_data.config.lang = "attacker";
        return {
          data: { encrypted: opensslEncrypt(JSON.stringify(uploaded), key) },
          headers: {},
        } as any;
      });

    const server = createServer();
    await server.addFile("name", makeBackupData());
    await expect(server.getFile("")).rejects.toThrow(/integrity/i);
  });
});

/**
 * 复检 P2（E）：uuid 归一化/编码、MAC 常量时间比较。
 */
describe("CookieCloud：uuid 校验与编码", () => {
  it("uuid 会进入 /get 路径且做 encodeURIComponent（含 / ? # 时不改变路由）", async () => {
    const server = new CookieCloudCtor({
      ...serverConfig,
      config: { ...serverConfig.config, uuid: "a/b?c#d" },
    });
    vi.mocked(axios.request).mockResolvedValue({ data: { encrypted: "" }, headers: {} } as any);

    await expect(server.getFile("")).rejects.toThrow(/No data found/);

    const requestConfig = vi.mocked(axios.request).mock.calls[0]![0] as any;
    expect(requestConfig.url).toBe(`/get/${encodeURIComponent("a/b?c#d")}`);
  });

  it("uuid 为空时给出明确错误，且不发起请求", async () => {
    const server = new CookieCloudCtor({
      ...serverConfig,
      config: { ...serverConfig.config, uuid: "   " },
    });

    await expect(server.getFile("")).rejects.toThrow(/uuid/i);
    expect(vi.mocked(axios.request)).not.toHaveBeenCalled();
  });

  it("uuid 含控制字符时拒绝", async () => {
    const server = new CookieCloudCtor({
      ...serverConfig,
      config: { ...serverConfig.config, uuid: "bad\u0000uuid" },
    });

    await expect(server.addFile("name", makeBackupData())).resolves.toBe(false);
    expect(vi.mocked(axios.request)).not.toHaveBeenCalled();
  });
});
