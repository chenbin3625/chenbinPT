/**
 * offscreen 消息发送方的来源判定与「sender 页面 ↔ 站点」绑定（A2 在 offscreen 侧的落地）。
 *
 * 背景（审查报告 A2 / B1-3）：`getSiteUserConfig` / `getTorrentDownloadLink` / `downloadTorrent`
 * 对 content script 开放，但处理方原先只信任调用方自己给出的 `siteId` / `torrent.site` /
 * `downloadId` / `downloaderId`，没有把请求与「发送方页面所属站点」绑定。任意被注入了内容脚本的
 * 站点页面因此可以：
 *   - 请求任意其他已配置站点的用户配置/下载链接（凭据面）；
 *   - 用任意 `downloadId` 改写既有下载历史（数据完整性）；
 *   - 把站外 magnet 推到任意下载器（写权限）。
 *
 * 这里提供纯函数式的最小判定，由各 handler 自行调用（不改变 handler 的正常语义）：
 *   - 扩展自身上下文（options/offscreen/background）保持全权；
 *   - content script 只有在**自己的页面 URL**（`sender.url`）落在该站点的可信 host 列表内时才放行。
 *
 * 判据与 `messages.ts` 的 `isExtensionPageSender` 保持一致：
 *   - `sender.id` 必须是本扩展 id（其它扩展/网页一律不可信）；
 *   - 有 `sender.url` 时必须是扩展页 URL；
 *   - `sender.url` 缺失时，只有**不带 tab** 的发送方才算扩展自身上下文（MV3 service worker 在
 *     Chrome < M140 没有 sender.url；内容脚本一定带 `sender.tab`）。
 *
 * 2026-10-24 并行审查 P1-1：调用方一律改成「`!isExtensionPageSender(sender)` 就必须过站点绑定」，
 * 不再用 `isContentScriptSender` 作为条件（它要求 id 匹配，外部扩展会被两边都判 false 而 fail-open）。
 */

type TMessageSender = chrome.runtime.MessageSender | undefined;

/** 通过 globalThis 取 chrome：单测/非扩展环境（SSR）下 `chrome` 可能整个不存在 */
function getChromeRuntime(): typeof chrome.runtime | undefined {
  try {
    return (globalThis as { chrome?: typeof chrome }).chrome?.runtime;
  } catch {
    return undefined;
  }
}

/** 当前扩展的基址（`chrome-extension://<id>/`）；拿不到时返回 undefined */
export function getExtensionBaseUrl(): string | undefined {
  try {
    return getChromeRuntime()?.getURL?.("");
  } catch {
    return undefined;
  }
}

/**
 * 发送方是否为扩展自身的可信上下文（options / offscreen / background 等）。
 *
 * - `sender.id` 必须等于本扩展 id；
 * - 有 `sender.url` 时必须是扩展页 URL；
 * - `sender.url` 缺失时（MV3 service worker 在 Chrome < M140 的形态），只有不带 tab 的才算扩展自身上下文；
 *   带 tab 的来自页面（内容脚本），按不可信处理（fail-closed）。
 */
export function isExtensionPageSender(sender: TMessageSender): boolean {
  if (!sender || sender.id !== getChromeRuntime()?.id) {
    return false;
  }
  if (typeof sender.url === "string" && sender.url.length > 0) {
    const extensionBase = getExtensionBaseUrl();
    if (extensionBase) {
      return sender.url.startsWith(extensionBase);
    }
    return /^(chrome|moz)-extension:\/\//.test(sender.url);
  }
  return sender.tab === undefined || sender.tab === null;
}

/**
 * 发送方是否属于**可信扩展上下文**：扩展页，或「没有 sender」的本地同上下文调用。
 *
 * `messages.ts` 的 `sendMessage` 在「本上下文已注册同名 handler」时会直接调用
 * `localHandler({ data })`（不发消息、因此没有 sender）——这是扩展代码自己调用自己，
 * 与扩展页同级可信。跨上下文消息一律带 sender（浏览器保证），所以 `sender === undefined`
 * 只可能出现在本地调用路径上，不能因此把它当页面侧拒绝。
 */
export function isTrustedExtensionContext(sender: TMessageSender): boolean {
  return typeof sender === "undefined" || isExtensionPageSender(sender);
}

/**
 * 发送方是否为内容脚本（同扩展、但 URL 不是扩展页；或 url 缺失但来自页面/iframe）。
 *
 * 只用于「是否是页面侧」的语义判断；**权限判定请用 `!isExtensionPageSender(sender)`**，
 * 否则外部扩展的 sender（id 不匹配时两边都 false）会被误判成可信（P1-1）。
 */
export function isContentScriptSender(sender: TMessageSender): boolean {
  if (!sender || sender.id !== getChromeRuntime()?.id) {
    return false;
  }
  if (isExtensionPageSender(sender)) {
    return false;
  }
  return !!sender.tab || typeof sender.url === "string";
}

/**
 * 发送方页面的 http(s) URL。
 *
 * 2026-10-24 并行审查 P2-3：**只信 `sender.url`**（消息真正来自哪个 frame）。
 * 只有在 `sender.url` 完全缺失时才回落到 `sender.tab.url`（顶层页 URL），否则会把
 * 「攻击者 iframe + 可信站点顶层页」判成可信 —— `sender.tab.url` 是顶层页而不是发送 frame。
 * 非 http(s)（about:blank、sandboxed iframe、扩展页等）一律丢弃。
 */
function toHttpUrl(candidate: unknown): string | undefined {
  if (typeof candidate !== "string" || candidate.length === 0) {
    return undefined;
  }
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

export function getSenderPageHttpUrls(sender: TMessageSender): string[] {
  // 发送 frame 的 URL 存在但不是 http(s)（about:blank / sandboxed iframe）：不能拿顶层 URL 放行
  if (typeof sender?.url === "string" && sender.url.length > 0) {
    const url = toHttpUrl(sender.url);
    return url ? [url] : [];
  }
  const tabUrl = toHttpUrl(sender?.tab?.url);
  return tabUrl ? [tabUrl] : [];
}

/**
 * 站点实例里绑定所需的能力（用结构化类型，避免依赖 @ptd/site 的具体类）。
 *
 * 优先复用 D2 的 `isTrustedSiteUrl`（与 `isTrustedDownloadLink`/`request()` 的 E3-1 同源校验
 * 共用 `trustedHostnames` + `siteHostMatches`，并包含站点定义对「兄弟 API 主机」的覆写，
 * 例如 mteam 的 `api.m-team.cc`）。老实例没有该方法时回落到 `isTrustedDownloadLink`。
 */
interface ISenderBindableSite {
  metadata: { id: string };
  isTrustedSiteUrl?(url: string): boolean;
  isTrustedDownloadLink?(link: string): boolean;
}

function getSiteUrlTrustChecker(site: ISenderBindableSite): ((url: string) => boolean) | null {
  if (typeof site.isTrustedSiteUrl === "function") {
    return (url) => site.isTrustedSiteUrl!(url);
  }
  if (typeof site.isTrustedDownloadLink === "function") {
    return (url) => site.isTrustedDownloadLink!(url);
  }
  return null;
}

/**
 * 断言发送方页面属于该站点；不属于时抛出 `Permission denied`。
 *
 * - 扩展页：放行（options/offscreen/background 是可信上下文）；
 * - content script：`sender.url` / `sender.tab.url` 至少一个必须落在站点可信 host 内
 *   （协议白名单 + trustedHostnames：用户自定义 url / metadata.urls / metadata.legacyUrls，
 *   以及站点定义显式声明的兄弟 API 主机）；
 * - 无 http(s) URL 的发送方（about:blank iframe、被篡改的 sender）：拒绝。
 */
export function assertSenderMatchesSite(site: ISenderBindableSite, sender: TMessageSender): void {
  // 本地同上下文调用（messages.ts 的 localHandler 快捷路径不带 sender）：扩展代码自己调用自己，直接放行。
  if (typeof sender === "undefined") {
    return;
  }

  // P1-1（并行审查）：先 fail-closed 校验「发送方属于本扩展」。外部扩展的 sender 在
  // `isExtensionPageSender` / `isContentScriptSender` 里都判 false（id 不匹配），旧调用点用
  // `isContentScriptSender` 做条件时会直接跳过绑定，等于任意扩展可拿本站凭据。
  const runtimeId = getChromeRuntime()?.id;
  if (!sender || !runtimeId || sender.id !== runtimeId) {
    throw new Error(`Permission denied: message sender is not this extension for site ${site.metadata.id}`);
  }

  if (isExtensionPageSender(sender)) {
    return;
  }

  const isTrustedUrl = getSiteUrlTrustChecker(site);
  if (!isTrustedUrl) {
    // 站点实例不支持同源判定时 fail-closed，而不是静默放行。
    throw new Error(`Permission denied: site ${site.metadata.id} does not support sender host verification`);
  }

  const senderUrls = getSenderPageHttpUrls(sender);
  if (senderUrls.length === 0) {
    throw new Error(`Permission denied: sender page is not a verifiable site page for site ${site.metadata.id}`);
  }

  if (!senderUrls.some((url) => isTrustedUrl(url))) {
    throw new Error(`Permission denied: sender page is not on the site host allowlist of ${site.metadata.id}`);
  }
}
