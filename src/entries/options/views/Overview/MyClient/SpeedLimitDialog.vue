<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import type { CTorrent, TorrentSpeedLimit } from "@ptd/downloader";
import { sendMessage } from "@/messages.ts";
import { useRuntimeStore } from "@/options/stores/runtime.ts";
import { summarizeBatchResults, formatBatchOpMessage, batchOpColor } from "./utils.ts";

const showDialog = defineModel<boolean>();
const { torrents } = defineProps<{
  torrents: CTorrent[];
}>();

const emit = defineEmits<{
  (e: "done", clientIds: string[]): void;
}>();

const { t } = useI18n();
const runtimeStore = useRuntimeStore();

const uploadLimit = ref<number | null>(null);
const downloadLimit = ref<number | null>(null);
const submitting = ref(false);

function dialogEnter() {
  submitting.value = false;
  // D2-08：只在「单选」时用当前种子的限速预填。
  // 多选时预填首个种子的两个方向，确认后会把它的限速覆盖到所有种子 —— 与文案
  // 「留空表示不修改该方向」的承诺冲突；多选一律留空，用户只填想改的方向。
  const first = torrents.length === 1 ? torrents[0] : undefined;
  const raw = first?.raw as Record<string, any> | undefined;
  uploadLimit.value = typeof raw?.up_limit === "number" ? Math.round(raw.up_limit / 1024) : null;
  downloadLimit.value = typeof raw?.dl_limit === "number" ? Math.round(raw.dl_limit / 1024) : null;
}

// 原生 a-modal 没有 afterOpenChange（只有 afterClose），打开时初始化自行监听 open。
watch(showDialog, (open) => {
  if (open) nextTick(dialogEnter);
});

async function confirmSetLimit() {
  if (submitting.value) return;

  const limits: TorrentSpeedLimit = {};
  if (uploadLimit.value !== null) limits.upload = uploadLimit.value;
  if (downloadLimit.value !== null) limits.download = downloadLimit.value;
  if (Object.keys(limits).length === 0) {
    runtimeStore.showSnakebar(t("MyClient.speedLimit.emptyLimit"), { color: "warning" });
    return;
  }

  submitting.value = true;
  try {
    const results = await Promise.allSettled(
      torrents.map((torrent) =>
        sendMessage("setClientTorrentSpeedLimit", {
          downloaderId: torrent.clientId,
          id: torrent.id,
          limits,
        }),
      ),
    );
    const summary = summarizeBatchResults(results);
    runtimeStore.showSnakebar(formatBatchOpMessage(t, "MyClient.speedLimit.success", summary), {
      color: batchOpColor(summary),
    });
    showDialog.value = false;
    // D2-09：成功后立即刷新受影响下载器，不再等下一轮自动刷新
    emit("done", [...new Set(torrents.map((torrent) => torrent.clientId))]);
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <a-modal
    v-model:open="showDialog"
    :cancel-text="t('common.dialog.cancel')"
    :closable="!submitting"
    :confirm-loading="submitting"
    :keyboard="!submitting"
    :mask-closable="!submitting"
    :ok-text="t('common.dialog.ok')"
    :title="t('MyClient.speedLimit.title', { count: torrents.length })"
    :width="480"
    @ok="confirmSetLimit"
  >
    <a-typography-paragraph class="ptd-section-description">
      {{ t("MyClient.speedLimit.unitNote") }}
    </a-typography-paragraph>

    <a-form-item :label="t('MyClient.speedLimit.upload')"
      ><a-input-number v-model:value="uploadLimit" :disabled="submitting" :min="0"></a-input-number
    ></a-form-item>
    <a-form-item :label="t('MyClient.speedLimit.download')"
      ><a-input-number v-model:value="downloadLimit" :disabled="submitting" :min="0"></a-input-number
    ></a-form-item>
  </a-modal>
</template>
