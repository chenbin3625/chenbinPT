<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { EResultParseStatus } from "@ptd/site";

const { status } = defineProps<{
  status: EResultParseStatus;
}>();

const { t } = useI18n();
</script>

<template>
  <a-tag v-if="status === EResultParseStatus.unknownError" color="error">
    {{ t("resultParseStatus.unknownError") }}
  </a-tag>
  <a-tag v-else-if="status === EResultParseStatus.waiting" color="processing">
    {{ t("resultParseStatus.waiting") }}
  </a-tag>
  <a-tag v-else-if="status === EResultParseStatus.working" color="processing">
    {{ t("resultParseStatus.working") }}
  </a-tag>
  <a-tag v-else-if="status === EResultParseStatus.success" color="success">
    {{ t("resultParseStatus.success") }}
  </a-tag>
  <a-tag v-else-if="status === EResultParseStatus.parseError" color="error">
    {{ t("resultParseStatus.parseError") }}
  </a-tag>
  <a-tag v-else-if="status === EResultParseStatus.passParse" color="warning">
    {{ t("resultParseStatus.passParse") }}
  </a-tag>
  <a-tooltip v-else-if="status === EResultParseStatus.CFBlocked" :title="t('resultParseStatus.CFBlockedNotes')">
    <a-tag>{{ t("resultParseStatus.CFBlocked") }}</a-tag>
  </a-tooltip>
  <a-tag v-else-if="status === EResultParseStatus.needLogin" color="error">
    {{ t("resultParseStatus.needLogin") }}
  </a-tag>
  <a-tag v-else-if="status === EResultParseStatus.noUserInput" color="error">
    {{ t("resultParseStatus.noUserInput") }}
  </a-tag>
  <a-tag v-else-if="status === EResultParseStatus.noResults" color="error">
    {{ t("resultParseStatus.noResults") }}
  </a-tag>
  <a-tag v-else>{{ t("resultParseStatus.unknown") }}</a-tag>
</template>
