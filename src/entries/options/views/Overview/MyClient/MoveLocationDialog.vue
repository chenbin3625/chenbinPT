<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { CTorrent } from "@ptd/downloader";

import { sendMessage } from "@/messages.ts";
import { useMetadataStore } from "@/options/stores/metadata.ts";
import { useRuntimeStore } from "@/options/stores/runtime.ts";
import { batchOpColor, formatBatchOpMessage, summarizeBatchResults } from "./utils.ts";

const showDialog = defineModel<boolean>();
const props = defineProps<{
  torrents: CTorrent[];
}>();
const emit = defineEmits<{
  (e: "done", clientIds: string[]): void;
}>();

const { t } = useI18n();
const metadataStore = useMetadataStore();
const runtimeStore = useRuntimeStore();

const location = ref("");
const moveData = ref(true);
const submitting = ref(false);

const pathSuggestions = computed(() => {
  const paths = new Set<string>();
  for (const item of props.torrents) {
    if (item.savePath) paths.add(item.savePath);
    for (const folder of metadataStore.downloaders[item.clientId]?.suggestFolders ?? []) {
      if (folder) paths.add(folder);
    }
  }
  return Array.from(paths).map((value) => ({ value }));
});

watch(showDialog, (open) => {
  if (open) {
    location.value = props.torrents[0]?.savePath ?? "";
    moveData.value = true;
  }
});

async function submit() {
  const target = location.value.trim();
  if (!target || props.torrents.length === 0 || submitting.value) return;
  submitting.value = true;
  try {
    const results = await Promise.allSettled(
      props.torrents.map((item) =>
        sendMessage("setClientTorrentLocation", {
          downloaderId: item.clientId,
          id: item.id,
          location: target,
          moveData: moveData.value,
        }),
      ),
    );
    const summary = summarizeBatchResults(results);
    runtimeStore.showSnackbar(formatBatchOpMessage(t, "MyClient.moveLocation.success", summary), {
      color: batchOpColor(summary),
    });
    const clientIds = [...new Set(props.torrents.map((item) => item.clientId))];
    showDialog.value = false;
    emit("done", clientIds);
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <a-modal
    v-model:open="showDialog"
    :title="t('MyClient.moveLocation.title', { count: torrents.length })"
    :confirm-loading="submitting"
    :ok-button-props="{ disabled: !location.trim() }"
    @ok="submit"
  >
    <a-form layout="vertical">
      <a-form-item :label="t('MyClient.moveLocation.targetPath')" required>
        <a-auto-complete
          v-model:value="location"
          :options="pathSuggestions"
          :placeholder="t('MyClient.moveLocation.placeholder')"
          allow-clear
        />
      </a-form-item>
      <a-form-item>
        <a-checkbox v-model:checked="moveData">{{ t("MyClient.moveLocation.moveData") }}</a-checkbox>
      </a-form-item>
    </a-form>
  </a-modal>
</template>
