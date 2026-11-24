import { describe, expect, it } from "vitest";

import { isTorrentFree, matchPushRoutingRule, matchesPushRoutingRule, safeRegexTest } from "@/shared/pushRouting.ts";
import type { IPushRoutingRule } from "@/shared/types/storages/metadata.ts";

const GIB = 1024 ** 3;

describe("pushRouting engine", () => {
  it("handles regex safely including invalid patterns and length cap", () => {
    expect(safeRegexTest("2160p|4K", "Movie.2025.2160p.WEB-DL")).toBe(true);
    expect(safeRegexTest("", "anything")).toBe(true);
    expect(safeRegexTest("[unclosed(", "anything")).toBe(false);
    expect(safeRegexTest("a".repeat(250), "a".repeat(250))).toBe(false);
  });

  it("recognizes free torrents by factor or tag", () => {
    expect(isTorrentFree({ downloadVolumeFactor: 0 })).toBe(true);
    expect(isTorrentFree({ tags: [{ name: "2xFree" }] })).toBe(true);
    expect(isTorrentFree({ tags: [{ name: "限时免费" }] })).toBe(true);
    expect(isTorrentFree({ downloadVolumeFactor: 0.5, tags: [{ name: "50%" }] })).toBe(false);
  });

  it("matches multi-condition rules and respects priority & enabled downloaders", () => {
    const rules: IPushRoutingRule[] = [
      {
        id: "fallback",
        name: "Default Catch-All",
        enabled: true,
        priority: 10,
        targetDownloaderId: "dl-default",
      },
      {
        id: "uhd-free",
        name: "4K Free Movies",
        enabled: true,
        priority: 100,
        sites: ["mteam"],
        categories: ["movie"],
        minSizeGiB: 15,
        maxSizeGiB: 120,
        freeOnly: true,
        tags: ["HDR"],
        titleRegex: "2160p|UHD",
        targetDownloaderId: "dl-nas",
        savePath: "/nas/4k",
        label: "4K",
      },
      {
        id: "disabled-dl",
        name: "Disabled Downloader Rule",
        enabled: true,
        priority: 200,
        sites: ["mteam"],
        targetDownloaderId: "dl-offline",
      },
    ];

    const torrent = {
      site: "mteam",
      category: "Movies/UHD",
      size: 40 * GIB,
      title: "Inception.2010.2160p.UHD.BluRay",
      tags: [{ name: "Free" }, { name: "HDR10" }],
    };

    expect(matchesPushRoutingRule(torrent, rules[1]!)).toBe(true);

    const enabledIds = new Set(["dl-default", "dl-nas"]);
    const matched = matchPushRoutingRule(torrent, rules, enabledIds);
    expect(matched?.id).toBe("uhd-free");

    // Non-free torrent misses uhd-free and falls back to lower-priority rule
    const nonFreeMatched = matchPushRoutingRule({ ...torrent, tags: [{ name: "HDR10" }] }, rules, enabledIds);
    expect(nonFreeMatched?.id).toBe("fallback");
  });
});
