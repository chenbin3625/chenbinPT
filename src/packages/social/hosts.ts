import type { TSupportSocialSite } from "./types.ts";

/**
 * 各社交站点的「可信主机」后缀白名单（C2-S-1）。
 *
 * 单独放在这个模块里，供引导脚本（content.js）在本地预筛：
 * `social/index.ts` 会引入 axios 与各实体模块，不能被打进每次页面加载都要执行的引导包。
 * 本文件只 import type，编译后没有任何运行时依赖。
 *
 * 旧实现是精确 hostname 集合，`m.douban.com` / `m.imdb.com` / `m.themoviedb.org` 这类常见移动页
 * 会被判为非社交页（快捷搜索入口消失），与各实体正则本身允许的 `m.*` / `mobile.*` 子域不一致。
 * 后缀匹配同时保留了反例（如 `douban.com.evil.example` 不匹配）。
 */
export const socialPageHosts: Record<TSupportSocialSite, readonly string[]> = {
  anidb: ["anidb.net"],
  bangumi: ["bgm.tv", "bangumi.tv", "chii.in"],
  douban: ["douban.com"],
  imdb: ["imdb.com"],
  tmdb: ["themoviedb.org"],
  tvmaze: ["tvmaze.com"],
};

/** host 是否等于白名单域名本身或为其子域 */
export function isSocialPageHost(hostname: string, site: TSupportSocialSite): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return (socialPageHosts[site] ?? []).some((domain) => host === domain || host.endsWith(`.${domain}`));
}

/**
 * 按 host 预筛社交站点：命中白名单才返回站点名，否则返回 null。
 *
 * 与 `matchSocialPageUrl` 的第一步判断完全一致（后者也先做 host 白名单，再匹配路径正则），
 * 因此引导脚本用它在本地跳过不可能命中的页面不会改变匹配结果。
 */
export function matchSocialPageHost(hostname: string): TSupportSocialSite | null {
  for (const site of Object.keys(socialPageHosts) as TSupportSocialSite[]) {
    if (isSocialPageHost(hostname, site)) return site;
  }
  return null;
}
