<script setup lang="ts">
/**
 * 媒体服务器筛选器（上游 #1599 的 FilterChips，按 antd 重写）。
 *
 * 「全部」+ 每台已启用服务器一个可切换的 chip，直接平铺在工具条上（原先藏在搜索框前缀的弹出层里）。
 * v-model 为选中的服务器 id 数组；「全部」= 选中全部服务器。切换只改选择，已加载的卡片由页面即时过滤。
 */
import { CloudServerOutlined } from "@ant-design/icons-vue";
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { getMediaServerIcon } from "@ptd/mediaServer";

import { useDisplay } from "@/options/composables/useDisplay.ts";
import type { TMediaServerKey } from "@/shared/types.ts";

const { items } = defineProps<{
  items: Array<{ id: TMediaServerKey; name: string; type: string }>;
}>();

const model = defineModel<TMediaServerKey[]>({ required: true });

const { t } = useI18n();
const display = useDisplay();

const isAllSelected = computed(() => items.length > 0 && items.every((item) => model.value.includes(item.id)));

function selectAll() {
  model.value = items.map((item) => item.id);
}

function toggle(id: TMediaServerKey) {
  model.value = model.value.includes(id) ? model.value.filter((x) => x !== id) : [...model.value, id];
}
</script>

<template>
  <a-flex align="center" :gap="4" wrap="wrap" style="min-width: 0">
    <a-tooltip :title="display.smAndDown.value ? t('MediaServerEntity.serverFilter.all') : undefined">
      <a-button
        :aria-pressed="isAllSelected"
        :ghost="isAllSelected"
        :type="isAllSelected ? 'primary' : 'default'"
        size="small"
        @click="selectAll"
      >
        <template #icon><CloudServerOutlined /></template>
        <template v-if="!display.smAndDown.value">{{ t("MediaServerEntity.serverFilter.all") }}</template>
      </a-button>
    </a-tooltip>
    <a-button
      v-for="item in items"
      :key="item.id"
      :aria-pressed="model.includes(item.id)"
      :ghost="model.includes(item.id)"
      :type="model.includes(item.id) ? 'primary' : 'default'"
      size="small"
      @click="toggle(item.id)"
    >
      <a-avatar :alt="item.type" :size="16" :src="getMediaServerIcon(item.type)" style="margin-right: 4px" />
      {{ item.name }}
    </a-button>
  </a-flex>
</template>
