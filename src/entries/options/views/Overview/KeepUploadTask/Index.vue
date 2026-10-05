<script setup lang="ts">
import { ArrowUpOutlined, CopyOutlined, DeleteOutlined, DownloadOutlined, NumberOutlined } from "@ant-design/icons-vue";
import { ref, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import type { CAddTorrentOptions } from "@ptd/downloader";

import type { IKeepUploadTask, TKeepUploadTaskKey } from "@/shared/types.ts";
import { sendMessage } from "@/messages.ts";
import { formatDate, formatDateTimeForTable, formatSize } from "@/options/utils.ts";
import { useRuntimeStore } from "@/options/stores/runtime.ts";
import { useMetadataStore } from "@/options/stores/metadata.ts";

import SiteFavicon from "@/options/components/SiteFavicon/Index.vue";
import { confirmModal } from "../utils/antdConfirm.ts";
import NoDataPlaceholder from "@/options/components/NoDataPlaceholder.vue";

const { t } = useI18n();
const runtimeStore = useRuntimeStore();
const metadataStore = useMetadataStore();

const tasks = ref<IKeepUploadTask[]>([]);
// 数据表格设置了 row-key="id"，因此 selectedTasks 中保存的是任务ID（TKeepUploadTaskKey）而非任务对象
const selectedTasks = ref<TKeepUploadTaskKey[]>([]);
const expanded = ref<string[]>([]);
const loading = ref(false);
const tableKey = ref(0); // 用于强制刷新表格

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
    runtimeStore.showSnakebar(t("KeepUploadTask.deleteSuccess"), { color: "success" });
  } catch (e) {
    runtimeStore.showSnakebar(t("KeepUploadTask.deleteError"), { color: "error" });
  }
}

async function deleteSelectedTasks() {
  if (selectedTasks.value.length === 0) return;
  if (!(await confirmModal(t("KeepUploadTask.deleteSelectedConfirm", { count: selectedTasks.value.length })))) return;

  try {
    for (const taskId of selectedTasks.value) {
      await sendMessage("deleteKeepUploadTask", taskId);
    }
    tasks.value = tasks.value.filter((t) => !selectedTasks.value.includes(t.id));
    selectedTasks.value = [];
    runtimeStore.showSnakebar(t("KeepUploadTask.deleteSuccess"), { color: "success" });
  } catch (e) {
    runtimeStore.showSnakebar(t("KeepUploadTask.deleteError"), { color: "error" });
  }
}

async function clearAllTasks() {
  if (!(await confirmModal(t("KeepUploadTask.clearConfirm")))) return;

  try {
    await sendMessage("clearKeepUploadTasks", undefined);
    tasks.value = [];
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

  try {
    for (const item of items) {
      const now = new Date();
      const replacements: Record<string, string> = {
        "torrent.title": item.title,
        "torrent.subTitle": item.subTitle ?? "",
        "torrent.category": String(item.category ?? ""),
        "torrent.site": item.site,
        "torrent.siteName": await metadataStore.getSiteName(item.site),
        "date:YYYY": formatDate(now, "yyyy"),
        "date:MM": formatDate(now, "MM"),
        "date:DD": formatDate(now, "dd"),
      };
      const addTorrentOptions: CAddTorrentOptions = {
        localDownload: true,
        // 与普通下载保持一致：是否暂停由下载器的“自动开始”设置决定。
        addAtPaused: !(downloader.feature?.DefaultAutoStart ?? true),
        savePath: task.downloadOptions.savePath || "",
        ...task.downloadOptions.addTorrentOptions,
      };

      for (const key of ["savePath", "label"] as const) {
        if (!addTorrentOptions[key]) continue;
        for (const [templateKey, value] of Object.entries(replacements)) {
          addTorrentOptions[key] = addTorrentOptions[key]!.replaceAll(`$${templateKey}$`, value);
        }
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
      if (result.downloadStatus === "failed") {
        throw new Error(result.errorMessage || item.title);
      }
    }
    runtimeStore.showSnakebar(t("KeepUploadTask.sendSingleSuccess"), { color: "success" });
  } catch (e) {
    const rawReason = e instanceof Error ? e.message : String(e);
    const reason = rawReason.trim() === "Fails." ? t("KeepUploadTask.qBittorrentLegacyFails") : rawReason;
    runtimeStore.showSnakebar(t("KeepUploadTask.sendSingleErrorWithReason", { reason }), { color: "error" });
  }
}

// 设为基准种子（移动到第一位并更新存储）
async function setAsBaseTorrent(task: IKeepUploadTask, itemIndex: number) {
  if (itemIndex === 0) {
    return;
  }

  // 将选中的种子移动到第一位
  const item = task.items.splice(itemIndex, 1)[0];
  task.items.unshift(item);

  // 更新任务存储
  try {
    await sendMessage("updateKeepUploadTask", task);
    // 强制刷新表格
    tableKey.value++;
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
      :key="tableKey"
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
