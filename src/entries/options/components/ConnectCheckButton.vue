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

let resetTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * OPTIONSSHELL-8：失败指示必须安排复位。
 * 原先只有 catch 分支（抛错）调度 setTimeout，而更常见的失败形态是 checkFn 解析为 false
 * （表单校验不过 / client.ping() 返回 false），这条路径会让红色断连图标永久停留。
 * 另外每次检查开始先清掉上一轮的待复位定时器，避免「先失败后重试成功」被旧定时器改回 default。
 */
function scheduleStatusReset() {
  if (!resetTimeout) return;
  clearTimeout(resetTimer);
  resetTimer = setTimeout(() => {
    resetTimer = undefined;
    connectStatusRef.value = connectStatus.default;
  }, resetTimeout);
}

async function checkConnect() {
  clearTimeout(resetTimer);
  resetTimer = undefined;
  isTestingConnectRef.value = true;
  try {
    const isConnected = await checkFn();
    connectStatusRef.value = isConnected ? connectStatus.success : connectStatus.error;
    if (!isConnected) scheduleStatusReset();
  } catch (e) {
    connectStatusRef.value = connectStatus.error;
    scheduleStatusReset();
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
