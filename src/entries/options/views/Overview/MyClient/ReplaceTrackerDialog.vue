<script setup lang="ts">
import { ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { CTorrent } from "@ptd/downloader";

import { sendMessage } from "@/messages.ts";
import { useRuntimeStore } from "@/options/stores/runtime.ts";

const showDialog = defineModel<boolean>();
const props = defineProps<{
  torrents: CTorrent[];
}>();
const emit = defineEmits<{
  (e: "done", clientIds: string[]): void;
}>();

const { t } = useI18n();
const runtimeStore = useRuntimeStore();

const searchText = ref("");
const replaceText = ref("");
const submitting = ref(false);

watch(showDialog, (open) => {
  if (open) {
    searchText.value = "";
    replaceText.value = "";
  }
});

async function submit() {
  const search = searchText.value.trim();
  if (!search || props.torrents.length === 0 || submitting.value) return;
  submitting.value = true;
  try {
    let affectedTorrents = 0;
    let totalReplaced = 0;
    let failedTorrents = 0;

    const results = await Promise.allSettled(
      props.torrents.map((torrent) =>
        sendMessage("replaceClientTorrentTracker", {
          downloaderId: torrent.clientId,
          torrent,
          search,
          replacement: replaceText.value,
        }),
      ),
    );

    for (const res of results) {
      if (res.status === "fulfilled") {
        if (res.value.replaced > 0) {
          affectedTorrents += 1;
          totalReplaced += res.value.replaced;
        }
      } else {
        failedTorrents += 1;
      }
    }

    runtimeStore.showSnackbar(
      t("MyClient.replaceTracker.result", {
        torrents: affectedTorrents,
        trackers: totalReplaced,
        failed: failedTorrents,
      }),
      { color: failedTorrents > 0 ? "warning" : totalReplaced > 0 ? "success" : "info" },
    );

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
    :title="t('MyClient.replaceTracker.title', { count: torrents.length })"
    :confirm-loading="submitting"
    :ok-button-props="{ disabled: !searchText.trim() }"
    @ok="submit"
  >
    <a-alert type="info" show-icon :message="t('MyClient.replaceTracker.hint')" class="replace-tracker__alert" />
    <a-form layout="vertical">
      <a-form-item :label="t('MyClient.replaceTracker.searchLabel')" required>
        <a-input v-model:value="searchText" :placeholder="t('MyClient.replaceTracker.searchPlaceholder')" allow-clear />
      </a-form-item>
      <a-form-item :label="t('MyClient.replaceTracker.replaceLabel')">
        <a-input
          v-model:value="replaceText"
          :placeholder="t('MyClient.replaceTracker.replacePlaceholder')"
          allow-clear
        />
      </a-form-item>
    </a-form>
  </a-modal>
</template>

<style scoped>
.replace-tracker__alert {
  margin-bottom: 12px;
}
</style>
