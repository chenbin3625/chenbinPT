<script setup lang="ts">
import { ref, computed, nextTick, shallowRef, toRaw, watch } from "vue";
import { useI18n } from "vue-i18n";
import { AppstoreOutlined, CheckCircleOutlined } from "@ant-design/icons-vue";
import { cloneDeep, toMerged } from "es-toolkit";
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
import { sendMessage } from "@/messages.ts";
import { formatSize } from "@/options/utils.ts";
import { matchPushRoutingRule } from "@/shared/pushRouting.ts";
import type { IDownloaderMetadata, TDownloaderKey } from "@/shared/types.ts";

import { createDynamicReplacePrompter, sendTorrentToDownloader } from "./utils.ts";

const showDialog = defineModel<boolean>();
const { torrentItems, isDefaultSend, allowSiteLessLink } = defineProps<{
  torrentItems: ITorrent[];
  isDefaultSend?: boolean;
  allowSiteLessLink?: boolean;
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
const selectedDownloaderId = ref<TDownloaderKey | undefined>(undefined);
const selectedDownloader = computed<IDownloaderMetadata | null>(() => {
  const id = selectedDownloaderId.value;
  if (!id) return null;
  return metadataStore.downloaders?.[id] ?? metadataStore.getEnabledDownloaders?.find((item) => item.id === id) ?? null;
});
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

const freeSpaceMap = ref<Record<string, number | "N/A">>({});
const totalSelectedSize = computed(() =>
  torrentItems.reduce(
    (sum, item) => sum + (typeof item.size === "number" && Number.isFinite(item.size) ? item.size : 0),
    0,
  ),
);
const selectedDownloaderFreeSpace = computed(() =>
  selectedDownloaderId.value ? freeSpaceMap.value[selectedDownloaderId.value] : undefined,
);
const isLowFreeSpace = computed(() => {
  const free = selectedDownloaderFreeSpace.value;
  if (typeof free !== "number" || !Number.isFinite(free)) return false;
  return free < Math.max(totalSelectedSize.value, 10 * 1024 ** 3);
});

async function refreshDownloaderFreeSpaces(ids: string[]) {
  const uniqueIds = [...new Set(ids.filter(Boolean))];
  await Promise.allSettled(
    uniqueIds.map(async (id) => {
      try {
        const space = await sendMessage("getDownloaderFreeSpace", id);
        freeSpaceMap.value = { ...freeSpaceMap.value, [id]: space };
      } catch {
        // 忽略单个下载器空间查询失败
      }
    }),
  );
}

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

const matchedRoutingRule = computed(() => {
  if (torrentItems.length === 0) return null;
  const enabledSet = new Set(sortedEnabledDownloadersBySite.value.map((d) => d.id));
  return matchPushRoutingRule(torrentItems[0], metadataStore.pushRoutingRules ?? [], enabledSet);
});

function applyRoutingRule(rule: NonNullable<typeof matchedRoutingRule.value>) {
  const downloader = metadataStore.downloaders[rule.targetDownloaderId];
  if (!downloader) return false;
  selectedDownloaderId.value = downloader.id;
  restoreAddTorrentOptions(downloader);
  if (typeof rule.savePath === "string" && rule.savePath) {
    addTorrentOptions.value.savePath = rule.savePath;
  }
  if (typeof rule.label === "string" && rule.label) {
    addTorrentOptions.value.label = rule.label;
  }
  if (
    typeof rule.uploadSpeedLimit === "number" &&
    Number.isFinite(rule.uploadSpeedLimit) &&
    rule.uploadSpeedLimit > 0
  ) {
    addTorrentOptions.value.uploadSpeedLimit = rule.uploadSpeedLimit;
  }
  if (typeof rule.addAtPaused === "boolean") {
    addTorrentOptions.value.addAtPaused = rule.addAtPaused;
  }
  return true;
}

function quickSendByRoutingRule() {
  if (!matchedRoutingRule.value || isSending.value) return;
  if (applyRoutingRule(matchedRoutingRule.value)) {
    void sendToDownloader();
  }
}

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
    value: downloader.id,
    downloader,
  })),
);

function optionDownloader(option: any): IDownloaderMetadata | undefined {
  return option?.downloader ?? option?.data?.downloader;
}

function filterDownloader(inputValue: string, option: any): boolean {
  const downloader = optionDownloader(option);
  if (!downloader) return true;
  const keyword = inputValue.toLowerCase();
  return [downloader.name, downloader.address, downloader.username]
    .filter((field) => !!field)
    .some((field) => String(field).toLowerCase().includes(keyword));
}

function restoreAddTorrentOptions(downloader?: IDownloaderMetadata) {
  // 每次赋予新对象而非就地修改，避免与已交给 metadataStore.setLastDownloader 的对象别名冲突
  addTorrentOptions.value = {
    localDownload: true,
    addAtPaused: !(downloader?.feature?.DefaultAutoStart ?? true),
    savePath: "",
    label: "",
    uploadSpeedLimit: 0,
    // 必须克隆：模板用 v-model:checked 直接写这个对象，直接引用 store 会让「取消」后
    // 已保存的下载器高级设置也被永久改写。
    advanceAddTorrentOptions: cloneDeep(toRaw(downloader?.advanceAddTorrentOptions ?? {})),
  };
}

function handleDownloaderChange(value: unknown) {
  const id = typeof value === "string" ? value : undefined;
  restoreAddTorrentOptions(id ? metadataStore.downloaders[id] : undefined);
}

watch(selectedDownloader, (value) => {
  const type = value?.type;

  // OPTIONSSHELL-9：只要选中的下载器变了，上一个下载器的元数据立即作废 —— 否则在动态 import
  // 返回前的窗口里会渲染它的高级选项，而 v-model 写的是**新下载器**的 advanceAddTorrentOptions。
  selectedDownloaderMetadata.value = null;
  if (!type) return;

  // getDownloaderMetaData 首次加载慢、其后快：迟到的回调会覆盖当前选中的元数据，
  // 加载失败还会留下 unhandled rejection。这里做「当前性校验 + catch」，只有仍是同一个 type 才落值。
  getDownloaderMetaData(type)
    .then((v) => {
      if (selectedDownloader.value?.type === type) selectedDownloaderMetadata.value = v;
    })
    .catch(() => {
      // 加载失败保持 null（高级选项面板置灰）而不是沿用上一个下载器的元数据；调用方无日志通道，不新增 console
      if (selectedDownloader.value?.type === type) selectedDownloaderMetadata.value = null;
    });
});

async function sendToDownloader() {
  if (isSending.value) return;
  if (!selectedDownloader.value?.id) {
    runtimeStore.showSnackbar(t("SentToDownloaderDialog.selectDownloaderFirst"), { color: "error" });
    return;
  }

  // 保存此次选择记录（默认推送不保存）；深拷贝解代理，避免关闭弹窗触发 dialogLeave 时原地清空
  if (!isDefaultSend && configStore.download.saveLastDownloader) {
    // noinspection ES6MissingAwait
    void metadataStore.setLastDownloader({
      id: selectedDownloader.value.id,
      options: cloneDeep(toRaw(addTorrentOptions.value)),
    });
  }

  isSending.value = true;

  try {
    await sendTorrentToDownloader(
      torrentItems,
      selectedDownloader.value.id,
      addTorrentOptions.value,
      promptForDynamicReplace,
      { allowSiteLessLink },
    );
    showDialog.value = false;
    emit("done");
  } catch (e) {
    // V-3：用户取消 `<...>` 输入时 sendTorrentToDownloader 会 reject。此前这里只挂了 `.finally()`：
    // 取消与成功在 UI 上完全一样（弹窗照样关闭、isSending 照样复位、还照样 emit("done")），
    // 并且产生 unhandled rejection。现在明确区分：提示取消原因、不 emit("done")，
    // 关闭弹窗后仍由 `after-close → dialogLeave` 统一 emit("cancel")。
    runtimeStore.showSnackbar(String(e), { color: "info" });
    showDialog.value = false;
  } finally {
    isSending.value = false;
  }
}

function quickSendToDownloader(downloader: IDownloaderMetadata, path: string = "", label?: string) {
  if (isSending.value) return;
  selectedDownloaderId.value = downloader.id;

  // 设置下载推送选项
  // V-2：必须**无条件**赋值。原来的 `if (path) savePath = path` / `if (label) label = label`
  // 让「默认路径」行（path 为空串）沿用上一次的保存路径与标签：
  // 先点 /downloads/movies 再点「默认路径」行，第二个种子仍会被送进那个目录。
  addTorrentOptions.value = {
    localDownload: true,
    addAtPaused: !(downloader.feature?.DefaultAutoStart ?? true),
    savePath: path,
    label: label ?? "",
    uploadSpeedLimit: 0,
    advanceAddTorrentOptions: cloneDeep(toRaw(downloader.advanceAddTorrentOptions ?? {})),
  };

  return sendToDownloader();
}
function dialogEnter() {
  // 如果是默认下载发送，则直接设置为快速发送到客户端模式
  if (isDefaultSend) {
    quickSendToClient.value = true;
    if (configStore.download.enableRoutingRulesOnDefaultSend && matchedRoutingRule.value) {
      applyRoutingRule(matchedRoutingRule.value);
      void sendToDownloader();
      return;
    }

    const downloader = metadataStore.downloaders[metadataStore.defaultDownloader.id!];
    restoreAddTorrentOptions(downloader);

    // 加载默认下载器设置中的 folder, tags 信息
    selectedDownloaderId.value = downloader?.id;
    addTorrentOptions.value.savePath = metadataStore.defaultDownloader.folder ?? "";
    addTorrentOptions.value.label = metadataStore.defaultDownloader.tags ?? "";

    // 直接调用发送函数
    void sendToDownloader();
  } else {
    selectedDownloaderId.value = undefined;
    restoreAddTorrentOptions(); // 先重置所有选项，然后如果需要则从uiStore中获取历史情况
    quickSendToClient.value = configStore.download.useQuickSendToClient;
    void refreshDownloaderFreeSpaces(sortedEnabledDownloadersBySite.value.map((d) => d.id));

    // 如果不是快速发送到客户端模式，优先应用命中的智能路由规则，其次回退上次使用的下载器
    if (!quickSendToClient.value) {
      if (matchedRoutingRule.value && applyRoutingRule(matchedRoutingRule.value)) {
        return;
      }

      const lastDownloaderId = metadataStore.lastDownloader?.id;
      const eligibleLastDownloader = lastDownloaderId
        ? sortedEnabledDownloadersBySite.value.find((d) => d.id === lastDownloaderId)
        : undefined;

      if (eligibleLastDownloader) {
        selectedDownloaderId.value = eligibleLastDownloader.id;
        restoreAddTorrentOptions(eligibleLastDownloader);
        // 将上一次的下载器选项通过 toMerged 合并到当前选项中，而不是直接覆盖
        addTorrentOptions.value = toMerged(
          addTorrentOptions.value,
          cloneDeep(toRaw(metadataStore.lastDownloader?.options ?? {})),
        ) as Required<Omit<CAddTorrentOptions, "localDownloadOption">>;
      } else {
        const fallbackDownloader =
          sortedEnabledDownloadersBySite.value.length === 1 ? sortedEnabledDownloadersBySite.value[0] : undefined;
        selectedDownloaderId.value = fallbackDownloader?.id;
        restoreAddTorrentOptions(fallbackDownloader);
      }
    }
  }
}

function dialogLeave() {
  selectedDownloaderId.value = undefined;
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
    if (open) void nextTick(dialogEnter);
  },
  { immediate: true },
);
</script>

<template>
  <a-modal
    v-model:open="showDialog"
    :closable="!isSending"
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
      <!-- 智能推送路由命中提示 -->
      <a-alert
        v-if="matchedRoutingRule"
        type="info"
        show-icon
        class="sent-to-downloader__alert"
        :message="
          t('SentToDownloaderDialog.routingRuleMatched', {
            rule: matchedRoutingRule.name,
            downloader:
              metadataStore.downloaders[matchedRoutingRule.targetDownloaderId]?.name ||
              matchedRoutingRule.targetDownloaderId,
          })
        "
      >
        <template v-if="quickSendToClient" #action>
          <a-button size="small" type="primary" @click="quickSendByRoutingRule">
            {{ t("SentToDownloaderDialog.sendByRoutingRule") }}
          </a-button>
        </template>
      </a-alert>

      <!-- 快速下载选项 -->
      <template v-if="quickSendToClient">
        <a-list v-if="quickSendRows.length > 0" :data-source="quickSendRows" size="small">
          <template #renderItem="{ item: row }">
            <a-dropdown :trigger="['hover']" placement="bottomRight">
              <!-- L-17：a-list-item 渲染为裸 <li>，补上按钮语义与键盘触发，纯键盘用户才能用 -->
              <a-list-item
                role="button"
                class="sent-to-downloader__quick-row"
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
                <a-tag
                  v-if="typeof freeSpaceMap[row.downloader.id] === 'number'"
                  :color="
                    (freeSpaceMap[row.downloader.id] as number) < Math.max(totalSelectedSize, 10 * 1024 ** 3)
                      ? 'error'
                      : 'default'
                  "
                >
                  {{
                    t("SentToDownloaderDialog.freeSpaceShort", {
                      size: formatSize(freeSpaceMap[row.downloader.id] as number),
                    })
                  }}
                </a-tag>
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
          v-model:value="selectedDownloaderId"
          allow-clear
          :filter-option="filterDownloader"
          :options="downloaderOptions"
          :placeholder="t('SentToDownloaderDialog.selectDownloader')"
          show-search
          @change="handleDownloaderChange"
        >
          <template #option="option">
            <a-flex v-if="optionDownloader(option)" align="center" justify="space-between" :gap="8">
              <a-flex align="center" :gap="8">
                <a-avatar :size="20" :src="getDownloaderIcon(optionDownloader(option)!.type)" shape="square" />
                <span>{{ downloaderTitle(optionDownloader(option)!) }}</span>
              </a-flex>
              <a-tag
                v-if="typeof freeSpaceMap[optionDownloader(option)!.id] === 'number'"
                :color="
                  (freeSpaceMap[optionDownloader(option)!.id] as number) < Math.max(totalSelectedSize, 10 * 1024 ** 3)
                    ? 'error'
                    : 'default'
                "
              >
                {{ formatSize(freeSpaceMap[optionDownloader(option)!.id] as number) }}
              </a-tag>
            </a-flex>
          </template>
        </a-select>

        <a-alert
          v-if="isLowFreeSpace && typeof selectedDownloaderFreeSpace === 'number'"
          type="warning"
          show-icon
          class="sent-to-downloader__space-warn"
          :message="
            t('SentToDownloaderDialog.lowFreeSpaceWarning', {
              free: formatSize(selectedDownloaderFreeSpace),
              need: formatSize(totalSelectedSize),
            })
          "
        />

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
            :disabled="isSending"
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

<style scoped>
/* 快速发送行整行可点，用类承载指针样式（静态行内样式收敛） */
.sent-to-downloader__quick-row {
  cursor: pointer;
}

.sent-to-downloader__alert {
  margin-bottom: 12px;
}

.sent-to-downloader__space-warn {
  margin-top: 8px;
  margin-bottom: 4px;
}
</style>
