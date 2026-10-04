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
});
