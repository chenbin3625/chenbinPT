<script setup lang="ts">
import { nanoid } from "nanoid";
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { computedAsync } from "@vueuse/core";
import {
  entityList,
  getDownloaderDefaultConfig,
  getDownloaderIcon,
  getDownloaderMetaData,
  type TorrentClientMetaData,
} from "@ptd/downloader";

import type { IDownloaderMetadata } from "@/shared/types.ts";
import { useMetadataStore } from "@/options/stores/metadata.ts";
import { useRuntimeStore } from "@/options/stores/runtime.ts";

import Editor from "./Editor.vue";

import { REPO_URL } from "~/helper.ts";

const showDialog = defineModel<boolean>();

const { t } = useI18n();
const metadataStore = useMetadataStore();
const runtimeStore = useRuntimeStore();

const currentStep = ref<0 | 1>(0);
const selectedClientType = ref<string | null>(null);
const storedDownloaderConfig = ref<Partial<IDownloaderMetadata>>({});
const isDownloaderConfigValid = ref<boolean>(false);

function resetDialog() {
  currentStep.value = 0;
  selectedClientType.value = null;
  storedDownloaderConfig.value = {};
  isDownloaderConfigValid.value = false;
}

const allTorrentClientMetaData = computedAsync(async () => {
  const clientMetaData: Record<string, TorrentClientMetaData & { type: string }> = {};
  for (const type of entityList) {
    clientMetaData[type] = { type, ...(await getDownloaderMetaData(type)) };
  }
  return clientMetaData;
}, {});

async function updateStoredDownloaderConfigByDefault(type: string) {
  storedDownloaderConfig.value = {
    valid: false,
    ...(await getDownloaderDefaultConfig(type)),
    enabled: true,
    id: nanoid(),
    advanceAddTorrentOptions: {},
    sortIndex: 100,
  };
}

async function saveStoredDownloaderConfig() {
  try {
    await metadataStore.addDownloader(storedDownloaderConfig.value as IDownloaderMetadata);

    if (metadataStore.getDownloaders.length === 1) {
      metadataStore.defaultDownloader = { id: storedDownloaderConfig.value.id!, folder: "", tags: "" };
      await metadataStore.$save();
    }

    showDialog.value = false;
  } catch {
    runtimeStore.showSnakebar(t("common.saveFailed"), { color: "error" });
  }
}
</script>

<template>
  <a-modal v-model:open="showDialog" :title="t('SetDownloader.add.title')" :width="800" :after-close="resetDialog">
    <div v-if="currentStep === 0">
      <!-- 选取可添加的客户端 -->
      <a-select
        v-model:value="selectedClientType"
        :placeholder="t('SetDownloader.add.selectPlaceholder')"
        option-label-prop="children"
        show-search
        style="width: 100%"
        @update:value="(e: string) => updateStoredDownloaderConfigByDefault(e)"
      >
        <a-select-option
          v-for="downloader in Object.values(allTorrentClientMetaData)"
          :key="downloader.type"
          :value="downloader.type"
        >
          <a-avatar :size="20" :src="getDownloaderIcon(downloader.type)" />
          {{ downloader.type }}
        </a-select-option>
      </a-select>
      <div style="margin-top: 4px">
        <a-typography-text type="secondary">
          {{ allTorrentClientMetaData[selectedClientType!]?.description ?? t("SetDownloader.add.NoneSelectNotice") }}
        </a-typography-text>
      </div>
    </div>
    <div v-if="currentStep === 1">
      <Editor
        v-if="storedDownloaderConfig.type"
        v-model="storedDownloaderConfig as IDownloaderMetadata"
        @update:config-valid="(v: any) => (isDownloaderConfigValid = v)"
      />
    </div>

    <template #footer>
      <a-flex align="center" justify="space-between">
        <a-flex align="center" :gap="8">
          <a-button
            v-show="currentStep === 0"
            :href="`${REPO_URL}/tree/master/src/packages/downloader`"
            rel="noopener noreferrer nofollow"
            target="_blank"
            type="link"
          >
            {{ t("SetDownloader.add.newType") }}
          </a-button>
          <a-button
            :href="`${REPO_URL}/wiki/config-download-client`"
            :title="t('layout.header.wiki')"
            rel="noopener noreferrer nofollow"
            target="_blank"
            type="link"
          >
            {{ t("layout.header.wiki") }}
          </a-button>
        </a-flex>

        <a-flex align="center" :gap="8">
          <a-button @click="showDialog = false">{{ t("common.dialog.cancel") }}</a-button>
          <a-button v-if="currentStep === 1" @click="currentStep--">{{ t("common.dialog.prev") }}</a-button>
          <a-button
            v-if="currentStep === 0"
            :disabled="selectedClientType == null"
            type="primary"
            @click="currentStep++"
          >
            {{ t("common.dialog.next") }}
          </a-button>
          <a-button
            v-if="currentStep === 1"
            :disabled="!isDownloaderConfigValid"
            type="primary"
            @click="saveStoredDownloaderConfig"
          >
            {{ t("common.dialog.ok") }}
          </a-button>
        </a-flex>
      </a-flex>
    </template>
  </a-modal>
</template>
