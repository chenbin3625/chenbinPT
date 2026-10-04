<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

type TDeleteId = any;

const showDialog = defineModel<boolean>();
const { toDeleteIds, confirmDelete: confirmDeleteFn } = defineProps<{
  toDeleteIds: TDeleteId[];
  confirmDelete: (toDeleteId: TDeleteId) => Promise<void> | void;
}>();
const emits = defineEmits<{
  (e: "allDelete"): void;
}>();

const { t } = useI18n();

const isDeleting = ref(false);

async function confirmDelete() {
  isDeleting.value = true;
  await Promise.allSettled(toDeleteIds.map((toDeleteId) => confirmDeleteFn(toDeleteId)));
  isDeleting.value = false;
  showDialog.value = false;
  emits("allDelete");
}

async function dialogEnter() {
  isDeleting.value = false;
}

// 原生 a-modal 没有 afterOpenChange（只有 afterClose），打开时的初始化自行监听 open。
watch(showDialog, (open) => {
  if (open) nextTick(dialogEnter);
});
</script>

<template>
  <a-modal
    v-model:open="showDialog"
    :cancel-text="t('common.dialog.cancel')"
    :confirm-loading="isDeleting"
    :keyboard="!isDeleting"
    :mask-closable="!isDeleting"
    :ok-text="t('common.dialog.ok')"
    ok-type="danger"
    :title="t('common.dialog.title.confirmAction')"
    :width="300"
    @ok="confirmDelete"
  >
    {{ t("common.dialog.deleteText", [toDeleteIds!.length]) }}
    <slot name="append-text" />
  </a-modal>
</template>
