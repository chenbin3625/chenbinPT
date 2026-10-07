<script setup lang="ts">
import { computed, type Component } from "vue";
import { useI18n } from "vue-i18n";
import { DisconnectOutlined, FolderOpenOutlined } from "@ant-design/icons-vue";
import { getDownloaderIcon } from "@ptd/downloader";

import { useMetadataStore } from "@/options/stores/metadata.ts";
import { resolveColor } from "@/shared/colors.ts";
import type { TDownloaderKey } from "@/shared/types.ts";

const { downloader } = defineProps<{
  downloader: TDownloaderKey;
}>();

const { t } = useI18n();
const metadataStore = useMetadataStore();

// OPTIONSSHELL-6：`downloaders` 是异步水合的 store state（其它标签页的 onChanged 也会改写它），
// setup 期取成常量会让标签/图标永远停在首次渲染值（水合未完成时即 `<a-typography-text delete>` + 断连图标）。
const downloaderConfig = computed(() => metadataStore.downloaders[downloader]);

const downloaderAvatar = computed<{ icon?: Component; src?: string; style?: Record<string, string> }>(() => {
  if (downloader === "local") {
    return { icon: FolderOpenOutlined, style: { backgroundColor: resolveColor("amber")!, color: "#fff" } };
  }
  if (downloaderConfig.value) {
    return { src: getDownloaderIcon(downloaderConfig.value.type) };
  }
  return { icon: DisconnectOutlined, style: { backgroundColor: resolveColor("grey")!, color: "#fff" } };
});

/** 名称被截断时用于悬停展示的完整文案（本地下载 / 已配置下载器 / 未知下载器三种情形） */
const downloaderNameTitle = computed(() => {
  if (downloader === "local") return t("downloaderLabel.localDownload");
  if (downloaderConfig.value) return downloaderConfig.value.name;
  return `[${downloader}]`;
});
</script>

<template>
  <slot :config="downloaderConfig" :icon="downloaderAvatar">
    <div class="downloader_label">
      <div class="downloader_icon">
        <!-- 28px：表格里 40px 头像会把下载历史/辅种任务的行高顶到 54px 以上 -->
        <a-avatar :size="28" :src="downloaderAvatar.src" :style="downloaderAvatar.style">
          <template v-if="downloaderAvatar.icon" #icon>
            <component :is="downloaderAvatar.icon" />
          </template>
        </a-avatar>
      </div>
      <div class="downloader_info" style="align-self: center">
        <!-- 名称与地址都可能很长（自定义名称 / 带 token 的完整地址），
             各自限制最大宽度并单行省略，悬停由原生 title 展示全文：
             否则地址换行会把整行撑到 90px 以上（下载历史表尤其明显）。 -->
        <strong class="ptd-cell-ellipsis" style="max-width: 12rem" :title="downloaderNameTitle">
          <template v-if="downloader === 'local'">{{ t("downloaderLabel.localDownload") }}</template>
          <template v-else-if="downloaderConfig">{{ downloaderConfig.name }}</template>
          <template v-else>
            <a-typography-text delete>[{{ downloader }}]</a-typography-text>
          </template>
        </strong>
        <template v-if="downloaderConfig">
          <a-typography-link
            class="ptd-cell-ellipsis"
            :href="downloaderConfig.address"
            style="font-size: 12px; max-width: 12rem"
            target="_blank"
            :title="downloaderConfig.address"
          >
            [{{ downloaderConfig.address }}]
          </a-typography-link>
        </template>
      </div>
    </div>
  </slot>
</template>
