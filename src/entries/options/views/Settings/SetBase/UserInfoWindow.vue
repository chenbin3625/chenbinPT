<script setup lang="ts">
import { ReloadOutlined } from "@ant-design/icons-vue";
import dayjs, { type Dayjs } from "dayjs";
import { range } from "es-toolkit";
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";

import { EJobType } from "@/shared/types/jobs.ts";
import { sendMessage } from "@/messages.ts";
import { useMetadataStore } from "@/options/stores/metadata.ts";
import { useRuntimeStore } from "@/options/stores/runtime.ts";
import { formatDate } from "@/options/utils.ts";

import { useSetBaseConfigDraft } from "./configDraft.ts";

const { t } = useI18n();
const config = useSetBaseConfigDraft();
const metadataStore = useMetadataStore();
const runtimeStore = useRuntimeStore();

const testingWebhook = ref(false);
const webhookTypeOptions = computed(() => [
  { label: t("SetBase.userInfo.alerts.webhookTypes.none"), value: "none" },
  { label: t("SetBase.userInfo.alerts.webhookTypes.generic"), value: "generic" },
  { label: t("SetBase.userInfo.alerts.webhookTypes.telegram"), value: "telegram" },
  { label: t("SetBase.userInfo.alerts.webhookTypes.bark"), value: "bark" },
]);

async function testWebhook() {
  if (testingWebhook.value) return;
  testingWebhook.value = true;
  try {
    const res = await sendMessage("sendAlertWebhook", {
      title: "chenbinPT 测试通知",
      message: t("SetBase.userInfo.alerts.webhookTestBody"),
      webhook: config.value.alerts.webhook,
    });
    if (res.ok) {
      runtimeStore.showSnackbar(t("SetBase.userInfo.alerts.webhookTestSuccess"), { color: "success" });
    } else {
      runtimeStore.showSnackbar(
        t("SetBase.userInfo.alerts.webhookTestFailed", { error: res.error || "Unknown error" }),
        { color: "error" },
      );
    }
  } catch (e) {
    runtimeStore.showSnackbar(
      t("SetBase.userInfo.alerts.webhookTestFailed", { error: e instanceof Error ? e.message : String(e) }),
      { color: "error" },
    );
  } finally {
    testingWebhook.value = false;
  }
}

const nextFlushUserInfoAt = ref<number>(0);

const afterTimeValue = computed<Dayjs | undefined>({
  get() {
    const value = config.value.userInfo.autoReflush.afterTime;
    return value ? dayjs(value, "HH:mm") : undefined;
  },
  set(value) {
    config.value.userInfo.autoReflush.afterTime = value ? value.format("HH:mm") : "";
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
  if (config.value.userInfo.autoReflush.enabled) {
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
          v-model:value="config.userInfo.queueConcurrency"
          :max="25"
          :min="1"
          style="width: min(100%, 420px)"
        />
      </div>

      <div class="ptd-settings-row">
        <a-typography-text>{{ t("userInfo.alwaysPickLastUserInfo") }}</a-typography-text>
        <a-switch v-model:checked="config.userInfo.alwaysPickLastUserInfo" />
      </div>

      <!-- 自动刷新 -->
      <div class="ptd-settings-row">
        <a-typography-text>{{ t("userInfo.enableAutoRefresh") }}</a-typography-text>
        <a-switch v-model:checked="config.userInfo.autoReflush.enabled" />
      </div>
      <div v-if="config.userInfo.autoReflush.enabled" class="ptd-setting-note">
        <a-flex align="center" :gap="8" style="white-space: nowrap; margin-bottom: 8px">
          <span>• {{ t("SetBase.userInfo.afterTime") }}</span>
          <a-time-picker v-model:value="afterTimeValue" format="HH:mm" />
          <!-- OPTIONSSETTINGS-7：原先这里硬编码中文「后，」，英文界面会渲染成中英混排；
               改用 SetBase.userInfo.afterTimeSuffix（键由 extends-i18n 包补进两个语言包，见 cross_package_needs） -->
          <span>{{ t("SetBase.userInfo.afterTimeSuffix") }}{{ t("userInfo.autoRefresh.every") }}</span>
          <a-select
            v-model:value="config.userInfo.autoReflush.interval"
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
            v-model:value="config.userInfo.autoReflush.retry.max"
            :options="rangeOptions(0, 6)"
            style="width: 88px"
          />
          <span>{{ t("userInfo.autoRefresh.times") }}</span>
          <a-select
            v-model:value="config.userInfo.autoReflush.retry.interval"
            :options="rangeOptions(1, 11)"
            style="width: 88px"
          />
          <span>{{ t("userInfo.autoRefresh.minutes") }}</span>
        </a-flex>
        <a-flex align="center" justify="flex-end" style="margin-top: 4px">
          <span>
            {{ t("userInfo.autoRefresh.lastFlushTime") }}
            {{ metadataStore.lastUserInfoAutoFlushAt > 0 ? formatDate(metadataStore.lastUserInfoAutoFlushAt) : "-" }}
            &nbsp;
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
        <a-switch v-model:checked="config.autoExtendCookies.enabled" />
      </div>
      <div v-if="config.autoExtendCookies.enabled" class="ptd-setting-note">
        <a-flex align="center" :gap="8" style="white-space: nowrap">
          <span>{{ t("userInfo.autoExtendCookies.triggerThreshold") }}:</span>
          <a-select
            v-model:value="config.autoExtendCookies.triggerThreshold"
            :options="rangeOptions(1, 4)"
            style="width: 88px"
          />
          <span>{{ t("userInfo.autoExtendCookies.weeks") }}</span>
          <span>{{ t("userInfo.autoExtendCookies.extensionDuration") }}:</span>
          <a-select
            v-model:value="config.autoExtendCookies.extensionDuration"
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
        <a-switch v-model:checked="config.userInfo.showDeadSiteInOverview" />
      </div>
      <div class="ptd-settings-row">
        <a-typography-text>{{ t("userInfo.showPassedSite") }}</a-typography-text>
        <a-switch v-model:checked="config.userInfo.showPassedSiteInOverview" />
      </div>
    </section>

    <!-- 账号健康监控、保号倒计时与主动通知中心 -->
    <section class="ptd-settings-section">
      <div class="ptd-settings-row ptd-settings-row--title">
        <a-typography-text strong>{{ t("SetBase.userInfo.alerts.title") }}</a-typography-text>
        <a-switch v-model:checked="config.alerts.enabled" />
      </div>

      <template v-if="config.alerts.enabled">
        <div class="ptd-settings-row">
          <a-typography-text>{{ t("SetBase.userInfo.alerts.notifyUnreadMessage") }}</a-typography-text>
          <a-switch v-model:checked="config.alerts.notifyUnreadMessage" />
        </div>
        <div class="ptd-settings-row">
          <a-typography-text>{{ t("SetBase.userInfo.alerts.notifyHnRWarning") }}</a-typography-text>
          <a-switch v-model:checked="config.alerts.notifyHnRWarning" />
        </div>
        <div class="ptd-settings-row">
          <a-typography-text>{{ t("SetBase.userInfo.alerts.notifyNeedLogin") }}</a-typography-text>
          <a-switch v-model:checked="config.alerts.notifyNeedLogin" />
        </div>
        <div class="ptd-settings-row">
          <a-typography-text>{{ t("SetBase.userInfo.alerts.notifyLevelUp") }}</a-typography-text>
          <a-switch v-model:checked="config.alerts.notifyLevelUp" />
        </div>
        <div class="ptd-settings-row">
          <a-typography-text>{{ t("SetBase.userInfo.alerts.notifyLowRatio") }}</a-typography-text>
          <a-flex align="center" :gap="8">
            <a-input-number
              v-if="config.alerts.notifyLowRatio"
              v-model:value="config.alerts.lowRatioThreshold"
              :min="0.1"
              :max="10"
              :step="0.1"
              size="small"
              class="alerts-input-sm"
            />
            <a-switch v-model:checked="config.alerts.notifyLowRatio" />
          </a-flex>
        </div>
        <div class="ptd-settings-row">
          <a-typography-text>{{ t("SetBase.userInfo.alerts.notifyInactivity") }}</a-typography-text>
          <a-switch v-model:checked="config.alerts.notifyInactivity" />
        </div>
        <div v-if="config.alerts.notifyInactivity" class="ptd-setting-note">
          <a-flex align="center" :gap="8" wrap>
            <span>{{ t("SetBase.userInfo.alerts.defaultSiteMaxInactiveDays") }}</span>
            <a-input-number
              v-model:value="config.alerts.defaultSiteMaxInactiveDays"
              :min="7"
              :max="365"
              size="small"
              class="alerts-input-sm"
            />
            <span>{{ t("SetBase.userInfo.alerts.inactivityWarningDays") }}</span>
            <a-input-number
              v-model:value="config.alerts.inactivityWarningDays"
              :min="1"
              :max="60"
              size="small"
              class="alerts-input-sm"
            />
          </a-flex>
        </div>

        <div class="ptd-setting-group">
          <div class="ptd-setting-group__title">{{ t("SetBase.userInfo.alerts.webhookTitle") }}</div>
          <div class="ptd-settings-row">
            <a-typography-text>{{ t("SetBase.userInfo.alerts.webhookType") }}</a-typography-text>
            <a-select
              v-model:value="config.alerts.webhook.type"
              :options="webhookTypeOptions"
              style="width: min(100%, 420px)"
            />
          </div>

          <template v-if="config.alerts.webhook.type !== 'none'">
            <div class="ptd-settings-row">
              <a-typography-text>{{ t("SetBase.userInfo.alerts.webhookUrl") }}</a-typography-text>
              <a-input
                v-model:value="config.alerts.webhook.url"
                :placeholder="t(`SetBase.userInfo.alerts.webhookUrlPlaceholder.${config.alerts.webhook.type}`)"
                style="width: min(100%, 420px)"
              />
            </div>
            <div class="ptd-settings-row">
              <a-typography-text>{{ t("SetBase.userInfo.alerts.webhookSecret") }}</a-typography-text>
              <a-input
                v-model:value="config.alerts.webhook.secret"
                type="password"
                :placeholder="t('SetBase.userInfo.alerts.webhookSecretPlaceholder')"
                style="width: min(100%, 420px)"
              />
            </div>
            <div v-if="config.alerts.webhook.type === 'telegram'" class="ptd-settings-row">
              <a-typography-text>{{ t("SetBase.userInfo.alerts.telegramChatId") }}</a-typography-text>
              <a-input
                v-model:value="config.alerts.webhook.chatId"
                :placeholder="t('SetBase.userInfo.alerts.telegramChatIdPlaceholder')"
                style="width: min(100%, 420px)"
              />
            </div>
            <div class="alerts-webhook-actions">
              <a-button size="small" :loading="testingWebhook" @click="testWebhook">
                {{ t("SetBase.userInfo.alerts.sendTestWebhook") }}
              </a-button>
            </div>
          </template>
        </div>
      </template>
    </section>
  </div>
</template>

<style scoped>
.alerts-input-sm {
  width: 88px;
}

.alerts-webhook-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 6px;
}
</style>
