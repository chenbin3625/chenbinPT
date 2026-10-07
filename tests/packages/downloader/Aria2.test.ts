/**
 * Aria2 实体回归测试。
 *
 * 覆盖四个已确认的缺陷：
 * 1. addTorrent 设置上传限速时把整个 jsonRPCResponse 当成 GID 传给 aria2.changeOption；
 * 2. getAllTorrents 直接 `task[0].forEach` 解包 system.multicall，遇到 JSON-RPC 的
 *    `{ result: [...] }` 或 fault / 空项会抛 TypeError，导致整个任务列表失败；
 * 3. parseRawTorrent 未把 0..1 的完成度换算成 CTorrent 约定的 0-100 百分比；
 * 4. 构造后不等连接 OPEN 就 send()（CONNECTING 时规范要求抛 InvalidStateError），
 *    且连接关闭后不再重连（send() 被静默丢弃，请求只能挂到超时）。
 *
 * 测试直接用假的 WebSocket 走完整的 methodSend 流程（发送 → 按 msgId 回包），
 * 不联网、不 mock 被测类内部方法。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@ptd/downloader/utils.ts", () => ({
  getRemoteTorrentFile: vi.fn(),
}));

vi.mock("@ptd/site/utils/adapter.ts", () => ({
  logMessage: vi.fn(),
}));

import Aria2 from "@ptd/downloader/entity/Aria2.ts";

type FakeListener = (event: any) => void;

/** 只实现 Aria2 用到的 WebSocket 表面：addEventListener / removeEventListener / send / close */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];

  readonly url: string;
  readonly sent: string[] = [];
  readyState = 0; // CONNECTING
  private listeners = new Map<string, FakeListener[]>();

  constructor(url: string) {
    this.url = url;
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

  /**
   * readyState 与 send() 的语义按规范实现：
   * - CONNECTING(0) 时抛 InvalidStateError；
   * - CLOSING(2)/CLOSED(3) 时静默丢弃（正是「请求挂到超时」的成因）。
   */
  send(data: string) {
    if (this.readyState === 0) {
      throw new Error("InvalidStateError: still in CONNECTING state");
    }
    if (this.readyState !== 1) {
      return;
    }
    this.sent.push(data);
  }

  close() {
    if (this.readyState === 3) {
      return;
    }
    this.readyState = 3;
    this.emit("close");
  }

  /** 模拟握手完成 */
  open() {
    this.readyState = 1;
    this.emit("open");
  }

  /** 只补发一次 close 事件（用于验证旧连接的迟到事件不影响新连接） */
  emitCloseAgain() {
    this.emit("close");
  }

  /** 模拟 ws 收到一条消息 */
  respond(data: any) {
    this.emit("message", { data: JSON.stringify(data) });
  }

  private emit(type: string, extra: Record<string, any> = {}) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ type, target: this, ...extra });
    }
  }
}

function lastSocket(): FakeWebSocket {
  return FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
}

async function createClient(timeout = 5000) {
  const client = new Aria2({ address: "http://127.0.0.1:6800/jsonrpc", password: "secret", timeout });
  const ws = lastSocket();
  ws.open(); // 模拟浏览器完成握手；「未 open 就请求」的场景见 D-1 用例
  return { client, ws };
}

/** 等待第 count 条请求发出，并解析出请求体 */
async function waitForRequest(ws: FakeWebSocket, count: number): Promise<any> {
  await vi.waitFor(() => expect(ws.sent.length).toBeGreaterThanOrEqual(count));
  return JSON.parse(ws.sent[count - 1]);
}

function makeRawTask(overrides: Record<string, any> = {}) {
  return {
    gid: "gid-1",
    status: "active",
    totalLength: "1000",
    completedLength: "500",
    uploadLength: "250",
    downloadSpeed: "1024",
    uploadSpeed: "512",
    dir: "/downloads",
    infoHash: "aabbccddeeff00112233445566778899aabbccdd",
    bittorrent: { info: { name: "test torrent" } },
    ...overrides,
  };
}

describe("Aria2：system.multicall 解包 / 进度单位 / 上传限速 GID", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });

  it("addTorrent 用 result 里的 GID 设置上传限速（而不是整个 jsonRPCResponse）", async () => {
    const { client, ws } = await createClient();

    const promise = client.addTorrent("magnet:?xt=urn:btih:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", {
      uploadSpeedLimit: 100,
    });

    const addRequest = await waitForRequest(ws, 1);
    expect(addRequest.method).toBe("aria2.addUri");
    expect(addRequest.params[0]).toBe("token:secret");

    // 回包：整个响应对象会 resolve 给 methodSend，真正的 GID 在 result 中
    ws.respond({ id: addRequest.id, jsonrpc: "2.0", result: "gid-abc" });

    const changeRequest = await waitForRequest(ws, 2);
    expect(changeRequest.method).toBe("aria2.changeOption");
    expect(changeRequest.params[1]).toBe("gid-abc"); // 修复前这里是 { id, jsonrpc, result }
    expect(changeRequest.params[2]).toEqual({ "max-upload-limit": "102400K" });

    ws.respond({ id: changeRequest.id, jsonrpc: "2.0", result: "OK" });
    await expect(promise).resolves.toMatchObject({ success: true });
  });

  it("getAllTorrents 兼容 JSON-RPC 的 { result: [...] } 形状", async () => {
    const { client, ws } = await createClient();

    const promise = client.getAllTorrents();
    const request = await waitForRequest(ws, 1);
    expect(request.method).toBe("system.multicall");

    ws.respond({
      id: request.id,
      jsonrpc: "2.0",
      result: [
        { result: [makeRawTask({ gid: "g-active" })] },
        { result: [makeRawTask({ gid: "g-waiting", status: "waiting" })] },
        { result: [] },
      ],
    });

    const torrents = await promise;
    expect(torrents.map((t) => t.id)).toEqual(["g-active", "g-waiting"]);
  });

  it("getAllTorrents 兼容 XML-RPC 风格的 [result] 形状", async () => {
    const { client, ws } = await createClient();

    const promise = client.getAllTorrents();
    const request = await waitForRequest(ws, 1);

    const active = makeRawTask({ gid: "g-active" });
    const stopped = makeRawTask({ gid: "g-stopped", status: "complete" });

    ws.respond({
      id: request.id,
      jsonrpc: "2.0",
      result: [[[active]], [[makeRawTask({ gid: "g-waiting", status: "waiting" })]], [[stopped]]],
    });

    const torrents = await promise;
    expect(torrents.map((t) => t.id)).toEqual(["g-active", "g-waiting", "g-stopped"]);
  });

  it("getAllTorrents 对 fault / null / 非 BitTorrent 项不抛异常（修复前是 TypeError）", async () => {
    const { client, ws } = await createClient();

    const promise = client.getAllTorrents();
    const request = await waitForRequest(ws, 1);

    ws.respond({
      id: request.id,
      jsonrpc: "2.0",
      result: [null, undefined, { faultCode: 1, faultString: "failed" }, { result: [{ gid: "g-http" }] }],
    });

    await expect(promise).resolves.toEqual([]);
  });

  it("getAllTorrents 容忍多余的单元素数组包装（{ result: [[task]] }）", async () => {
    const { client, ws } = await createClient();

    const promise = client.getAllTorrents();
    const request = await waitForRequest(ws, 1);

    ws.respond({
      id: request.id,
      jsonrpc: "2.0",
      result: [{ result: [[makeRawTask({ gid: "g-nested" })]] }],
    });

    const torrents = await promise;
    expect(torrents.map((t) => t.id)).toEqual(["g-nested"]);
  });

  it("parseRawTorrent 把 completedLength / totalLength 换算成 0-100，并对 totalLength=0 防御", async () => {
    const { client, ws } = await createClient();

    const promise = client.getAllTorrents();
    const request = await waitForRequest(ws, 1);

    ws.respond({
      id: request.id,
      jsonrpc: "2.0",
      result: [
        {
          result: [
            makeRawTask({ gid: "g-half", status: "active", completedLength: "500", totalLength: "1000" }),
            makeRawTask({ gid: "g-done", status: "active", completedLength: "1000", totalLength: "1000" }),
            makeRawTask({ gid: "g-meta", status: "active", completedLength: "0", totalLength: "0" }),
          ],
        },
      ],
    });

    const [half, done, meta] = await promise;

    expect(half.progress).toBe(50);
    expect(half.isCompleted).toBe(false);
    expect(half.state).toBe("downloading");

    expect(done.progress).toBe(100);
    expect(done.isCompleted).toBe(true);
    expect(done.state).toBe("seeding");

    expect(meta.progress).toBe(0);
    expect(meta.isCompleted).toBe(false);
    expect(Number.isFinite(meta.progress)).toBe(true);
  });
});

describe("Aria2 删除任务按状态分流（H-4）", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });

  it("已完成（complete）的任务只清下载结果，不调用对它必然报错的 aria2.remove", async () => {
    const { client, ws } = await createClient();
    const promise = client.removeTorrent("gid-done");

    const status = await waitForRequest(ws, 1);
    expect(status.method).toBe("aria2.tellStatus");
    ws.respond({ id: status.id, jsonrpc: "2.0", result: { status: "complete" } });

    const cleanup = await waitForRequest(ws, 2);
    expect(cleanup.method).toBe("aria2.removeDownloadResult");
    ws.respond({ id: cleanup.id, jsonrpc: "2.0", result: "OK" });

    await expect(promise).resolves.toBe(true);
    expect(ws.sent.map((raw) => JSON.parse(raw).method)).not.toContain("aria2.remove");
  });

  it("活动任务先 aria2.remove；随后的 removeDownloadResult 报 not found 不影响结果", async () => {
    const { client, ws } = await createClient();
    const promise = client.removeTorrent("gid-active");

    const status = await waitForRequest(ws, 1);
    ws.respond({ id: status.id, jsonrpc: "2.0", result: { status: "active" } });

    const remove = await waitForRequest(ws, 2);
    expect(remove.method).toBe("aria2.remove");
    ws.respond({ id: remove.id, jsonrpc: "2.0", result: "gid-active" });

    const cleanup = await waitForRequest(ws, 3);
    expect(cleanup.method).toBe("aria2.removeDownloadResult");
    ws.respond({ id: cleanup.id, jsonrpc: "2.0", error: { code: 1, message: "GID gid-active is not found" } });

    await expect(promise).resolves.toBe(true);
  });
});

describe("Aria2 删除文件参数", () => {
  it("API 不支持删文件时明确返回失败，而不是假报成功（DOWNLOADER-3：抛异常会被调用方 allSettled 吞掉）", async () => {
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const { client, ws } = await createClient();

    await expect(client.removeTorrent("gid-1", true)).resolves.toBe(false);
    expect(ws.sent).toHaveLength(0);
  });
});

describe("Aria2：连接状态自愈（D-1）", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });

  it("首个请求会等到连接 open 后再发送（修复前 CONNECTING 时 send 抛 InvalidStateError → ping 必失败）", async () => {
    const client = new Aria2({ address: "http://127.0.0.1:6800/jsonrpc", password: "secret", timeout: 5000 });
    const ws = lastSocket();
    expect(ws.readyState).toBe(0); // CONNECTING

    const promise = client.ping();
    // 没 open 之前不允许发送（假 socket 在 CONNECTING 时 send 会抛错）
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ws.sent).toHaveLength(0);

    ws.open();
    const request = await waitForRequest(ws, 1);
    expect(request.method).toBe("aria2.getVersion");

    ws.respond({ id: request.id, jsonrpc: "2.0", result: { version: "1.36.0", enabledFeatures: [] } });
    // 修复前：send 抛 InvalidStateError → ping 吞掉异常返回 false
    await expect(promise).resolves.toBe(true);
  });

  it("连接关闭后下一次请求会重建连接（修复前 send 被静默丢弃，请求挂到超时）", async () => {
    const { client, ws } = await createClient(300);

    ws.close(); // 模拟服务端/网络断开
    expect(ws.readyState).toBe(3);

    const promise = client.getClientStatus();

    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    const newWs = lastSocket();
    newWs.open();

    const request = await waitForRequest(newWs, 1);
    expect(request.method).toBe("aria2.getGlobalStat");
    newWs.respond({ id: request.id, jsonrpc: "2.0", result: { downloadSpeed: "2048", uploadSpeed: "1024" } });

    await expect(promise).resolves.toMatchObject({ dlSpeed: 2048, upSpeed: 1024 });
  });

  it("旧连接的迟到 close 事件不会打断新连接上的在途请求", async () => {
    const { client, ws } = await createClient(300);

    ws.close();
    const promise = client.getClientStatus();

    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    const newWs = lastSocket();
    newWs.open();

    const request = await waitForRequest(newWs, 1);
    ws.emitCloseAgain(); // 旧 socket 的 close 事件晚到

    newWs.respond({ id: request.id, jsonrpc: "2.0", result: { downloadSpeed: "1", uploadSpeed: "2" } });
    await expect(promise).resolves.toMatchObject({ dlSpeed: 1, upSpeed: 2 });
  });

  it("dispose 后的请求直接失败；dispose 会释放连接并清空待响应请求", async () => {
    const { client, ws } = await createClient(300);

    const inFlight = client.getClientStatus();
    const request = await waitForRequest(ws, 1);

    client.dispose();
    await expect(inFlight).rejects.toThrow(/disconnected/);
    expect(ws.readyState).toBe(3);

    // 迟到的响应不应再有影响
    ws.respond({ id: request.id, jsonrpc: "2.0", result: { downloadSpeed: "1", uploadSpeed: "2" } });
    await expect(client.getClientStatus()).rejects.toThrow(/disposed/);
  });

  it("握手永不完成时按 timeout 失败，不能永久挂起（反回归：超时必须覆盖建连阶段）", async () => {
    // 场景：半开 TCP（VPN 掉线 / 防火墙丢包）。WebSocket 既不 open 也不 close/error，
    // 只 await 连接就绪会让调用方**永久挂起**（UI 一直 loading）。
    // 修复前实测：timeout=60ms 时 400ms 后仍 pending，且定时器先 reject 的 responsePromise
    // 无人 await → 产生 unhandled rejection。
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);

    try {
      const client = new Aria2({ address: "http://127.0.0.1:6800/jsonrpc", password: "secret", timeout: 60 });
      const ws = lastSocket();
      expect(ws.readyState).toBe(0); // 一直停在 CONNECTING，不调 ws.open()

      await expect(client.ping()).resolves.toBe(false); // ping 吞掉异常 → false
      expect(ws.sent).toHaveLength(0); // 从未发出请求

      // 给潜在的 unhandled rejection 一点时间冒出来
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("成功路径会清理建连超时定时器（反回归：删掉 clearTimeout 不应再无人发现）", async () => {
    // 这条守的是一个真实的覆盖缺口：把 `methodSend` 成功分支里的
    // `clearTimeout(connectTimer)` 删掉后，本文件其余 12 条用例**全部照旧通过**——
    // 也就是说「每次成功请求都泄漏一个 5s 定时器」这种退化没有任何防线。
    vi.useFakeTimers();
    try {
      const client = new Aria2({ address: "http://127.0.0.1:6800/jsonrpc", password: "secret", timeout: 5000 });
      const ws = lastSocket();
      ws.open();

      const promise = client.ping();
      await vi.advanceTimersByTimeAsync(0);

      const request = JSON.parse(ws.sent[0]);
      ws.respond({ id: request.id, jsonrpc: "2.0", result: { version: "1.36.0", enabledFeatures: [] } });
      await vi.advanceTimersByTimeAsync(0);
      await expect(promise).resolves.toBe(true);

      // 建连超时定时器与请求超时定时器都必须已被清理
      expect(vi.getTimerCount(), "成功请求后不应残留任何定时器").toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("握手永不完成时 getClientStatus 会以超时错误拒绝（而不是一直 pending）", async () => {
    const client = new Aria2({ address: "http://127.0.0.1:6800/jsonrpc", password: "secret", timeout: 80 });
    lastSocket(); // 停在 CONNECTING

    const startedAt = Date.now();
    await expect(client.getClientStatus()).rejects.toThrow(/timeout/);
    // 必须在 timeout 量级内失败（而不是等 OS 的 TCP 超时）
    expect(Date.now() - startedAt).toBeLessThan(2000);
  });
});
