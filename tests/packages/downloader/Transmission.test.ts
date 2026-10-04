/**
 * Transmission 实体回归测试。
 *
 * 覆盖两个已确认的缺陷：
 * - B-5：torrent-set 的限速参数用了 kebab-case（`upload-limit` / `download-limited`…），
 *   而 rpc-spec 只认 camelCase（`uploadLimit` / `uploadLimited`…，Transmission 4/5 的
 *   兼容层也只枚举 camelCase）。未知键会被服务端静默忽略且仍返回 success ——
 *   即「限速没生效但 UI 报成功」。
 * - D-5：torrent-add 在种子已在库中时返回 `torrent-duplicate`，旧代码只读
 *   `torrent-added`，会抛 TypeError 把「成功」记成失败，并跳过标签/限速后置设置。
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@ptd/downloader/utils.ts", () => ({
  getRemoteTorrentFile: vi.fn(),
}));

vi.mock("@ptd/site/utils/adapter.ts", () => ({
  logMessage: vi.fn(),
}));

import Transmission from "@ptd/downloader/entity/Transmission.ts";

const MAGNET = "magnet:?xt=urn:btih:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

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

  it("种子已在库中时 addTorrent 仍然成功，并继续设置标签", async () => {
    const { client, requestMock } = createClient(duplicateResponse());

    const result = await client.addTorrent(MAGNET, { label: "tv", addAtPaused: false });

    expect(result.success).toBe(true);
    expect(result.message).toBeUndefined();

    // [0] session-get（取 RPC 版本）→ [1] torrent-add → [2] torrent-set
    expect(requestMock.mock.calls.map(([method]) => method)).toEqual(["session-get", "torrent-add", "torrent-set"]);
    expect(requestMock.mock.calls[2][1]).toEqual({ ids: 7, labels: ["tv"] });
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
