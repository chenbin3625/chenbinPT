<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";

import { doKeywordSearch } from "../utils.ts";

/**
 * SocialSiteParseResultsDialog 的一行解析结果。
 *
 * 等价于原来的 PtdListItem + PtdChip + PtdMenu（菜单挂在父级、hover 打开）：
 * - 行本身点击 → 用当前 searchPlan 搜索
 * - hover 该行 → 弹出搜索方案菜单（a-dropdown 的 hover 触发，替代 Vuetify 的 v-menu）
 */
const {
  title,
  tagText,
  tagColor,
  keyword,
  searchPlan = "default",
  searchPlans = [],
} = defineProps<{
  title: string;
  tagText: string;
  /** a-tag 的预设色名（geekblue / green / …），不传则用默认灰 */
  tagColor?: string;
  /** 点击该行时搜索的关键词 */
  keyword: string;
  searchPlan?: string;
  searchPlans?: { id: string; name: string }[];
}>();

const { t } = useI18n();

const showPlanMenu = computed(() => searchPlans.length > 0);
</script>

<template>
  <a-dropdown :disabled="!showPlanMenu" placement="bottomRight">
    <a-list-item class="ptd-parse-result-row" @click="() => doKeywordSearch(keyword, searchPlan)">
      <a-list-item-meta :title="title" />

      <template #actions>
        <a-tag :color="tagColor">{{ tagText }}</a-tag>
      </template>
    </a-list-item>

    <template #overlay>
      <a-menu>
        <a-menu-item-group :title="t('contentScript.SocialSiteParseResultsDialog.searchPlan')">
          <a-menu-item v-for="plan in searchPlans" :key="plan.id" @click="() => doKeywordSearch(keyword, plan.id)">
            {{ plan.name }}
          </a-menu-item>
        </a-menu-item-group>
      </a-menu>
    </template>
  </a-dropdown>
</template>
