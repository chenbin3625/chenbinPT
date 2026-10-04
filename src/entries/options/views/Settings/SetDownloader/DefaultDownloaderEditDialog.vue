<script setup lang="ts">
import { computed, nextTick, watch } from "vue";
import { useI18n } from "vue-i18n";

import { useMetadataStore } from "@/options/stores/metadata.ts";
import type { IDefaultDownloaderConfig, TDownloaderKey } from "@/shared/types/storages/metadata.ts";
import { useResetableRef } from "@/options/directives/useResetableRef.ts";
import { getDownloaderIcon } from "@ptd/downloader";

const showDialog = defineModel<boolean>();

const { t } = useI18n();
const metadataStore = useMetadataStore();

const { ref: defaultDownloaderConfig, reset: resetDefaultDownloaderConfig } = useResetableRef<
  Required<IDefaultDownloaderConfig>
>(() => ({
  id: "",
  folder: "",
  tags: "",
}));

const { ref: suggests, reset: resetSuggestions } = useResetableRef<{ folder: string[]; tags: string[] }>(
  () => ({ folder: [], tags: [] }),
  { shallow: true },
);

const folderOptions = computed(() => suggests.value.folder.map((value) => ({ value })));
const tagOptions = computed(() => suggests.value.tags.map((value) => ({ value })));

function updateDefaultDownloaderInput(downloaderId: TDownloaderKey, clean: boolean = true) {
  // 如果切换了下载器，则清空路径和标签
  if (clean) {
    defaultDownloaderConfig.value.folder = "";
    defaultDownloaderConfig.value.tags = "";
  }

  // 加载预设的下载路径和标签
  suggests.value = {
    folder: metadataStore.downloaders?.[downloaderId]?.suggestFolders ?? [],
    tags: metadataStore.downloaders?.[downloaderId]?.suggestTags ?? [],
  };
}

function saveDefaultDownloader() {
  metadataStore.defaultDownloader = defaultDownloaderConfig.value;
  metadataStore.$save();
  showDialog.value = false;
}

function enterDialog() {
  // 首先重置选项
  resetDefaultDownloaderConfig();
  resetSuggestions();

  // 如果已经有默认下载器了，则加载它
  if (metadataStore.defaultDownloader?.id) {
    defaultDownloaderConfig.value = { ...metadataStore.defaultDownloader } as Required<IDefaultDownloaderConfig>;
    updateDefaultDownloaderInput(defaultDownloaderConfig.value.id!, false);
  }
}

// 原生 a-modal 没有 afterOpenChange（只有 afterClose），打开时的初始化自行监听 open。
watch(showDialog, (open) => {
  if (open) nextTick(enterDialog);
});
</script>

<template>
  <a-modal
    v-model:open="showDialog"
    :cancel-text="t('common.dialog.cancel')"
    :ok-text="t('common.dialog.ok')"
    :title="t('SetDownloader.index.editDefaultDownloaderBtn')"
    :width="600"
    @ok="saveDefaultDownloader"
  >
    <a-form layout="vertical">
      <a-typography-text strong style="display: block; margin-left: 4px; margin-bottom: 4px">
        {{ t("SetDownloader.index.editDefaultDownloaderBtn") }}
      </a-typography-text>
      <a-select
        v-model:value="defaultDownloaderConfig.id"
        option-label-prop="children"
        style="width: 100%"
        @update:value="(e: any) => updateDefaultDownloaderInput(e)"
      >
        <a-select-option
          v-for="downloader in metadataStore.getEnabledDownloaders"
          :key="downloader.id"
          :value="downloader.id"
        >
          <a-avatar :size="20" :src="getDownloaderIcon(downloader.type)" />
          <span>{{ downloader.name }}</span>
          <a-typography-text type="secondary" style="margin-left: 8px">{{ downloader.address }}</a-typography-text>
        </a-select-option>
      </a-select>

      <!-- 如果用户已经在对应下载器的预设了下载路径和标签，则加载对应的列表 -->
      <a-flex align="center" justify="space-between" :gap="24" style="margin-top: 16px">
        <a-typography-text>{{ t("SetDownloader.PathAndTag.downloadPath.title") }}</a-typography-text>
        <a-auto-complete v-model:value="defaultDownloaderConfig.folder" :options="folderOptions" style="width: 320px" />
      </a-flex>
      <a-flex align="center" justify="space-between" :gap="24" style="margin-top: 8px">
        <a-typography-text>{{ t("SetDownloader.PathAndTag.tags.title") }}</a-typography-text>
        <a-auto-complete v-model:value="defaultDownloaderConfig.tags" :options="tagOptions" style="width: 320px" />
      </a-flex>
    </a-form>
  </a-modal>
</template>
