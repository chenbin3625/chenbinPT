<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { EResultParseStatus } from "@ptd/site";

import { sendMessage } from "@/messages.ts";
import { computeSiteInactivityInfo } from "@/shared/accountHealth.ts";
import { formatSize } from "@/options/utils.ts";
import type { IConfigPiniaStorageSchema } from "@/shared/types/storages/config.ts";
import type { IMetadataPiniaStorageSchema, IDownloaderMetadata } from "@/shared/types/storages/metadata.ts";

interface IDownloaderLiveCard {
  id: string;
  name: string;
  upSpeed: number;
  dlSpeed: number;
  freeSpace: number | "N/A";
  online: boolean;
}

const { t, locale } = useI18n();

const isDark = ref<boolean>(false);
const loading = ref<boolean>(true);
const searchInput = ref<string>("");

const downloaderCards = ref<IDownloaderLiveCard[]>([]);
const siteCount = ref<number>(0);
const unreadMessageCount = ref<number>(0);
const abnormalSiteCount = ref<number>(0);
const inactiveWarningCount = ref<number>(0);

const totalUpSpeed = computed(() => downloaderCards.value.reduce((acc, d) => acc + d.upSpeed, 0));
const totalDlSpeed = computed(() => downloaderCards.value.reduce((acc, d) => acc + d.dlSpeed, 0));

function resolveDark(theme?: string): boolean {
  if (theme === "dark") return true;
  if (theme === "light") return false;
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches;
}

async function loadData() {
  loading.value = true;
  try {
    const [config, metadata] = await Promise.all([
      sendMessage("getExtStorage", "config") as Promise<Partial<IConfigPiniaStorageSchema> | null>,
      sendMessage("getExtStorage", "metadata") as Promise<Partial<IMetadataPiniaStorageSchema> | null>,
    ]);

    if (config?.lang) {
      locale.value = config.lang;
    }
    isDark.value = resolveDark(config?.theme);

    // 账号健康摘要
    const sites = metadata?.sites ?? {};
    const lastUserInfo = metadata?.lastUserInfo ?? {};
    const siteInactivityDays = metadata?.siteInactivityDays ?? {};
    const defaultInactivityDays = config?.alerts?.defaultSiteMaxInactiveDays ?? 30;
    const warnBeforeDays = config?.alerts?.inactivityWarningDays ?? 7;

    const addedSiteIds = Object.keys(sites);
    siteCount.value = addedSiteIds.length;

    let unread = 0;
    let abnormal = 0;
    let inactiveWarn = 0;

    for (const siteId of addedSiteIds) {
      const info = lastUserInfo[siteId];
      if (!info) continue;
      if (typeof info.messageCount === "number" && info.messageCount > 0) {
        unread += info.messageCount;
      }
      if (
        info.status === EResultParseStatus.needLogin ||
        info.status === EResultParseStatus.parseError ||
        info.status === EResultParseStatus.CFBlocked
      ) {
        abnormal += 1;
      }
      const inact = computeSiteInactivityInfo(
        info,
        siteInactivityDays[siteId] ?? defaultInactivityDays,
        warnBeforeDays,
      );
      if (inact && (inact.status === "warning" || inact.status === "danger")) {
        inactiveWarn += 1;
      }
    }

    unreadMessageCount.value = unread;
    abnormalSiteCount.value = abnormal;
    inactiveWarningCount.value = inactiveWarn;

    // 启用下载器实时状态
    const enabledDownloaders = Object.values(metadata?.downloaders ?? {}).filter((d): d is IDownloaderMetadata =>
      Boolean(d?.enabled),
    );
    const liveCards = await Promise.all(
      enabledDownloaders.slice(0, 6).map(async (dl): Promise<IDownloaderLiveCard> => {
        try {
          const [status, freeSpace] = await Promise.all([
            sendMessage("getDownloaderStatus", dl.id),
            sendMessage("getDownloaderFreeSpace", dl.id).catch(() => "N/A" as const),
          ]);
          return {
            id: dl.id,
            name: dl.name,
            upSpeed: Number(status?.upSpeed ?? 0) || 0,
            dlSpeed: Number(status?.dlSpeed ?? 0) || 0,
            freeSpace,
            online: true,
          };
        } catch {
          return {
            id: dl.id,
            name: dl.name,
            upSpeed: 0,
            dlSpeed: 0,
            freeSpace: "N/A",
            online: false,
          };
        }
      }),
    );
    downloaderCards.value = liveCards;
  } catch {
    // 忽略瞬时读取异常
  } finally {
    loading.value = false;
  }
}

async function openPath(path: string, query?: Record<string, string | number>) {
  await sendMessage("openOptionsPage", query ? { path, query } : path);
  window.close();
}

async function handleQuickSearch() {
  const q = searchInput.value.trim();
  if (!q) {
    await openPath("/search-entity");
    return;
  }
  await openPath("/search-entity", { search: q, plan: "default", flush: 1 });
}

onMounted(() => {
  void loadData();
});
</script>

<template>
  <div class="mp-root" :class="{ 'mp-dark': isDark }">
    <div class="mp-header">
      <div class="mp-brand">chenbinPT</div>
      <div class="mp-header-actions">
        <button type="button" class="mp-btn mp-btn--ghost" :disabled="loading" @click="loadData">
          {{ loading ? "..." : t("common.refresh") }}
        </button>
        <button type="button" class="mp-btn mp-btn--primary" @click="openPath('/')">
          {{ t("miniPopup.openFullPanel") }}
        </button>
      </div>
    </div>

    <form class="mp-search" @submit.prevent="handleQuickSearch">
      <input
        v-model="searchInput"
        type="text"
        class="mp-input"
        :placeholder="t('miniPopup.searchPlaceholder')"
        autofocus
      />
      <button type="submit" class="mp-btn mp-btn--primary">{{ t("miniPopup.searchBtn") }}</button>
    </form>

    <div class="mp-section">
      <div class="mp-section-title">
        <span>{{ t("miniPopup.accountHealth") }}</span>
        <span class="mp-muted">{{ t("miniPopup.sitesCount", { count: siteCount }) }}</span>
      </div>
      <div class="mp-metrics">
        <button type="button" class="mp-metric" @click="openPath('/my-data')">
          <span class="mp-metric-val" :class="{ 'mp-warn': unreadMessageCount > 0 }">{{ unreadMessageCount }}</span>
          <span class="mp-metric-label">{{ t("miniPopup.unreadPm") }}</span>
        </button>
        <button type="button" class="mp-metric" @click="openPath('/my-data')">
          <span class="mp-metric-val" :class="{ 'mp-danger': abnormalSiteCount > 0 }">{{ abnormalSiteCount }}</span>
          <span class="mp-metric-label">{{ t("miniPopup.abnormalSites") }}</span>
        </button>
        <button type="button" class="mp-metric" @click="openPath('/my-data')">
          <span class="mp-metric-val" :class="{ 'mp-warn': inactiveWarningCount > 0 }">{{ inactiveWarningCount }}</span>
          <span class="mp-metric-label">{{ t("miniPopup.inactivityWarn") }}</span>
        </button>
      </div>
    </div>

    <div class="mp-section">
      <div class="mp-section-title">
        <span>{{ t("miniPopup.downloaders") }}</span>
        <span class="mp-speed-summary"> ↑ {{ formatSize(totalUpSpeed) }}/s · ↓ {{ formatSize(totalDlSpeed) }}/s </span>
      </div>

      <div v-if="downloaderCards.length === 0" class="mp-empty">
        {{ loading ? t("miniPopup.loading") : t("miniPopup.noDownloader") }}
      </div>
      <div v-else class="mp-dl-list">
        <button
          v-for="dl in downloaderCards"
          :key="dl.id"
          type="button"
          class="mp-dl-row"
          @click="openPath('/my-client')"
        >
          <div class="mp-dl-name">
            <span class="mp-dot" :class="dl.online ? 'mp-dot--on' : 'mp-dot--off'" />
            <span class="mp-ellipsis">{{ dl.name }}</span>
          </div>
          <div class="mp-dl-stats">
            <span>↑{{ formatSize(dl.upSpeed) }}/s</span>
            <span>↓{{ formatSize(dl.dlSpeed) }}/s</span>
            <span v-if="typeof dl.freeSpace === 'number'" class="mp-muted">{{ formatSize(dl.freeSpace) }}</span>
          </div>
        </button>
      </div>
    </div>

    <div class="mp-nav-grid">
      <button type="button" class="mp-nav-btn" @click="openPath('/my-data')">{{ t("route.Overview.MyData") }}</button>
      <button type="button" class="mp-nav-btn" @click="openPath('/my-client')">
        {{ t("route.Overview.MyClient") }}
      </button>
      <button type="button" class="mp-nav-btn" @click="openPath('/search-entity')">
        {{ t("route.Overview.SearchEntity") }}
      </button>
      <button type="button" class="mp-nav-btn" @click="openPath('/keyword-watch')">
        {{ t("route.Overview.KeywordWatch") }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.mp-root {
  --bg: #ffffff;
  --surface: #f5f7fa;
  --border: #e5e7eb;
  --text: #111827;
  --muted: #6b7280;
  --primary: #1677ff;
  --primary-text: #ffffff;
  width: 360px;
  min-height: 260px;
  padding: 12px;
  background: var(--bg);
  color: var(--text);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  font-size: 13px;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.mp-dark {
  --bg: #141414;
  --surface: #1f1f1f;
  --border: #303030;
  --text: #f3f4f6;
  --muted: #9ca3af;
  --primary: #1668dc;
}

.mp-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.mp-brand {
  font-size: 15px;
  font-weight: 700;
}

.mp-header-actions {
  display: flex;
  gap: 6px;
}

.mp-search {
  display: flex;
  gap: 6px;
}

.mp-input {
  flex: 1;
  min-width: 0;
  padding: 6px 10px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text);
  font-size: 13px;
  outline: none;
}

.mp-input:focus {
  border-color: var(--primary);
}

.mp-btn {
  padding: 5px 10px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text);
  cursor: pointer;
  font-size: 12px;
  white-space: nowrap;
}

.mp-btn--primary {
  background: var(--primary);
  border-color: var(--primary);
  color: var(--primary-text);
}

.mp-btn--ghost {
  background: transparent;
}

.mp-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.mp-section-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
  font-weight: 600;
}

.mp-muted {
  color: var(--muted);
  font-weight: 400;
}

.mp-speed-summary {
  font-size: 11px;
  color: var(--muted);
  font-weight: 500;
}

.mp-metrics {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 6px;
}

.mp-metric {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 8px 6px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text);
  cursor: pointer;
}

.mp-metric-val {
  font-size: 16px;
  font-weight: 700;
}

.mp-metric-label {
  font-size: 11px;
  color: var(--muted);
}

.mp-warn {
  color: #faad14;
}

.mp-danger {
  color: #ff4d4f;
}

.mp-dl-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.mp-dl-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text);
  cursor: pointer;
  text-align: left;
}

.mp-dl-name {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-weight: 500;
}

.mp-ellipsis {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mp-dl-stats {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  white-space: nowrap;
}

.mp-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}

.mp-dot--on {
  background: #52c41a;
}

.mp-dot--off {
  background: #ff4d4f;
}

.mp-empty {
  padding: 10px;
  text-align: center;
  font-size: 12px;
  color: var(--muted);
  background: var(--surface);
  border-radius: 6px;
}

.mp-nav-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 6px;
}

.mp-nav-btn {
  padding: 7px 10px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text);
  font-size: 12px;
  cursor: pointer;
}

.mp-nav-btn:hover,
.mp-metric:hover,
.mp-dl-row:hover {
  border-color: var(--primary);
}
</style>
