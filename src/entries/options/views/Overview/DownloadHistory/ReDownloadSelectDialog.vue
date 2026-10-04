<script setup lang="ts">
import { CloudDownloadOutlined, ReloadOutlined, SaveOutlined } from "@ant-design/icons-vue";
import { nextTick, ref, shallowRef, watch, type Component } from "vue";
import { useI18n } from "vue-i18n";
import type { CAddTorrentOptions } from "@ptd/downloader";

import { sendMessage } from "@/messages.ts";
import { useResetableRef } from "@/options/directives/useResetableRef.ts";
import type { ITorrentDownloadMetadata } from "@/shared/types.ts";

import SentToDownloaderDialog from "@/options/components/SentToDownloaderDialog/Index.vue";

const { t } = useI18n();

const showDialog = defineModel<boolean>();
const emit = defineEmits<{
  (e: "reDownloadComplete"): void;
}>();

const { torrentItems } = defineProps<{
  torrentItems: ITorrentDownloadMetadata[];
}>();

type TReDownloadType = "old" | "local" | "downloader";

const { ref: isReDownloading, reset: resetIsReDownloading } = useResetableRef<Record<TReDownloadType, boolean>>(() => ({
  old: false,
  local: false,
  downloader: false,
}));

const disableLocalDownload = ref<boolean>(false);
const showSentToDownloaderDialog = ref<boolean>(false);
const downloadTorrentsRef = shallowRef<ITorrentDownloadMetadata["torrent"][]>([]);

const btnItem: Record<TReDownloadType, { icon: Component; color: string; title: string }> = {
  old: { icon: ReloadOutlined, color: "indigo", title: t("DownloadHistory.ReDownloadSelectDialog.oldMethod") },
  local: { icon: SaveOutlined, color: "orange", title: t("downloaderLabel.localDownload") },
  downloader: {
    icon: CloudDownloadOutlined,
    color: "cyan",
    title: t("DownloadHistory.ReDownloadSelectDialog.selectDownloader"),
  },
};

function submitDownloadFinish(reDownloadType: TReDownloadType) {
  isReDownloading.value[reDownloadType] = false;
  emit("reDownloadComplete");
  showDialog.value = false;
}

function reDownload(reDownloadType: TReDownloadType) {
  isReDownloading.value[reDownloadType] = true;
  if (reDownloadType === "downloader") {
    // 对 downloader 则弹出 SentToDownloaderDialog 进行下一步操作
    downloadTorrentsRef.value = torrentItems.map((x) => x.torrent);
    showSentToDownloaderDialog.value = true;
  } else {
    // 对 old 和 local 直接调用下载方法
    const promises = [];

    for (const history of torrentItems) {
      if (history) {
        const historyTorrent = history.torrent;
        if (reDownloadType === "local" || history.downloaderId === "local") {
          promises.push(sendMessage("downloadTorrent", { torrent: historyTorrent, downloaderId: "local" }));
        } else {
          promises.push(
            sendMessage("downloadTorrent", {
              torrent: historyTorrent,
              downloaderId: history.downloaderId,
              addTorrentOptions: (history.addTorrentOptions ?? {}) as CAddTorrentOptions,
            }),
          );
        }
      }
    }

    Promise.all(promises).finally(() => {
      submitDownloadFinish(reDownloadType);
    });
  }
}

function dialogEnter() {
  resetIsReDownloading();

  // 如果传入的种子列表中有 magnet 链接，则禁用本地下载按钮
  disableLocalDownload.value = torrentItems.some((t) => t?.torrent?.link?.startsWith("magnet:"));
}

// 原生 a-modal 没有 afterOpenChange（只有 afterClose），打开时的初始化自行监听 open。
watch(showDialog, (open) => {
  if (open) nextTick(dialogEnter);
});
</script>

<template>
  <a-modal
    v-model:open="showDialog"
    :footer="null"
    :title="t('DownloadHistory.ReDownloadSelectDialog.title', [torrentItems.length])"
    :width="600"
  >
    <a-list>
      <a-list-item v-for="(value, key) in btnItem" :key="key">
        <a-button
          :loading="isReDownloading[key]"
          block
          size="large"
          style="justify-content: flex-start"
          @click="reDownload(key)"
          ><component :is="value.icon" />
          {{ value.title }}
        </a-button>
      </a-list-item>
    </a-list>
  </a-modal>

  <SentToDownloaderDialog
    v-model="showSentToDownloaderDialog"
    :torrent-items="downloadTorrentsRef"
    @cancel="() => (isReDownloading.downloader = false)"
    @done="() => submitDownloadFinish('downloader')"
  />
</template>
