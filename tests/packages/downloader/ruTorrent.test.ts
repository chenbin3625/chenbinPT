/**
 * ruTorrent 实体回归测试。
 *
 * 覆盖四个已确认的缺陷：
 * - B-6：`parseXmlRpcResponse` 只下探到 `methodResponse params param value`，
 *   而 XML-RPC 的 system.multicall 会把每个调用结果再包一层单元素数组，
 *   导致 f/p/t.multicall 解构出的是「包装层」而不是数据行（文件/Peers/Tracker 面板全是垃圾数据）。
 * - B-7：label 与状态消息各错一位（`[15]` 是 peers 数、`[30]` 是 torrent_comment）。
 * - D-6：XML-RPC 请求体不转义 `&`/`<`/`>`，且 setTorrentLabel 硬编码返回 true。
 * - D-7：空闲空间端点重复拼接 `/rutorrent`（baseURL 已包含该前缀）。
 *
 * B-6 的用例使用**真实形状**的响应报文：三层数组嵌套
 * `[ [ [ row1, row2, ... ] ] ]` = multicall 列表 / 单元素包装 / 调用的返回值。
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@ptd/downloader/utils.ts", () => ({
  getRemoteTorrentFile: vi.fn(),
}));

import axios from "axios";
import RuTorrent, { clientMetaData } from "@ptd/downloader/entity/ruTorrent.ts";
import { CTorrentState } from "@ptd/downloader/types.ts";

const XML_DECL = '<?xml version="1.0" encoding="UTF-8"?>';

/** 构造 system.multicall 的真实响应；数字字段按 rTorrent 的实际类型渲染成 <i8> */
function multicallXml(rows: Array<Array<string | number>>): string {
  const rowXml = rows
    .map(
      (fields) =>
        `<value><array><data>${fields
          .map((field) =>
            typeof field === "number" ? `<value><i8>${field}</i8></value>` : `<value><string>${field}</string></value>`,
          )
          .join("")}</data></array></value>`,
    )
    .join("");

  return (
    XML_DECL +
    "<methodResponse><params><param><value><array><data>" + // multicall 的调用结果列表
    "<value><array><data>" + // 单个调用结果的单元素包装（XML-RPC 规范要求）
    `<value><array><data>${rowXml}</data></array></value>` + // 调用的返回值（数据行）
    "</data></array></value>" +
    "</data></array></value></param></params></methodResponse>"
  );
}

/** system.multicall 中「单个调用失败」：该项是含 faultCode/faultString 的 struct */
function multicallFaultXml(): string {
  return (
    XML_DECL +
    "<methodResponse><params><param><value><array><data><value><array><data>" +
    "<value><struct>" +
    "<member><name>faultCode</name><value><int>-501</int></value></member>" +
    "<member><name>faultString</name><value><string>Could not find info-hash.</string></value></member>" +
    "</struct></value>" +
    "</data></array></value></data></array></value></param></params></methodResponse>"
  );
}

/** 整个方法调用失败：methodResponse 下直接是 fault */
function methodFaultXml(): string {
  return (
    XML_DECL +
    "<methodResponse><fault><value><struct>" +
    "<member><name>faultCode</name><value><int>-501</int></value></member>" +
    "<member><name>faultString</name><value><string>Could not find info-hash.</string></value></member>" +
    "</struct></value></fault></methodResponse>"
  );
}

/** 单个调用成功且返回值为 int 0（如 d.custom1.set） */
function intResultXml(): string {
  return (
    XML_DECL +
    "<methodResponse><params><param><value><array><data><value><array><data>" +
    "<value><int>0</int></value>" +
    "</data></array></value></data></array></value></param></params></methodResponse>"
  );
}

function createClient(response: unknown) {
  const client = new RuTorrent({
    address: "http://rt.local/rutorrent",
    username: "u",
    password: "p",
    timeout: 1000,
  });
  const requestHttpRpc = vi.fn().mockResolvedValue({ data: response });
  (client as any).requestHttpRpc = requestHttpRpc;
  return { client, requestHttpRpc };
}

describe("ruTorrent：system.multicall 多剥一层（B-6）", () => {
  it("文件列表解析出真实的行与字段（修复前得到 1 行 path=整行数组、size=NaN）", async () => {
    const { client } = createClient(
      multicallXml([
        ["video/a.mkv", 1073741824, 10, 20, 2],
        ["video/b.srt", 2048, 20, 20, 0],
      ]),
    );

    const files = await client.getTorrentFiles("HASH");

    expect(files).toHaveLength(2);
    expect(files[0]).toMatchObject({
      index: 0,
      name: "a.mkv",
      path: "video/a.mkv",
      size: 1073741824,
      progress: 50,
      priority: "normal",
      wanted: true,
    });
    expect(files[1]).toMatchObject({
      index: 1,
      name: "b.srt",
      path: "video/b.srt",
      size: 2048,
      progress: 100,
      priority: "skip",
      wanted: false,
    });
  });

  it("只有一行数据时不会把数据行连同包装一起剥掉", async () => {
    const { client } = createClient(multicallXml([["only.mkv", 1024, 1, 2, 3]]));

    const files = await client.getTorrentFiles("HASH");

    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ path: "only.mkv", size: 1024, progress: 50, priority: "high" });
  });

  it("空列表 / 单个调用失败（fault）都不会抛异常，也不会伪造数据行", async () => {
    const empty = createClient(multicallXml([]));
    await expect(empty.client.getTorrentFiles("HASH")).resolves.toEqual([]);

    const fault = createClient(multicallFaultXml());
    await expect(fault.client.getTorrentFiles("HASH")).resolves.toEqual([]);
  });

  it("Peers 列表解析出真实字段", async () => {
    const { client } = createClient(multicallXml([["1.2.3.4", 6881, "qBittorrent 4.5.0", 1000, 1024, 2048, 1, 0]]));

    const peers = await client.getTorrentPeers("HASH");

    expect(peers).toHaveLength(1);
    expect(peers[0]).toMatchObject({
      ip: "1.2.3.4",
      port: 6881,
      client: "qBittorrent 4.5.0",
      progress: 100, // p.completed_percent 是千分比
      downloadSpeed: 1024,
      uploadSpeed: 2048,
      incoming: true,
      encrypted: false,
    });
  });

  it("Tracker 列表解析出真实字段", async () => {
    const { client } = createClient(multicallXml([["http://tracker.local/announce", 1, 1, 12, 3, 1700000000, 0]]));

    const trackers = await client.getTorrentTrackersDetail("HASH");

    expect(trackers).toHaveLength(1);
    expect(trackers[0]).toMatchObject({
      url: "http://tracker.local/announce",
      tier: 0,
      status: "working",
      seeds: 12,
      leeches: 3,
      lastAnnounce: 1700000000,
      enabled: true,
    });
  });
});

describe("ruTorrent：恢复动作使用 unpause", () => {
  it("resumeTorrent 不发送不存在的 mode=post", async () => {
    const { client, requestHttpRpc } = createClient(intResultXml());

    await client.resumeTorrent("HASH");

    expect(requestHttpRpc).toHaveBeenCalledWith(expect.any(URLSearchParams));
    const body = requestHttpRpc.mock.calls[0][0] as URLSearchParams;
    expect(body.get("mode")).toBe("unpause");
  });
});

describe("ruTorrent：单种限速（H-4）", () => {
  it("rTorrent 没有单种限速命令：能力声明为不支持，且不再发出不存在的 d.set_upload_limit", async () => {
    const { client, requestHttpRpc } = createClient(intResultXml());

    expect(clientMetaData.feature.SpeedLimit.allowed).toBe(false);
    await expect(client.setTorrentSpeedLimit("hash", { upload: 1024, download: 128 })).resolves.toBe(false);
    expect(requestHttpRpc).not.toHaveBeenCalled();
  });
});

describe("ruTorrent：label / 状态消息下标（B-7）", () => {
  /** 34 项元组，下标含义见 ruTorrent.ts 的 torrentData 声明 */
  function makeRawTorrent(overrides: Record<number, string> = {}): string[] {
    const raw = new Array<string>(34).fill("0");
    raw[0] = "1"; // is_open
    raw[3] = "1"; // get_state
    raw[4] = "My Torrent"; // torrent_name
    raw[5] = "1024"; // torrent_size
    raw[6] = "5"; // get_completed_chunks
    raw[7] = "10"; // get_size_chunks
    raw[14] = "movies%20%26%20tv"; // torrent_label（d.custom1）
    raw[15] = "7"; // peers_actual（修复前被当成 label）
    raw[25] = "/downloads/My Torrent"; // base_path
    raw[28] = "1"; // is_active
    raw[29] = ""; // torrent_msg（d.get_message）
    // 刻意留空：早先这里默认填 "Tracker: [Tried all trackers.]"（恰好是判定用的白名单哨兵），
    // 于是「误把 [30] 当消息」的回归在多数用例里不会暴露（因为哨兵本身判为良性）。
    // 需要哨兵的用例请自己显式覆盖 [30]。
    raw[30] = ""; // torrent_comment（d.get_custom2）
    Object.assign(raw, overrides);
    return raw;
  }

  function listResponse(raw: string[], infoHash = "ABCDEF") {
    return { t: { [infoHash]: raw }, cid: 1 };
  }

  it("label 取 torrent_label[14]（修复前取 [15] 得到 peer 数 7）", async () => {
    const { client } = createClient(listResponse(makeRawTorrent()));

    const [torrent] = await client.getAllTorrents();

    expect(torrent.label).toBe("movies & tv");
    expect(torrent.label).not.toBe("7");
    expect(torrent.state).toBe(CTorrentState.downloading);
  });

  it("label 含裸 `%` 时退回原文而不是抛错", async () => {
    const { client } = createClient(listResponse(makeRawTorrent({ 14: "100%" })));

    const [torrent] = await client.getAllTorrents();

    expect(torrent.label).toBe("100%");
  });

  it("错误态取 d.message / [29]（rTorrent 把 tracker 消息放在这里）", async () => {
    // is_open=0 且未在哈希校验中，才会走到「按消息判错误态」分支。
    // 上游依据：rTorrent `src/core/download.cc:59-64` 的 `receive_tracker_msg()` 写
    // `m_message = "Tracker: [" + msg + "]"`，而 `m_message` 就是 `d.get_message`（元组 [29]）。
    const errorTorrent = makeRawTorrent({
      0: "0",
      29: "Tracker: [Failure reason: unregistered torrent]",
      30: "Tracker: [Tried all trackers.]",
    });
    const { client } = createClient(listResponse(errorTorrent));

    const [torrent] = await client.getAllTorrents();
    expect(torrent.state).toBe(CTorrentState.error);
  });

  it("[30] 是 d.custom2(Comment)，**不得**参与错误态判定（反回归）", async () => {
    // 这条守的是一个曾经真实出现过的回归：曾把判定写成 `[29] || [30]`，理由是「ruTorrent 把
    // tracker 消息写进 custom2」——但该前提与上游实现相反：
    //   - ruTorrent `js/rtorrent.js:1390,1399` 自己就用 `values[29]`（torrent.msg）判 error，
    //     且其哨兵串与这里逐字节相同；
    //   - `[30]` = `d.get_custom2` = Comment（`index.html` 的 `#cmt`="Comment" ← `d.comment`），
    //     而且 ruTorrent 发种时会把种子文件里的 comment 写进 custom2（`php/rtorrent.php:352`）。
    // 于是「回退到 [30]」会让**任何带 comment 的已停止种子**被误判为 error。
    const stoppedWithComment = makeRawTorrent({
      0: "0",
      29: "", // d.message 为空
      30: "VRS24mrker" + encodeURIComponent("My release comment"), // d.custom2
    });
    const { client } = createClient(listResponse(stoppedWithComment));

    const [torrent] = await client.getAllTorrents();
    expect(torrent.state).not.toBe(CTorrentState.error);
  });

  it("d.message 为已知的良性提示时不判为错误态", async () => {
    const okTorrent = makeRawTorrent({ 0: "0", 29: "Tracker: [Tried all trackers.]" });
    const { client } = createClient(listResponse(okTorrent));

    const [torrent] = await client.getAllTorrents();
    expect(torrent.state).toBe(CTorrentState.unknown);
  });

  it("ratio 取 d.get_ratio 并归一到倍数（rTorrent 返回千分比，未除会放大 1000 倍）", async () => {
    // 上游：rTorrent 的 d.get_ratio = (1000 * upTotal) / bytesDone；ruTorrent 自己的 UI 也按 /1000 显示。
    // 同仓先例：uTorrent.ts 的 `ratio: torrent[7] / 1000`。
    const { client } = createClient(listResponse(makeRawTorrent({ 10: "1500" }))); // 千分比 1500 = 1.5

    const [torrent] = await client.getAllTorrents();
    expect(torrent.ratio).toBeCloseTo(1.5, 10);
    expect(torrent.ratio, "绝不能把千分比当倍数（1.5 不应显示成 1500）").not.toBe(1500);
  });

  it("ratio 为 0 时归零，不产生 NaN/Infinity", async () => {
    const { client } = createClient(listResponse(makeRawTorrent({ 10: "0" })));

    const [torrent] = await client.getAllTorrents();
    expect(torrent.ratio).toBe(0);
    expect(Number.isFinite(torrent.ratio)).toBe(true);
  });

  it("d.message 为空且 Comment 也为空时不判为错误态", async () => {
    const emptyMsg = makeRawTorrent({ 0: "0", 29: "", 30: "" });
    const { client } = createClient(listResponse(emptyMsg));

    const [torrent] = await client.getAllTorrents();
    expect(torrent.state).toBe(CTorrentState.unknown);
  });
});

describe("ruTorrent：XML 转义与真实返回值（D-6）", () => {
  it("system.multicall 请求体会转义 & < >（修复前会产生 XML 解析 fault，操作静默无效）", async () => {
    const { client, requestHttpRpc } = createClient(intResultXml());

    await client.setTorrentLabel("HASH", "A&B <C>");

    const xml = requestHttpRpc.mock.calls[0][0] as string;
    expect(xml).toContain("<string>A&amp;B &lt;C&gt;</string>");
    expect(xml).not.toContain("A&B <C>");
    // 结构本身不受影响
    expect(xml).toContain("<methodName>system.multicall</methodName>");
    expect(xml).toContain("<member><name>methodName</name><value><string>d.custom1.set</string></value></member>");
  });

  it("批量文件优先级的请求体同样转义", async () => {
    const { client, requestHttpRpc } = createClient(intResultXml());

    await client.setTorrentFilePriority("ha&sh", [{ index: 0, priority: "skip" }]);

    const xml = requestHttpRpc.mock.calls[0][0] as string;
    expect(xml).toContain("<string>HA&amp;SH:f0</string>");
    expect(xml).not.toContain("HA&SH");
  });

  it("setTorrentLabel 返回真实结果：fault → false，成功 → true", async () => {
    const fault = createClient(methodFaultXml());
    await expect(fault.client.setTorrentLabel("HASH", "tv")).resolves.toBe(false);

    const ok = createClient(intResultXml());
    await expect(ok.client.setTorrentLabel("HASH", "tv")).resolves.toBe(true);
  });
});

describe("ruTorrent：空闲空间端点（D-7）", () => {
  it("不再重复拼接 /rutorrent（修复前是 /rutorrent/rutorrent/plugins/... 404）", async () => {
    const client = new RuTorrent({ address: "http://rt.local/rutorrent", username: "u", password: "p" });
    const requestMock = vi.fn().mockResolvedValue({ data: { total: 100, free: 42 } });
    (client as any).request = requestMock;

    await expect(client.getClientFreeSpace()).resolves.toBe(42);

    const [config] = requestMock.mock.calls[0];
    expect(config.url).toBe("/plugins/diskspace/action.php");

    // baseURL 已包含 /rutorrent，拼出的最终 URL 中该前缀只应出现一次
    expect(axios.getUri({ baseURL: (client as any).config.address, url: config.url })).toBe(
      "http://rt.local/rutorrent/plugins/diskspace/action.php",
    );
    expect(
      axios.getUri({ baseURL: (client as any).config.address, url: "/rutorrent/plugins/diskspace/action.php" }),
    ).toBe(
      "http://rt.local/rutorrent/rutorrent/plugins/diskspace/action.php", // 修复前的确切值
    );
  });
});
