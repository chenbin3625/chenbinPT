<script setup lang="ts">
import { nanoid } from "nanoid";
import { computed, nextTick, ref, shallowRef, watch } from "vue";
import { useI18n } from "vue-i18n";
import { cloneDeep } from "es-toolkit";
import { find } from "es-toolkit/compat";

import { refDebounced } from "@vueuse/core";
import {
  ClusterOutlined,
  OrderedListOutlined,
  SearchOutlined,
  SortAscendingOutlined,
  SortDescendingOutlined,
} from "@ant-design/icons-vue";

import { useRuntimeStore } from "@/options/stores/runtime.ts";
import { useMetadataStore } from "@/options/stores/metadata.ts";
import { formValidateRules } from "@/options/utils.ts";
import type { ISearchSolution, ISearchSolutionMetadata, TSolutionKey } from "@/shared/types.ts";

import SolutionLabel from "./SolutionLabel.vue";
import { isDuplicateSearchSolution } from "./utils.ts";
import SiteCategoryPanel from "./SiteCategoryPanel.vue";
import SiteName from "@/options/components/SiteName.vue";
import SiteFavicon from "@/options/components/SiteFavicon/Index.vue";

const showDialog = defineModel<boolean>();
const solutionId = defineModel<TSolutionKey>("solutionId");

const { t } = useI18n();

const initSolution = () =>
  ({
    id: nanoid(),
    name: "",
    sort: 1,
    enabled: true,
    isDefault: false,
    createdAt: Date.now(),
    solutions: [],
  }) as ISearchSolutionMetadata;

const metadataStore = useMetadataStore();
const runtimeStore = useRuntimeStore();

const solution = ref<ISearchSolutionMetadata>(initSolution());

const nameRules = [formValidateRules.require()];

function firstError(rules: ((v: unknown) => boolean | string)[], value: unknown): string | undefined {
  for (const rule of rules) {
    const result = rule(value);
    if (result !== true) return typeof result === "string" ? result : String(result);
  }
  return undefined;
}

const nameError = computed(() => firstError(nameRules, solution.value.name));
// 与迁移前 PtdForm 广播的「表单是否合法」语义一致：任一字段的 rules 未通过即为不合法
const formValid = computed(() => !nameError.value);

const siteWaitFilter = ref("");
const siteFilter = refDebounced(siteWaitFilter, 500); // 延迟搜索过滤词的生成

const addedSiteInfo = shallowRef<Array<{ siteId: string; isDead: boolean; siteName: string; siteUrl: string }>>([]);

// 每个站点在当前方案右侧已添加的方案数（同一站点允许以不同参数多次添加）
const addedCountBySite = computed<Record<string, number>>(() => {
  const counts: Record<string, number> = {};
  for (const s of solution.value.solutions) {
    counts[s.siteId] = (counts[s.siteId] ?? 0) + 1;
  }
  return counts;
});

// 已添加次数排序：asc（未添加在前）-> desc（添加多的在前）-> 无（保持默认次序）循环切换
type TAddedCountSort = "asc" | "desc" | null;
const addedCountSort = ref<TAddedCountSort>(null);

function cycleAddedCountSort() {
  addedCountSort.value = addedCountSort.value === null ? "asc" : addedCountSort.value === "asc" ? "desc" : null;
}

const filteredSite = computed(() => {
  const filter = (siteFilter.value ?? "").toLowerCase();

  const sites = addedSiteInfo.value
    .filter((item) => {
      const siteKey = [item.siteId, item.siteName, item.siteUrl]
        .filter(Boolean)
        .map((x: string) => x.toLowerCase())
        .join("|");
      return siteKey.includes(filter);
    })
    .map((item) => item.siteId);

  if (addedCountSort.value) {
    // 按已添加次数排序；次数相同时保持原有顺序（稳定排序）
    const dir = addedCountSort.value === "asc" ? 1 : -1;
    sites.sort((a, b) => ((addedCountBySite.value[a] ?? 0) - (addedCountBySite.value[b] ?? 0)) * dir);
  }
  return sites;
});

// 同一个筛选词也作用于右侧已添加方案列表：按站点 id / 名称 / URL 匹配（与左侧口径一致）
const filteredSolutions = computed(() => {
  const filter = (siteFilter.value ?? "").toLowerCase();
  if (!filter) return solution.value.solutions;
  return solution.value.solutions.filter((item) => {
    const meta = metadataStore.sites[item.siteId];
    const siteKey = [item.siteId, meta?.name, meta?.url]
      .filter(Boolean)
      .map((x: string) => x.toLowerCase())
      .join("|");
    return siteKey.includes(filter);
  });
});

function addSolution(addSolution: ISearchSolution) {
  // 基于 siteId 和 selectedCategories / name 判断是否已存在，如果存在则不添加
  if (find(solution.value.solutions, (item) => isDuplicateSearchSolution(item, addSolution))) {
    runtimeStore.showSnackbar(t("SetSearchSolution.edit.cantAddByDuplicateNote"), { color: "error" });
    return;
  }

  solution.value.solutions.push(addSolution);
}

function removeSolution(removeSolution: ISearchSolution) {
  solution.value.solutions = solution.value.solutions.filter(
    (x) => !(x.id == removeSolution.id && x.siteId == removeSolution.siteId),
  );
}

function saveSolutionState() {
  metadataStore.addSearchSolution(solution.value);
  showDialog.value = false;
}

function dialogEnter() {
  siteWaitFilter.value = ""; // 进入时清空筛选词，避免上次残留影响左右两侧显示
  // 生成站点列表
  Promise.all(
    metadataStore.getAddedSiteIds
      // OPTIONSSETTINGS-10：站点列表是按快照取的，期间可能被另一个上下文删除，
      // 这里与模板一样不能裸解引用 metadataStore.sites[siteId]
      .sort((a, b) => Number(!!metadataStore.sites[b]?.allowSearch) - Number(!!metadataStore.sites[a]?.allowSearch))
      .map(async (siteId) => ({
        siteId,
        isDead: (await metadataStore.getSiteMergedMetadata(siteId, "isDead")) ?? false,
        siteName: await metadataStore.getSiteName(siteId),
        siteUrl: await metadataStore.getSiteUrl(siteId),
      })),
  ).then((siteInfos) => {
    addedSiteInfo.value = siteInfos.filter((site) => !site.isDead);
  });

  let storedSolution = metadataStore.solutions[solutionId.value!];
  if (!storedSolution) {
    storedSolution = initSolution();
  }

  solution.value = cloneDeep(storedSolution);
}

function dialogLeave() {
  solution.value = initSolution();
}

// 原生 a-modal 没有 afterOpenChange（只有 afterClose），打开时的初始化自行监听 open。
watch(showDialog, (open) => {
  if (open) nextTick(dialogEnter);
});
</script>

<template>
  <a-modal
    v-model:open="showDialog"
    :cancel-text="t('common.dialog.cancel')"
    :ok-button-props="{ disabled: !formValid || solution.solutions.length === 0 }"
    :ok-text="t('common.dialog.ok')"
    :style="{ top: 0, paddingBottom: 0, maxWidth: 'none' }"
    :title="t('SetSearchSolution.edit.title')"
    :width="'100vw'"
    :after-close="dialogLeave"
    @ok="saveSolutionState"
  >
    <a-form layout="vertical">
      <a-row :gutter="16">
        <a-col :flex="1">
          <a-form-item :help="nameError" :label="t('common.name')" required>
            <a-input v-model:value="solution.name" :status="nameError ? 'error' : undefined" />
          </a-form-item>
        </a-col>
        <a-col :span="6">
          <a-form-item label="ID">
            <a-input v-model:value="solution.id" disabled />
          </a-form-item>
        </a-col>
        <a-col :span="4">
          <a-form-item :label="t('common.sortIndex')">
            <a-input-number v-model:value="solution.sort" :max="100" :min="0" style="width: 100%" />
          </a-form-item>
        </a-col>
      </a-row>
      <a-row :gutter="16">
        <a-col :md="16" :xs="24">
          <a-form-item>
            <a-flex :gap="8">
              <a-input
                v-model:value="siteWaitFilter"
                allow-clear
                :placeholder="t('SetSearchSolution.edit.filterPlaceholder')"
                style="flex: 1"
              >
                <template #prefix><ClusterOutlined /></template>
                <template #suffix><SearchOutlined /></template>
              </a-input>
              <a-tooltip :title="t('SetSearchSolution.edit.sortByAddedCount')">
                <a-button :type="addedCountSort ? 'primary' : 'default'" @click="cycleAddedCountSort">
                  <template #icon>
                    <SortAscendingOutlined v-if="addedCountSort === 'asc'" />
                    <SortDescendingOutlined v-else-if="addedCountSort === 'desc'" />
                    <OrderedListOutlined v-else />
                  </template>
                </a-button>
              </a-tooltip>
            </a-flex>
          </a-form-item>

          <a-card :bordered="false" :style="{ height: 'calc(100vh - 340px)', overflowY: 'auto' }">
            <a-collapse>
              <!-- OPTIONSSETTINGS-10：站点可能已被另一个上下文删除（跨上下文删除会同步进 store），
                   裸解引用 metadataStore.sites[site].isOffline 会让整个弹窗渲染中断；找不到站点时禁用该面板 -->
              <a-collapse-panel
                v-for="site in filteredSite"
                :key="site"
                :disabled="metadataStore.sites[site] ? !!metadataStore.sites[site].isOffline : true"
              >
                <template #header>
                  <a-flex align="center" :gap="8">
                    <SiteFavicon :site-id="site" :size="18" style="margin-right: 8px" />
                    <a-tag :color="addedCountBySite[site] ? 'green' : 'default'">
                      <SiteName :site-id="site" />
                    </a-tag>
                    <a-tooltip
                      v-if="addedCountBySite[site]"
                      :title="t('SetSearchSolution.edit.siteAddedCount', [addedCountBySite[site]])"
                    >
                      <a-tag :color="addedCountBySite[site] === 1 ? 'success' : 'warning'">
                        ×{{ addedCountBySite[site] }}
                      </a-tag>
                    </a-tooltip>
                  </a-flex>
                </template>
                <SiteCategoryPanel :site-id="site" @update:solution="addSolution" />
              </a-collapse-panel>
            </a-collapse>
          </a-card>
        </a-col>
        <a-col :md="8" :xs="24">
          <div class="ptd-section-heading" style="margin-top: 0">
            {{ t("SetSearchSolution.edit.addCount", [solution.solutions.length]) }}
          </div>

          <a-card :bordered="false" :style="{ height: 'calc(100vh - 330px)', overflowY: 'auto' }">
            <div
              v-if="siteFilter && filteredSolutions.length === 0 && solution.solutions.length > 0"
              style="color: var(--ptd-text-secondary); margin-bottom: 8px"
            >
              {{ t("SetSearchSolution.edit.noMatchInFilteredSolutions") }}
            </div>
            <SolutionLabel closable column :solutions="filteredSolutions" @remove:solution="removeSolution" />
          </a-card>
        </a-col>
      </a-row>
    </a-form>
  </a-modal>
</template>
