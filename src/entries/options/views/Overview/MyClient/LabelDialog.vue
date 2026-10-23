<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import type { CTorrent } from "@ptd/downloader";
import { sendMessage } from "@/messages.ts";
import { useRuntimeStore } from "@/options/stores/runtime.ts";
import { summarizeBatchResults, formatBatchOpMessage, batchOpColor } from "./utils.ts";

const showDialog = defineModel<boolean>();
const { torrents, suggestLabels } = defineProps<{
  torrents: CTorrent[];
  suggestLabels?: string[];
}>();

const emit = defineEmits<{
  (e: "done", clientIds: string[]): void;
}>();

const { t } = useI18n();
const runtimeStore = useRuntimeStore();

const labelInput = ref<string>("");
const submitting = ref(false);

function dialogEnter() {
  submitting.value = false;
  // 只在单选时用当前种子的标签预填；多选预填首个种子的标签会让「确认」把它的标签覆盖到全部种子，
  // 与批量限速（D2-08）是同一类误操作。
  const first = torrents.length === 1 ? torrents[0] : undefined;
  labelInput.value = first?.label ?? "";
}

// 原生 a-modal 没有 afterOpenChange（只有 afterClose），打开时初始化自行监听 open。
watch(showDialog, (open) => {
  if (open) nextTick(dialogEnter);
});

async function confirmSetLabel() {
  if (submitting.value) return;

  const label = labelInput.value.trim();
  if (!label) {
    runtimeStore.showSnakebar(t("MyClient.label.emptyLabel"), { color: "warning" });
    return;
  }

  submitting.value = true;
  try {
    const results = await Promise.allSettled(
      torrents.map((torrent) =>
        sendMessage("setClientTorrentLabel", {
          downloaderId: torrent.clientId,
          id: torrent.id,
          label,
        }),
      ),
    );
    const summary = summarizeBatchResults(results);
    runtimeStore.showSnakebar(formatBatchOpMessage(t, "MyClient.label.success", summary), {
      color: batchOpColor(summary),
    });
    showDialog.value = false;
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
    :title="t('MyClient.label.title', { count: torrents.length })"
    :width="480"
    @ok="confirmSetLabel"
  >
    <a-form-item :label="t('MyClient.label.input')">
      <a-auto-complete
        v-model:value="labelInput"
        :disabled="submitting"
        :options="(suggestLabels ?? []).map((label) => ({ value: label, label }))"
        allow-clear
      />
    </a-form-item>
  </a-modal>
</template>
