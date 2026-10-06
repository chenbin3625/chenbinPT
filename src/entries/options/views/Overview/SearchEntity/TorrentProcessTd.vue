<script setup lang="ts">
import { ArrowDownOutlined, ArrowUpOutlined, CheckOutlined, DisconnectOutlined } from "@ant-design/icons-vue";
import { computed, type Component } from "vue";
import { ETorrentStatus } from "@ptd/site";

import { resolveColor } from "@/shared/colors.ts";
import { ISearchResultTorrent } from "@/shared/types.ts";

const { torrent } = defineProps<{
  torrent: ISearchResultTorrent;
}>();

const icon = computed<Component>(() => {
  switch (torrent.status) {
    case ETorrentStatus.downloading:
      return ArrowDownOutlined;

    case ETorrentStatus.completed:
      return CheckOutlined;

    case ETorrentStatus.inactive:
      return DisconnectOutlined;

    case ETorrentStatus.seeding:
    default:
      return ArrowUpOutlined;
  }
});

const color = computed(() => {
  switch (torrent.status) {
    case ETorrentStatus.downloading:
      return "info";

    case ETorrentStatus.completed:
    case ETorrentStatus.inactive:
      return "grey";

    case ETorrentStatus.seeding:
    default:
      return "success";
  }
});
</script>

<template>
  <!--
    保持图标列与进度条紧凑对齐：
    - gutter=0 避免图标列被默认间距拉宽；
    - align="middle" 让 4px 高的进度条与图标垂直居中。
  -->
  <a-row align="middle" :gutter="0" style="padding-top: 4px">
    <a-col :span="4" style="padding: 0">
      <!-- M-29：缺 :is 时渲染成未知元素 <component>，状态图标从不显示 -->
      <component :is="icon" class="ptd-icon-sm" :style="{ color: resolveColor(color) }" />
    </a-col>
    <a-col flex="1 1 0" style="padding-left: 4px">
      <a-progress :percent="torrent.progress" :show-info="false" status="active" :title="`${torrent.progress}%`" />
    </a-col>
  </a-row>
</template>
