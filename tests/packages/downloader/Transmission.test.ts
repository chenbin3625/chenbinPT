/**
 * Transmission 实体回归测试。
 *
 * 覆盖两个已确认的缺陷：
 * - B-5：torrent-set 的限速参数用了 kebab-case（`upload-limit` / `download-limited`…），
 *   而 rpc-spec 只认 camelCase（`uploadLimit` / `uploadLimited`…，Transmission 4/5 的
 *   兼容层也只枚举 camelCase）。未知键会被服务端静默忽略且仍返回 success ——
 *   即「限速没生效但 UI 报成功」。
 * - D-5：torrent-add 在种子已在库中时返回 `torrent-duplicate`，旧代码只读
 *   `torrent-added`，会抛 TypeError 把「成功」记成失败。现在 duplicate 判为成功，
 *   但**有意跟随上游 58395cf0** 跳过标签/限速等 torrent-set 后置设置（避免改写用户已有种子的配置），
 *   替代 fork 早先「duplicate 时继续设置标签」的行为。
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@ptd/downloader/utils.ts", () => ({
  getRemoteTorrentFile: vi.fn(),
  sanitizeDownloadUrlForLog: vi.fn((url: string) => String(url)),
}));

vi.mock("@ptd/site/utils/adapter.ts", () => ({
  logMessage: vi.fn(),
}));

import Transmission from "@ptd/downloader/entity/Transmission.ts";

const MAGNET = "magnet:?xt=urn:btih:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

describe("Transmission RPC 地址", () => {
  it("主机名含 rpc 时仍补上路径，同时保留自定义 rpc 路径", () => {
    expect((new Transmission({ address: "https://rpc.example.com/" }) as any).address).toBe(
      "https://rpc.example.com/transmission/rpc",
    );
    expect((new Transmission({ address: "https://host.example/custom/rpc" }) as any).address).toBe(
      "https://host.example/custom/rpc",
    );
  });

  it("非法地址不会让构造函数抛 TypeError（复检：对齐 uTorrent N-2）", () => {
    expect(() => new Transmission({ address: "not a valid url" })).not.toThrow();
  });
});

/** 用 stub 掉 request 的实例，只验证「发出去的参数」 */
function createClient(response?: any) {
  const client = new Transmission({ address: "http://tr.local:9091/", username: "u", password: "p" });
  const requestMock = vi.fn().mockResolvedValue(response ?? { data: { result: "success", arguments: {} } });
  (client as any).request = requestMock;
  return { client, requestMock };
}

describe("Transmission：torrent-set 限速键名（B-5）", () => {
  it("使用 camelCase 键名（修复前是 kebab-case，服务端忽略但返回成功）", async () => {
    const { client, requestMock } = createClient();

    await expect(client.setTorrentSpeedLimit("HASH-A", { upload: 100, download: 200 })).resolves.toBe(true);

    expect(requestMock).toHaveBeenCalledTimes(1);
    const [method, args] = requestMock.mock.calls[0];
    expect(method).toBe("torrent-set");
    expect(args).toEqual({
      ids: "HASH-A",
      uploadLimit: 100,
      uploadLimited: true,
      downloadLimit: 200,
      downloadLimited: true,
    });

    // 修复前的确切键名，任何一个都不允许再出现
    for (const kebab of ["upload-limit", "upload-limited", "download-limit", "download-limited"]) {
      expect(args).not.toHaveProperty(kebab);
    }
  });

  it("限速为 0 时把 *Limited 置为 false（而不是删除键）", async () => {
    const { client, requestMock } = createClient();

    await client.setTorrentSpeedLimit("HASH-B", { download: 0 });

    expect(requestMock.mock.calls[0][1]).toEqual({ ids: "HASH-B", downloadLimit: 0, downloadLimited: false });
  });
});

describe("Transmission：torrent-duplicate 视为成功（D-5）", () => {
  /** rpc-version 16 < 17，因此标签需要在添加后补一次 torrent-set */
  function duplicateResponse() {
    return {
      data: {
        result: "success",
        arguments: {
          version: "4.0.5",
          "rpc-version": 16,
          "torrent-duplicate": { id: 7, hashString: "deadbeef", name: "dup" },
        },
      },
    };
  }

  it("种子已在库中时 addTorrent 仍然成功，但不再对已有种子补设标签/限速（跟随上游 58395cf0）", async () => {
    const { client, requestMock } = createClient(duplicateResponse());

    const result = await client.addTorrent(MAGNET, { label: "tv", uploadSpeedLimit: 100, addAtPaused: false });

    expect(result.success).toBe(true);
    expect(result.message).toBeUndefined();
    expect(result.id).toBe("7");

    // 只有 [0] session-get（取 RPC 版本）→ [1] torrent-add，不发 torrent-set：
    // 种子早已在库中，补设标签/限速会改写用户对已有种子的配置（替代 fork 早先「继续设置标签」的行为）
    expect(requestMock.mock.calls.map(([method]) => method)).toEqual(["session-get", "torrent-add"]);
  });

  it("新增成功（torrent-added）时行为不变", async () => {
    const { client, requestMock } = createClient({
      data: {
        result: "success",
        arguments: {
          version: "4.0.5",
          "rpc-version": 16,
          "torrent-added": { id: 9, hashString: "cafebabe", name: "new" },
        },
      },
    });

    const result = await client.addTorrent(MAGNET, { label: "movies", addAtPaused: false });

    expect(result.success).toBe(true);
    expect(requestMock.mock.calls[2][1]).toEqual({ ids: 9, labels: ["movies"] });
  });
});

describe("Transmission：各版本的重复种子响应（L-12）", () => {
  /** session-get 返回版本信息，torrent-add 返回被测响应 */
  function clientWithAddResponse(addResponse: any, rpcVersion = 14) {
    const { client, requestMock } = createClient();
    requestMock.mockImplementation(async (method: string) =>
      method === "session-get"
        ? { data: { result: "success", arguments: { version: "2.77", "rpc-version": rpcVersion } } }
        : addResponse,
    );
    return { client, requestMock };
  }

  it('2.77（rpc14）只回 result: "duplicate torrent"、无 arguments：判成功', async () => {
    const { client } = clientWithAddResponse({ data: { result: "duplicate torrent" } });

    const result = await client.addTorrent(MAGNET, { addAtPaused: false });
    expect(result.success).toBe(true);
  });

  it("2.80（rpc15）带 torrent-duplicate 但 result 非 success：判成功并带回 id", async () => {
    const { client } = clientWithAddResponse(
      {
        data: {
          result: "duplicate torrent",
          arguments: { "torrent-duplicate": { id: 3, hashString: "aa", name: "dup" } },
        },
      },
      15,
    );

    const result = await client.addTorrent(MAGNET, { addAtPaused: false });
    expect(result.success).toBe(true);
    expect(result.id).toBe("3");
  });

  it("真正的失败（如 invalid or corrupt torrent file）仍判失败", async () => {
    const { client } = clientWithAddResponse({ data: { result: "invalid or corrupt torrent file" } });

    const result = await client.addTorrent(MAGNET, { addAtPaused: false });
    expect(result.success).toBe(false);
  });
});

/** C1 修复轮回归：TR-1 / TR-2 / TR-3 / TR-4 / SEC-1 */
describe("Transmission：C1 修复轮", () => {
  const baseTorrent = (overrides: Record<string, any> = {}) => ({
    addedDate: 1,
    id: 1,
    hashString: "ABCDEF0123456789ABCDEF0123456789ABCDEF01",
    isFinished: false,
    name: "n",
    percentDone: 0,
    uploadRatio: 0,
    downloadDir: "/d",
    status: 4,
    totalSize: 1,
    leftUntilDone: 1,
    labels: [],
    rateDownload: 0,
    rateUpload: 0,
    uploadedEver: 0,
    downloadedEver: 0,
    trackers: [],
    ...overrides,
  });

  function torrentClient(torrents: any[]) {
    const { client, requestMock } = createClient();
    requestMock.mockResolvedValue({ data: { result: "success", arguments: { torrents } } });
    return { client, requestMock };
  }

  const trackerStat = (overrides: Record<string, any> = {}) => ({
    announce: "https://tracker.local/announce",
    announceState: 0,
    hasAnnounced: false,
    isBackup: false,
    lastAnnounceSucceeded: false,
    ...overrides,
  });

  it("TR-1：从未 announce 过的 tracker 是 unknown，而不是 error", async () => {
    const { client } = torrentClient([{ trackerStats: [trackerStat()] }]);
    const [tracker] = await client.getTorrentTrackersDetail("HASH");
    expect(tracker.status).toBe("unknown");
  });

  it("TR-1：备用 tracker 是 disabled", async () => {
    const { client } = torrentClient([{ trackerStats: [trackerStat({ isBackup: true })] }]);
    const [tracker] = await client.getTorrentTrackersDetail("HASH");
    expect(tracker.status).toBe("disabled");
  });

  it("TR-1：已 announce 且失败才是 error", async () => {
    const { client } = torrentClient([
      { trackerStats: [trackerStat({ hasAnnounced: true, lastAnnounceSucceeded: false })] },
    ]);
    const [tracker] = await client.getTorrentTrackersDetail("HASH");
    expect(tracker.status).toBe("error");
  });

  it("TR-2：removeTorrentTracker 先查 tracker id，再传整数数组给 trackerRemove", async () => {
    const { client, requestMock } = createClient();
    requestMock
      .mockResolvedValueOnce({
        data: {
          result: "success",
          arguments: { torrents: [{ trackerStats: [{ announce: "https://a/announce", id: 7 }] }] },
        },
      })
      .mockResolvedValueOnce({ data: { result: "success" } });

    await expect(client.removeTorrentTracker("HASH", "https://a/announce")).resolves.toBe(true);

    expect(requestMock.mock.calls[0][0]).toBe("torrent-get");
    expect(requestMock.mock.calls[1][0]).toBe("torrent-set");
    expect(requestMock.mock.calls[1][1]).toEqual({ ids: "HASH", trackerRemove: [7] });
  });

  it("TR-3：status=1（排队等待校验）映射为 checking", async () => {
    const { client } = torrentClient([baseTorrent({ status: 1 })]);
    const [torrent] = await client.getTorrentsBy({});
    expect(torrent.state).toBe("checking");
  });

  it("TR-3：tr_stat.error>=2 映射为 error，error=1（tracker warning）不算", async () => {
    const { client } = torrentClient([baseTorrent({ error: 2 }), baseTorrent({ error: 1 })]);
    const [withError, withWarning] = await client.getTorrentsBy({});
    expect(withError.state).toBe("error");
    expect(withWarning.state).toBe("downloading");
  });

  it("TR-4：磁链未获取元数据时 isCompleted 为 false", async () => {
    const { client } = torrentClient([
      baseTorrent({ percentDone: 0, leftUntilDone: 0 }),
      baseTorrent({ percentDone: 1, leftUntilDone: 0, isFinished: true }),
    ]);
    const [magnet, completed] = await client.getTorrentsBy({});
    expect(magnet.isCompleted).toBe(false);
    expect(completed.isCompleted).toBe(true);
  });

  it("SEC-1：添加失败日志里的 URL 已脱敏（不含 passkey）", async () => {
    const { logMessage } = await import("@ptd/site/utils/adapter.ts");
    const { sanitizeDownloadUrlForLog } = await import("@ptd/downloader/utils.ts");
    // 本文件的 sanitize 被 mock 成 passthrough；这里换成「去掉 query」的实现来验证调用点确实做了脱敏
    vi.mocked(sanitizeDownloadUrlForLog).mockImplementation((url: any) => String(url).split("?")[0]);
    const { client } = createClient();
    (client as any).request = vi.fn().mockRejectedValue(new Error("offline"));
    (vi.mocked(logMessage) as any).mockClear();

    await client.addTorrent("https://pt.example/download.php?id=1&passkey=SECRET", {
      addAtPaused: false,
      localDownload: false,
    });

    const failureLog = vi.mocked(logMessage).mock.calls.find((call) => String(call[0]).includes("添加种子失败"));
    expect(failureLog).toBeDefined();
    expect(JSON.stringify(failureLog![1])).not.toContain("SECRET");
  });
});
