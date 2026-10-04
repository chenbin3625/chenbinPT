<script setup lang="ts">
import { ref, type Component } from "vue";
import { useI18n } from "vue-i18n";
import { CheckCircleOutlined, DisconnectOutlined, WifiOutlined } from "@ant-design/icons-vue";

import { resolveColor } from "@/shared/colors.ts";

const { checkFn, resetTimeout } = defineProps<{
  checkFn: () => Promise<boolean>;
  resetTimeout?: number;
}>();
const emits = defineEmits<{
  (e: "after:checkConnect"): void;
}>();

const { t } = useI18n();

enum connectStatus {
  default = "default",
  success = "success",
  error = "error",
}

const connectBtnMap: Record<connectStatus, { icon: Component; color: string | undefined }> = {
  [connectStatus.default]: { icon: WifiOutlined, color: resolveColor("info") },
  [connectStatus.success]: { icon: CheckCircleOutlined, color: resolveColor("success") },
  [connectStatus.error]: { icon: DisconnectOutlined, color: resolveColor("error") },
};

const isTestingConnectRef = ref<boolean>(false);
const connectStatusRef = ref<connectStatus>(connectStatus.default);

async function checkConnect() {
  isTestingConnectRef.value = true;
  try {
    connectStatusRef.value = (await checkFn()) ? connectStatus.success : connectStatus.error;
  } catch (e) {
    connectStatusRef.value = connectStatus.error;
    if (resetTimeout) {
      setTimeout(() => (connectStatusRef.value = connectStatus.default), resetTimeout);
    }
  } finally {
    isTestingConnectRef.value = false;
    emits("after:checkConnect");
  }
}
</script>

<template>
  <a-button
    :disabled="isTestingConnectRef"
    :loading="isTestingConnectRef"
    :style="{ color: connectBtnMap[connectStatusRef].color }"
    block
    type="text"
    @click="checkConnect"
  >
    <template #icon>
      <component :is="connectBtnMap[connectStatusRef].icon" />
    </template>
    {{ t("connectCheck." + connectStatusRef) }}
  </a-button>
</template>
