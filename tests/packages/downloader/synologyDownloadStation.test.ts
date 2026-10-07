/**
 * Synology Download Station 进度单位回归测试。
 *
 * `download / task.size` 得到的是 0..1，而 CTorrent.progress 的约定是 0-100。
 * 修复前 100% 的种子会显示成 1%，且 task.size 为 0 时会得到 Infinity/NaN。
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@ptd/downloader/utils.ts", () => ({
  getRemoteTorrentFile: vi.fn(),
}));

import SynologyDownloadStation from "@ptd/downloader/entity/synologyDownloadStation.ts";

function makeRawTask(overrides: Record<string, any> = {}) {
  return {
    id: "dbid-1",
    type: "bt",
    title: "test torrent",
    size: 200,
    status: "downloading",
    additional: {
      detail: {
        completed_time: 0,
        created_time: 1700000000,
        destination: "/volume1/downloads",
        uri: "",
        priority: "auto",
        total_peers: 0,
        connected_seeders: 0,
        connected_leechers: 0,
      },
      transfer: {
        size_downloaded: 100,
        size_uploaded: 50,
        speed_download: 1024,
        speed_upload: 512,
      },
    },
    ...overrides,
  };
}

async function getAllTorrentsWith(tasks: any[]) {
  const client = new SynologyDownloadStation({ address: "http://dsm.local:5000/" });
  (client as any).requestEntryCGI = vi.fn().mockResolvedValue({
    success: true,
    data: { offset: 0, total: tasks.length, task: tasks },
  });
  return await client.getAllTorrents();
}

describe("Synology Download Station：progress 换算成 0-100", () => {
  it("已下载 100 / 总大小 200 → 50%", async () => {
    const [torrent] = await getAllTorrentsWith([makeRawTask()]);

    expect(torrent.progress).toBe(50);
    expect(torrent.isCompleted).toBe(false);
  });

  it("task.size 为 0 时 progress 为 0（不产生 Infinity/NaN）", async () => {
    const [torrent] = await getAllTorrentsWith([makeRawTask({ id: "dbid-2", size: 0 })]);

    expect(torrent.progress).toBe(0);
    expect(Number.isFinite(torrent.progress)).toBe(true);
  });
});

/**
 * 覆盖 `login` / `ping` / `requestEntryCGI` 的会话处理：
 * - D-4：`_sessionId` 此前永久缓存，会话过期（105/106）后整个实例生命周期持续故障；
 *   `getTorrentsBy` 也直接访问 `req.data.task`，不看 `success`。
 * - D-8：登录此前用 `params` 且未指定 method → axios 发 GET，账号密码进入 URL query。
 */
function createSessionClient() {
  return new SynologyDownloadStation({ address: "http://dsm.local:5000/", username: "u", password: "p@ss" });
}

/** 按 cgi 分派的 request 替身：记录每次请求的配置，便于断言 _sid 与登录方式 */
function mockRequests(options: { failFirstEntryWith?: number } = {}) {
  const authPasswords: string[] = [];
  const entrySids: string[] = [];
  let entryAttempts = 0;

  const requestMock = vi.fn().mockImplementation(async (cgi: string, config: any) => {
    if (cgi === "query.cgi") {
      return { success: true, data: { "SYNO.API.Auth": { maxVersion: 6, minVersion: 1, path: "auth.cgi" } } };
    }
    if (cgi === "auth.cgi") {
      authPasswords.push(String((config.data as URLSearchParams).get("passwd")));
      return { success: true, data: { sid: `sid-${authPasswords.length}` } };
    }

    entryAttempts++;
    entrySids.push(String((config.data as URLSearchParams).get("_sid")));
    if (entryAttempts === 1 && options.failFirstEntryWith) {
      return { success: false, error: { code: options.failFirstEntryWith } };
    }
    return { success: true, data: { offset: 0, total: 1, task: [makeRawTask()] } };
  });

  return { requestMock, authPasswords, entrySids };
}

describe("Synology Download Station：会话过期自愈（D-4）", () => {
  it.each([105, 106])("错误码 %i：清空 _sessionId、重登并重试一次", async (code) => {
    const client = createSessionClient();
    const { requestMock, authPasswords, entrySids } = mockRequests({ failFirstEntryWith: code });
    (client as any).request = requestMock;

    const torrents = await client.getAllTorrents();

    expect(torrents).toHaveLength(1);
    expect(authPasswords).toHaveLength(2); // 首次登录 + 会话失效后重登
    expect(entrySids).toEqual(["sid-1", "sid-2"]); // 修复前会一直复用 sid-1
    expect((client as any)._sessionId).toBe("sid-2");
  });

  it("其它错误码抛出可读错误且不重登（修复前是 Cannot read properties of undefined）", async () => {
    const client = createSessionClient();
    const { requestMock, authPasswords } = mockRequests({ failFirstEntryWith: 101 });
    (client as any).request = requestMock;

    await expect(client.getAllTorrents()).rejects.toThrow(/\(101\)/);
    expect(authPasswords).toHaveLength(1);
  });

  it("重登后仍失败时抛出，不无限重试", async () => {
    const client = createSessionClient();
    const requestMock = vi.fn().mockImplementation(async (cgi: string) => {
      if (cgi === "query.cgi") {
        return { success: true, data: { "SYNO.API.Auth": { maxVersion: 6, minVersion: 1, path: "auth.cgi" } } };
      }
      if (cgi === "auth.cgi") {
        return { success: true, data: { sid: "sid-x" } };
      }
      return { success: false, error: { code: 105 } };
    });
    (client as any).request = requestMock;

    await expect(client.getAllTorrents()).rejects.toThrow(/\(105\)/);
    expect(requestMock.mock.calls.filter(([cgi]) => cgi === "auth.cgi")).toHaveLength(2);
    expect(requestMock.mock.calls.filter(([cgi]) => cgi === "entry.cgi")).toHaveLength(2);
  });

  it("ping 会丢弃缓存的 sid 并重新登录", async () => {
    const client = createSessionClient();
    const { requestMock, authPasswords, entrySids } = mockRequests();
    (client as any).request = requestMock;
    (client as any)._sessionId = "stale-sid";

    await expect(client.ping()).resolves.toBe(true);

    expect(authPasswords).toHaveLength(1);
    expect(entrySids).toHaveLength(0);
    expect((client as any)._sessionId).toBe("sid-1");
  });
});

describe("Synology Download Station：登录使用 POST（D-8）", () => {
  it("账号密码放在 POST body，而不是 URL query", async () => {
    const client = createSessionClient();
    const { requestMock } = mockRequests();
    (client as any).request = requestMock;

    await expect(client.ping()).resolves.toBe(true);

    const authCall = requestMock.mock.calls.find(([cgi]) => cgi === "auth.cgi");
    expect(authCall).toBeDefined();

    const [, config] = authCall!;
    // 修复前：{ params: {...} } 且没有 method → axios 发 GET，凭据进入 URL
    expect(config.method).toBe("post");
    expect(config.params).toBeUndefined();
    expect(config.data).toBeInstanceOf(URLSearchParams);
    expect(config.data.get("api")).toBe("SYNO.API.Auth");
    expect(config.data.get("method")).toBe("login");
    expect(config.data.get("account")).toBe("u");
    expect(config.data.get("passwd")).toBe("p@ss");
  });

  it("登录失败时不留存旧 sid", async () => {
    const client = createSessionClient();
    const requestMock = vi.fn().mockImplementation(async (cgi: string) => {
      if (cgi === "query.cgi") {
        return { success: true, data: { "SYNO.API.Auth": { maxVersion: 6, minVersion: 1, path: "auth.cgi" } } };
      }
      return { success: false, error: { code: 400 } };
    });
    (client as any).request = requestMock;
    (client as any)._sessionId = "stale-sid";

    await expect(client.ping()).resolves.toBe(false);
    expect((client as any)._sessionId).toBeUndefined();
  });
});

describe("Synology Download Station 删除参数", () => {
  it("无法只删除任务时，未勾选删数据不得调用可能删除文件的接口（DOWNLOADER-3：返回 false 而非抛异常）", async () => {
    const client = new SynologyDownloadStation({ address: "http://dsm.local:5000/" });
    const request = vi.fn();
    (client as any).requestEntryCGI = request;

    await expect(client.removeTorrent("task-1", false)).resolves.toBe(false);
    expect(request).not.toHaveBeenCalled();
  });

  it("明确勾选删除数据时可以删除任务与文件", async () => {
    const client = new SynologyDownloadStation({ address: "http://dsm.local:5000/" });
    const request = vi.fn(async () => ({ success: true }));
    (client as any).requestEntryCGI = request;

    await expect(client.removeTorrent("task-1", true)).resolves.toBe(true);
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ method: "delete", id: "task-1" }));
  });
});
