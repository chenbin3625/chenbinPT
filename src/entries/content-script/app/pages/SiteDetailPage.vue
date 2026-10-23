<script setup lang="ts">
import { computed, inject } from "vue";
import { useI18n } from "vue-i18n";
import { CloudDownloadOutlined, CopyOutlined, DownloadOutlined, SearchOutlined } from "@ant-design/icons-vue";
import type { ITorrent } from "@ptd/site";

import { sendMessage } from "@/messages.ts";
import { useRuntimeStore } from "@/options/stores/runtime.ts";
import { useMetadataStore } from "@/options/stores/metadata.ts";

import type { IRemoteDownloadDialogData } from "../types.ts";
import {
  copyTextToClipboard,
  doKeywordSearch,
  ensureTrustedTorrentLink,
  siteInstance,
  type IPtdData,
} from "../utils.ts";

import SpeedDialBtn from "../components/SpeedDialBtn.vue";

const metadataStore = useMetadataStore();
const runtimeStore = useRuntimeStore();
const { t } = useI18n();

const ptdData = inject<IPtdData>("ptd_data", {});
const enabledDownloadersBySite = computed(() => {
  return metadataStore.getEnabledDownloadersBySite(ptdData.siteId ?? "");
});

/**
 * 解析详情页。
 *
 * B2-4：`requireLink` 区分两类动作 —— 「复制链接 / 推送到下载器」需要可下载的 link，
 * 而「快捷搜索」只需要标题。旧实现让快捷搜索也复用「必须解析出 link」的同一路径，
 * 于是详情页 link 解析失败时快捷搜索完全不会执行，还弹一条与本动作无关的错误。
 */
async function parseDetailPage(options: { requireLink?: boolean } = {}) {
  const { requireLink = true } = options;
  const parsedResult = await siteInstance.value?.transformDetailPage(document);

  if (!parsedResult) {
    runtimeStore.showSnakebar(t("contentScript.parsePageFailed"), { color: "error" });
    throw new Error("无法解析当前页面种子信息");
  }

  // 真值判定：fixLink 对危险 scheme（javascript:/data:/file: 等）返回空串，
  // 空串与 undefined 都是「没解析到链接」，必须走同一条提示，而不是把空串当成可用下载链接往下传。
  if (requireLink && !parsedResult.link) {
    runtimeStore.showSnakebar(t("contentScript.cannotParseDetailLink"), { color: "error" });
    throw new Error("无法解析当前页面种子链接");
  }

  // 更新搜索状态，方便 SentToDownloaderDialog 中替换
  runtimeStore.search.searchPlanKey = "all";
  runtimeStore.search.searchKey = parsedResult?.title ?? "";

  return parsedResult;
}

const remoteDownloadDialogData = inject<IRemoteDownloadDialogData>("remoteDownloadDialogData")!;

/**
 * 解析详情页 + 校验链接来源，供「拿链接去发请求」的动作（复制链接 / 推送到下载器）使用。
 * 任一环节失败都返回 undefined，且失败原因已经提示过（不重复弹窗）。
 */
async function parseTrustedDetailTorrent(): Promise<ITorrent | undefined> {
  try {
    const torrent = await parseDetailPage();

    // S-2：详情页链接同样可能被页面注入（下载列里的异站 <a href>）；magnet: 没有 host，不受影响
    return (await ensureTrustedTorrentLink(torrent, ptdData.siteId)) ? torrent : undefined;
  } catch {
    // parseDetailPage 内部已经给出「无法解析当前页面种子链接 / 页面信息」的提示
    return undefined;
  }
}

async function handleLinkCopy() {
  const torrent = await parseTrustedDetailTorrent();
  if (!torrent) return;

  try {
    const downloadUrl = await sendMessage("getTorrentDownloadLink", torrent);

    const copied = await copyTextToClipboard(downloadUrl);
    runtimeStore.showSnakebar(copied ? t("contentScript.copyLinkSuccess") : t("contentScript.copyLinkFailed"), {
      color: copied ? "success" : "error",
    });
  } catch (e) {
    runtimeStore.showSnakebar(t("contentScript.copyLinkFailed"), { color: "error" });
  }
}

async function handleRemoteDownload(isDefaultSend = false) {
  const torrent = await parseTrustedDetailTorrent();
  if (!torrent) return;

  remoteDownloadDialogData.torrents = [torrent];
  remoteDownloadDialogData.isDefaultSend = isDefaultSend;
  remoteDownloadDialogData.show = true;
}

function handleSearch() {
  // B2-4：快捷搜索只用到标题，不要求下载链接（link 解析失败不再阻止搜索）
  parseDetailPage({ requireLink: false })
    .then((torrent) => {
      void doKeywordSearch(torrent.title || "");
    })
    .catch(() => {
      // parseDetailPage 内部已经给出提示；快捷搜索只用到标题，链接缺失不影响搜索本身
    });
}
</script>

<template>
  <SpeedDialBtn
    key="copy"
    type="primary"
    :icon="CopyOutlined"
    :title="t('contentScript.copyLink')"
    :label="t('contentScript.speedDial.copyLink')"
    @click="handleLinkCopy"
  />
  <SpeedDialBtn
    key="download"
    :disabled="enabledDownloadersBySite.length === 0"
    type="primary"
    :icon="CloudDownloadOutlined"
    :title="t('contentScript.pushTo')"
    :label="t('contentScript.speedDial.pushTo')"
    @click="() => handleRemoteDownload()"
  />
  <SpeedDialBtn
    key="download_default"
    v-if="metadataStore.defaultDownloader?.id"
    :disabled="enabledDownloadersBySite.length === 0"
    type="primary"
    :icon="DownloadOutlined"
    :title="t('contentScript.pushToDefault')"
    :label="t('contentScript.speedDial.pushToDefault')"
    @click="handleRemoteDownload(true)"
  />
  <SpeedDialBtn
    key="search"
    :icon="SearchOutlined"
    :title="t('contentScript.quickSearch')"
    :label="t('contentScript.speedDial.quickSearch')"
    @click="handleSearch"
  />
</template>
