import { onMessage, sendMessage } from "@/messages.ts";
import {
  buildSuggestedDownloadFilename,
  DEFAULT_UPDATE_CHECK_CONFIG,
  extractVersion,
  getBrowserExtensionsPageUrl,
  hasUnignoredUpdate,
  isTrustedUpdateUrl,
  parseGitHubReleaseApi,
  parseReleaseManifest,
  reconcileUpdateCheckState,
  UPDATE_CHECK_STATE_STORAGE_KEY,
  UPDATE_RELEASE_API_URL,
  UPDATE_RELEASE_MANIFEST_URL,
  type IDownloadUpdateResult,
  type IOpenExtensionsPageResult,
  type IUpdateCheckConfig,
  type IUpdateCheckState,
  type IUpdateReleaseInfo,
  type TUpdateBrowserTarget,
} from "@/shared/updateCheck.ts";

import { getExtStoragePathCached, logBackgroundError, openOptionsPage } from "./base.ts";
import { showNotificationSafely } from "./contextMenus.ts";

const UPDATE_FETCH_TIMEOUT_MS = 12_000;
const UPDATE_NOTIFICATION_PREFIX = "ptd-ext-update:";
const BADGE_COLOR = "#1677ff";
const BADGE_TEXT_COLOR = "#ffffff";

let inFlightCheck: Promise<IUpdateCheckState> | null = null;

function getBrowserTarget(): TUpdateBrowserTarget {
  return typeof __BROWSER__ !== "undefined" && __BROWSER__ === "firefox" ? "firefox" : "chrome";
}

export function getCurrentExtensionVersion(): string {
  const manifestVersion = globalThis.chrome?.runtime?.getManifest?.()?.version;
  if (typeof manifestVersion === "string" && manifestVersion.trim()) {
    return extractVersion(manifestVersion) ?? manifestVersion.trim();
  }
  const buildVersion = typeof __EXT_VERSION__ !== "undefined" ? __EXT_VERSION__ : "";
  return extractVersion(buildVersion) ?? "0.0.0";
}

async function readUpdateCheckConfig(): Promise<IUpdateCheckConfig> {
  try {
    const raw = (await getExtStoragePathCached("config", "updateCheck", undefined as unknown)) as
      Partial<IUpdateCheckConfig> | undefined;
    const intervalHours =
      typeof raw?.intervalHours === "number" && Number.isFinite(raw.intervalHours) && raw.intervalHours >= 1
        ? raw.intervalHours
        : DEFAULT_UPDATE_CHECK_CONFIG.intervalHours;
    return {
      enabled: typeof raw?.enabled === "boolean" ? raw.enabled : DEFAULT_UPDATE_CHECK_CONFIG.enabled,
      intervalHours,
      notifyBrowser:
        typeof raw?.notifyBrowser === "boolean" ? raw.notifyBrowser : DEFAULT_UPDATE_CHECK_CONFIG.notifyBrowser,
      ignoredVersion: typeof raw?.ignoredVersion === "string" ? raw.ignoredVersion.trim() : "",
    };
  } catch (e) {
    logBackgroundError("Failed to read updateCheck config", e);
    return { ...DEFAULT_UPDATE_CHECK_CONFIG };
  }
}

async function loadStoredUpdateState(): Promise<IUpdateCheckState | null> {
  try {
    const stored = await globalThis.chrome?.storage?.local?.get(UPDATE_CHECK_STATE_STORAGE_KEY);
    const raw = stored?.[UPDATE_CHECK_STATE_STORAGE_KEY];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return null;
    }
    return raw as IUpdateCheckState;
  } catch (e) {
    logBackgroundError("Failed to read update check state", e);
    return null;
  }
}

async function persistUpdateState(state: IUpdateCheckState): Promise<void> {
  try {
    await globalThis.chrome?.storage?.local?.set({ [UPDATE_CHECK_STATE_STORAGE_KEY]: state });
  } catch (e) {
    logBackgroundError("Failed to persist update check state", e);
  }
}

export async function syncUpdateActionBadge(state?: IUpdateCheckState | null, ignoredVersion?: string): Promise<void> {
  const action = globalThis.chrome?.action;
  if (!action || typeof action.setBadgeText !== "function") {
    return;
  }
  try {
    const resolvedState =
      state !== undefined
        ? reconcileUpdateCheckState(state, getCurrentExtensionVersion())
        : reconcileUpdateCheckState(await loadStoredUpdateState(), getCurrentExtensionVersion());
    const resolvedIgnored =
      ignoredVersion !== undefined ? ignoredVersion : (await readUpdateCheckConfig()).ignoredVersion;

    if (hasUnignoredUpdate(resolvedState, resolvedIgnored)) {
      await action.setBadgeText({ text: "NEW" });
      if (typeof action.setBadgeBackgroundColor === "function") {
        await action.setBadgeBackgroundColor({ color: BADGE_COLOR });
      }
      if (typeof action.setBadgeTextColor === "function") {
        await action.setBadgeTextColor({ color: BADGE_TEXT_COLOR });
      }
    } else {
      await action.setBadgeText({ text: "" });
    }
  } catch (e) {
    logBackgroundError("Failed to sync extension update badge", e);
  }
}

async function fetchJsonWithTimeout(
  url: string,
  headers: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPDATE_FETCH_TIMEOUT_MS);
  try {
    return await fetchImpl(url, {
      method: "GET",
      headers,
      cache: "no-store",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 优先请求随 Release 发布的静态清单 `latest.json`（无 GitHub API 匿名限流），
 * 缺失（404）或不可解析时自动回退到 GitHub Releases API。
 */
export async function fetchLatestReleaseInfo(
  target: TUpdateBrowserTarget = getBrowserTarget(),
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
): Promise<IUpdateReleaseInfo> {
  try {
    const manifestResp = await fetchJsonWithTimeout(
      UPDATE_RELEASE_MANIFEST_URL,
      { Accept: "application/json" },
      fetchImpl,
    );
    if (manifestResp.ok) {
      const manifestJson: unknown = await manifestResp.json();
      const parsedManifest = parseReleaseManifest(manifestJson, target);
      if (parsedManifest) {
        return parsedManifest;
      }
    }
  } catch {
    // 静态清单尚未上传或拉取失败时自动回退 GitHub Releases API
  }

  const apiResp = await fetchJsonWithTimeout(
    UPDATE_RELEASE_API_URL,
    { Accept: "application/vnd.github+json" },
    fetchImpl,
  );
  if (!apiResp.ok) {
    if (apiResp.status === 403 && apiResp.headers?.get?.("x-ratelimit-remaining") === "0") {
      throw new Error("GitHub API rate limit exceeded (HTTP 403)");
    }
    throw new Error(`HTTP ${apiResp.status} ${apiResp.statusText}`.trim());
  }

  const apiJson: unknown = await apiResp.json();
  const parsedApi = parseGitHubReleaseApi(apiJson, target);
  if (!parsedApi) {
    throw new Error("Invalid GitHub release metadata");
  }
  return parsedApi;
}

function showUpdateNotification(latest: IUpdateReleaseInfo, currentVersion: string): void {
  const iconUrl = globalThis.chrome?.runtime?.getURL?.("icons/logo/128.png") ?? "";
  const extTitle = globalThis.chrome?.i18n?.getMessage?.("extName") || "chenbinPT";
  const localizedTitle = globalThis.chrome?.i18n?.getMessage?.("notificationUpdateAvailableTitle", [
    `v${latest.version}`,
  ]);
  const localizedBody = globalThis.chrome?.i18n?.getMessage?.("notificationUpdateAvailableBody", [
    `v${currentVersion}`,
    `v${latest.version}`,
  ]);

  const notificationId = `${UPDATE_NOTIFICATION_PREFIX}${latest.version}`;
  const create = globalThis.chrome?.notifications?.create;
  const options: chrome.notifications.NotificationCreateOptions = {
    type: "basic",
    iconUrl,
    title: localizedTitle || `${extTitle} v${latest.version}`,
    message: localizedBody || `v${currentVersion} → v${latest.version}`,
  };

  if (typeof create === "function") {
    try {
      const result = create(notificationId, options);
      if (result && typeof (result as unknown as Promise<unknown>).catch === "function") {
        void (result as unknown as Promise<unknown>).catch((e) =>
          logBackgroundError("Failed to create update notification", e),
        );
      }
      return;
    } catch (e) {
      logBackgroundError("Failed to create keyed update notification", e);
    }
  }
  showNotificationSafely(options);
}

export async function getUpdateCheckState(): Promise<IUpdateCheckState> {
  const currentVersion = getCurrentExtensionVersion();
  const stored = await loadStoredUpdateState();
  const reconciled = reconcileUpdateCheckState(stored, currentVersion);
  // 若本地已升级到 >= latest.version，把修正后的状态写回并清掉旧角标
  if (stored && stored.status !== reconciled.status) {
    await persistUpdateState(reconciled);
  }
  await syncUpdateActionBadge(reconciled);
  return reconciled;
}

export async function performExtensionUpdateCheck(options?: {
  force?: boolean;
  isScheduled?: boolean;
  fetchImpl?: typeof fetch;
}): Promise<IUpdateCheckState> {
  const force = Boolean(options?.force);
  const isScheduled = Boolean(options?.isScheduled);
  const currentVersion = getCurrentExtensionVersion();
  const config = await readUpdateCheckConfig();

  if (isScheduled && !config.enabled) {
    return await getUpdateCheckState();
  }

  const stored = await loadStoredUpdateState();
  const reconciledStored = reconcileUpdateCheckState(stored, currentVersion);
  const now = Date.now();
  const intervalMs = Math.max(1, config.intervalHours) * 60 * 60 * 1000;

  if (!force && reconciledStored.checkedAt > 0 && now - reconciledStored.checkedAt < intervalMs) {
    await syncUpdateActionBadge(reconciledStored, config.ignoredVersion);
    return reconciledStored;
  }

  if (inFlightCheck) {
    return await inFlightCheck;
  }

  const task = (async (): Promise<IUpdateCheckState> => {
    const checkedAt = Date.now();
    try {
      const latest = await fetchLatestReleaseInfo(getBrowserTarget(), options?.fetchImpl);
      const nextBase = reconcileUpdateCheckState(
        {
          currentVersion,
          checkedAt,
          status: "up-to-date",
          latest,
          lastNotifiedVersion: stored?.lastNotifiedVersion,
        },
        currentVersion,
      );

      if (
        config.notifyBrowser &&
        hasUnignoredUpdate(nextBase, config.ignoredVersion) &&
        nextBase.latest &&
        nextBase.lastNotifiedVersion !== nextBase.latest.version
      ) {
        showUpdateNotification(nextBase.latest, currentVersion);
        nextBase.lastNotifiedVersion = nextBase.latest.version;
      }

      await persistUpdateState(nextBase);
      await syncUpdateActionBadge(nextBase, config.ignoredVersion);

      sendMessage("logger", {
        msg:
          nextBase.status === "update-available" && nextBase.latest
            ? `Extension update available: v${currentVersion} -> v${nextBase.latest.version}`
            : `Extension is up to date (v${currentVersion}).`,
      }).catch(() => undefined);

      return nextBase;
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : String(e);
      logBackgroundError("Extension update check failed", e);
      const errorState: IUpdateCheckState = {
        currentVersion,
        checkedAt,
        status: "error",
        ...(reconciledStored.latest ? { latest: reconciledStored.latest } : {}),
        ...(stored?.lastNotifiedVersion ? { lastNotifiedVersion: stored.lastNotifiedVersion } : {}),
        error: errorMessage,
      };
      await persistUpdateState(errorState);
      return errorState;
    }
  })();

  inFlightCheck = task;
  try {
    return await task;
  } finally {
    if (inFlightCheck === task) {
      inFlightCheck = null;
    }
  }
}

export async function downloadExtensionUpdate(data?: {
  url?: string;
  filename?: string;
}): Promise<IDownloadUpdateResult> {
  const state = await getUpdateCheckState();
  const targetUrl = (data?.url ?? state.latest?.asset?.url ?? "").trim();
  if (!isTrustedUpdateUrl(targetUrl)) {
    throw new Error("Untrusted update download URL");
  }

  const version = state.latest?.version ?? state.currentVersion;
  const rawName = data?.filename ?? state.latest?.asset?.name;
  const filename = buildSuggestedDownloadFilename(rawName, version);

  const downloadId = await globalThis.chrome.downloads.download({
    url: targetUrl,
    filename,
    saveAs: false,
    conflictAction: "uniquify",
  });
  return { downloadId, filename };
}

export async function openBrowserExtensionsPage(): Promise<IOpenExtensionsPageResult> {
  const url = getBrowserExtensionsPageUrl(getBrowserTarget(), globalThis.navigator?.userAgent ?? "");
  try {
    if (typeof globalThis.chrome?.tabs?.create === "function") {
      await globalThis.chrome.tabs.create({ url });
      return { opened: true, url };
    }
    return { opened: false, url };
  } catch {
    return { opened: false, url };
  }
}

// 注册跨上下文消息（均列于 extensionPageOnlyMessages，禁止内容脚本调用）
onMessage("getUpdateCheckState", async () => {
  return await getUpdateCheckState();
});

onMessage("checkExtensionUpdate", async ({ data }) => {
  return await performExtensionUpdateCheck({ force: data?.force ?? true });
});

onMessage("downloadExtensionUpdate", async ({ data }) => {
  return await downloadExtensionUpdate(data);
});

onMessage("openBrowserExtensionsPage", async () => {
  return await openBrowserExtensionsPage();
});

// MV3 要求在顶层同步注册通知点击监听：点击更新通知后直达「版本更新」页
if (typeof globalThis.chrome?.notifications?.onClicked?.addListener === "function") {
  globalThis.chrome.notifications.onClicked.addListener((notificationId) => {
    if (!notificationId.startsWith(UPDATE_NOTIFICATION_PREFIX)) {
      return;
    }
    openOptionsPage("/set-base/update");
    try {
      const clearResult = globalThis.chrome.notifications.clear(notificationId);
      if (clearResult && typeof (clearResult as unknown as Promise<unknown>).catch === "function") {
        void (clearResult as unknown as Promise<unknown>).catch(() => undefined);
      }
    } catch {
      // 忽略清理通知失败
    }
  });
}

// 忽略版本或更新配置变化时自动同步工具栏角标
if (typeof globalThis.chrome?.storage?.onChanged?.addListener === "function") {
  globalThis.chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "local" && ("config" in changes || UPDATE_CHECK_STATE_STORAGE_KEY in changes)) {
      void syncUpdateActionBadge();
    }
  });
}

// SW 启动时校准一次状态与角标（不发网络请求）
void getUpdateCheckState().catch(() => undefined);
