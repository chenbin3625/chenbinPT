/**
 * uTorrent 进度单位回归测试。
 *
 * µTorrent Web API 的 PROGRESS 是千分比（integer in per mils），
 * 而 CTorrent.progress 的约定是 0-100（见 src/packages/downloader/types.ts）。
 * 修复前用的是 `torrent[4] / 100`（得到 0-10），界面会把 100% 显示成 10%。
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@ptd/downloader/utils.ts", () => ({
  getRemoteTorrentFile: vi.fn(),
  extractMagnetHash: vi.fn(),
}));

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
