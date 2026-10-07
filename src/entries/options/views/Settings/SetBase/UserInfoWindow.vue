<script setup lang="ts">
import { ReloadOutlined } from "@ant-design/icons-vue";
import dayjs, { type Dayjs } from "dayjs";
import { range } from "es-toolkit";
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";

import { EJobType } from "@/background/utils/alarms.ts";
import { useConfigStore } from "@/options/stores/config.ts";
import { useMetadataStore } from "@/options/stores/metadata.ts";
import { formatDate } from "@/options/utils.ts";

const { t } = useI18n();
const configStore = useConfigStore();
const metadataStore = useMetadataStore();

const nextFlushUserInfoAt = ref<number>(0);

const afterTimeValue = computed<Dayjs | undefined>({
  get() {
    const value = configStore.userInfo.autoReflush.afterTime;
    return value ? dayjs(value, "HH:mm") : undefined;
  },
  set(value) {
    configStore.userInfo.autoReflush.afterTime = value ? value.format("HH:mm") : "";
  },
});

function rangeOptions(start: number, end: number) {
  return range(start, end).map((value) => ({ label: String(value), value }));
}

async function getNextFlushUserInfoAt() {
  const alarm = await chrome.alarms.get(EJobType.FlushUserInfo);
  if (alarm) {
    nextFlushUserInfoAt.value = alarm.scheduledTime;
  }
}

async function save() {
  if (configStore.userInfo.autoReflush.enabled) {
    // noinspection ES6MissingAwait
    getNextFlushUserInfoAt();
  } else {
    nextFlushUserInfoAt.value = 0;
  }
}

defineExpose({
  afterSave: save,
});

onMounted(async () => {
  // noinspection ES6MissingAwait
  getNextFlushUserInfoAt();
});
</script>

<template>
  <div class="ptd-settings-grid">
    <section class="ptd-settings-section">
      <a-typography-text strong style="display: block; margin-bottom: 4px">
        {{ t("SetBase.userInfo.userDataRefresh") }}
      </a-typography-text>

      <div class="ptd-settings-row">
        <a-typography-text>{{ t("userInfo.queueConcurrency") }}</a-typography-text>
        <a-input-number
          v-model:value="configStore.userInfo.queueConcurrency"
          :max="25"
          :min="1"
          style="width: min(100%, 420px)"
        />
      </div>

      <div class="ptd-settings-row">
        <a-typography-text>{{ t("userInfo.alwaysPickLastUserInfo") }}</a-typography-text>
        <a-switch v-model:checked="configStore.userInfo.alwaysPickLastUserInfo" />
      </div>

      <!-- 自动刷新 -->
      <div class="ptd-settings-row">
        <a-typography-text>{{ t("userInfo.enableAutoRefresh") }}</a-typography-text>
        <a-switch v-model:checked="configStore.userInfo.autoReflush.enabled" />
      </div>
      <div v-if="configStore.userInfo.autoReflush.enabled" class="ptd-setting-note">
        <a-flex align="center" :gap="8" style="white-space: nowrap; margin-bottom: 8px">
          <span>• {{ t("SetBase.userInfo.afterTime") }}</span>
          <a-time-picker v-model:value="afterTimeValue" format="HH:mm" />
          <!-- OPTIONSSETTINGS-7：原先这里硬编码中文「后，」，英文界面会渲染成中英混排；
               改用 SetBase.userInfo.afterTimeSuffix（键由 extends-i18n 包补进两个语言包，见 cross_package_needs） -->
          <span>{{ t("SetBase.userInfo.afterTimeSuffix") }}{{ t("userInfo.autoRefresh.every") }}</span>
          <a-select
            v-model:value="configStore.userInfo.autoReflush.interval"
            :options="rangeOptions(1, 24)"
            style="width: 88px"
          />
          <span>{{ t("userInfo.autoRefresh.hoursLabel") }}</span>
          <strong>{{ t("userInfo.autoRefresh.unrefreshedSite") }}</strong>
          <span>{{ t("userInfo.autoRefresh.ofSites") }}</span>
        </a-flex>
        <a-flex align="center" :gap="8" style="white-space: nowrap">
          <span>• {{ t("userInfo.autoRefresh.retryOnFail") }}</span>
          <a-select
            v-model:value="configStore.userInfo.autoReflush.retry.max"
            :options="rangeOptions(0, 6)"
            style="width: 88px"
          />
          <span>{{ t("userInfo.autoRefresh.times") }}</span>
          <a-select
            v-model:value="configStore.userInfo.autoReflush.retry.interval"
            :options="rangeOptions(1, 11)"
            style="width: 88px"
          />
          <span>{{ t("userInfo.autoRefresh.minutes") }}</span>
        </a-flex>
        <a-flex align="center" justify="flex-end" style="margin-top: 4px">
          <span>
            {{ t("userInfo.autoRefresh.lastFlushTime") }}
            {{ formatDate(metadataStore.lastUserInfoAutoFlushAt) }} &nbsp;
            {{ t("userInfo.autoRefresh.nextFlushTime") }}
            {{ nextFlushUserInfoAt != 0 ? formatDate(nextFlushUserInfoAt) : "-" }}
          </span>
          <a-tooltip :title="t('userInfo.autoRefresh.getNextFlushTime')">
            <a-button shape="circle" size="small" style="margin-left: 4px" type="text" @click="getNextFlushUserInfoAt">
              <template #icon>
                <ReloadOutlined />
              </template>
            </a-button>
          </a-tooltip>
        </a-flex>
      </div>
    </section>

    <section class="ptd-settings-section">
      <!-- 自动延长cookies -->
      <div class="ptd-settings-row">
        <a-typography-text>{{ t("userInfo.autoExtendCookies.enabled") }}</a-typography-text>
        <a-switch v-model:checked="configStore.autoExtendCookies.enabled" />
      </div>
      <div v-if="configStore.autoExtendCookies.enabled" class="ptd-setting-note">
        <a-flex align="center" :gap="8" style="white-space: nowrap">
          <span>{{ t("userInfo.autoExtendCookies.triggerThreshold") }}:</span>
          <a-select
            v-model:value="configStore.autoExtendCookies.triggerThreshold"
            :options="rangeOptions(1, 4)"
            style="width: 88px"
          />
          <span>{{ t("userInfo.autoExtendCookies.weeks") }}</span>
          <span>{{ t("userInfo.autoExtendCookies.extensionDuration") }}:</span>
          <a-select
            v-model:value="configStore.autoExtendCookies.extensionDuration"
            :options="rangeOptions(1, 13)"
            style="width: 88px"
          />
          <span>{{ t("userInfo.autoExtendCookies.months") }}</span>
        </a-flex>
      </div>
    </section>

    <section class="ptd-settings-section">
      <a-typography-text strong style="display: block; margin-bottom: 4px">
        {{ t("SetBase.userInfo.userInfoDisplay") }}
      </a-typography-text>

      <div class="ptd-settings-row">
        <a-typography-text>{{ t("userInfo.showDeadSite") }}</a-typography-text>
        <a-switch v-model:checked="configStore.userInfo.showDeadSiteInOverview" />
      </div>
      <div class="ptd-settings-row">
        <a-typography-text>{{ t("userInfo.showPassedSite") }}</a-typography-text>
        <a-switch v-model:checked="configStore.userInfo.showPassedSiteInOverview" />
      </div>
    </section>
  </div>
</template>
