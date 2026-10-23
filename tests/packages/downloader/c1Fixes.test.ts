/**
 * C1 修复轮跨实体回归测试：
 * - SEC-1：日志 URL 脱敏（sanitizeDownloadUrlForLog）
 * - PKG-3：getRemoteTorrentFile 的 content-type 判定与体积上限
 * - RT-5：基类 getTorrentsBy({ids}) 对 hash 大小写不敏感
 * - PKG-2：invalidateSuggestListCache 使建议列表缓存立即失效
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { axiosRequestMock } = vi.hoisted(() => ({
  axiosRequestMock: vi.fn(),
}));

vi.mock("axios", () => {
  const instance = {
    request: axiosRequestMock,
    interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } },
  };
  return {
    default: {
      request: axiosRequestMock,
      create: vi.fn(() => instance),
    },
  };
});

vi.mock("@/messages.ts", () => ({
  sendMessage: vi.fn(async () => undefined),
  onMessage: vi.fn(),
}));

import { sanitizeDownloadUrlForLog, getRemoteTorrentFile } from "@ptd/downloader/utils.ts";
import {
  AbstractBittorrentClient,
  CTorrent,
  CTorrentState,
  DownloaderBaseConfig,
  CAddTorrentOptions,
  CAddTorrentResult,
} from "@ptd/downloader/types.ts";

describe("SEC-1：日志里的下载 URL 脱敏", () => {
  it("普通下载链接只保留 协议+主机+路径，去掉 query 里的 passkey", () => {
    expect(sanitizeDownloadUrlForLog("https://pt.example/download.php?id=1&passkey=SECRET")).toBe(
      "https://pt.example/download.php",
    );
  });

  it("磁链只保留 infoHash（不保留 dn/tr/passkey 等参数）", () => {
    const magnet = "magnet:?xt=urn:btih:ABCDEF0123456789ABCDEF0123456789ABCDEF01&dn=secret&tr=https://t/a";
    expect(sanitizeDownloadUrlForLog(magnet)).toBe("magnet:?xt=urn:btih:ABCDEF0123456789ABCDEF0123456789ABCDEF01");
  });

  it("非法/空 URL 返回占位符而不是原文", () => {
    expect(sanitizeDownloadUrlForLog("not a url with passkey=SECRET")).toBe("<invalid-url>");
    expect(sanitizeDownloadUrlForLog("")).toBe("<empty>");
    expect(sanitizeDownloadUrlForLog(undefined)).toBe("<empty>");
  });

  it("RB-5：路径内凭据段（Rartracker/RSS 形式）同样脱敏为 ***", () => {
    // 真实站点：src/packages/site/schemas/Rartracker.ts 下载链接 = /api/v1/torrents/download/{id}/{passkey}
    expect(
      sanitizeDownloadUrlForLog(
        "https://rartracker.example/api/v1/torrents/download/42/abcdef0123456789abcdef0123456789",
      ),
    ).toBe("https://rartracker.example/api/v1/torrents/download/42/***");
    // 普通路径段（短 id、单词、带扩展名的文件名）不应被误伤
    expect(sanitizeDownloadUrlForLog("https://pt.example/download/42/movie.torrent")).toBe(
      "https://pt.example/download/42/movie.torrent",
    );
  });
});

describe("PKG-3：getRemoteTorrentFile 的响应类型/体积校验", () => {
  beforeEach(() => {
    axiosRequestMock.mockReset();
  });

  function bencodedTorrent(): Buffer {
    const pieces = Buffer.alloc(20, 0x61);
    const info = Buffer.concat([
      Buffer.from("d6:lengthi1024e4:name4:test12:piece lengthi16384e6:pieces20:"),
      pieces,
      Buffer.from("e"),
    ]);
    const announce = "http://tracker.local/announce";
    return Buffer.concat([
      Buffer.from("d8:announce" + Buffer.byteLength(announce) + ":" + announce + "4:info"),
      info,
      Buffer.from("e"),
    ]);
  }

  it("明确不是种子的 content-type（text/html）直接报错", async () => {
    axiosRequestMock.mockResolvedValue({
      headers: { "content-type": "text/html; charset=utf-8" },
      data: Buffer.from("<html/>"),
    });
    await expect(getRemoteTorrentFile({ url: "https://pt.example/download.php?id=1" })).rejects.toThrow(
      /Invalid Torrent From Server/,
    );
  });

  it("application/force-download 等非标准类型不再被白名单误杀", async () => {
    axiosRequestMock.mockResolvedValue({
      headers: { "content-type": "application/force-download" },
      data: bencodedTorrent(),
    });
    const parsed = await getRemoteTorrentFile({ url: "https://pt.example/download.php?id=1" });
    expect(parsed.info.name).toBe("test");
  });

  it("超过体积上限时拒绝，避免误下载大文件", async () => {
    axiosRequestMock.mockResolvedValue({
      headers: { "content-type": "application/x-bittorrent", "content-length": String(60 * 1024 * 1024) },
      data: Buffer.alloc(64),
    });
    await expect(getRemoteTorrentFile({ url: "https://pt.example/big" })).rejects.toThrow(/too large/);
  });
});

/** 用于验证基类契约的最小实现 */
class TestClient extends AbstractBittorrentClient {
  readonly version = "v0.0.1" as const;
  public getAllCalls = 0;

  constructor(
    private readonly torrents: CTorrent[],
    options: Partial<DownloaderBaseConfig> = {},
  ) {
    super({ type: "Test", name: "Test", address: "http://test.local", ...options } as DownloaderBaseConfig);
  }

  async ping(): Promise<boolean> {
    return true;
  }
  protected async getClientVersionFromRemote(): Promise<string> {
    return "1.0.0";
  }
  async getAllTorrents(): Promise<CTorrent[]> {
    this.getAllCalls++;
    return this.torrents;
  }
  async addTorrent(_url: string, _options: Partial<CAddTorrentOptions>): Promise<CAddTorrentResult> {
    return { success: true };
  }
  async pauseTorrent(): Promise<boolean> {
    return true;
  }
  async resumeTorrent(): Promise<boolean> {
    return true;
  }
  async removeTorrent(): Promise<boolean> {
    return true;
  }
  async getTorrentTrackers(): Promise<string[]> {
    return [];
  }

  // 暴露 protected 方法供测试
  public invalidateCache() {
    this.invalidateSuggestListCache();
  }
}

function makeTorrent(infoHash: string, savePath = "/downloads"): CTorrent {
  return {
    id: infoHash.toLowerCase(),
    infoHash,
    name: "t",
    progress: 100,
    isCompleted: true,
    ratio: 1,
    dateAdded: 1,
    savePath,
    state: CTorrentState.seeding,
    totalSize: 1,
    uploadSpeed: 0,
    downloadSpeed: 0,
    totalUploaded: 0,
    totalDownloaded: 0,
    raw: {},
    clientId: "test",
  } as CTorrent;
}

describe("RT-5：基类按 id/hash 过滤时大小写不敏感", () => {
  it("小写 id 能匹配大写的 infoHash（ruTorrent/uTorrent/Flood 的 id 是小写）", async () => {
    const client = new TestClient([makeTorrent("AABBCCDDEEFF00112233445566778899AABBCCDD")]);
    const [torrent] = await client.getTorrentsBy({ ids: "aabbccddeeff00112233445566778899aabbccdd" });
    expect(torrent?.infoHash).toBe("AABBCCDDEEFF00112233445566778899AABBCCDD");
  });

  it("id 数组同样大小写不敏感", async () => {
    const client = new TestClient([
      makeTorrent("AABBCCDDEEFF00112233445566778899AABBCCDD"),
      makeTorrent("FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF"),
    ]);
    const torrents = await client.getTorrentsBy({
      ids: ["aabbccddeeff00112233445566778899aabbccdd"],
    });
    expect(torrents).toHaveLength(1);
  });
});

describe("PKG-2：建议列表缓存可主动失效", () => {
  it("TTL 内复用缓存，invalidateSuggestListCache 后立即重新拉取", async () => {
    const client = new TestClient([makeTorrent("AABBCCDDEEFF00112233445566778899AABBCCDD", "/downloads/a")]);

    await client.getClientPaths();
    expect(client.getAllCalls).toBe(1);

    // TTL 内（30s）第二次调用复用缓存
    await client.getClientPaths();
    expect(client.getAllCalls).toBe(1);

    client.invalidateCache();
    await client.getClientPaths();
    expect(client.getAllCalls).toBe(2);
  });
});
