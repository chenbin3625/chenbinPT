<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { ref } from "vue";
import { computedAsync } from "@vueuse/core";
import { nanoid } from "nanoid";

import { BackupFields, IBackupServerMetadata } from "@/shared/types.ts";
import { useMetadataStore } from "@/options/stores/metadata.ts";
import {
  entityList,
  getBackupServerDefaultConfig,
  getBackupServerIcon,
  getBackupServerMetaData,
  type IBackupMetadata,
} from "@ptd/backupServer";

import Editor from "./Editor.vue";

const showDialog = defineModel<boolean>();

const { t } = useI18n();
const metadataStore = useMetadataStore();

const currentStep = ref<0 | 1>(0);
const selectedBackupServerType = ref<IBackupServerMetadata["type"] | null>(null);
const storedBackupServerConfig = ref<IBackupServerMetadata>({} as IBackupServerMetadata);
const isBackupServerConfigValid = ref<boolean>(false);

const allBackupServerMetaData = computedAsync(async () => {
  const clientMetaData: Record<string, IBackupMetadata<any> & { type: string }> = {};
  for (const type of entityList) {
    clientMetaData[type] = { type, ...(await getBackupServerMetaData(type)) };
  }
  return clientMetaData;
}, {});

async function updateStoredDownloaderConfigByDefault(type: IBackupServerMetadata["type"]) {
  storedBackupServerConfig.value = {
    ...(await getBackupServerDefaultConfig(type)),
    enabled: true,
    id: nanoid(),
    backupFields: [...BackupFields],
  } as IBackupServerMetadata;
}

async function saveStoredBackupServerConfig() {
  await metadataStore.addBackupServer(storedBackupServerConfig.value as IBackupServerMetadata);
  showDialog.value = false;
}

function resetDialog() {
  currentStep.value = 0;
  selectedBackupServerType.value = null;
  storedBackupServerConfig.value = {} as IBackupServerMetadata;
  isBackupServerConfigValid.value = false;
}
</script>

<template>
  <a-modal v-model:open="showDialog" :title="t('SetBackup.AddDialog.title')" :width="800" :after-close="resetDialog">
    <div>
      <!-- 选取可添加的备份服务器类型 -->
      <div v-show="currentStep === 0">
        <a-select
          v-model:value="selectedBackupServerType"
          :options="Object.values(allBackupServerMetaData).map((item) => ({ label: item.type, value: item.type }))"
          show-search
          style="width: 100%"
          @change="(e: any) => updateStoredDownloaderConfigByDefault(e)"
        >
          <template #option="{ value }">
            <a-flex align="center" :gap="8">
              <a-avatar :size="20" shape="square" :src="getBackupServerIcon(value)" />
              <span>{{ value }}</span>
            </a-flex>
          </template>
        </a-select>

        <a-typography-text style="display: block; margin-top: 4px" type="secondary">
          {{
            allBackupServerMetaData[selectedBackupServerType!]?.description ?? t("SetDownloader.add.NoneSelectNotice")
          }}
        </a-typography-text>
      </div>
      <div v-show="currentStep === 1">
        <Editor
          v-if="storedBackupServerConfig.type"
          v-model="storedBackupServerConfig"
          @update:config-valid="(v: any) => (isBackupServerConfigValid = v)"
        />
      </div>
    </div>

    <template #footer>
      <a-flex align="center" justify="end">
        <a-flex align="center" :gap="8">
          <a-button @click="showDialog = false">{{ t("common.dialog.cancel") }}</a-button>
          <a-button v-if="currentStep === 1" @click="currentStep--">{{ t("common.dialog.prev") }}</a-button>
          <a-button
            v-if="currentStep === 0"
            :disabled="selectedBackupServerType == null"
            type="primary"
            @click="currentStep++"
          >
            {{ t("common.dialog.next") }}
          </a-button>
          <a-button
            v-if="currentStep === 1"
            :disabled="!isBackupServerConfigValid"
            type="primary"
            @click="saveStoredBackupServerConfig"
          >
            {{ t("common.dialog.ok") }}
          </a-button>
        </a-flex>
      </a-flex>
    </template>
  </a-modal>
</template>
