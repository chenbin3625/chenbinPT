<script setup generic="T" lang="ts">
import { useI18n } from "vue-i18n";
import { BorderOutlined, CheckSquareOutlined, MinusSquareOutlined } from "@ant-design/icons-vue";

import NavButton from "./NavButton.vue";

const { t } = useI18n();

const selected = defineModel<T[]>({ required: true });
const { all } = defineProps<{
  all: T[];
}>();

function updateSelected(value: T[]) {
  selected.value = value;
}

/**
 * F1（原 D1-Low-09）：`all` 只是「当前可见/可操作」的集合，而 v-model 里可能还有
 * 不在 `all` 中的既有选项（例如下载器站点过滤里被 `allowContentScript` 隐藏的站点）。
 *
 * 旧实现用 `all` 整体覆盖 / 以 `all` 为基准做反选，会把这些「看不见但已选中」的项静默丢弃
 * （保存后它们的排除状态被清除）。这里：
 * - 全选：保留 `all` 之外的选择，只把 `all` 并进来；
 * - 全不选：这是用户明确的「全部取消」，按语义清空（含不可见项）；
 * - 反选：只翻转 `all` 内的项，`all` 之外的保持原样。
 */
function selectAll() {
  updateSelected([...new Set([...selected.value, ...all])]);
}

function invertAll() {
  const allSet = new Set(all);
  const kept = selected.value.filter((item) => !allSet.has(item));
  const inverted = all.filter((item) => !selected.value.includes(item));
  updateSelected([...kept, ...inverted]);
}
</script>

<template>
  <NavButton
    :icon="CheckSquareOutlined"
    :text="t('common.checkbox.all')"
    size="small"
    v-bind="$attrs"
    @click="selectAll"
  />
  <NavButton
    :icon="BorderOutlined"
    :text="t('common.checkbox.none')"
    size="small"
    v-bind="$attrs"
    @click="() => updateSelected([])"
  />
  <NavButton
    :icon="MinusSquareOutlined"
    :text="t('common.checkbox.invert')"
    size="small"
    v-bind="$attrs"
    @click="invertAll"
  />
</template>
