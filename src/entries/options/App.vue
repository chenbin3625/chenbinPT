<script setup lang="ts">
import { computed, watch, watchEffect } from "vue";
import { useI18n } from "vue-i18n";
import { useDevicePixelRatio } from "@vueuse/core";
import { useRoute } from "vue-router";

import { useConfigStore } from "@/options/stores/config.ts";
import { useAntdConfig } from "@/options/plugins/antd.ts";

import Navigation from "./views/Layout/Navigation.vue";
import Topbar from "./views/Layout/Topbar.vue";

const { locale: currentVueI18nLocal, t } = useI18n({ useScope: "global" });
const route = useRoute();

const configStore = useConfigStore();
const { locale: antdLocale, themeConfig, themeVars } = useAntdConfig();

const mainSectionName = computed(() => {
  const mainRoute = route.matched.find((item) => item.meta?.isMainMenu);
  return mainRoute?.name ? String(mainRoute.name) : "";
});

const pageRouteName = computed(() => {
  const leafName = String(route.name ?? "");
  if (!mainSectionName.value || leafName === mainSectionName.value) return mainSectionName.value;
  // 常规设置下的页签共享同一个页面标题，具体页签信息已经由 Tab 栏表达。
  if (mainSectionName.value === "Settings" && leafName.startsWith("SetBase")) return "SetBase";
  return leafName;
});

const pageTitle = computed(() => {
  if (!mainSectionName.value || !pageRouteName.value) return "";
  return t(`route.${mainSectionName.value}.${pageRouteName.value}`);
});

const PAGE_DESCRIPTION_KEYS: Partial<Record<string, string>> = {
  MyData: "MyData.pageDescription",
  SearchEntity: "SearchEntity.index.pageDescription",
  MyClient: "MyClient.pageDescription",
  SetBase: "SetBase.pageDescription",
};

const pageDescription = computed(() => {
  const key = PAGE_DESCRIPTION_KEYS[pageRouteName.value];
  return key ? t(key) : "";
});

/**
 * 把 antd Design Token 派生的 `--ptd-*` 变量写到 <html> 上。
 *
 * 必须挂在 documentElement 而不是 `#ptd`：style.css 里 `body { background: var(--ptd-bg) }`
 * 这类规则作用在 `#ptd` 的**祖先**上，自定义属性只向下继承，挂在 `#ptd` 上时 body 取不到值。
 * 主题的唯一来源是 ConfigProvider 的 algorithm（见 plugins/antd.ts 的 themeVars）。
 */
watchEffect(() => {
  const root = document.documentElement;
  for (const [name, value] of Object.entries(themeVars.value)) {
    root.style.setProperty(name, value);
  }
});

watch(
  () => configStore.lang,
  (newLang) => {
    currentVueI18nLocal.value = newLang; // 修改 vue-i18n 的语言
  },
  { immediate: true },
);

// 页面缩放（devicePixelRatio）异常提示
const { pixelRatio } = useDevicePixelRatio();
async function setIgnoreWrongPixelRatio() {
  // 双保险：该提示可能在水合完成前就渲染出来，先等 configStore 恢复完成，
  // 避免 $save() 用默认值整份覆盖 storage（插件侧也已把 $save 串行到 restorePromise 之后）。
  await configStore.$onReady();
  configStore.ignoreWrongPixelRatio = true;
  // 保存失败由持久化插件统一提示，这里避免产生未处理的 rejection
  await configStore.$save().catch(() => undefined);
}
</script>

<template>
  <!-- auto-insert-space-in-button：antd 默认会在「恰好两个汉字」的按钮文案里插一个空格
       （取消 → 取 消），而工具条按钮走插槽渲染不会有空格，两种写法并排时明显不一致；
       这里统一关闭，按钮文案一律按 i18n 原文渲染。 -->
  <a-config-provider :auto-insert-space-in-button="false" :locale="antdLocale" :theme="themeConfig">
    <a-layout id="ptd">
      <!-- 页面缩放异常提示 -->
      <a-alert
        v-if="(pixelRatio > 1.1 || pixelRatio < 0.8) && !configStore.ignoreWrongPixelRatio"
        banner
        closable
        :message="t('layout.header.wrongPixelRatioNotice')"
        type="warning"
        @close="setIgnoreWrongPixelRatio"
      />

      <!-- 顶部工具条 -->
      <Topbar />

      <a-layout>
        <!-- 导航栏 -->
        <Navigation />

        <a-layout-content id="ptd-main">
          <header v-if="pageTitle" class="ptd-page-heading">
            <div class="ptd-page-heading__content">
              <h1>{{ pageTitle }}</h1>
              <p v-if="pageDescription">{{ pageDescription }}</p>
            </div>
          </header>
          <router-view v-slot="{ Component }">
            <component :is="Component" />
          </router-view>
        </a-layout-content>
      </a-layout>
    </a-layout>
  </a-config-provider>
</template>
