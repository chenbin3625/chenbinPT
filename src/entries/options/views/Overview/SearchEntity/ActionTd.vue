<script setup lang="ts">
import {
  CloudDownloadOutlined,
  CopyOutlined,
  DownloadOutlined,
  MergeCellsOutlined,
  SaveOutlined,
} from "@ant-design/icons-vue";
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";

import { sendMessage } from "@/messages.ts";
import type { ISearchResultTorrent } from "@/shared/types.ts";
import { useRuntimeStore } from "@/options/stores/runtime.ts";
import { useMetadataStore } from "@/options/stores/metadata.ts";

import SentToDownloaderDialog from "@/options/components/SentToDownloaderDialog/Index.vue";
import KeepUploadDialog from "./KeepUploadDialog.vue";

const {
  torrentItems,
  compact = false,
  showKeepUploadBtn = true,
  showLabel = false,
  variant = "table",
} = defineProps<{
  torrentItems: ISearchResultTorrent[];
  compact?: boolean;
  showKeepUploadBtn?: boolean;
  /** 文字按钮模式：在图标右侧显示短文案（用于页面底部的多选操作条），表格行内仍只显示图标 */
  showLabel?: boolean;
  /** table: 表格单元格内的 24px 图标小按钮；bar: 页面底部的多选操作条（不套表格操作栏尺寸样式） */
  variant?: "table" | "bar";
}>();

const isBarVariant = computed(() => variant === "bar");

const btnSize = computed<"small" | "middle">(() => (compact ? "small" : "middle"));

// PtdBtn 的 text prop 与插槽互斥：未开启文字模式时传 undefined，保持图标按钮（圆形 + tooltip）的原样式
function buttonLabel(key: string) {
  return showLabel ? t(`SearchEntity.ActionTd.label.${key}`) : undefined;
}

const { t } = useI18n();
const metadataStore = useMetadataStore();
const runtimeStore = useRuntimeStore();

async function getTorrentDownloadLinks() {
  const downloadUrls = [];

  for (const torrent of torrentItems) {
    const downloadUrl = await sendMessage("getTorrentDownloadLink", torrent);
    // 记录 site/id 而不是 `${torrent}`（模板字符串里是 "[object Object]"，没有任何信息量）；
    // 下载链接里的凭据由 offscreen logger 统一脱敏。日志失败不影响取链接。
    void sendMessage("logger", { msg: `torrent ${torrent.site}/${torrent.id} download link: ${downloadUrl}` }).catch(
      () => {},
    );
    downloadUrls.push({ torrent, downloadUrl });
  }

  return downloadUrls;
}

const copyTorrentDownloadLinkBtnStatus = ref(false);
async function copyTorrentDownloadLink() {
  // V-16：整段都必须包在 try/finally 里——`getTorrentDownloadLinks()` 一旦 reject
  // （`sendMessage("getTorrentDownloadLink")` 失败），原先位于 try 之外的复位语句不会执行，
  // 复制按钮会永久转圈，同时产生 unhandled rejection。
  copyTorrentDownloadLinkBtnStatus.value = true;
  try {
    const downloadUrls = await getTorrentDownloadLinks();
    await navigator.clipboard.writeText(
      downloadUrls
        .map((x) => x.downloadUrl)
        .join("\n")
        .trim(),
    );
    runtimeStore.showSnakebar(t("SearchEntity.ActionTd.copyLinkSuccess"), { color: "success" });
  } catch (e) {
    runtimeStore.showSnakebar(t("SearchEntity.ActionTd.copyLinkFailed"), { color: "error" });
  } finally {
    copyTorrentDownloadLinkBtnStatus.value = false;
  }
}

const localDlTorrentDownloadLinkBtnStatus = ref(false);
async function localDlTorrentDownloadLink() {
  localDlTorrentDownloadLinkBtnStatus.value = true;
  try {
    const results = await Promise.allSettled(
      torrentItems.map((torrent) => sendMessage("downloadTorrent", { torrent, downloaderId: "local" })),
    );

    // OPTIONSOVERVIEW-3：downloadTorrent 失败时不会 reject，而是返回 { downloadStatus: "failed", errorMessage }，
    // 旧写法完全不看 allSettled 结果，批量本地下载失败时静默无声。按 ReDownloadSelectDialog 的写法统计失败。
    let failedCount = 0;
    let firstError = "";
    // DOWNLOADER-8：downloadTorrent 结果里 warningMessage 表示「推送成功但部分设置未生效」，
    // 它与失败并列、不能计入失败数，但也必须让用户看到，否则「设置已生效」是错误预期。
    let warningCount = 0;
    let firstWarning = "";
    for (const result of results) {
      if (result.status === "rejected") {
        failedCount++;
        firstError ||= String(result.reason);
      } else if (result.value?.downloadStatus === "failed") {
        failedCount++;
        firstError ||= result.value.errorMessage ?? "";
      } else if (result.value?.warningMessage) {
        warningCount++;
        firstWarning ||= result.value.warningMessage;
      }
    }

    // 只在有失败时提示：逐行批量下载成功时也弹提示会淹没有效信息
    if (failedCount > 0) {
      const succeeded = results.length - failedCount;
      const errorDetail = firstError ? ` (${t("DownloadHistory.detail.errorMessage")}: ${firstError})` : "";
      const message = `${t("contentScript.localDownloadFailed")} (${succeeded}/${results.length})${errorDetail}`;
      runtimeStore.showSnakebar(message, { color: succeeded > 0 ? "warning" : "error" });
    } else if (warningCount > 0) {
      // DOWNLOADER-8：全部成功但有降级告警时也必须提示（此时不会有失败提示，告警否则完全不可见）
      const warningDetail = firstWarning ? ` (${t("DownloadHistory.detail.warningMessage")}: ${firstWarning})` : "";
      const message = `${t("DownloadHistory.warningSummary", { count: warningCount })} (${results.length}/${results.length})${warningDetail}`;
      runtimeStore.showSnakebar(message, { color: "warning" });
    }
  } finally {
    // V-16 同类：取链接/下载中途抛错时也必须复位 loading，否则按钮永久转圈
    localDlTorrentDownloadLinkBtnStatus.value = false;
  }
}

const showDownloadClientDialog = ref(false);
const isDefaultSend = ref(false);

function sendToDownloader(defaultDownload = false) {
  isDefaultSend.value = defaultDownload;
  showDownloadClientDialog.value = true;
}

const showKeepUploadDialog = ref(false);

function openKeepUploadDialog() {
  showKeepUploadDialog.value = true;
}
</script>

<template>
  <a-button-group :class="[isBarVariant ? 'ptd-action-bar' : 'table-action', showLabel ? 'ptd-action-text' : null]">
    <a-button
      v-if="metadataStore.defaultDownloader?.id"
      :disabled="torrentItems.length == 0"
      :title="t('SearchEntity.ActionTd.sendToDefault')"
      @click="() => sendToDownloader(true)"
      :size="btnSize"
      ><template #icon><DownloadOutlined /></template>{{ buttonLabel("sendToDefault") }}</a-button
    >

    <!-- 下载到服务器 -->
    <a-button
      :disabled="torrentItems.length == 0"
      :title="t('SearchEntity.ActionTd.sendToDownloader')"
      @click="() => sendToDownloader()"
      :size="btnSize"
      ><template #icon><CloudDownloadOutlined /></template>{{ buttonLabel("sendToDownloader") }}</a-button
    >
    <!-- 复制下载链接 -->
    <a-button
      :disabled="torrentItems.length == 0"
      :loading="copyTorrentDownloadLinkBtnStatus"
      :title="t('SearchEntity.ActionTd.copyLink')"
      @click="() => copyTorrentDownloadLink()"
      :size="btnSize"
      ><template #icon><CopyOutlined /></template>{{ buttonLabel("copyLink") }}</a-button
    >
    <!-- 下载种子文件到本地 -->
    <a-button
      :disabled="torrentItems.length == 0"
      :loading="localDlTorrentDownloadLinkBtnStatus"
      :title="t('SearchEntity.ActionTd.localDownload')"
      @click="() => localDlTorrentDownloadLink()"
      :size="btnSize"
      ><template #icon><SaveOutlined /></template>{{ buttonLabel("localDownload") }}</a-button
    >
    <!-- 辅种检测 -->
    <a-button
      v-if="showKeepUploadBtn"
      :disabled="torrentItems.length < 2"
      :title="t('SearchEntity.KeepUploadDialog.keepUpload')"
      @click="openKeepUploadDialog"
      :size="btnSize"
      ><template #icon><MergeCellsOutlined /></template>{{ buttonLabel("keepUpload") }}</a-button
    >
  </a-button-group>

  <!-- 在点击发送到远程服务器时，弹出选择下载器及其他自定义选项 -->
  <!-- P1-17：对话框按需挂载（仅打开时存在实例），表格每行不再常驻对话框 -->
  <SentToDownloaderDialog
    v-if="showDownloadClientDialog"
    v-model="showDownloadClientDialog"
    :torrent-items="torrentItems"
    :is-default-send="isDefaultSend"
  />

  <!-- 辅种检测对话框 -->
  <KeepUploadDialog
    v-if="showKeepUploadBtn && showKeepUploadDialog"
    v-model="showKeepUploadDialog"
    :torrent-items="torrentItems"
  />
</template>
