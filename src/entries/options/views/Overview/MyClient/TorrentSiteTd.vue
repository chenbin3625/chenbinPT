<script setup lang="ts">
import { GlobalOutlined } from "@ant-design/icons-vue";
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { CTorrent } from "@ptd/downloader";

import SiteFavicon from "@/options/components/SiteFavicon/Index.vue";
import SiteName from "@/options/components/SiteName.vue";

import { getCachedTorrentSiteMatch } from "./torrentSite.ts";

// 站点判定在 loadSingleDownloader 中统一完成并写入响应式缓存，该组件只负责展示
// （缓存中没有结果表示判定尚未完成）
const { item } = defineProps<{
  item: CTorrent;
}>();

const { t } = useI18n();

const match = computed(() => getCachedTorrentSiteMatch(item));
</script>

<template>
  <div class="torrent-site-td">
    <template v-if="match?.type === 'site'">
      <SiteFavicon :site-id="match.siteId" :size="20" />
      <SiteName class="ptd-cell-ellipsis torrent-site-td__name" :site-id="match.siteId" />
    </template>
    <template v-else-if="match?.type === 'public'">
      <GlobalOutlined :title="t('MyClient.sitePublicTip')" style="font-size: 18px; color: var(--ptd-text-tertiary)" />
      <span class="torrent-site-td__label" style="color: var(--ptd-text-tertiary)">{{ t("MyClient.sitePublic") }}</span>
    </template>
    <template v-else-if="match?.type === 'unmatched'">
      <GlobalOutlined :title="t('MyClient.siteUnmatchedTip')" style="font-size: 18px; color: var(--ptd-warning)" />
      <span class="torrent-site-td__label" style="color: var(--ptd-warning)">{{ t("MyClient.siteUnmatched") }}</span>
    </template>
    <a-spin v-else size="small" />
  </div>
</template>

<style scoped>
.torrent-site-td {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
}

.torrent-site-td__name {
  max-width: 8rem;
  font-size: 12px;
}

.torrent-site-td__label {
  font-size: 12px;
  white-space: nowrap;
}
</style>
