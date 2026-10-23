/**
 * uTorrent 进度单位回归测试。
 *
 * µTorrent Web API 的 PROGRESS 是千分比（integer in per mils），
 * 而 CTorrent.progress 的约定是 0-100（见 src/packages/downloader/types.ts）。
 * 修复前用的是 `torrent[4] / 100`（得到 0-10），界面会把 100% 显示成 10%。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const axiosMock = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
}));

vi.mock("@ptd/downloader/utils.ts", () => ({
  getRemoteTorrentFile: vi.fn(),
  extractMagnetHash: vi.fn(),
  sanitizeDownloadUrlForLog: vi.fn((url: string) => String(url)),
}));
vi.mock("@ptd/site/utils/adapter.ts", () => ({
  logMessage: vi.fn(),
}));
vi.mock("axios", () => ({ default: axiosMock }));

import UTorrent from "@ptd/downloader/entity/uTorrent.ts";

function makeTorrentTuple(overrides: Record<number, any> = {}) {
  const torrent: any[] = [];
  torrent[0] = "AABBCCDDEEFF00112233445566778899AABBCCDD";
  torrent[1] = 1; // STATE_STARTED
  torrent[2] = "test torrent";
  torrent[3] = 1000; // SIZE
  torrent[4] = 500; // PROGRESS (per mils)
  torrent[5] = 400; // DOWNLOADED
  torrent[6] = 100; // UPLOADED
  torrent[7] = 1000; // RATIO (per mils)
  torrent[8] = 10; // UPSPEED
  torrent[9] = 20; // DOWNSPEED
  torrent[11] = "label";
  torrent[23] = 1700000000; // DATE_ADDED
  torrent[26] = "/downloads";
  for (const [index, value] of Object.entries(overrides)) {
    torrent[Number(index)] = value;
  }
  return torrent;
}

async function getAllTorrentsWith(torrents: any[]) {
  const client = new UTorrent({ address: "http://127.0.0.1:8080/gui/" });
  (client as any).request = vi.fn().mockResolvedValue({ torrents });
  return await client.getAllTorrents();
}

describe("uTorrent：progress 千分比换算成 0-100", () => {
  it("500‰ → 50，未完成时状态为 downloading", async () => {
    const [torrent] = await getAllTorrentsWith([makeTorrentTuple()]);

    expect(torrent.progress).toBe(50);
    expect(torrent.isCompleted).toBe(false);
    expect(torrent.state).toBe("downloading");
  });

  it("1000‰ → 100，完成后状态为 seeding", async () => {
    const [torrent] = await getAllTorrentsWith([makeTorrentTuple({ 4: 1000 })]);

    expect(torrent.progress).toBe(100);
    expect(torrent.isCompleted).toBe(true);
    expect(torrent.state).toBe("seeding");
  });
});

describe("uTorrent：认证与删除默认值", () => {
  it("通用请求携带 Basic Auth 与 credentials", async () => {
    const client = new UTorrent({
      address: "http://127.0.0.1:8080/gui/",
      username: "admin",
      password: "secret",
    });
    (client as any)._sid = "sid";
    axiosMock.get.mockResolvedValue({ data: { build: "1" } });

    await client.request("getsettings");

    expect(axiosMock.get).toHaveBeenCalledWith(
      "http://127.0.0.1:8080/gui/",
      expect.objectContaining({
        auth: { username: "admin", password: "secret" },
        withCredentials: true,
      }),
    );
  });

  it("直接调用 removeTorrent 默认只移除任务，不删除数据", async () => {
    const client = new UTorrent({ address: "http://127.0.0.1:8080/gui/" });
    (client as any).request = vi.fn().mockResolvedValue({ build: "1" });

    await client.removeTorrent("hash");

    expect((client as any).request).toHaveBeenCalledWith("removetorrent", { hash: "hash" });
  });
});

/** C1 修复轮回归：UT-1/UT-2/UT-3/N-2 */
describe("uTorrent：C1 修复轮", () => {
  beforeEach(() => {
    axiosMock.get.mockReset();
    axiosMock.post.mockReset();
  });

  it("UT-1：token 失效（HTTP 400）时重新取 token 并重试一次", async () => {
    let tokenCalls = 0;
    let businessCalls = 0;
    axiosMock.get.mockImplementation(async (url: string) => {
      if (url === "/token.html") {
        tokenCalls++;
        return { data: `<div id="token">TOKEN-${tokenCalls}</div>` };
      }
      businessCalls++;
      if (businessCalls === 1) {
        throw Object.assign(new Error("invalid request"), { response: { status: 400 } });
      }
      return { data: { build: 1 } };
    });

    const client = new UTorrent({ address: "http://127.0.0.1:8080/gui/", username: "u", password: "p" });
    await expect(client.request("getsettings")).resolves.toMatchObject({ build: 1 });

    expect(tokenCalls).toBe(2); // 首次取 token + 失效后重取
    expect(businessCalls).toBe(2); // 首次失败 + 重试
  });

  it("UT-2：响应体带 error 时 addTorrent 判失败，而不是无条件成功", async () => {
    axiosMock.post.mockResolvedValue({ data: { build: 1, error: "invalid request" } });
    const client = new UTorrent({ address: "http://127.0.0.1:8080/gui/" });
    (client as any).getSessionId = vi.fn().mockResolvedValue("sid");

    const result = await client.addTorrent("magnet:?xt=urn:btih:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", {
      addAtPaused: false,
    });

    expect(result.success).toBe(false);
    expect(String(result.message)).toContain("invalid request");
  });

  it("UT-2：添加成功但后置设置失败时 success 仍为 true，并回传 warning message", async () => {
    axiosMock.post.mockResolvedValue({ data: { build: 1 } });
    axiosMock.get.mockImplementation(async (url: string) => {
      if (url === "/token.html") {
        return { data: `<div id="token">TOKEN</div>` };
      }
      throw Object.assign(new Error("pause failed"), { response: { status: 500 } });
    });
    const utils = await import("@ptd/downloader/utils.ts");
    vi.mocked(utils.getRemoteTorrentFile); // 保持 mock 状态
    const client = new UTorrent({ address: "http://127.0.0.1:8080/gui/" });
    (client as any)._sid = "sid";

    const result = await client.addTorrent("magnet:?xt=urn:btih:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", {
      addAtPaused: true,
    });

    expect(result.success).toBe(true);
    expect(String(result.message)).toContain("暂停");
  });

  it("UT-3：状态位按 ERROR → CHECKING → PAUSED → STARTED 的优先级判断", async () => {
    // status=17 = STARTED(1) | ERROR(16)，以前会被判成 downloading
    const [errorTorrent] = await getAllTorrentsWith([makeTorrentTuple({ 1: 17 })]);
    expect(errorTorrent.state).toBe("error");

    // status=3 = STARTED(1) | CHECKING(2)，以前会被判成 downloading
    const [checkingTorrent] = await getAllTorrentsWith([makeTorrentTuple({ 1: 3 })]);
    expect(checkingTorrent.state).toBe("checking");
  });

  it("N-2：主机名含 gui 时仍补 /gui/，不会拼成 //", () => {
    expect(new UTorrent({ address: "http://gui.local:8080/" }).address).toBe("http://gui.local:8080/gui/");
    expect(new UTorrent({ address: "http://host.local:8080/gui" }).address).toBe("http://host.local:8080/gui/");
    expect(new UTorrent({ address: "http://host.local:8080/gui/" }).address).toBe("http://host.local:8080/gui/");
  });
});

/**
 * 复检 RB-2：uTorrent 对**失败的操作**返回 HTTP 200 + `{ build, error }`。
 * `request()` 统一把 `error` 抛错后，操作型方法必须返回 false（而不是假成功）。
 */
describe("uTorrent：操作接口在 HTTP 200 + {error} 时返回 false", () => {
  function makeClientWithErrorResponse(error = "invalid request") {
    const client = new UTorrent({ address: "http://127.0.0.1:8080/gui/", username: "u", password: "p" });
    (client as any)._sid = "sid";
    axiosMock.get.mockResolvedValue({ data: { build: 1, error } });
    // 让 getTorrentTrackersDetail 等读取路径也走同一响应，避免真实网络请求
    return client;
  }

  beforeEach(() => {
    axiosMock.get.mockReset();
    axiosMock.post.mockReset();
  });

  it("request() 在响应体带 error 时抛错", async () => {
    const client = makeClientWithErrorResponse();
    await expect(client.request("getsettings")).rejects.toThrow(/invalid request/);
  });

  it("pause/resume/remove/recheck/move/limit/label/file-priority/tracker 均返回 false", async () => {
    const client = makeClientWithErrorResponse();

    await expect(client.pauseTorrent("HASH")).resolves.toBe(false);
    await expect(client.resumeTorrent("HASH")).resolves.toBe(false);
    await expect(client.removeTorrent("HASH")).resolves.toBe(false);
    await expect(client.recheckTorrent("HASH")).resolves.toBe(false);
    await expect(client.moveTorrentInQueue("HASH", "top")).resolves.toBe(false);
    await expect(client.setTorrentSpeedLimit("HASH", { download: 1, upload: 1 })).resolves.toBe(false);
    await expect(client.setTorrentLabel("HASH", "label")).resolves.toBe(false);
    await expect(
      client.setTorrentFilePriority("HASH", [{ index: 0, priority: "skip" as any, wanted: false } as any]),
    ).resolves.toBe(false);
    await expect(client.addTorrentTracker("HASH", "http://tracker.example/announce")).resolves.toBe(false);
    await expect(client.removeTorrentTracker("HASH", "http://tracker.example/announce")).resolves.toBe(false);
  });

  it("错误响应下 addTorrent 仍自行判读 error（不被 request() 的抛出路径影响）", async () => {
    const client = new UTorrent({ address: "http://127.0.0.1:8080/gui/" });
    (client as any).getSessionId = vi.fn().mockResolvedValue("sid");
    axiosMock.post.mockResolvedValue({ data: { build: 1, error: "invalid request" } });

    const result = await client.addTorrent("magnet:?xt=urn:btih:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", {});
    expect(result.success).toBe(false);
    expect(String(result.message)).toContain("invalid request");
  });
});

/**
 * 复检 P2（I）：`ping()` 必须走 token 单飞（getSessionId），不能在并发登录时另起一次 /token.html。
 */
describe("uTorrent：ping 走 token 单飞", () => {
  beforeEach(() => {
    axiosMock.get.mockReset();
    axiosMock.post.mockReset();
  });

  it("成功后返回 true，且只请求一次 /token.html", async () => {
    axiosMock.get.mockResolvedValue({ data: `<div id="token">TOKEN</div>` });
    const client = new UTorrent({ address: "http://127.0.0.1:8080/gui/", username: "u", password: "p" });

    await expect(client.ping()).resolves.toBe(true);
    expect(axiosMock.get).toHaveBeenCalledTimes(1);
    expect(axiosMock.get.mock.calls[0]![0]).toBe("/token.html");
    // 强制重取：不残留旧 token
    expect((client as any)._sid).toBe("TOKEN");
  });

  it("token 获取失败时返回 false（不抛错）", async () => {
    axiosMock.get.mockRejectedValue(Object.assign(new Error("unauthorized"), { response: { status: 401 } }));
    const client = new UTorrent({ address: "http://127.0.0.1:8080/gui/", username: "u", password: "p" });

    await expect(client.ping()).resolves.toBe(false);
  });
});
