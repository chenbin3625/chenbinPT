<script setup lang="ts">
import {
  DownOutlined,
  ExclamationCircleOutlined,
  ExportOutlined,
  ReloadOutlined,
  StopOutlined,
  UpOutlined,
} from "@ant-design/icons-vue";
import { nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import { getDownloaderIcon, type TorrentClientStatus } from "@ptd/downloader";
import { sendMessage } from "@/messages.ts";
import { formatSize } from "@/options/utils.ts";

import {
  torrents,
  selectedDownloaderIds,
  suspendedDownloaders,
  useClientRefresh,
  autoRefreshRunning,
} from "./utils.ts";

const showDialog = defineModel<boolean>();

const { t } = useI18n();
const { enabledDownloaders, resumeDownloaderRefresh, clearDownloaderTimer } = useClientRefresh();

const clientStatuses = ref<Record<string, TorrentClientStatus>>({});
const clientVersions = ref<Record<string, string>>({});
const clientLoading = ref<Record<string, boolean>>({});

/** Returns true when the downloader's torrents are included in the current filter. */
function isDownloaderActive(id: string) {
  return selectedDownloaderIds.value.length === 0 || selectedDownloaderIds.value.includes(id);
}

/** Toggle a downloader in/out of the torrent filter. */
function toggleDownloaderFilter(id: string) {
  const idx = selectedDownloaderIds.value.indexOf(id);
  if (idx >= 0) {
    selectedDownloaderIds.value.splice(idx, 1);
  } else {
    selectedDownloaderIds.value.push(id);
  }
}

function torrentCountFor(id: string) {
  return (torrents.value[id] ?? []).length;
}

function formatSizeOrDash(v: number | undefined): string {
  return typeof v !== "undefined" ? (formatSize(v) as string) : "-";
}

async function fetchStatusFor(id: string) {
  clientLoading.value[id] = true;
  try {
    // client version 只获取一次即可
    if (typeof clientVersions.value[id] === "undefined") {
      clientVersions.value[id] = (await sendMessage("getDownloaderVersion", id)) ?? "—";
    }

    const status = await sendMessage("getDownloaderStatus", id);
    if (status) clientStatuses.value[id] = status;
  } finally {
    clientLoading.value[id] = false;
  }
}

function suspendedDownloader(id: string) {
  suspendedDownloaders.value.add(id);
  clearDownloaderTimer(id);
}

async function fetchAll() {
  await Promise.allSettled(enabledDownloaders.value.map((d) => fetchStatusFor(d.id)));
}

function onEnter() {
  fetchAll();
}

// 原生 a-modal 没有 afterOpenChange（只有 afterClose），打开时初始化自行监听 open。
watch(showDialog, (open) => {
  if (open) nextTick(onEnter);
});
</script>

<template>
  <a-modal v-model:open="showDialog" :title="t('MyClient.clientStatusDialog.title')" :width="800">
    <a-list>
      <a-list-item
        v-for="d in enabledDownloaders"
        :key="d.id"
        :style="[isDownloaderActive(d.id) ? { color: 'var(--ptd-primary)' } : undefined, { cursor: 'pointer' }]"
        @click="toggleDownloaderFilter(d.id)"
      >
        <a-list-item-meta>
          <template #avatar>
            <a-avatar :src="getDownloaderIcon(d.type)" :size="32" style="margin-right: 8px"></a-avatar>
          </template>
          <template #title>
            <strong>{{ d.name }}</strong>
            <span
              v-if="clientVersions[d.id]"
              style="margin-left: 8px; color: var(--ptd-text-tertiary); font-size: 12px"
            >
              {{ clientVersions[d.id] }}
            </span>
            <a-tooltip v-if="suspendedDownloaders.has(d.id)" :title="t('MyClient.autoRefresh.suspendedTip')">
              <ExclamationCircleOutlined class="ptd-icon-sm" style="margin-left: 4px; color: var(--ptd-danger)" />
            </a-tooltip>
          </template>
          <template #description>
            <a-typography-link
              :href="d.address"
              rel="noopener noreferrer nofollow"
              target="_blank"
              style="font-size: 12px"
              @click.stop
            >
              {{ d.address }}
            </a-typography-link>
          </template>
        </a-list-item-meta>

        <a-spin v-if="clientLoading[d.id]" style="margin-right: 16px"></a-spin>
        <template v-else>
          <div style="margin-right: 8px; text-align: right; font-size: 12px">
            <a-flex align="center" justify="flex-end" :gap="4">
              <UpOutlined style="color: var(--ptd-success)" />
              <span style="white-space: nowrap">
                {{ formatSizeOrDash(clientStatuses[d.id]?.upSpeed) }}/s ({{
                  formatSizeOrDash(clientStatuses[d.id]?.upData)
                }})
              </span>
            </a-flex>
            <a-flex align="center" justify="flex-end" :gap="4">
              <DownOutlined style="color: var(--ptd-danger)" />
              <span style="white-space: nowrap">
                {{ formatSizeOrDash(clientStatuses[d.id]?.dlSpeed) }}/s ({{
                  formatSizeOrDash(clientStatuses[d.id]?.dlData)
                }})
              </span>
            </a-flex>
            <div style="color: var(--ptd-text-tertiary)">
              {{ t("MyClient.clientStatusDialog.torrentCount", { count: torrentCountFor(d.id) }) }}
            </div>
          </div>
        </template>

        <a-divider style="margin: 0 8px" type="vertical" />
        <a-button
          v-if="suspendedDownloaders.has(d.id)"
          :title="t('MyClient.autoRefresh.resumeDownloader')"
          type="text"
          danger
          size="small"
          @click.stop="resumeDownloaderRefresh(d.id)"
          ><template #icon><ReloadOutlined /></template
        ></a-button>
        <a-button
          v-else
          :title="t('MyClient.autoRefresh.stopDownloader')"
          :disabled="!autoRefreshRunning"
          type="text"
          size="small"
          @click.stop="() => suspendedDownloader(d.id)"
          ><template #icon><StopOutlined /></template
        ></a-button>
        <a-button
          :href="d.address"
          :title="t('MyClient.clientStatusDialog.openClient')"
          rel="noopener noreferrer nofollow"
          target="_blank"
          type="text"
          size="small"
          @click.stop
          ><template #icon><ExportOutlined /></template
        ></a-button>
      </a-list-item>
    </a-list>
    <template #footer>
      <a-flex align="center" justify="space-between">
        <a-flex align="center" :gap="8">
          <a-button type="text" :title="t('MyClient.refresh')" @click="fetchAll">
            <ReloadOutlined />
          </a-button>
        </a-flex>
        <a-flex align="center" :gap="8">
          <a-button @click="showDialog = false">{{ t("common.dialog.close") }}</a-button>
        </a-flex>
      </a-flex>
    </template>
  </a-modal>
</template>
