<script setup lang="ts">
import {
  ClockCircleOutlined,
  ExclamationCircleOutlined,
  PauseOutlined,
  QuestionCircleOutlined,
  SyncOutlined,
  UploadOutlined,
  DownloadOutlined,
} from "@ant-design/icons-vue";
import type { Component } from "vue";
import { useI18n } from "vue-i18n";

import { type CTorrent, CTorrentState } from "@ptd/downloader";

const { item } = defineProps<{
  item: CTorrent;
}>();

const { t } = useI18n();

// ── state chip display map ────────────────────────────────────────────────
const stateDisplay: Record<CTorrentState, { color: string; icon: Component; label: string }> = {
  [CTorrentState.downloading]: { color: "blue", icon: DownloadOutlined, label: "MyClient.state.downloading" },
  [CTorrentState.seeding]: { color: "green", icon: UploadOutlined, label: "MyClient.state.seeding" },
  [CTorrentState.paused]: { color: "grey", icon: PauseOutlined, label: "MyClient.state.paused" },
  [CTorrentState.queued]: { color: "orange", icon: ClockCircleOutlined, label: "MyClient.state.queued" },
  [CTorrentState.checking]: { color: "cyan", icon: SyncOutlined, label: "MyClient.state.checking" },
  [CTorrentState.error]: { color: "red", icon: ExclamationCircleOutlined, label: "MyClient.state.error" },
  [CTorrentState.unknown]: { color: "grey", icon: QuestionCircleOutlined, label: "MyClient.state.unknown" },
};
</script>

<template>
  <a-tag
    ><component :is="stateDisplay[item.state]?.icon" style="margin-right: 4px" />
    {{ t(stateDisplay[item.state]?.label ?? "MyClient.state.unknown") }}
  </a-tag>
</template>
