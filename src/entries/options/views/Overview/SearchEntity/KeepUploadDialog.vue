<script setup lang="ts">
import {
  CheckOutlined,
  CloseOutlined,
  MinusOutlined,
  PlusOutlined,
  QuestionOutlined,
  SaveOutlined,
  SyncOutlined,
} from "@ant-design/icons-vue";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import type { CTorrent } from "@ptd/downloader";
import type { ITorrent } from "@ptd/site";

export interface IClientBaseTorrentRef {
  downloaderId: string;
  torrentId: string;
  name: string;
  size: number;
  infoHash?: string;
  savePath?: string;
}

import { sendMessage } from "@/messages.ts";
import type { ITorrentInfoForVerification } from "@/messages.ts";
import type { IKeepUploadTask, IKeepUploadTaskItem, IKeepUploadTaskDownloadOptions } from "@/shared/types.ts";
import { formatSize } from "@/options/utils.ts";
import { useMetadataStore } from "@/options/stores/metadata.ts";
import { useRuntimeStore } from "@/options/stores/runtime.ts";
import { useConfigStore } from "@/options/stores/config.ts";

import NoDataPlaceholder from "@/options/components/NoDataPlaceholder.vue";
import { confirmModal } from "../utils/antdConfirm.ts";
import SiteFavicon from "@/options/components/SiteFavicon/Index.vue";
import { mapWithConcurrency } from "./utils/concurrency.ts";

/** 批量拉取种子信息的并发上限（避免一次打开大量站点请求） */
const VERIFY_CONCURRENCY = 4;

const showDialog = defineModel<boolean>();
const { torrentItems, clientBaseTorrent } = defineProps<{
  torrentItems: ITorrent[];
  clientBaseTorrent?: IClientBaseTorrentRef | null;
}>();

const { t } = useI18n();
const configStore = useConfigStore();
const metadataStore = useMetadataStore();
const runtimeStore = useRuntimeStore();

interface IVerifiedItem {
  id: string; // Map key
  data: ITorrent;
  torrent: ITorrentInfoForVerification | null;
  loading: boolean;
  verified: boolean;
  status: TVerificationStatus;
  error: boolean;
}

type TVerificationStatus =
  "downloading" | "waiting" | "downloaded" | "success" | "failed" | "downloadFailed" | "missingFiles";

const verifiedItems = ref<Map<string, IVerifiedItem>>(new Map());
const verifiedItemsOrder = ref<string[]>([]); // 保持顺序
const baseTorrent = ref<ITorrentInfoForVerification | null>(null);
const verifiedCount = ref(0);
const creating = ref(false);

// 校验轮次与单条请求版本：防止移除基准项、单条重试、关闭或卸载弹窗后，旧请求/旧定时器写回过期状态
let verificationEpoch = 0;
const itemRequestVersions = new Map<string, number>();
const pendingTimers = new Set<ReturnType<typeof setTimeout>>();

function clearPendingTimers() {
  for (const timer of pendingTimers) {
    clearTimeout(timer);
  }
  pendingTimers.clear();
}

function bumpItemRequestVersion(id: string): number {
  const next = (itemRequestVersions.get(id) ?? 0) + 1;
  itemRequestVersions.set(id, next);
  return next;
}

function isRequestCurrent(id: string, epoch: number, itemVersion: number): boolean {
  return epoch === verificationEpoch && itemRequestVersions.get(id) === itemVersion;
}

function invalidateVerification() {
  verificationEpoch += 1;
  clearPendingTimers();
  itemRequestVersions.clear();
}

onBeforeUnmount(() => {
  invalidateVerification();
});

/**
 * F5：`verifiedCount` 改为「按当前条目重算」而不是 `++/--`。
 * 移除基准项会触发整批重新校验，同一项可能因为旧一轮的迟到回调被再次验证；
 * 累加式计数会出现「已选择 N 项」与实际勾选数不一致（进而误禁用/误启用创建任务）。
 */
function recalcVerifiedCount() {
  verifiedCount.value = Array.from(verifiedItems.value.values()).filter((item) => item.verified).length;
}

// 下载选项
const selectedDownloaderId = ref<string>("");
const savePath = ref("");
const torrentLabel = ref("");
const suggestedSavePaths = computed(() => metadataStore.downloaders[selectedDownloaderId.value]?.suggestFolders ?? []);
const suggestedLabels = computed(() => metadataStore.downloaders[selectedDownloaderId.value]?.suggestTags ?? []);

const hasClientBase = computed(() => Boolean(clientBaseTorrent?.downloaderId && clientBaseTorrent?.torrentId));
const clientBaseLoading = ref(false);
const clientBaseError = ref(false);

// 是否可以创建任务（反向辅种模式以客户端种子为基准，只需命中 >= 1 条候选即可创建）
const canCreateTask = computed(() => {
  const minVerified = hasClientBase.value ? 1 : 2;
  return verifiedCount.value >= minVerified && Boolean(selectedDownloaderId.value);
});

// 状态文本
const statusText = computed<Record<TVerificationStatus, string>>(() => ({
  downloading: t("SearchEntity.KeepUploadDialog.status.downloading"),
  waiting: t("SearchEntity.KeepUploadDialog.status.waiting"),
  downloaded: t("SearchEntity.KeepUploadDialog.status.downloaded"),
  success: t("SearchEntity.KeepUploadDialog.status.success"),
  failed: t("SearchEntity.KeepUploadDialog.status.failed"),
  downloadFailed: t("SearchEntity.KeepUploadDialog.status.downloadFailed"),
  missingFiles: t("SearchEntity.KeepUploadDialog.status.missingFiles"),
}));

// 打开对话框时初始化
// 必须带 immediate：ActionTd 用 `v-if="showKeepUploadBtn && showKeepUploadDialog"` 按需挂载本组件，
// 挂载时 open 已经是 true，没有「值变化」事件 → 不带 immediate 时 startVerification() 永不执行，
// 辅种检测对话框会打开一片空白（创建任务按钮恒禁用）。
watch(
  showDialog,
  (val) => {
    if (val) {
      startVerification();
    } else {
      invalidateVerification();
    }
  },
  { immediate: true },
);

function startVerification() {
  invalidateVerification();
  const epoch = verificationEpoch;

  verifiedItems.value = new Map();
  verifiedItemsOrder.value = [];
  baseTorrent.value = null;
  verifiedCount.value = 0;
  clientBaseLoading.value = false;
  clientBaseError.value = false;

  const remembered = configStore.download.saveLastDownloader ? metadataStore.lastKeepUpload : undefined;
  const rememberedDownloaderExists = remembered?.downloaderId && metadataStore.downloaders[remembered.downloaderId];
  selectedDownloaderId.value = hasClientBase.value
    ? clientBaseTorrent!.downloaderId
    : rememberedDownloaderExists
      ? remembered.downloaderId!
      : metadataStore.defaultDownloader?.id || "";
  savePath.value = hasClientBase.value
    ? clientBaseTorrent!.savePath || ""
    : rememberedDownloaderExists
      ? remembered?.savePath || ""
      : metadataStore.defaultDownloader?.folder || "";
  torrentLabel.value = rememberedDownloaderExists
    ? remembered?.label || ""
    : metadataStore.defaultDownloader?.tags || "";

  if (hasClientBase.value && clientBaseTorrent) {
    clientBaseLoading.value = true;
    const baseRef = clientBaseTorrent;
    void sendMessage("getClientTorrentFiles", {
      downloaderId: baseRef.downloaderId,
      torrent: { id: baseRef.torrentId, infoHash: baseRef.infoHash || "" } as CTorrent,
    })
      .then((files) => {
        if (epoch !== verificationEpoch) return;
        baseTorrent.value = {
          infoHash: baseRef.infoHash || "",
          name: baseRef.name,
          length: baseRef.size,
          files: (files ?? []).map((f) => ({ path: f.path || f.name, length: f.size })),
        };
        clientBaseLoading.value = false;
      })
      .catch(() => {
        if (epoch !== verificationEpoch) return;
        clientBaseError.value = true;
        clientBaseLoading.value = false;
      });
  }

  const pending: { item: ITorrent; id: string; itemVersion: number }[] = [];
  torrentItems.forEach((item) => {
    const id = crypto.randomUUID();
    const itemVersion = bumpItemRequestVersion(id);

    // 下载链接可能需要后台根据站点和种子 ID 动态解析，不能在此处过滤未提供 link 的选中项。
    verifiedItems.value.set(id, {
      id,
      data: item,
      torrent: null,
      loading: true,
      verified: false,
      status: "downloading",
      error: false,
    });
    verifiedItemsOrder.value.push(id);
    pending.push({ item, id, itemVersion });
  });

  // 限并发拉取：避免选中大量种子时一次性打出几百个消息请求
  void mapWithConcurrency(pending, VERIFY_CONCURRENCY, async ({ item, id, itemVersion }) => {
    if (!isRequestCurrent(id, epoch, itemVersion)) return;
    try {
      const result = await getTorrent(item, id, epoch, itemVersion);
      if (!isRequestCurrent(id, epoch, itemVersion)) return;
      verification(result, id, epoch, itemVersion);
    } catch {
      if (!isRequestCurrent(id, epoch, itemVersion)) return;
      verification(null, id, epoch, itemVersion);
    }
  });
}

async function getTorrent(
  torrent: ITorrent,
  id: string,
  epoch: number,
  itemVersion: number,
): Promise<ITorrentInfoForVerification | null> {
  try {
    const result = await sendMessage("getTorrentInfoForVerification", torrent);
    if (!isRequestCurrent(id, epoch, itemVersion)) return null;
    // 边界检查：确保项仍然存在
    const item = verifiedItems.value.get(id);
    if (!item) return null;
    item.status = "waiting";
    return result;
  } catch (e) {
    if (!isRequestCurrent(id, epoch, itemVersion)) return null;
    // 边界检查：确保项仍然存在
    const item = verifiedItems.value.get(id);
    if (item) {
      item.status = "downloadFailed";
      item.error = true;
    }
    throw e;
  }
}

function verification(torrent: ITorrentInfoForVerification | null, id: string, epoch: number, itemVersion: number) {
  if (!isRequestCurrent(id, epoch, itemVersion)) return;
  // 边界检查：确保项仍然存在
  const item = verifiedItems.value.get(id);
  if (!item) return;

  const isFirstItem = !hasClientBase.value && verifiedItemsOrder.value[0] === id;

  if (isFirstItem) {
    // 第一个种子作为基准种子。重新校验（reDownload）也必须更新它：
    // 旧实现只在 baseTorrent 为空时赋值，基准项重新下载失败后仍保留上一轮的 verified 标记。
    baseTorrent.value = torrent;
    item.loading = false;

    if (torrent) {
      item.torrent = torrent;
      item.verified = true;
      item.status = "downloaded";
    } else {
      item.torrent = null;
      item.verified = false;
      item.status = "failed";
    }
  } else {
    // 等待基准种子加载完成
    const baseLoading = hasClientBase.value
      ? clientBaseLoading.value
      : verifiedItems.value.get(verifiedItemsOrder.value[0])?.loading;
    if (baseLoading) {
      const timer = setTimeout(() => {
        pendingTimers.delete(timer);
        verification(torrent, id, epoch, itemVersion);
      }, 200);
      pendingTimers.add(timer);
      return;
    }

    // 先无条件清掉上一轮的 verified：名称/大小/文件不匹配、下载失败或 torrent=null 时
    // 都不能继续沿用旧结果，否则用户手动点过「+」后重新校验失败仍会被计入辅种任务。
    const result: Partial<IVerifiedItem> = {
      loading: false,
      verified: false,
      torrent: torrent ?? null,
    };

    const baseVerified = hasClientBase.value
      ? Boolean(baseTorrent.value && !clientBaseError.value)
      : Boolean(verifiedItems.value.get(verifiedItemsOrder.value[0])?.verified);

    if (!baseVerified) {
      result.status = "failed";
    }

    if (!torrent || !baseVerified) {
      Object.assign(item, result);
      recalcVerifiedCount();
      return;
    }

    const baseTorrentInfo = baseTorrent.value!;
    const torrentInfo = torrent;

    // 首先检查 infoHash 是否相同
    if (torrentInfo.infoHash && baseTorrentInfo.infoHash && torrentInfo.infoHash === baseTorrentInfo.infoHash) {
      // infoHash 完全相同，说明是同一个种子
      result.verified = true;
    } else {
      // infoHash 不同，检查名称和总大小是否相同
      if (torrentInfo.name === baseTorrentInfo.name && torrentInfo.length === baseTorrentInfo.length) {
        // 检查文件数量是否相同
        if (torrentInfo.files?.length === baseTorrentInfo.files?.length) {
          // 检查所有文件是否都能匹配（不要求顺序一致）
          result.verified = torrentInfo.files.every((file) => {
            return baseTorrentInfo.files.some(
              (sourceFile) => file.path === sourceFile.path && file.length === sourceFile.length,
            );
          });
        } else {
          // 文件数量不同，检查是否缺少文件
          const allFilesFound = torrentInfo.files.every((file) => {
            return baseTorrentInfo.files.some(
              (sourceFile) => file.path === sourceFile.path && file.length === sourceFile.length,
            );
          });
          if (allFilesFound) {
            result.status = "missingFiles";
          }
        }
      }
    }

    result.torrent = torrent;

    if (!result.status) {
      result.status = result.verified ? "success" : "failed";
    }

    Object.assign(item, result);
  }

  recalcVerifiedCount();
}

async function addToVerified(id: string) {
  if (await confirmModal(t("SearchEntity.KeepUploadDialog.addToKeepUploadConfirm"))) {
    const item = verifiedItems.value.get(id);
    if (item) {
      item.verified = true;
      recalcVerifiedCount();
    }
  }
}

/**
 * F5：移除基准项（index 0）后，其余条目是针对「旧基准」得出的验证结果，不能继续沿用 ——
 * 否则新 index 0 会被标成「基准种子」，但其它条目的对比结果与创建出的辅种任务仍基于旧基准。
 * 这里递增 epoch、清空旧定时器并同步重置所有条目（含并发上限之后的第 5+ 项），再按新顺序触发整批校验。
 */
function restartVerification() {
  invalidateVerification();
  const epoch = verificationEpoch;
  baseTorrent.value = null;
  verifiedCount.value = 0;

  const targets: { id: string; itemVersion: number }[] = [];
  for (const id of verifiedItemsOrder.value) {
    const item = verifiedItems.value.get(id);
    if (!item) continue;

    const itemVersion = bumpItemRequestVersion(id);
    item.loading = true;
    item.verified = false;
    item.torrent = null;
    item.error = false;
    item.status = "downloading";
    targets.push({ id, itemVersion });
  }

  // 与首次校验一致限制并发；新 index 0 仍是第一个被取到的条目（worker 按下标顺序领取任务）
  void mapWithConcurrency(targets, VERIFY_CONCURRENCY, async ({ id, itemVersion }) => {
    if (!isRequestCurrent(id, epoch, itemVersion)) return;
    const item = verifiedItems.value.get(id);
    if (!item) return;

    try {
      const result = await getTorrent(item.data, id, epoch, itemVersion);
      if (!isRequestCurrent(id, epoch, itemVersion)) return;
      verification(result, id, epoch, itemVersion);
    } catch {
      if (!isRequestCurrent(id, epoch, itemVersion)) return;
      verification(null, id, epoch, itemVersion);
    }
  });
}

function removeVerifiedItem(id: string) {
  const item = verifiedItems.value.get(id);
  if (!item) return;

  const wasBase = !hasClientBase.value && verifiedItemsOrder.value[0] === id;
  itemRequestVersions.delete(id);
  verifiedItems.value.delete(id);
  verifiedItemsOrder.value = verifiedItemsOrder.value.filter((itemId) => itemId !== id);
  recalcVerifiedCount();

  if (wasBase) {
    if (verifiedItemsOrder.value.length > 0) {
      restartVerification();
    } else {
      invalidateVerification();
      baseTorrent.value = null;
    }
  }
}

function reDownload(id: string) {
  const item = verifiedItems.value.get(id);
  if (!item) return;
  const epoch = verificationEpoch;
  const itemVersion = bumpItemRequestVersion(id);
  item.loading = true;
  item.status = "downloading";
  // 校验结果必须与上一轮彻底脱钩：否则下载失败/不匹配时旧的 verified:true 会残留。
  item.verified = false;
  item.error = false;
  item.torrent = null;
  recalcVerifiedCount();

  getTorrent(item.data, id, epoch, itemVersion)
    .then((result) => {
      if (!isRequestCurrent(id, epoch, itemVersion)) return;
      verification(result, id, epoch, itemVersion);
    })
    .catch(() => {
      if (!isRequestCurrent(id, epoch, itemVersion)) return;
      verification(null, id, epoch, itemVersion);
    });
}

function closeDialog() {
  showDialog.value = false;
}

function resetDownloadOptions() {
  savePath.value = "";
  torrentLabel.value = "";
}

// 获取种子文件数量
function getFileCount(item: IVerifiedItem): number | string {
  return item.torrent?.files?.length ?? "N/A";
}

// 创建辅种任务
async function createKeepUploadTask() {
  if (!canCreateTask.value || !selectedDownloaderId.value) return;

  const verifiedList = Array.from(verifiedItems.value.values()).filter((item) => item.verified);
  if (verifiedList.length === 0) {
    runtimeStore.showSnackbar(t("SearchEntity.KeepUploadDialog.noVerifiedItem"), { color: "error" });
    return;
  }

  creating.value = true;

  try {
    const downloader = metadataStore.downloaders[selectedDownloaderId.value];
    const downloadOptions: IKeepUploadTaskDownloadOptions = {
      downloaderId: selectedDownloaderId.value,
      savePath: savePath.value || undefined,
      clientName: downloader?.name || selectedDownloaderId.value,
      addTorrentOptions: {
        label: torrentLabel.value || undefined,
      },
    };

    const task: IKeepUploadTask = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
      time: Date.now(),
      title: verifiedList[0].data.title || t("torrent.status.unknown"),
      size: verifiedList[0].data.size || 0,
      downloadOptions,
      items: verifiedList.map((item) => ({
        site: item.data.site,
        title: item.data.title || "",
        subTitle: item.data.subTitle,
        category: item.data.category,
        link: item.data.url || "", // ITorrent.url = 详情页链接
        url: item.data.link || "", // ITorrent.link = 下载链接
        size: item.data.size || 0,
        seeders: item.data.seeders,
        leechers: item.data.leechers,
      })) as IKeepUploadTaskItem[],
    };

    await sendMessage("createKeepUploadTask", task);
    if (configStore.download.saveLastDownloader) {
      metadataStore.lastKeepUpload = {
        downloaderId: selectedDownloaderId.value,
        savePath: savePath.value || undefined,
        label: torrentLabel.value || undefined,
      };
      await metadataStore.$save();
    }
    runtimeStore.showSnackbar(t("SearchEntity.KeepUploadDialog.createSuccess"), { color: "success" });
    closeDialog();
  } catch (e) {
    runtimeStore.showSnackbar(t("SearchEntity.KeepUploadDialog.createError"), { color: "error" });
  } finally {
    creating.value = false;
  }
}
</script>

<template>
  <a-modal
    v-model:open="showDialog"
    :keyboard="false"
    :mask-closable="false"
    :title="t('SearchEntity.KeepUploadDialog.title')"
    :width="1024"
  >
    <a-alert
      v-if="hasClientBase && clientBaseTorrent && clientBaseError"
      type="error"
      show-icon
      class="keep-upload-dialog__client-base"
      :message="
        t('SearchEntity.KeepUploadDialog.clientBaseBanner', {
          name: clientBaseTorrent.name,
          size: formatSize(clientBaseTorrent.size),
          files: baseTorrent?.files?.length ?? 0,
        })
      "
    />
    <a-alert
      v-else-if="hasClientBase && clientBaseTorrent"
      type="info"
      show-icon
      class="keep-upload-dialog__client-base"
      :message="
        t('SearchEntity.KeepUploadDialog.clientBaseBanner', {
          name: clientBaseTorrent.name,
          size: formatSize(clientBaseTorrent.size),
          files: baseTorrent?.files?.length ?? 0,
        })
      "
    />

    <a-list size="small" style="max-height: 80vh">
      <template v-for="(id, index) in verifiedItemsOrder" :key="id">
        <a-typography-text v-if="!hasClientBase && index === 0" strong>
          {{ t("SearchEntity.KeepUploadDialog.baseTorrent") }}
        </a-typography-text>
        <a-typography-text v-if="(hasClientBase && index === 0) || (!hasClientBase && index === 1)" strong>
          {{ t("SearchEntity.KeepUploadDialog.otherTorrent") }}
        </a-typography-text>
        <a-list-item v-if="verifiedItems.get(id)">
          <a-list-item-meta>
            <template #avatar>
              <a-avatar :size="18">
                <SiteFavicon :site-id="verifiedItems.get(id)!.data.site" :size="18" />
              </a-avatar>
            </template>
            <template #title>
              <a-typography-link
                :href="verifiedItems.get(id)!.data.url"
                target="_blank"
                rel="noopener noreferrer nofollow"
              >
                {{ verifiedItems.get(id)!.data.title }}
              </a-typography-link>
            </template>
            <template #description>
              {{ t("SearchEntity.KeepUploadDialog.size") }}{{ formatSize(verifiedItems.get(id)!.data.size ?? 0) }},
              {{ t("SearchEntity.KeepUploadDialog.fileCount") }}{{ getFileCount(verifiedItems.get(id)!) }},
              {{ t("SearchEntity.KeepUploadDialog.status.label") }}{{ statusText[verifiedItems.get(id)!.status] }}
            </template>
          </a-list-item-meta>

          <div style="display: flex; gap: 4px">
            <a-button
              v-if="
                (hasClientBase
                  ? Boolean(baseTorrent && !clientBaseError)
                  : verifiedItems.get(verifiedItemsOrder[0])?.verified) &&
                !verifiedItems.get(id)!.loading &&
                !verifiedItems.get(id)!.verified &&
                (hasClientBase || index > 0)
              "
              :title="t('SearchEntity.KeepUploadDialog.addToKeepUpload')"
              @click.stop="addToVerified(id)"
              type="text"
            >
              <PlusOutlined style="color: var(--ptd-primary)" />
            </a-button>

            <a-button
              v-if="
                (hasClientBase
                  ? Boolean(baseTorrent && !clientBaseError)
                  : verifiedItems.get(verifiedItemsOrder[0])?.verified) &&
                !verifiedItems.get(id)!.loading &&
                !verifiedItems.get(id)!.torrent &&
                (hasClientBase || index > 0)
              "
              :title="t('SearchEntity.KeepUploadDialog.redownload')"
              @click.stop="reDownload(id)"
              type="text"
            >
              <SyncOutlined style="color: var(--ptd-success)" />
            </a-button>

            <!-- F5：状态图标 + 独立的移除入口。修复前 X 只在未通过验证时显示，
                 已校验（含手动「+」加入）的条目无法移除，用户只能关掉弹窗重来。 -->
            <a-button
              :loading="verifiedItems.get(id)!.loading"
              :title="statusText[verifiedItems.get(id)!.status]"
              type="text"
            >
              <CheckOutlined v-if="verifiedItems.get(id)!.verified" style="color: var(--ptd-success)" />
              <CloseOutlined v-else style="color: var(--ptd-danger)" />
            </a-button>
            <a-button
              :title="t('SearchEntity.KeepUploadDialog.removeFromKeepUpload')"
              type="text"
              @click.stop="removeVerifiedItem(id)"
            >
              <MinusOutlined />
            </a-button>
          </div>
        </a-list-item>
        <a-divider v-if="index > 0"></a-divider>
      </template>

      <!-- 待验证列表为空（调用方传入了空的种子列表）时列表区域会完全空白，这里补明确占位；
           列表项本身来自 torrentItems，打开即已渲染，逐项验证状态由条目内的 spinner + 状态文案表达，
           所以不需要整表骨架，避免把已知的标题/大小信息藏起来 -->
      <NoDataPlaceholder
        v-if="verifiedItemsOrder.length === 0"
        compact
        :description="t('SearchEntity.KeepUploadDialog.noVerifiedItem')"
      />
    </a-list>

    <template #footer>
      <a-flex align="center" justify="space-between">
        <a-flex align="center" :gap="8">
          <a-button
            href="https://github.com/chenbin3625/PT-Plugin-Plus/wiki/keep-upload-task"
            rel="noopener noreferrer nofollow"
            target="_blank"
            type="link"
            :title="t('common.howToUse')"
          >
            <QuestionOutlined />
          </a-button>
          <template v-if="verifiedCount >= (hasClientBase ? 1 : 2)">
            <a-select
              v-model:value="selectedDownloaderId"
              :options="metadataStore.getSortedEnabledDownloaders"
              :field-names="{ label: 'name', value: 'id' }"
              :placeholder="t('SearchEntity.KeepUploadDialog.setSavePath')"
              style="max-width: 200px"
              @change="resetDownloadOptions"
            />
            <a-auto-complete
              v-model:value="savePath"
              :options="suggestedSavePaths.map((path) => ({ value: path, label: path }))"
              :placeholder="t('KeepUploadTask.savePath')"
              style="max-width: 200px"
            />
            <a-auto-complete
              v-model:value="torrentLabel"
              :options="suggestedLabels.map((label) => ({ value: label, label }))"
              :placeholder="t('SentToDownloaderDialog.label')"
              style="max-width: 200px"
            />
            <a-button type="primary" :disabled="!canCreateTask" :loading="creating" @click="createKeepUploadTask">
              <SaveOutlined style="margin-right: 4px" />
              {{ t("SearchEntity.KeepUploadDialog.create") }}
            </a-button>
          </template>
        </a-flex>

        <a-flex align="center" :gap="8">
          <a-button @click="closeDialog">{{ t("common.dialog.close") }}</a-button>
        </a-flex>
      </a-flex>
    </template>
  </a-modal>
</template>

<style scoped>
.keep-upload-dialog__client-base {
  margin-bottom: 12px;
}
</style>
