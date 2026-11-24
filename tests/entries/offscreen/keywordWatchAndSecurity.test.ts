import { beforeEach, describe, expect, it, vi } from "vitest";
import { EResultParseStatus, type ITorrent } from "@ptd/site";

import { contentScriptAllowedMessages, extensionPageOnlyMessages, offscreenMessageTypes } from "@/messages.ts";
import type { IKeywordWatchRule } from "@/shared/types/storages/metadata.ts";

const mocks = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  getSiteInstance: vi.fn(),
  runSiteOperation: vi.fn(async (_siteId: string, fn: () => Promise<any>) => await fn()),
  ensureCustomSitesSynced: vi.fn(async () => undefined),
  createTorrentFavorites: vi.fn(async () => undefined),
  getDefinedSiteMetadata: vi.fn(),
}));

vi.mock("@ptd/site", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ptd/site")>();
  return {
    ...actual,
    getDefinedSiteMetadata: mocks.getDefinedSiteMetadata,
  };
});
vi.mock("@/offscreen/adapter/indexdb.ts", () => ({ ptdIndexDb: Promise.resolve({}) }));
vi.mock("@/offscreen/utils/logger.ts", () => ({ logger: vi.fn() }));
vi.mock("@/offscreen/utils/site.ts", () => ({
  ensureCustomSitesSynced: mocks.ensureCustomSitesSynced,
  getSiteInstance: mocks.getSiteInstance,
  runSiteOperation: mocks.runSiteOperation,
}));
vi.mock("@/offscreen/utils/torrentFavorite.ts", () => ({
  createTorrentFavorites: mocks.createTorrentFavorites,
}));
vi.mock("@/messages.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/messages.ts")>();
  return {
    ...actual,
    onMessage: vi.fn(),
    sendMessage: mocks.sendMessage,
  };
});

const { filterTorrentByKeywordWatchRule, runKeywordWatchRule } = await import("@/offscreen/utils/keywordWatch.ts");

function installMetadataStorage(initialMetadata: Record<string, any>) {
  const metadata = structuredClone(initialMetadata);
  mocks.sendMessage.mockImplementation(async (type: string, payload: any) => {
    if (type === "getExtStoragePath" && payload.key === "metadata") {
      const path = Array.isArray(payload.path) ? payload.path : [payload.path];
      let cur: any = metadata;
      for (const seg of path) {
        if (cur == null) return payload.defaultValue;
        cur = cur[seg];
      }
      return cur === undefined ? payload.defaultValue : structuredClone(cur);
    }
    if (type === "patchExtStoragePath" && payload.key === "metadata") {
      const path = Array.isArray(payload.path) ? payload.path : [payload.path];
      let cur: any = metadata;
      for (let i = 0; i < path.length - 1; i++) {
        cur[path[i]] ??= {};
        cur = cur[path[i]];
      }
      const last = path[path.length - 1];
      if (payload.remove) delete cur[last];
      else cur[last] = structuredClone(payload.value);
      return undefined;
    }
    return undefined;
  });
  return metadata;
}

beforeEach(() => {
  mocks.sendMessage.mockReset();
  mocks.getSiteInstance.mockReset();
  mocks.runSiteOperation.mockClear();
  mocks.ensureCustomSitesSynced.mockClear();
  mocks.createTorrentFavorites.mockReset();
  mocks.createTorrentFavorites.mockResolvedValue(undefined);
  mocks.getDefinedSiteMetadata.mockReset();
  mocks.getDefinedSiteMetadata.mockRejectedValue(new Error("not mocked"));
});

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

describe("keywordWatch runKeywordWatchRule 回归测试（全部 5 项监控问题）", () => {
  const makeRule = (overrides: Partial<IKeywordWatchRule> = {}): IKeywordWatchRule => ({
    id: "rule-1",
    name: "Watch Test",
    enabled: true,
    keyword: "Dune",
    solutionId: "all",
    intervalMinutes: 60,
    ...overrides,
  });

  it("搜索期间删除或停用规则不会被旧快照写回恢复", async () => {
    // 1. 删除场景
    const metaDelete = installMetadataStorage({
      sites: { s1: { allowSearch: true } },
      keywordWatches: { "rule-1": makeRule({ autoFavorite: true }) },
    });
    mocks.getSiteInstance.mockResolvedValue({
      getSearchResult: vi.fn(async () => {
        // 模拟搜索耗时期间用户删除规则
        delete metaDelete.keywordWatches["rule-1"];
        return {
          status: EResultParseStatus.success,
          data: [{ site: "s1", id: "t1", title: "Dune.2160p" }],
        };
      }),
    });

    const delRes = await runKeywordWatchRule("rule-1");
    expect(metaDelete.keywordWatches["rule-1"]).toBeUndefined();
    expect(mocks.createTorrentFavorites).not.toHaveBeenCalled();
    expect(delRes.newMatches).toHaveLength(0);

    // 2. 停用场景
    const metaDisable = installMetadataStorage({
      sites: { s1: { allowSearch: true } },
      keywordWatches: { "rule-1": makeRule({ enabled: true, autoFavorite: true }) },
    });
    mocks.getSiteInstance.mockResolvedValue({
      getSearchResult: vi.fn(async () => {
        metaDisable.keywordWatches["rule-1"].enabled = false;
        return {
          status: EResultParseStatus.success,
          data: [{ site: "s1", id: "t2", title: "Dune.2160p" }],
        };
      }),
    });

    const disableRes = await runKeywordWatchRule("rule-1");
    expect(metaDisable.keywordWatches["rule-1"].enabled).toBe(false);
    expect(mocks.createTorrentFavorites).not.toHaveBeenCalled();
    expect(disableRes.newMatches).toHaveLength(0);
  });

  it("站点通过返回 parseError/needLogin 报告失败（未抛异常）时计入失败并回报错误", async () => {
    const metadata = installMetadataStorage({
      sites: { s1: { allowSearch: true }, s2: { allowSearch: true } },
      keywordWatches: { "rule-1": makeRule() },
    });
    mocks.getSiteInstance.mockImplementation(async (siteId: string) => ({
      getSearchResult: vi.fn(async () => ({
        status: siteId === "s1" ? EResultParseStatus.parseError : EResultParseStatus.needLogin,
        statusMsg: siteId === "s1" ? "HTML changed" : "Cookie expired",
        data: [],
      })),
    }));

    const res = await runKeywordWatchRule("rule-1");
    expect(res.error).toMatch(/All 2 sites failed/);
    expect(metadata.keywordWatches["rule-1"].lastError).toMatch(/All 2 sites failed/);
  });

  it("稳定命中超过 200 条（201 条）连续 4 轮仅首轮报 201，后续均为 0", async () => {
    installMetadataStorage({
      sites: { s1: { allowSearch: true } },
      keywordWatches: { "rule-1": makeRule() },
    });
    const stableTorrents: ITorrent[] = Array.from({ length: 201 }, (_, i) => ({
      site: "s1",
      id: `id-${i + 1}`,
      title: `Dune.Release.${i + 1}`,
      url: `https://s1.example/details.php?id=${i + 1}`,
    }));
    mocks.getSiteInstance.mockResolvedValue({
      getSearchResult: vi.fn(async () => ({
        status: EResultParseStatus.success,
        data: stableTorrents,
      })),
    });

    const round1 = await runKeywordWatchRule("rule-1");
    const round2 = await runKeywordWatchRule("rule-1");
    const round3 = await runKeywordWatchRule("rule-1");
    const round4 = await runKeywordWatchRule("rule-1");

    expect([
      round1.newMatches.length,
      round2.newMatches.length,
      round3.newMatches.length,
      round4.newMatches.length,
    ]).toEqual([201, 0, 0, 0]);
  });

  it("自动收藏失败时不把命中标为已见，下轮存储恢复后重试收藏成功", async () => {
    const metadata = installMetadataStorage({
      sites: { s1: { allowSearch: true } },
      keywordWatches: { "rule-1": makeRule({ autoFavorite: true, favCategory: "追剧" }) },
    });
    const torrent: ITorrent = { site: "s1", id: "99", title: "Dune.Part.Two" };
    mocks.getSiteInstance.mockResolvedValue({
      getSearchResult: vi.fn(async () => ({ status: EResultParseStatus.success, data: [torrent] })),
    });

    mocks.createTorrentFavorites.mockRejectedValueOnce(new Error("IDB quota exceeded"));
    const first = await runKeywordWatchRule("rule-1");
    expect(first.error).toMatch(/Auto-favorite failed/);
    expect(first.newMatches).toHaveLength(0);
    expect(metadata.keywordWatches["rule-1"].seenTorrentKeys).toEqual([]);

    mocks.createTorrentFavorites.mockResolvedValueOnce(undefined);
    const second = await runKeywordWatchRule("rule-1");
    expect(second.error).toBeUndefined();
    expect(second.newMatches).toHaveLength(1);
    expect(mocks.createTorrentFavorites).toHaveBeenCalledTimes(2);
    expect(metadata.keywordWatches["rule-1"].seenTorrentKeys).toHaveLength(1);

    const third = await runKeywordWatchRule("rule-1");
    expect(third.newMatches).toHaveLength(0);
    expect(mocks.createTorrentFavorites).toHaveBeenCalledTimes(2);
  });

  it("监控范围与用户搜索方案一致：展开站点已启用的额外入口，且自定义方案全禁用入口时不补发默认搜索", async () => {
    // 1. 全站方案展开站点 searchEntry + merge.searchEntry 覆盖，且跳过 isDead 站点
    mocks.getDefinedSiteMetadata.mockImplementation(async (siteId: string) => {
      if (siteId === "dead_site") {
        return { id: "dead_site", isDead: true };
      }
      return {
        id: "multi_site",
        searchEntry: {
          torrents: { name: "综合", enabled: true },
          special: { name: "特别区", enabled: false },
        },
      };
    });

    installMetadataStorage({
      sites: {
        multi_site: { allowSearch: true, merge: { searchEntry: { special: { enabled: true } } } },
        dead_site: { allowSearch: true },
      },
      keywordWatches: { "rule-all": makeRule({ id: "rule-all", solutionId: "all" }) },
    });

    const calledEntries: Array<{ siteId: string; entryId?: string }> = [];
    mocks.getSiteInstance.mockImplementation(async (siteId: string) => ({
      getSearchResult: vi.fn(async (_kw: string, entry: any) => {
        calledEntries.push({ siteId, entryId: entry?.id });
        return { status: EResultParseStatus.success, data: [] };
      }),
    }));

    await runKeywordWatchRule("rule-all");
    expect(calledEntries).toEqual([
      { siteId: "multi_site", entryId: "torrents" },
      { siteId: "multi_site", entryId: "special" },
    ]);

    // 2. 自定义方案里所有 searchEntries 都 enabled: false 时，不回落补发默认入口
    calledEntries.length = 0;
    installMetadataStorage({
      sites: { s1: { allowSearch: true } },
      solutions: {
        "sol-disabled": {
          id: "sol-disabled",
          name: "All Disabled",
          sort: 0,
          enabled: true,
          isDefault: false,
          createdAt: 0,
          solutions: [
            {
              id: "item-1",
              siteId: "s1",
              searchEntries: {
                movies: { enabled: false },
                tv: { enabled: false },
              },
            },
          ],
        },
      },
      keywordWatches: { "rule-disabled": makeRule({ id: "rule-disabled", solutionId: "sol-disabled" }) },
    });

    const disabledSolRes = await runKeywordWatchRule("rule-disabled");
    expect(calledEntries).toEqual([]);
    expect(disabledSolRes.error).toBe("No searchable sites in target solution");
  });
});
