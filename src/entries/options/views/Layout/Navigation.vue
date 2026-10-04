<script lang="ts" setup>
import { computed, h, watch, type Component } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";
import type { ItemType } from "ant-design-vue";

import { routes } from "@/options/plugins/router";
import { useConfigStore } from "@/options/stores/config.ts";
import { useDisplay } from "@/options/composables/useDisplay.ts";

import { isDebug } from "~/helper.ts";

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const configStore = useConfigStore();

// 当页面窗口大小发生变化时，调整 Navigation 的显示
const display = useDisplay();
// 注意：这里刻意**不加** `{ immediate: true }`。
// `isNavBarOpen` 是持久化字段（stores/config.ts 的 persistWebExt，用户点击侧栏原生折叠按钮后会 $save），
// 若在加载时用当前断点值无条件覆盖，用户手动折叠/展开的选择会在刷新后丢失（functional-audit SH-07）。
// 因此只在断点真正发生变化（非首次同步）时，才按配置自动折叠/展开。
watch(display.mdAndUp, (isMdAndUp, previousIsMdAndUp) => {
  if (previousIsMdAndUp === undefined) return; // 首次同步：保留已持久化的用户选择
  if (configStore.autoToggleNavBarOnDisplayChange) {
    configStore.isNavBarOpen = isMdAndUp;
  }
});

// 使用 antd 原生的折叠触发器（底部折叠条；窄屏 collapsed-width=0 时为侧栏右侧的零宽悬浮按钮）
// 来切换侧栏，并持久化用户的选择（替代原顶栏自绘的折叠按钮）。
function onNavBarCollapsed(collapsed: boolean) {
  configStore.isNavBarOpen = !collapsed;
  configStore.$save();
}

// 根据 meta 的 isMainMenu 属性自动从 router.ts 生成目录
const menuItems = computed<ItemType[]>(() =>
  routes
    .filter((r) => r.meta?.isMainMenu)
    .map((r) => ({
      type: "group",
      key: String(r.name),
      label: t(`route.${String(r.name)}.default`),
      children: r
        .children!.filter((child) => !(child.meta?.show === false)) // 允许通过 meta.show = false 隐藏子路由
        .map((child) => ({
          key: String(child.name),
          // router.ts 的 meta.icon 已迁移为 antd 图标组件，直接渲染
          icon: child.meta?.icon ? () => h(child.meta!.icon as Component) : undefined,
          label: t(`route.${String(r.name)}.${String(child.name)}`),
        })),
    })),
);

// 子路由（如 SetBase 的各个 tab）也需要高亮其父级菜单
const selectedKeys = computed(() => route.matched.map((r) => String(r.name)));

function onMenuClick({ key }: { key: string | number }) {
  router.push({ name: String(key) });
}
</script>

<template>
  <a-layout-sider
    id="ptd-navigation"
    :collapsed="!configStore.isNavBarOpen"
    :collapsed-width="display.smAndUp.value ? 64 : 0"
    :width="168"
    theme="light"
    collapsible
    @update:collapsed="onNavBarCollapsed"
  >
    <div class="ptd-navigation-inner">
      <a-menu :items="menuItems" :selected-keys="selectedKeys" mode="inline" @click="onMenuClick" />

      <!-- 调试构建下展示测试标记（按产品决策：侧栏不再展示版本号） -->
      <div v-if="isDebug" class="ptd-navigation-footer">
        <span class="ptd-navigation-debug">{{ t("common.test") }}</span>
      </div>
    </div>
  </a-layout-sider>
</template>

<style lang="scss" scoped>
.ptd-navigation-footer {
  margin-top: auto;
  padding: 8px;
  font-size: 12px;
  line-height: 18px;
  color: var(--ptd-text-tertiary, rgba(0, 0, 0, 0.45));
  text-align: center;
  white-space: nowrap;
  overflow: hidden;
}

.ptd-navigation-debug {
  display: inline-block;
  margin-left: 4px;
  padding: 0 6px;
  color: #fff;
  background-color: var(--ptd-warning, #faad14);
  border-radius: 2px;
}
</style>
