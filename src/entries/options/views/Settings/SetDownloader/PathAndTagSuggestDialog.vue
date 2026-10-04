<script setup lang="ts">
import { CloseCircleOutlined, ImportOutlined } from "@ant-design/icons-vue";
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { getDownloader, getDownloaderMetaData, type TorrentClientMetaData } from "@ptd/downloader";

import { resolveColor } from "@/shared/colors.ts";
import { withEllipsisCell } from "@/options/views/Overview/utils/antdTable.ts";
import { useRuntimeStore } from "@/options/stores/runtime.ts";
import { useMetadataStore } from "@/options/stores/metadata.ts";
import type { IDownloaderMetadata } from "@/shared/types.ts";

const showDialog = defineModel<boolean>();
const { clientId } = defineProps<{
  clientId: string;
}>();

const { t } = useI18n();
const runtimeStore = useRuntimeStore();
const metadataStore = useMetadataStore();

const clientConfig = ref<IDownloaderMetadata>();
const clientMetadata = ref<TorrentClientMetaData>();
const expansionPanelOpen = ref<string>("note");

function onCollapseChange(key: string | number | (string | number)[]) {
  expansionPanelOpen.value = String(Array.isArray(key) ? (key[0] ?? "") : (key ?? ""));
}

// [key (for i18n), value, example]
const pathReplaceMap: [string, string, string][] = [
  // 在 torrent 相关字段中，因为对应的 title subTitle 为对应 torrent 的字段，所以这里用 . 来分隔
  ["torrentTitle", "$torrent.title$", "/volume1/$torrent.title$ -> /volume1/TorrentTitle"],
  ["torrentSubTitle", "$torrent.subTitle$", "/volume1/$torrent.subTitle$ -> /volume1/TorrentSubTitle"],
  ["torrentSite", "$torrent.site$", "/volume1/$torrent.site$/music -> /volume1/opencd/music"],
  ["torrentSiteName", "$torrent.siteName$", "/volume1/$torrent.siteName$/music -> /volume1/OpenCD/music"],
  // 而在 search, date 等字段中，则是全局字段，所以用 : 来分隔
  ["searchKeyword", "$search:keyword$", "/volume1/$search:keyword$/music -> /volume1/keyword/music"],
  ["searchPlan", "$search:plan$", "/volume1/$search:plan$/music -> /volume1/all/music"],
  ["dateYear", "$date:YYYY$", "/volume1/$date:YYYY$/music -> /volume1/2019/music"],
  ["dateMonth", "$date:MM$", "/volume1/$date:MM$/music -> /volume1/10/music"],
  ["dateDay", "$date:DD$", "/volume1/$date:DD$/music -> /volume1/01/music"],
  ["custom", "<...>", "/volume1/<...>/music -> prompt for input 'test' -> /volume1/test/music"],
];

const noteColumns = computed(() => [
  withEllipsisCell(
    { title: t("SetDownloader.PathAndTag.note.table.keywords"), dataIndex: "keyword", key: "keyword" },
    "10rem",
  ),
  withEllipsisCell({ title: t("SetDownloader.PathAndTag.note.table.note"), dataIndex: "note", key: "note" }, "20rem"),
  { title: t("SetDownloader.PathAndTag.note.table.example"), dataIndex: "example", key: "example" },
]);

const noteDataSource = computed(() =>
  pathReplaceMap.map(([key, value, example]) => ({
    key: value,
    keyword: value,
    note: t(`SetDownloader.PathAndTag.note.replaceNote.${key}`),
    example,
  })),
);

watch(
  () => clientId,
  async (newValue) => {
    console.log("Edit clientId:", newValue);
    if (newValue) {
      clientConfig.value = { suggestFolders: [], suggestTags: [], ...metadataStore.downloaders[newValue] }; // 防止直接修改父组件的数据
      clientMetadata.value = await getDownloaderMetaData(clientConfig.value.type);
    }
  },
  { immediate: true },
);

const suggestFolderInput = computed({
  get: () => (clientConfig.value?.suggestFolders ?? []).join("\n"),
  set: (value) => {
    clientConfig.value!.suggestFolders = value
      .split("\n")
      .map((v) => v.trim())
      .filter(Boolean);
  },
});

const isLoadingClientFolders = ref<boolean>(false);
async function loadClientFolders() {
  isLoadingClientFolders.value = true;
  const client = await getDownloader(clientConfig.value!);
  try {
    const clientPaths = await client.getClientPaths();
    for (const path of clientPaths) {
      if ((clientConfig.value?.suggestFolders ?? []).includes(path)) continue; // 避免重复添加
      suggestFolderInput.value += "\n" + path;
    }
  } catch (e) {
    runtimeStore.showSnakebar(t("SetDownloader.PathAndTag.downloadPath.autoImportFail"), { color: "error" });
  }

  isLoadingClientFolders.value = false;
}

const suggestTagInput = computed({
  get: () => (clientConfig.value?.suggestTags ?? []).join("\n"),
  set: (value) => {
    clientConfig.value!.suggestTags = value
      .split("\n")
      .map((v) => v.trim())
      .filter(Boolean);
  },
});

const isLoadingClientLabels = ref<boolean>(false);
async function loadClientLabels() {
  isLoadingClientLabels.value = true;
  const client = await getDownloader(clientConfig.value!);
  try {
    const clientLabels = await client.getClientLabels();
    for (const label of clientLabels) {
      if ((clientConfig.value?.suggestTags ?? []).includes(label)) continue; // 避免重复添加
      suggestTagInput.value += "\n" + label;
    }
  } catch (e) {
    runtimeStore.showSnakebar(t("SetDownloader.PathAndTag.tags.autoImportFail"), { color: "error" });
  }

  isLoadingClientLabels.value = false;
}

function saveClientConfig() {
  metadataStore.addDownloader(clientConfig.value as IDownloaderMetadata);
  showDialog.value = false;
}
</script>

<template>
  <a-modal
    v-model:open="showDialog"
    :cancel-text="t('common.dialog.cancel')"
    :ok-text="t('common.dialog.ok')"
    :title="t('SetDownloader.PathAndTag.title', [clientConfig?.name ?? clientId])"
    :width="1000"
    @ok="saveClientConfig"
  >
    <a-collapse accordion :active-key="expansionPanelOpen" @change="onCollapseChange">
      <a-collapse-panel key="path" :disabled="clientMetadata?.feature?.CustomPath?.allowed === false">
        <template #header>
          <a-flex align="center" :gap="8">
            {{ t("SetDownloader.PathAndTag.downloadPath.title") }}
            <span style="flex: 1 1 auto; min-width: 8px" />
            <a-tag :color="clientConfig!.suggestFolders!.length > 0 ? resolveColor('info') : undefined">
              +{{ clientConfig!.suggestFolders!.length }}
            </a-tag>
          </a-flex>
        </template>

        <a-typography-paragraph v-if="clientMetadata?.feature?.CustomPath?.description" class="ptd-section-description">
          {{ clientMetadata?.feature?.CustomPath?.description }}
        </a-typography-paragraph>

        <a-typography-text style="display: block; margin-top: 8px">
          {{ t("SetDownloader.PathAndTag.downloadPath.addInputLabel") }}
        </a-typography-text>
        <a-flex align="flex-start" :gap="8">
          <a-textarea v-model:value="suggestFolderInput" :rows="4" style="flex: 1 1 auto" />
          <a-flex :gap="4" vertical>
            <a-tooltip :title="t('SetDownloader.PathAndTag.downloadPath.autoImport')">
              <a-button :loading="isLoadingClientFolders" type="link" @click="loadClientFolders">
                <template #icon>
                  <ImportOutlined />
                </template>
              </a-button>
            </a-tooltip>
            <a-tooltip :title="t('SetDownloader.PathAndTag.downloadPath.clear')">
              <a-button danger type="text" @click="suggestFolderInput = ''">
                <template #icon>
                  <CloseCircleOutlined />
                </template>
              </a-button>
            </a-tooltip>
          </a-flex>
        </a-flex>
        <a-flex :gap="6" style="margin-top: 8px" wrap="wrap">
          <a-tag
            v-for="pathReplace in pathReplaceMap"
            :key="pathReplace[1]"
            :title="pathReplace[2]"
            style="cursor: pointer; margin-inline-end: 0"
            @click="suggestFolderInput += '/' + pathReplace[1]"
          >
            {{ pathReplace[1] }}
          </a-tag>
        </a-flex>
      </a-collapse-panel>
      <a-collapse-panel key="tag">
        <template #header>
          <a-flex align="center" :gap="8">
            {{ t("SetDownloader.PathAndTag.tags.title") }}
            <span style="flex: 1 1 auto; min-width: 8px" />
            <a-tag :color="clientConfig!.suggestTags!.length > 0 ? resolveColor('info') : undefined">
              +{{ clientConfig!.suggestTags!.length }}
            </a-tag>
          </a-flex>
        </template>
        <a-typography-text style="display: block; margin-bottom: 4px">
          {{ t("SetDownloader.PathAndTag.tags.addInputLabel") }}
        </a-typography-text>
        <a-flex align="flex-start" :gap="8">
          <a-textarea v-model:value="suggestTagInput" :rows="4" style="flex: 1 1 auto" />
          <a-flex :gap="4" vertical>
            <a-tooltip :title="t('SetDownloader.PathAndTag.tags.autoImport')">
              <a-button :loading="isLoadingClientLabels" type="link" @click="loadClientLabels">
                <template #icon>
                  <ImportOutlined />
                </template>
              </a-button>
            </a-tooltip>
            <a-tooltip :title="t('SetDownloader.PathAndTag.tags.clear')">
              <a-button danger type="text" @click="suggestTagInput = ''">
                <template #icon>
                  <CloseCircleOutlined />
                </template>
              </a-button>
            </a-tooltip>
          </a-flex>
        </a-flex>
        <a-flex :gap="6" style="margin-top: 8px" wrap="wrap">
          <a-tag
            v-for="pathReplace in pathReplaceMap"
            :key="pathReplace[1]"
            :title="pathReplace[2]"
            style="cursor: pointer; margin-inline-end: 0"
            @click="suggestTagInput += pathReplace[1]"
          >
            {{ pathReplace[1] }}
          </a-tag>
        </a-flex>
      </a-collapse-panel>
      <a-collapse-panel key="note" :header="t('SetDownloader.PathAndTag.note.title')">
        <a-typography-paragraph class="ptd-section-description">
          {{ t("SetDownloader.PathAndTag.note.index") }}
        </a-typography-paragraph>
        <a-table
          :columns="noteColumns"
          :data-source="noteDataSource"
          :pagination="false"
          size="small"
          style="margin-top: 8px"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'example'">
              <pre
                class="ptd-cell-ellipsis"
                style="margin: 0; max-width: 24rem"
                :title="String(record.example ?? '')"
                >{{ record.example }}</pre>
            </template>
          </template>
        </a-table>
      </a-collapse-panel>
    </a-collapse>
  </a-modal>
</template>
