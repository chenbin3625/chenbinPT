<script setup lang="ts">
import { nanoid } from "nanoid";
import { computed, nextTick, ref, shallowRef, watch } from "vue";
import { useI18n } from "vue-i18n";
import { cloneDeep, isEqual } from "es-toolkit";
import { find, isEmpty } from "es-toolkit/compat";
import { refDebounced } from "@vueuse/core";
import { ClusterOutlined, SearchOutlined } from "@ant-design/icons-vue";

import { useRuntimeStore } from "@/options/stores/runtime.ts";
import { useMetadataStore } from "@/options/stores/metadata.ts";
import { formValidateRules } from "@/options/utils.ts";
import type { ISearchSolution, ISearchSolutionMetadata, TSolutionKey } from "@/shared/types.ts";

import SolutionLabel from "./SolutionLabel.vue";
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

const filteredSite = computed(() => {
  const filter = (siteFilter.value ?? "").toLowerCase();

  return addedSiteInfo.value
    .filter((item) => {
      const siteKey = [item.siteId, item.siteName, item.siteUrl]
        .filter(Boolean)
        .map((x: string) => x.toLowerCase())
        .join("|");
      return siteKey.includes(filter);
    })
    .map((item) => item.siteId);
});

function addSolution(addSolution: ISearchSolution) {
  // 基于 siteId 和 selectedCategories / name 判断是否已存在，如果存在则不添加
  if (
    find(solution.value.solutions, (item) => {
      return (
        item.siteId === addSolution.siteId &&
        ((!isEmpty(item.selectedCategories) && isEqual(item.selectedCategories, addSolution.selectedCategories)) ||
          (typeof item.name !== "undefined" && item.name === addSolution.name))
      );
    })
  ) {
    runtimeStore.showSnakebar(t("SetSearchSolution.edit.cantAddByDuplicateNote"), { color: "error" });
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
  // 生成站点列表
  Promise.all(
    metadataStore.getAddedSiteIds
      .sort((a, b) => Number(metadataStore.sites[b].allowSearch) - Number(metadataStore.sites[a].allowSearch))
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
            <a-input
              v-model:value="siteWaitFilter"
              allow-clear
              :placeholder="t('SetSearchSolution.edit.filterPlaceholder')"
            >
              <template #prefix><ClusterOutlined /></template>
              <template #suffix><SearchOutlined /></template>
            </a-input>
          </a-form-item>

          <a-card :bordered="false" :style="{ height: 'calc(100vh - 340px)', overflowY: 'auto' }">
            <a-collapse>
              <a-collapse-panel
                v-for="site in filteredSite"
                :key="site"
                :disabled="!!metadataStore.sites[site].isOffline"
              >
                <template #header>
                  <a-flex align="center" :gap="8">
                    <SiteFavicon :site-id="site" :size="18" style="margin-right: 8px" />
                    <a-tag color="green">
                      <SiteName :site-id="site" />
                    </a-tag>
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
            <SolutionLabel closable column :solutions="solution.solutions" @remove:solution="removeSolution" />
          </a-card>
        </a-col>
      </a-row>
    </a-form>
  </a-modal>
</template>
