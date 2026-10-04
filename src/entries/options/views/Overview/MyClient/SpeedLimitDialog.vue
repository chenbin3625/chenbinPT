<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import type { CTorrent, TorrentSpeedLimit } from "@ptd/downloader";
import { sendMessage } from "@/messages.ts";
import { useRuntimeStore } from "@/options/stores/runtime.ts";

const showDialog = defineModel<boolean>();
const { torrents } = defineProps<{
  torrents: CTorrent[];
}>();

const { t } = useI18n();
const runtimeStore = useRuntimeStore();

const uploadLimit = ref<number | null>(null);
const downloadLimit = ref<number | null>(null);

function dialogEnter() {
  // 初始化为当前种子的限速（qBittorrent raw 中有 up_limit/dl_limit 字段，其他客户端留空）
  const first = torrents[0];
  const raw = first?.raw as Record<string, any> | undefined;
  uploadLimit.value = typeof raw?.up_limit === "number" ? Math.round(raw.up_limit / 1024) : null;
  downloadLimit.value = typeof raw?.dl_limit === "number" ? Math.round(raw.dl_limit / 1024) : null;
}

// 原生 a-modal 没有 afterOpenChange（只有 afterClose），打开时初始化自行监听 open。
watch(showDialog, (open) => {
  if (open) nextTick(dialogEnter);
});

async function confirmSetLimit() {
  const limits: TorrentSpeedLimit = {};
  if (uploadLimit.value !== null) limits.upload = uploadLimit.value;
  if (downloadLimit.value !== null) limits.download = downloadLimit.value;
  if (Object.keys(limits).length === 0) {
    runtimeStore.showSnakebar(t("MyClient.speedLimit.emptyLimit"), { color: "warning" });
    return;
  }

  const results = await Promise.allSettled(
    torrents.map((torrent) =>
      sendMessage("setClientTorrentSpeedLimit", {
        downloaderId: torrent.clientId,
        id: torrent.id,
        limits,
      }),
    ),
  );
  const succeeded = results.filter((r) => r.status === "fulfilled" && Boolean(r.value)).length;
  runtimeStore.showSnakebar(t("MyClient.speedLimit.success", { count: succeeded }), {
    color: succeeded > 0 ? "success" : "error",
  });
  showDialog.value = false;
}
</script>

<template>
  <a-modal
    v-model:open="showDialog"
    :cancel-text="t('common.dialog.cancel')"
    :ok-text="t('common.dialog.ok')"
    :title="t('MyClient.speedLimit.title', { count: torrents.length })"
    :width="480"
    @ok="confirmSetLimit"
  >
    <a-typography-paragraph class="ptd-section-description">
      {{ t("MyClient.speedLimit.unitNote") }}
    </a-typography-paragraph>

    <a-form-item :label="t('MyClient.speedLimit.upload')"
      ><a-input-number v-model:value="uploadLimit" :min="0"></a-input-number
    ></a-form-item>
    <a-form-item :label="t('MyClient.speedLimit.download')"
      ><a-input-number v-model:value="downloadLimit" :min="0"></a-input-number
    ></a-form-item>
  </a-modal>
</template>
