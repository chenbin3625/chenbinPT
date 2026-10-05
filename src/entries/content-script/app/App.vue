<script setup lang="ts">
import { inject, provide, useTemplateRef, ref, shallowReactive, computed, withModifiers, onUnmounted } from "vue";
import { useI18n } from "vue-i18n";
import { useDraggable } from "@vueuse/core";
import { HomeOutlined } from "@ant-design/icons-vue";
import { Modal } from "ant-design-vue";
import { type ITorrent } from "@ptd/site";

import { sendMessage } from "@/messages.ts";
import { useConfigStore } from "@/options/stores/config.ts";
import { useRuntimeStore } from "@/options/stores/runtime.ts";

import { registerModalApi } from "./modal.ts";
import type { IRemoteDownloadDialogData } from "./types.ts";
import {
  CUSTOM_DRAG_MIME,
  currentView,
  getTrustedLinkHosts,
  getIDFromURL,
  installPageTypeUrlWatcher,
  pageType,
  resolveDroppedTorrents,
  updatePageType,
  type IPtdData,
} from "./utils.ts";

import SpeedDialBtn from "./components/SpeedDialBtn.vue";
import SentToDownloaderDialog from "@/options/components/SentToDownloaderDialog/Index.vue";

const configStore = useConfigStore();
const runtimeStore = useRuntimeStore();
const { t } = useI18n();

// shadow root 内的 Modal 实例：contextHolder 必须渲染在 ConfigProvider 之下（本组件的模板里），
// 弹窗才会继承主题/语言/getPopupContainer。详见 ./modal.ts。
const [modal, modalContextHolder] = Modal.useModal();
registerModalApi(modal);

const ptdIcon = chrome.runtime.getURL("icons/logo/64.png");
const ptdData = inject<IPtdData>("ptd_data", {});

const el = useTemplateRef<HTMLElement>("el");
provide("app", el);

// 记录一下与右边界和下边界的距离
const rightX = ref<number>(0);
const bottomY = ref<number>(0);

const openSpeedDial = ref<boolean>(false);
const { x, y, style } = useDraggable(el, {
  preventDefault: true,
  initialValue: { x: -100, y: -100 }, // Default position off-screen
  onEnd: ({ x, y }) => {
    configStore.updateContentScriptPosition(x, y);
    const { clientWidth, clientHeight } = document.documentElement;
    rightX.value = clientWidth - x;
    bottomY.value = clientHeight - y;
  },
});

// 监听窗口大小变化，更新位置（组件卸载时需要移除，避免 content-script 重挂载时监听器累积）
function handleWindowResize() {
  const { clientWidth, clientHeight } = document.documentElement;

  x.value = clientWidth - rightX.value; // 右侧吸附
  if (x.value > clientWidth - 50 || x.value < 0) {
    x.value = clientWidth - 100; // 确保不会超出右边界
  }
  rightX.value = clientWidth - x.value;

  y.value = clientHeight - bottomY.value; // 底部吸附
  if (y.value > clientHeight - 50 || y.value < 0) {
    y.value = clientHeight - 100; // 确保不会超出下边界
  }
  bottomY.value = clientHeight - y.value;
}
window.addEventListener("resize", handleWindowResize);

// 由于App.vue是整个应用的根组件，此时 configStore 等 pinia store 可能还未初始化完成，所以需要监听 $onReady
let stopUrlWatcher: (() => void) | undefined;

configStore.$onReady(() => {
  openSpeedDial.value = configStore.contentScript?.defaultOpenSpeedDial ?? false;

  if (openSpeedDial.value) {
    updatePageType(ptdData).catch();
  }

  // A-8：SPA 站点（Unit3D/Livewire 等）列表 → 详情是 pushState 导航，内容脚本不会重新执行，
  // 必须订阅 URL 变化并重新求值 pageType/站点实例（在 store 就绪后再装，避免水合竞态）。
  stopUrlWatcher?.(); // 幂等：$onReady 若重复触发，先释放上一轮的订阅，避免监听器累积
  stopUrlWatcher = installPageTypeUrlWatcher(ptdData);

  let { x: storeX = -100, y: storeY = -100 } = configStore.contentScript?.position ?? {};
  let { clientWidth, clientHeight } = document.documentElement;

  x.value = storeX <= 0 || storeX > clientWidth - 50 ? clientWidth - 100 : storeX; // Default to right side
  y.value = storeY <= 0 || storeY > clientHeight - 50 ? clientHeight - 100 : storeY; // Default to bottom
  rightX.value = clientWidth - x.value;
  bottomY.value = clientHeight - y.value;
});

const remoteDownloadDialogData = shallowReactive<IRemoteDownloadDialogData>({
  show: false,
  torrents: [] as ITorrent[],
  isDefaultSend: false,
});
provide("remoteDownloadDialogData", remoteDownloadDialogData);

const isDragging = ref<boolean>(false);

function fixDraggingLink(link: string): string {
  if (!link.startsWith("http") && !link.startsWith("magnet:")) {
    return new URL(link, window.location.href).href; // 相对链接转换为绝对链接
  }
  return link;
}

function handleDocumentDragStart(e: DragEvent) {
  const target = e.target as HTMLElement;
  if (target.tagName == "A") {
    const a = target as HTMLAnchorElement;
    const link = fixDraggingLink(a.href);
    if (link) {
      let list: ITorrent[] = [
        {
          site: ptdData.siteId || "",
          link,
          title: a.getAttribute("title") || target.innerText,
          id: getIDFromURL(URL.parse(link, location.href)),
        },
      ];
      e.dataTransfer?.setData(CUSTOM_DRAG_MIME, JSON.stringify(list));
    }
  }
  // fallback to default text/html behavior
}
document.addEventListener("dragstart", handleDocumentDragStart);

onUnmounted(() => {
  window.removeEventListener("resize", handleWindowResize);
  document.removeEventListener("dragstart", handleDocumentDragStart);
  stopUrlWatcher?.(); // A-8：移除 URL 变化订阅（含 history 上的补丁）
});

async function onDrop(event: DragEvent) {
  const dataTransfer = event.dataTransfer;
  if (!dataTransfer) {
    isDragging.value = false;
    return;
  }

  try {
    const siteId = ptdData.siteId || "";
    const trustedHosts = await getTrustedLinkHosts(siteId);
    // S-2：拖拽内容完全由页面提供，必须在这里做形状 + 协议白名单 + 当前站点 host 校验，
    // 并强制把 site 改写为当前站点（校验失败时 resolveDroppedTorrents 会给出提示）
    const { torrents } = resolveDroppedTorrents(dataTransfer, siteId, trustedHosts);

    if (torrents.length > 0) {
      remoteDownloadDialogData.torrents = torrents;
      remoteDownloadDialogData.show = true;
    }
  } catch {
    runtimeStore.showSnakebar(t("contentScript.noTorrentParsed"), { color: "error" });
  } finally {
    isDragging.value = false; // 重置拖拽状态
  }
}

const dropAction = computed(() => {
  if (ptdData.siteId && (configStore.contentScript?.dragLinkOnSpeedDial ?? true)) {
    return {
      drop: withModifiers((e) => onDrop(e as DragEvent), ["prevent"]),
      dragover: withModifiers(() => (isDragging.value = true), ["prevent"]),
      dragenter: withModifiers(() => (isDragging.value = true), ["prevent"]),
      // dragleave 和 mouseleave 事件直接使用 vue 的普通注册方式，而不是用 对象方式（因为不会有任何副作用）
    };
  }
  return {};
});

function openOptions() {
  sendMessage("openOptionsPage", "/");
}
</script>

<template>
  <div
    ref="el"
    :style="style"
    class="ptd-content-script-draggable"
    :class="{
      'ptd-fade-enter': configStore.contentScript.fadeEnterStyle,
    }"
    @mouseleave.prevent="isDragging = false"
    @dragleave.prevent="isDragging = false"
    v-on="dropAction"
  >
    <a-float-button-group
      v-model:open="openSpeedDial"
      :shape="configStore.contentScript.stackedButtons ? 'square' : 'circle'"
      trigger="click"
      type="primary"
    >
      <template #icon>
        <a-avatar
          :src="ptdIcon"
          :size="32"
          shape="square"
          class="ptd-fab-logo"
          :class="{ 'ptd-fab-logo--dragging': isDragging }"
          @click="updatePageType(ptdData)"
        />
      </template>

      <!-- 这里根据 pageType 来决定显示哪些按钮 -->
      <component :is="currentView" :key="pageType" />

      <SpeedDialBtn key="home" :icon="HomeOutlined" :title="t('contentScript.openPTD')" @click="openOptions" />
    </a-float-button-group>
  </div>

  <SentToDownloaderDialog
    v-model="remoteDownloadDialogData.show"
    :torrent-items="remoteDownloadDialogData.torrents"
    :is-default-send="remoteDownloadDialogData.isDefaultSend"
  />

  <!-- Modal.useModal() 的 contextHolder：把 confirm/prompt 弹窗渲染在 shadow root 内 -->
  <component :is="modalContextHolder" />
</template>
