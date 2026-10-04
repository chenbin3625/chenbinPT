<script setup lang="ts">
import { GlobalOutlined } from "@ant-design/icons-vue";
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { useDisplay } from "@/options/composables/useDisplay.ts";

import { useConfigStore } from "@/options/stores/config.ts";

import { tableCustomFilter } from "./utils/filter.ts";
import { applyQuickSiteFilter, getQuickSiteFilterSelection, type IQuickSiteFilter } from "./utils/quickSiteFilter.ts";

import SiteName from "@/options/components/SiteName.vue";
import SiteFavicon from "@/options/components/SiteFavicon/Index.vue";

const { t } = useI18n();
const configStore = useConfigStore();
const display = useDisplay();

const { advanceFilterDictRef, advanceItemPropsRef, updateTableFilterValueFn } = tableCustomFilter;

const emptySiteFilter: IQuickSiteFilter = { required: [], exclude: [] };

function getSiteFilter(): IQuickSiteFilter {
  return advanceFilterDictRef.value.site ?? emptySiteFilter;
}

function getWritableSiteFilter(): IQuickSiteFilter {
  advanceFilterDictRef.value.site ??= { required: [], exclude: [] };
  return advanceFilterDictRef.value.site;
}

const quickSiteSelection = computed(() => getQuickSiteFilterSelection(getSiteFilter()));
const isAllSelected = computed(() => quickSiteSelection.value.isAllSelected);
const selectedSite = computed(() => quickSiteSelection.value.selectedSite);

function selectQuickSite(siteId: string | null) {
  applyQuickSiteFilter(getWritableSiteFilter(), siteId);
  updateTableFilterValueFn();
}
</script>

<template>
  <!-- 快速站点筛选：只是筛选器，不再使用 alert 承载；已选种子的信息与批量操作见页面底部的 SelectionBar -->
  <div v-if="configStore.searchEntity.quickSiteFilter" class="quick-site-filter">
    <button
      type="button"
      class="quick-site-filter__option"
      :class="{
        'quick-site-filter__option--active': isAllSelected,
        'quick-site-filter__option--icon-only': display.smAndDown.value,
      }"
      @click.stop="selectQuickSite(null)"
    >
      <GlobalOutlined class="quick-site-filter__icon" />
      {{ display.smAndDown.value ? "" : t("SearchEntity.siteFilter.all") }}
    </button>

    <button
      v-for="siteId in advanceItemPropsRef.site"
      :key="siteId"
      type="button"
      class="quick-site-filter__option"
      :class="{ 'quick-site-filter__option--active': selectedSite === siteId }"
      @click="selectQuickSite(siteId)"
    >
      <SiteFavicon :site-id="siteId" :size="14" class="quick-site-filter__favicon" />
      <SiteName :site-id="siteId" tag="span" class="quick-site-filter__name" />
    </button>
  </div>
</template>
