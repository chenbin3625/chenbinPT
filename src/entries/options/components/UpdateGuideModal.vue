<script setup lang="ts">
import {
  CloudDownloadOutlined,
  CopyOutlined,
  ExportOutlined,
  EyeInvisibleOutlined,
  EyeOutlined,
  SettingOutlined,
} from "@ant-design/icons-vue";
import { filesize } from "filesize";
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";

import { sendMessage } from "@/messages.ts";
import { useRuntimeStore } from "@/options/stores/runtime.ts";
import { formatDate } from "@/options/utils.ts";
import {
  compareVersion,
  extractVersion,
  UPDATE_RELEASES_PAGE_URL,
  type IUpdateCheckState,
  type IUpdateReleaseAsset,
} from "@/shared/updateCheck.ts";

const props = defineProps<{
  open: boolean;
  state: IUpdateCheckState | null;
  ignoredVersion?: string;
}>();

const emit = defineEmits<{
  (e: "update:open", value: boolean): void;
  (e: "ignore", version: string): void;
  (e: "unignore"): void;
  (e: "open-settings"): void;
}>();

const { t } = useI18n();
const runtimeStore = useRuntimeStore();

const downloadingUrl = ref<string>("");
const openingExtensions = ref(false);

const isFirefox = computed(() => typeof __BROWSER__ !== "undefined" && __BROWSER__ === "firefox");
const latest = computed(() => props.state?.latest);
const currentVersionLabel = computed(() => {
  const raw = props.state?.currentVersion || (typeof __EXT_VERSION__ !== "undefined" ? __EXT_VERSION__ : "");
  const normalized = extractVersion(raw);
  return normalized ? `v${normalized}` : raw || "-";
});
const latestVersionLabel = computed(() => {
  const version = latest.value?.version;
  return version ? `v${version}` : "-";
});
const isIgnored = computed(() => {
  if (!latest.value?.version || !props.ignoredVersion) return false;
  return compareVersion(latest.value.version, props.ignoredVersion) === 0;
});

const otherAssets = computed<IUpdateReleaseAsset[]>(() => {
  const all = latest.value?.allAssets ?? [];
  const primaryUrl = latest.value?.asset?.url;
  return all.filter((asset) => asset.url !== primaryUrl);
});

const publishedAtLabel = computed(() => {
  const publishedAt = latest.value?.publishedAt;
  if (!publishedAt) return "";
  const timestamp = Date.parse(publishedAt);
  return Number.isFinite(timestamp) ? formatDate(timestamp) : publishedAt;
});

const primaryAssetSizeLabel = computed(() => {
  const size = latest.value?.asset?.size;
  return typeof size === "number" && Number.isFinite(size) ? String(filesize(size)) : "";
});

function closeModal() {
  emit("update:open", false);
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

function handleToggleIgnore() {
  if (!latest.value?.version) return;
  if (isIgnored.value) {
    emit("unignore");
  } else {
    emit("ignore", latest.value.version);
    closeModal();
  }
}

function handleOpenSettings() {
  closeModal();
  emit("open-settings");
}
</script>

<template>
  <a-modal
    :open="open"
    :title="t('SetBase.update.modalTitle', { version: latestVersionLabel })"
    :width="620"
    @cancel="closeModal"
  >
    <div v-if="latest" class="ptd-update-modal">
      <div class="ptd-update-modal__summary">
        <a-space :size="8" wrap>
          <a-tag>{{ currentVersionLabel }}</a-tag>
          <span class="ptd-update-modal__arrow">→</span>
          <a-tag color="blue">{{ latestVersionLabel }}</a-tag>
          <a-tag v-if="primaryAssetSizeLabel">{{ primaryAssetSizeLabel }}</a-tag>
          <span v-if="publishedAtLabel" class="ptd-meta-text">
            {{ t("SetBase.update.publishedAt") }}: {{ publishedAtLabel }}
          </span>
        </a-space>
        <div v-if="latest.asset?.sha256" class="ptd-update-modal__checksum">
          <span class="ptd-meta-text">{{ t("SetBase.update.checksumLabel") }}:</span>
          <code class="ptd-update-modal__hash">{{ latest.asset.sha256 }}</code>
          <a-tooltip :title="t('SetBase.update.copyChecksum')">
            <a-button size="small" type="text" @click="copyChecksum">
              <template #icon><CopyOutlined /></template>
            </a-button>
          </a-tooltip>
        </div>
      </div>

      <div class="ptd-update-modal__section">
        <div class="ptd-update-modal__section-title">{{ t("SetBase.update.releaseNotes") }}</div>
        <div class="ptd-update-modal__notes">
          {{ latest.notes || t("SetBase.update.noReleaseNotes") }}
        </div>
      </div>

      <div class="ptd-update-modal__actions">
        <a-button
          v-if="latest.asset"
          type="primary"
          :loading="downloadingUrl === latest.asset.url"
          @click="triggerDownload(latest.asset)"
        >
          <template #icon><CloudDownloadOutlined /></template>
          {{ t("SetBase.update.downloadNow", { name: latest.asset.name }) }}
        </a-button>
        <a-button
          v-else
          type="primary"
          :href="latest.releaseUrl || UPDATE_RELEASES_PAGE_URL"
          rel="noopener noreferrer"
          target="_blank"
        >
          <template #icon><ExportOutlined /></template>
          {{ t("SetBase.update.downloadFallback") }}
        </a-button>

        <a-button :loading="openingExtensions" @click="handleOpenExtensionsPage">
          <template #icon><ExportOutlined /></template>
          {{ t("SetBase.update.openExtensionsPage") }}
        </a-button>

        <a-button
          :href="latest.releaseUrl || UPDATE_RELEASES_PAGE_URL"
          rel="noopener noreferrer"
          target="_blank"
          type="link"
        >
          {{ t("SetBase.update.openReleases") }}
        </a-button>
      </div>

      <div v-if="otherAssets.length > 0" class="ptd-update-modal__other-assets">
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

      <div class="ptd-update-modal__guide">
        <div class="ptd-update-modal__section-title">{{ t("SetBase.update.guideTitle") }}</div>
        <div v-if="isFirefox" class="ptd-update-modal__steps">
          <div>{{ t("SetBase.update.guideFirefoxStep1") }}</div>
          <div>{{ t("SetBase.update.guideFirefoxStep2") }}</div>
          <div>{{ t("SetBase.update.guideFirefoxStep3") }}</div>
        </div>
        <div v-else class="ptd-update-modal__steps">
          <div>{{ t("SetBase.update.guideChromeStep1") }}</div>
          <div>{{ t("SetBase.update.guideChromeStep2") }}</div>
          <div>{{ t("SetBase.update.guideChromeStep3") }}</div>
        </div>
      </div>
    </div>

    <template #footer>
      <div class="ptd-update-modal__footer">
        <a-space :size="8">
          <a-button size="small" type="text" @click="handleToggleIgnore">
            <template #icon>
              <EyeOutlined v-if="isIgnored" />
              <EyeInvisibleOutlined v-else />
            </template>
            {{ isIgnored ? t("SetBase.update.unignoreVersion") : t("SetBase.update.ignoreVersion") }}
          </a-button>
          <a-button size="small" type="text" @click="handleOpenSettings">
            <template #icon><SettingOutlined /></template>
            {{ t("SetBase.update.openSettings") }}
          </a-button>
        </a-space>
        <a-button @click="closeModal">{{ t("common.dialog.close") }}</a-button>
      </div>
    </template>
  </a-modal>
</template>

<style scoped>
.ptd-update-modal {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.ptd-update-modal__summary {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.ptd-update-modal__arrow {
  color: var(--ptd-text-tertiary);
}

.ptd-update-modal__checksum {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.ptd-update-modal__hash {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--ptd-surface-soft);
  word-break: break-all;
}

.ptd-update-modal__section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.ptd-update-modal__section-title {
  font-weight: 600;
  color: var(--ptd-text);
}

.ptd-update-modal__notes {
  max-height: 220px;
  overflow-y: auto;
  padding: 10px 12px;
  border: 1px solid var(--ptd-border);
  border-radius: var(--ptd-radius, 6px);
  background: var(--ptd-surface-soft);
  white-space: pre-wrap;
  word-break: break-word;
  font-size: var(--ptd-font-size-sm, 12px);
  line-height: 1.6;
}

.ptd-update-modal__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.ptd-update-modal__other-assets {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.ptd-update-modal__guide {
  padding: 10px 12px;
  border: 1px solid var(--ptd-border);
  border-radius: var(--ptd-radius, 6px);
  background: var(--ptd-surface-soft);
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.ptd-update-modal__steps {
  display: flex;
  flex-direction: column;
  gap: 4px;
  color: var(--ptd-text-secondary);
  font-size: var(--ptd-font-size-sm, 12px);
}

.ptd-update-modal__footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
</style>
