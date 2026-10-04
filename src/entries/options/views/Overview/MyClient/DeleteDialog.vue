<script setup lang="ts">
import { ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import BaseDeleteDialog from "@/options/components/DeleteDialog.vue";

const showDialog = defineModel<boolean>();
const props = defineProps<{
  toDeleteIds: string[];
  confirmDelete: (toDeleteId: string, removeData: boolean) => Promise<void> | void;
}>();
const emits = defineEmits<{
  (e: "allDelete"): void;
}>();

const { t } = useI18n();

const removeData = ref(false);

watch(showDialog, (val) => {
  if (val) removeData.value = false;
});

function wrappedConfirmDelete(id: string) {
  return props.confirmDelete(id, removeData.value);
}
</script>

<template>
  <BaseDeleteDialog
    v-model="showDialog"
    :to-delete-ids="toDeleteIds"
    :confirm-delete="wrappedConfirmDelete"
    @all-delete="emits('allDelete')"
  >
    <template #append-text>
      <a-checkbox v-model:checked="removeData">{{ t("MyClient.dialog.removeData") }}</a-checkbox>
    </template>
  </BaseDeleteDialog>
</template>
