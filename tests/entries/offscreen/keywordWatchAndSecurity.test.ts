import { describe, expect, it, vi } from "vitest";
import type { ITorrent } from "@ptd/site";

import { contentScriptAllowedMessages, extensionPageOnlyMessages, offscreenMessageTypes } from "@/messages.ts";
import type { IKeywordWatchRule } from "@/shared/types/storages/metadata.ts";

vi.mock("@/offscreen/adapter/indexdb.ts", () => ({ ptdIndexDb: Promise.resolve({}) }));
vi.mock("@/offscreen/utils/logger.ts", () => ({ logger: vi.fn() }));
vi.mock("@/messages.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/messages.ts")>();
  return {
    ...actual,
    onMessage: vi.fn(),
    sendMessage: vi.fn(),
  };
});

const { filterTorrentByKeywordWatchRule } = await import("@/offscreen/utils/keywordWatch.ts");

const GIB = 1024 ** 3;

describe("keywordWatch torrent filtering", () => {
  const baseRule: IKeywordWatchRule = {
    id: "kw-1",
    name: "4K Free Rule",
    enabled: true,
    keyword: "Dune",
    solutionId: "default",
    intervalMinutes: 60,
    freeOnly: true,
    minSizeGiB: 10,
    maxSizeGiB: 80,
    minSeeders: 5,
    titleIncludeRegex: "2160p|4K",
    titleExcludeRegex: "CAM|TS",
  };

  const baseTorrent: ITorrent = {
    site: "demo",
    id: "1001",
    title: "Dune.Part.Two.2024.2160p.WEB-DL",
    subTitle: "沙丘2 杜比视界",
    size: 25 * GIB,
    seeders: 42,
    tags: [{ name: "Free" }],
  };

  it("accepts torrents matching all criteria and rejects violations", () => {
    expect(filterTorrentByKeywordWatchRule(baseTorrent, baseRule)).toBe(true);
    expect(filterTorrentByKeywordWatchRule({ ...baseTorrent, tags: [] }, baseRule)).toBe(false);
    expect(filterTorrentByKeywordWatchRule({ ...baseTorrent, size: 5 * GIB }, baseRule)).toBe(false);
    expect(filterTorrentByKeywordWatchRule({ ...baseTorrent, size: 90 * GIB }, baseRule)).toBe(false);
    expect(filterTorrentByKeywordWatchRule({ ...baseTorrent, seeders: 2 }, baseRule)).toBe(false);
    expect(filterTorrentByKeywordWatchRule({ ...baseTorrent, title: "Dune.1080p.WEB-DL" }, baseRule)).toBe(false);
    expect(filterTorrentByKeywordWatchRule({ ...baseTorrent, title: "Dune.2160p.CAM" }, baseRule)).toBe(false);
  });
});

describe("new messages security boundaries", () => {
  it("restricts privileged new messages to extension pages only", () => {
    const privileged = [
      "setClientTorrentLocation",
      "replaceClientTorrentTracker",
      "reannounceClientTorrent",
      "runKeywordWatchRule",
      "sendAlertWebhook",
      "syncToolbarPopup",
      "testSiteUrlsLatency",
      "getAllSitesPreviousUserInfo",
    ] as const;

    for (const type of privileged) {
      expect(extensionPageOnlyMessages.has(type), `${type} must be extension-page-only`).toBe(true);
      expect(contentScriptAllowedMessages.has(type), `${type} must NOT be exposed to content scripts`).toBe(false);
    }
  });

  it("allows only sanitized content-script status & media-check messages", () => {
    expect(contentScriptAllowedMessages.has("checkMediaServerBySocialInfo")).toBe(true);
    expect(contentScriptAllowedMessages.has("getSiteTorrentStatuses")).toBe(true);
    expect(offscreenMessageTypes.has("checkMediaServerBySocialInfo")).toBe(true);
    expect(offscreenMessageTypes.has("getSiteTorrentStatuses")).toBe(true);
  });
});
