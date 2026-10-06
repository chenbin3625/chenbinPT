<script setup lang="ts">
import { CheckCircleOutlined } from "@ant-design/icons-vue";
import { computed, useTemplateRef } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";

import { setBaseChildren } from "@/options/plugins/router.ts";
import { useConfigStore } from "@/options/stores/config.ts";
import { useRuntimeStore } from "@/options/stores/runtime.ts";

const { t } = useI18n();
const router = useRouter();
const route = useRoute();
const configStore = useConfigStore();
const runtimeStore = useRuntimeStore();

const setBaseTabs = setBaseChildren.map((x) => ({
  key: String(x.alias ?? x.path),
  route: String(x.name),
}));

interface ISetBaseTabSaveHooks {
  beforeSave?: () => Promise<void>;
  afterSave?: () => Promise<void>;
}

// 注意：这里的模板 ref 位于 `<a-tab-pane v-for>` 内部，Vue 编译时会带上 ref_for，
// 于是 setTabRef.value 实际是「组件实例数组」而不是单个实例——直接调用 .beforeSave 会静默为 undefined，
// 导致各 tab 的保存前后钩子（如 UiWindow 的 allowContentScript 补全、UserInfoWindow 的下次刷新时间）永不执行。
const setTabRef = useTemplateRef<ISetBaseTabSaveHooks | ISetBaseTabSaveHooks[]>("setTabRef");

function currentTabInstance(): ISetBaseTabSaveHooks | undefined {
  const value = setTabRef.value as ISetBaseTabSaveHooks | ISetBaseTabSaveHooks[] | null | undefined;
  return Array.isArray(value) ? value[0] : (value ?? undefined);
}

const activeTab = computed({
  get() {
    return String(route.name ?? setBaseTabs[0]?.route ?? "");
  },
  set(newRouteName) {
    if (newRouteName && newRouteName !== route.name) {
      router.push({ name: newRouteName });
    }
  },
});

const showSaveButton = computed(() => {
  return route.meta?.usesGlobalSave !== false;
});

async function save() {
  const tab = currentTabInstance();
  try {
    await tab?.beforeSave?.();
    await configStore.$save();
    await tab?.afterSave?.();
    runtimeStore.showSnakebar(t("common.saveSuccess"), { color: "success" });
  } catch {
    runtimeStore.showSnakebar(t("common.saveFailed"), { color: "error" });
  }
}
</script>

<template>
  <a-card class="ptd-settings-card ptd-set-base-card">
    <a-tabs v-model:active-key="activeTab" class="set-base-tabs" tab-position="top" destroy-inactive-tab-pane>
      <a-tab-pane v-for="tab in setBaseTabs" :key="tab.route" :tab="t(`SetBase.tab.${tab.key}`)">
        <div class="ptd-settings-form ptd-set-base-form">
          <router-view v-slot="{ Component }">
            <component :is="Component" ref="setTabRef" />
          </router-view>
        </div>
      </a-tab-pane>

      <!-- 保存按钮与页签同一行、贴行尾：与对话框页脚保持一致的原生 antd 按钮层级（主操作 = 实心 primary） -->
      <template v-if="showSaveButton" #rightExtra>
        <a-button class="set-base-save" type="primary" @click="save">
          <template #icon>
            <CheckCircleOutlined />
          </template>
          {{ t("common.save") }}
        </a-button>
      </template>
    </a-tabs>
  </a-card>
</template>

<style scoped>
.set-base-tabs {
  margin-bottom: 0;
}

/* 保存按钮给一个稳定的最小宽度，避免只随文案宽度变化 */
.set-base-save {
  min-width: 96px;
}
</style>
