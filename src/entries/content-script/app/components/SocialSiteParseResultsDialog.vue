<script setup lang="ts">
import { ISocialSitePageInformation } from "@ptd/social";
import { type IPtdData } from "../utils.ts";
import { computed, inject } from "vue";
import { useI18n } from "vue-i18n";
import { useMetadataStore } from "@/options/stores/metadata.ts";

import ParseResultListItem from "./ParseResultListItem.vue";

const { t } = useI18n();
const metadataStore = useMetadataStore();

const showDialog = defineModel<boolean>();
const { parseResults, searchPlan = "default" } = defineProps<{
  parseResults: ISocialSitePageInformation[];
  searchPlan?: string;
}>();

const ptdData = inject<IPtdData>("ptd_data", {});

const customSearchPlans = computed(() => {
  if (!metadataStore.$ready) {
    return [];
  }

  return metadataStore.getSearchSolutions
    .filter((solution) => !!solution.enabled)
    .sort((a, b) => b.sort - a.sort)
    .map((solution) => ({
      id: solution.id,
      name: solution.name ?? solution.id,
    }));
});

const searchPlans = computed(() => {
  const plans = [{ id: "default", name: t("layout.header.searchPlan.default") }];

  if (metadataStore.defaultSolutionId !== "default") {
    plans.push({ id: "all", name: t("layout.header.searchPlan.all") });
  }

  plans.push(...customSearchPlans.value);

  return plans;
});

const shouldShowSearchPlanMenu = computed(() => customSearchPlans.value.length > 0);

/** 只有存在自定义搜索方案时才给行挂 hover 菜单，否则传空数组让 a-dropdown 禁用 */
const planMenuSearchPlans = computed(() => (shouldShowSearchPlanMenu.value ? searchPlans.value : []));

function buildSiteSearchKeyword(result: ISocialSitePageInformation) {
  return `${ptdData.socialSite!}|${result.id}`;
}

function shouldCollapseTitles(result: ISocialSitePageInformation) {
  return ptdData.socialSite === "tmdb" && result.pageCategory === "season_list";
}

function getCollapseTitle(result: ISocialSitePageInformation) {
  if (ptdData.socialSite === "tmdb" && result.pageCategory === "season_list") {
    return t("contentScript.SocialSiteParseResultsDialog.searchEntryTitle", {
      title: result.entryTitle || t("contentScript.SocialSiteParseResultsDialog.defaultSeasonTitle"),
    });
  }

  return t("contentScript.SocialSiteParseResultsDialog.searchTitle");
}

function getResultKey(result: ISocialSitePageInformation, index: number) {
  return `${result.id}|${result.pageCategory ?? "default"}|${result.titles[0] ?? index}`;
}

function shouldShowSiteId(result: ISocialSitePageInformation, index: number) {
  if (!(ptdData.socialSite === "tmdb" && result.pageCategory === "season_list")) {
    return true;
  }

  return index === 0;
}

function shouldShowExternalIds(result: ISocialSitePageInformation, index: number) {
  if (!(ptdData.socialSite === "tmdb" && result.pageCategory === "season_list")) {
    return true;
  }

  return index === 0;
}

function shouldShowSeriesTitle(result: ISocialSitePageInformation, index: number) {
  return ptdData.socialSite === "tmdb" && result.pageCategory === "season_list" && index === 0 && !!result.seriesTitle;
}
</script>

<template>
  <a-modal
    v-model:open="showDialog"
    :footer="null"
    :title="t('contentScript.SocialSiteParseResultsDialog.title')"
    :width="600"
  >
    <a-list>
      <template v-for="(result, index) in parseResults" :key="getResultKey(result, index)">
        <ParseResultListItem
          v-if="shouldShowSiteId(result, index)"
          :title="`${ptdData.socialSite}: ${result.id}`"
          :tag-text="t('contentScript.SocialSiteParseResultsDialog.searchId')"
          tag-color="geekblue"
          :keyword="buildSiteSearchKeyword(result)"
          :search-plan="searchPlan"
          :search-plans="planMenuSearchPlans"
        />

        <template v-if="result.external_ids && shouldShowExternalIds(result, index)">
          <ParseResultListItem
            v-for="(externalId, externalType) in result.external_ids"
            :key="`${result.id}|${externalType}|${externalId}`"
            :title="`${externalType}: ${externalId}`"
            :tag-text="t('contentScript.SocialSiteParseResultsDialog.searchExternalId')"
            tag-color="green"
            :keyword="`${externalType}|${externalId}`"
            :search-plan="searchPlan"
            :search-plans="planMenuSearchPlans"
          />
        </template>

        <ParseResultListItem
          v-if="shouldShowSeriesTitle(result, index)"
          :title="result.seriesTitle!"
          :tag-text="t('contentScript.SocialSiteParseResultsDialog.searchTitle')"
          :keyword="result.seriesTitle!"
          :search-plan="searchPlan"
          :search-plans="planMenuSearchPlans"
        />

        <a-collapse v-if="shouldCollapseTitles(result)" :bordered="false" accordion>
          <a-collapse-panel
            :key="getResultKey(result, index)"
            :header="`${getCollapseTitle(result)} (${result.titles.length})`"
          >
            <ParseResultListItem
              v-for="title in result.titles"
              :key="`${result.id}|${title}`"
              :title="title"
              :tag-text="t('contentScript.SocialSiteParseResultsDialog.searchTitle')"
              :keyword="title"
              :search-plan="searchPlan"
              :search-plans="planMenuSearchPlans"
            />
          </a-collapse-panel>
        </a-collapse>
        <template v-else v-for="title in result.titles" :key="`${result.id}|${title}`">
          <ParseResultListItem
            :title="title"
            :tag-text="t('contentScript.SocialSiteParseResultsDialog.searchTitle')"
            :keyword="title"
            :search-plan="searchPlan"
            :search-plans="planMenuSearchPlans"
          />
        </template>

        <a-divider v-if="index != parseResults.length - 1" />
      </template>

      <!-- 解析结果可能为空数组（解析器对当前页面没有产出），此时列表区域会完全空白，补明确占位 -->
      <a-empty v-if="parseResults.length === 0" :description="t('contentScript.parseResultEmpty')" />
    </a-list>
  </a-modal>
</template>
