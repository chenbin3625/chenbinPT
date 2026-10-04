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

/** Methods the bridge will proxy to sendMessage(). Everything else is rejected. */
const ALLOWED_METHODS = new Set([
  // Site config
  "getSiteList",
  "getSiteUserConfig",
  "getSiteFavicon",
  "clearSiteFaviconCache",
  // Search
  "getSiteSearchResult",
  "getMediaServerSearchResult",
  // Download and downloader
  "getDownloaderList",
  "getDownloaderConfig",
  "getDownloaderVersion",
  "getDownloaderStatus",
  "getTorrentDownloadLink",
  "getTorrentInfoForVerification",
  "downloadTorrent",
  "getDownloadHistory",
  "getDownloadHistoryById",
  "deleteDownloadHistoryById",
  "clearDownloadHistory",
  // User info
  "getSiteUserInfoResult",
  "cancelUserInfoQueue",
  "getSiteUserInfo",
  "removeSiteUserInfo",
  // Keep-upload
  "getKeepUploadTasks",
  "getKeepUploadTaskById",
  "createKeepUploadTask",
  "updateKeepUploadTask",
  "deleteKeepUploadTask",
  "clearKeepUploadTasks",
]);

// ── Module-scoped state ──────────────────────────────────────────────

let port: chrome.runtime.Port | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempt = 0;
let enabled = true;
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

    try {
      await setupOffscreenDocument();
      const result = await sendMessage(method as any, params);
      if (port === currentPort) {
        currentPort.postMessage({ type: "response", id, result });
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
  const stored = await chrome.storage.local.get(ENABLED_KEY);
  enabled = stored[ENABLED_KEY] !== false; // default true

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
