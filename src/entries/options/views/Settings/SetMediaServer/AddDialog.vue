<script setup lang="ts">
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { computedAsync } from "@vueuse/core";
import { nanoid } from "nanoid";
import {
  getMediaServerDefaultConfig,
  getMediaServerMetaData,
  entityList,
  getMediaServerIcon,
  type IMediaServerMetadata,
} from "@ptd/mediaServer";

import { useMetadataStore } from "@/options/stores/metadata.ts";
import type {
  IMediaServerMetadata as IMediaServerUserConfig,
  TDownloaderKey,
  TMediaServerKey,
} from "@/shared/types.ts";

import Editor from "./Editor.vue";

const showDialog = defineModel<boolean>();

const { t } = useI18n();
const metadataStore = useMetadataStore();

const currentStep = ref<0 | 1>(0);
const selectedMediaServerType = ref<TMediaServerKey | null>(null);
const storedMediaServerConfig = ref<Partial<IMediaServerUserConfig>>({});
const isMediaServerConfigValid = ref<boolean>(false);

function resetDialog() {
  currentStep.value = 0;
  selectedMediaServerType.value = null;
  storedMediaServerConfig.value = {};
  isMediaServerConfigValid.value = false;
}

interface MediaServerMetaData extends IMediaServerMetadata {
  type: TMediaServerKey;
}

const allMediaServerMetaData = computedAsync(async () => {
  const mediaServerMetaData: Record<TMediaServerKey, MediaServerMetaData> = {};
  for (const type of entityList) {
    mediaServerMetaData[type] = { type, ...(await getMediaServerMetaData(type)) } as MediaServerMetaData;
  }
  return mediaServerMetaData;
}, {});

async function updateStoredMediaServerConfigByDefault(e: TDownloaderKey) {
  storedMediaServerConfig.value = {
    ...(await getMediaServerDefaultConfig(e)),
    enabled: true,
    id: nanoid(),
  };
}

async function saveStoredMediaServerConfig() {
  await metadataStore.addMediaServer(storedMediaServerConfig.value as IMediaServerUserConfig);
  showDialog.value = false;
}
</script>

<template>
  <a-modal v-model:open="showDialog" :title="t('SetMediaServer.add.title')" :width="800" :after-close="resetDialog">
    <div v-if="currentStep === 0">
      <a-select
        v-model:value="selectedMediaServerType"
        :placeholder="t('SetDownloader.add.selectPlaceholder')"
        option-label-prop="children"
        show-search
        style="width: 100%"
        @update:value="(e: any) => updateStoredMediaServerConfigByDefault(e)"
      >
        <a-select-option
          v-for="mediaServer in Object.values(allMediaServerMetaData)"
          :key="mediaServer.type"
          :value="mediaServer.type"
        >
          <a-avatar :size="20" :src="getMediaServerIcon(mediaServer.type)" />
          {{ mediaServer.type }}
        </a-select-option>
      </a-select>
      <div style="margin-top: 4px">
        <a-typography-text type="secondary">
          {{ allMediaServerMetaData[selectedMediaServerType!]?.description ?? t("SetDownloader.add.NoneSelectNotice") }}
        </a-typography-text>
      </div>
    </div>
    <div v-if="currentStep === 1">
      <Editor
        v-if="storedMediaServerConfig.type"
        v-model="storedMediaServerConfig as IMediaServerUserConfig"
        @update:config-valid="(e: any) => (isMediaServerConfigValid = e)"
      />
    </div>

    <template #footer>
      <a-flex align="center" justify="flex-end" :gap="8">
        <a-button @click="showDialog = false">{{ t("common.dialog.cancel") }}</a-button>
        <a-button v-if="currentStep === 1" @click="currentStep--">{{ t("common.dialog.prev") }}</a-button>
        <a-button
          v-if="currentStep === 0"
          :disabled="selectedMediaServerType == null"
          type="primary"
          @click="currentStep++"
        >
          {{ t("common.dialog.next") }}
        </a-button>
        <a-button
          v-if="currentStep === 1"
          :disabled="!isMediaServerConfigValid"
          type="primary"
          @click="saveStoredMediaServerConfig"
        >
          {{ t("common.dialog.ok") }}
        </a-button>
      </a-flex>
    </template>
  </a-modal>
</template>
