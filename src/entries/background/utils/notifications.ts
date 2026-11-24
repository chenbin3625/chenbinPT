import type { IAlertConfig, IAlertWebhookConfig } from "@/shared/types/storages/config.ts";
import type { IAccountHealthAlert } from "@/shared/accountHealth.ts";
import { onMessage } from "@/messages.ts";

import { getExtStoragePathCached, logBackgroundError } from "./base.ts";
import { showNotificationSafely } from "./contextMenus.ts";

const ALERT_DEDUPE_STORAGE_KEY = "ptd_alertNotifyAt";
const ALERT_DEDUPE_WINDOW_MS = 6 * 60 * 60 * 1000; // 6 小时同 key 去重
const WEBHOOK_TIMEOUT_MS = 10_000;

const alertNotifyAt = new Map<string, number>();

async function loadAlertNotifyAt(): Promise<void> {
  try {
    const stored = await chrome.storage?.session?.get(ALERT_DEDUPE_STORAGE_KEY);
    const value = stored?.[ALERT_DEDUPE_STORAGE_KEY] as Record<string, unknown> | undefined;
    if (!value || typeof value !== "object") return;
    const now = Date.now();
    for (const [key, at] of Object.entries(value)) {
      if (typeof at === "number" && now - at < ALERT_DEDUPE_WINDOW_MS && at > (alertNotifyAt.get(key) ?? 0)) {
        alertNotifyAt.set(key, at);
      }
    }
  } catch {
    // session storage 不可用时退回内存 Map
  }
}

async function persistAlertNotifyAt(): Promise<void> {
  try {
    const now = Date.now();
    const pruned: Record<string, number> = {};
    for (const [key, at] of alertNotifyAt.entries()) {
      if (now - at < ALERT_DEDUPE_WINDOW_MS) {
        pruned[key] = at;
      } else {
        alertNotifyAt.delete(key);
      }
    }
    await chrome.storage?.session?.set({ [ALERT_DEDUPE_STORAGE_KEY]: pruned });
  } catch {
    // 忽略持久化失败
  }
}

function parseSafeHttpUrl(raw: string): URL | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function dispatchWebhookAlert(
  webhook: IAlertWebhookConfig | undefined,
  title: string,
  message: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!webhook || webhook.type === "none") {
    return { ok: false, error: "Webhook is not enabled" };
  }

  let targetUrl: URL | null = null;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  let body: Record<string, unknown> = {};

  if (webhook.type === "telegram") {
    const token = webhook.secret?.trim() ?? "";
    const chatId = webhook.chatId?.trim() ?? "";
    if (!chatId) {
      return { ok: false, error: "Telegram chatId is required" };
    }
    const rawUrl = webhook.url?.trim() ?? "";
    if (rawUrl) {
      const parsed = parseSafeHttpUrl(rawUrl);
      if (!parsed) return { ok: false, error: "Invalid Telegram webhook URL" };
      if (parsed.pathname.includes("/sendMessage")) {
        targetUrl = parsed;
      } else if (token) {
        targetUrl = new URL(`/bot${encodeURIComponent(token)}/sendMessage`, parsed.origin);
      } else {
        return { ok: false, error: "Telegram bot token is required" };
      }
    } else if (token) {
      targetUrl = new URL(`https://api.telegram.org/bot${encodeURIComponent(token)}/sendMessage`);
    } else {
      return { ok: false, error: "Telegram bot token or full URL is required" };
    }
    body = {
      chat_id: chatId,
      text: `${title}\n${message}`,
    };
  } else if (webhook.type === "bark") {
    const base = parseSafeHttpUrl(webhook.url ?? "");
    if (!base) return { ok: false, error: "Invalid Bark URL" };
    const secret = webhook.secret?.trim();
    if (secret && !base.pathname.includes(secret)) {
      const baseHref = base.href.endsWith("/") ? base.href : `${base.href}/`;
      targetUrl = new URL(`${encodeURIComponent(secret)}/`, baseHref);
    } else {
      targetUrl = base;
    }
    body = {
      title,
      body: message,
      group: "chenbinPT",
    };
  } else {
    // generic webhook
    targetUrl = parseSafeHttpUrl(webhook.url ?? "");
    if (!targetUrl) return { ok: false, error: "Invalid webhook URL" };
    if (webhook.secret?.trim()) {
      headers.Authorization = `Bearer ${webhook.secret.trim()}`;
    }
    body = {
      title,
      message,
      source: "chenbinPT",
      timestamp: Date.now(),
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
  try {
    const resp = await fetch(targetUrl.href, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!resp.ok) {
      return { ok: false, error: `HTTP ${resp.status} ${resp.statusText}`.trim() };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

export async function notifyAccountHealthAlerts(
  alerts: IAccountHealthAlert[],
  alertsConfig: IAlertConfig,
): Promise<void> {
  if (!alertsConfig.enabled || alerts.length === 0) {
    return;
  }

  await loadAlertNotifyAt();
  const now = Date.now();
  const freshAlerts = alerts.filter((alert) => {
    const lastAt = alertNotifyAt.get(alert.key) ?? 0;
    return now - lastAt >= ALERT_DEDUPE_WINDOW_MS;
  });

  if (freshAlerts.length === 0) {
    return;
  }

  for (const alert of freshAlerts) {
    alertNotifyAt.set(alert.key, now);
  }
  await persistAlertNotifyAt();

  const iconUrl = chrome.runtime.getURL?.("icons/logo/128.png") ?? "";
  const extTitle = chrome.i18n?.getMessage?.("extName") || "chenbinPT";

  if (freshAlerts.length === 1) {
    const [single] = freshAlerts;
    showNotificationSafely({
      type: "basic",
      iconUrl,
      title: single.title,
      message: single.message,
    });
  } else {
    const summaryLines = freshAlerts.slice(0, 4).map((a) => `• ${a.message}`);
    if (freshAlerts.length > 4) {
      summaryLines.push(`… (+${freshAlerts.length - 4})`);
    }
    showNotificationSafely({
      type: "basic",
      iconUrl,
      title: `${extTitle} (${freshAlerts.length})`,
      message: summaryLines.join("\n"),
    });
  }

  if (alertsConfig.webhook && alertsConfig.webhook.type !== "none") {
    const title = freshAlerts.length === 1 ? freshAlerts[0].title : `${extTitle} 账号健康提醒 (${freshAlerts.length})`;
    const message = freshAlerts.map((a) => `[${a.siteName}] ${a.message}`).join("\n");
    const result = await dispatchWebhookAlert(alertsConfig.webhook, title, message);
    if (!result.ok) {
      logBackgroundError(`Failed to dispatch account health webhook: ${result.error}`);
    }
  }
}

onMessage("sendAlertWebhook", async ({ data }) => {
  const webhook =
    data.webhook ??
    ((await getExtStoragePathCached("config", "alerts.webhook", undefined as unknown)) as
      IAlertWebhookConfig | undefined);
  return await dispatchWebhookAlert(webhook, data.title, data.message);
});
