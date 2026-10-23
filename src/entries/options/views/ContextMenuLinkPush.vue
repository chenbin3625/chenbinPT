<script setup lang="ts">
/**
 * 本文件仅作为右键菜单的链接跳转使用
 */

import { onMounted, onUnmounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";
import { getHostFromUrl, ITorrent } from "@ptd/site";

import { useMetadataStore } from "@/options/stores/metadata.ts";
import { useRuntimeStore } from "@/options/stores/runtime.ts";

import SentToDownloaderDialog from "@/options/components/SentToDownloaderDialog/Index.vue";

const route = useRoute();
const router = useRouter();
const metadataStore = useMetadataStore();
const runtimeStore = useRuntimeStore();
const { t } = useI18n();

const showDialog = ref(false);
const torrentItems = ref<ITorrent[]>([]);

let disposed = false;
onUnmounted(() => {
  disposed = true;
});

/**
 * F1-02：**必须等 metadata store 水合完成**再解析站点。
 *
 * 本页由 background 的 `chrome.tabs.create` 打开（`background/utils/base.ts` 的 openOptionsPage），
 * 等同一次冷启动：`metadata` store 的状态是从 `chrome.storage.local` 异步恢复的
 * （`extends/pinia/webExtPersistence.ts`），而 `onMounted` 一定早于恢复完成。
 * 旧实现在这里直接读 `metadataStore.siteHostMap`（此时恒为 `{}`），于是右键「推送链接」得到的
 * `torrent.site` 永远是 undefined —— `$torrent.site$` / `$torrent.siteName$` 占位符不替换、
 * 站点维度的下载器过滤失效。
 */
onMounted(async () => {
  const link = route?.query?.link;

  if (!link || typeof link !== "string") {
    runtimeStore.showSnakebar(t("ContextMenuLinkPush.invalidLink"), { color: "error" });
    onCancel();
    return;
  }

  // 等水合完成；失败也继续（站点解析不到就按「站点无关链接」推送，与旧行为一致）
  try {
    await metadataStore.$onReady();
  } catch {
    // 水合异常时 siteHostMap 保持为空，后面按 allowSiteLessLink 处理
  }

  if (disposed) return;

  const torrent = { link } as ITorrent;

  // 尝试从 link 中解出site
  if (link.match(/https?:\/\/([^/]+)/)) {
    const host = getHostFromUrl(link);
    const siteId = host ? metadataStore.siteHostMap[host] : undefined;
    if (siteId) {
      torrent.site = siteId;
    }
  }

  torrentItems.value = [torrent];
  runtimeStore.showSnakebar(t("ContextMenuLinkPush.keywordWarning"), { color: "warning" });
  showDialog.value = true;
});

function onDone() {
  void router.push({
    name: "DownloadHistory",
  });
}

function onCancel() {
  // 该页面是 background 用 `chrome.tabs.create` 打开的普通标签页，而浏览器只允许脚本关闭
  // 「由脚本 window.open 打开的」窗口 —— 这里的 window.close() 通常是 no-op（F1-02 附带发现），
  // 用户会停留在一个只有顶栏/侧栏的空白页。因此无论能否关闭，都退回下载记录页作为兜底。
  window.close();
  void router.replace({ name: "DownloadHistory" });
}
</script>

<template>
  <SentToDownloaderDialog
    v-model="showDialog"
    :torrent-items="torrentItems"
    allow-site-less-link
    @done="onDone"
    @cancel="onCancel"
  />
</template>
