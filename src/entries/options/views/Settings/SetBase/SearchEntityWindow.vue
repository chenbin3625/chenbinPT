<script setup lang="ts">
import { QuestionCircleOutlined } from "@ant-design/icons-vue";
import { isEmpty } from "es-toolkit/compat";
import { computed } from "vue";
import { useI18n } from "vue-i18n";

import { resolveColor } from "@/shared/colors.ts";
import { useConfigStore } from "@/options/stores/config.ts";
import { useMetadataStore } from "@/options/stores/metadata.ts";

const { t } = useI18n();
const configStore = useConfigStore();
const metadataStore = useMetadataStore();

const infoIconColor = resolveColor("info");

async function clearLastFilter(v: boolean) {
  if (!v) {
    await metadataStore.setLastSearchFilter("");
  }
}

const hiddenTagNamesText = computed({
  get: () => configStore.searchEntifyControl.hiddenTagNames.join("\n"),
  set: (val: string) => {
    configStore.searchEntifyControl.hiddenTagNames = val
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  },
});
</script>

<template>
  <div class="ptd-settings-grid">
    <section class="ptd-settings-section">
      <a-typography-text strong style="display: block; margin-bottom: 4px">
        {{ t("SetBase.searchEntity.siteSearchConfig") }}
      </a-typography-text>
      <div class="ptd-settings-row">
        <a-typography-text>{{ t("SetBase.searchEntity.siteQueueConcurrency") }}</a-typography-text>
        <a-input-number
          v-model:value="configStore.searchEntity.queueConcurrency"
          :max="25"
          :min="1"
          style="width: min(100%, 420px)"
        />
      </div>

      <div class="ptd-setting-group">
        <div class="ptd-setting-group__title">{{ t("SetBase.searchEntity.searchPlanLabel") }}</div>

        <div class="ptd-settings-row">
          <a-typography-text>{{ t("SetBase.searchEntity.allowSingleSiteSearch") }}</a-typography-text>
          <a-switch
            v-model:checked="configStore.searchEntity.allowSingleSiteSearch"
            :disabled="isEmpty(metadataStore.sites)"
          />
        </div>

        <div class="ptd-settings-row">
          <a-typography-text>{{ t("SetBase.searchEntity.treatTTQueryAsImdbSearch") }}</a-typography-text>
          <a-flex align="center" :gap="8">
            <a-tooltip placement="bottom" :overlay-style="{ maxWidth: '400px' }">
              <template #title>{{ t("SetBase.searchEntity.imdbTip") }}</template>
              <QuestionCircleOutlined :style="{ color: infoIconColor }" />
            </a-tooltip>
            <a-switch v-model:checked="configStore.searchEntity.treatTTQueryAsImdbSearch" />
          </a-flex>
        </div>

        <div class="ptd-settings-row">
          <a-typography-text>{{ t("SetBase.searchEntity.showHotRecommendations") }}</a-typography-text>
          <a-switch v-model:checked="configStore.searchEntity.showHotRecommendations" />
        </div>
      </div>

      <div class="ptd-setting-group">
        <div class="ptd-setting-group__title">{{ t("SetBase.searchEntity.filterLabel") }}</div>

        <div class="ptd-settings-row">
          <a-typography-text>{{ t("SetBase.searchEntity.saveLastSearchFilter") }}</a-typography-text>
          <a-switch v-model:checked="configStore.searchEntity.saveLastFilter" @change="clearLastFilter" />
        </div>

        <div class="ptd-settings-row">
          <a-typography-text>{{ t("SetBase.searchEntity.forceImdbIdMatchFilter") }}</a-typography-text>
          <a-switch v-model:checked="configStore.searchEntity.forceImdbIdMatchFilter" />
        </div>

        <div class="ptd-settings-row">
          <a-typography-text>{{ t("SetBase.searchEntity.quickSiteFilter") }}</a-typography-text>
          <a-switch v-model:checked="configStore.searchEntity.quickSiteFilter" />
        </div>
      </div>

      <div class="ptd-setting-group">
        <div class="ptd-setting-group__title">{{ t("SetBase.searchEntity.tagLabel") }}</div>

        <div class="ptd-settings-row">
          <a-typography-text>{{ t("SetBase.searchEntity.autoDetectOfficialGroupFromTitle") }}</a-typography-text>
          <a-switch v-model:checked="configStore.searchEntity.autoDetectOfficialGroupFromTitle" />
        </div>

        <div class="ptd-settings-row">
          <a-typography-text>{{ t("SetBase.searchEntity.maxTagCountBeforeGroup") }}</a-typography-text>
          <a-input-number
            v-model:value="configStore.searchEntifyControl.maxTagCountBeforeGroup"
            :max="50"
            :min="0"
            style="width: min(100%, 420px)"
          />
        </div>

        <div class="ptd-settings-row" style="margin-top: 8px">
          <a-typography-text>{{ t("SetBase.searchEntity.hiddenTagNames") }}</a-typography-text>
          <a-textarea
            v-model:value="hiddenTagNamesText"
            :auto-size="{ minRows: 5 }"
            allow-clear
            style="width: min(100%, 420px)"
          />
        </div>
        <div style="text-align: end">
          <a-typography-text type="secondary">{{ t("SetBase.searchEntity.hiddenTagNamesMessage") }}</a-typography-text>
        </div>
      </div>
    </section>

    <section class="ptd-settings-section">
      <a-typography-text strong style="display: block; margin-bottom: 4px">
        {{ t("SetBase.searchEntity.mediaServerSearchConfig") }}
      </a-typography-text>
      <div class="ptd-settings-row">
        <a-typography-text>{{ t("SetBase.searchEntity.mediaQueueConcurrency") }}</a-typography-text>
        <a-input-number
          v-model:value="configStore.mediaServerEntity.queueConcurrency"
          :max="25"
          :min="1"
          style="width: min(100%, 420px)"
        />
      </div>
      <div class="ptd-settings-row">
        <a-typography-text>{{ t("SetBase.searchEntity.mediaSearchLimit") }}</a-typography-text>
        <a-input-number
          v-model:value="configStore.mediaServerEntity.searchLimit"
          :max="500"
          :min="1"
          :step="configStore.mediaServerEntity.searchLimit >= 100 ? 10 : 1"
          style="width: min(100%, 420px)"
        />
      </div>
      <div style="text-align: end">
        <a-typography-text type="secondary">{{ t("SetBase.searchEntity.mediaSearchLimitMessage") }}</a-typography-text>
      </div>
      <div class="ptd-settings-row">
        <a-typography-text>{{ t("SetBase.searchEntity.autoLoadInitialMediaWall") }}</a-typography-text>
        <a-switch v-model:checked="configStore.mediaServerEntity.autoSearchWhenMount" />
      </div>
      <div class="ptd-settings-row">
        <a-typography-text>{{ t("SetBase.searchEntity.autoLoadMoreMediaOnScroll") }}</a-typography-text>
        <a-switch v-model:checked="configStore.mediaServerEntity.autoSearchMoreWhenScroll" />
      </div>
    </section>
  </div>
</template>
