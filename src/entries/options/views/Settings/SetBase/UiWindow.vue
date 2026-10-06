<script setup lang="ts">
import { QuestionCircleOutlined } from "@ant-design/icons-vue";
import { isEmpty } from "es-toolkit/compat";
import { computed } from "vue";
import { useI18n } from "vue-i18n";

import { resolveColor } from "@/shared/colors.ts";
import { supportTheme } from "@/shared/types.ts";
import { definedLangMetaData } from "@/options/plugins/i18n.ts";

import { useConfigStore } from "@/options/stores/config.ts";
import { useMetadataStore } from "@/options/stores/metadata.ts";

const { t } = useI18n();
const configStore = useConfigStore();
const metadataStore = useMetadataStore();

const infoIconColor = resolveColor("info");

const langOptions = computed(() => definedLangMetaData.map((item) => ({ label: item.title, value: item.value })));
const themeOptions = computed(() =>
  supportTheme.map((item) => ({ label: t(`SetBase.ui.displayMode.${item}`), value: item })),
);
const socialSiteSearchOptions = computed(() =>
  (["id", "title", "imdb", "chosen"] as const).map((item) => ({
    label: t(`SetBase.ui.socialSiteSearchBy.${item}`),
    value: item,
  })),
);

async function initContentScriptExceptionSites() {
  Object.keys(metadataStore.sites).forEach((site) => {
    if (typeof metadataStore.sites[site].allowContentScript === "undefined") {
      metadataStore.sites[site].allowContentScript = true;
    }
  });
  await metadataStore.$save();
}

async function beforeSave() {
  // 对从低版本升级上来的用户，在启用例外站点时，补全缺失选项
  if (
    configStore.contentScript.enabled &&
    configStore.contentScript.allowExceptionSites &&
    !isEmpty(metadataStore.sites)
  ) {
    await initContentScriptExceptionSites();
  }
}

defineExpose({
  beforeSave,
});
</script>

<template>
  <div class="ptd-settings-grid">
    <!-- 语言、显示模式等基础外观设置 -->
    <section class="ptd-settings-section">
      <!-- 插件语言设置 -->
      <div class="ptd-settings-row">
        <a-typography-text>{{ t("SetBase.ui.changeLanguage") }}</a-typography-text>
        <a-select v-model:value="configStore.lang" :options="langOptions" style="width: min(100%, 420px)" />
      </div>

      <!-- 明亮模式设置 -->
      <div class="ptd-settings-row">
        <a-typography-text>{{ t("SetBase.ui.displayMode.index") }}</a-typography-text>
        <a-select v-model:value="configStore.theme" :options="themeOptions" style="width: min(100%, 420px)" />
      </div>

      <div class="ptd-settings-row">
        <a-typography-text>{{ t("SetBase.ui.saveTableBehavior") }}</a-typography-text>
        <a-switch v-model:checked="configStore.saveTableBehavior" />
      </div>

      <div class="ptd-settings-row">
        <a-typography-text>{{ t("SetBase.ui.enableTableMultiSort") }}</a-typography-text>
        <a-flex align="center" :gap="8">
          <a-tooltip placement="bottom" :overlay-style="{ maxWidth: '400px' }">
            <template #title>{{ t("SetBase.ui.tableMultiSortNote") }}</template>
            <QuestionCircleOutlined :style="{ color: infoIconColor }" />
          </a-tooltip>
          <a-switch v-model:checked="configStore.enableTableMultiSort" />
        </a-flex>
      </div>

      <div class="ptd-settings-row">
        <a-typography-text>{{ t("SetBase.ui.autoToggleNavBarOnDisplayChange") }}</a-typography-text>
        <a-flex align="center" :gap="8">
          <a-tooltip placement="bottom" :overlay-style="{ maxWidth: '400px' }">
            <template #title>{{ t("SetBase.ui.autoToggleNavBarOnDisplayChangeNote") }}</template>
            <QuestionCircleOutlined :style="{ color: infoIconColor }" />
          </a-tooltip>
          <a-switch v-model:checked="configStore.autoToggleNavBarOnDisplayChange" />
        </a-flex>
      </div>
    </section>

    <!-- 内容脚本 -->
    <section class="ptd-settings-section">
      <div class="ptd-settings-row ptd-settings-row--title">
        <a-typography-text strong>{{ t("SetBase.ui.contentScript") }}</a-typography-text>
        <a-flex align="center" :gap="8">
          <a-typography-text>{{ t("common.enable") }}</a-typography-text>
          <a-switch v-model:checked="configStore.contentScript.enabled" />
        </a-flex>
      </div>

      <template v-if="configStore.contentScript.enabled">
        <a-alert type="warning" show-icon :message="t('SetBase.ui.contentScriptWarning')" />

        <div class="ptd-setting-group">
          <div class="ptd-setting-group__title">{{ t("SetBase.ui.basicSettings") }}</div>

          <div class="ptd-settings-row">
            <a-typography-text>{{ t("SetBase.ui.allowExceptionSites") }}</a-typography-text>
            <a-switch v-model:checked="configStore.contentScript.allowExceptionSites" />
          </div>

          <div class="ptd-settings-row">
            <a-typography-text>{{ t("SetBase.ui.enableOnSocialSite") }}</a-typography-text>
            <a-switch v-model:checked="configStore.contentScript.enabledAtSocialSite" />
          </div>
        </div>

        <div class="ptd-setting-group">
          <div class="ptd-setting-group__title">{{ t("SetBase.ui.sidebarStyle") }}</div>

          <div class="ptd-settings-row">
            <a-typography-text>
              {{ `${t("SetBase.ui.respondDisplayMode")}` + t("SetBase.ui.displayMode.index") }}
            </a-typography-text>
            <a-switch v-model:checked="configStore.contentScript.applyTheme" />
          </div>

          <div class="ptd-settings-row">
            <a-typography-text>{{ t("SetBase.ui.expandByDefault") }}</a-typography-text>
            <a-switch v-model:checked="configStore.contentScript.defaultOpenSpeedDial" />
          </div>

          <div class="ptd-settings-row">
            <a-typography-text>{{ t("SetBase.ui.useLargeIcon") }}</a-typography-text>
            <a-switch v-model:checked="configStore.contentScript.stackedButtons" />
          </div>

          <div class="ptd-settings-row">
            <a-typography-text>{{ t("SetBase.ui.enableFadeEffect") }}</a-typography-text>
            <a-switch v-model:checked="configStore.contentScript.fadeEnterStyle" />
          </div>
        </div>

        <div class="ptd-setting-group">
          <div class="ptd-setting-group__title">{{ t("SetBase.ui.sidebarFunctions") }}</div>

          <div class="ptd-settings-row">
            <a-typography-text>{{ t("SetBase.ui.confirmTwoStep") }}</a-typography-text>
            <a-switch v-model:checked="configStore.contentScript.doubleConfirmAction" />
          </div>

          <div class="ptd-settings-row">
            <a-typography-text>{{ t("SetBase.ui.allowDragLink") }}</a-typography-text>
            <a-flex align="center" :gap="8">
              <a-tooltip placement="bottom" :overlay-style="{ maxWidth: '400px' }">
                <template #title>{{ t("SetBase.ui.dragNote") }}</template>
                <QuestionCircleOutlined :style="{ color: infoIconColor }" />
              </a-tooltip>
              <a-switch v-model:checked="configStore.contentScript.dragLinkOnSpeedDial" />
            </a-flex>
          </div>

          <div class="ptd-settings-row">
            <a-typography-text>{{ t("SetBase.ui.socialSiteSearchLabel") }}</a-typography-text>
            <a-select
              v-model:value="configStore.contentScript.socialSiteSearchBy"
              :disabled="!configStore.contentScript.enabledAtSocialSite"
              :options="socialSiteSearchOptions"
              style="width: min(100%, 420px)"
            />
          </div>
        </div>
      </template>
    </section>

    <!-- 右键菜单 -->
    <section class="ptd-settings-section">
      <div class="ptd-settings-row ptd-settings-row--title">
        <a-typography-text strong>{{ t("SetBase.ui.contextMenu") }}</a-typography-text>
        <a-flex align="center" :gap="8">
          <a-typography-text>{{ t("common.enable") }}</a-typography-text>
          <a-switch v-model:checked="configStore.contextMenus.enabled" />
        </a-flex>
      </div>

      <template v-if="configStore.contextMenus.enabled">
        <div class="ptd-settings-row">
          <a-typography-text>{{ t("SetBase.ui.contextMenuTextSearch") }}</a-typography-text>
          <a-switch v-model:checked="configStore.contextMenus.allowSelectionTextSearch" />
        </div>

        <div class="ptd-settings-row">
          <a-typography-text>{{ t("SetBase.ui.contextMenuSocialSearch") }}</a-typography-text>
          <a-switch v-model:checked="configStore.contextMenus.allowSocialLinkSearch" />
        </div>

        <div class="ptd-settings-row">
          <a-typography-text>{{ t("SetBase.ui.contextMenuLinkPush") }}</a-typography-text>
          <a-switch
            v-model:checked="configStore.contextMenus.allowLinkDownloadPush"
            :disabled="metadataStore.getEnabledDownloaders.length === 0"
          />
        </div>
      </template>
    </section>
  </div>
</template>
