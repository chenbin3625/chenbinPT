<script setup lang="ts">
import { ref, computed, nextTick, shallowRef, watch } from "vue";
import { useI18n } from "vue-i18n";
import { AppstoreOutlined, CheckCircleOutlined } from "@ant-design/icons-vue";
import { toMerged } from "es-toolkit";
import { Modal } from "ant-design-vue";

import { type ITorrent } from "@ptd/site";
import {
  type CAddTorrentOptions,
  getDownloaderIcon as getDownloaderIconRaw,
  getDownloaderMetaData,
} from "@ptd/downloader";

import { useRuntimeStore } from "@/options/stores/runtime.ts";
import { useMetadataStore } from "@/options/stores/metadata.ts";
import { useConfigStore } from "@/options/stores/config.ts";
import type { IDownloaderMetadata } from "@/shared/types.ts";

import { createDynamicReplacePrompter, sendTorrentToDownloader } from "./utils.ts";

const showDialog = defineModel<boolean>();
const { torrentItems, isDefaultSend } = defineProps<{
  torrentItems: ITorrent[];
  isDefaultSend?: boolean;
}>();
const emit = defineEmits<{
  (e: "cancel"): void;
  (e: "done"): void;
}>();

const { t } = useI18n();
const configStore = useConfigStore();
const runtimeStore = useRuntimeStore();
const metadataStore = useMetadataStore();

// V-11：动态替换 `<...>` 的输入弹窗必须用 `Modal.useModal()`（contextHolder 渲染在本组件模板里），
// 而不是 antd 的静态 `Modal.confirm` —— 本组件会被内容脚本挂在 shadow root 内，
// 静态弹窗落到宿主页面 document.body，既不继承主题，也让页面脚本能读取/改写用户输入的保存路径与标签。
const [modal, modalContextHolder] = Modal.useModal();
const promptForDynamicReplace = createDynamicReplacePrompter(modal);

const isSending = ref(false);
const quickSendToClient = ref<boolean>(false);
const selectedDownloader = ref<IDownloaderMetadata | null>(null);
const selectedDownloaderMetadata = shallowRef();
const addTorrentOptions = ref<Required<Omit<CAddTorrentOptions, "localDownloadOption">>>({
  localDownload: true,
  addAtPaused: false,
  savePath: "",
  label: "",
  uploadSpeedLimit: 0,
  advanceAddTorrentOptions: {},
});

const suggestFolders = computed(() => selectedDownloader.value?.suggestFolders ?? []);
const suggestTags = computed(() => selectedDownloader.value?.suggestTags ?? []);

const currentSiteIds = computed(() => [...new Set(torrentItems.map((t) => t.site).filter(Boolean))]);
const enabledDownloadersBySite = computed(() => {
  const ids = currentSiteIds.value;
  if (ids.length === 0) return metadataStore.getEnabledDownloaders;
  const sets = ids.map((id) => new Set(metadataStore.getEnabledDownloadersBySite(id).map((d) => d.id)));
  const intersection = sets.reduce((acc, s) => new Set([...acc].filter((x) => s.has(x))));
  return metadataStore.getEnabledDownloaders.filter((d) => intersection.has(d.id));
});
const sortedEnabledDownloadersBySite = computed(() =>
  [...enabledDownloadersBySite.value].sort((a, b) => (b.sortIndex ?? 0) - (a.sortIndex ?? 0)),
);

const downloaderTitle = (downloader: IDownloaderMetadata) => `${downloader.name} [${downloader.address}]`;
const getDownloaderIcon = (x: string) => chrome.runtime.getURL(getDownloaderIconRaw(x));

// 快速推送列表：把「下载器 × 建议目录」展开成行，便于用 a-list 渲染并保留行内 hover 菜单
const quickSendRows = computed(() =>
  sortedEnabledDownloadersBySite.value.flatMap((downloader) =>
    ["", ...(downloader.suggestFolders ?? [])].map((path) => ({
      downloader,
      path,
      key: `${downloader.id}:${path}`,
    })),
  ),
);

const downloaderOptions = computed(() =>
  sortedEnabledDownloadersBySite.value.map((downloader) => ({
    label: downloaderTitle(downloader),
    value: downloader,
  })),
);

function filterDownloader(inputValue: string, option: any): boolean {
  const downloader = option?.value as IDownloaderMetadata | undefined;
  if (!downloader) return true;
  const keyword = inputValue.toLowerCase();
  return [downloader.name, downloader.address, downloader.username]
    .filter((field) => !!field)
    .some((field) => String(field).toLowerCase().includes(keyword));
}

function restoreAddTorrentOptions(downloader?: IDownloaderMetadata) {
  addTorrentOptions.value.localDownload = true;
  addTorrentOptions.value.addAtPaused = !(downloader?.feature?.DefaultAutoStart ?? true);
  addTorrentOptions.value.savePath = "";
  addTorrentOptions.value.label = "";
  addTorrentOptions.value.advanceAddTorrentOptions = downloader?.advanceAddTorrentOptions ?? {};
}

watch(selectedDownloader, (value) => {
  if (value?.type) {
    getDownloaderMetaData(value.type).then((v) => (selectedDownloaderMetadata.value = v));
  } else {
    selectedDownloaderMetadata.value = null;
  }
});

async function sendToDownloader() {
  if (!selectedDownloader.value?.id) {
    runtimeStore.showSnakebar(t("SentToDownloaderDialog.selectDownloaderFirst"), { color: "error" });
    return;
  }

  // 保存此次选择记录（默认推送不保存）
  if (!isDefaultSend && configStore.download.saveLastDownloader) {
    // noinspection ES6MissingAwait
    metadataStore.setLastDownloader({
      id: selectedDownloader.value.id,
      options: addTorrentOptions.value,
    });
  }

  isSending.value = true;

  try {
    await sendTorrentToDownloader(
      torrentItems,
      selectedDownloader.value.id,
      addTorrentOptions.value,
      promptForDynamicReplace,
    );
    showDialog.value = false;
    emit("done");
  } catch (e) {
    // V-3：用户取消 `<...>` 输入时 sendTorrentToDownloader 会 reject。此前这里只挂了 `.finally()`：
    // 取消与成功在 UI 上完全一样（弹窗照样关闭、isSending 照样复位、还照样 emit("done")），
    // 并且产生 unhandled rejection。现在明确区分：提示取消原因、不 emit("done")，
    // 关闭弹窗后仍由 `after-close → dialogLeave` 统一 emit("cancel")。
    runtimeStore.showSnakebar(String(e), { color: "info" });
    showDialog.value = false;
  } finally {
    isSending.value = false;
  }
}

function quickSendToDownloader(downloader: IDownloaderMetadata, path: string = "", label?: string) {
  selectedDownloader.value = downloader;

  // 设置下载推送选项
  addTorrentOptions.value.localDownload = true;
  addTorrentOptions.value.addAtPaused = !(downloader.feature?.DefaultAutoStart ?? true);
  addTorrentOptions.value.advanceAddTorrentOptions = downloader.advanceAddTorrentOptions ?? {};

  // V-2：必须**无条件**赋值。原来的 `if (path) savePath = path` / `if (label) label = label`
  // 让「默认路径」行（path 为空串）沿用上一次的保存路径与标签：
  // 先点 /downloads/movies 再点「默认路径」行，第二个种子仍会被送进那个目录。
  addTorrentOptions.value.savePath = path;
  addTorrentOptions.value.label = label ?? "";

  return sendToDownloader();
}
function dialogEnter() {
  // 如果是默认下载发送，则直接设置为快速发送到客户端模式
  if (isDefaultSend) {
    const downloader = metadataStore.downloaders[metadataStore.defaultDownloader.id!];
    restoreAddTorrentOptions(downloader);
    quickSendToClient.value = true;

    // 加载默认下载器设置中的 folder, tags 信息
    selectedDownloader.value = downloader;
    addTorrentOptions.value.savePath = metadataStore.defaultDownloader.folder ?? "";
    addTorrentOptions.value.label = metadataStore.defaultDownloader.tags ?? "";

    // 直接调用发送函数
    sendToDownloader();
  } else {
    restoreAddTorrentOptions(); // 先重置所有选项，然后如果需要则从uiStore中获取历史情况
    quickSendToClient.value = configStore.download.useQuickSendToClient;

    // 如果不是快速发送到客户端模式，则尝试设置默认下载器
    if (!quickSendToClient.value) {
      const lastDownloaderId = metadataStore.lastDownloader?.id;
      selectedDownloader.value = lastDownloaderId // 如果有上次选择的下载器，则直接使用
        ? metadataStore.downloaders[lastDownloaderId]
        : sortedEnabledDownloadersBySite.value.length === 1 // 如果只有一个启用的下载器，则直接使用
          ? sortedEnabledDownloadersBySite.value[0]
          : null;

      // 将上一次的下载器选项通过 toMerged 合并到当前选项中，而不是直接覆盖
      addTorrentOptions.value = toMerged(
        addTorrentOptions.value,
        metadataStore.lastDownloader?.options ?? {},
      ) as Required<Omit<CAddTorrentOptions, "localDownloadOption">>;
    }
  }
}

function dialogLeave() {
  restoreAddTorrentOptions(); // 先重置所有选项，然后从uiStore中获取历史情况
  emit("cancel");
}

// 原生 a-modal 没有 afterOpenChange（只有 afterClose），打开时的初始化自行监听 open。
// 必须带 immediate：SearchEntity 的 ActionTd 用 `v-if="showDownloadClientDialog"` 按需挂载本组件，
// 挂载时 open 已经是 true，此时没有「值变化」事件，不带 immediate 的 watch 永远不会执行 dialogEnter，
// 「发送到默认下载器」就永远发不出去（且不会报错）。
watch(
  showDialog,
  (open) => {
    if (open) nextTick(dialogEnter);
  },
  { immediate: true },
);
</script>

<template>
  <a-modal
    v-model:open="showDialog"
    :keyboard="!isSending"
    :mask-closable="!isSending"
    :title="t('SentToDownloaderDialog.title', [torrentItems.length])"
    :width="800"
    :after-close="dialogLeave"
  >
    <a-alert
      v-if="isSending"
      show-icon
      :message="
        t('SentToDownloaderDialog.isSending', {
          name: selectedDownloader?.name,
          address: selectedDownloader?.address,
        })
      "
      type="info"
    />

    <a-form v-else layout="vertical">
      <!-- 快速下载选项 -->
      <template v-if="quickSendToClient">
        <a-list v-if="quickSendRows.length > 0" :data-source="quickSendRows" size="small">
          <template #renderItem="{ item: row }">
            <a-dropdown :trigger="['hover']" placement="bottomRight">
              <!-- L-17：a-list-item 渲染为裸 <li>，补上按钮语义与键盘触发，纯键盘用户才能用 -->
              <a-list-item
                role="button"
                style="cursor: pointer"
                tabindex="0"
                @click="() => quickSendToDownloader(row.downloader, row.path)"
                @keydown.enter.prevent="() => quickSendToDownloader(row.downloader, row.path)"
                @keydown.space.prevent="() => quickSendToDownloader(row.downloader, row.path)"
              >
                <a-list-item-meta :description="row.path || undefined" :title="downloaderTitle(row.downloader)">
                  <template #avatar>
                    <a-avatar :src="getDownloaderIcon(row.downloader.type)" shape="square" />
                  </template>
                </a-list-item-meta>
              </a-list-item>
              <template #overlay>
                <a-menu
                  @click="
                    ({ key }: { key: string | number }) => quickSendToDownloader(row.downloader, row.path, String(key))
                  "
                >
                  <a-menu-item v-for="tag in row.downloader.suggestTags" :key="tag">{{ tag }}</a-menu-item>
                </a-menu>
              </template>
            </a-dropdown>
          </template>
        </a-list>
        <a-alert
          v-else
          show-icon
          :message="
            currentSiteIds.length > 0 && configStore.download.allowDownloaderFilterForSite
              ? t('SentToDownloaderDialog.noDownloaderForSite')
              : t('SentToDownloaderDialog.noDownloader')
          "
          type="warning"
        />
      </template>

      <!-- 普通下载选项 -->
      <template v-else>
        <a-select
          v-model:value="selectedDownloader"
          allow-clear
          :filter-option="filterDownloader"
          :options="downloaderOptions"
          :placeholder="t('SentToDownloaderDialog.selectDownloader')"
          show-search
          @change="restoreAddTorrentOptions"
        >
          <template #option="{ value }">
            <a-flex align="center" :gap="8">
              <a-avatar :size="20" :src="getDownloaderIcon(value.type)" shape="square" />
              <span>{{ downloaderTitle(value) }}</span>
            </a-flex>
          </template>
        </a-select>

        <a-row :gutter="16">
          <a-col :span="12">
            <a-form-item
              :extra="t('SentToDownloaderDialog.savePathHint')"
              :label="t('SentToDownloaderDialog.savePath')"
            >
              <a-auto-complete
                v-model:value="addTorrentOptions.savePath"
                allow-clear
                :options="suggestFolders.map((folder) => ({ value: folder }))"
              />
            </a-form-item>
          </a-col>
          <a-col :span="12">
            <a-form-item :extra="t('SentToDownloaderDialog.labelHint')" :label="t('SentToDownloaderDialog.label')">
              <a-auto-complete
                v-model:value="addTorrentOptions.label"
                allow-clear
                :options="suggestTags.map((tag) => ({ value: tag }))"
              />
            </a-form-item>
          </a-col>
        </a-row>

        <a-row :gutter="16">
          <a-col :span="12">
            <!-- FIXME 添加设置项，默认 disabled -->
            <a-flex align="center" :gap="8">
              <a-switch
                v-model:checked="addTorrentOptions.localDownload"
                :disabled="!configStore.download.allowDirectSendToClient"
              />
              <span>{{ t("SentToDownloaderDialog.localRelay") }}</span>
            </a-flex>
          </a-col>
          <a-col :span="12">
            <a-flex align="center" :gap="8">
              <a-switch v-model:checked="addTorrentOptions.addAtPaused" />
              <span>{{ t("SentToDownloaderDialog.pauseOnAdd") }}</span>
            </a-flex>
          </a-col>
        </a-row>

        <a-collapse :bordered="false">
          <a-collapse-panel
            :disabled="!((selectedDownloaderMetadata?.advanceAddTorrentOptions ?? []).length > 0)"
            :header="t('common.advancedSettings')"
          >
            <a-flex
              v-for="opt in selectedDownloaderMetadata?.advanceAddTorrentOptions ?? []"
              :key="opt.key"
              :gap="4"
              vertical
            >
              <a-flex align="center" :gap="8">
                <a-switch v-model:checked="addTorrentOptions.advanceAddTorrentOptions![opt.key]" />
                <span>{{ opt.name }}</span>
              </a-flex>
              <a-typography-text v-if="opt.description" type="secondary">{{ opt.description }}</a-typography-text>
            </a-flex>
          </a-collapse-panel>
        </a-collapse>
      </template>
    </a-form>
    <template #footer>
      <a-flex align="center" justify="space-between">
        <a-flex align="center" :gap="8">
          <a-button
            :title="t('SentToDownloaderDialog.moreOptions')"
            type="text"
            @click="quickSendToClient = !quickSendToClient"
          >
            <template #icon><AppstoreOutlined /></template>
          </a-button>
        </a-flex>

        <a-flex align="center" :gap="8">
          <a-button :disabled="isSending" @click="showDialog = false">
            {{ t("common.dialog.cancel") }}
          </a-button>
          <a-button
            :disabled="!selectedDownloader || quickSendToClient"
            :loading="isSending"
            type="primary"
            @click="sendToDownloader"
          >
            <template #icon><CheckCircleOutlined /></template>
            {{ t("common.dialog.ok") }}
          </a-button>
        </a-flex>
      </a-flex>
    </template>
  </a-modal>

  <!-- Modal.useModal() 的 contextHolder：把「替换 <...>」输入弹窗渲染在本组件所在的容器内
       （内容脚本下即 shadow root），而不是宿主页面的 document.body（V-11） -->
  <component :is="modalContextHolder" />
</template>
