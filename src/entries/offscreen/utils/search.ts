import { uniqBy } from "es-toolkit";
import { getMediaServer } from "@ptd/mediaServer";
import { normalizedTorrentTagMap, sortTorrentTags, type TPattern, type TPatterns } from "@ptd/site";

import { onMessage, sendMessage } from "@/messages.ts";
import type { IMetadataPiniaStorageSchema, TSearchResultSnapshotStorageSchema } from "@/shared/types.ts";

import { logger } from "./logger.ts";
import { getSiteInstance } from "./site.ts";

/** 把站点定义里的 pattern（string | RegExp）预编译成正则，避免逐行 eval（见 docs/performance-audit.md P1 搜索热路径） */
function compilePatterns(patterns: TPatterns): RegExp[] {
  return patterns
    .map((pattern) => {
      try {
        if (pattern instanceof RegExp) {
          // 去掉 g/y 标志：带 lastIndex 的正则复用会漏匹配（原实现对 RegExp pattern 会 new 一个新实例）
          return new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ""));
        }
        if (typeof pattern !== "string" || pattern.length === 0) {
          return undefined;
        }
        return new RegExp(pattern, "i");
      } catch {
        return undefined;
      }
    })
    .filter((pattern): pattern is RegExp => !!pattern);
}

onMessage(
  "getSiteSearchResult",
  async ({ data: { siteId, keyword = "", searchEntry = {}, autoDetectOfficialGroupFromTitle } }) => {
    // 只取一个开关，避免整份 config 跨上下文往返
    const autoDetectEnabled =
      typeof autoDetectOfficialGroupFromTitle === "boolean"
        ? autoDetectOfficialGroupFromTitle
        : ((await sendMessage("getExtStoragePath", {
            key: "config",
            path: "searchEntity.autoDetectOfficialGroupFromTitle",
            defaultValue: false,
          })) as boolean);

    logger({
      msg: `getSiteSearchResult For site: ${siteId} with keyword: ${keyword}`,
      data: { siteId, keyword },
    });
    const site = await getSiteInstance<"public">(siteId);

    let searchResult = await site.getSearchResult(keyword, searchEntry);

    if (searchResult.data.length > 0) {
      let officialGroupPatterns: RegExp[] = [];
      if (autoDetectEnabled && site.metadata.officialGroupPattern?.length) {
        officialGroupPatterns = compilePatterns(site.metadata.officialGroupPattern);
      }

      searchResult.data = searchResult.data.map((item) => {
        item.tags ??= [];

        if (officialGroupPatterns.length > 0 && item.title) {
          if (officialGroupPatterns.some((pattern) => pattern.test(item.title))) {
            item.tags.push({ name: "官方" });
          }
        }

        // 尽可能将 tags 转换预定义的部分，去重并排序
        item.tags = sortTorrentTags(
          uniqBy(
            item.tags.map((tag) => {
              for (const normalizedTorrentTag of normalizedTorrentTagMap) {
                if (normalizedTorrentTag.from.test(tag.name)) {
                  return normalizedTorrentTag.to;
                }
              }
              return tag;
            }),
            (tag) => tag.name,
          ),
        );
        return item;
      });
    }

    return searchResult;
  },
);

onMessage("getMediaServerSearchResult", async ({ data: { mediaServerId, keywords = "", options = {} } }) => {
  logger({
    msg: `getMediaServerSearchResult For mediaServer: ${mediaServerId} with: ${keywords}`,
  });
  const mediaServerConfig = await sendMessage("getExtStoragePath", {
    key: "metadata",
    path: ["mediaServers", mediaServerId],
    defaultValue: {},
  });
  const mediaServer = await getMediaServer(mediaServerConfig as IMetadataPiniaStorageSchema["mediaServers"][string]);
  return await mediaServer.getSearchResult(keywords ?? "", options);
});

/**
 * 搜索快照按 snapshotId 独立读写（见 docs/performance-audit.md P1-4）：
 * 早期实现每次保存/删除都要整份读取并写回 Record<snapshotId, ISearchData>，
 * 第 N 次保存需重新序列化前 N-1 份快照（O(N²) 写入）。
 */
onMessage("getSearchResultSnapshotData", async ({ data: snapshotId }) => {
  return (await sendMessage("getExtStoragePath", {
    key: "searchResultSnapshot",
    path: [snapshotId],
    defaultValue: undefined,
  })) as TSearchResultSnapshotStorageSchema[string];
});

onMessage("saveSearchResultSnapshotData", async ({ data: { snapshotId, data } }) => {
  logger({ msg: `A new SearchResult Snapshot will be add at: ${snapshotId}` });
  await sendMessage("patchExtStoragePath", {
    key: "searchResultSnapshot",
    path: [snapshotId],
    value: data,
  });
});

onMessage("removeSearchResultSnapshotData", async ({ data: snapshotId }) => {
  await sendMessage("patchExtStoragePath", {
    key: "searchResultSnapshot",
    path: [snapshotId],
    remove: true,
  });
  logger({ msg: `SearchResult Snapshot ${snapshotId} is removed.` });
});
