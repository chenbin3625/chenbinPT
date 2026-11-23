<script setup lang="ts">
import { LinkOutlined, UploadOutlined } from "@ant-design/icons-vue";
import { computed, nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import { type ITorrent, getHostFromUrl } from "@ptd/site";
import { useMetadataStore } from "@/options/stores/metadata.ts";

import SentToDownloaderDialog from "@/options/components/SentToDownloaderDialog/Index.vue";

const showDialog = defineModel<boolean>();
const metadataStore = useMetadataStore();
const { t } = useI18n();

type TInputMode = "url" | "file";

const inputMode = ref<TInputMode>("url");
const urlInput = ref("");
const torrentFiles = ref<File[]>([]);

const showSentToDownloaderDialog = ref(false);
const pendingTorrentItems = ref<ITorrent[]>([]);

let nextFileUid = 0;
const fileUidMap = new WeakMap<File, string>();

function getFileUid(file: File): string {
  let uid = fileUidMap.get(file);
  if (!uid) {
    uid = `ptd-file-${++nextFileUid}-${file.name}`;
    fileUidMap.set(file, uid);
  }
  return uid;
}

const uploadFileList = computed(() =>
  torrentFiles.value.map((file) => ({
    uid: getFileUid(file),
    name: file.name,
    size: file.size,
    status: "done" as const,
  })),
);

function onBeforeUpload(file: File) {
  torrentFiles.value = Array.from(new Set([...torrentFiles.value, file]));
  return false;
}

function onRemoveFile(uploadFile: { uid: string }) {
  torrentFiles.value = torrentFiles.value.filter((file) => getFileUid(file) !== uploadFile.uid);
  return true;
}

function cleanStatus() {
  inputMode.value = "url";
  urlInput.value = "";
  torrentFiles.value = [];
}

// 原生 a-modal 没有 afterOpenChange（只有 afterClose），打开时初始化自行监听 open。
watch(showDialog, (open) => {
  if (open) nextTick(cleanStatus);
});

async function submit() {
  const torrentItems: ITorrent[] = [];

  if (inputMode.value === "url") {
    const lines = urlInput.value
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);

    for (const link of lines) {
      const torrent = { link, title: link } as ITorrent;
      if (link.match(/^https?:\/\//)) {
        const host = getHostFromUrl(link);
        if (metadataStore.siteHostMap[host]) {
          torrent.site = metadataStore.siteHostMap[host];
        }
      }
      torrentItems.push(torrent);
    }
  } else {
    for (const file of torrentFiles.value) {
      const dataUri = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      torrentItems.push({
        link: dataUri,
        title: file.name.replace(/\.torrent$/i, ""),
        site: "",
        id: file.name,
      } as unknown as ITorrent);
    }
  }

  if (torrentItems.length === 0) return;

  pendingTorrentItems.value = torrentItems;
  showDialog.value = false;
  showSentToDownloaderDialog.value = true;
}
</script>

<template>
  <a-modal
    v-model:open="showDialog"
    :cancel-text="t('common.dialog.cancel')"
    :ok-button-props="{ disabled: inputMode === 'url' ? !urlInput.trim() : torrentFiles.length === 0 }"
    :ok-text="t('common.dialog.ok')"
    :title="t('MyClient.pushToDownloader.title')"
    :width="560"
    @ok="submit"
  >
    <a-radio-group v-model:value="inputMode" button-style="solid" class="push-to-downloader__mode">
      <a-radio-button value="url"><LinkOutlined />{{ t("MyClient.pushToDownloader.modeUrl") }}</a-radio-button>
      <a-radio-button value="file"><UploadOutlined />{{ t("MyClient.pushToDownloader.modeFile") }}</a-radio-button>
    </a-radio-group>

    <template v-if="inputMode === 'url'">
      <a-form-item :label="t('MyClient.pushToDownloader.urlInputLabel')"
        ><a-textarea v-model:value="urlInput" :auto-size="{ minRows: 3 }" allow-clear></a-textarea
      ></a-form-item>
    </template>

    <template v-else>
      <a-form-item
        :label="t('MyClient.pushToDownloader.fileInputLabel')"
        :help="t('MyClient.pushToDownloader.fileInputHint')"
      >
        <a-upload
          :file-list="uploadFileList"
          :before-upload="onBeforeUpload"
          accept=".torrent"
          multiple
          show-upload-list
          @remove="onRemoveFile"
        >
          <a-button><UploadOutlined />{{ t("MyClient.pushToDownloader.fileInputLabel") }}</a-button>
        </a-upload>
      </a-form-item>
    </template>
  </a-modal>

  <SentToDownloaderDialog
    v-model="showSentToDownloaderDialog"
    :torrent-items="pendingTorrentItems"
    allow-site-less-link
    @done="() => (showDialog = false)"
  />
</template>

<style scoped>
/* 推送方式切换与下方输入区留出间距 */
.push-to-downloader__mode {
  margin-bottom: 16px;
}
</style>
