<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";

import { useConfigStore } from "@/options/stores/config.ts";
import { useMetadataStore } from "@/options/stores/metadata.ts";
import { LocalDownloadMethod } from "@/shared/types.ts";

const { t } = useI18n();
const configStore = useConfigStore();
const metadataStore = useMetadataStore();

const localDownloadMethodOptions = computed(() =>
  LocalDownloadMethod.map((item) => ({
    label: t(`SetBase.download.localDownloadMethodOptions.${item}`),
    value: item,
  })),
);

const localDownloadMethodTip = computed(() =>
  t(`SetBase.download.localDownloadMethodOptions.${configStore.download.localDownloadMethod}Tip`),
);

async function clearLastDownloader(v: boolean) {
  if (!v) {
    metadataStore.lastKeepUpload = {};
    await metadataStore.setLastDownloader({});
  }
}
</script>

<template>
  <div class="ptd-settings-grid">
    <section class="ptd-settings-section">
      <div class="ptd-settings-row">
        <a-typography-text>{{ t("SetBase.download.saveDownloadHistory") }}</a-typography-text>
        <a-switch v-model:checked="configStore.download.saveDownloadHistory" />
      </div>
    </section>

    <section class="ptd-settings-section">
      <a-typography-text strong style="display: block; margin-bottom: 4px">
        {{ t("SetBase.download.myClientTitle") }}
      </a-typography-text>
      <div class="ptd-settings-row">
        <a-typography-text>{{ t("SetBase.download.initDownloaderTorrentOnEnter") }}</a-typography-text>
        <a-switch v-model:checked="configStore.download.initDownloaderTorrentOnEnter" />
      </div>
    </section>

    <section class="ptd-settings-section">
      <a-typography-text strong style="display: block; margin-bottom: 4px">
        {{ t("SetBase.download.localDownloadTitle") }}
      </a-typography-text>
      <div class="ptd-settings-row">
        <a-typography-text>{{ t("SetBase.download.localDownloadMethod") }}</a-typography-text>
        <a-select
          v-model:value="configStore.download.localDownloadMethod"
          :options="localDownloadMethodOptions"
          style="width: min(100%, 420px)"
        />
      </div>
      <div style="text-align: end">
        <a-typography-text type="secondary">{{ localDownloadMethodTip }}</a-typography-text>
      </div>
      <div class="ptd-settings-row">
        <a-typography-text>{{ t("SetBase.download.localDownloadIgnoreInterval") }}</a-typography-text>
        <a-switch v-model:checked="configStore.download.ignoreSiteDownloadIntervalWhenLocalDownload" />
      </div>
    </section>

    <section class="ptd-settings-section">
      <a-typography-text strong style="display: block; margin-bottom: 4px">
        {{ t("SetBase.download.pushDownloadServerTitle") }}
      </a-typography-text>
      <div class="ptd-settings-row">
        <a-typography-text>{{ t("SetBase.download.useQuickSendToClient") }}</a-typography-text>
        <a-switch v-model:checked="configStore.download.useQuickSendToClient" />
      </div>
      <a-typography-paragraph class="ptd-section-description">
        <span v-html="t('SetBase.download.quickSendToClientNote')" />
      </a-typography-paragraph>

      <div class="ptd-settings-row">
        <a-typography-text>{{ t("SetBase.download.enableSiteFilter") }}</a-typography-text>
        <a-switch v-model:checked="configStore.download.allowDownloaderFilterForSite" />
      </div>

      <div class="ptd-settings-row">
        <a-typography-text>{{ t("SetBase.download.saveLastDownloader") }}</a-typography-text>
        <a-switch v-model:checked="configStore.download.saveLastDownloader" @change="clearLastDownloader" />
      </div>
      <div class="ptd-settings-row">
        <a-typography-text>{{ t("SetBase.download.allowDirectSendToClient") }}</a-typography-text>
        <a-switch v-model:checked="configStore.download.allowDirectSendToClient" />
      </div>
    </section>
  </div>
</template>
