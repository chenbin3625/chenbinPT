<script setup lang="ts">
import { ArrowLeftOutlined, EyeInvisibleOutlined, EyeOutlined, KeyOutlined } from "@ant-design/icons-vue";
import { useThrottledRefHistory } from "@vueuse/core";
import { nanoid } from "nanoid";
import { ref, shallowRef, watch } from "vue";
import { useI18n } from "vue-i18n";

import { resolveColor } from "@/shared/colors.ts";

import { useSetBaseConfigDraft } from "./configDraft.ts";

const { t } = useI18n();
const config = useSetBaseConfigDraft();

const showEncryptionKey = ref<boolean>(false);
// F2-N1：输入框绑定本地草稿（含撤销历史），不再逐键写回 configStore。
// 只有点 SetBase 的「保存」才会经 Index.vue 的草稿合并写回 store 并落盘；
// 这样其它页面任何一次 `$save()`（如表格排序）都不会把用户没确认的新密钥静默写进 storage。
const encryptionKey = shallowRef<string>(config.value.backup.encryptionKey);
const { history, undo: undoEncryptionKey } = useThrottledRefHistory(encryptionKey, { throttle: 50 });
watch(encryptionKey, (newValue) => {
  config.value.backup.encryptionKey = newValue;
});

function randomEncryptionKey() {
  encryptionKey.value = nanoid();
}
</script>

<template>
  <div class="ptd-settings-grid">
    <section class="ptd-settings-section">
      <a-typography-text strong style="display: block; margin: 8px 0">
        {{ t("ptppSettings.basicConfig") }}
      </a-typography-text>
      <a-alert style="margin-bottom: 8px" type="info" show-icon :message="t('ptppSettings.saveKeyNotice')" />
      <div class="ptd-settings-row">
        <a-typography-text>{{ t("ptppSettings.encryptionKeyLabel") }}</a-typography-text>
        <a-flex align="center" :gap="4" style="width: min(100%, 420px)">
          <a-input v-model:value="encryptionKey" :type="showEncryptionKey ? 'text' : 'password'" style="flex: 1 1 auto">
            <template #suffix>
              <EyeOutlined v-if="showEncryptionKey" style="cursor: pointer" @click="showEncryptionKey = false" />
              <EyeInvisibleOutlined v-else style="cursor: pointer" @click="showEncryptionKey = true" />
            </template>
          </a-input>
          <a-tooltip :title="t('ptppSettings.undoKeyTitle')">
            <a-button :disabled="history.length <= 1" shape="circle" type="text" @click="undoEncryptionKey">
              <a-badge v-if="history.length > 1" :count="history.length - 1" :overflow-count="9">
                <ArrowLeftOutlined :style="{ color: resolveColor('green') }" />
              </a-badge>
              <ArrowLeftOutlined v-else />
            </a-button>
          </a-tooltip>
          <a-tooltip :title="t('ptppSettings.randomGenTitle')">
            <a-button shape="circle" type="text" @click="randomEncryptionKey">
              <template #icon>
                <KeyOutlined />
              </template>
            </a-button>
          </a-tooltip>
        </a-flex>
      </div>
    </section>
  </div>
</template>
