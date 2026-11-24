import type { ITorrent } from "@ptd/site";
import type { IPushRoutingRule } from "./types/storages/metadata.ts";

const GIB = 1024 ** 3;
const MAX_REGEX_LENGTH = 200;

export function safeRegexTest(pattern: string | undefined, input: string): boolean {
  const trimmed = pattern?.trim() ?? "";
  if (!trimmed) return true;
  if (trimmed.length > MAX_REGEX_LENGTH) return false;
  try {
    return new RegExp(trimmed, "i").test(input);
  } catch {
    return false;
  }
}

export function isTorrentFree(torrent: Partial<ITorrent>): boolean {
  if (torrent.downloadVolumeFactor === 0) {
    return true;
  }
  const tags = Array.isArray(torrent.tags) ? torrent.tags : [];
  return tags.some((tag) => {
    const name = typeof tag?.name === "string" ? tag.name.trim() : "";
    return /^(2x\s*)?free$/i.test(name) || /免费/i.test(name);
  });
}

export function matchesPushRoutingRule(torrent: Partial<ITorrent>, rule: IPushRoutingRule): boolean {
  if (!rule.enabled || !rule.targetDownloaderId) {
    return false;
  }

  // 1. 站点匹配
  if (Array.isArray(rule.sites) && rule.sites.length > 0) {
    if (!torrent.site || !rule.sites.includes(torrent.site)) {
      return false;
    }
  }

  // 2. 分类匹配（忽略大小写，支持精确或子串匹配）
  if (Array.isArray(rule.categories) && rule.categories.length > 0) {
    const torrentCategory = String(torrent.category ?? "")
      .trim()
      .toLowerCase();
    const matchedCategory = rule.categories.some((cat) => {
      const target = cat.trim().toLowerCase();
      return target.length > 0 && torrentCategory.includes(target);
    });
    if (!matchedCategory) {
      return false;
    }
  }

  // 3. 体积区间（GiB）
  const sizeBytes = typeof torrent.size === "number" && Number.isFinite(torrent.size) ? torrent.size : 0;
  if (typeof rule.minSizeGiB === "number" && Number.isFinite(rule.minSizeGiB) && rule.minSizeGiB > 0) {
    if (sizeBytes < rule.minSizeGiB * GIB) {
      return false;
    }
  }
  if (typeof rule.maxSizeGiB === "number" && Number.isFinite(rule.maxSizeGiB) && rule.maxSizeGiB > 0) {
    if (sizeBytes <= 0 || sizeBytes > rule.maxSizeGiB * GIB) {
      return false;
    }
  }

  // 4. 仅免费
  if (rule.freeOnly && !isTorrentFree(torrent)) {
    return false;
  }

  // 5. 标签匹配（命中任意一条即可）
  if (Array.isArray(rule.tags) && rule.tags.length > 0) {
    const torrentTagNames = (Array.isArray(torrent.tags) ? torrent.tags : [])
      .map((tag) =>
        String(tag?.name ?? "")
          .trim()
          .toLowerCase(),
      )
      .filter(Boolean);
    const matchedTag = rule.tags.some((target) => {
      const normalized = target.trim().toLowerCase();
      return normalized.length > 0 && torrentTagNames.some((t) => t === normalized || t.includes(normalized));
    });
    if (!matchedTag) {
      return false;
    }
  }

  // 6. 标题 / 副标题正则匹配
  if (rule.titleRegex?.trim()) {
    const text = `${torrent.title ?? ""} ${torrent.subTitle ?? ""}`.trim();
    if (!safeRegexTest(rule.titleRegex, text)) {
      return false;
    }
  }

  return true;
}

/**
 * 按优先级降序匹配第一条命中的智能推送路由规则。
 */
export function matchPushRoutingRule(
  torrent: Partial<ITorrent>,
  rules: ReadonlyArray<IPushRoutingRule>,
  enabledDownloaderIds?: ReadonlySet<string>,
): IPushRoutingRule | null {
  if (!Array.isArray(rules) || rules.length === 0) {
    return null;
  }

  const ordered = [...rules]
    .filter((rule) => {
      if (!rule?.enabled || !rule.targetDownloaderId) return false;
      if (enabledDownloaderIds && !enabledDownloaderIds.has(rule.targetDownloaderId)) return false;
      return true;
    })
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));

  for (const rule of ordered) {
    if (matchesPushRoutingRule(torrent, rule)) {
      return rule;
    }
  }
  return null;
}
