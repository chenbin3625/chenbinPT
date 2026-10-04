/**
 * 关于 logger 方法记录
 * 在 background 等其他页面中， 请使用 sendMessage("logger", {}) 并挂上错误处理
 * （例如 background/utils/base.ts 的 logBackgroundError），不要用裸 .catch() 静默吞掉失败。
 * 在 offscreen 中， 请使用 logger({}) 直接调用
 *
 * 性能说明（见 docs/performance-audit.md P1-2）：
 * 早期实现使用 `useSessionStorage`，其底层是 `useStorage` 的 deep watch，
 * 每次 push 都会把整个日志数组 `JSON.stringify` 后写入 sessionStorage。
 * 日志数组上限 500 条且经常携带大对象（站点配置、下载请求配置等），
 * 导致单条日志的写入成本随数组增长而线性上升（实测 500 条累计序列化 ~80MB）。
 *
 * 现改为「内存环形缓冲 + 节流批量落盘」：
 * - 内存数组始终是唯一事实来源，读取零成本；
 * - 写入按 500ms 节流合并，最多丢失最近 500ms 的日志；
 * - 超过 PENDING_FLUSH_THRESHOLD 条未落盘时立即落盘，避免崩溃时丢失过多日志；
 * - 落盘失败（如 QuotaExceeded）时丢弃一半最旧日志后重试一次。
 *
 * 另见 L-7：写入缓冲前会对 `msg` 与 `data` 里的 URL 做 query 脱敏
 * （下载链接可能形如 `/api/torrent/download1?token=…`，不能把 token 明文长期留在 sessionStorage 里）。
 */
import { nanoid } from "nanoid";

import { onMessage } from "@/messages.ts";
import type { ILoggerItem } from "@/shared/types.ts";

const MAX_LOGGER_LENGTH = 500;
const STORAGE_KEY = "logger";
const FLUSH_DELAY = 500;
const PENDING_FLUSH_THRESHOLD = 50;

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

/** 抹掉单个 URL 的 query 值，保留 path、query 键名与 hash */
function redactUrlQuery(url: string): string {
  const queryIndex = url.indexOf("?");
  if (queryIndex < 0) {
    return url;
  }

  const path = url.slice(0, queryIndex);
  const rawQuery = url.slice(queryIndex + 1);
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

/** 把文本里所有 URL 的 query 值替换为 `***` */
export function redactSensitiveUrls(text: string): string {
  return text.replace(URL_WITH_QUERY_PATTERN, (matched) => {
    const trailing = TRAILING_PUNCTUATION_PATTERN.exec(matched)?.[0] ?? "";
    const url = trailing ? matched.slice(0, -trailing.length) : matched;
    return redactUrlQuery(url) + trailing;
  });
}

const MAX_REDACT_DEPTH = 6;

/** 只处理普通对象（字面量 / 无原型对象）：其它对象（Date、Map、类实例…）保持原样 */
function isPlainContainer(value: object): boolean {
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

/**
 * 递归脱敏日志载荷里的字符串。
 *
 * 只下探普通对象与数组，并保持原型：既覆盖了所有实际调用点传入的普通数据，
 * 又不会因为「复制」而改变 Date/Map/类实例等对象在日志里的既有形状与序列化结果。
 */
function redactSensitiveData(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") {
    return redactSensitiveUrls(value);
  }
  if (value === null || typeof value !== "object" || depth >= MAX_REDACT_DEPTH) {
    return value;
  }
  if (!Array.isArray(value) && !isPlainContainer(value)) {
    return value;
  }
  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveData(item, depth + 1, seen));
  }

  const output = Object.create(Object.getPrototypeOf(value) as object | null) as Record<string, unknown>;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    output[key] = redactSensitiveData(item, depth + 1, seen);
  }
  return output;
}

const loggerItems: ILoggerItem[] = [];
let loaded = false;
let pendingWrites = 0;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function loadOnce() {
  if (loaded) {
    return;
  }
  loaded = true;

  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        loggerItems.push(...(parsed.slice(-MAX_LOGGER_LENGTH) as ILoggerItem[]));
      }
    }
  } catch (e) {
    console.warn("[PTD] logger restore failed:", e);
  }
}

function flush() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }

  pendingWrites = 0;

  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(loggerItems));
  } catch (e) {
    // 常见于 QuotaExceededError：丢弃一半最旧日志后重试一次，优先保留最新日志
    loggerItems.splice(0, Math.ceil(loggerItems.length / 2));
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(loggerItems));
    } catch {
      // 仍然失败则放弃本次写入（日志记录失败不应影响主流程）
    }
    console.warn("[PTD] logger flush failed, trimmed history:", e);
  }
}

function scheduleFlush() {
  pendingWrites += 1;
  if (pendingWrites >= PENDING_FLUSH_THRESHOLD) {
    flush();
    return;
  }

  if (flushTimer === null) {
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flush();
    }, FLUSH_DELAY);
  }
}

export function getLoggerItems(): ILoggerItem[] {
  loadOnce();
  return loggerItems;
}

export function clearLoggerItems() {
  loadOnce();
  loggerItems.length = 0;
  flush();
}

export function logger(data: ILoggerItem) {
  try {
    data.id ??= nanoid();
    data.time ??= new Date().getTime();
    // 落盘前先脱敏（见 L-7）：msg 与 data 里的 URL query 值一律替换为 ***，避免 token 明文长期驻留
    data.msg = data.msg ? redactSensitiveUrls(data.msg.trim()) : data.msg;
    if (typeof data.data !== "undefined") {
      data.data = redactSensitiveData(data.data);
    }

    loadOnce();

    loggerItems.push(data);
    if (loggerItems.length > MAX_LOGGER_LENGTH) {
      loggerItems.splice(0, loggerItems.length - MAX_LOGGER_LENGTH);
    }

    scheduleFlush();
  } catch (e) {
    // 日志记录失败不应影响主流程（如传入不可序列化数据、sessionStorage 写入异常等）
    console.error("[PTD] logger failed:", e);
  }
}

onMessage("logger", ({ data }) => logger(data));
onMessage("getLogger", async () => getLoggerItems());
onMessage("clearLogger", async () => clearLoggerItems());
