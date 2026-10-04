<script setup lang="ts">
import { useI18n } from "vue-i18n";

/**
 * 统一的「无数据」占位组件（antd Empty 的薄封装）。
 *
 * - 默认描述取 `common.noData`，页面有更具体的文案时通过 `description` 传入；
 * - `compact` 用于表格 `#no-data` 插槽等纵向空间受限的场景，收窄上下留白；
 * - 默认插槽可用于放置「去添加 / 去搜索」之类的引导按钮。
 */
const { t } = useI18n();

const { compact = false, description } = defineProps<{
  /** 空状态描述文案，默认取 common.noData */
  description?: string;
  /** 紧凑模式：减少上下留白（表格 no-data 插槽推荐） */
  compact?: boolean;
}>();
</script>

<template>
  <a-empty
    :description="description ?? t('common.noData')"
    :style="compact ? { padding: '8px 0' } : { padding: '32px 0' }"
  >
    <slot />
  </a-empty>
</template>
