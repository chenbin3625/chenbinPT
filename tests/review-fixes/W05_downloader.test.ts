import { afterEach, describe, expect, it, vi } from "vitest";
import axios from "axios";

vi.mock("@ptd/site/utils/adapter.ts", () => ({
  logMessage: vi.fn(),
}));

import Aria2 from "@ptd/downloader/entity/Aria2.ts";
import Deluge from "@ptd/downloader/entity/Deluge.ts";
import Flood from "@ptd/downloader/entity/Flood.ts";
import QBittorrent from "@ptd/downloader/entity/qBittorrent.ts";
import RuTorrent, { clientMetaData as ruTorrentMetaData } from "@ptd/downloader/entity/ruTorrent.ts";
import SynologyDownloadStation from "@ptd/downloader/entity/synologyDownloadStation.ts";
import Transmission from "@ptd/downloader/entity/Transmission.ts";
import UTorrent from "@ptd/downloader/entity/uTorrent.ts";
import { getDownloader, releaseDownloaderInstance, requireContext } from "@ptd/downloader/index.ts";
import { AbstractBittorrentClient, CTorrentState, CTrackerState, type CTorrent } from "@ptd/downloader/types.ts";
import { axios as downloaderAxios, extractMagnetHash, getRemoteTorrentFile } from "@ptd/downloader/utils.ts";

function buildXmlRpcMulticallResponse(rows: Array<Array<string | number>>): string {
  const serializeValue = (val: string | number) =>
    typeof val === "number" ? `<value><i8>${val}</i8></value>` : `<value><string>${val}</string></value>`;
  const rowsXml = rows
    .map((row) => `<value><array><data>${row.map(serializeValue).join("")}</data></array></value>`)
    .join("");
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<methodResponse><params><param><value><array><data>` +
    `<value><array><data><value><array><data>${rowsXml}</data></array></value></data></array></value>` +
    `</data></array></value></param></params></methodResponse>`
  );
}

/** 构造最小合法单文件 bencode .torrent 二进制（info: { length: 12, name: "demo.txt", piece length: 16384, pieces: 20 bytes }） */
function buildMinimalTorrentBytes(): Uint8Array {
  const head =
    "d8:announce20:http://t.example/ann10:created by4:test4:infod6:lengthi12e4:name8:demo.txt12:piece lengthi16384e6:pieces20:";
  const tail = "ee";
  const encoder = new TextEncoder();
  const headBytes = encoder.encode(head);
  const tailBytes = encoder.encode(tail);
  const out = new Uint8Array(headBytes.length + 20 + tailBytes.length);
  out.set(headBytes, 0);
  out.fill(0x61, headBytes.length, headBytes.length + 20);
  out.set(tailBytes, headBytes.length + 20);
  return out;
}

afterEach(() => {
  vi.restoreAllMocks();
});

/* -------------------------------------------------------------------------- */
/*                                   F0028                                    */
/* -------------------------------------------------------------------------- */

describe("F0028: qBittorrent request() does not override FormData Content-Type", () => {
  it("omits application/x-www-form-urlencoded for FormData POST (/torrents/add) while keeping it for plain POST", async () => {
    const requestSpy = vi.spyOn(downloaderAxios, "request").mockResolvedValue({ data: "Ok.", status: 200 } as any);

    const client = new QBittorrent({ address: "http://127.0.0.1:8080/", username: "admin", password: "pwd" });
    client.isLogin = true;

    const addResult = await client.addTorrent("magnet:?xt=urn:btih:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", {
      savePath: "/downloads",
      label: "PT",
      addAtPaused: true,
    });
    expect(addResult.success).toBe(true);
    expect(requestSpy).toHaveBeenCalledTimes(1);

    const addConfig = requestSpy.mock.calls[0]![0];
    expect(addConfig.url).toBe("/api/v2/torrents/add");
    expect(addConfig.data).toBeInstanceOf(FormData);
    expect(addConfig.headers?.["content-type"]).toBeUndefined();

    // 非 FormData 的 POST 仍应设置 application/x-www-form-urlencoded
    await client.recheckTorrent("HASH123");
    const recheckConfig = requestSpy.mock.calls[1]![0];
    expect(recheckConfig.url).toBe("/api/v2/torrents/recheck");
    expect(recheckConfig.headers?.["content-type"]).toBe("application/x-www-form-urlencoded");
  });
});

/* -------------------------------------------------------------------------- */
/*                                   F0029                                    */
/* -------------------------------------------------------------------------- */

describe("F0029: Aria2 methodSend() registers pending request only after WS reconnect", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not prematurely reject a call whose stale socket closes before reconnect succeeds", async () => {
    const sockets: FakeWebSocket[] = [];
    class FakeWebSocket {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;

      readyState = FakeWebSocket.CONNECTING;
      sent: string[] = [];
      private listeners = new Map<string, Set<(ev: any) => void>>();

      constructor(_url: string) {
        sockets.push(this);
      }

      addEventListener(type: string, cb: (ev: any) => void) {
        if (!this.listeners.has(type)) this.listeners.set(type, new Set());
        this.listeners.get(type)!.add(cb);
      }

      removeEventListener(type: string, cb: (ev: any) => void) {
        this.listeners.get(type)?.delete(cb);
      }

      emit(type: string, ev: any = {}) {
        for (const cb of [...(this.listeners.get(type) ?? [])]) {
          cb(ev);
        }
      }

      send(payload: string) {
        this.sent.push(payload);
        const parsed = JSON.parse(payload);
        queueMicrotask(() => {
          this.emit("message", {
            data: JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: "gid-reconnected" }),
          });
        });
      }

      close() {
        this.readyState = FakeWebSocket.CLOSED;
      }
    }

    vi.stubGlobal("WebSocket", FakeWebSocket);

    const client = new Aria2({ address: "ws://127.0.0.1:6800/jsonrpc", password: "" });

    // 启动 methodSend：attempt=0 创建 sockets[0]（CONNECTING）
    const sendPromise = (client as any).methodSend("aria2.addUri", [["magnet:?xt=urn:btih:1234"]]);
    expect(sockets).toHaveLength(1);

    // 模拟旧 socket 在连接阶段关闭，触发 _handleWsClose 和 attempt=1 重连
    sockets[0]!.readyState = FakeWebSocket.CLOSED;
    sockets[0]!.emit("close");

    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    sockets[1]!.readyState = FakeWebSocket.OPEN;
    sockets[1]!.emit("open");

    await expect(sendPromise).resolves.toMatchObject({ result: "gid-reconnected" });
    expect(sockets[0]!.sent).toHaveLength(0);
    expect(sockets[1]!.sent).toHaveLength(1);

    client.dispose();
  });
});

/* -------------------------------------------------------------------------- */
/*                               F0030 & F0036                                */
/* -------------------------------------------------------------------------- */

describe("F0030 & F0036: Aria2 magnet metadata fallback & getTorrentFiles numeric coercion", () => {
  it("F0030: parses magnet tasks without bittorrent.info using file path / infoHash / gid fallbacks", async () => {
    const client = new Aria2({ address: "http://127.0.0.1:6800/jsonrpc", password: "" });

    const tasks = [
      {
        gid: "gid-1",
        status: "active",
        totalLength: "0",
        completedLength: "0",
        uploadLength: "0",
        downloadSpeed: "0",
        uploadSpeed: "0",
        dir: "/downloads",
        files: [{ path: "/downloads/[METADATA]Ubuntu.iso" }],
        bittorrent: { announceList: [["http://tracker.local/announce"]] },
        infoHash: "abc123",
      },
      {
        gid: "gid-2",
        status: "waiting",
        totalLength: "0",
        completedLength: "0",
        uploadLength: "0",
        downloadSpeed: "0",
        uploadSpeed: "0",
        dir: "/downloads",
        files: [],
        bittorrent: { announceList: [] },
        infoHash: "def456",
      },
      {
        gid: "gid-3",
        status: "paused",
        totalLength: "0",
        completedLength: "0",
        uploadLength: "0",
        downloadSpeed: "0",
        uploadSpeed: "0",
        dir: "/downloads",
        files: [],
        bittorrent: {},
      },
    ];

    vi.spyOn(client, "methodSend").mockImplementation(async (method: string) => {
      if (method === "system.multicall") return { id: "1", jsonrpc: "2.0", result: [[tasks], [[]], [[]]] } as any;
      if (method === "aria2.tellStatus") return { id: "2", jsonrpc: "2.0", result: tasks[2] } as any;
      return { id: "3", jsonrpc: "2.0", result: [] } as any;
    });

    const all = await client.getAllTorrents();
    expect(all).toHaveLength(3);
    expect(all[0]!.name).toBe("[METADATA]Ubuntu.iso");
    expect(all[0]!.infoHash).toBe("abc123");
    expect(all[1]!.name).toBe("def456");
    expect(all[2]!.name).toBe("gid-3");
    expect(all[2]!.infoHash).toBe("");

    const single = await client.getTorrent("gid-3");
    expect(single?.name).toBe("gid-3");
    expect(single?.infoHash).toBe("");
  });

  it("F0036: getTorrentFiles converts Aria2 JSON-RPC string index/length/completedLength to numbers", async () => {
    const client = new Aria2({ address: "http://127.0.0.1:6800/jsonrpc", password: "" });
    vi.spyOn(client, "methodSend").mockResolvedValue({
      id: "1",
      jsonrpc: "2.0",
      result: [
        { index: "1", path: "/dl/a.mkv", length: "1000", completedLength: "250", selected: "true" },
        { index: "2", path: "/dl/b.srt", length: "200", completedLength: "0", selected: "false" },
      ],
    } as any);

    const files = await client.getTorrentFiles("gid-1");
    expect(files).toHaveLength(2);
    expect(typeof files[0]!.index).toBe("number");
    expect(typeof files[0]!.size).toBe("number");
    expect(files[0]).toMatchObject({
      index: 1,
      name: "a.mkv",
      size: 1000,
      progress: 25,
      priority: "normal",
      wanted: true,
    });
    expect(files[1]).toMatchObject({
      index: 2,
      name: "b.srt",
      size: 200,
      progress: 0,
      priority: "normal",
      wanted: false,
    });
  });
});

/* -------------------------------------------------------------------------- */
/*                                   F0031                                    */
/* -------------------------------------------------------------------------- */

describe("F0031: Deluge getTorrentsBy populates CTorrent.label and getClientLabels()", () => {
  it("maps raw torrent.label onto CTorrent and exposes it via getClientLabels()", async () => {
    const client = new Deluge({ address: "http://127.0.0.1:8112/", password: "deluge" });
    vi.spyOn(client as any, "request").mockResolvedValue({
      hash1: {
        hash: "hash1",
        name: "Labeled Torrent",
        state: "Seeding",
        time_added: 1700000000,
        is_finished: true,
        progress: 100,
        label: "movies",
        save_path: "/downloads",
        total_size: 1024,
        ratio: 2,
        upload_payload_rate: 10,
        download_payload_rate: 0,
        total_uploaded: 2048,
        all_time_download: 1024,
        private: true,
        trackers: [],
      },
      hash2: {
        hash: "hash2",
        name: "Unlabeled Torrent",
        state: "Downloading",
        time_added: 1700000001,
        is_finished: false,
        progress: 50,
        label: "",
        save_path: "/downloads",
        total_size: 1024,
        ratio: 0,
        upload_payload_rate: 0,
        download_payload_rate: 100,
        total_uploaded: 0,
        all_time_download: 512,
        private: false,
        trackers: [],
      },
    });

    const torrents = await client.getAllTorrents();
    expect(torrents.find((t) => t.id === "hash1")?.label).toBe("movies");
    expect(torrents.find((t) => t.id === "hash2")?.label).toBeUndefined();

    const labels = await client.getClientLabels();
    expect(labels).toEqual(["movies"]);
  });
});

/* -------------------------------------------------------------------------- */
/*                               F0032 & F0033                                */
/* -------------------------------------------------------------------------- */

describe("F0032 & F0033: Transmission ids normalization and label RPC16/comma/clear handling", () => {
  it("F0032: wraps single ids in array, coerces safe numeric strings to numbers, preserves recently-active and 40-digit hashes", async () => {
    const client = new Transmission({ address: "http://127.0.0.1:9091/" });
    const reqSpy = vi.spyOn(client, "request").mockResolvedValue({
      data: { result: "success", arguments: { torrents: [] } },
    } as any);

    await client.getTorrentsBy({ ids: "42" });
    expect(reqSpy.mock.calls[0]![1].ids).toEqual([42]);

    await client.getTorrentsBy({ ids: "recently-active" });
    expect(reqSpy.mock.calls[1]![1].ids).toBe("recently-active");

    const allDigitSha1 = "0123456789012345678901234567890123456789";
    await client.pauseTorrent(allDigitSha1);
    expect(reqSpy.mock.calls[2]![1].ids).toEqual([allDigitSha1]);

    await client.resumeTorrent("abc123hash");
    expect(reqSpy.mock.calls[3]![1].ids).toEqual(["abc123hash"]);

    await client.removeTorrent(["7", "hash-x"], true);
    expect(reqSpy.mock.calls[4]![1].ids).toEqual([7, "hash-x"]);

    await client.setTorrentFilePriority("99", [{ index: 0, priority: "high" }]);
    expect(reqSpy.mock.calls[5]![1].ids).toEqual([99]);
  });

  it("F0033: supports setTorrentLabel on RPC 16, rejects RPC 15, replaces commas, and clears with empty labels[]", async () => {
    const client16 = new Transmission({ address: "http://127.0.0.1:9091/" });
    vi.spyOn(client16, "getClientVersion").mockResolvedValue("3.00, RPC 16");
    const req16 = vi.spyOn(client16, "request").mockResolvedValue({
      data: { result: "success", arguments: {} },
    } as any);

    await expect(client16.setTorrentLabel("12", "  Movie, The  ")).resolves.toBe(true);
    expect(req16).toHaveBeenCalledWith("torrent-set", { ids: [12], labels: ["Movie- The"] });

    await expect(client16.setTorrentLabel(12, "   ")).resolves.toBe(true);
    expect(req16).toHaveBeenLastCalledWith("torrent-set", { ids: [12], labels: [] });

    // addTorrent 也应归一化逗号
    req16.mockReset();
    req16
      .mockResolvedValueOnce({
        data: { result: "success", arguments: { "torrent-added": { id: 15, hashString: "h", name: "n" } } },
      } as any)
      .mockResolvedValueOnce({ data: { result: "success", arguments: {} } } as any);

    await client16.addTorrent("magnet:?xt=urn:btih:1234", { label: "TV, 4K" });
    expect(req16.mock.calls[1]).toEqual(["torrent-set", { ids: [15], labels: ["TV- 4K"] }]);

    // RPC 15 仍应拒绝
    const client15 = new Transmission({ address: "http://127.0.0.1:9091/" });
    vi.spyOn(client15, "getClientVersion").mockResolvedValue("2.94, RPC 15");
    const req15 = vi.spyOn(client15, "request");
    await expect(client15.setTorrentLabel(1, "tag")).resolves.toBe(false);
    expect(req15).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/*                               F0034 & F0038                                */
/* -------------------------------------------------------------------------- */

describe("F0034 & F0038: qBittorrent getSyncData single-flight / fullSync & getTorrentFiles index fallback", () => {
  it("F0034: coalesces concurrent delta syncs and lets fullSync bypass TTL after awaiting in-flight delta", async () => {
    const client = new QBittorrent({ address: "http://127.0.0.1:8080/", username: "admin", password: "pwd" });
    client.isLogin = true;

    let resolveDelta!: (v: any) => void;
    const requestSpy = vi
      .spyOn(downloaderAxios, "request")
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveDelta = resolve;
          }),
      )
      .mockResolvedValueOnce({
        data: { rid: 1, full_update: true, server_state: { free_space_on_disk: 999 }, torrents: {} },
      } as any);

    // 两次并发 delta 同步应合并为一次 /sync/maindata 请求
    const p1 = (client as any).getSyncData(false);
    const p2 = (client as any).getSyncData(false);
    // 同时发起的 fullSync 应等待 delta 完成后再发 rid=0，且不被 15s TTL 拦截
    const pFull = (client as any).getSyncData(true);

    expect(requestSpy).toHaveBeenCalledTimes(1);
    resolveDelta({
      data: { rid: 5, full_update: true, server_state: { free_space_on_disk: 100 }, torrents: {} },
    });

    const [r1, r2, rFull] = await Promise.all([p1, p2, pFull]);
    expect(r1.rid).toBe(5);
    expect(r2.rid).toBe(5);
    expect(rFull.rid).toBe(1);
    expect(requestSpy).toHaveBeenCalledTimes(2);
    expect(requestSpy.mock.calls[1]![0].params).toEqual({ rid: 0 });
  });

  it("F0038: getTorrentFiles falls back to array index when file.index is undefined", async () => {
    const client = new QBittorrent({ address: "http://127.0.0.1:8080/", username: "admin", password: "pwd" });
    client.isLogin = true;
    vi.spyOn(downloaderAxios, "request").mockResolvedValue({
      data: [
        { name: "first.mkv", size: 100, progress: 0.5, priority: 1, is_seed: false },
        { index: 0, name: "explicit-zero.srt", size: 20, progress: 1, priority: 6, is_seed: false },
        { name: "third.nfo", size: 10, progress: 0, priority: 0, is_seed: false },
      ],
    } as any);

    const files = await client.getTorrentFiles("HASH");
    expect(files.map((f) => f.index)).toEqual([0, 0, 2]);
  });
});

/* -------------------------------------------------------------------------- */
/*                               F0035 & F0037                                */
/* -------------------------------------------------------------------------- */

describe("F0035 & F0037: Flood getTorrentHash normalization & checking status precedence", () => {
  it("F0035: uppercases string hash and falls back from empty infoHash to id", async () => {
    const client = new Flood({ address: "http://127.0.0.1:3000/" });
    const reqSpy = vi.spyOn(client as any, "request").mockResolvedValue({ data: [] });

    await client.getTorrentFiles("abcdef1234");
    expect(reqSpy).toHaveBeenCalledWith("/api/torrents/ABCDEF1234/contents");

    await client.getTorrentFiles({ id: "fedcba9876", infoHash: "" } as CTorrent);
    expect(reqSpy).toHaveBeenLastCalledWith("/api/torrents/FEDCBA9876/contents");
  });

  it("F0037: evaluates checking before downloading/seeding/stopped/complete while keeping error highest", async () => {
    const client = new Flood({ address: "http://127.0.0.1:3000/" });
    const baseTorrent = {
      name: "t",
      dateAdded: 1700000000,
      percentComplete: 50,
      tags: [],
      directory: "/dl",
      sizeBytes: 1000,
      ratio: 0,
      upRate: 0,
      downRate: 0,
      upTotal: 0,
      downTotal: 500,
      isPrivate: true,
      trackerURIs: [],
    };
    vi.spyOn(client as any, "request").mockResolvedValue({
      data: {
        torrents: {
          H1: { ...baseTorrent, hash: "H1", status: ["checking", "downloading"] },
          H2: { ...baseTorrent, hash: "H2", status: ["checking", "stopped", "complete"] },
          H3: { ...baseTorrent, hash: "H3", status: ["error", "checking"] },
        },
      },
    });

    const list = await client.getAllTorrents();
    expect(list.find((t) => t.infoHash === "H1")?.state).toBe(CTorrentState.checking);
    expect(list.find((t) => t.infoHash === "H2")?.state).toBe(CTorrentState.checking);
    expect(list.find((t) => t.infoHash === "H3")?.state).toBe(CTorrentState.error);
  });
});

/* -------------------------------------------------------------------------- */
/*                       F0039, F0043, F0044, F0045                           */
/* -------------------------------------------------------------------------- */

describe("F0039, F0043, F0044, F0045: ruTorrent priority, peer progress, tracker state & label encoding", () => {
  it("F0039: uses 0/1/2 priority scale, declares low+highest unsupported, and calls d.update_priorities", async () => {
    expect(ruTorrentMetaData.feature.FilePriority.unsupportedPriorities).toEqual(["low", "highest"]);

    const client = new RuTorrent({ address: "http://127.0.0.1/rutorrent" });
    const xmlFiles = buildXmlRpcMulticallResponse([
      ["skip.txt", 100, 0, 10, 0],
      ["norm.mkv", 200, 5, 10, 1],
      ["high.mkv", 300, 10, 10, 2],
    ]);
    const rpcSpy = vi.spyOn(client, "requestHttpRpc").mockResolvedValue({ data: xmlFiles } as any);

    const files = await client.getTorrentFiles("abc123");
    expect(files.map((f) => f.priority)).toEqual(["skip", "normal", "high"]);

    rpcSpy.mockResolvedValueOnce({
      data: "<methodResponse><params><param><value><array><data/></array></value></param></params></methodResponse>",
    } as any);
    const ok = await client.setTorrentFilePriority("abc123", [
      { index: 0, priority: "skip" },
      { index: 1, priority: "normal" },
      { index: 2, priority: "high" },
    ]);
    expect(ok).toBe(true);
    const sentXml = rpcSpy.mock.calls[1]![0] as string;
    expect(sentXml).toContain("<string>ABC123:f0</string></value><value><string>0</string>");
    expect(sentXml).toContain("<string>ABC123:f1</string></value><value><string>1</string>");
    expect(sentXml).toContain("<string>ABC123:f2</string></value><value><string>2</string>");
    expect(sentXml).toContain(
      "<member><name>methodName</name><value><string>d.update_priorities</string></value></member><member><name>params</name><value><array><data><value><string>ABC123</string></value></data></array></value></member>",
    );
  });

  it("F0043: getTorrentPeers reads p.completed_percent as 0-100 directly without dividing by 10", async () => {
    const client = new RuTorrent({ address: "http://127.0.0.1/rutorrent" });
    vi.spyOn(client, "requestHttpRpc").mockResolvedValue({
      data: buildXmlRpcMulticallResponse([
        ["1.2.3.4", 51413, "qBittorrent", 75, 100, 200, 1, 1],
        ["5.6.7.8", 6881, "rTorrent", 100, 0, 50, 0, 0],
      ]),
    } as any);

    const peers = await client.getTorrentPeers("HASH");
    expect(peers.map((p) => p.progress)).toEqual([75, 100]);
  });

  it("F0044: getTorrentTrackersDetail queries failed/success counters and maps tracker states accurately", async () => {
    const client = new RuTorrent({ address: "http://127.0.0.1/rutorrent" });
    const rpcSpy = vi.spyOn(client, "requestHttpRpc").mockResolvedValue({
      data: buildXmlRpcMulticallResponse([
        ["http://t.disabled/ann", 0, 0, 0, 0, 0, 0, 0, 0],
        ["http://t.updating/ann", 1, 1, 10, 2, 1700000000, 0, 0, 1],
        ["http://t.error/ann", 1, 0, 0, 0, 1700000001, 0, 3, 0],
        ["http://t.working/ann", 1, 0, 20, 5, 1700000002, 0, 0, 4],
        ["http://t.unknown/ann", 1, 0, 0, 0, 0, 0, 0, 0],
      ]),
    } as any);

    const trackers = await client.getTorrentTrackersDetail("HASH");
    const sentXml = rpcSpy.mock.calls[0]![0] as string;
    expect(sentXml).toContain("<string>t.failed_counter=</string>");
    expect(sentXml).toContain("<string>t.success_counter=</string>");
    expect(trackers.map((t) => [t.url, t.status])).toEqual([
      ["http://t.disabled/ann", CTrackerState.disabled],
      ["http://t.updating/ann", CTrackerState.updating],
      ["http://t.error/ann", CTrackerState.error],
      ["http://t.working/ann", CTrackerState.working],
      ["http://t.unknown/ann", CTrackerState.unknown],
    ]);
  });

  it("F0045: setTorrentLabel URL-encodes label before writing to d.custom1.set", async () => {
    const client = new RuTorrent({ address: "http://127.0.0.1/rutorrent" });
    const rpcSpy = vi.spyOn(client, "requestHttpRpc").mockResolvedValue({
      data: "<methodResponse><params><param><value><array><data/></array></value></param></params></methodResponse>",
    } as any);

    await expect(client.setTorrentLabel("hash1", "100% HD & 4K")).resolves.toBe(true);
    const sentXml = rpcSpy.mock.calls[0]![0] as string;
    expect(sentXml).toContain("<string>100%25%20HD%20%26%204K</string>");
  });
});

/* -------------------------------------------------------------------------- */
/*                               F0040 & F0046                                */
/* -------------------------------------------------------------------------- */

describe("F0040 & F0046: Synology array id serialization & concurrent 105/106 auth retry safety", () => {
  it("F0040: serializes id as a JSON array in getTorrentsBy, pauseTorrent, resumeTorrent, and removeTorrent", async () => {
    const client = new SynologyDownloadStation({ address: "http://127.0.0.1:5000/" });
    (client as any)._sessionId = "SID1";
    const axiosSpy = vi.spyOn(axios, "request").mockResolvedValue({
      data: { success: true, data: { offset: 0, total: 0, task: [] } },
    } as any);

    await client.getTorrentsBy({ ids: "dbid_1" });
    await client.pauseTorrent("dbid_2");
    await client.resumeTorrent("dbid_3");
    await client.removeTorrent("dbid_4", true);

    const sentIds = axiosSpy.mock.calls.map((call) => (call[0]!.data as URLSearchParams).get("id"));
    expect(sentIds).toEqual(['["dbid_1"]', '["dbid_2"]', '["dbid_3"]', '["dbid_4"]']);
  });

  it("F0046: concurrent 105/106 retries reuse refreshed _sessionId without wiping it or logging in twice", async () => {
    const client = new SynologyDownloadStation({ address: "http://127.0.0.1:5000/", username: "u", password: "p" });
    (client as any)._sessionId = "OLD_SID";
    (client as any)._apiInfo = { "SYNO.API.Auth": { maxVersion: 7, minVersion: 1, path: "entry.cgi" } };

    let loginCount = 0;
    let releaseReq2Error!: () => void;
    const req2ErrorGate = new Promise<void>((resolve) => {
      releaseReq2Error = resolve;
    });
    let req1Attempt = 0;
    let req2Attempt = 0;

    vi.spyOn(axios, "request").mockImplementation(async (cfg: any) => {
      if (String(cfg.url).includes("auth.cgi")) {
        loginCount++;
        return { data: { success: true, data: { sid: `NEW_SID_${loginCount}` } } } as any;
      }
      const data = cfg.data as URLSearchParams;
      const sid = data.get("_sid");
      const id = data.get("id");
      if (id === '["t1"]') {
        req1Attempt++;
        if (req1Attempt === 1 && sid === "OLD_SID") {
          return { data: { success: false, error: { code: 105 } } } as any;
        }
        return { data: { success: true, data: {} } } as any;
      }
      req2Attempt++;
      if (req2Attempt === 1 && sid === "OLD_SID") {
        // 等请求 1 完成重登并把 _sessionId 更新为 NEW_SID_1 之后，再返回请求 2 的 106
        await req2ErrorGate;
        return { data: { success: false, error: { code: 106 } } } as any;
      }
      expect(sid).toBe("NEW_SID_1");
      return { data: { success: true, data: {} } } as any;
    });

    const p1 = client.pauseTorrent("t1");
    const p2 = client.pauseTorrent("t2");

    await expect(p1).resolves.toBe(true);
    expect((client as any)._sessionId).toBe("NEW_SID_1");

    releaseReq2Error();
    await expect(p2).resolves.toBe(true);
    expect(loginCount).toBe(1);
    expect((client as any)._sessionId).toBe("NEW_SID_1");
  });
});

/* -------------------------------------------------------------------------- */
/*                           F0041, F0047, F0048                              */
/* -------------------------------------------------------------------------- */

describe("F0041, F0047, F0048: uTorrent repeated f= setprio, concurrent token refresh & strict token parsing", () => {
  it("F0041: sends repeated f= query params (via paramsSerializer.indexes=null) and chunks >100 files", async () => {
    const client = new UTorrent({ address: "http://127.0.0.1:8080/gui/", username: "u", password: "p" });
    (client as any)._sid = "TOK";

    const getSpy = vi.spyOn(axios, "get").mockResolvedValue({ data: { build: 1 } } as any);

    const selections = Array.from({ length: 105 }, (_, i) => ({ index: i, priority: "high" as const }));
    await expect(client.setTorrentFilePriority("HASH", selections)).resolves.toBe(true);

    expect(getSpy).toHaveBeenCalledTimes(2);
    const firstConfig = getSpy.mock.calls[0]![1]!;
    const secondConfig = getSpy.mock.calls[1]![1]!;
    expect((firstConfig.params as any).f).toHaveLength(100);
    expect((secondConfig.params as any).f).toEqual([100, 101, 102, 103, 104]);
    expect(firstConfig.paramsSerializer).toEqual({ indexes: null });

    // 验证 axios 实际序列化出重复的 f= 而不是 f[]= 或 f=100,101,...
    const serializedUrl = axios.getUri({
      url: "http://127.0.0.1:8080/gui/",
      params: secondConfig.params,
      paramsSerializer: secondConfig.paramsSerializer,
    });
    expect(serializedUrl).toContain("f=100&f=101&f=102&f=103&f=104");
    expect(serializedUrl).not.toContain("f%5B");
  });

  it("F0047: concurrent 400 invalid request retries coalesce into a single /token.html fetch", async () => {
    const client = new UTorrent({ address: "http://127.0.0.1:8080/gui/", username: "u", password: "p" });
    (client as any)._sid = "OLD_TOK";

    let tokenFetches = 0;
    let releaseSecondFail!: () => void;
    const secondFailGate = new Promise<void>((resolve) => {
      releaseSecondFail = resolve;
    });

    vi.spyOn(axios, "get").mockImplementation(async (url: string, cfg?: any) => {
      if (url === "/token.html") {
        tokenFetches++;
        return { data: `<div id='token' style='display:none;'>NEW_TOK_${tokenFetches}</div>` } as any;
      }
      if (cfg?.params?.token === "OLD_TOK") {
        if (cfg?.params?.hash === "H2") {
          await secondFailGate;
        }
        throw Object.assign(new Error("invalid request"), { response: { status: 400, data: "invalid request" } });
      }
      expect(cfg?.params?.token).toBe("NEW_TOK_1");
      return { data: { build: 1 } } as any;
    });

    const p1 = client.pauseTorrent("H1");
    const p2 = client.pauseTorrent("H2");

    await expect(p1).resolves.toBe(true);
    releaseSecondFail();
    await expect(p2).resolves.toBe(true);
    expect(tokenFetches).toBe(1);
    expect((client as any)._sid).toBe("NEW_TOK_1");
  });

  it("F0048: login() only accepts <div id='token'>...</div> and rejects arbitrary HTML or blank tokens", async () => {
    const client = new UTorrent({ address: "http://127.0.0.1:8080/gui/", username: "u", password: "p" });
    const getSpy = vi.spyOn(axios, "get");

    getSpy.mockResolvedValueOnce({ data: "<html><head><title>404 Not Found</title></head></html>" } as any);
    await expect(client.ping()).resolves.toBe(false);
    expect((client as any)._sid).toBeNull();

    getSpy.mockResolvedValueOnce({ data: "<html><div id='token'>   </div></html>" } as any);
    await expect(client.ping()).resolves.toBe(false);
    expect((client as any)._sid).toBeNull();

    getSpy.mockResolvedValueOnce({
      data: "<html><div id='token' style='display:none;'>  REAL_TOKEN  </div></html>",
    } as any);
    await expect(client.ping()).resolves.toBe(true);
    expect((client as any)._sid).toBe("REAL_TOKEN");
  });
});

/* -------------------------------------------------------------------------- */
/*                       F0049, F0050, F0051, F0052                           */
/* -------------------------------------------------------------------------- */

describe("F0049, F0050, F0051, F0052: downloader utils, index cache dedup & base client id matching", () => {
  it("F0049: getRemoteTorrentFile recovers from malformed percent-encoding in Content-Disposition filename*", async () => {
    const torrentBytes = buildMinimalTorrentBytes();
    vi.spyOn(axios, "request").mockResolvedValue({
      data: torrentBytes.buffer.slice(torrentBytes.byteOffset, torrentBytes.byteOffset + torrentBytes.byteLength),
      headers: {
        "content-type": "application/x-bittorrent",
        "content-disposition": "attachment; filename*=UTF-8''bad%ZZname.torrent",
      },
    } as any);

    const parsed = await getRemoteTorrentFile({ url: "https://tracker.example/download/1" });
    expect(parsed.name).toBe("bad%ZZname.torrent");
    expect(parsed.info?.name).toBe("demo.txt");
  });

  it("F0050: concurrent getDownloader() calls for the same config coalesce into a single instance", async () => {
    const originalLoader = requireContext["./entity/Flood.ts"]!;
    let loaderCalls = 0;
    let releaseModule!: () => void;
    const moduleGate = new Promise<void>((resolve) => {
      releaseModule = resolve;
    });

    vi.spyOn(requireContext, "./entity/Flood.ts").mockImplementation(async () => {
      loaderCalls++;
      await moduleGate;
      return await originalLoader();
    });

    const cfg = {
      id: "dl-f0050",
      type: "Flood",
      name: "Flood",
      address: "http://127.0.0.1:3000/",
      username: "u",
      password: "p",
    };

    const pA = getDownloader(cfg);
    const pB = getDownloader(cfg);
    releaseModule();

    const [a, b] = await Promise.all([pA, pB]);
    expect(a).toBe(b);
    expect(loaderCalls).toBe(1);

    const c = await getDownloader({ ...cfg, address: "http://127.0.0.1:3001/" });
    expect(c).not.toBe(a);

    releaseDownloaderInstance(a);
    releaseDownloaderInstance(c);
  });

  it("F0051: AbstractBittorrentClient.getTorrentsBy({ ids }) matches CTorrent.id when id !== infoHash or infoHash is empty", async () => {
    class MockClient extends AbstractBittorrentClient {
      override version = "v1.0.0" as const;
      constructor(cfg: any) {
        super(cfg);
      }
      protected async getClientVersionFromRemote() {
        return "1.0.0";
      }
      async ping() {
        return true;
      }
      async addTorrent() {
        return { success: true };
      }
      async getAllTorrents(): Promise<CTorrent[]> {
        return [
          { id: "gid-abc", infoHash: "", name: "Aria2 Magnet" } as CTorrent,
          { id: "gid-def", infoHash: "AABBCC", name: "Aria2 BT" } as CTorrent,
        ];
      }
      async pauseTorrent() {
        return true;
      }
      async resumeTorrent() {
        return true;
      }
      async removeTorrent() {
        return true;
      }
      async getTorrentTrackers() {
        return [];
      }
    }

    const client = new MockClient({ type: "Mock", name: "Mock", address: "http://localhost/" });

    const byEmptyHashId = await client.getTorrent("GID-ABC");
    expect(byEmptyHashId?.name).toBe("Aria2 Magnet");

    const byGid = await client.getTorrent("gid-def");
    expect(byGid?.name).toBe("Aria2 BT");

    const byInfoHash = await client.getTorrent("aabbcc");
    expect(byInfoHash?.name).toBe("Aria2 BT");
  });

  it("F0052: extractMagnetHash matches xt.2 and higher numbered xt parameters in hybrid magnets", () => {
    const v1Hash = "0123456789abcdef0123456789abcdef01234567";
    const v2Hash = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

    const v2FirstHybrid = `magnet:?xt.1=urn:btmh:1220${v2Hash}&xt.2=urn:btih:${v1Hash}&dn=Hybrid`;
    expect(extractMagnetHash(v2FirstHybrid)).toBe(v1Hash);

    const v2OnlyAtXt3 = `magnet:?dn=V2Only&xt.3=urn:btmh:1220${v2Hash}`;
    expect(extractMagnetHash(v2OnlyAtXt3)).toBe(v2Hash);
  });
});
