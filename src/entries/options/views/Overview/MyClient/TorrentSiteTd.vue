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
      <GlobalOutlined
        :title="t('MyClient.sitePublicTip')"
        class="torrent-site-td__icon torrent-site-td__icon--public"
      />
      <span class="torrent-site-td__label torrent-site-td__label--public">{{ t("MyClient.sitePublic") }}</span>
    </template>
    <template v-else-if="match?.type === 'unmatched'">
      <GlobalOutlined
        :title="t('MyClient.siteUnmatchedTip')"
        class="torrent-site-td__icon torrent-site-td__icon--unmatched"
      />
      <span class="torrent-site-td__label torrent-site-td__label--unmatched">{{ t("MyClient.siteUnmatched") }}</span>
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

/* 公网 / 未匹配两种状态的图标与文案色（原先 4 处静态行内样式） */
.torrent-site-td__icon {
  font-size: 18px;
}

.torrent-site-td__icon--public,
.torrent-site-td__label--public {
  color: var(--ptd-text-tertiary);
}

.torrent-site-td__icon--unmatched,
.torrent-site-td__label--unmatched {
  color: var(--ptd-warning);
}
</style>
