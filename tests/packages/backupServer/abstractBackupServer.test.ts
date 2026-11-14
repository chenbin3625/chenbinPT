/**
 * AbstractBackupServer 基类测试。
 *
 * 目标模块此前没有直接测试：各实体（WebDAV / S3 / Gist …）只覆盖了自己的请求路径，
 * 基类共同的 userConfig、加解密、zip 往返、请求超时与失败日志语义没有回归保护。
 *
 * 这里用一个最小具体子类实现抽象方法，通过公开包装方法触发基类的 protected 行为，
 * 只做行为断言，不复制实现细节。
 */
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const logMessageMock = vi.hoisted(() => vi.fn());

vi.mock("@ptd/site/utils/adapter.ts", () => ({ logMessage: logMessageMock }));

import AbstractBackupServer from "@ptd/backupServer/AbstractBackupServer.ts";
import type { IBackupConfig, IBackupData, IBackupFileInfo, IBackupFileListOption } from "@ptd/backupServer/type.ts";

class TestBackupServer extends AbstractBackupServer<IBackupConfig> {
  protected version = "test-version";

  constructor(config: IBackupConfig) {
    super(config);
  }

  // 抽象方法：基类不提供实现，这里只做最小实现以便实例化
  public ping(): Promise<boolean> {
    return Promise.resolve(true);
  }

  public list(_options?: IBackupFileListOption): Promise<IBackupFileInfo[]> {
    return Promise.resolve([]);
  }

  public addFile(_fileName: string, _file: IBackupData): Promise<boolean> {
    return Promise.resolve(true);
  }

  public getFile(_path: string): Promise<IBackupData> {
    return Promise.resolve({});
  }

  public deleteFile(_path: string): Promise<boolean> {
    return Promise.resolve(true);
  }

  // 公开包装：在子类内部调用 protected 方法
  public encrypt(data: any): string {
    return this.encryptData(data);
  }

  public decrypt<T = any>(data: string): T {
    return this.decryptData<T>(data);
  }

  public toZipBlob(data: IBackupData): Promise<Blob> {
    return this.backupDataToZipBlob(data);
  }

  public fromZipBlob(blob: Blob): Promise<IBackupData> {
    return this.zipBlobToBackupData(blob);
  }

  public runWithTimeout<T>(executor: (signal: AbortSignal) => Promise<T>, timeout?: number): Promise<T> {
    return timeout === undefined ? this.withRequestTimeout(executor) : this.withRequestTimeout(executor, timeout);
  }

  public logFailure(action: string, error: unknown): void {
    this.logBackupFailure(action, error);
  }
}

function createServer(overrides: Partial<IBackupConfig> = {}): TestBackupServer {
  return new TestBackupServer({
    id: "test-backup-server",
    type: "TestBackup",
    name: "Test Backup",
    config: {},
    ...overrides,
  });
}

function makeBackupData(): IBackupData {
  return {
    config: { lang: "zh_CN", nested: { itemsPerPage: 10, flags: [true, false] } },
    metadata: { sites: { mteam: { url: "https://mteam.example", merge: { name: "M-Team" } } } },
    downloadHistory: [{ id: "1", title: '含 "引号"、反斜杠 \\ 与 🙂 的记录' }],
  };
}

/** 读取 ZIP 本地文件头中的压缩方法（0 = STORE，8 = raw DEFLATE） */
function localZipCompressionMethods(bytes: Uint8Array): number[] {
  const methods: number[] = [];
  let offset = 0;
  while (offset + 30 <= bytes.length) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 30);
    if (view.getUint32(0, true) !== 0x04034b50) break; // 本地文件头签名
    methods.push(view.getUint16(8, true));
    const compressedSize = view.getUint32(18, true);
    const nameLength = view.getUint16(26, true);
    const extraLength = view.getUint16(28, true);
    offset += 30 + nameLength + extraLength + compressedSize;
  }
  return methods;
}

function expectDataPreserved(restored: IBackupData, original: IBackupData): void {
  expect(restored.config).toEqual(original.config);
  expect(restored.metadata).toEqual(original.metadata);
  expect(restored.downloadHistory).toEqual(original.downloadHistory);
}

describe("userConfig 与 encryptionKey", () => {
  it("userConfig 返回 config.config 本体（不是副本）", () => {
    const config = { address: "https://example.com", timeout: 1234, secure: true };
    const server = createServer({ config });

    expect(server.userConfig).toBe(config);
    expect(server.userConfig).toEqual({ address: "https://example.com", timeout: 1234, secure: true });
  });

  it("encryptionKey 默认为 undefined，setEncryptionKey 可读写（含覆写）", () => {
    const server = createServer();

    expect(server.encryptionKey).toBeUndefined();

    server.setEncryptionKey("first-key");
    expect(server.encryptionKey).toBe("first-key");

    server.setEncryptionKey("second-key");
    expect(server.encryptionKey).toBe("second-key");
  });
});

describe("encryptData / decryptData", () => {
  const encryptionKey = "unit-test-encryption-key";

  it.each<[string, unknown]>([
    ["字符串", "plain text"],
    ["对象", { nested: { enabled: true, count: 2 }, list: [1, "two", null] }],
    ["特殊字符", `中文🙂 "double" 'single' \\ backslash\n换行\ttab`],
  ])("设置密钥后往返保留 %s", (_label, value) => {
    const server = createServer();
    server.setEncryptionKey(encryptionKey);

    const encrypted = server.encrypt(value);
    expect(encrypted.startsWith("PTD-AES-HMAC-v1:")).toBe(true);
    expect(server.decrypt(encrypted)).toEqual(value);
  });

  it("未设置密钥时按 JSON 明文处理（加解密都不做转换）", () => {
    const server = createServer();
    const value = { lang: "zh_CN", nested: { list: [1, 2, 3] }, special: `引号 " 与 🙂` };

    const encrypted = server.encrypt(value);
    expect(encrypted).toBe(JSON.stringify(value));
    expect(encrypted.startsWith("PTD-AES-HMAC-")).toBe(false);

    expect(server.decrypt(encrypted)).toEqual(value);
    expect(server.decrypt<string>('"含特殊字符 🙂"')).toBe("含特殊字符 🙂");
  });
});

describe("backupDataToZipBlob / zipBlobToBackupData 往返", () => {
  it("有密钥时：条目加密为 v2 封套、ZIP 使用 STORE，恢复后数据保真", async () => {
    const server = createServer();
    server.setEncryptionKey("zip-roundtrip-key");
    const data = makeBackupData();

    const blob = await server.toZipBlob(data);
    expect(blob.size).toBeGreaterThan(0);

    const zipBytes = new Uint8Array(await blob.arrayBuffer());
    const methods = localZipCompressionMethods(zipBytes);
    expect(methods.length).toBeGreaterThan(0);
    expect(new Set(methods)).toEqual(new Set([0])); // 加密条目不可压缩 → STORE

    const zip = await JSZip.loadAsync(blob);
    const configEntry = await zip.file("config.json")!.async("string");
    expect(configEntry.startsWith("PTD-AES-HMAC-v2:")).toBe(true);
    expect(configEntry).not.toContain("zh_CN"); // 密文不含明文

    const manifest = JSON.parse((await zip.file("manifest.json")!.async("string")) as string);
    expect(manifest.encryption).toBe(true);

    const restored = await server.fromZipBlob(blob);
    expect(restored.manifest?.encryption).toBe(true);
    expectDataPreserved(restored, data);
  }, 15_000);

  it("无密钥时：条目为明文 JSON、ZIP 使用 DEFLATE，恢复后数据保真", async () => {
    const server = createServer();
    const data = makeBackupData();

    const blob = await server.toZipBlob(data);

    const zipBytes = new Uint8Array(await blob.arrayBuffer());
    const methods = localZipCompressionMethods(zipBytes);
    expect(methods.length).toBeGreaterThan(0);
    expect(new Set(methods)).toEqual(new Set([8])); // 未加密 JSON → raw deflate

    const zip = await JSZip.loadAsync(blob);
    const configEntry = await zip.file("config.json")!.async("string");
    expect(configEntry).toBe(JSON.stringify(data.config));

    const manifest = JSON.parse((await zip.file("manifest.json")!.async("string")) as string);
    expect(manifest.encryption).toBe(false);

    const restored = await server.fromZipBlob(blob);
    expect(restored.manifest?.encryption).toBe(false);
    expectDataPreserved(restored, data);
  }, 15_000);
});

describe("withRequestTimeout", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("正常执行时返回结果，signal 未 abort，且定时器被清理", async () => {
    vi.useFakeTimers();
    const server = createServer();
    let receivedSignal: AbortSignal | undefined;

    const result = server.runWithTimeout((signal) => {
      receivedSignal = signal;
      return Promise.resolve("done");
    }, 10_000);

    await expect(result).resolves.toBe("done");
    expect(receivedSignal).toBeInstanceOf(AbortSignal);
    expect(receivedSignal!.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("超时后 abort，并以源码错误信息 reject；超时定时器不残留", async () => {
    vi.useFakeTimers();
    const server = createServer();
    let receivedSignal: AbortSignal | undefined;

    const promise = server.runWithTimeout<string>((signal) => {
      receivedSignal = signal;
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason));
      });
    }, 50);
    // 提前挂上 rejection handler，避免 fake timers 推进时出现未处理拒绝
    const outcome = promise.then(
      (value) => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error }),
    );

    await vi.advanceTimersByTimeAsync(49);
    expect(receivedSignal!.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const { error } = await outcome;

    expect(receivedSignal!.aborted).toBe(true);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("[TestBackup] request timeout after 50ms");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("显式传入的 timeout 覆盖 config.timeout", async () => {
    vi.useFakeTimers();
    const server = createServer({ config: { timeout: 60_000 } });

    const promise = server.runWithTimeout<string>((signal) => {
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason));
      });
    }, 30);
    const outcome = promise.then(
      (value) => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error }),
    );

    await vi.advanceTimersByTimeAsync(30);
    const { error } = await outcome;

    expect((error as Error).message).toBe("[TestBackup] request timeout after 30ms");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("未显式传 timeout 时使用 userConfig.timeout", async () => {
    vi.useFakeTimers();
    const server = createServer({ config: { timeout: 25 } });

    const promise = server.runWithTimeout<string>((signal) => {
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason));
      });
    });
    const outcome = promise.then(
      (value) => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error }),
    );

    await vi.advanceTimersByTimeAsync(25);
    const { error } = await outcome;

    expect((error as Error).message).toBe("[TestBackup] request timeout after 25ms");
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("logBackupFailure", () => {
  beforeEach(() => {
    logMessageMock.mockClear();
  });

  it("通过具体子类触发时，日志包含 config.type、action 与 Error.message", () => {
    const server = createServer({ type: "TestBackup" });

    server.logFailure("ping", new Error("401 Unauthorized"));

    expect(logMessageMock).toHaveBeenCalledTimes(1);
    expect(logMessageMock).toHaveBeenCalledWith("[TestBackup] ping 失败", { error: "401 Unauthorized" });
  });

  it("非 Error 值按 String(...) 记录", () => {
    const server = createServer({ type: "AnotherBackup" });

    server.logFailure("addFile", "quota exceeded");

    expect(logMessageMock).toHaveBeenCalledWith("[AnotherBackup] addFile 失败", { error: "quota exceeded" });
  });
});
