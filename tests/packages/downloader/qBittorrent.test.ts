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
