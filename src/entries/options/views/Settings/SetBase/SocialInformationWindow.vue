<script setup lang="ts">
import { buildInPtGenApi } from "@ptd/social";
import { computed, ref } from "vue";
import { EyeInvisibleOutlined, EyeOutlined } from "@ant-design/icons-vue";

import { useConfigStore } from "@/options/stores/config.ts";

import { useI18n } from "vue-i18n";

const { t } = useI18n();
const configStore = useConfigStore();

// B-31：Bangumi API Key 是可代表用户调用 API 的凭据，默认掩码显示（与 BackupWindow 的加密密钥一致）
const showBangumiApiKey = ref<boolean>(false);

const ptGenApiOptions = computed(() => buildInPtGenApi.map((item) => ({ label: item.provider, value: item.url })));

function filterPtGenApi(input: string, option: { label?: string; value?: string }) {
  const text = `${option?.label ?? ""} ${option?.value ?? ""}`.toUpperCase();
  return text.includes(String(input).toUpperCase());
}
</script>

<template>
  <div class="ptd-settings-grid">
    <section class="ptd-settings-section">
      <a-typography-text strong style="display: block; margin-bottom: 4px">
        {{ t("socialConfig.basicConfig") }}
      </a-typography-text>
      <div class="ptd-settings-row">
        <a-typography-text>{{ t("socialConfig.cacheValidityDays") }}</a-typography-text>
        <a-input-number
          v-model:value="configStore.socialSiteInformation.cacheDay"
          :min="3"
          style="width: min(100%, 420px)"
        />
      </div>
      <div style="text-align: end">
        <a-typography-text type="secondary">{{ t("socialConfig.cacheShortWarning") }}</a-typography-text>
      </div>
      <div class="ptd-settings-row">
        <a-typography-text>{{ t("socialConfig.requestTimeoutMs") }}</a-typography-text>
        <a-input-number v-model:value="configStore.socialSiteInformation.timeout" style="width: min(100%, 420px)" />
      </div>
    </section>

    <section class="ptd-settings-section">
      <a-typography-text strong style="display: block; margin-bottom: 4px">
        {{ t("socialConfig.ptgenConfig") }}
      </a-typography-text>
      <div class="ptd-settings-row">
        <a-typography-text>{{ t("socialConfig.preferPtgenLabel") }}</a-typography-text>
        <a-switch v-model:checked="configStore.socialSiteInformation.preferPtGen" />
      </div>
      <template v-if="configStore.socialSiteInformation.preferPtGen">
        <div class="ptd-settings-row">
          <a-typography-text>{{ t("socialConfig.ptgenApiAddress") }}</a-typography-text>
          <a-auto-complete
            v-model:value="configStore.socialSiteInformation.ptGenEndpoint"
            :filter-option="filterPtGenApi"
            :options="ptGenApiOptions"
            style="width: min(100%, 420px)"
          />
        </div>
        <div style="text-align: end">
          <a-typography-text type="secondary">{{ t("socialConfig.ptgenApiMessages") }}</a-typography-text>
        </div>
      </template>
    </section>

    <section class="ptd-settings-section">
      <a-typography-text strong style="display: block; margin-bottom: 4px">
        {{ t("socialConfig.mediaRatingConfig") }}
      </a-typography-text>
      <div class="ptd-settings-row">
        <a-typography-text>{{ t("socialConfig.anidbClientId") }}</a-typography-text>
        <a-input
          v-model:value="configStore.socialSiteInformation.socialSite!.anidb.client"
          allow-clear
          style="width: min(100%, 420px)"
        >
          <template #prefix>
            <a-avatar :size="20" shape="square" src="/icons/social/anidb.png" />
          </template>
        </a-input>
      </div>
      <div style="text-align: end">
        <a-typography-text type="secondary">{{ t("socialConfig.anidbClientMessages") }}</a-typography-text>
      </div>

      <div class="ptd-settings-row">
        <a-typography-text>{{ t("socialConfig.bangumiApiKey") }}</a-typography-text>
        <a-input
          v-model:value="configStore.socialSiteInformation.socialSite!.bangumi.apikey"
          allow-clear
          style="width: min(100%, 420px)"
          :type="showBangumiApiKey ? 'text' : 'password'"
        >
          <template #prefix>
            <a-avatar :size="20" shape="square" src="/icons/social/bangumi.png" />
          </template>
          <template #suffix>
            <EyeOutlined v-if="showBangumiApiKey" style="cursor: pointer" @click="showBangumiApiKey = false" />
            <EyeInvisibleOutlined v-else style="cursor: pointer" @click="showBangumiApiKey = true" />
          </template>
        </a-input>
      </div>
      <div style="text-align: end">
        <a-typography-text type="secondary">{{ t("socialConfig.bangumiApiMessages") }}</a-typography-text>
      </div>
    </section>
  </div>
</template>
