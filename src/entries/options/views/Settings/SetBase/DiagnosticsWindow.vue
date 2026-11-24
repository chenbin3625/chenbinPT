<script setup lang="ts">
import { CopyOutlined, DeleteOutlined, DownloadOutlined, ReloadOutlined } from "@ant-design/icons-vue";
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";

import { sendMessage } from "@/messages.ts";
import { useConfigStore } from "@/options/stores/config.ts";
import { useMetadataStore } from "@/options/stores/metadata.ts";
import { useRuntimeStore } from "@/options/stores/runtime.ts";
import { formatDate } from "@/options/utils.ts";
import type { ILoggerItem } from "@/shared/types.ts";
import NoDataPlaceholder from "@/options/components/NoDataPlaceholder.vue";

const { t } = useI18n();
const configStore = useConfigStore();
const metadataStore = useMetadataStore();
const runtimeStore = useRuntimeStore();

const logs = ref<ILoggerItem[]>([]);
const loading = ref(false);
const levelFilter = ref<string>("all");
const searchKeyword = ref("");

const levelOptions = computed(() => [
  { label: t("SetBase.diagnostics.levels.all"), value: "all" },
  { label: "ERROR", value: "error" },
  { label: "WARN", value: "warn" },
  { label: "INFO", value: "info" },
  { label: "LOG", value: "log" },
  { label: "DEBUG", value: "debug" },
]);

const filteredLogs = computed(() => {
  const q = searchKeyword.value.trim().toLowerCase();
  return [...logs.value].reverse().filter((item) => {
    const level = (item.level ?? "log").toLowerCase();
    if (levelFilter.value !== "all" && level !== levelFilter.value) {
      return false;
    }
    if (!q) return true;
    const text = `${item.module ?? ""} ${item.msg ?? ""} ${item.data ? JSON.stringify(item.data) : ""}`.toLowerCase();
    return text.includes(q);
  });
});

function levelColor(level?: string): string {
  switch (level) {
    case "error":
      return "error";
    case "warn":
      return "warning";
    case "info":
      return "processing";
    case "debug":
    case "trace":
      return "default";
    default:
      return "blue";
  }
}

function formatLogData(data: unknown): string {
  if (data === undefined || data === null) return "";
  if (typeof data === "string") return data;
  try {
    return JSON.stringify(data);
  } catch {
    return String(data);
  }
}

async function fetchLogs() {
  loading.value = true;
  try {
    const data = await sendMessage("getLogger", undefined);
    logs.value = Array.isArray(data) ? data : [];
  } catch {
    runtimeStore.showSnackbar(t("SetBase.diagnostics.loadFailed"), { color: "error" });
  } finally {
    loading.value = false;
  }
}

async function clearLogs() {
  try {
    await sendMessage("clearLogger", undefined);
    logs.value = [];
    runtimeStore.showSnackbar(t("SetBase.diagnostics.cleared"), { color: "success" });
  } catch {
    runtimeStore.showSnackbar(t("SetBase.diagnostics.clearFailed"), { color: "error" });
  }
}

function buildRedactedDiagnosticBundle() {
  const downloaders = Object.values(metadataStore.downloaders ?? {}).map((d) => ({
    type: d.type,
    enabled: d.enabled,
    hasAuth: Boolean(d.username || d.password),
  }));
  const mediaServers = Object.values(metadataStore.mediaServers ?? {}).map((m) => ({
    type: m.type,
    enabled: m.enabled,
  }));
  const customSiteSchemas = Object.values(metadataStore.customSites ?? {}).map((c) => c.schema);

  return {
    exportedAt: new Date().toISOString(),
    version: typeof __EXT_VERSION__ !== "undefined" ? __EXT_VERSION__ : "unknown",
    userAgent: navigator.userAgent,
    language: configStore.lang,
    theme: configStore.theme,
    summary: {
      addedSitesCount: Object.keys(metadataStore.sites ?? {}).length,
      customSitesCount: customSiteSchemas.length,
      customSiteSchemas,
      searchSolutionsCount: Object.keys(metadataStore.solutions ?? {}).length,
      pushRoutingRulesCount: (metadataStore.pushRoutingRules ?? []).length,
      keywordWatchesCount: Object.keys(metadataStore.keywordWatches ?? {}).length,
      downloaders,
      mediaServers,
      autoRefreshEnabled: configStore.userInfo?.autoReflush?.enabled ?? false,
      alertsEnabled: configStore.alerts?.enabled ?? false,
      webhookType: configStore.alerts?.webhook?.type ?? "none",
      toolbarPopupEnabled: configStore.enableToolbarPopup ?? false,
    },
    logs: logs.value,
  };
}

async function copyDiagnostics() {
  try {
    const payload = JSON.stringify(buildRedactedDiagnosticBundle(), null, 2);
    await navigator.clipboard.writeText(payload);
    runtimeStore.showSnackbar(t("SetBase.diagnostics.copied"), { color: "success" });
  } catch {
    runtimeStore.showSnackbar(t("SetBase.diagnostics.copyFailed"), { color: "error" });
  }
}

function exportDiagnostics() {
  const payload = JSON.stringify(buildRedactedDiagnosticBundle(), null, 2);
  const blob = new Blob([payload], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `chenbinPT-diagnostics-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

onMounted(() => {
  void fetchLogs();
});
</script>

<template>
  <div class="diagnostics-window">
    <a-alert type="info" show-icon :message="t('SetBase.diagnostics.privacyHint')" class="diagnostics-window__alert" />

    <div class="diagnostics-window__toolbar">
      <a-space :size="8" wrap>
        <a-select v-model:value="levelFilter" :options="levelOptions" size="small" class="diagnostics-window__level" />
        <a-input
          v-model:value="searchKeyword"
          size="small"
          allow-clear
          :placeholder="t('SetBase.diagnostics.searchPlaceholder')"
          class="diagnostics-window__search"
        />
      </a-space>
      <a-space :size="8" wrap>
        <a-button size="small" :loading="loading" @click="fetchLogs">
          <template #icon><ReloadOutlined /></template>
          {{ t("common.refresh") }}
        </a-button>
        <a-button size="small" @click="copyDiagnostics">
          <template #icon><CopyOutlined /></template>
          {{ t("SetBase.diagnostics.copyBundle") }}
        </a-button>
        <a-button size="small" type="primary" @click="exportDiagnostics">
          <template #icon><DownloadOutlined /></template>
          {{ t("SetBase.diagnostics.exportBundle") }}
        </a-button>
        <a-button size="small" danger :disabled="logs.length === 0" @click="clearLogs">
          <template #icon><DeleteOutlined /></template>
          {{ t("SetBase.diagnostics.clearLogs") }}
        </a-button>
      </a-space>
    </div>

    <div class="diagnostics-window__meta">
      <a-typography-text type="secondary">
        {{ t("SetBase.diagnostics.countSummary", { shown: filteredLogs.length, total: logs.length }) }}
      </a-typography-text>
    </div>

    <div class="diagnostics-window__list">
      <NoDataPlaceholder v-if="!loading && filteredLogs.length === 0" compact />
      <a-list v-else :data-source="filteredLogs" :loading="loading" size="small" bordered>
        <template #renderItem="{ item }">
          <a-list-item class="diagnostics-window__item">
            <div class="diagnostics-window__row">
              <div class="diagnostics-window__row-head">
                <a-tag :color="levelColor(item.level)" class="diagnostics-window__tag">
                  {{ (item.level ?? "log").toUpperCase() }}
                </a-tag>
                <span v-if="item.module" class="diagnostics-window__module">[{{ item.module }}]</span>
                <span class="diagnostics-window__time">{{ item.time ? formatDate(item.time) : "-" }}</span>
              </div>
              <div class="diagnostics-window__msg">{{ item.msg }}</div>
              <div v-if="item.data !== undefined" class="diagnostics-window__data">
                {{ formatLogData(item.data) }}
              </div>
            </div>
          </a-list-item>
        </template>
      </a-list>
    </div>
  </div>
</template>

<style scoped>
.diagnostics-window {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.diagnostics-window__alert {
  margin-bottom: 2px;
}

.diagnostics-window__toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.diagnostics-window__level {
  width: 110px;
}

.diagnostics-window__search {
  width: 240px;
}

.diagnostics-window__meta {
  font-size: var(--ptd-font-size-sm);
}

.diagnostics-window__list {
  max-height: 540px;
  overflow-y: auto;
}

.diagnostics-window__item {
  padding: 6px 10px;
}

.diagnostics-window__row {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.diagnostics-window__row-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--ptd-font-size-sm);
}

.diagnostics-window__tag {
  margin-inline-end: 0;
}

.diagnostics-window__module {
  color: var(--ptd-primary);
  font-weight: 500;
}

.diagnostics-window__time {
  color: var(--ptd-text-tertiary);
  font-variant-numeric: tabular-nums;
}

.diagnostics-window__msg {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 12px;
  word-break: break-word;
}

.diagnostics-window__data {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 11px;
  color: var(--ptd-text-secondary);
  word-break: break-all;
}
</style>
