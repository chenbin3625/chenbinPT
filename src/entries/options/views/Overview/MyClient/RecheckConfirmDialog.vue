<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

const showDialog = defineModel<boolean>();
const { torrentCount, confirmFn } = defineProps<{
  torrentCount: number;
  confirmFn: () => Promise<void> | void;
}>();

const { t } = useI18n();

const isRechecking = ref(false);

async function confirmRecheck() {
  isRechecking.value = true;
  try {
    await confirmFn();
  } finally {
    isRechecking.value = false;
    showDialog.value = false;
  }
}

function dialogEnter() {
  isRechecking.value = false;
}

// 原生 a-modal 没有 afterOpenChange（只有 afterClose），打开时初始化自行监听 open。
watch(showDialog, (open) => {
  if (open) nextTick(dialogEnter);
});
</script>

<template>
  <a-modal
    v-model:open="showDialog"
    :cancel-text="t('common.dialog.cancel')"
    :confirm-loading="isRechecking"
    :keyboard="!isRechecking"
    :mask-closable="!isRechecking"
    :ok-text="t('common.dialog.ok')"
    :title="t('MyClient.recheckDialog.title')"
    :width="420"
    @ok="confirmRecheck"
  >
    <div style="font-size: 16px">
      {{ t("MyClient.recheckDialog.text", { count: torrentCount }) }}
    </div>
  </a-modal>
</template>
