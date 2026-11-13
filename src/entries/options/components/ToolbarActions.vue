<script setup lang="ts">
import { computed, h, type Component } from "vue";
import { useI18n } from "vue-i18n";
import { DownOutlined } from "@ant-design/icons-vue";
import type { MenuProps } from "ant-design-vue";

import { useDisplay } from "@/options/composables/useDisplay.ts";

/**
 * 列表页工具条的「可折叠次操作组」。
 *
 * 解决的问题：搜索结果 / 下载器 / 下载历史这些页面的工具条有 5～9 个按钮，
 * 420～800px 宽度下会折成两三行，把表格往下推、与主操作混在一起看不出主次。
 *
 * 约定：
 * - `#primary` 插槽放**任何时候都必须可见**的主操作（通常 1～2 个，形如 NavButton）；
 * - `items` 放次要操作：md 及以上按普通按钮平铺，md 以下收进「更多」下拉。
 * - 两种形态由同一份 `items` 渲染，避免「宽屏按钮 / 窄屏菜单」两套文案与禁用态不同步。
 *
 * 容器用 a-flex 而不是 a-space：a-space 开启 wrap 时会给自身加负的下外边距来抵消行间距，
 * 与同一行里不在本组件内的按钮（如下载器页的「自动刷新」）错开 2px。
 *
 * 为什么不直接用 `<a-dropdown>` 包住原有按钮：按钮的 `v-show` / loading / danger
 * 状态需要与菜单项同源，包一层只能遮住视觉，状态仍会分叉。
 */
export interface ToolbarAction {
  key: string;
  label: string;
  icon?: Component;
  type?: "default" | "primary" | "dashed" | "text" | "link";
  danger?: boolean;
  disabled?: boolean;
  loading?: boolean;
  /** 该操作当前不适用（例如无选中项时隐藏而非禁用） */
  hidden?: boolean;
  /** 悬停提示；默认取 label */
  title?: string;
}

const props = defineProps<{ items: ToolbarAction[] }>();
const emit = defineEmits<{ select: [key: string] }>();

const { t } = useI18n();
const display = useDisplay();

const visibleItems = computed(() => props.items.filter((item) => !item.hidden));

// antd 的 Menu 只接受 VNode / 渲染函数形式的图标，不让直接透传组件对象。
const menuItems = computed<MenuProps["items"]>(() =>
  visibleItems.value.map((item) => ({
    key: item.key,
    label: item.label,
    icon: item.icon ? () => h(item.icon!) : undefined,
    danger: item.danger,
    disabled: item.disabled,
  })),
);

function onMenuClick({ key }: { key: string | number }) {
  emit("select", String(key));
}
</script>

<template>
  <a-flex class="toolbar-actions" align="center" :gap="4" wrap="wrap">
    <slot name="primary" />
    <template v-if="display.mdAndUp.value">
      <!-- 图标由 style.css 统一排在文案右侧（全站按钮的既定顺序） -->
      <a-button
        v-for="item in visibleItems"
        :key="item.key"
        :danger="item.danger"
        :disabled="item.disabled"
        :loading="item.loading"
        :title="item.title ?? item.label"
        :type="item.type ?? 'default'"
        @click="emit('select', item.key)"
      >
        <template v-if="item.icon" #icon><component :is="item.icon" /></template>
        {{ item.label }}
      </a-button>
    </template>
    <a-dropdown v-else-if="visibleItems.length > 0" :trigger="['click']" placement="bottomLeft">
      <a-button :title="t('common.more')">
        <template #icon><DownOutlined /></template>
        {{ t("common.more") }}
      </a-button>
      <template #overlay>
        <a-menu :items="menuItems" @click="onMenuClick" />
      </template>
    </a-dropdown>
  </a-flex>
</template>

<style scoped>
/* 次操作组整体不压缩：工具条空间不足时应由搜索框等弹性控件让位，而不是把按钮挤成两行文字 */
.toolbar-actions {
  flex: 0 0 auto;
  min-width: 0;
}
</style>
