/**
 * Flood 实体回归测试（复检 P2-I：FL-1/FL-2 改了行为却零测试）。
 *
 * 上游核对（jesec/flood）：
 * - `server/routes/api/torrents.ts` 的 add-urls/add-files 构造 options 时 `start: start ?? false`，
 *   因此「自动开始」必须显式下发 `start: true`（FL-1）；
 * - Flood/rTorrent 内部 hash 是大写，MyClient 传的是 `CTorrent.id`（小写），stop/start/delete 必须转大写（FL-2）；
 * - delete 的字段名是 `deleteData`（`shared/schema/api/torrents.ts`）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const requestMock = vi.hoisted(() => vi.fn());

vi.mock("axios", () => ({ default: { create: vi.fn(() => ({ request: requestMock })) } }));
vi.mock("@ptd/downloader/utils.ts", () => ({
  getRemoteTorrentFile: vi.fn(),
  sanitizeDownloadUrlForLog: vi.fn((url: unknown) => String(url)),
}));
vi.mock("@ptd/site/utils/adapter.ts", () => ({ logMessage: vi.fn() }));

import Flood from "@ptd/downloader/entity/Flood.ts";

const MAGNET = "magnet:?xt=urn:btih:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const HASH = "abcdef0123456789abcdef0123456789abcdef01";

const makeClient = () =>
  new Flood({
    id: "flood-1",
    type: "Flood",
    name: "Flood",
    address: "http://flood.local/",
    username: "u",
    password: "p",
    timeout: 1000,
  } as any);

function lastRequestBody() {
  const call = requestMock.mock.calls.at(-1)!;
  return call[0]?.data;
}

beforeEach(() => {
  requestMock.mockReset();
});

describe("Flood FL-1：添加时显式下发 start", () => {
  it("addAtPaused=false → start: true；addAtPaused=true → start: false", async () => {
    requestMock.mockResolvedValue({ data: {} });
    const client = makeClient();

    await expect(client.addTorrent(MAGNET, { addAtPaused: false })).resolves.toMatchObject({ success: true });
    expect(lastRequestBody()).toMatchObject({ start: true, urls: [MAGNET] });

    await expect(client.addTorrent(MAGNET, { addAtPaused: true })).resolves.toMatchObject({ success: true });
    expect(lastRequestBody()).toMatchObject({ start: false });
  });

  it("未指定 addAtPaused 时按「自动开始」处理", async () => {
    requestMock.mockResolvedValue({ data: {} });
    await expect(makeClient().addTorrent(MAGNET, {})).resolves.toMatchObject({ success: true });
    expect(lastRequestBody()).toMatchObject({ start: true });
  });
});

describe("Flood FL-2：hash 统一转大写", () => {
  it("pause / resume / remove 都把 id 转成大写 hash", async () => {
    requestMock.mockResolvedValue({ data: {} });
    const client = makeClient();

    await expect(client.pauseTorrent(HASH)).resolves.toBe(true);
    expect(lastRequestBody()).toEqual({ hashes: [HASH.toUpperCase()] });

    await expect(client.resumeTorrent(HASH)).resolves.toBe(true);
    expect(lastRequestBody()).toEqual({ hashes: [HASH.toUpperCase()] });

    await expect(client.removeTorrent(HASH, true)).resolves.toBe(true);
    expect(lastRequestBody()).toEqual({ hashes: [HASH.toUpperCase()], deleteData: true });

    // 请求路径也必须是 Flood 的 delete 路由
    expect(requestMock.mock.calls.at(-1)![0].url).toBe("/api/torrents/delete");
  });
});

describe("Flood FL-3：失败返回 false（符合 Promise<boolean> 契约）", () => {
  it("pause/resume/remove/文件优先级失败时返回 false，而不是 reject", async () => {
    requestMock.mockRejectedValue(new Error("boom"));
    const client = makeClient();

    await expect(client.pauseTorrent(HASH)).resolves.toBe(false);
    await expect(client.resumeTorrent(HASH)).resolves.toBe(false);
    await expect(client.removeTorrent(HASH, false)).resolves.toBe(false);
    await expect(
      client.setTorrentFilePriority(HASH, [{ index: 0, priority: "skip" as any, wanted: false } as any]),
    ).resolves.toBe(false);
  });

  it("401 时先登录再重试一次，成功后返回 true", async () => {
    requestMock
      .mockRejectedValueOnce(Object.assign(new Error("unauthorized"), { response: { status: 401 } }))
      .mockResolvedValueOnce({ data: { success: true } }) // /api/auth/authenticate
      .mockResolvedValueOnce({ data: {} }); // 重试的 stop
    const client = makeClient();

    await expect(client.pauseTorrent(HASH)).resolves.toBe(true);
    expect(requestMock.mock.calls[1]![0].url).toBe("/api/auth/authenticate");
    expect(requestMock.mock.calls[2]![0].url).toBe("/api/torrents/stop");
  });
});
