<script setup lang="ts">
import { CheckCircleOutlined, PlayCircleOutlined } from "@ant-design/icons-vue";
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import type { IMediaServerItem } from "@ptd/mediaServer";

import ItemInformationDialog from "../MediaServerEntity/ItemInformationDialog.vue";
import { mediaCrossCheckHits, mediaCrossCheckLoading, type IMediaCrossCheckHit } from "./utils/crossCheck.ts";

const { t } = useI18n();

const showDetailDialog = ref(false);
const activeItem = ref<IMediaServerItem | undefined>(undefined);
const expanded = ref(true);

function openHitDetail(hit: IMediaCrossCheckHit) {
  activeItem.value = hit.item;
  showDetailDialog.value = true;
}
</script>

<template>
  <div v-if="mediaCrossCheckLoading || mediaCrossCheckHits.length > 0" class="media-cross-check">
    <div class="media-cross-check__header" @click="expanded = !expanded">
      <a-space :size="6">
        <PlayCircleOutlined class="media-cross-check__icon" />
        <strong>{{ t("SearchEntity.crossCheck.mediaBannerTitle") }}</strong>
        <a-spin v-if="mediaCrossCheckLoading" size="small" />
        <a-tag v-else color="purple">{{ mediaCrossCheckHits.length }}</a-tag>
      </a-space>
      <a-button size="small" type="link">
        {{ expanded ? t("common.collapse") : t("common.expand") }}
      </a-button>
    </div>

    <div v-if="expanded && mediaCrossCheckHits.length > 0" class="media-cross-check__items">
      <a-tag
        v-for="(hit, idx) in mediaCrossCheckHits.slice(0, 12)"
        :key="`${hit.serverId}:${hit.item.name}:${idx}`"
        color="purple"
        class="media-cross-check__chip"
        @click="openHitDetail(hit)"
      >
        <span>[{{ hit.serverName }}] {{ hit.item.name }}</span>
        <span v-if="hit.item.productionYear"> ({{ hit.item.productionYear }})</span>
        <span v-if="hit.videoQuality"> · {{ hit.videoQuality }}</span>
        <CheckCircleOutlined v-if="hit.item.user?.IsPlayed" class="media-cross-check__played" />
      </a-tag>
    </div>

    <ItemInformationDialog v-if="activeItem" v-model="showDetailDialog" :item="activeItem" />
  </div>
</template>

<style scoped>
.media-cross-check {
  margin-bottom: 8px;
  padding: 6px 10px;
  border: 1px solid var(--ptd-border);
  border-radius: var(--ptd-radius, 6px);
  background: var(--ptd-surface-soft);
}

.media-cross-check__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  cursor: pointer;
}

.media-cross-check__icon {
  color: var(--ptd-primary);
}

.media-cross-check__items {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 6px;
}

.media-cross-check__chip {
  cursor: pointer;
  margin-inline-end: 0;
}

.media-cross-check__played {
  margin-left: 4px;
  color: var(--ptd-success);
}
</style>
