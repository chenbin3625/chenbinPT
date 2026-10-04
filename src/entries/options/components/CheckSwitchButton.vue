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
</script>

<template>
  <NavButton
    :icon="CheckSquareOutlined"
    :text="t('common.checkbox.all')"
    size="small"
    v-bind="$attrs"
    @click="() => updateSelected(all)"
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
    @click="() => updateSelected(all.filter((site) => !selected.includes(site)))"
  />
</template>
