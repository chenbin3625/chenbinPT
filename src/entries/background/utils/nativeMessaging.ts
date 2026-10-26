import { onMessage, sendMessage } from "@/messages.ts";
import { setupOffscreenDocument } from "./offscreen.ts";
import type { BridgeState, BridgeStatus } from "@/shared/types.ts";

const NATIVE_HOST_NAME = "com.ptd.native";
const INSTANCE_ID_KEY = "ptd_native_instance_id";
const ENABLED_KEY = "ptd_native_bridge_enabled";
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const MAX_RECONNECT_ATTEMPTS = 10;
/** 长延迟重连改用 alarms：可跨 service worker 回收存活（见 docs/performance-audit.md P1-8） */
const RECONNECT_ALARM_NAME = "nativeBridgeReconnect";

/** Errors that indicate the native host is not installed — no point retrying. */
const FATAL_ERRORS = [
  "Specified native messaging host not found.",
  "Access to the specified native messaging host is forbidden.",
];

/**
 * 原生宿主可调用的方法白名单（A4）。
 *
 * 原则：**只读 + 不返回任何凭据**。原生宿主是本机进程（仓库内没有它的实现，其访问控制无法验证），
 * 因此不能把「扩展页面级」能力整体交给它。本次收缩移除了：
 * - 凭据读取：`getSiteUserConfig`（inputSetting/runtimeSettings 含 passkey/authkey/token）、
 *   `getDownloaderConfig`（地址 + 用户名/密码）、`getTorrentDownloadLink` / `getTorrentInfoForVerification`
 *   （返回/使用带 authkey 的下载链接），以及会改变站点 favicon 缓存的 `clearSiteFaviconCache`；
 * - 破坏性写操作：`downloadTorrent`、`deleteDownloadHistoryById`、`clearDownloadHistory`、
 *   `removeSiteUserInfo`、`createKeepUploadTask` / `updateKeepUploadTask` / `deleteKeepUploadTask` /
 *   `clearKeepUploadTasks`、`cancelUserInfoQueue`（会打断用户正在进行的刷新）。
 * 写操作若将来确实需要由 CLI 触发，应由用户在打开的 options 页面显式确认后由扩展页发起，而不是经桥接静默执行。
 *
 * 纵深防御：即使列在这里的方法，返回值也会再经过 `sanitizeBridgeResult()` 深度脱敏
 * （敏感字段名 + URL 里的凭据查询参数），避免站点/下载器返回的对象夹带凭据。
 * 注意 sender→site 绑定（A2）由 offscreen 侧负责（B1），本文件只保证「桥接不再放大暴露面」。
 */
export const ALLOWED_METHODS = new Set([
  // 站点 / 搜索（只读，结果经脱敏）
  "getSiteList",
  "getSiteFavicon",
  "getSiteSearchResult",
  "getMediaServerSearchResult",
  // 媒体库条目详情（只读，与搜索结果同类数据；海报/头像是 data URL，令牌不进入 URL）。
  // 不开放 getMediaServerOverview：整库遍历有被服务器判定为滥用的风险，必须由用户在设置页显式确认后发起。
  "getMediaServerItemDetail",
  // 下载器状态（只读；不含配置/密码）
  "getDownloaderList",
  "getDownloaderVersion",
  "getDownloaderStatus",
  // 下载历史（只读，结果经脱敏；downloadRequestConfig 会被整体剔除）
  "getDownloadHistory",
  "getDownloadHistoryById",
  // 用户信息（只读或幂等刷新；不含凭据）
  "getSiteUserInfoResult",
  "getSiteUserInfo",
  // 辅种任务（只读；不开放 create/update/delete/clear）
  "getKeepUploadTasks",
  "getKeepUploadTaskById",
]);

/**
 * 结果里出现这些键名就整项剔除：凭据/会话/请求配置（`downloadRequestConfig` 可能含 Cookie、
 * Authorization 等敏感请求头，`addTorrentOptions` 同理）。
 */
const SENSITIVE_RESULT_KEY_PATTERN =
  /(?:passkey|pass_key|authkey|auth_key|torrent_?pass|token|password|passwd|secret|cookie|authorization|api[_-]?key|rsskey|csrf|inputsetting|runtimesettings|downloadrequestconfig|addtorrentoptions)/i;

/** URL/字符串里的凭据查询参数值统一替换为 `***`（保留参数名，避免改变结构）。 */
const SENSITIVE_QUERY_PARAM_PATTERN =
  /([?&](?:authkey|auth_key|torrent_pass|passkey|pass_key|token|apikey|api_key|rsskey|csrf|downhash)=)[^&#]*/gi;

const CREDENTIAL_LIKE_PATH_SEGMENT = /^(?=[A-Za-z0-9]*[A-Za-z])(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{20,}$/;
const URL_USERINFO_PATTERN = /^((?:[a-zA-Z][a-zA-Z0-9+.-]*:)?\/\/)[^/?#\s]*@/g;

function redactStringCredentials(text: string): string {
  let res = text.replace(URL_USERINFO_PATTERN, "$1***@");
  if (res.includes("/")) {
    res = res.replace(/(?:https?:\/\/[^/?#\s]+)?\/[^\s?#]*/g, (path) => {
      return path
        .split("/")
        .map((segment) => (CREDENTIAL_LIKE_PATH_SEGMENT.test(segment) ? "***" : segment))
        .join("/");
    });
  }
  return res.replace(SENSITIVE_QUERY_PARAM_PATTERN, "$1***");
}

const MAX_SANITIZE_DEPTH = 12;

/**
 * 桥接返回值的深度脱敏。
 *
 * 不是可选的「润色」：`getSiteSearchResult` 返回的 `torrent.link` 在 Gazelle 系站点上是
 * `...&authkey=…&torrent_pass=…`（见 `GazelleJSONAPI.ts`），NexusPHP 上是 `&downhash=...`，
 * Rartracker 上 passkey 在路径中，`getDownloadHistory` 还会带 `downloadRequestConfig`。
 * 这些字段如果原样发给原生宿主，等于把 A1/A2 的凭据泄漏面换了一条路径。
 */
export function sanitizeBridgeResult(
  value: unknown,
  seen: WeakMap<object, unknown> = new WeakMap(),
  inStack: WeakSet<object> = new WeakSet(),
  depth = 0,
): unknown {
  if (typeof value === "string") {
    return redactStringCredentials(value);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (depth > MAX_SANITIZE_DEPTH || inStack.has(value)) {
    return undefined;
  }
  if (seen.has(value)) {
    return seen.get(value);
  }

  inStack.add(value);

  if (Array.isArray(value)) {
    const arr: unknown[] = [];
    for (const item of value) {
      arr.push(sanitizeBridgeResult(item, seen, inStack, depth + 1));
    }
    inStack.delete(value);
    seen.set(value, arr);
    return arr;
  }

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_RESULT_KEY_PATTERN.test(key)) {
      continue;
    }
    const sanitized = sanitizeBridgeResult(item, seen, inStack, depth + 1);
    if (sanitized !== undefined) {
      out[key] = sanitized;
    }
  }
  inStack.delete(value);
  seen.set(value, out);
  return out;
}

const MAX_PARAMS_DEPTH = 8;

/** 只接受 JSON 可往返的「普通值」：拒绝 undefined/函数/symbol/bigint/类实例/超深嵌套。 */
function isBridgeParamValue(value: unknown, depth: number): boolean {
  if (value === null) {
    return true;
  }
  switch (typeof value) {
    case "string":
    case "number":
    case "boolean":
      return true;
    case "object":
      break;
    default:
      return false;
  }
  if (depth >= MAX_PARAMS_DEPTH) {
    return false;
  }
  if (Array.isArray(value)) {
    return value.every((item) => isBridgeParamValue(item, depth + 1));
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    return false;
  }
  return Object.values(value as Record<string, unknown>).every((item) => isBridgeParamValue(item, depth + 1));
}

/** 少数方法的标的 id 必须是固定基本类型，避免把任意对象塞进业务路径。 */
const REQUIRED_PRIMITIVE_PARAM: Partial<Record<string, "string" | "number">> = {
  getDownloaderVersion: "string",
  getDownloaderStatus: "string",
  getDownloadHistoryById: "number",
  getSiteUserInfo: "string",
  getKeepUploadTaskById: "string",
};

/** 返回错误文案表示不合法；`undefined` 表示通过。 */
export function validateBridgeParams(method: string, params: unknown): string | undefined {
  if (params !== undefined && !isBridgeParamValue(params, 0)) {
    return "params must be a JSON-serializable plain value";
  }
  const required = REQUIRED_PRIMITIVE_PARAM[method];
  if (required && typeof params !== required) {
    return `params for '${method}' must be a ${required}`;
  }
  return undefined;
}

// ── Module-scoped state ──────────────────────────────────────────────

let port: chrome.runtime.Port | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempt = 0;
/**
 * A4：默认**关闭**。桥接只在用户显式开启（options 页面开关）并授予 `nativeMessaging` 权限后才连接；
 * 旧实现默认 true 意味着用户一授予权限、宿主就被自动赋予上述能力，没有任何二次确认。
 */
let enabled = false;
let state: BridgeState = "no-permission";
let lastError: string | undefined;
let intentionalDisconnect = false;

/**
 * 桥接状态持久化（见 docs/performance-audit.md P1-8）。
 *
 * 早期实现把 reconnectAttempt/state/lastError 只放在模块内存里，
 * 而 MV3 的 service worker 会被回收：退避链会断掉、状态回落到初始值，
 * 导致 `nativeBridgeGetStatus` 结果在"回收前后"抖动。
 * 这里把关键状态放进 chrome.storage.session（随浏览器会话存活、不落盘）。
 */
const BRIDGE_STATE_KEY = "nativeBridgeState";

async function saveBridgeState(): Promise<void> {
  try {
    await chrome.storage?.session?.set({
      [BRIDGE_STATE_KEY]: { reconnectAttempt, enabled, state, lastError },
    });
  } catch {
    // session storage 不可用时不影响主流程
  }
}

async function loadBridgeState(): Promise<void> {
  try {
    const stored = await chrome.storage?.session?.get(BRIDGE_STATE_KEY);
    const value = stored?.[BRIDGE_STATE_KEY] as
      { reconnectAttempt?: number; enabled?: boolean; state?: BridgeState; lastError?: string } | undefined;
    if (value) {
      reconnectAttempt = value.reconnectAttempt ?? reconnectAttempt;
      enabled = value.enabled ?? enabled;
      state = value.state ?? state;
      lastError = value.lastError;
    }
  } catch {
    // ignore
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

async function getOrCreateInstanceId(): Promise<string> {
  const stored = await chrome.storage.local.get(INSTANCE_ID_KEY);
  const storedInstanceId = stored[INSTANCE_ID_KEY];

  if (typeof storedInstanceId === "string" && storedInstanceId.length > 0) {
    return storedInstanceId;
  }
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ [INSTANCE_ID_KEY]: id });
  return id;
}

async function checkPermission(): Promise<boolean> {
  try {
    return await chrome.permissions.contains({ permissions: ["nativeMessaging"] });
  } catch {
    return false;
  }
}

async function getStatus(): Promise<BridgeStatus> {
  const permissionGranted = await checkPermission();
  return {
    permissionGranted,
    enabled,
    state,
    connected: port !== null && state === "connected",
    lastError,
  };
}

function clearReconnectTimer() {
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

// ── Lifecycle ────────────────────────────────────────────────────────

function disconnect(intentional: boolean) {
  intentionalDisconnect = intentional;
  clearReconnectTimer();
  try {
    chrome.alarms?.clear(RECONNECT_ALARM_NAME);
  } catch {
    // ignore
  }
  reconnectAttempt = 0;
  void saveBridgeState();

  if (port) {
    try {
      port.disconnect();
    } catch {
      // Already disconnected — ignore
    }
    port = null;
  }
}

function scheduleReconnect() {
  clearReconnectTimer();
  reconnectAttempt++;

  if (reconnectAttempt > MAX_RECONNECT_ATTEMPTS) {
    state = "error";
    lastError = `Gave up after ${MAX_RECONNECT_ATTEMPTS} reconnect attempts`;
    void saveBridgeState();
    console.debug("[PTD] Native bridge exceeded max reconnect attempts, giving up.");
    return;
  }

  const delay = Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempt, RECONNECT_MAX_MS);
  state = "retrying";
  void saveBridgeState();
  console.debug(
    `[PTD] Native bridge reconnecting in ${delay}ms (attempt ${reconnectAttempt}/${MAX_RECONNECT_ATTEMPTS})...`,
  );

  // 较长延迟用 chrome.alarms 排程：SW 被回收后仍能唤醒并重连
  // （setTimeout 会随 SW 销毁而丢失，导致退避链断开）
  if (delay >= RECONNECT_MAX_MS) {
    try {
      chrome.alarms?.create(RECONNECT_ALARM_NAME, { when: Date.now() + delay });
      return;
    } catch {
      // alarms 不可用时退回 setTimeout
    }
  }

  reconnectTimer = setTimeout(connect, delay);
}

function connect() {
  if (!enabled) {
    return;
  }

  // 已存在连接时不再重复 connectNative（P1-8 修复的配套守卫）：
  // 启动恢复与权限/开关变更会先后调用 init()，重复连接会留下一条无人引用的 native port
  // （旧 port 的 onDisconnect 会因 port !== currentPort 被判定为 stale 而忽略，native 宿主进程无法回收）。
  if (port) {
    return;
  }

  clearReconnectTimer();
  state = "connecting";
  lastError = undefined;
  intentionalDisconnect = false;
  void saveBridgeState();

  let currentPort: chrome.runtime.Port;
  try {
    currentPort = chrome.runtime.connectNative(NATIVE_HOST_NAME);
    port = currentPort;
  } catch (e: any) {
    state = "error";
    lastError = e?.message ?? String(e);
    console.debug("[PTD] Native messaging host not available:", lastError);
    return;
  }

  // Send hello handshake — mark connected after successful send.
  // The native host does not send an ack, so a successful postMessage
  // is our best signal. If the host is absent, onDisconnect fires.
  getOrCreateInstanceId()
    .then((instanceId) => {
      if (port !== currentPort) return;

      try {
        currentPort.postMessage({
          type: "hello",
          instanceId,
          browser: __BROWSER__,
          extensionId: chrome.runtime.id,
          version: __EXT_VERSION__,
          capabilities: ["bridge-v1"],
        });
      } catch (e: any) {
        state = "error";
        lastError = e?.message ?? String(e);
        console.debug("[PTD] Failed to send native hello message:", lastError);
        return;
      }

      state = "connected";
      reconnectAttempt = 0;
    })
    .catch((e: any) => {
      if (port !== currentPort) return;
      state = "error";
      lastError = e?.message ?? String(e);
      console.debug("[PTD] Failed to get or create native instance id:", lastError);
      try {
        currentPort.disconnect();
      } catch {
        // ignore
      }
    });

  currentPort.onMessage.addListener(async (msg: any) => {
    if (msg?.type !== "request" || !msg.id || !msg.method) {
      return;
    }

    const { id, method, params } = msg;

    if (!ALLOWED_METHODS.has(method)) {
      currentPort.postMessage({
        type: "response",
        id,
        error: { code: "METHOD_NOT_ALLOWED", message: `Method '${method}' is not allowed` },
      });
      return;
    }

    // A4：桥接参数必须做形状校验 —— 旧实现把宿主传来的 params 原样塞进业务消息路径。
    const paramsError = validateBridgeParams(method, params);
    if (paramsError) {
      currentPort.postMessage({
        type: "response",
        id,
        error: { code: "INVALID_PARAMS", message: paramsError },
      });
      return;
    }

    try {
      await setupOffscreenDocument();
      const result = await sendMessage(method as any, params);
      if (port === currentPort) {
        // A4：返回值深度脱敏（URL 凭据参数、敏感字段名），避免把站点/下载器返回的凭据转给宿主。
        currentPort.postMessage({ type: "response", id, result: sanitizeBridgeResult(result) });
      }
    } catch (e: any) {
      if (port === currentPort) {
        currentPort.postMessage({
          type: "response",
          id,
          error: { code: "EXTENSION_ERROR", message: e?.message ?? String(e) },
        });
      }
    }
  });

  currentPort.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError;
    const errMsg = err?.message ?? "";

    // Stale port — a new connection has already replaced this one
    if (port !== currentPort) return;

    port = null;

    if (intentionalDisconnect) {
      return;
    }

    if (err) {
      console.debug("[PTD] Native messaging disconnected:", errMsg);
    }

    if (FATAL_ERRORS.some((e) => errMsg.includes(e))) {
      state = "error";
      lastError = errMsg;
      console.debug("[PTD] Native host not available, CLI bridge disabled.");
      return;
    }

    lastError = errMsg || "Connection lost";
    scheduleReconnect();
  });
}

async function init() {
  const permissionGranted = await checkPermission();

  // Refresh enabled flag
  // A4：默认关闭 —— 只有用户显式开启过（storage 里明确写入 true）才连接。
  const stored = await chrome.storage.local.get(ENABLED_KEY);
  enabled = stored[ENABLED_KEY] === true;

  if (!permissionGranted) {
    disconnect(true);
    state = "no-permission";
    lastError = undefined;
    await saveBridgeState();
    return;
  }

  if (!enabled) {
    disconnect(true);
    state = "disabled";
    lastError = undefined;
    return;
  }

  connect();
}

// ── Startup & runtime listeners ──────────────────────────────────────

/**
 * alarms 触发的长延迟重连（见 docs/performance-audit.md P1-8）。
 *
 * P1-8 修复：这段注册必须在模块顶层执行。早期重构把它误嵌进了下面的 permissions.onAdded
 * 回调里，于是 SW 每次冷启动都没有 alarm 监听者——30s 档的退避 alarm 到点无人处理，
 * 退避链会永久停住；而且用户之后授予权限时会再次把「恢复状态 + init()」跑一遍，与顶层
 * 启动流程并发连接。onAdded/onRemoved 恢复为只做 init()。
 */
chrome.alarms?.onAlarm?.addListener((alarm) => {
  if (alarm.name === RECONNECT_ALARM_NAME) {
    connect();
  }
});

chrome.permissions.onAdded?.addListener((permissions) => {
  if (permissions.permissions?.includes("nativeMessaging")) {
    void init();
  }
});

chrome.permissions.onRemoved?.addListener((permissions) => {
  if (permissions.permissions?.includes("nativeMessaging")) {
    void init();
  }
});

// ── Message handlers ─────────────────────────────────────────────────

onMessage("nativeBridgeGetStatus", async () => {
  return getStatus();
});

onMessage("nativeBridgeSetEnabled", async ({ data }) => {
  if (typeof data !== "boolean") {
    return getStatus();
  }
  await chrome.storage.local.set({ [ENABLED_KEY]: data });
  await init();
  if (state === "connecting") {
    await new Promise((r) => setTimeout(r, 200));
  }
  return getStatus();
});

onMessage("nativeBridgeReconnect", async () => {
  const permissionGranted = await checkPermission();
  if (!permissionGranted) {
    lastError = "Permission not granted — cannot reconnect";
    return getStatus();
  }
  if (!enabled) {
    lastError = "Bridge is disabled — cannot reconnect";
    return getStatus();
  }

  disconnect(true);
  connect();
  await saveBridgeState();
  return getStatus();
});

// ── Startup ──────────────────────────────────────────────────────────

/**
 * SW 冷启动：先恢复上次的状态（session），再按恢复出的 enabled / 退避次数建立连接。
 *
 * P1-8 修复：这段恢复逻辑必须在顶层只执行一次（否则 SW 每次启动都会丢掉保存的
 * reconnectAttempt/state/enabled/lastError，退避与状态展示在回收前后抖动）。
 * 权限变更仍由上面的 onAdded/onRemoved 监听器负责，connect() 对已有 port 幂等。
 */
void (async () => {
  await loadBridgeState();
  await init();
})();
