/**
 * 站点「可信主机」判定（同源收紧的公共实现）。
 *
 * 背景（跨范围协调）：`AbstractBittorrentSite.prepareRequestConfig()` / `isTrustedSiteUrl()` 会拒绝
 * 发往站点之外主机的请求，以防 passkey/token 等凭据被带到第三方。判据必须**放行站点自己声明的
 * 主机**，否则同源收紧就会把正常功能打成回归（典型：M-Team 的 web 域是 `kp.m-team.cc`，
 * API 域是兄弟主机 `api.m-team.cc`，只放行子域时所有 API 请求都会被判 untrusted）。
 *
 * 本模块集中实现主机比较与「声明主机集合」的构建，供 schema（request 同源校验）与站点定义
 * （`trustedHostnames` 覆写 / 凭据注入守卫）共用，避免各处规则漂移：
 *
 * 1. 默认规则：主机**全等**或为声明主机的**子域**（`www.` 前缀归一化），与 D1 的 request()
 *    当前语义保持一致；`api.<declared-host>` / `cdn.<declared-host>` 等子域自动放行。
 * 2. 兄弟主机（如 `kp.m-team.cc` ↔ `api.m-team.cc`）：不属于子域关系，必须由站点显式声明：
 *    - 站点定义覆写 `trustedHostnames`，把 `buildTrustedHostnames(..., [...])` 的结果返回
 *      （例如 M-Team 的 `api.<domain>` 由定义自行派生后加入 `extraHosts`）。
 * 3. metadata 中显式写定的绝对请求地址（`search/list/detail/download` 的 requestConfig）属于
 *    站点声明主机，可经 `collectDeclaredRequestHostnames()` 自动加入信任集合（当前定义中没有
 *    此类跨主机地址，保留该机制供未来定义使用）。
 *
 * 说明（第二轮复检）：曾提供 `deriveSiblingHostname()` 供定义派生兄弟主机，但全仓无调用点
 * （mteam 定义已自行派生），属死代码，已删除；本模块只保留「比较/构建」两类公共能力，
 * schema 的同源校验、sender 绑定、favicon 抓取、定义覆写共用同一套规则。
 */

import type { ISiteMetadata } from "../types";
import { restoreSecureLink } from "./html";

/** 归一化主机名：去空白、小写、去掉 `www.` 前缀（只处理 hostname，不含端口） */
export function normalizeSiteHost(host: string): string {
  const value = String(host ?? "")
    .trim()
    .toLowerCase();
  return value.startsWith("www.") ? value.slice(4) : value;
}

/** 从 URL（绝对地址；兼容站点定义里 ROT13 加密的 `uggcf://` 写法）提取 hostname；失败返回 undefined */
export function parseHostname(url?: string | null): string | undefined {
  if (!url) return undefined;
  try {
    const raw = url.startsWith("uggc") ? restoreSecureLink(url) : url;
    const hostname = new URL(raw).hostname;
    return hostname ? hostname.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

/** 主机是否命中某个可信主机：全等，或为可信主机的子域（`api.example.com` ⊆ `example.com`） */
export function siteHostMatches(host: string, trustedHost: string): boolean {
  const target = normalizeSiteHost(host);
  const trusted = normalizeSiteHost(trustedHost);
  if (!target || !trusted) return false;
  return target === trusted || (target.includes(".") && trusted.includes(".") && target.endsWith(`.${trusted}`));
}

/** 主机是否命中可信主机集合中的任意一个 */
export function isHostTrusted(host: string, trustedHosts: Iterable<string>): boolean {
  for (const trustedHost of trustedHosts) {
    if (siteHostMatches(host, trustedHost)) return true;
  }
  return false;
}

/** 把「URL 或裸 hostname」转成可比较的 hostname */
function toTrustedHostname(value?: string | null): string | undefined {
  if (!value) return undefined;
  const trimmed = String(value).trim();
  if (!trimmed) return undefined;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) || trimmed.startsWith("//")) {
    return parseHostname(trimmed.startsWith("//") ? `https:${trimmed}` : trimmed);
  }
  const host = trimmed.split(/[/?#]/)[0];
  return host ? normalizeSiteHost(host) : undefined;
}

/**
 * 构建去重的可信主机列表（保持声明顺序）。
 *
 * @param declaredUrls 站点声明地址（`metadata.urls` / `metadata.legacyUrls` / `this.url` 等）
 * @param extraHosts   站点显式追加的主机（兄弟 API 主机、额外 CDN 等），支持 hostname 或 URL
 */
export function buildTrustedHostnames(
  declaredUrls: Iterable<string | null | undefined>,
  extraHosts: Iterable<string | null | undefined> = [],
): string[] {
  const hostnames = new Set<string>();
  for (const url of declaredUrls) {
    const hostname = toTrustedHostname(url);
    if (hostname) hostnames.add(hostname);
  }
  for (const host of extraHosts) {
    const hostname = toTrustedHostname(host);
    if (hostname) hostnames.add(hostname);
  }
  return [...hostnames];
}

/**
 * 收集 siteMetadata 中**显式写定的绝对请求地址**的主机（站点声明主机）。
 *
 * 只扫描 requestConfig 的 `url` / `baseURL`，且只接受带协议的绝对地址或协议相对地址；
 * 相对路径由 `this.url` 解析、不会引入新主机。`favicon` 等纯展示字段不在此列
 * （它们可能是第三方 CDN，不应据此放宽凭据注入守卫）。
 */
export function collectDeclaredRequestHostnames(metadata: Partial<ISiteMetadata> | null | undefined): string[] {
  if (!metadata) return [];

  const hostnames = new Set<string>();
  const addConfig = (config: unknown): void => {
    if (!config || typeof config !== "object") return;
    const { url, baseURL } = config as { url?: unknown; baseURL?: unknown };
    for (const raw of [baseURL, url]) {
      if (typeof raw !== "string") continue;
      const trimmed = raw.trim();
      if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) && !trimmed.startsWith("//")) continue;
      const hostname = parseHostname(trimmed.startsWith("//") ? `https:${trimmed}` : trimmed);
      if (hostname) hostnames.add(hostname);
    }
  };

  addConfig(metadata.search?.requestConfig);
  for (const entry of Object.values(metadata.searchEntry ?? {})) {
    addConfig((entry as { requestConfig?: unknown } | undefined)?.requestConfig);
  }
  for (const listItem of metadata.list ?? []) {
    addConfig((listItem as { requestConfig?: unknown } | undefined)?.requestConfig);
  }
  addConfig(metadata.detail?.requestConfig);
  addConfig((metadata as { download?: { requestConfig?: unknown } }).download?.requestConfig);

  return [...hostnames];
}
