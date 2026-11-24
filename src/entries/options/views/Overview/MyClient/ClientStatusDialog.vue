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
const clientFreeSpaces = ref<Record<string, number | "N/A">>({});
const clientLoading = ref<Record<string, boolean>>({});
const fetchSeq = new Map<string, number>();

const LOW_SPACE_DANGER_BYTES = 20 * 1024 ** 3;
const LOW_SPACE_WARN_BYTES = 50 * 1024 ** 3;

function freeSpaceTagColor(bytes: number | "N/A" | undefined): string | undefined {
  if (typeof bytes !== "number" || !Number.isFinite(bytes)) return undefined;
  if (bytes < LOW_SPACE_DANGER_BYTES) return "error";
  if (bytes < LOW_SPACE_WARN_BYTES) return "warning";
  return "default";
}

/** Returns true when the downloader's torrents are included in the current filter. */
function isDownloaderActive(id: string) {
  return selectedDownloaderIds.value.length === 0 || selectedDownloaderIds.value.includes(id);
}

/** Toggle a downloader in/out of the torrent filter. */
function toggleDownloaderFilter(id: string) {
  // 必须整体替换数组：MyClient 页面的 watcher 监听 `activeDownloaderIds`（computed），
  // splice/push 原地修改时 computed 返回同一引用，watch 按 identity 比较不会触发，
  // 新增/移除的下载器既不会加载数据也不会清理定时器。
  selectedDownloaderIds.value = selectedDownloaderIds.value.includes(id)
    ? selectedDownloaderIds.value.filter((item) => item !== id)
    : [...selectedDownloaderIds.value, id];
}

function torrentCountFor(id: string) {
  return (torrents.value[id] ?? []).length;
}

function formatSizeOrDash(v: number | undefined): string {
  return typeof v !== "undefined" ? (formatSize(v) as string) : "-";
}

async function fetchStatusFor(id: string) {
  const seq = (fetchSeq.get(id) ?? 0) + 1;
  fetchSeq.set(id, seq);
  clientLoading.value[id] = true;
  try {
    // client version 仅在未成功获取过时拉取，并与 status 并行且独立容错：
    // 避免版本接口失败阻塞状态展示，或把临时失败/空值永久缓存成 "—"
    const versionPromise = clientVersions.value[id]
      ? Promise.resolve(undefined)
      : sendMessage("getDownloaderVersion", id).catch(() => undefined);
    const statusPromise = sendMessage("getDownloaderStatus", id).catch(() => undefined);
    const freeSpacePromise = sendMessage("getDownloaderFreeSpace", id).catch(() => "N/A" as const);

    const [version, status, freeSpace] = await Promise.all([versionPromise, statusPromise, freeSpacePromise]);
    if (fetchSeq.get(id) !== seq) return;
    if (version) clientVersions.value[id] = version;
    if (status) clientStatuses.value[id] = status;
    clientFreeSpaces.value[id] = freeSpace;
  } finally {
    if (fetchSeq.get(id) === seq) {
      clientLoading.value[id] = false;
    }
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
      <!-- OPTIONSOVERVIEW-7：这一行是「只看某个下载器」的唯一入口，挂 @click 的 li 必须自己可聚焦、
           能报出按压状态并响应键盘，否则纯键盘用户无法使用单个下载器筛选。 -->
      <a-list-item
        v-for="d in enabledDownloaders"
        :key="d.id"
        role="button"
        tabindex="0"
        :aria-pressed="isDownloaderActive(d.id)"
        :style="[isDownloaderActive(d.id) ? { color: 'var(--ptd-primary)' } : undefined, { cursor: 'pointer' }]"
        @click="toggleDownloaderFilter(d.id)"
        @keydown.enter.prevent="toggleDownloaderFilter(d.id)"
        @keydown.space.prevent="toggleDownloaderFilter(d.id)"
      >
        <a-list-item-meta>
          <template #avatar>
            <a-avatar :src="getDownloaderIcon(d.type)" :size="32" class="client-status__avatar"></a-avatar>
          </template>
          <template #title>
            <strong>{{ d.name }}</strong>
            <span v-if="clientVersions[d.id]" class="client-status__version">
              {{ clientVersions[d.id] }}
            </span>
            <!-- N6：文案提示「点击感叹号图标可恢复」，原先这个图标只有 tooltip、点不动。
                 改成按钮，点击即恢复该下载器的自动刷新。 -->
            <a-tooltip v-if="suspendedDownloaders.has(d.id)" :title="t('MyClient.autoRefresh.suspendedTip')">
              <a-button
                :title="t('MyClient.autoRefresh.resumeDownloader')"
                type="text"
                danger
                size="small"
                @click.stop="resumeDownloaderRefresh(d.id)"
              >
                <template #icon><ExclamationCircleOutlined class="ptd-icon-sm" /></template>
              </a-button>
            </a-tooltip>
          </template>
          <template #description>
            <a-typography-link
              :href="d.address"
              rel="noopener noreferrer nofollow"
              target="_blank"
              class="client-status__address"
              @click.stop
            >
              {{ d.address }}
            </a-typography-link>
          </template>
        </a-list-item-meta>

        <a-spin v-if="clientLoading[d.id]" class="client-status__loading"></a-spin>
        <template v-else>
          <div class="client-status__summary">
            <a-flex align="center" justify="flex-end" :gap="4">
              <UpOutlined class="client-status__speed-up" />
              <span class="client-status__nowrap">
                {{ formatSizeOrDash(clientStatuses[d.id]?.upSpeed) }}/s ({{
                  formatSizeOrDash(clientStatuses[d.id]?.upData)
                }})
              </span>
            </a-flex>
            <a-flex align="center" justify="flex-end" :gap="4">
              <DownOutlined class="client-status__speed-down" />
              <span class="client-status__nowrap">
                {{ formatSizeOrDash(clientStatuses[d.id]?.dlSpeed) }}/s ({{
                  formatSizeOrDash(clientStatuses[d.id]?.dlData)
                }})
              </span>
            </a-flex>
            <div class="client-status__muted">
              {{ t("MyClient.clientStatusDialog.torrentCount", { count: torrentCountFor(d.id) }) }}
              <a-tag
                v-if="typeof clientFreeSpaces[d.id] === 'number'"
                :color="freeSpaceTagColor(clientFreeSpaces[d.id])"
                class="client-status__free-space"
              >
                {{ t("MyClient.clientStatusDialog.freeSpace", { size: formatSize(clientFreeSpaces[d.id] as number) }) }}
              </a-tag>
            </div>
          </div>
        </template>

        <a-divider class="client-status__divider" type="vertical" />
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

<style scoped>
/* 下载器状态行内重复的静态样式，收敛为语义类（选中高亮等动态 :style 保持原样） */
.client-status__avatar {
  margin-right: 8px;
}

.client-status__version {
  margin-left: 8px;
  font-size: var(--ptd-font-size-sm);
  color: var(--ptd-text-tertiary);
}

.client-status__address {
  font-size: var(--ptd-font-size-sm);
}

.client-status__loading {
  margin-right: 16px;
}

.client-status__summary {
  margin-right: 8px;
  font-size: var(--ptd-font-size-sm);
  text-align: right;
}

.client-status__speed-up {
  color: var(--ptd-success);
}

.client-status__speed-down {
  color: var(--ptd-danger);
}

.client-status__nowrap {
  white-space: nowrap;
}

.client-status__muted {
  color: var(--ptd-text-tertiary);
}

.client-status__free-space {
  margin-left: 6px;
  margin-inline-end: 0;
}

.client-status__divider {
  margin: 0 8px;
}
</style>
