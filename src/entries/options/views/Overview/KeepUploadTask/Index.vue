<script setup lang="ts">
import { ArrowUpOutlined, CopyOutlined, DeleteOutlined, DownloadOutlined, NumberOutlined } from "@ant-design/icons-vue";
import { ref, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import type { CAddTorrentOptions } from "@ptd/downloader";
import { datePathTemplateVars, expandPathTemplate } from "@ptd/downloader/utils/pathTemplate.ts";

import type { IKeepUploadTask, TKeepUploadTaskKey } from "@/shared/types.ts";
import { sendMessage } from "@/messages.ts";
import { formatDateTimeForTable, formatSize, sanitizeDynamicReplaceValue } from "@/options/utils.ts";
import { useRuntimeStore } from "@/options/stores/runtime.ts";
import { useMetadataStore } from "@/options/stores/metadata.ts";

import SiteFavicon from "@/options/components/SiteFavicon/Index.vue";
import { confirmModal } from "../utils/antdConfirm.ts";
import NoDataPlaceholder from "@/options/components/NoDataPlaceholder.vue";
import { summarizeKeepUploadSendOutcomes, type TKeepUploadSendOutcome } from "./utils.ts";

const { t } = useI18n();
const runtimeStore = useRuntimeStore();
const metadataStore = useMetadataStore();

const tasks = ref<IKeepUploadTask[]>([]);
// 数据表格设置了 row-key="id"，因此 selectedTasks 中保存的是任务ID（TKeepUploadTaskKey）而非任务对象
const selectedTasks = ref<TKeepUploadTaskKey[]>([]);
const expanded = ref<string[]>([]);
const loading = ref(false);

const columns = [
  { title: t("KeepUploadTask.table.site"), dataIndex: "site", key: "site", align: "center" as const },
  { title: t("KeepUploadTask.table.title"), dataIndex: "title", key: "title", align: "left" as const },
  { title: t("KeepUploadTask.table.size"), dataIndex: "size", key: "size", align: "right" as const },
  { title: t("KeepUploadTask.table.count"), dataIndex: "count", key: "count", align: "center" as const },
  { title: t("KeepUploadTask.table.time"), dataIndex: "time", key: "time", align: "center" as const },
  { title: t("common.action"), key: "action", align: "center" as const },
];

function onSelectionChange(keys: TKeepUploadTaskKey[]) {
  selectedTasks.value = keys;
}

function onExpandedChange(keys: string[]) {
  expanded.value = keys;
}

async function loadTasks() {
  loading.value = true;
  try {
    tasks.value = await sendMessage("getKeepUploadTasks", undefined);
  } catch (e) {
    console.error("Failed to load keep upload tasks:", e);
    tasks.value = [];
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  loadTasks();
});

async function deleteTask(task: IKeepUploadTask) {
  if (!(await confirmModal(t("KeepUploadTask.deleteConfirm")))) return;

  try {
    await sendMessage("deleteKeepUploadTask", task.id);
    tasks.value = tasks.value.filter((t) => t.id !== task.id);
    // N13：删掉的任务必须从选中集合里移除，否则「删除所选」仍高亮、还会对不存在的 id 再发删除消息
    selectedTasks.value = selectedTasks.value.filter((id) => id !== task.id);
    runtimeStore.showSnakebar(t("KeepUploadTask.deleteSuccess"), { color: "success" });
  } catch (e) {
    runtimeStore.showSnakebar(t("KeepUploadTask.deleteError"), { color: "error" });
  }
}

async function deleteSelectedTasks() {
  if (selectedTasks.value.length === 0) return;
  if (!(await confirmModal(t("KeepUploadTask.deleteSelectedConfirm", { count: selectedTasks.value.length })))) return;

  // N13：逐项删除并收集结果。原先顺序 await，中途失败会让「已删掉的记录仍留在列表里」，
  // 内存与存储不一致；这里按实际成功集合更新列表，失败项保留并继续选中，方便重试。
  const targetIds = [...selectedTasks.value];
  const results = await Promise.allSettled(targetIds.map((taskId) => sendMessage("deleteKeepUploadTask", taskId)));
  const deletedIds = targetIds.filter((_, index) => results[index]?.status === "fulfilled");
  const failedIds = targetIds.filter((taskId) => !deletedIds.includes(taskId));

  if (deletedIds.length > 0) {
    const deletedSet = new Set(deletedIds);
    tasks.value = tasks.value.filter((t) => !deletedSet.has(t.id));
    expanded.value = expanded.value.filter((key) => !deletedSet.has(key as TKeepUploadTaskKey));
  }
  selectedTasks.value = failedIds;

  if (failedIds.length === 0) {
    runtimeStore.showSnakebar(t("KeepUploadTask.deleteSuccess"), { color: "success" });
  } else {
    runtimeStore.showSnakebar(t("KeepUploadTask.deleteError"), { color: deletedIds.length > 0 ? "warning" : "error" });
  }
}

async function clearAllTasks() {
  if (!(await confirmModal(t("KeepUploadTask.clearConfirm")))) return;

  try {
    await sendMessage("clearKeepUploadTasks", undefined);
    tasks.value = [];
    // N13：清空后选中集合与展开态也要复位，否则「删除所选」按钮仍可点、指向已不存在的任务
    selectedTasks.value = [];
    expanded.value = [];
    runtimeStore.showSnakebar(t("KeepUploadTask.clearSuccess"), { color: "success" });
  } catch (e) {
    runtimeStore.showSnakebar(t("KeepUploadTask.clearError"), { color: "error" });
  }
}

// 发送种子到下载器
async function sendTorrentsToDownloader(task: IKeepUploadTask, items: IKeepUploadTask["items"]) {
  if (items.length === 0) return;

  const downloader = metadataStore.downloaders[task.downloadOptions.downloaderId];
  if (!downloader) {
    runtimeStore.showSnakebar(t("KeepUploadTask.downloaderNotFound"), { color: "error" });
    return;
  }

  const outcomes: TKeepUploadSendOutcome[] = [];

  const normalizeReason = (reason: string): string => {
    const trimmed = reason.trim();
    // qBittorrent 旧版 WebAPI 只回 "Fails."，换成可操作的提示
    return trimmed === "Fails." ? t("KeepUploadTask.qBittorrentLegacyFails") : trimmed;
  };

  // N11：逐项收集结果，某一项失败不能中止后续项（原先 `for + await` + 抛错，第 3 项失败会让 4~N 项
  // 根本不发送，用户重试时前 2 项又被重复推送）。
  for (const item of items) {
    try {
      const now = new Date();
      // OUI-4：替换值来自站点页面解析（标题/副标题/分类），会拼进下载器的 savePath / label。
      // 复用「发送到下载器」同一套路径安全化（Info8）：剥掉 `/`、`\`、`..`、控制字符与
      // Windows 非法字符，否则恶意/被污染的站点标题可让用户配置的下载目录被逃出。
      const replacements: Record<string, string> = {
        "torrent.title": sanitizeDynamicReplaceValue(item.title),
        "torrent.subTitle": sanitizeDynamicReplaceValue(item.subTitle ?? ""),
        "torrent.category": sanitizeDynamicReplaceValue(item.category ?? ""),
        "torrent.site": sanitizeDynamicReplaceValue(item.site),
        "torrent.siteName": sanitizeDynamicReplaceValue(await metadataStore.getSiteName(item.site)),
        ...datePathTemplateVars(now),
      };
      const addTorrentOptions: CAddTorrentOptions = {
        localDownload: true,
        // 与普通下载保持一致：是否暂停由下载器的“自动开始”设置决定。
        addAtPaused: !(downloader.feature?.DefaultAutoStart ?? true),
        savePath: task.downloadOptions.savePath || "",
        ...task.downloadOptions.addTorrentOptions,
      };

      for (const key of ["savePath", "label"] as const) {
        const value = addTorrentOptions[key];
        if (!value) continue;
        addTorrentOptions[key] = expandPathTemplate(value, replacements) ?? value;
      }

      const result = await sendMessage("downloadTorrent", {
        torrent: {
          site: item.site,
          title: item.title,
          subTitle: item.subTitle,
          link: item.url,
          // item.link 是详情页；下载链接为空时，后台需要它来动态解析真实下载地址。
          url: item.link,
          size: item.size,
        },
        downloaderId: task.downloadOptions.downloaderId,
        addTorrentOptions,
      });
      if (result?.downloadStatus === "failed") {
        outcomes.push({ status: "failed", reason: normalizeReason(result.errorMessage || item.title) });
      } else if (result?.downloadStatus === "pending") {
        // pending = 站点下载间隔未到，后台会排程稍后重发（offscreen/utils/download.ts），
        // 既不是「已发送成功」也不是「失败」，单独计数
        outcomes.push({ status: "pending" });
      } else {
        // DOWNLOADER-8：推送成功但下载器降级（部分设置未生效）时结果里是 warningMessage
        outcomes.push({ status: "success", warningMessage: result?.warningMessage });
      }
    } catch (e) {
      outcomes.push({ status: "failed", reason: normalizeReason(e instanceof Error ? e.message : String(e)) });
    }
  }

  const { succeeded, failed, pending, warned, firstFailureReason, firstWarningMessage } =
    summarizeKeepUploadSendOutcomes(outcomes);

  if (items.length === 1) {
    // D（REVIEW-FINDINGS options-2）：单条发送与批量路径对齐 —— pending（站点下载间隔未到）不是
    // 成功；warned（下载器降级、部分设置未生效）也必须提示，否则用户只看到绿色的「发送成功」。
    if (failed > 0) {
      runtimeStore.showSnakebar(t("KeepUploadTask.sendSingleErrorWithReason", { reason: firstFailureReason ?? "" }), {
        color: "error",
      });
    } else {
      let singleMessage = t("KeepUploadTask.sendSingleSuccess");
      if (pending > 0) {
        singleMessage += t("SentToDownloaderDialog.sendSummaryPending", { count: pending });
      }
      if (warned > 0) {
        singleMessage += t("SentToDownloaderDialog.sendSummaryWarning", { count: warned });
        if (firstWarningMessage) {
          singleMessage += ` (${t("DownloadHistory.detail.warningMessage")}: ${firstWarningMessage})`;
        }
      }
      runtimeStore.showSnakebar(singleMessage, {
        color: pending > 0 || warned > 0 ? "warning" : "success",
      });
    }
    return;
  }

  // L2（F1）：全部成功时用 KeepUploadTask 专用文案，不再借用「发送到下载器」的汇总 key；
  // 有 pending / warned / failed 时仍用带计数的汇总，便于用户判断下一步操作。
  if (failed === 0 && pending === 0 && warned === 0) {
    runtimeStore.showSnakebar(t("KeepUploadTask.sendSummary"), { color: "success" });
    return;
  }

  const pendingText = pending > 0 ? t("SentToDownloaderDialog.sendSummaryPending", { count: pending }) : "";
  const failedText = failed > 0 ? t("SentToDownloaderDialog.sendSummaryFailed", { count: failed }) : "";
  let summary = t("SentToDownloaderDialog.sendSummary", {
    success: succeeded,
    pending: pendingText,
    failed: failedText,
  });
  if (warned > 0) {
    summary += t("SentToDownloaderDialog.sendSummaryWarning", { count: warned });
    if (firstWarningMessage) {
      summary += ` (${t("DownloadHistory.detail.warningMessage")}: ${firstWarningMessage})`;
    }
  }
  if (firstFailureReason) {
    summary += ` (${t("DownloadHistory.detail.errorMessage")}: ${firstFailureReason})`;
  }
  runtimeStore.showSnakebar(summary, {
    color:
      failed === 0
        ? pending > 0 || warned > 0
          ? "warning"
          : "success"
        : succeeded > 0 || pending > 0
          ? "warning"
          : "error",
  });
}

// 设为基准种子（移动到第一位并更新存储）
async function setAsBaseTorrent(task: IKeepUploadTask, itemIndex: number) {
  if (itemIndex === 0) {
    return;
  }

  // N12：先构造新顺序并持久化，成功后才改内存 —— 原先先 splice/unshift 再 await，
  // 存储写入失败时内存顺序已经变了且不回滚，「发送基准种子」会以未持久化的顺序为准。
  const nextItems = [...task.items];
  const [item] = nextItems.splice(itemIndex, 1);
  nextItems.unshift(item);

  try {
    await sendMessage("updateKeepUploadTask", { ...task, items: nextItems });
    // 持久化成功后再更新内存；表格按 row-key 复用行，不需要 tableKey 整表重挂载
    // （重挂载会丢失展开行 / 滚动位置）。
    task.items = nextItems;
    runtimeStore.showSnakebar(t("KeepUploadTask.setBaseSuccess"), { color: "success" });
  } catch (e) {
    runtimeStore.showSnakebar(t("KeepUploadTask.setBaseError"), { color: "error" });
  }
}

// 发送基准种子到下载器
function sendBaseTorrent(task: IKeepUploadTask) {
  const items = task.items.slice(0, 1);
  sendTorrentsToDownloader(task, items);
}

// 发送其他种子到下载器
async function sendOtherTorrents(task: IKeepUploadTask) {
  if (task.items.length <= 1) return;
  if (!(await confirmModal(t("KeepUploadTask.sendConfirm", { count: task.items.length - 1 })))) return;
  const items = task.items.slice(1);
  sendTorrentsToDownloader(task, items);
}

// 发送所有种子到下载器
async function sendAllTorrents(task: IKeepUploadTask) {
  if (!(await confirmModal(t("KeepUploadTask.sendConfirm", { count: task.items.length })))) return;
  const items = task.items.slice(0);
  sendTorrentsToDownloader(task, items);
}

// 复制下载链接
async function copyLinksToClipboard(task: IKeepUploadTask) {
  const urls = task.items.map((item) => item.url).join("\n");
  try {
    await navigator.clipboard.writeText(urls);
    runtimeStore.showSnakebar(t("KeepUploadTask.copySuccess", { count: task.items.length }), { color: "success" });
  } catch (e) {
    runtimeStore.showSnakebar(t("KeepUploadTask.copyError"), { color: "error" });
  }
}
</script>

<template>
  <a-card>
    <a-typography-text strong>
      <a-button :disabled="selectedTasks.length === 0" style="margin-right: 8px" danger @click="deleteSelectedTasks">
        <DeleteOutlined style="margin-right: 8px" />
        {{ t("common.remove") }}
      </a-button>

      <a-button :disabled="tasks.length === 0" danger @click="clearAllTasks">
        <DeleteOutlined style="margin-right: 8px" />
        {{ t("KeepUploadTask.clearAll") }}
      </a-button>
    </a-typography-text>

    <a-table
      :columns="columns"
      :data-source="tasks"
      :loading="loading"
      :pagination="{ pageSize: 25, showSizeChanger: true }"
      :row-key="'id'"
      :row-selection="{ selectedRowKeys: selectedTasks, onChange: onSelectionChange }"
      :expanded-row-keys="expanded"
      :scroll="{ x: 'max-content' }"
      @expanded-rows-change="onExpandedChange"
    >
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'site'">
          <div style="display: flex; flex-direction: column; align-items: center">
            <SiteFavicon :site-id="record.items[0]?.site" :size="18" />
          </div>
        </template>

        <template v-else-if="column.key === 'title'">
          <div>
            <a-typography-link
              class="ptd-cell-ellipsis"
              :href="record.items[0]?.link"
              target="_blank"
              rel="noopener noreferrer nofollow"
              style="font-size: 16px; max-width: 28rem"
              :title="String(record.title ?? '')"
            >
              {{ record.title }}
            </a-typography-link>
            <div
              class="ptd-cell-ellipsis"
              style="color: var(--ptd-text-tertiary); font-size: 12px; max-width: 28rem"
              :title="`${t('KeepUploadTask.savePath')}${record.downloadOptions?.clientName} -> ${
                record.downloadOptions?.savePath || t('KeepUploadTask.defaultPath')
              }`"
            >
              {{ t("KeepUploadTask.savePath") }}{{ record.downloadOptions?.clientName }} ->
              {{ record.downloadOptions?.savePath || t("KeepUploadTask.defaultPath") }}
            </div>
            <div style="font-size: 12px">{{ t("KeepUploadTask.torrentCount") }}{{ record.items.length }}</div>
          </div>
        </template>

        <template v-else-if="column.key === 'size'">
          {{ formatSize(record.size) }}
        </template>

        <template v-else-if="column.key === 'count'">
          {{ record.items.length }}
        </template>

        <template v-else-if="column.key === 'time'">
          <span class="ptd-date-time">{{ formatDateTimeForTable(record.time) }}</span>
        </template>

        <template v-else-if="column.key === 'action'">
          <a-button :title="t('KeepUploadTask.sendBaseTorrent')" type="link" @click="sendBaseTorrent(record)">
            <NumberOutlined />
          </a-button>
          <a-button :title="t('KeepUploadTask.sendOtherTorrents')" type="text" @click="sendOtherTorrents(record)">
            <NumberOutlined />
          </a-button>
          <a-button :title="t('KeepUploadTask.sendAllTorrents')" type="link" @click="sendAllTorrents(record)">
            <DownloadOutlined />
          </a-button>
          <a-button :title="t('KeepUploadTask.copyLinks')" type="text" @click="copyLinksToClipboard(record)">
            <CopyOutlined />
          </a-button>
          <a-button :title="t('common.remove')" type="text" danger @click="deleteTask(record)">
            <DeleteOutlined />
          </a-button>
        </template>
      </template>

      <!-- 注意：antd Table 的 expandedRowRender 外层已自带展开行容器，
           这里只能返回纯内容，禁止再包一层表格行（非法嵌套 + colspan 少算列，见 OV-13） -->
      <template #expandedRowRender="{ record }">
        <a-list size="small" :split="false">
          <!-- index 仍被下方 setAsBaseTorrent(record, index) 作为业务下标使用，故保留 -->
          <a-list-item v-for="(subItem, index) in record.items" :key="`${subItem.site}-${subItem.link}`">
            <a-list-item-meta>
              <template #avatar><SiteFavicon :site-id="subItem.site" :size="16" /></template>
              <template #title>
                <a-typography-link
                  class="ptd-cell-ellipsis"
                  :href="subItem.link"
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                  style="max-width: 48rem"
                  :title="String(subItem.title ?? '')"
                >
                  {{ subItem.title }}
                </a-typography-link>
              </template>
              <template #description>
                {{ formatSize(subItem.size) }}, {{ t("KeepUploadTask.seeders") }}{{ subItem.seeders ?? "-" }},
                {{ t("KeepUploadTask.leechers") }}{{ subItem.leechers ?? "-" }}
              </template>
            </a-list-item-meta>
            <a-button
              :title="t('KeepUploadTask.setAsBaseTorrent')"
              type="link"
              size="small"
              @click="setAsBaseTorrent(record, index)"
            >
              <ArrowUpOutlined />
            </a-button>
          </a-list-item>
        </a-list>
      </template>

      <template #emptyText>
        <NoDataPlaceholder compact :description="t('KeepUploadTask.emptyNotice')" />
      </template>
    </a-table>
  </a-card>

  <a-alert type="warning" show-icon style="margin-top: 16px">
    <template #description>
      <div>
        {{ t("KeepUploadTask.warning.title") }}
        <a-list size="small" :split="false">
          <a-list-item>{{ t("KeepUploadTask.warning.item1") }}</a-list-item>
          <a-list-item>{{ t("KeepUploadTask.warning.item2") }}</a-list-item>
          <a-list-item>{{ t("KeepUploadTask.warning.item3") }}</a-list-item>
        </a-list>
      </div>
    </template>
  </a-alert>
</template>
