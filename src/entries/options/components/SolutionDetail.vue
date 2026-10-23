<script setup lang="ts">
import { shallowRef, watch } from "vue";
import { useI18n } from "vue-i18n";
import { isEmpty } from "es-toolkit/compat";
import type { ISearchCategories } from "@ptd/site";

import type { ISearchSolution } from "@/shared/types.ts";

import {
  getCategoryName,
  getCategoryOptionName,
  getSiteMetaCategory,
} from "@/options/views/Settings/SetSearchSolution/utils.ts";

const props = defineProps<{
  solution: ISearchSolution;
}>();

const siteMetaCategory = shallowRef<ISearchCategories[]>([]);
const { t } = useI18n();

/**
 * F1-10：两个修复点。
 * 1. 只在 `onMounted` 取一次 → 组件实例被复用来渲染另一个 `solution`（方案列表按行渲染）时
 *    分类名会停留在上一个站点；改成跟随 `solution.siteId` 的 watch。
 * 2. 站点定义已不在构建产物里时 `getSiteMetaCategory` 会 reject（T-2 同类场景），
 *    旧实现留下 unhandled rejection；这里 catch 后回退为空分类（`getCategoryName` 会退化为原始 key）。
 */
watch(
  () => props.solution?.siteId,
  async (siteId) => {
    if (!siteId) {
      siteMetaCategory.value = [];
      return;
    }
    try {
      const categories = await getSiteMetaCategory(siteId);
      if (props.solution?.siteId === siteId) siteMetaCategory.value = categories;
    } catch {
      if (props.solution?.siteId === siteId) siteMetaCategory.value = [];
    }
  },
  { immediate: true },
);
</script>

<template>
  <div v-if="solution">
    <template v-if="solution.name">{{ solution.name }}</template>
    <template v-else-if="isEmpty(solution.selectedCategories)">{{ t("common.default") }}</template>
    <template v-else>
      <a-tooltip
        v-for="(value, category) in solution.selectedCategories"
        :key="category"
        :title="
          getCategoryName(siteMetaCategory, category) + ': ' + getCategoryOptionName(siteMetaCategory, category, value)
        "
      >
        <span>
          <strong>{{ getCategoryName(siteMetaCategory, category) }}</strong> :
          {{ getCategoryOptionName(siteMetaCategory, category, value) }};&nbsp;
        </span>
      </a-tooltip>
    </template>
  </div>
  <template v-else>{{ t("common.unknown") }}</template>
</template>
