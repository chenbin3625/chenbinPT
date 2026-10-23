<script setup lang="ts">
import { ref, computed, inject, nextTick, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useWindowSize } from "@vueuse/core";
import {
  CloudDownloadOutlined,
  CopyOutlined,
  DownloadOutlined,
  InboxOutlined,
  SaveOutlined,
  StopOutlined,
} from "@ant-design/icons-vue";
import { ETorrentStatus, ITorrent } from "@ptd/site";
import type { DataTableHeader } from "@/options/types/dataTable.ts";

import { formatDate, formatSize } from "@/options/utils.ts";
import { sendMessage } from "@/messages.ts";
import { useRuntimeStore } from "@/options/stores/runtime.ts";
import { useMetadataStore } from "@/options/stores/metadata.ts";

import type { IRemoteDownloadDialogData } from "../types.ts";
import { copyTextToClipboard } from "../utils.ts";

import NavButton from "@/options/components/NavButton.vue";
import TorrentTitleTd from "@/options/components/TorrentTitleTd.vue";

const { t } = useI18n();

const showDialog = defineModel<boolean>();

const { height: windowHeight } = useWindowSize();
const tableScrollHeight = computed(() => Math.max(160, Math.min(360, windowHeight.value - 360)));

const { torrentItems } = defineProps<{
  torrentItems: ITorrent[];
}>();

const runtimeStore = useRuntimeStore();
const metadataStore = useMetadataStore();

const tableHeaders = computed(
  () =>
    [
      { title: t("SearchEntity.index.table.category"), key: "category", align: "center", maxWidth: 60 },
      { title: t("SearchEntity.index.table.title"), key: "title", align: "start", maxWidth: 400 },
      { title: t("SearchEntity.index.table.size"), key: "size", align: "end", minWidth: 60 },
      { title: t("SearchEntity.index.table.seeders"), key: "seeders", align: "end", minWidth: 40 },
      { title: t("SearchEntity.index.table.leechers"), key: "leechers", align: "end", minWidth: 40 },
      { title: t("SearchEntity.index.table.completed"), key: "completed", align: "end", minWidth: 40 },
      { title: t("SearchEntity.index.table.time"), key: "time", align: "center", minWidth: 80 },
    ] as DataTableHeader[],
);

/**
 * B2-5：高级列表的行 key 必须是**唯一**的，而 `torrent.id` 由引擎按 `url || link` 兜底
 * （`AbstractBittorrentSite.parseWholeTorrentFromRow`），url/link 都没解析到的行 id 会是
 * `undefined`/`""`。旧实现直接 `:row-key="record.id"` 并按 id 反查选中项：多行共享同一个 key 时
 * 勾选一行会连带勾中所有同 key 行（`selectedTorrentsCount` 也与实际选中数不符）。
 * 这里给每行补一个「行序号 + id」的唯一 key，选中集合只认这个 key。
 */
type TAdvanceListRow = ITorrent & { __rowKey: string };

function buildRowKey(torrent: ITorrent, index: number): string {
  return `${index}|${String(torrent.id ?? "")}`;
}

const tableRows = computed<TAdvanceListRow[]>(() =>
  torrentItems.map((torrent, index) => ({ ...torrent, __rowKey: buildRowKey(torrent, index) })),
);

const selectedRowKeys = ref<string[]>([]);
const selectedRowKeySet = computed(() => new Set(selectedRowKeys.value));
const selectedTorrents = computed<ITorrent[]>(() =>
  tableRows.value.filter((row) => selectedRowKeySet.value.has(row.__rowKey)).map(stripRowKey),
);
const hasSelectedTorrent = computed(() => selectedRowKeys.value.length > 0);
const selectedTorrentsCount = computed(() => selectedRowKeys.value.length);
const selectedTorrentsSize = computed(() =>
  selectedTorrents.value.reduce((acc, torrent) => acc + (torrent.size ?? 0), 0),
);

/** 把内部行 key 从种子对象上摘掉，避免额外的 `__rowKey` 字段流入下载消息/下载历史 */
function stripRowKey(row: TAdvanceListRow): ITorrent {
  const torrent: ITorrent & { __rowKey?: string } = { ...row };
  delete torrent.__rowKey;
  return torrent;
}

function selectedKeysOf(rows: TAdvanceListRow[]): string[] {
  return rows.map((row) => row.__rowKey);
}

function rowKeyOf(record: TAdvanceListRow): string {
  return record.__rowKey;
}

function toCssSize(size?: number | string) {
  return typeof size === "number" ? `${size}px` : size;
}

/**
 * Vuetify `headers` → antd `columns`。
 * - `align` start/end → left/right
 * - PtdDataTable 对未显式声明 `sortable: false` 的列默认开启客户端排序，这里用同样的比较函数保持行为
 * - `maxWidth`/`minWidth` 落到单元格 style（antd 列只有固定 `width`）
 */
const tableColumns = computed(() =>
  tableHeaders.value.map((header) => {
    const key = String(header.key ?? "");

    return {
      title: header.title,
      dataIndex: key,
      key,
      align: header.align === "end" ? ("right" as const) : header.align === "start" ? ("left" as const) : header.align,
      sorter: (a: TAdvanceListRow, b: TAdvanceListRow) => {
        const left = a[key as keyof ITorrent];
        const right = b[key as keyof ITorrent];
        if (typeof left === "number" && typeof right === "number") return left - right;
        return String(left ?? "").localeCompare(String(right ?? ""));
      },
      width: header.width,
      customCell: () => ({
        style: { maxWidth: toCssSize(header.maxWidth), minWidth: toCssSize(header.minWidth) },
      }),
    };
  }),
);

const rowSelection = computed(() => ({
  selectedRowKeys: selectedRowKeys.value,
  onChange: (keys: (string | number)[]) => {
    selectedRowKeys.value = keys.map((key) => String(key));
  },
}));

const localDownloadMultiStatus = ref<boolean>(false);
async function handleLocalDownloadMulti() {
  localDownloadMultiStatus.value = true;

  try {
    // A-9：发送也要在 try 内 —— 任一条 reject 都必须走到 finally 复位按钮，
    // 否则按钮永久转圈且产生 unhandled rejection。offscreen 侧有并发队列与下载间隔预留，可并发投递。
    await Promise.all(
      selectedTorrents.value.map((torrent) => sendMessage("downloadTorrent", { torrent, downloaderId: "local" })),
    );
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
    const downloadUrls = await Promise.all(
      selectedTorrents.value.map((torrent) => sendMessage("getTorrentDownloadLink", torrent)),
    );

    // A-9：走已有的 copyTextToClipboard（clipboard API 不可用 / 文档失焦时回退 execCommand），
    // 并且只有真的复制成功才提示成功
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

function handleRemoteDownloadMulti(isDefaultSend = false) {
  remoteDownloadDialogData.torrents = selectedTorrents.value;
  remoteDownloadDialogData.isDefaultSend = isDefaultSend;
  // CONTENTSCRIPT-2：两个 a-modal 都 portal 到同一个 popup host，antd 的 Modal 容器在首次 open 时
  // 创建、关闭后不销毁，未传 zIndex 时两者的 .ant-modal-wrap 同为 token.zIndexPopupBase(1000)，
  // 叠放由 DOM 顺序（= 首次打开顺序）决定。本页更早开过 SentToDownloaderDialog 时，推送弹窗会渲染
  // 进更早的容器，被本弹窗及其遮罩整层盖住 —— 表现为「点推送没反应」。先关掉自身，移交下一步。
  showDialog.value = false;
  remoteDownloadDialogData.show = true;
}

function handleSelectSeeders() {
  selectedRowKeys.value = selectedKeysOf(tableRows.value.filter((row) => row.seeders));
}

function handleSelectNotSeeding() {
  selectedRowKeys.value = selectedKeysOf(
    tableRows.value.filter(
      (row) => row.status !== undefined && ![ETorrentStatus.seeding, ETorrentStatus.downloading].includes(row.status!),
    ),
  );
}

function enterDialog() {
  selectedRowKeys.value = selectedKeysOf(tableRows.value);
}

// 原生 a-modal 没有 afterOpenChange（只有 afterClose），打开时的初始化自行监听 open。
watch(showDialog, (open) => {
  if (open) nextTick(enterDialog);
});
</script>

<template>
  <a-modal
    v-model:open="showDialog"
    centered
    :title="t('contentScript.AdvanceListModuleDialog.title', [torrentItems.length])"
    :width="'min(1200px, calc(100vw - 32px))'"
  >
    <NavButton
      :icon="InboxOutlined"
      :text="t('contentScript.AdvanceListModuleDialog.selectSeeders')"
      @click="handleSelectSeeders"
    />
    <NavButton
      :icon="StopOutlined"
      :text="t('contentScript.AdvanceListModuleDialog.selectNotSeeding')"
      @click="handleSelectNotSeeding"
    />
    <a-table
      :columns="tableColumns"
      :data-source="tableRows"
      :pagination="{ defaultPageSize: 25, showSizeChanger: true }"
      :row-key="rowKeyOf"
      :row-selection="rowSelection"
      :scroll="{ x: 'max-content', y: tableScrollHeight }"
      class="ptd-data-table table-stripe table-header-no-wrap"
    >
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'title'">
          <TorrentTitleTd :item="record" :show-social="false" />
        </template>

        <!-- 种子大小 -->
        <template v-else-if="column.key === 'size'">
          <span style="white-space: nowrap">{{ formatSize(record.size ?? 0) }}</span>
        </template>

        <template v-else-if="column.key === 'time'">
          <span style="white-space: nowrap">
            {{ record.time ? formatDate(record.time) : "-" }}
          </span>
        </template>
      </template>
    </a-table>

    <template #footer>
      <a-flex align="center" justify="space-between" wrap="wrap" :gap="8">
        <span v-show="hasSelectedTorrent">{{
          t("contentScript.AdvanceListModuleDialog.selectedInfo", [
            selectedTorrentsCount,
            formatSize(selectedTorrentsSize),
          ])
        }}</span>

        <a-flex align="center" wrap="wrap" :gap="8">
          <NavButton
            :disabled="!hasSelectedTorrent"
            :loading="localDownloadMultiStatus"
            :icon="SaveOutlined"
            :text="t('downloaderLabel.localDownload')"
            @click="handleLocalDownloadMulti"
          />

          <NavButton
            :disabled="!hasSelectedTorrent"
            :loading="linkCopyMultiStatus"
            :icon="CopyOutlined"
            :text="t('contentScript.copyLink')"
            @click="handleLinkCopyMulti"
          />

          <NavButton
            :disabled="!hasSelectedTorrent"
            key="remote_download_multi"
            :icon="CloudDownloadOutlined"
            :text="t('contentScript.pushTo')"
            @click="() => handleRemoteDownloadMulti()"
          />

          <NavButton
            v-if="metadataStore.defaultDownloader?.id"
            key="remote_download_multi_default"
            :disabled="!hasSelectedTorrent"
            :icon="DownloadOutlined"
            :text="t('contentScript.pushToDefault')"
            @click="() => handleRemoteDownloadMulti(true)"
          />
        </a-flex>
      </a-flex>
    </template>
  </a-modal>
</template>
