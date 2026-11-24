<script setup lang="ts">
import {
  CheckCircleOutlined,
  CloudDownloadOutlined,
  CopyOutlined,
  ExportOutlined,
  EyeInvisibleOutlined,
  EyeOutlined,
  ReloadOutlined,
} from "@ant-design/icons-vue";
import { filesize } from "filesize";
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";

import { sendMessage } from "@/messages.ts";
import { useConfigStore } from "@/options/stores/config.ts";
import { useRuntimeStore } from "@/options/stores/runtime.ts";
import { formatDate } from "@/options/utils.ts";
import {
  compareVersion,
  extractVersion,
  UPDATE_CHECK_INTERVAL_OPTIONS,
  UPDATE_RELEASES_PAGE_URL,
  type IUpdateCheckState,
  type IUpdateReleaseAsset,
} from "@/shared/updateCheck.ts";

import { useSetBaseConfigDraft } from "./configDraft.ts";

const { t } = useI18n();
const config = useSetBaseConfigDraft();
const configStore = useConfigStore();
const runtimeStore = useRuntimeStore();

const state = ref<IUpdateCheckState | null>(null);
const loadingState = ref(true);
const checking = ref(false);
const downloadingUrl = ref("");
const openingExtensions = ref(false);

const isFirefox = computed(() => typeof __BROWSER__ !== "undefined" && __BROWSER__ === "firefox");
const browserLabel = computed(() => {
  if (isFirefox.value) return "Firefox";
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  if (ua.includes("Edg/")) return "Edge";
  if (ua.includes("Chromium/")) return "Chromium";
  return "Chrome";
});

const currentDisplayVersion = computed(() => {
  if (typeof __EXT_VERSION__ !== "undefined" && __EXT_VERSION__) {
    return __EXT_VERSION__;
  }
  const v = state.value?.currentVersion;
  return v ? `v${v}` : "-";
});

const latest = computed(() => state.value?.latest);
const hasUpdate = computed(() => state.value?.status === "update-available" && Boolean(latest.value));
const ignoredVersion = computed(() => configStore.updateCheck?.ignoredVersion ?? "");
const isIgnored = computed(() => {
  if (!latest.value?.version || !ignoredVersion.value) return false;
  return compareVersion(latest.value.version, ignoredVersion.value) === 0;
});

const statusTagColor = computed(() => {
  if (state.value?.status === "error") return "error";
  if (hasUpdate.value) return isIgnored.value ? "default" : "processing";
  if (state.value?.status === "up-to-date") return "success";
  return "default";
});

const statusTagText = computed(() => {
  if (!state.value || state.value.status === "idle") return t("SetBase.update.statusIdle");
  if (state.value.status === "error") return t("SetBase.update.statusError");
  if (hasUpdate.value && latest.value) {
    const version = `v${latest.value.version}`;
    return isIgnored.value
      ? t("SetBase.update.statusIgnored", { version })
      : t("SetBase.update.statusAvailable", { version });
  }
  return t("SetBase.update.statusUpToDate");
});

const lastCheckedText = computed(() => {
  const checkedAt = state.value?.checkedAt ?? 0;
  return checkedAt > 0 ? formatDate(checkedAt) : t("SetBase.update.neverChecked");
});

const publishedAtText = computed(() => {
  const publishedAt = latest.value?.publishedAt;
  if (!publishedAt) return "";
  const timestamp = Date.parse(publishedAt);
  return Number.isFinite(timestamp) ? formatDate(timestamp) : publishedAt;
});

const primaryAssetSizeLabel = computed(() => {
  const size = latest.value?.asset?.size;
  return typeof size === "number" && Number.isFinite(size) ? String(filesize(size)) : "";
});

const otherAssets = computed<IUpdateReleaseAsset[]>(() => {
  const all = latest.value?.allAssets ?? [];
  const primaryUrl = latest.value?.asset?.url;
  return all.filter((asset) => asset.url !== primaryUrl);
});

const dataSourceLabel = computed(() => {
  if (!latest.value) return "";
  return latest.value.source === "manifest"
    ? t("SetBase.update.dataSourceManifest")
    : t("SetBase.update.dataSourceGitHubApi");
});

const intervalOptions = computed(() =>
  UPDATE_CHECK_INTERVAL_OPTIONS.map((hours) => ({
    value: hours,
    label:
      hours >= 24 && hours % 24 === 0
        ? t("SetBase.update.intervalDays", { days: hours / 24 })
        : t("SetBase.update.intervalHours", { hours }),
  })),
);

async function loadState() {
  loadingState.value = true;
  try {
    state.value = await sendMessage("getUpdateCheckState", undefined);
  } catch {
    state.value = null;
  } finally {
    loadingState.value = false;
  }
}

async function handleCheckNow() {
  if (checking.value) return;
  checking.value = true;
  try {
    const next = await sendMessage("checkExtensionUpdate", { force: true });
    state.value = next;
    if (next.status === "error") {
      runtimeStore.showSnackbar(t("SetBase.update.checkFailedDetail", { error: next.error || "Unknown error" }), {
        color: "error",
      });
    } else if (next.status === "update-available" && next.latest) {
      runtimeStore.showSnackbar(t("SetBase.update.checkSuccessAvailable", { version: `v${next.latest.version}` }), {
        color: "info",
      });
    } else {
      const normalized = extractVersion(next.currentVersion) ?? next.currentVersion;
      runtimeStore.showSnackbar(t("SetBase.update.checkSuccessUpToDate", { version: `v${normalized}` }), {
        color: "success",
      });
    }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    runtimeStore.showSnackbar(t("SetBase.update.checkFailedDetail", { error }), { color: "error" });
  } finally {
    checking.value = false;
  }
}

async function triggerDownload(asset?: IUpdateReleaseAsset) {
  if (!asset?.url || downloadingUrl.value) return;
  downloadingUrl.value = asset.url;
  try {
    const result = await sendMessage("downloadExtensionUpdate", {
      url: asset.url,
      filename: asset.name,
    });
    runtimeStore.showSnackbar(t("SetBase.update.downloadStarted", { filename: result.filename }), {
      color: "success",
    });
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    runtimeStore.showSnackbar(t("SetBase.update.downloadFailed", { error }), { color: "error" });
  } finally {
    downloadingUrl.value = "";
  }
}

async function copyTextSafely(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

async function copyChecksum() {
  const sha = latest.value?.asset?.sha256;
  if (!sha) return;
  const ok = await copyTextSafely(sha);
  runtimeStore.showSnackbar(ok ? t("SetBase.update.checksumCopied") : t("SetBase.update.copyFailed"), {
    color: ok ? "success" : "warning",
  });
}

async function setIgnoredVersion(version: string) {
  // 即时持久化忽略状态，不触碰草稿 baseline，避免干扰全局保存按钮的未保存状态
  configStore.updateCheck.ignoredVersion = version;
  try {
    await sendMessage("patchExtStoragePath", {
      key: "config",
      path: "updateCheck.ignoredVersion",
      value: version,
    });
    runtimeStore.showSnackbar(
      version ? t("SetBase.update.versionIgnored", { version: `v${version}` }) : t("SetBase.update.versionUnignored"),
      { color: "success" },
    );
  } catch {
    runtimeStore.showSnackbar(t("common.saveFailed"), { color: "error" });
  }
}

async function handleToggleIgnore() {
  if (!latest.value?.version) return;
  await setIgnoredVersion(isIgnored.value ? "" : latest.value.version);
}

async function handleOpenExtensionsPage() {
  if (openingExtensions.value) return;
  openingExtensions.value = true;
  try {
    const result = await sendMessage("openBrowserExtensionsPage", undefined);
    if (!result.opened) {
      const copied = await copyTextSafely(result.url);
      runtimeStore.showSnackbar(
        copied
          ? t("SetBase.update.openExtensionsPageFallback", { url: result.url })
          : t("SetBase.update.openExtensionsPageManual", { url: result.url }),
        { color: "info" },
      );
    }
  } catch {
    const fallbackUrl = isFirefox.value ? "about:debugging#/runtime/this-firefox" : "chrome://extensions";
    const copied = await copyTextSafely(fallbackUrl);
    runtimeStore.showSnackbar(
      copied
        ? t("SetBase.update.openExtensionsPageFallback", { url: fallbackUrl })
        : t("SetBase.update.openExtensionsPageManual", { url: fallbackUrl }),
      { color: "info" },
    );
  } finally {
    openingExtensions.value = false;
  }
}

onMounted(() => {
  void loadState();
});
</script>

<template>
  <div class="ptd-settings-grid">
    <!-- 当前版本与更新检测状态 -->
    <section class="ptd-settings-section">
      <div class="ptd-settings-row ptd-settings-row--title">
        <a-typography-text strong>{{ t("SetBase.update.sectionStatus") }}</a-typography-text>
        <a-space :size="8" wrap>
          <a-button :loading="checking" size="small" type="primary" @click="handleCheckNow">
            <template #icon><ReloadOutlined /></template>
            {{ t("SetBase.update.checkNow") }}
          </a-button>
          <a-button
            :href="latest?.releaseUrl || UPDATE_RELEASES_PAGE_URL"
            rel="noopener noreferrer"
            size="small"
            target="_blank"
          >
            <template #icon><ExportOutlined /></template>
            {{ t("SetBase.update.openReleases") }}
          </a-button>
        </a-space>
      </div>

      <a-card :bordered="false" :loading="loadingState" class="ptd-update-status-card">
        <div class="ptd-update-meta-grid">
          <div class="ptd-update-meta-item">
            <span class="ptd-meta-text">{{ t("SetBase.update.currentVersion") }}</span>
            <a-typography-text strong>{{ currentDisplayVersion }}</a-typography-text>
          </div>
          <div class="ptd-update-meta-item">
            <span class="ptd-meta-text">{{ t("SetBase.update.browserTarget") }}</span>
            <a-typography-text>{{ browserLabel }}</a-typography-text>
          </div>
          <div class="ptd-update-meta-item">
            <span class="ptd-meta-text">{{ t("SetBase.update.lastCheckedAt") }}</span>
            <a-typography-text>{{ lastCheckedText }}</a-typography-text>
          </div>
          <div class="ptd-update-meta-item">
            <a-tag :color="statusTagColor">
              <CheckCircleOutlined v-if="state?.status === 'up-to-date'" style="margin-right: 4px" />
              {{ statusTagText }}
            </a-tag>
          </div>
        </div>

        <a-alert
          v-if="state?.status === 'error' && state.error"
          :message="t('SetBase.update.checkFailedDetail', { error: state.error })"
          class="ptd-update-alert"
          show-icon
          type="error"
        />

        <!-- 发现新版本：展示发布信息、一键下载与三步升级引导 -->
        <div v-if="hasUpdate && latest" class="ptd-update-release">
          <a-divider class="ptd-update-divider" />

          <div class="ptd-update-release__header">
            <a-space :size="8" wrap>
              <a-typography-text strong>
                {{ t("SetBase.update.latestVersion") }}: v{{ latest.version }}
              </a-typography-text>
              <a-tag v-if="primaryAssetSizeLabel">{{ primaryAssetSizeLabel }}</a-tag>
              <span v-if="publishedAtText" class="ptd-meta-text">
                {{ t("SetBase.update.publishedAt") }}: {{ publishedAtText }}
              </span>
              <span v-if="dataSourceLabel" class="ptd-meta-text">{{ dataSourceLabel }}</span>
            </a-space>
            <a-button size="small" type="text" @click="handleToggleIgnore">
              <template #icon>
                <EyeOutlined v-if="isIgnored" />
                <EyeInvisibleOutlined v-else />
              </template>
              {{ isIgnored ? t("SetBase.update.unignoreVersion") : t("SetBase.update.ignoreVersion") }}
            </a-button>
          </div>

          <div v-if="latest.asset?.sha256" class="ptd-update-checksum">
            <span class="ptd-meta-text">{{ t("SetBase.update.checksumLabel") }}:</span>
            <code class="ptd-update-hash">{{ latest.asset.sha256 }}</code>
            <a-tooltip :title="t('SetBase.update.copyChecksum')">
              <a-button size="small" type="text" @click="copyChecksum">
                <template #icon><CopyOutlined /></template>
              </a-button>
            </a-tooltip>
          </div>

          <div class="ptd-update-notes">
            {{ latest.notes || t("SetBase.update.noReleaseNotes") }}
          </div>

          <div class="ptd-update-actions">
            <a-button
              v-if="latest.asset"
              :loading="downloadingUrl === latest.asset.url"
              type="primary"
              @click="triggerDownload(latest.asset)"
            >
              <template #icon><CloudDownloadOutlined /></template>
              {{ t("SetBase.update.downloadNow", { name: latest.asset.name }) }}
            </a-button>
            <a-button
              v-else
              :href="latest.releaseUrl || UPDATE_RELEASES_PAGE_URL"
              rel="noopener noreferrer"
              target="_blank"
              type="primary"
            >
              <template #icon><ExportOutlined /></template>
              {{ t("SetBase.update.downloadFallback") }}
            </a-button>

            <a-button :loading="openingExtensions" @click="handleOpenExtensionsPage">
              <template #icon><ExportOutlined /></template>
              {{ t("SetBase.update.openExtensionsPage") }}
            </a-button>
          </div>

          <div v-if="otherAssets.length > 0" class="ptd-update-other-assets">
            <span class="ptd-meta-text">{{ t("SetBase.update.otherAssets") }}:</span>
            <a-space :size="6" wrap>
              <a-button
                v-for="asset in otherAssets"
                :key="asset.url"
                :loading="downloadingUrl === asset.url"
                size="small"
                type="dashed"
                @click="triggerDownload(asset)"
              >
                {{ asset.name }}
              </a-button>
            </a-space>
          </div>

          <div class="ptd-update-guide">
            <div class="ptd-update-guide__title">{{ t("SetBase.update.guideTitle") }}</div>
            <div v-if="isFirefox" class="ptd-update-guide__steps">
              <div>{{ t("SetBase.update.guideFirefoxStep1") }}</div>
              <div>{{ t("SetBase.update.guideFirefoxStep2") }}</div>
              <div>{{ t("SetBase.update.guideFirefoxStep3") }}</div>
            </div>
            <div v-else class="ptd-update-guide__steps">
              <div>{{ t("SetBase.update.guideChromeStep1") }}</div>
              <div>{{ t("SetBase.update.guideChromeStep2") }}</div>
              <div>{{ t("SetBase.update.guideChromeStep3") }}</div>
            </div>
          </div>
        </div>
      </a-card>
    </section>

    <!-- 自动检测偏好（走 SetBase 草稿与全局保存按钮） -->
    <section class="ptd-settings-section">
      <div class="ptd-settings-row ptd-settings-row--title">
        <a-typography-text strong>{{ t("SetBase.update.sectionSettings") }}</a-typography-text>
      </div>

      <div class="ptd-settings-row">
        <a-typography-text>{{ t("SetBase.update.enableAutoCheck") }}</a-typography-text>
        <a-switch v-model:checked="config.updateCheck.enabled" />
      </div>

      <template v-if="config.updateCheck.enabled">
        <div class="ptd-settings-row">
          <a-typography-text>{{ t("SetBase.update.checkInterval") }}</a-typography-text>
          <a-select
            v-model:value="config.updateCheck.intervalHours"
            :options="intervalOptions"
            style="width: min(100%, 240px)"
          />
        </div>

        <div class="ptd-settings-row">
          <a-typography-text>{{ t("SetBase.update.notifyBrowser") }}</a-typography-text>
          <a-switch v-model:checked="config.updateCheck.notifyBrowser" />
        </div>
      </template>

      <a-alert :message="t('SetBase.update.privacyNotice')" show-icon type="info" />
    </section>
  </div>
</template>

<style scoped>
.ptd-update-status-card {
  background: var(--ptd-surface-soft);
}

.ptd-update-meta-grid {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px 24px;
}

.ptd-update-meta-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.ptd-update-alert {
  margin-top: 12px;
}

.ptd-update-divider {
  margin: 12px 0;
}

.ptd-update-release {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.ptd-update-release__header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.ptd-update-checksum {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.ptd-update-hash {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--ptd-surface);
  border: 1px solid var(--ptd-border);
  word-break: break-all;
}

.ptd-update-notes {
  max-height: 240px;
  overflow-y: auto;
  padding: 10px 12px;
  border: 1px solid var(--ptd-border);
  border-radius: var(--ptd-radius, 6px);
  background: var(--ptd-surface);
  white-space: pre-wrap;
  word-break: break-word;
  font-size: var(--ptd-font-size-sm, 12px);
  line-height: 1.6;
}

.ptd-update-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.ptd-update-other-assets {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.ptd-update-guide {
  padding: 10px 12px;
  border: 1px solid var(--ptd-border);
  border-radius: var(--ptd-radius, 6px);
  background: var(--ptd-surface);
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.ptd-update-guide__title {
  font-weight: 600;
  color: var(--ptd-text);
}

.ptd-update-guide__steps {
  display: flex;
  flex-direction: column;
  gap: 4px;
  color: var(--ptd-text-secondary);
  font-size: var(--ptd-font-size-sm, 12px);
}
</style>
