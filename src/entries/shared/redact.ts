/**
 * URL 脱敏工具（见审查报告 L-7 / OS-1 / A4）。
 *
 * 单独成模块的原因：logger、下载历史（IndexedDB/备份导出）与原生桥接（background）都要用
 * 同一套脱敏规则，而测试里经常整体 mock `logger.ts`；放在这里可以避免「脱敏函数随 logger 被 mock 掉」。
 *
 * 2026-10-23 复检（M1）：从 `src/entries/offscreen/utils/redact.ts` 迁移到 `src/entries/shared/`，
 * 让 background 的原生桥接也能复用（原生桥必须覆盖 NexusPHP 的 `&downhash=` 与 Rartracker 的
 * 路径内 passkey，而不是只认固定名字的 query 参数）。旧路径保留 re-export，历史 import 不受影响。
 */

/**
 * 日志脱敏（见 L-7）。
 *
 * 下载链路会记录完整的下载 URL（`download.ts` 的 "Download torrent file with … method: <uri>"），
 * 而部分站点的下载链接形如 `/api/torrent/download1?token=…`（如 yemapt），
 * 于是 token 明文会长期驻留在 sessionStorage 的环形缓冲里。
 * 这里在写入缓冲前统一把 URL 的 query **值**替换为 `***`：保留 path 与 query 的键名（排查问题够用），
 * 只抹掉值本身。
 *
 * 匹配范围刻意放宽到「绝对地址或站内相对路径」：相对路径形式的下载链接同样会出现在日志里。
 */
const URL_WITH_QUERY_PATTERN = /(?:https?:\/\/|\/)[^\s"'<>\\]+/g;

/** 自然语言标点不属于 URL：匹配后把它们留在原位，避免改写日志文本本身 */
const TRAILING_PUNCTUATION_PATTERN = /[.,;:!?)\]}'"]+$/;

/**
 * 路径里的凭据段：部分站点把 passkey/rsskey 直接放在路径里（如 Rartracker 的
 * `/api/v1/torrents/download/{id}/{passkey}`），只抹 query 值会让它原样进日志。
 * 判据刻意收窄为「≥20 位、只含字母数字、同时含字母与数字」的整段 —— 典型的 32 位十六进制 passkey
 * 会命中，而数字 id、普通单词、带扩展名的文件名（含 `.`）不会。
 */
const CREDENTIAL_LIKE_PATH_SEGMENT = /^(?=[A-Za-z0-9]*[A-Za-z])(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{20,}$/;

/**
 * URL authority 里的 userinfo 凭据（`https://user:pass@host/...`）。
 *
 * 2026-10-24 REVIEW-FINDINGS P2-2：旧实现只抹 query 值与路径凭据段，`user:pass@host` 会原样留存
 * （下载器地址、代理地址、站点 WebDAV/S3 端点都可能带 userinfo）。这里只匹配 authority 部分
 * （`//` 之后、第一个 `/ ? #` 之前且以 `@` 结尾），把 userinfo 整段替换为 `***` 并**保留 host**；
 * path 中普通的 `@`（如 `/user/@name`）不受影响。
 */
const URL_USERINFO_PATTERN = /^((?:[a-zA-Z][a-zA-Z0-9+.-]*:)?\/\/)[^/?#\s]*@/;

function redactUrlUserInfo(url: string): string {
  return url.replace(URL_USERINFO_PATTERN, "$1***@");
}

function redactUrlPath(path: string): string {
  return path
    .split("/")
    .map((segment) => (CREDENTIAL_LIKE_PATH_SEGMENT.test(segment) ? "***" : segment))
    .join("/");
}

/** 抹掉单个 URL 的 userinfo、query 值与路径中的凭据段，保留 host、path 结构、query 键名与 hash */
function redactUrlQuery(url: string): string {
  const safeUrl = redactUrlUserInfo(url);
  const queryIndex = safeUrl.indexOf("?");
  if (queryIndex < 0) {
    return redactUrlPath(safeUrl);
  }

  const path = redactUrlPath(safeUrl.slice(0, queryIndex));
  const rawQuery = safeUrl.slice(queryIndex + 1);
  const hashIndex = rawQuery.indexOf("#");
  const hash = hashIndex >= 0 ? rawQuery.slice(hashIndex) : "";
  const query = hashIndex >= 0 ? rawQuery.slice(0, hashIndex) : rawQuery;

  const redactedQuery = query
    .split("&")
    .map((pair) => {
      const equalIndex = pair.indexOf("=");
      return equalIndex < 0 ? pair : `${pair.slice(0, equalIndex)}=***`;
    })
    .join("&");

  return `${path}?${redactedQuery}${hash}`;
}

/** 把文本里所有 URL 的 userinfo / query 值 / 路径凭据段替换为 `***` */
export function redactSensitiveUrls(text: string): string {
  return text.replace(URL_WITH_QUERY_PATTERN, (matched) => {
    const trailing = TRAILING_PUNCTUATION_PATTERN.exec(matched)?.[0] ?? "";
    const url = trailing ? matched.slice(0, -trailing.length) : matched;
    return redactUrlQuery(url) + trailing;
  });
}
