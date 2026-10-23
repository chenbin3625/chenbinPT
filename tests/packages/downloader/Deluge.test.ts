/**
 * Deluge 实体回归测试。
 *
 * 1. 标签：core.add_torrent_url / core.add_torrent_file 返回的是新种子的 hash 字符串（失败时为 null），
 *    不是数组。修复前取 `result[0][1]` 恒为 undefined，label.set_torrent 必然失败，
 *    表现为「种子添加成功但标签没生效」。
 * 2. 错误处理（D-2）：deluge-web 用 HTTP 200 + 响应体里的 `error` 字段报错
 *    （develop 分支为 `{ message, code }`，code 1 = Not authenticated），
 *    修复前只看 `result`，会把失败当成成功（`result` 为 null 时调用方 `Object.values(null)` 直接 TypeError），
 *    会话失效也不会重新登录。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@ptd/downloader/utils.ts", () => ({
  getRemoteTorrentFile: vi.fn(),
  sanitizeDownloadUrlForLog: vi.fn((url: string) => String(url)),
}));

vi.mock("@ptd/site/utils/adapter.ts", () => ({
  logMessage: vi.fn(),
}));

const { postMock, createMock } = vi.hoisted(() => {
  const post = vi.fn();
  return { postMock: post, createMock: vi.fn(() => ({ post })) };
});

vi.mock("axios", () => ({
  default: { create: createMock },
}));

import Deluge from "@ptd/downloader/entity/Deluge.ts";

function createClient(...responses: any[]) {
  const client = new Deluge({ address: "http://localhost:8112/" });
  const requestMock = vi.fn();
  for (const response of responses) {
    requestMock.mockResolvedValueOnce(response);
  }
  (client as any).request = requestMock;
  return { client, requestMock };
}

const MAGNET = "magnet:?xt=urn:btih:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

describe("Deluge RPC 地址", () => {
  it("主机名含 json 时仍补上路径，同时保留自定义 json 路径", () => {
    expect((new Deluge({ address: "https://json.example.com/" }) as any).address).toBe("https://json.example.com/json");
    expect((new Deluge({ address: "https://host.example/custom/json" }) as any).address).toBe(
      "https://host.example/custom/json",
    );
  });

  it("非法地址不会让构造函数抛 TypeError（复检：对齐 uTorrent N-2）", () => {
    expect(() => new Deluge({ address: "not a valid url" })).not.toThrow();
  });
});

/** P1-8：防止「登录单飞自死锁」的用例都加超时，避免测试进程挂死 */
function withTimeout<T>(promise: Promise<T>, ms = 1_000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timeout ${ms}ms (deadlock?)`)), ms)),
  ]);
}

describe("Deluge：用返回的 torrent hash 设置标签", () => {
  it("hash 是字符串时正确设置标签", async () => {
    const { client, requestMock } = createClient("HASH-1", {});

    const result = await client.addTorrent(MAGNET, { label: "tv", addAtPaused: false });

    expect(result.success).toBe(true);
    expect(requestMock).toHaveBeenNthCalledWith(2, "label.set_torrent", ["HASH-1", "tv"]);
  });

  it("兼容 [hash] 与 [[torrent_id, hash]] 形式的返回值", async () => {
    const arrayForm = createClient(["HASH-2"], {});
    await arrayForm.client.addTorrent(MAGNET, { label: "movies", addAtPaused: false });
    expect(arrayForm.requestMock).toHaveBeenNthCalledWith(2, "label.set_torrent", ["HASH-2", "movies"]);

    const legacyForm = createClient([["torrent_id", "HASH-3"]], {});
    await legacyForm.client.addTorrent(MAGNET, { label: "anime", addAtPaused: false });
    expect(legacyForm.requestMock).toHaveBeenNthCalledWith(2, "label.set_torrent", ["HASH-3", "anime"]);
  });

  it("未传 label 时不调用 label.set_torrent；添加失败时 success=false", async () => {
    const withoutLabel = createClient("HASH-4");
    await expect(withoutLabel.client.addTorrent(MAGNET, { addAtPaused: false })).resolves.toMatchObject({
      success: true,
    });
    expect(withoutLabel.requestMock).toHaveBeenCalledTimes(1);

    const failed = createClient(null);
    await expect(failed.client.addTorrent(MAGNET, { label: "tv", addAtPaused: false })).resolves.toMatchObject({
      success: false,
    });
    expect(failed.requestMock).toHaveBeenCalledTimes(1);
  });
});

/** 会话 cookie 失效时 deluge-web 的响应（HTTP 200） */
function notAuthenticated() {
  return { data: { id: 2, error: { code: 1, message: "Not authenticated" }, result: null } };
}

const STATUS_RESULT = { download_rate: 1, upload_rate: 2, total_download: 3, total_upload: 4 };

describe("Deluge：HTTP 200 + error 字段（D-2）", () => {
  beforeEach(() => {
    postMock.mockReset();
    createMock.mockClear();
  });

  function createSessionClient() {
    return new Deluge({ address: "http://deluge.local:8112/", password: "pw" });
  }

  it("error 存在时抛错（修复前把 null result 当成成功 / TypeError）", async () => {
    const client = createSessionClient();
    postMock
      .mockResolvedValueOnce({ data: { id: 1, error: null, result: true } }) // auth.login
      .mockResolvedValueOnce({ data: { id: 2, error: { code: 3, message: "TypeError: boom" }, result: null } });

    await expect(client.getClientStatus()).rejects.toThrow(/Deluge: TypeError: boom/);
    expect(postMock).toHaveBeenCalledTimes(2); // 非认证错误不重试
  });

  it("Not authenticated（code 1）时重新登录并重试一次", async () => {
    const client = createSessionClient();
    postMock
      .mockResolvedValueOnce({ data: { id: 1, error: null, result: true } }) // auth.login
      .mockResolvedValueOnce(notAuthenticated()) // 会话已失效
      .mockResolvedValueOnce({ data: { id: 3, error: null, result: true } }) // 重登
      .mockResolvedValueOnce({ data: { id: 4, error: null, result: STATUS_RESULT } }); // 重试成功

    await expect(client.getClientStatus()).resolves.toMatchObject({ dlSpeed: 1, upSpeed: 2, dlData: 3, upData: 4 });
    expect(postMock).toHaveBeenCalledTimes(4);

    // 请求体是 JSON-RPC 结构，且打到规范化后的 /json 地址
    const [url, body] = postMock.mock.calls[1];
    expect(url).toBe("http://deluge.local:8112/json");
    expect(body).toMatchObject({ method: "core.get_session_status", params: [expect.any(Array)] });
  });

  it("兼容旧版把 error 写成字符串的响应", async () => {
    const client = createSessionClient();
    postMock
      .mockResolvedValueOnce({ data: { id: 1, error: null, result: true } })
      .mockResolvedValueOnce({ data: { id: 2, error: "Not authenticated", result: null } })
      .mockResolvedValueOnce({ data: { id: 3, error: null, result: true } })
      .mockResolvedValueOnce({ data: { id: 4, error: null, result: STATUS_RESULT } });

    await expect(client.getClientStatus()).resolves.toMatchObject({ dlSpeed: 1, upSpeed: 2 });
    expect(postMock).toHaveBeenCalledTimes(4);
  });

  it("重试仍失败时抛出（不无限重登）", async () => {
    const client = createSessionClient();
    postMock
      .mockResolvedValueOnce({ data: { id: 1, error: null, result: true } })
      .mockResolvedValueOnce(notAuthenticated())
      .mockResolvedValueOnce({ data: { id: 3, error: null, result: true } })
      .mockResolvedValueOnce(notAuthenticated());

    await expect(client.getClientStatus()).rejects.toThrow(/Not authenticated/);
    expect(postMock).toHaveBeenCalledTimes(4);
  });

  it("会话 axios 实例开启 withCredentials（_session_id 是 Cookie）", () => {
    createSessionClient();
    expect(createMock).toHaveBeenCalledWith({ withCredentials: true });
  });

  /**
   * P1-8（复检）：deluge-web 被反向代理/魔改后，可能对 `auth.login` 本身也回 code 1。
   * 修复前 login() 内的 request("auth.login") 会走「notAuthenticated → ensureLogin(true)」分支，
   * 而复用到的 loginPromise 正是等待 login() 完成的那个 → 自死锁，后续所有请求永久挂起。
   */
  it("P1-8：auth.login 自身返回 Not authenticated 时不自死锁（ping 快速返回 false）", async () => {
    const client = createSessionClient();
    postMock.mockResolvedValue(notAuthenticated());

    await expect(withTimeout(client.ping())).resolves.toBe(false);
    // 只发一次 auth.login：不得因 notAuthenticated 触发重登递归
    expect(postMock).toHaveBeenCalledTimes(1);
  });

  it("P1-8：登录失败时业务请求快速抛错（不死锁、不无限重试）", async () => {
    const client = createSessionClient();
    postMock.mockResolvedValue(notAuthenticated());

    await expect(withTimeout(client.getClientStatus())).rejects.toThrow(/Not authenticated|登录失败/);
    expect(postMock).toHaveBeenCalledTimes(1);
  });
});

/** C1 修复轮回归：DE-1/DE-2/DE-3/DE-4/DE-6/N-1/N-4/PKG-1/SEC-1 */
describe("Deluge：C1 修复轮", () => {
  function newClient() {
    return new Deluge({ address: "http://deluge.local:8112/", password: "pw" });
  }

  it("DE-1：RPC 成功但 result 为 null（Deluge 常见）时操作返回 true", async () => {
    const client: any = newClient();
    client.request = vi.fn().mockResolvedValue(null);

    await expect(client.pauseTorrent("H")).resolves.toBe(true);
    await expect(client.resumeTorrent("H")).resolves.toBe(true);
    await expect(client.recheckTorrent("H")).resolves.toBe(true);
    await expect(client.setTorrentSpeedLimit("H", { upload: 100 })).resolves.toBe(true);
    await expect(client.setTorrentLabel("H", "tv")).resolves.toBe(true);
  });

  it("N-1：force_recheck 传 List[str]（[[id]]），而不是单字符串", async () => {
    const client: any = newClient();
    client.request = vi.fn().mockResolvedValue(null);

    await client.recheckTorrent("ABCDEF");
    expect(client.request).toHaveBeenCalledWith("core.force_recheck", [["ABCDEF"]]);
  });

  it("DE-2：磁链使用 core.add_torrent_magnet，http 直链仍用 add_torrent_url", async () => {
    const client: any = newClient();
    client.request = vi.fn().mockResolvedValue("HASH-1");

    await client.addTorrent("magnet:?xt=urn:btih:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", { addAtPaused: false });
    expect(client.request.mock.calls[0][0]).toBe("core.add_torrent_magnet");
    expect(client.request.mock.calls[0][1][0]).toContain("magnet:");

    client.request.mockClear();
    await client.addTorrent("https://pt.example/download.php?id=1", { addAtPaused: false, localDownload: false });
    expect(client.request.mock.calls[0][0]).toBe("core.add_torrent_url");
  });

  it("DE-3：列表请求带上速度/流量字段", async () => {
    const client: any = newClient();
    client.request = vi.fn().mockResolvedValue({
      H: {
        hash: "H",
        name: "t",
        progress: 10,
        ratio: 0,
        time_added: 1,
        save_path: "/d",
        state: "Downloading",
        total_size: 1,
      },
    });

    const [torrent] = await client.getTorrentsBy({});
    const fields = client.request.mock.calls[0][1][1] as string[];
    for (const field of ["upload_payload_rate", "download_payload_rate", "total_uploaded", "total_done"]) {
      expect(fields).toContain(field);
    }
    expect(torrent.uploadSpeed).toBeUndefined(); // 响应里没有该字段时不再编造数据
  });

  it("DE-4：ping 检查 web.connected，断开时尝试 web.get_hosts/web.connect", async () => {
    const client: any = newClient();
    const methods: string[] = [];
    let connectedChecks = 0;
    client.sessionedAxios.post = async (_url: string, body: any) => {
      methods.push(body.method);
      if (body.method === "auth.login") {
        return { data: { id: 1, error: null, result: true } };
      }
      if (body.method === "web.connected") {
        connectedChecks++;
        return { data: { id: 2, error: null, result: connectedChecks > 1 } };
      }
      if (body.method === "web.get_hosts") {
        return { data: { id: 3, error: null, result: [["host-1", "127.0.0.1", 58846, "localclient"]] } };
      }
      if (body.method === "web.connect") {
        return { data: { id: 4, error: null, result: [] } };
      }
      return { data: { id: 5, error: null, result: null } };
    };

    await expect(client.ping()).resolves.toBe(true);
    expect(methods).toEqual(["auth.login", "web.connected", "web.get_hosts", "web.connect", "web.connected"]);
  });

  it("DE-6：complete 过滤本地按进度，且 Allocating/Moving 不再 unknown", async () => {
    const client: any = newClient();
    const torrent = (overrides: Record<string, any>) => ({
      hash: "H",
      name: "t",
      progress: 0,
      ratio: 0,
      time_added: 1,
      save_path: "/d",
      state: "Paused",
      total_size: 1,
      upload_payload_rate: 0,
      download_payload_rate: 0,
      total_uploaded: 0,
      total_done: 0,
      ...overrides,
    });
    client.request = vi.fn().mockResolvedValue({
      A: torrent({ hash: "A", progress: 100, state: "Paused" }),
      B: torrent({ hash: "B", progress: 50, state: "Allocating" }),
      C: torrent({ hash: "C", progress: 0, state: "Moving" }),
    });

    const all = await client.getTorrentsBy({});
    expect(all.map((t: any) => t.state)).toEqual(["paused", "queued", "checking"]);

    const completed = await client.getTorrentsBy({ complete: true });
    expect(completed.map((t: any) => t.id)).toEqual(["A"]);
  });

  it("N-4：getTorrentsBy 不改写入参 filter 对象", async () => {
    const client: any = newClient();
    client.request = vi.fn().mockResolvedValue({});
    const filter = { ids: "HASH", complete: true };

    await client.getTorrentsBy(filter as any);

    expect(filter).toEqual({ ids: "HASH", complete: true });
  });

  it("PKG-1：并发首请求共享同一次 auth.login", async () => {
    const client: any = newClient();
    let authLoginCount = 0;
    client.sessionedAxios.post = async (_url: string, body: any) => {
      if (body.method === "auth.login") {
        authLoginCount++;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { data: { id: 1, error: null, result: true } };
      }
      return {
        data: {
          id: 2,
          error: null,
          result: { download_rate: 1, upload_rate: 2, total_download: 3, total_upload: 4 },
        },
      };
    };

    await Promise.all([client.getClientStatus(), client.getClientStatus(), client.getClientStatus()]);
    expect(authLoginCount).toBe(1);
  });

  it("SEC-1：添加失败日志里的 URL 已脱敏（不含 passkey）", async () => {
    const { logMessage } = await import("@ptd/site/utils/adapter.ts");
    const { sanitizeDownloadUrlForLog } = await import("@ptd/downloader/utils.ts");
    vi.mocked(sanitizeDownloadUrlForLog).mockImplementation((url: any) => String(url).split("?")[0]);
    const client: any = newClient();
    client.request = vi.fn().mockRejectedValue(new Error("offline"));
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
