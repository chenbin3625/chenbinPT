/**
 * 第三轮审查 downloader 包（DOWNLOADER-1 ~ DOWNLOADER-8）的行为回归测试。
 *
 * 覆盖：
 * - DOWNLOADER-1：Deluge 文件优先级数值按上游 FILE_PRIORITY（0/1/4/7）读写；
 * - DOWNLOADER-2：Flood/ruTorrent/uTorrent/Transmission/Deluge 声明客户端不存在的档位；
 * - DOWNLOADER-3：Synology / Aria2 的「能力不支持」返回 false 而不是抛异常；
 * - DOWNLOADER-4：ruTorrent 除 setTorrentLabel 外的方法也校验 httprpc 的失败信号；
 * - DOWNLOADER-5：包级缓存淘汰不关闭外部仍持有的实例，releaseDownloaderInstance 才 dispose 长连接；
 * - DOWNLOADER-6：Transmission request() 读 result（HTTP 200 + 错误串不再算成功）；
 * - DOWNLOADER-7：Synology size_downloaded=0 时 ratio 不做除零；
 * - DOWNLOADER-8：uTorrent 直发 http 链接拿不到 infoHash 时回传 message。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { axiosPostMock, axiosRequestMock, axiosGetMock, axiosCreateMock } = vi.hoisted(() => {
  const post = vi.fn();
  const request = vi.fn();
  const get = vi.fn();
  const create = vi.fn(() => ({
    post,
    request,
    get,
    interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } },
  }));
  return { axiosPostMock: post, axiosRequestMock: request, axiosGetMock: get, axiosCreateMock: create };
});

vi.mock("axios", () => ({
  default: {
    create: axiosCreateMock,
    post: axiosPostMock,
    request: axiosRequestMock,
    get: axiosGetMock,
  },
  isAxiosError: (error: any) => Boolean(error?.isAxiosError),
}));

vi.mock("@ptd/downloader/utils.ts", () => ({
  getRemoteTorrentFile: vi.fn(),
  // 与真实实现一致：只识别 magnet，http(s) 直链返回 null（DOWNLOADER-8 的前提）
  extractMagnetHash: vi.fn((url: string) => (/^magnet:/.test(url) ? "magnet-hash" : null)),
}));

vi.mock("@ptd/site/utils/adapter.ts", () => ({
  logMessage: vi.fn(),
}));

import Aria2 from "@ptd/downloader/entity/Aria2.ts";
import Deluge, { clientMetaData as delugeMetaData } from "@ptd/downloader/entity/Deluge.ts";
import { clientMetaData as floodMetaData } from "@ptd/downloader/entity/Flood.ts";
import RuTorrent, { clientMetaData as ruTorrentMetaData } from "@ptd/downloader/entity/ruTorrent.ts";
import SynologyDownloadStation from "@ptd/downloader/entity/synologyDownloadStation.ts";
import Transmission, { clientMetaData as transmissionMetaData } from "@ptd/downloader/entity/Transmission.ts";
import UTorrent, { clientMetaData as uTorrentMetaData } from "@ptd/downloader/entity/uTorrent.ts";

type FakeListener = (event: any) => void;

/** 只实现 Aria2 用到的 WebSocket 表面：addEventListener / removeEventListener / close */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];

  readyState = 0; // CONNECTING
  private listeners = new Map<string, FakeListener[]>();

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: FakeListener) {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, listener: FakeListener) {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((item) => item !== listener),
    );
  }

  send() {
    /* 本用例不发请求 */
  }

  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    for (const listener of this.listeners.get("close") ?? []) {
      listener({ type: "close", target: this });
    }
  }
}

// Aria2 在构造函数里就建立连接，所有用例都必须用假 WebSocket，避免真的去连 127.0.0.1
vi.stubGlobal("WebSocket", FakeWebSocket);

const XML_DECL = '<?xml version="1.0" encoding="UTF-8"?>';

/** 整个方法调用失败：methodResponse 下直接是 fault（HTTP 200） */
function methodFaultXml(): string {
  return (
    XML_DECL +
    "<methodResponse><fault><value><struct>" +
    "<member><name>faultCode</name><value><int>-501</int></value></member>" +
    "<member><name>faultString</name><value><string>Could not find info-hash.</string></value></member>" +
    "</struct></value></fault></methodResponse>"
  );
}

/** system.multicall 单个调用成功的响应（如 d.check_hash 返回 int 0） */
function intResultXml(): string {
  return (
    XML_DECL +
    "<methodResponse><params><param><value><array><data><value><array><data>" +
    "<value><int>0</int></value>" +
    "</data></array></value></data></array></value></param></params></methodResponse>"
  );
}

describe("DOWNLOADER-1：Deluge 文件优先级数值（上游 FILE_PRIORITY：0/1/4/7）", () => {
  function createClient(...responses: any[]) {
    const client = new Deluge({ address: "http://deluge.local:8112/" });
    const requestMock = vi.fn();
    for (const response of responses) {
      requestMock.mockResolvedValueOnce(response);
    }
    (client as any).request = requestMock;
    return { client, requestMock };
  }

  it("回读：0→skip、1/2/3→low、4→normal、5/6/7→high（修复前 7 会被读成 normal）", async () => {
    const { client } = createClient({
      HASH: {
        files: [
          { index: 0, path: "a.mkv", size: 1 },
          { index: 1, path: "b.mkv", size: 1 },
          { index: 2, path: "c.mkv", size: 1 },
          { index: 3, path: "d.mkv", size: 1 },
          { index: 4, path: "e.mkv", size: 1 },
          { index: 5, path: "f.mkv", size: 1 },
          { index: 6, path: "g.mkv", size: 1 },
        ],
        file_progress: [1, 1, 1, 1, 1, 1, 1],
        file_priorities: [0, 1, 2, 3, 4, 5, 7],
      },
    });

    const files = await client.getTorrentFiles("HASH");

    expect(files.map((file) => file.priority)).toEqual(["skip", "low", "low", "low", "normal", "high", "high"]);
    expect(files.map((file) => file.wanted)).toEqual([false, true, true, true, true, true, true]);
  });

  it("下发：skip→0、low→1、normal→4、high→7（修复前 normal=1 实际是 Low、high=2 仍是 Low）", async () => {
    const { client, requestMock } = createClient({ HASH: { file_priorities: [7, 7, 7, 7] } }, true);

    await expect(
      client.setTorrentFilePriority("HASH", [
        { index: 0, priority: "skip" },
        { index: 1, priority: "low" },
        { index: 2, priority: "normal" },
        { index: 3, priority: "high" },
      ]),
    ).resolves.toBe(true);

    expect(requestMock.mock.calls[1]).toEqual(["core.set_torrent_file_priorities", ["HASH", [0, 1, 4, 7]]]);
  });

  it("能力声明：Deluge 没有 Highest 档", () => {
    expect(delugeMetaData.feature.FilePriority.unsupportedPriorities).toEqual(["highest"]);
  });
});

describe("DOWNLOADER-2：各客户端只向 UI 提供真实存在的文件优先级档位", () => {
  it("Flood 只有 Skip/Normal/High：不提供 low/highest", () => {
    expect(floodMetaData.feature.FilePriority.unsupportedPriorities).toEqual(["low", "highest"]);
  });

  it("ruTorrent（f.priority 0..3）不提供 highest", () => {
    expect(ruTorrentMetaData.feature.FilePriority.unsupportedPriorities).toEqual(["highest"]);
  });

  it("uTorrent（0..3）不提供 highest", () => {
    expect(uTorrentMetaData.feature.FilePriority.unsupportedPriorities).toEqual(["highest"]);
  });

  it("Transmission（-1/0/1）不提供 highest", () => {
    expect(transmissionMetaData.feature.FilePriority.unsupportedPriorities).toEqual(["highest"]);
  });
});

describe("DOWNLOADER-4：ruTorrent 各动作校验 httprpc 的真实结果", () => {
  function createClient(response: unknown) {
    const client = new RuTorrent({ address: "http://rt.local/rutorrent", username: "u", password: "p" });
    const requestHttpRpc = vi.fn().mockResolvedValue({ data: response });
    (client as any).requestHttpRpc = requestHttpRpc;
    return { client };
  }

  it("JSON 模式（pause/unpause/remove）返回 false 时判失败（修复前一律 true）", async () => {
    const paused = createClient(false);
    await expect(paused.client.pauseTorrent("HASH")).resolves.toBe(false);

    const resumed = createClient(false);
    await expect(resumed.client.resumeTorrent("HASH")).resolves.toBe(false);

    const removed = createClient(false);
    await expect(removed.client.removeTorrent("HASH", false)).resolves.toBe(false);

    // axios 若把 `false` 当普通文本返回（未解析成 boolean）也要判失败
    const textFalse = createClient("false");
    await expect(textFalse.client.pauseTorrent("HASH")).resolves.toBe(false);
  });

  it("XML-RPC fault（HTTP 200 + fault 报文）判失败：recheck / removeWithData / setTorrentFilePriority", async () => {
    const recheck = createClient(methodFaultXml());
    await expect(recheck.client.recheckTorrent("HASH")).resolves.toBe(false);

    const removeWithData = createClient(methodFaultXml());
    await expect(removeWithData.client.removeTorrent("HASH", true)).resolves.toBe(false);

    const priority = createClient(methodFaultXml());
    await expect(priority.client.setTorrentFilePriority("HASH", [{ index: 0, priority: "high" }])).resolves.toBe(false);
  });

  it("成功响应仍判成功", async () => {
    const xmlOk = createClient(intResultXml());
    await expect(xmlOk.client.recheckTorrent("HASH")).resolves.toBe(true);
    await expect(xmlOk.client.removeTorrent("HASH", true)).resolves.toBe(true);
    await expect(xmlOk.client.setTorrentFilePriority("HASH", [{ index: 0, priority: "high" }])).resolves.toBe(true);

    const jsonOk = createClient(true);
    await expect(jsonOk.client.pauseTorrent("HASH")).resolves.toBe(true);
    await expect(jsonOk.client.resumeTorrent("HASH")).resolves.toBe(true);
    await expect(jsonOk.client.removeTorrent("HASH", false)).resolves.toBe(true);
  });
});

describe("DOWNLOADER-3：不支持的操作返回 false，不再抛异常（调用方 allSettled 会吞掉 rejection）", () => {
  it("Synology：未勾选删除数据时 removeTorrent 返回 false", async () => {
    const client = new SynologyDownloadStation({ address: "http://ds.local:5000", username: "u", password: "p" });
    await expect(client.removeTorrent("dbid-1", false)).resolves.toBe(false);
    await expect(client.removeTorrent("dbid-1", undefined)).resolves.toBe(false);
  });

  it("Aria2：勾选删除数据时 removeTorrent 返回 false", async () => {
    const client = new Aria2({ address: "http://127.0.0.1:6800/jsonrpc", password: "p" });
    await expect(client.removeTorrent("gid-1", true)).resolves.toBe(false);
  });
});

describe("DOWNLOADER-6：Transmission 读取 RPC 的 result（HTTP 200 + 错误串）", () => {
  beforeEach(() => {
    axiosPostMock.mockReset();
  });

  it("result 不是 success 时 request 抛错（修复前 pause/remove 等会 return true）", async () => {
    axiosPostMock.mockResolvedValue({ data: { result: "invalid argument" } });

    const client = new Transmission({ address: "http://tr.local:9091/", username: "u", password: "p" });
    await expect(client.request("torrent-stop", { ids: 1 })).rejects.toThrow(/invalid argument/);
  });

  it("allowResultError 的调用（torrent-add 的 duplicate 语义）仍能拿到原始响应", async () => {
    axiosPostMock.mockImplementation(async (_url: string, body: any) =>
      body?.method === "session-get"
        ? { data: { result: "success", arguments: { version: "2.77", "rpc-version": 14 } } }
        : { data: { result: "duplicate torrent" } },
    );

    const client = new Transmission({ address: "http://tr.local:9091/", username: "u", password: "p" });
    const result = await client.addTorrent("magnet:?xt=urn:btih:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", {
      addAtPaused: false,
    });

    expect(result.success).toBe(true);
  });
});

describe("DOWNLOADER-7：Synology ratio 除零", () => {
  it("size_downloaded=0 时 ratio 为 0，不是 Infinity/NaN", async () => {
    const client = new SynologyDownloadStation({ address: "http://ds.local:5000", username: "u", password: "p" });
    (client as any).requestEntryCGI = vi.fn().mockResolvedValue({
      success: true,
      data: {
        offset: 0,
        total: 1,
        task: [
          {
            id: "dbid-1",
            type: "bt",
            title: "test torrent",
            size: 200,
            status: "seeding",
            additional: {
              detail: {
                completed_time: 1700000000,
                created_time: 1700000000,
                destination: "/volume1/downloads",
                uri: "",
                priority: "auto",
                total_peers: 0,
                connected_seeders: 0,
                connected_leechers: 0,
              },
              transfer: { size_downloaded: 0, size_uploaded: 100, speed_download: 0, speed_upload: 0 },
            },
          },
        ],
      },
    });

    const [torrent] = await client.getAllTorrents();

    expect(torrent.ratio).toBe(0);
    expect(Number.isFinite(torrent.ratio)).toBe(true);
  });
});

describe("DOWNLOADER-8：uTorrent 直发 http 链接时不再静默丢弃后置设置", () => {
  beforeEach(() => {
    axiosPostMock.mockReset();
    axiosPostMock.mockResolvedValue({ data: { build: 1 } });
  });

  it("拿不到 infoHash 时回传 message（种子仍添加成功）", async () => {
    const client = new UTorrent({ address: "http://ut.local:8080/gui/", username: "u", password: "p" });
    (client as any).getSessionId = vi.fn().mockResolvedValue("sid");

    const result = await client.addTorrent("https://tracker.local/download.php?id=1&passkey=secret", {
      localDownload: false,
      addAtPaused: true,
      label: "tv",
      savePath: "",
    });

    expect(result.success).toBe(true);
    expect(result.message).toContain("infoHash");
    // 直发只发一次 add-url，不会再发 setprops（因为根本没有 hash 可定位）
    expect(axiosPostMock).toHaveBeenCalledTimes(1);
    // DOWNLOADER-8 的关键是「种子确实经 add-url 直发出去」，因此断言实际下发的 URL 与参数，
    // 而不是只数调用次数（只数次数的话，把 action/s 写错也照样绿）。
    const [postUrl, , postConfig] = axiosPostMock.mock.calls[0]!;
    expect(postUrl).toBe("http://ut.local:8080/gui/");
    expect(postConfig.params).toMatchObject({
      token: "sid",
      action: "add-url",
      s: "https://tracker.local/download.php?id=1&passkey=secret",
    });
  });

  it("没有需要后置设置的选项时不产生提示", async () => {
    const client = new UTorrent({ address: "http://ut.local:8080/gui/", username: "u", password: "p" });
    (client as any).getSessionId = vi.fn().mockResolvedValue("sid");

    const result = await client.addTorrent("https://tracker.local/download.php?id=1", {
      localDownload: false,
      addAtPaused: false,
      savePath: "",
    });

    expect(result.success).toBe(true);
    expect(result.message).toBeUndefined();
  });
});

describe("DOWNLOADER-5：实例缓存淘汰 / 主动释放会 dispose 长连接", () => {
  /**
   * 包入口 `@ptd/downloader/index.ts` 里的 `downloaderInstanceCache` 是模块级 Map，
   * `FakeWebSocket.instances` 是测试替身上的静态数组：两者都不会被 `beforeEach` 自动复位。
   *
   * 这里每个用例都 `vi.resetModules()` 后重新 import 包入口，保证 LRU 用例永远从「空缓存」开始
   * （否则用例顺序/新增用例都会改变缓存起点，LRU 淘汰的就不再是 dl-0）；
   * static 数组则在 describe 的 beforeEach 里显式清空。断言一律按连接的 ws 地址取 socket，
   * 不按 `instances[0] / instances[16]` 这类创建下标 —— 下标依赖创建顺序，属于时序耦合。
   */
  async function loadDownloaderModule() {
    vi.resetModules();
    return await import("@ptd/downloader/index.ts");
  }

  /** 按 config.address 推导出的 ws 地址定位 socket，避免依赖数组下标 */
  function socketFor(address: string) {
    const wsUrl = address.replace(/^http/, "ws");
    const socket = FakeWebSocket.instances.find((item) => item.url === wsUrl);
    expect(socket, `应为 ${wsUrl} 建立 WebSocket 连接`).toBeTruthy();
    return socket!;
  }

  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });

  it("LRU 淘汰只移除包级缓存引用，不关闭可能仍被 offscreen 持有的实例", async () => {
    const { getDownloader } = await loadDownloaderModule();
    const configs = Array.from({ length: 17 }, (_, index) => ({
      id: `dl-${index}`,
      type: "Aria2",
      name: `dl-${index}`,
      address: `http://127.0.0.1:${6800 + index}/jsonrpc`,
      password: "p",
    }));

    for (const config of configs) {
      await getDownloader(config);
    }

    expect(FakeWebSocket.instances).toHaveLength(17);
    // 被淘汰的是最早创建的 dl-0；它与最新的 dl-16 都必须保持「未关闭」
    expect(socketFor(configs[0]!.address).readyState).not.toBe(3);
    expect(socketFor(configs[16]!.address).readyState).not.toBe(3);
  });

  it("releaseDownloaderInstance 释放连接并从缓存移除，同配置再次获取得到新实例", async () => {
    const { getDownloader, releaseDownloaderInstance } = await loadDownloaderModule();
    const config = { id: "dl-x", type: "Aria2", name: "x", address: "http://127.0.0.1:6900/jsonrpc", password: "p" };

    const first = await getDownloader(config);
    expect(FakeWebSocket.instances).toHaveLength(1);
    const firstSocket = socketFor(config.address);

    releaseDownloaderInstance(first);
    expect(firstSocket.readyState).toBe(3);

    const second = await getDownloader(config);
    expect(second).not.toBe(first);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });
});
