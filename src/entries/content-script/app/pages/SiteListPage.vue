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
  StarOutlined,
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
import TorrentFavoriteDialog from "@/options/components/TorrentFavoriteDialog.vue";

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
    runtimeStore.showSnackbar(errorMessage, { color: "error" });
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
    // 用 allSettled：一条失败不应把已成功的条目说成失败，否则用户重试会重复下载它们。
    const results = await Promise.allSettled(
      torrents.map((torrent) => sendMessage("downloadTorrent", { torrent, downloaderId: "local" })),
    );
    const failed = results.filter((result) => result.status === "rejected").length;
    if (failed > 0) {
      const success = results.length - failed;
      runtimeStore.showSnackbar(
        success > 0
          ? t("contentScript.localDownloadPartial", { success, failed })
          : t("contentScript.localDownloadFailed"),
        { color: success > 0 ? "warning" : "error" },
      );
    }
  } catch (e) {
    runtimeStore.showSnackbar(t("contentScript.localDownloadFailed"), { color: "error" });
  } finally {
    localDownloadMultiStatus.value = false;
  }
}

const linkCopyMultiStatus = ref<boolean>(false);

/**
 * 以有限并发执行任务并保留每一项的 settle 结果。
 * 批量复制/下载不能因为一条失败就丢弃其余已成功的结果（Promise.all 的全有或全无）。
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let cursor = 0;
  const run = async () => {
    while (cursor < items.length) {
      const index = cursor++;
      try {
        results[index] = { status: "fulfilled", value: await worker(items[index]!) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => run()));
  return results;
}

async function handleLinkCopyMulti() {
  linkCopyMultiStatus.value = true;

  try {
    const { torrents } = await parseListPage();
    if (torrents.length === 0) return;

    // 并发上限 4：一条链接获取失败不影响其余条目，先复制成功的部分
    const results = await mapWithConcurrency(torrents, 4, (torrent) => sendMessage("getTorrentDownloadLink", torrent));
    const downloadUrls = results
      .filter((result): result is PromiseFulfilledResult<string> => result.status === "fulfilled" && !!result.value)
      .map((result) => result.value);
    const failed = results.length - downloadUrls.length;

    if (downloadUrls.length === 0) {
      runtimeStore.showSnackbar(t("contentScript.copyLinkFailed"), { color: "error" });
      return;
    }

    const copied = await copyTextToClipboard(downloadUrls.join("\n").trim());
    if (!copied) {
      runtimeStore.showSnackbar(t("contentScript.copyLinkFailed"), { color: "error" });
      return;
    }

    if (failed > 0) {
      // 部分成功：复用现有两条提示组合展示，不新增 i18n key
      runtimeStore.showSnackbar(
        `${t("contentScript.copyLinkSuccess")} (${downloadUrls.length}/${results.length}) / ${t("contentScript.copyLinkFailed")} (${failed}/${results.length})`,
        { color: "warning" },
      );
    } else {
      runtimeStore.showSnackbar(t("contentScript.copyLinkSuccess"), { color: "success" });
    }
  } catch (e) {
    runtimeStore.showSnackbar(t("contentScript.copyLinkFailed"), { color: "error" });
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
    runtimeStore.showSnackbar(t("contentScript.operationFailed"), { color: "error" });
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
    runtimeStore.showSnackbar(t("contentScript.operationFailed"), { color: "error" });
  }
}

// 收藏（当前页面解析出的全部种子，或高级列表中勾选的种子）
// 写入由 offscreen 校验：每个 torrent.site 都必须与当前页面所属站点绑定（utils/torrentFavorite.ts）
const favoriteTorrents = shallowRef<ITorrent[]>([]);
const showFavoriteDialog = ref<boolean>(false);

function openFavoriteDialog(torrents: ITorrent[]) {
  if (torrents.length === 0) {
    return;
  }
  favoriteTorrents.value = torrents;
  showFavoriteDialog.value = true;
}

async function handleFavoriteMulti() {
  try {
    const { torrents } = await parseListPage();
    openFavoriteDialog(torrents);
  } catch (e) {
    runtimeStore.showSnackbar(t("contentScript.operationFailed"), { color: "error" });
  }
}

function handleFavoriteSelected(torrents: ITorrent[]) {
  showAdvanceListModuleDialog.value = false;
  openFavoriteDialog(torrents);
}

async function handleSearch() {
  // CONTENTSCRIPT-3：await parseListPage() 同样要处理失败，否则快捷搜索的点击会留下 unhandled rejection
  try {
    let keywords = (await parseListPage()).keywords;

    await doKeywordSearch(keywords);
  } catch (e) {
    runtimeStore.showSnackbar(t("contentScript.operationFailed"), { color: "error" });
  }
}
</script>

<template>
  <!-- SpeedDial 中越靠前的按钮越靠近主按钮，收藏放在最前（与上游一致） -->
  <SpeedDialBtn
    key="favorite"
    :icon="StarOutlined"
    :title="t('contentScript.favoriteTorrents')"
    :label="t('contentScript.speedDial.favorite')"
    @click="handleFavoriteMulti"
  />
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

  <AdvanceListModuleDialog
    v-model="showAdvanceListModuleDialog"
    :torrent-items="parsedTorrents"
    @favorite="handleFavoriteSelected"
  />

  <TorrentFavoriteDialog v-model="showFavoriteDialog" :torrent-items="favoriteTorrents" />
</template>
