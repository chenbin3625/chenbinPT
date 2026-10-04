<script setup lang="ts">
import { SyncOutlined, ToTopOutlined } from "@ant-design/icons-vue";
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { EResultParseStatus } from "@ptd/site";

import { useRuntimeStore } from "@/options/stores/runtime.ts";
import { useMetadataStore } from "@/options/stores/metadata.ts";
import { resolveColor } from "@/shared/colors.ts";
import type { ISearchPlanStatus, TSearchSolutionKey } from "@/shared/types.ts";

import NoDataPlaceholder from "@/options/components/NoDataPlaceholder.vue";
import SiteFavicon from "@/options/components/SiteFavicon/Index.vue";
import SiteName from "@/options/components/SiteName.vue";
import SolutionDetail from "@/options/components/SolutionDetail.vue";
import ResultParseStatus from "@/options/components/ResultParseStatus.vue";

import { doSearchEntity, raiseSearchPriority } from "./utils/search.ts";

const showDialog = defineModel<boolean>();

const { t } = useI18n();
const runtimeStore = useRuntimeStore();
const metadataStore = useMetadataStore();

function getSearchSolution(planKey: string, entryName: string) {
  return metadataStore.solutions[planKey]?.solutions.find((x) => x.id === entryName)!;
}

const statusFilterRef = ref<EResultParseStatus[]>([]);

// A-22：这份表里的颜色名是 Vuetify 的调色板写法（"yellow-darken-2"/"indigo"…）。antd 的 a-tag 只认
// 预设色名，其余值会被原样写进 `style.backgroundColor` —— 非法 CSS 会被浏览器直接丢弃，标签就没有任何样式。
// 因此消费时必须经 resolveColor() 转成真实色值（见 src/entries/shared/colors.ts）。
const statusColorMap: Record<EResultParseStatus, string> = {
  [EResultParseStatus.success]: "green",
  [EResultParseStatus.waiting]: "indigo",
  [EResultParseStatus.working]: "indigo",
  [EResultParseStatus.parseError]: "red",
  [EResultParseStatus.passParse]: "yellow-darken-2",
  [EResultParseStatus.CFBlocked]: "orange",
  [EResultParseStatus.needLogin]: "red",
  [EResultParseStatus.noUserInput]: "red",
  [EResultParseStatus.noResults]: "red",
  [EResultParseStatus.unknownError]: "red",
};

const statusChips = computed(() => {
  const countMap = new Map<EResultParseStatus, number>();
  for (const plan of Object.values(runtimeStore.search.searchPlan ?? {})) {
    countMap.set(plan.status, (countMap.get(plan.status) ?? 0) + 1);
  }
  return [...countMap.entries()].map(([status, count]) => ({
    status,
    count,
    color: resolveColor(statusColorMap[status]),
  }));
});

const filteredSearchPlan = computed(() => {
  const entries = Object.entries(runtimeStore.search.searchPlan ?? {}) as [TSearchSolutionKey, ISearchPlanStatus][];
  if (statusFilterRef.value.length === 0) return entries;
  return entries.filter(([, plan]) => statusFilterRef.value.includes(plan.status));
});
</script>

<template>
  <a-modal v-model:open="showDialog" :footer="null" :width="800">
    <template #title>
      {{
        t("SearchEntity.SearchStatusDialog.title", [
          metadataStore.getSearchSolutionName(runtimeStore.search.searchPlanKey),
        ])
      }}
      <br />
      <p style="font-size: 12px"><{{ runtimeStore.search.searchPlanKey }}></p>
    </template>
    <a-space wrap>
      <a-tag
        v-for="{ status, count, color } in statusChips"
        :key="status"
        :bordered="!statusFilterRef.includes(status)"
        :color="statusFilterRef.includes(status) ? color : undefined"
        style="cursor: pointer"
        @click="
          () => {
            statusFilterRef = statusFilterRef.includes(status)
              ? statusFilterRef.filter((s) => s !== status)
              : [...statusFilterRef, status];
          }
        "
      >
        <ResultParseStatus :status="status" />
        <a-badge color="grey" :count="count" :number-style="{ position: 'static', transform: 'none' }"></a-badge>
      </a-tag>
    </a-space>
    <a-divider v-if="statusChips.length > 0" style="margin-bottom: 8px"></a-divider>
    <a-list>
      <a-list-item v-for="[solutionKey, searchPlan] in filteredSearchPlan" :key="solutionKey">
        <a-list-item-meta>
          <template #avatar><SiteFavicon :site-id="searchPlan.siteId" style="margin-right: 8px" /></template>
          <template #title>
            <a-flex :gap="4">
              <SiteName :site-id="searchPlan.siteId" strong style="text-decoration: none" />
              ->
              <span v-if="searchPlan.searchEntry.name">
                {{ searchPlan.searchEntry.name }}
              </span>
              <span
                v-else-if="
                  runtimeStore.search.searchPlanKey === 'all' || runtimeStore.search.searchPlanKey.startsWith('site:')
                "
              >
                {{ searchPlan.searchEntry.name ?? searchPlan.searchEntryName }}
              </span>
              <span v-else>
                <SolutionDetail
                  :solution="getSearchSolution(runtimeStore.search.searchPlanKey, searchPlan.searchEntryName)"
                />
              </span>
            </a-flex>
            <br />
            <span style="color: var(--ptd-text-tertiary); font-size: 14px"> <{{ searchPlan.searchEntryName }}> </span>
          </template>
        </a-list-item-meta>

        <div style="font-size: 14px; text-align: right">
          <ResultParseStatus :status="searchPlan.status" />
          <template v-if="searchPlan.status === EResultParseStatus.success">
            <br />
            <span>
              {{
                t("SearchEntity.SearchStatusDialog.successMsg", [searchPlan.count, (searchPlan.costTime ?? 0) / 1000])
              }}
            </span>
          </template>
          <template v-else-if="searchPlan.statusMsg">
            <br />
            <span>
              {{
                searchPlan.statusMsg.startsWith("i18n.")
                  ? t("SearchEntity.SearchStatusDialog.statusMsg" + searchPlan.statusMsg.replace("i18n.", "."))
                  : searchPlan.statusMsg
              }}
            </span>
          </template>
        </div>
        <a-divider style="margin: 0 8px" type="vertical" />
        <a-button-group size="small">
          <!-- 上移队列 -->
          <a-button
            v-if="searchPlan.status === EResultParseStatus.waiting"
            type="text"
            :title="t('SearchEntity.SearchStatusDialog.moveUp')"
            @click="() => raiseSearchPriority(solutionKey)"
          >
            <template #icon><ToTopOutlined /></template>
          </a-button>
          <!-- 重新搜索 -->
          <a-button
            v-else
            danger
            :title="t('SearchEntity.SearchStatusDialog.searchAgain')"
            :loading="searchPlan.status === EResultParseStatus.working"
            @click="() => doSearchEntity(searchPlan.siteId, searchPlan.searchEntryName, searchPlan.searchEntry, true)"
          >
            <template #icon><SyncOutlined /></template>
          </a-button>
        </a-button-group>
      </a-list-item>

      <!-- 搜索方案尚未创建条目（或筛选条件把条目全部过滤掉）时，列表本身渲染为空，这里补一个明确占位 -->
      <NoDataPlaceholder v-if="filteredSearchPlan.length === 0" />
    </a-list>
  </a-modal>
</template>
