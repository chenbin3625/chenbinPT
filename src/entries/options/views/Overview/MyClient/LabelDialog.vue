<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import type { CTorrent } from "@ptd/downloader";
import { sendMessage } from "@/messages.ts";
import { useRuntimeStore } from "@/options/stores/runtime.ts";

const showDialog = defineModel<boolean>();
const { torrents, suggestLabels } = defineProps<{
  torrents: CTorrent[];
  suggestLabels?: string[];
}>();

const { t } = useI18n();
const runtimeStore = useRuntimeStore();

const labelInput = ref<string>("");

function dialogEnter() {
  // 初始化为当前种子的标签（如果有的话）
  const first = torrents[0];
  labelInput.value = first?.label ?? "";
}

// 原生 a-modal 没有 afterOpenChange（只有 afterClose），打开时初始化自行监听 open。
watch(showDialog, (open) => {
  if (open) nextTick(dialogEnter);
});

async function confirmSetLabel() {
  const label = labelInput.value.trim();
  if (!label) {
    runtimeStore.showSnakebar(t("MyClient.label.emptyLabel"), { color: "warning" });
    return;
  }

  const results = await Promise.allSettled(
    torrents.map((torrent) =>
      sendMessage("setClientTorrentLabel", {
        downloaderId: torrent.clientId,
        id: torrent.id,
        label,
      }),
    ),
  );
  const succeeded = results.filter((r) => r.status === "fulfilled" && Boolean(r.value)).length;
  runtimeStore.showSnakebar(t("MyClient.label.success", { count: succeeded }), {
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
    :title="t('MyClient.label.title', { count: torrents.length })"
    :width="480"
    @ok="confirmSetLabel"
  >
    <a-form-item :label="t('MyClient.label.input')">
      <a-auto-complete
        v-model:value="labelInput"
        :options="(suggestLabels ?? []).map((label) => ({ value: label, label }))"
        allow-clear
      />
    </a-form-item>
  </a-modal>
</template>
