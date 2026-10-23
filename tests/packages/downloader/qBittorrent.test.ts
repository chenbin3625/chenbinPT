/**
 * qBittorrent 实体回归测试。
 *
 * 覆盖两个已确认的缺陷：
 * - B-4：单种下载限速打到不存在的 `/torrents/setLimit`（qBittorrent WebAPI 只有
 *   `setDownloadLimit` / `setUploadLimit`），导致 404 与「上传成功、下载失败」的半配置状态。
 * - D-3：SID 超时（默认 3600s）后每个请求都 401，而 `isLogin` 一旦成功就再不复位、
 *   实例又被长期缓存，因此无法自愈；修复后应在 401/403 时复位登录态、重新登录并重试一次。
 *
 * 这里替换的是 `@ptd/downloader/utils` 导出的 axios 实例（模块级 mock），
 * 不 mock 被测类自身的 request/login。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { axiosMock } = vi.hoisted(() => ({
  axiosMock: {
    request: vi.fn(),
    post: vi.fn(),
  },
}));

vi.mock("@ptd/downloader/utils.ts", () => ({
  axios: axiosMock,
  getRemoteTorrentFile: vi.fn(),
}));

import QBittorrent from "@ptd/downloader/entity/qBittorrent.ts";

function createClient(options: Record<string, any> = {}) {
  return new QBittorrent({
    address: "http://qbt.local:8080/",
    username: "admin",
    password: "pw",
    timeout: 1000,
    ...options,
  });
}

function unauthorized() {
  return Object.assign(new Error("Unauthorized"), { response: { status: 401 } });
}

describe("qBittorrent：下载限速端点（B-4）", () => {
  beforeEach(() => {
    axiosMock.request.mockReset();
    axiosMock.post.mockReset();
    axiosMock.post.mockResolvedValue({ data: "Ok.", status: 200 }); // /auth/login
    axiosMock.request.mockResolvedValue({ data: "Ok.", status: 200 });
  });

  it("下载限速打到 /torrents/setDownloadLimit（修复前是不存在的 /torrents/setLimit）", async () => {
    const client = createClient();

    await expect(client.setTorrentSpeedLimit("HASH-A", { download: 300, upload: 100 })).resolves.toBe(true);

    const urls = axiosMock.request.mock.calls.map(([config]) => config.url);
    expect(urls).toEqual(["/api/v2/torrents/setDownloadLimit", "/api/v2/torrents/setUploadLimit"]);
    expect(urls).not.toContain("/api/v2/torrents/setLimit");

    // 单位换算：KiB/s → bytes/s，0 表示不限速（-1）
    expect(axiosMock.request.mock.calls[0][0].data).toEqual({ hashes: "HASH-A", limit: 300 * 1024 });
    expect(axiosMock.request.mock.calls[1][0].data).toEqual({ hashes: "HASH-A", limit: 100 * 1024 });
  });

  it("限速为 0 时发送 -1（不限速）", async () => {
    const client = createClient();

    await client.setTorrentSpeedLimit("HASH-B", { download: 0 });

    expect(axiosMock.request.mock.calls[0][0].data).toEqual({ hashes: "HASH-B", limit: -1 });
  });
});

describe("qBittorrent：SID 过期自愈（D-3）", () => {
  beforeEach(() => {
    axiosMock.request.mockReset();
    axiosMock.post.mockReset();
    axiosMock.post.mockResolvedValue({ data: "Ok.", status: 200 }); // /auth/login
  });

  it("401 时复位登录态、重新登录并重试一次", async () => {
    const client = createClient();

    let attempts = 0;
    axiosMock.request.mockImplementation(async (config: any) => {
      attempts++;
      if (attempts === 1) {
        throw unauthorized();
      }
      return { data: config.url };
    });

    const version = await (client as any).getClientVersionFromRemote();

    // /app/version（401）→ 重登 → 重试 /app/version → /app/webapiVersion
    expect(attempts).toBe(3);
    // 第一次是首次请求前的登录，第二次是 401 之后的重登（不能再多）
    expect(axiosMock.post).toHaveBeenCalledTimes(2);
    expect(client.isLogin).toBe(true);
    expect(version).toBe("/api/v2/app/version (/api/v2/app/webapiVersion)");
  });

  it("403（部分版本用 403 表示未认证）同样触发重登重试", async () => {
    const client = createClient();

    let attempts = 0;
    axiosMock.request.mockImplementation(async (config: any) => {
      attempts++;
      if (attempts === 1) {
        throw Object.assign(new Error("Forbidden"), { response: { status: 403 } });
      }
      return { data: config.url };
    });

    await (client as any).getClientVersionFromRemote();

    expect(axiosMock.post).toHaveBeenCalledTimes(2);
  });

  it("重登后仍 401 时只重试一次，不无限递归", async () => {
    const client = createClient();
    axiosMock.request.mockRejectedValue(unauthorized());

    await expect((client as any).getClientVersionFromRemote()).rejects.toThrow(/Unauthorized/);
    // 首次登录 + 一次重登（若无限递归，post/request 次数会随之增长）
    expect(axiosMock.post).toHaveBeenCalledTimes(2);
    expect(axiosMock.request).toHaveBeenCalledTimes(2);
    // 登录态被复位为「未登录」（null），下一次请求会重新走登录流程
    expect(client.isLogin).toBeNull();
  });

  it("API Key 认证不依赖 SID，遇到 401 不重登", async () => {
    const client = createClient({ username: "", password: "qbt_apikey" });
    axiosMock.request.mockRejectedValue(unauthorized());

    await expect((client as any).getClientVersionFromRemote()).rejects.toThrow(/Unauthorized/);
    expect(axiosMock.post).not.toHaveBeenCalled();
  });
});

describe("qBittorrent：用户名密码请求必须携带 Cookie", () => {
  it("登录后的业务请求带 withCredentials", async () => {
    const client = createClient();
    axiosMock.request.mockResolvedValue({ data: "1.0.0" });

    await (client as any).getClientVersionFromRemote();

    expect(axiosMock.request.mock.calls[0][0].withCredentials).toBe(true);
  });
});

describe("qBittorrent ≥5.2：/torrents/add 的 JSON 响应（M-27）", () => {
  beforeEach(() => {
    axiosMock.request.mockReset();
    axiosMock.post.mockReset();
    axiosMock.post.mockResolvedValue({ data: "Ok.", status: 200 });
  });

  it("链接直发返回 202 + pending_count>0（已异步入队）时判成功，而不是 failed", async () => {
    axiosMock.request.mockResolvedValue({
      status: 202,
      data: { success_count: 0, pending_count: 1, failure_count: 0, added_torrent_ids: [] },
    });
    const client = createClient();

    const result = await client.addTorrent("https://pt.example/download.php?id=1", { localDownload: false });
    expect(result.success).toBe(true);
  });

  it("有 failure_count 时仍判失败", async () => {
    axiosMock.request.mockResolvedValue({
      status: 200,
      data: { success_count: 0, pending_count: 1, failure_count: 1, added_torrent_ids: [] },
    });
    const client = createClient();

    const result = await client.addTorrent("https://pt.example/download.php?id=1", { localDownload: false });
    expect(result.success).toBe(false);
  });

  it("什么都没接受（全 0）时判失败", async () => {
    axiosMock.request.mockResolvedValue({
      status: 200,
      data: { success_count: 0, pending_count: 0, failure_count: 0, added_torrent_ids: [] },
    });
    const client = createClient();

    const result = await client.addTorrent("https://pt.example/download.php?id=1", { localDownload: false });
    expect(result.success).toBe(false);
  });
});

describe("qBittorrent：sync/maindata 缓存一致性（M-2 / L-3）", () => {
  beforeEach(() => {
    axiosMock.request.mockReset();
    axiosMock.post.mockReset();
  });

  const rawTorrent = (state: string) => ({
    name: "Torrent",
    hash: "HASH",
    magnet_uri: "",
    added_on: 0,
    size: 100,
    progress: state === "pausedDL" ? 0.5 : 1,
    dlspeed: 0,
    upspeed: 0,
    priority: 0,
    num_seeds: 0,
    num_complete: 0,
    num_leechs: 0,
    num_incomplete: 0,
    ratio: 1,
    eta: 0,
    state,
    seq_dl: false,
    f_l_piece_prio: false,
    completion_on: 0,
    tracker: "",
    dl_limit: -1,
    up_limit: -1,
    downloaded: 0,
    uploaded: 0,
    downloaded_session: 0,
    uploaded_session: 0,
    amount_left: 0,
    save_path: "/downloads",
    completed: 0,
    max_ratio: -1,
    max_seeding_time: -1,
    ratio_limit: -1,
    seeding_time_limit: -1,
    seen_complete: 0,
    last_activity: 0,
    total_size: 100,
    time_active: 0,
    category: "",
  });

  it("pause/remove/resume 等写操作完成后立即刷新列表，不复用 15 秒内的旧快照", async () => {
    const client = createClient({ username: "", password: "qbt_api_key" });
    (client as any).webApiVersion = "2.10";

    let syncCalls = 0;
    axiosMock.request.mockImplementation(async (config: any) => {
      if (config.url.endsWith("/sync/maindata")) {
        syncCalls++;
        return {
          data:
            syncCalls === 1
              ? { rid: 1, full_update: true, torrents: { HASH: rawTorrent("uploading") } }
              : { rid: 2, full_update: true, torrents: { HASH: rawTorrent("pausedDL") } },
        };
      }
      return { data: "Ok." };
    });

    const before = await client.getAllTorrents();
    expect(before[0].state).toBe("seeding");

    await client.pauseTorrent("HASH");
    const after = await client.getAllTorrents();

    expect(syncCalls).toBe(2);
    expect(after[0].state).toBe("paused");
  });

  it("增量同步的 tags 是新增标签，应做并集而不是按数组下标 merge", async () => {
    const client = createClient({ username: "", password: "qbt_api_key" });
    const responses = [
      { rid: 1, full_update: true, tags: ["a", "b", "c"] },
      { rid: 2, tags: ["d"] },
    ];
    axiosMock.request.mockImplementation(async (config: any) => {
      if (config.url.endsWith("/sync/maindata")) {
        return { data: responses.shift() };
      }
      return { data: "Ok." };
    });

    expect((await (client as any).getSyncData(true)).tags).toEqual(["a", "b", "c"]);
    (client as any).lastSyncTimestamp = 0;

    expect((await (client as any).getSyncData()).tags).toEqual(["a", "b", "c", "d"]);
  });
});

/** C1 修复轮回归：QB-1 / QB-2 / QB-3 / QB-4 / QB-5 / N-5 */
describe("qBittorrent：C1 修复轮", () => {
  const rawTorrent = (state: string, overrides: Record<string, any> = {}) => ({
    name: "Torrent",
    hash: "HASH",
    magnet_uri: "",
    added_on: 0,
    size: 100,
    progress: 1,
    dlspeed: 0,
    upspeed: 0,
    priority: 0,
    num_seeds: 0,
    num_complete: 0,
    num_leechs: 0,
    num_incomplete: 0,
    ratio: 1,
    eta: 0,
    state,
    seq_dl: false,
    f_l_piece_prio: false,
    completion_on: 0,
    tracker: "",
    dl_limit: -1,
    up_limit: -1,
    downloaded: 0,
    uploaded: 0,
    downloaded_session: 0,
    uploaded_session: 0,
    amount_left: 0,
    save_path: "/downloads",
    completed: 0,
    max_ratio: -1,
    max_seeding_time: -1,
    ratio_limit: -1,
    seeding_time_limit: -1,
    seen_complete: 0,
    last_activity: 0,
    total_size: 100,
    time_active: 0,
    category: "",
    tags: "",
    ...overrides,
  });

  const apiKeyClient = () => createClient({ username: "", password: "qbt_api_key" });

  beforeEach(() => {
    axiosMock.request.mockReset();
    axiosMock.post.mockReset();
  });

  it("QB-1：qBittorrent 5.x 的 stoppedUP/stoppedDL/forcedMetaDL 映射正确", async () => {
    const client = apiKeyClient();
    axiosMock.request.mockResolvedValue({
      data: {
        rid: 1,
        full_update: true,
        torrents: {
          A: rawTorrent("stoppedUP"),
          B: rawTorrent("stoppedDL"),
          C: rawTorrent("forcedMetaDL"),
          D: rawTorrent("pausedUP"),
        },
      },
    });

    const list = await client.getAllTorrents();
    expect(list.map((t) => `${(t.raw as any).state}->${t.state}`)).toEqual([
      "stoppedUP->paused",
      "stoppedDL->paused",
      "forcedMetaDL->downloading",
      "pausedUP->paused",
    ]);
  });

  it("QB-2：凭据错误时并发请求只发起一次失败登录，且不再发业务请求", async () => {
    axiosMock.post.mockRejectedValue(Object.assign(new Error("Forbidden"), { response: { status: 403 } }));
    const client = createClient();

    const results = await Promise.allSettled([
      client.getClientStatus(),
      client.getAllTorrents(),
      client.getClientFreeSpace(),
    ]);

    expect(results.every((result) => result.status === "rejected")).toBe(true);
    expect(axiosMock.post).toHaveBeenCalledTimes(1);
    expect(axiosMock.request).not.toHaveBeenCalled();
  });

  it("QB-3：读取 label 取 torrents[].tags 的第一个 tag", async () => {
    const client = apiKeyClient();
    axiosMock.request.mockResolvedValue({
      data: { rid: 1, full_update: true, torrents: { A: rawTorrent("uploading", { tags: "movie, tv" }) } },
    });

    const [torrent] = await client.getAllTorrents();
    expect(torrent.label).toBe("movie");
  });

  it("QB-3：setTorrentLabel 加法语义——只 addTags，不删除种子上其它 tag", async () => {
    const client = apiKeyClient();
    const calls: any[] = [];
    axiosMock.request.mockImplementation(async (config: any) => {
      calls.push(config);
      if (String(config.url).endsWith("/torrents/info")) {
        return { data: [{ hash: "HASH", tags: "old,tv" }] };
      }
      return { data: "Ok." };
    });

    await expect(client.setTorrentLabel("HASH", "movie")).resolves.toBe(true);

    const urls = calls.map((config) => config.url);
    // 复检 RB-3：加法语义不再 removeTags（qB tags 是多值属性且有外部写入者），也不再写 category
    expect(urls).toContain("/api/v2/torrents/addTags");
    expect(urls).not.toContain("/api/v2/torrents/removeTags");
    expect(urls).not.toContain("/api/v2/torrents/setCategory");
    expect(calls.find((config) => String(config.url).endsWith("addTags")).data).toEqual({
      hashes: "HASH",
      tags: "movie",
    });
  });

  it("QB-3：setTorrentLabel 空标签时才清空该种子的全部 tags（显式删除语义）", async () => {
    const client = apiKeyClient();
    const calls: any[] = [];
    axiosMock.request.mockImplementation(async (config: any) => {
      calls.push(config);
      if (String(config.url).endsWith("/torrents/info")) {
        return { data: [{ hash: "HASH", tags: "old,tv" }] };
      }
      return { data: "Ok." };
    });

    await expect(client.setTorrentLabel("HASH", "   ")).resolves.toBe(true);

    const urls = calls.map((config) => config.url);
    expect(urls).not.toContain("/api/v2/torrents/addTags");
    expect(calls.find((config) => String(config.url).endsWith("removeTags")).data).toEqual({
      hashes: "HASH",
      tags: "old,tv",
    });
  });

  it("QB-4：addAtPaused=false/true 都显式下发 paused/stopped", async () => {
    const client = apiKeyClient();
    let captured: any;
    axiosMock.request.mockImplementation(async (config: any) => {
      captured = config;
      return { data: "Ok." };
    });

    await client.addTorrent("magnet:?xt=urn:btih:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", {
      addAtPaused: false,
      localDownload: true,
    });
    expect((captured.data as FormData).get("paused")).toBe("false");
    expect((captured.data as FormData).get("stopped")).toBe("false");

    await client.addTorrent("magnet:?xt=urn:btih:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", {
      addAtPaused: true,
      localDownload: true,
    });
    expect((captured.data as FormData).get("paused")).toBe("true");
    expect((captured.data as FormData).get("stopped")).toBe("true");
  });

  it("QB-5：使用 category: 前缀时不改写调用方的 advanceAddTorrentOptions", async () => {
    const client = apiKeyClient();
    axiosMock.request.mockResolvedValue({ data: "Ok." });
    const advanceAddTorrentOptions = { autoTMM: false };

    await client.addTorrent("magnet:?xt=urn:btih:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", {
      addAtPaused: false,
      localDownload: true,
      savePath: "category:movies",
      advanceAddTorrentOptions,
    });

    expect(advanceAddTorrentOptions).toEqual({ autoTMM: false });
  });

  it("N-5：addTorrent 遇到 HTTP 错误时返回 success=false + message，而不是 reject", async () => {
    const client = apiKeyClient();
    axiosMock.request.mockRejectedValue(
      Object.assign(new Error("Request failed with status code 409"), { response: { status: 409 } }),
    );

    await expect(
      client.addTorrent("magnet:?xt=urn:btih:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", {
        addAtPaused: false,
        localDownload: true,
      }),
    ).resolves.toMatchObject({ success: false, message: expect.stringContaining("409") });
  });
});
