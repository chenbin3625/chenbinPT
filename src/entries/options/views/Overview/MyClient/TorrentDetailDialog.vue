<script setup lang="ts">
import {
  CalendarOutlined,
  CheckCircleFilled,
  CheckCircleOutlined,
  CopyOutlined,
  DatabaseOutlined,
  DeleteOutlined,
  DownOutlined,
  ExclamationCircleOutlined,
  FileTextOutlined,
  FolderOutlined,
  KeyOutlined,
  LineChartOutlined,
  LinkOutlined,
  LockOutlined,
  PartitionOutlined,
  QuestionCircleOutlined,
  StopOutlined,
  SyncOutlined,
  TagOutlined,
  UpOutlined,
} from "@ant-design/icons-vue";
import { nextTick, ref, watch, type Component } from "vue";
import { useI18n } from "vue-i18n";

import type {
  CTorrent,
  CTorrentFile,
  CTorrentPeer,
  CTorrentTracker,
  CTrackerState,
  TorrentClientMetaData,
  TorrentFilePriority,
} from "@ptd/downloader";
import { sendMessage } from "@/messages.ts";
import { formatRatio, formatSize, formatDate, isRatioHealthy } from "@/options/utils.ts";

import NoDataPlaceholder from "@/options/components/NoDataPlaceholder.vue";
import TorrentStateTd from "./TorrentStateTd.vue";
import { createTorrentLoadGuard } from "./utils.ts";

const showDialog = defineModel<boolean>();
const { torrent } = defineProps<{
  torrent: CTorrent | null;
}>();

const { t } = useI18n();

const activeTab = ref<string>("info");

// 下载器能力元数据（feature 声明）
const metaData = ref<TorrentClientMetaData | null>(null);
// metaData 所属的下载器 ID：弹窗复用时不把上一个客户端的 feature 当成当前客户端的
const metaDataForClient = ref<string | null>(null);

/**
 * B-30：弹窗是复用实例，关闭时只能清空数据、无法取消在途请求。
 * 因此文件 / peers / trackers 的「已加载」标记按种子身份（`clientId:id`）记录，
 * 并在写回前校验响应是否仍属于当前展示的种子——否则迟到的响应会把上一个种子的数据
 * 连同「已加载」状态留给下一个种子（随后 removeTracker / updateFilePriority 会打错目标）。
 */
const createGuard = () =>
  createTorrentLoadGuard(
    () => showDialog.value === true,
    () => torrent,
  );

// 文件
const files = ref<CTorrentFile[]>([]);
const filesLoading = ref(false);
const filesGuard = createGuard();

// peers
const peers = ref<CTorrentPeer[]>([]);
const peersLoading = ref(false);
const peersGuard = createGuard();

// trackers
const trackers = ref<CTorrentTracker[]>([]);
const trackersLoading = ref(false);
const trackersGuard = createGuard();
const trackerInput = ref("");

const priorityItems: Array<{ title: string; value: TorrentFilePriority }> = [
  { title: t("MyClient.detail.prioritySkip"), value: "skip" },
  { title: t("MyClient.detail.priorityLow"), value: "low" },
  { title: t("MyClient.detail.priorityNormal"), value: "normal" },
  { title: t("MyClient.detail.priorityHigh"), value: "high" },
  { title: t("MyClient.detail.priorityHighest"), value: "highest" },
];

const trackerStatusIcon: Record<CTrackerState, Component> = {
  unknown: QuestionCircleOutlined,
  working: CheckCircleFilled,
  updating: SyncOutlined,
  disabled: StopOutlined,
  error: ExclamationCircleOutlined,
};

function featureAllowed(feature: keyof NonNullable<TorrentClientMetaData["feature"]>): boolean {
  return metaData.value?.feature?.[feature]?.allowed ?? false;
}

async function loadMetaData() {
  const clientId = torrent?.clientId;
  if (!clientId || (metaData.value && metaDataForClient.value === clientId)) return;
  try {
    const meta = (await sendMessage("getDownloaderMetaData", clientId)) ?? null;
    // 弹窗已关闭 / 已换成别的下载器：丢弃这次响应
    if (showDialog.value !== true || clientId !== torrent?.clientId) return;
    metaData.value = meta;
    metaDataForClient.value = clientId;
  } catch {
    metaData.value = null;
  }
}

async function loadFiles() {
  const requestKey = filesGuard.begin();
  if (!torrent || !requestKey || filesGuard.isLoaded.value) return;
  filesLoading.value = true;
  try {
    const fileList = await sendMessage("getClientTorrentFiles", { downloaderId: torrent.clientId, torrent });
    filesGuard.commit(requestKey, () => (files.value = fileList)); // 迟到的响应会被 commit 丢弃
  } catch {
    filesGuard.commit(requestKey, () => (files.value = []), false);
  } finally {
    filesLoading.value = false;
  }
}

async function updateFilePriority(file: CTorrentFile, priority: TorrentFilePriority | null) {
  if (!torrent || !priority || priority === file.priority) return;
  const requestKey = filesGuard.begin();
  try {
    const ok = await sendMessage("setClientTorrentFilePriority", {
      downloaderId: torrent.clientId,
      torrent,
      selections: [{ index: file.index, priority }],
    });
    if (ok) {
      // 弹窗已关闭 / 已换成别的种子时不改本地展示，避免用陈旧的 record.index 污染下一个种子的文件列表
      filesGuard.commit(
        requestKey,
        () => {
          file.priority = priority;
          file.wanted = priority !== "skip";
        },
        false,
      );
    }
  } catch {
    // 静默失败，优先级保持原值
  }
}

async function loadPeers() {
  const requestKey = peersGuard.begin();
  if (!torrent || !requestKey || peersGuard.isLoaded.value) return;
  peersLoading.value = true;
  try {
    const peerList = await sendMessage("getClientTorrentPeers", { downloaderId: torrent.clientId, torrent });
    peersGuard.commit(requestKey, () => (peers.value = peerList)); // 迟到的响应会被 commit 丢弃
  } catch {
    peersGuard.commit(requestKey, () => (peers.value = []), false);
  } finally {
    peersLoading.value = false;
  }
}

async function loadTrackers() {
  const requestKey = trackersGuard.begin();
  if (!torrent || !requestKey || trackersGuard.isLoaded.value) return;
  trackersLoading.value = true;
  try {
    const trackerList = await sendMessage("getClientTorrentTrackersDetail", {
      downloaderId: torrent.clientId,
      torrent,
    });
    trackersGuard.commit(requestKey, () => (trackers.value = trackerList)); // 迟到的响应会被 commit 丢弃
  } catch {
    trackersGuard.commit(requestKey, () => (trackers.value = []), false);
  } finally {
    trackersLoading.value = false;
  }
}

async function addTracker() {
  const requestKey = trackersGuard.begin();
  if (!torrent || !requestKey || !trackerInput.value.trim()) return;
  const url = trackerInput.value.trim();
  try {
    const ok = await sendMessage("addClientTorrentTracker", { downloaderId: torrent.clientId, torrent, url });
    if (!ok) return;
    const trackerList = await sendMessage("getClientTorrentTrackersDetail", {
      downloaderId: torrent.clientId,
      torrent,
    });
    if (trackersGuard.commit(requestKey, () => (trackers.value = trackerList))) {
      trackerInput.value = "";
    }
  } catch {
    // 静默失败
  }
}

async function removeTracker(tracker: CTorrentTracker) {
  const requestKey = trackersGuard.begin();
  if (!torrent || !requestKey) return;
  try {
    const ok = await sendMessage("removeClientTorrentTracker", {
      downloaderId: torrent.clientId,
      torrent,
      url: tracker.url,
    });
    if (!ok) return;
    const trackerList = await sendMessage("getClientTorrentTrackersDetail", {
      downloaderId: torrent.clientId,
      torrent,
    });
    trackersGuard.commit(requestKey, () => (trackers.value = trackerList));
  } catch {
    // 静默失败
  }
}

function resetDialog() {
  activeTab.value = "info";
  metaData.value = null;
  metaDataForClient.value = null;
  // 清空数据的同时复位「已加载」标记与 loading：在途请求的响应会被 commit/isStale 丢弃，不会再把它们置回 true
  files.value = [];
  filesLoading.value = false;
  filesGuard.reset();
  peers.value = [];
  peersLoading.value = false;
  peersGuard.reset();
  trackers.value = [];
  trackersLoading.value = false;
  trackersGuard.reset();
  trackerInput.value = "";
}

async function afterEnter() {
  await loadMetaData();
  // Tracker 列表最常被查看，随对话框打开预加载；文件/peers 在首次切换到对应 tab 时加载
  await loadTrackers();
}

// 原生 a-modal 没有 afterOpenChange（只有 afterClose），打开时的初始化自行监听 open。
watch(showDialog, (open) => {
  if (open) nextTick(afterEnter);
});

function onTabChange(value: string | null | undefined) {
  if (value === "files") {
    loadFiles();
  } else if (value === "peers") {
    loadPeers();
  }
}

async function copyToClipboard(text: string) {
  await navigator.clipboard.writeText(text);
}

function magnetLink(torrent: CTorrent): string {
  return `magnet:?xt=urn:btih:${torrent.infoHash}&dn=${encodeURIComponent(torrent.name)}`;
}

/** 格式化速度：0 / undefined 显示 "-"（避免 filesize(undefined) 抛错渲染为空） */
function formatSpeed(speed: number | undefined): string {
  return speed && speed > 0 ? `${formatSize(speed)}/s` : "-";
}

/** 格式化总量：undefined 显示 "-"，0 显示 "0 B" */
function formatTotal(total: number | undefined): string {
  return typeof total === "number" ? (formatSize(total) as string) : "-";
}

/** 格式化时间戳（秒）：undefined 显示 "-" */
function formatTimestamp(timestamp: number | undefined): string {
  return typeof timestamp === "number" && timestamp > 0 ? formatDate(timestamp * 1000) : "-";
}
</script>

<template>
  <a-modal
    v-model:open="showDialog"
    :footer="null"
    :title="t('MyClient.detail.title')"
    :width="900"
    :after-close="resetDialog"
  >
    <template v-if="torrent">
      <a-tabs v-model:active-key="activeTab" @change="onTabChange">
        <!-- 基本信息 -->
        <a-tab-pane key="info" :tab="t('MyClient.detail.title')">
          <div>
            <a-list size="small">
              <a-list-item>
                <a-list-item-meta>
                  <template #avatar><FileTextOutlined /></template>
                  <template #title
                    ><strong>{{ torrent.name }}</strong></template
                  >
                </a-list-item-meta>
              </a-list-item>

              <a-list-item>
                <a-list-item-meta>
                  <template #avatar><KeyOutlined /></template>
                  <template #title>
                    <a-flex align="center" :gap="8">
                      <code style="font-size: 12px">{{ torrent.infoHash }}</code>
                      <a-button
                        :title="t('MyClient.detail.copyHash')"
                        type="text"
                        size="small"
                        @click="copyToClipboard(torrent.infoHash)"
                        ><template #icon><CopyOutlined /></template
                      ></a-button>
                      <a-button
                        :title="t('MyClient.detail.copyMagnet')"
                        type="text"
                        size="small"
                        @click="copyToClipboard(magnetLink(torrent))"
                        ><template #icon><LinkOutlined /></template
                      ></a-button>
                    </a-flex>
                  </template>
                </a-list-item-meta>
              </a-list-item>

              <a-divider />

              <a-row :gutter="8">
                <a-col :span="12">
                  <a-list-item>
                    <a-list-item-meta>
                      <template #avatar><PartitionOutlined /></template>
                      <template #title><TorrentStateTd :item="torrent" /></template>
                    </a-list-item-meta>
                  </a-list-item>
                  <a-list-item>
                    <a-list-item-meta>
                      <template #avatar><CheckCircleOutlined /></template>
                      <template #title>{{ torrent.progress.toFixed(2) }}%</template>
                    </a-list-item-meta>
                  </a-list-item>
                  <a-list-item>
                    <a-list-item-meta>
                      <template #avatar><DatabaseOutlined /></template>
                      <template #title>{{ formatSize(torrent.totalSize) }}</template>
                    </a-list-item-meta>
                  </a-list-item>
                </a-col>
                <a-col :span="12">
                  <a-list-item>
                    <a-list-item-meta>
                      <template #avatar><UpOutlined style="color: var(--ptd-success)" /></template>
                      <template #title>
                        {{ formatSpeed(torrent.uploadSpeed) }}
                        <span style="color: var(--ptd-text-tertiary); font-size: 12px; margin-left: 4px">
                          ({{ formatTotal(torrent.totalUploaded) }})
                        </span>
                      </template>
                    </a-list-item-meta>
                  </a-list-item>
                  <a-list-item>
                    <a-list-item-meta>
                      <template #avatar><DownOutlined style="color: var(--ptd-danger)" /></template>
                      <template #title>
                        {{ formatSpeed(torrent.downloadSpeed) }}
                        <span style="color: var(--ptd-text-tertiary); font-size: 12px; margin-left: 4px">
                          ({{ formatTotal(torrent.totalDownloaded) }})
                        </span>
                      </template>
                    </a-list-item-meta>
                  </a-list-item>
                  <a-list-item>
                    <a-list-item-meta>
                      <template #avatar><LineChartOutlined /></template>
                      <template #title>
                        <!-- 同 Index.vue：ratio 可能缺失（ITorrent 未声明该字段），不能直接 toFixed -->
                        <span
                          :style="{
                            color: isRatioHealthy(torrent.ratio) ? 'var(--ptd-success)' : 'var(--ptd-danger)',
                          }"
                        >
                          {{ formatRatio(torrent.ratio) }}
                        </span>
                      </template>
                    </a-list-item-meta>
                  </a-list-item>
                </a-col>
              </a-row>

              <a-divider />

              <a-list-item>
                <a-list-item-meta>
                  <template #avatar><FolderOutlined /></template>
                  <template #title>
                    <span style="font-size: 12px">{{ torrent.savePath }}</span>
                  </template>
                </a-list-item-meta>
              </a-list-item>
              <a-list-item>
                <a-list-item-meta>
                  <template #avatar><TagOutlined /></template>
                  <template #title>{{ torrent.label || "-" }}</template>
                </a-list-item-meta>
              </a-list-item>
              <a-list-item>
                <a-list-item-meta>
                  <template #avatar><CalendarOutlined /></template>
                  <template #title>{{ formatDate(torrent.dateAdded * 1000) }}</template>
                </a-list-item-meta>
              </a-list-item>
            </a-list>
          </div>
        </a-tab-pane>

        <!-- 文件管理 -->
        <a-tab-pane v-if="featureAllowed('FileList')" key="files" :tab="t('MyClient.detail.fileTitle')">
          <div>
            <div v-if="filesLoading" style="padding: 16px 0; text-align: center">
              <a-spin />
            </div>
            <a-table
              v-else-if="files.length > 0"
              :columns="[
                { title: t('MyClient.detail.fileColumnName'), dataIndex: 'path', key: 'path' },
                {
                  title: t('MyClient.detail.fileColumnSize'),
                  dataIndex: 'size',
                  key: 'size',
                  align: 'right',
                  width: 120,
                },
                {
                  title: t('MyClient.detail.fileColumnProgress'),
                  dataIndex: 'progress',
                  key: 'progress',
                  align: 'right',
                  width: 100,
                },
                {
                  title: t('MyClient.detail.fileColumnPriority'),
                  key: 'priority',
                  align: 'right',
                  width: 150,
                },
              ]"
              :data-source="files"
              :pagination="false"
              row-key="index"
              size="small"
            >
              <template #bodyCell="{ column, record }">
                <template v-if="column.key === 'path'">
                  <span class="ptd-cell-ellipsis" style="font-size: 12px" :title="String(record.path ?? '')">{{
                    record.path
                  }}</span>
                </template>
                <template v-else-if="column.key === 'size'">
                  <span style="font-size: 12px">{{ formatSize(record.size) }}</span>
                </template>
                <template v-else-if="column.key === 'progress'">
                  <span style="font-size: 12px">{{ record.progress.toFixed(1) }}%</span>
                </template>
                <template v-else-if="column.key === 'priority'">
                  <a-select
                    v-if="featureAllowed('FilePriority')"
                    :value="record.priority"
                    :options="priorityItems"
                    :field-names="{ label: 'title', value: 'value' }"
                    size="small"
                    @change="(value: any) => updateFilePriority(record, value)"
                  />
                  <span v-else style="font-size: 12px">{{ record.priority }}</span>
                </template>
              </template>
            </a-table>
            <!-- 加载完成但列表为空时给出占位，避免整块内容区空白 -->
            <NoDataPlaceholder v-else compact :description="t('MyClient.detail.noFiles')" />
          </div>
        </a-tab-pane>

        <!-- Peers -->
        <a-tab-pane v-if="featureAllowed('PeerList')" key="peers" :tab="t('MyClient.detail.peersTitle')">
          <div>
            <div v-if="peersLoading" style="padding: 16px 0; text-align: center">
              <a-spin />
            </div>
            <a-table
              v-else-if="peers.length > 0"
              :columns="[
                { title: t('MyClient.detail.peersColumnIp'), dataIndex: 'ip', key: 'ip' },
                { title: t('MyClient.detail.peersColumnClient'), dataIndex: 'client', key: 'client' },
                {
                  title: t('MyClient.detail.peersColumnProgress'),
                  dataIndex: 'progress',
                  key: 'progress',
                  align: 'right',
                },
                {
                  title: t('MyClient.detail.peersColumnDownloadSpeed'),
                  key: 'downloadSpeed',
                  align: 'right',
                },
                {
                  title: t('MyClient.detail.peersColumnUploadSpeed'),
                  key: 'uploadSpeed',
                  align: 'right',
                },
                {
                  title: t('MyClient.detail.peersColumnEncrypted'),
                  key: 'encrypted',
                  align: 'center',
                },
                {
                  title: t('MyClient.detail.peersColumnCountry'),
                  dataIndex: 'country',
                  key: 'country',
                  align: 'center',
                },
              ]"
              :data-source="peers"
              :pagination="false"
              :row-key="(record: any, index: number) => `${record.ip}-${index}`"
              size="small"
            >
              <template #bodyCell="{ column, record }">
                <template v-if="column.key === 'ip'">
                  <span style="font-size: 12px">{{ record.ip }}</span>
                </template>
                <template v-else-if="column.key === 'client'">
                  <span style="font-size: 12px">{{ record.client || "-" }}</span>
                </template>
                <template v-else-if="column.key === 'progress'">
                  <span style="font-size: 12px">{{ record.progress.toFixed(1) }}%</span>
                </template>
                <template v-else-if="column.key === 'downloadSpeed'">
                  <span style="font-size: 12px">{{ formatSize(record.downloadSpeed) }}/s</span>
                </template>
                <template v-else-if="column.key === 'uploadSpeed'">
                  <span style="font-size: 12px">{{ formatSize(record.uploadSpeed) }}/s</span>
                </template>
                <template v-else-if="column.key === 'encrypted'">
                  <LockOutlined v-if="record.encrypted" />
                  <span v-else>-</span>
                </template>
                <template v-else-if="column.key === 'country'">
                  <span style="font-size: 12px">{{ record.country || "-" }}</span>
                </template>
              </template>
            </a-table>
            <NoDataPlaceholder v-else compact :description="t('MyClient.detail.noPeers')" />
          </div>
        </a-tab-pane>

        <!-- Tracker 管理 -->
        <a-tab-pane v-if="featureAllowed('TrackerList')" key="trackers" :tab="t('MyClient.detail.trackers')">
          <div>
            <a-row align="middle" :gutter="8" style="margin-bottom: 8px">
              <a-col flex="1 1 0">
                <a-form-item :label="t('MyClient.detail.addTrackerTitle')">
                  <a-input v-model:value="trackerInput" @keyup.enter="addTracker" />
                </a-form-item>
              </a-col>
              <a-col style="flex: none">
                <a-button :disabled="!trackerInput.trim()" type="primary" @click="addTracker">
                  {{ t("MyClient.detail.addTrackerTitle") }}
                </a-button>
              </a-col>
            </a-row>

            <div v-if="trackersLoading" style="padding: 16px 0; text-align: center">
              <a-spin />
            </div>
            <a-table
              v-else-if="trackers.length > 0"
              :columns="[
                { title: t('MyClient.detail.trackerColumnUrl'), dataIndex: 'url', key: 'url' },
                {
                  title: t('MyClient.detail.trackerColumnTier'),
                  dataIndex: 'tier',
                  key: 'tier',
                  align: 'center',
                  width: 80,
                },
                {
                  title: t('MyClient.detail.trackerColumnStatus'),
                  key: 'status',
                  align: 'center',
                  width: 90,
                },
                {
                  title: t('MyClient.detail.trackerColumnSeeds'),
                  dataIndex: 'seeds',
                  key: 'seeds',
                  align: 'right',
                  width: 90,
                },
                {
                  title: t('MyClient.detail.trackerColumnLeeches'),
                  dataIndex: 'leeches',
                  key: 'leeches',
                  align: 'right',
                  width: 90,
                },
                {
                  title: t('MyClient.detail.trackerColumnLastAnnounce'),
                  key: 'lastAnnounce',
                  width: 140,
                },
                ...(featureAllowed('TrackerManage')
                  ? [{ title: '', key: 'action', align: 'center' as const, width: 70 }]
                  : []),
              ]"
              :data-source="trackers"
              :pagination="false"
              row-key="url"
              size="small"
            >
              <template #bodyCell="{ column, record }">
                <template v-if="column.key === 'url'">
                  <span style="font-size: 12px">{{ record.url }}</span>
                </template>
                <template v-else-if="column.key === 'tier'">
                  <span style="font-size: 12px">{{ record.tier }}</span>
                </template>
                <template v-else-if="column.key === 'status'">
                  <component :is="trackerStatusIcon[record.status as CTrackerState]" />
                </template>
                <template v-else-if="column.key === 'seeds'">
                  <span style="font-size: 12px">{{ record.seeds ?? "-" }}</span>
                </template>
                <template v-else-if="column.key === 'leeches'">
                  <span style="font-size: 12px">{{ record.leeches ?? "-" }}</span>
                </template>
                <template v-else-if="column.key === 'lastAnnounce'">
                  <span style="font-size: 12px">{{ formatTimestamp(record.lastAnnounce) }}</span>
                </template>
                <template v-else-if="column.key === 'action'">
                  <a-button
                    type="text"
                    size="small"
                    :title="t('MyClient.detail.removeTracker')"
                    @click="removeTracker(record)"
                    ><template #icon><DeleteOutlined /></template
                  ></a-button>
                </template>
              </template>
            </a-table>
            <NoDataPlaceholder v-else compact :description="t('MyClient.detail.noTrackers')" />
          </div>
        </a-tab-pane>

        <!-- 原始数据 -->
        <a-tab-pane key="raw" :tab="t('MyClient.action.viewRaw')">
          <div>
            <pre class="raw-json" style="font-size: 14px">{{ JSON.stringify(torrent, null, 2) }}</pre>
          </div>
        </a-tab-pane>
      </a-tabs>
    </template>
  </a-modal>
</template>
