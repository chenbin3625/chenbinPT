<script setup lang="ts">
import { CheckCircleOutlined } from "@ant-design/icons-vue";
import { cloneDeep } from "es-toolkit";
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";

import { setBaseChildren } from "@/options/plugins/router.ts";
import { useConfigStore } from "@/options/stores/config.ts";
import { useRuntimeStore } from "@/options/stores/runtime.ts";

import {
  applySetBaseConfigDraft,
  createSetBaseConfigDraft,
  provideSetBaseConfigDraft,
  provideSetBaseConfigDraftReset,
  type TSetBaseConfigDraft,
} from "./configDraft.ts";

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

// F2-N10：页签的 `<component>` 位于 `v-for` 里，模板 ref 会被收集成数组（ref_for），
// `value[0]` 在页签切换的过渡帧里可能是上一个页签的实例。这里改为按路由名登记实例、按 route.name 精确取。
const tabInstances = new Map<string, ISetBaseTabSaveHooks>();

// L1（REVIEW-FINDINGS P1-9）：切走页签时组件会被 `destroy-inactive-tab-pane` 卸载，但它的
// beforeSave 副作用（清空 lastDownloader / lastSearchFilter、补全 contentScript 站点选项）
// 仍必须在**之后任意页签**的保存时执行 —— 否则「在下载页签关掉记住上次下载服务器、切到
// UI 页签点保存」时旧值不会被清理。因此卸载时**保留**最后登记的 hook 提供者（只作为闭包使用，
// 重新挂载时被新实例覆盖；SetBase 页签数量固定，不存在无界增长）。
function setTabInstance(routeName: string, instance: unknown): void {
  if (instance) {
    tabInstances.set(routeName, instance as ISetBaseTabSaveHooks);
  }
}

/** 对所有已访问页签统一执行保存钩子（幂等：各 hook 内部由草稿里的开关状态守卫） */
async function runAllTabHooks(hook: "beforeSave" | "afterSave"): Promise<void> {
  const hooks = [...tabInstances.values()]
    .map((instance) => instance[hook])
    .filter((fn): fn is () => Promise<void> => typeof fn === "function");
  await Promise.all(hooks.map((fn) => fn()));
}

// F2-N1：SetBase 采用「草稿 + 显式保存」语义。控件只写草稿，点保存才合并回 store 并落盘；
// 这样其它页面触发的任意 `$save()` 都不会把这里未确认的修改（尤其是备份加密密钥）静默写入。
const configDraft = ref(createSetBaseConfigDraft(configStore.$state)) as unknown as TSetBaseConfigDraft;
const configDraftBaseline = ref(cloneDeep(configDraft.value)) as unknown as TSetBaseConfigDraft;
provideSetBaseConfigDraft(configDraft);

/**
 * OUI-3 / G：用 store 当前值重建草稿 + 基线。
 * - 「重置系统设置」后由 ResetWindow 通过 `provideSetBaseConfigDraftReset` 触发；
 * - 冷启动时等 `configStore.$onReady()`（storage 水合完成）后触发一次，
 *   否则草稿会基于「未水合的默认值」创建，页签显示的不是用户已保存的配置。
 */
function rebuildConfigDraft() {
  configDraft.value = createSetBaseConfigDraft(configStore.$state) as unknown as TSetBaseConfigDraft["value"];
  configDraftBaseline.value = cloneDeep(configDraft.value) as unknown as TSetBaseConfigDraft["value"];
}
provideSetBaseConfigDraftReset(rebuildConfigDraft);

void configStore
  .$onReady()
  .then(() => rebuildConfigDraft())
  .catch(() => undefined);

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
  try {
    // L1：所有已访问页签的副作用都执行（不只是当前页签），幂等
    await runAllTabHooks("beforeSave");

    // 只把草稿中真正改动过的叶子写回 store（不覆盖草稿期间其它上下文对同一子树的改动）
    applySetBaseConfigDraft(configStore.$state, configDraft.value, configDraftBaseline.value);
    configDraftBaseline.value = cloneDeep(configDraft.value);

    await configStore.$save();
    await runAllTabHooks("afterSave");
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
            <component :is="Component" :ref="(el: unknown) => setTabInstance(tab.route, el)" />
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

/* 保存按钮给一个稳定的最小宽度，避免只随文案变化 */
.set-base-save {
  min-width: 96px;
}
</style>
