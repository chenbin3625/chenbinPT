<script setup lang="ts">
import { computed, inject, ref, shallowRef } from "vue";
import { useI18n } from "vue-i18n";
import {
  CheckSquareOutlined,
  CloudDownloadOutlined,
  CopyOutlined,
  DownloadOutlined,
  SaveOutlined,
  SearchOutlined,
} from "@ant-design/icons-vue";
import { type ITorrent } from "@ptd/site";

import { sendMessage } from "@/messages.ts";
import { useRuntimeStore } from "@/options/stores/runtime.ts";
import { useMetadataStore } from "@/options/stores/metadata.ts";

import type { IRemoteDownloadDialogData } from "../types.ts";
import {
  copyTextToClipboard,
  doKeywordSearch,
  getTrustedLinkHosts,
  sanitizeParsedTorrents,
  siteInstance,
  wrapperConfirmFn,
  type IPtdData,
} from "../utils.ts";

import AdvanceListModuleDialog from "../components/AdvanceListModuleDialog.vue";
import SpeedDialBtn from "../components/SpeedDialBtn.vue";

const metadataStore = useMetadataStore();
const runtimeStore = useRuntimeStore();
const { t } = useI18n();

const ptdData = inject<IPtdData>("ptd_data", {});
const enabledDownloadersBySite = computed(() => {
  return metadataStore.getEnabledDownloadersBySite(ptdData.siteId ?? "");
});

async function parseListPage(showNoTorrentError = true) {
  // 使用克隆的文档，避免污染原始文档
  const parsedResult = await siteInstance.value?.transformListPage(document.cloneNode(true) as Document);

  // S-2：页面可以往下载列塞任意 <a href>，只保留 host 落在该站点已知范围内的链接；
  // 被剔除的条目会单独提示（sanitizeParsedTorrents 内），与下面的「未解析到种子」互补。
  const torrents = sanitizeParsedTorrents(parsedResult?.torrents ?? [], await getTrustedLinkHosts(ptdData.siteId));

  let errorMessage = "";
  if (torrents.length === 0) {
    errorMessage = t("contentScript.noTorrentParsed");
  }

  if (showNoTorrentError && errorMessage) {
    runtimeStore.showSnakebar(errorMessage, { color: "error" });
  }

  // 更新搜索状态，方便 SentToDownloaderDialog 中替换
  runtimeStore.search.searchPlanKey = "all";
  runtimeStore.search.searchKey = parsedResult?.keywords ?? "";

  return { torrents, keywords: parsedResult?.keywords ?? "" };
}

const localDownloadMultiStatus = ref<boolean>(false);
async function handleLocalDownloadMulti() {
  localDownloadMultiStatus.value = true;

  try {
    const { torrents } = await parseListPage();

    // A-9：必须 await 这些消息。原来是 fire-and-forget，loading 在发送完成前就被复位（UI 谎报完成），
    // 失败也没有任何提示。offscreen 侧有 DOWNLOAD_CONCURRENCY 队列与下载间隔预留，并发投递是设计内行为。
    await Promise.all(torrents.map((torrent) => sendMessage("downloadTorrent", { torrent, downloaderId: "local" })));
  } catch (e) {
    runtimeStore.showSnakebar(t("contentScript.localDownloadFailed"), { color: "error" });
  } finally {
    localDownloadMultiStatus.value = false;
  }
}

const linkCopyMultiStatus = ref<boolean>(false);
async function handleLinkCopyMulti() {
  linkCopyMultiStatus.value = true;

  try {
    const { torrents } = await parseListPage();
    const downloadUrls = await Promise.all(torrents.map((torrent) => sendMessage("getTorrentDownloadLink", torrent)));

    const copied = await copyTextToClipboard(downloadUrls.join("\n").trim());
    runtimeStore.showSnakebar(copied ? t("contentScript.copyLinkSuccess") : t("contentScript.copyLinkFailed"), {
      color: copied ? "success" : "error",
    });
  } catch (e) {
    runtimeStore.showSnakebar(t("contentScript.copyLinkFailed"), { color: "error" });
  } finally {
    linkCopyMultiStatus.value = false;
  }
}

const remoteDownloadDialogData = inject<IRemoteDownloadDialogData>("remoteDownloadDialogData")!;

// CONTENTSCRIPT-3：parseListPage() 会 await 引擎解析 / host 校验，失败时必须给出 UI 反馈；
// 原来这两条 .then 链没有 catch/finally，解析抛错时按钮静默无反应并留下 unhandled rejection
// （同文件的 handleLocalDownloadMulti/handleLinkCopyMulti 都显式处理了失败）。
async function handleRemoteDownloadMulti(isDefaultSend = false) {
  try {
    const { torrents } = await parseListPage();
    if (torrents.length > 0) {
      remoteDownloadDialogData.torrents = torrents;
      remoteDownloadDialogData.isDefaultSend = isDefaultSend;
      remoteDownloadDialogData.show = true;
    }
  } catch (e) {
    runtimeStore.showSnakebar(t("contentScript.operationFailed"), { color: "error" });
  }
}

const parsedTorrents = shallowRef<ITorrent[]>([]);
const showAdvanceListModuleDialog = ref<boolean>(false);

async function handleAdvanceListModule() {
  try {
    const { torrents } = await parseListPage();
    if (torrents.length > 0) {
      parsedTorrents.value = torrents;
      showAdvanceListModuleDialog.value = true;
    }
  } catch (e) {
    runtimeStore.showSnakebar(t("contentScript.operationFailed"), { color: "error" });
  }
}

async function handleSearch() {
  // CONTENTSCRIPT-3：await parseListPage() 同样要处理失败，否则快捷搜索的点击会留下 unhandled rejection
  try {
    let keywords = (await parseListPage()).keywords;

    await doKeywordSearch(keywords);
  } catch (e) {
    runtimeStore.showSnakebar(t("contentScript.operationFailed"), { color: "error" });
  }
}
</script>

<template>
  <SpeedDialBtn
    key="save"
    :loading="localDownloadMultiStatus"
    type="primary"
    :icon="SaveOutlined"
    :title="t('downloaderLabel.localDownload')"
    :label="t('contentScript.speedDial.localDownload')"
    @click="wrapperConfirmFn(handleLocalDownloadMulti)"
  />
  <SpeedDialBtn
    key="copy"
    :loading="linkCopyMultiStatus"
    type="primary"
    :icon="CopyOutlined"
    :title="t('contentScript.copyLink')"
    :label="t('contentScript.speedDial.copyLink')"
    @click="wrapperConfirmFn(handleLinkCopyMulti)"
  />
  <SpeedDialBtn
    key="download"
    :disabled="enabledDownloadersBySite.length === 0"
    type="primary"
    :icon="CloudDownloadOutlined"
    :title="t('contentScript.pushTo')"
    :label="t('contentScript.speedDial.pushTo')"
    @click="() => handleRemoteDownloadMulti()"
  />
  <SpeedDialBtn
    key="download_default"
    v-if="metadataStore.defaultDownloader?.id"
    :disabled="enabledDownloadersBySite.length === 0"
    type="primary"
    :icon="DownloadOutlined"
    :title="t('contentScript.pushToDefault')"
    :label="t('contentScript.speedDial.pushToDefault')"
    @click="() => handleRemoteDownloadMulti(true)"
  />

  <SpeedDialBtn
    key="advance"
    :icon="CheckSquareOutlined"
    :title="t('contentScript.advanceList')"
    :label="t('contentScript.speedDial.advanceList')"
    @click="handleAdvanceListModule"
  />
  <SpeedDialBtn
    key="search"
    :icon="SearchOutlined"
    :title="t('contentScript.quickSearch')"
    :label="t('contentScript.speedDial.quickSearch')"
    @click="handleSearch"
  />

  <AdvanceListModuleDialog v-model="showAdvanceListModuleDialog" :torrent-items="parsedTorrents" />
</template>
