<script setup lang="ts">
import { onMounted, ref, shallowRef } from "vue";
import { useI18n } from "vue-i18n";
import { ArrowRightOutlined, EditOutlined, SyncOutlined } from "@ant-design/icons-vue";
import type { ISearchCategories, TSiteID } from "@ptd/site";

import {
  generateSiteSearchSolution,
  getSiteMetaCategory,
  isDefaultCategory,
  radioDefault,
  type TSelectCategory,
} from "./utils.ts";

import CustomSolutionDialog from "./CustomSolutionDialog.vue";
import PageSkeleton from "@/options/components/PageSkeleton.vue";
import NoDataPlaceholder from "@/options/components/NoDataPlaceholder.vue";
import type { ISearchSolution } from "@/shared/types/storages/metadata.ts";

const { siteId } = defineProps<{
  siteId: TSiteID;
}>();

const emit = defineEmits(["update:solution"]);

const { t } = useI18n();
const showCustomSolutionDialog = ref(false);

const selectCategory = ref<TSelectCategory>({});
const siteMetaCategory = shallowRef<ISearchCategories[]>([]);
// 站点搜索分类需按站点定义异步读取，加载完成前不能把空数组渲染成「该站点未定义搜索模块」
const isLoadingSiteMetaCategory = ref<boolean>(true);

function resetSelectCategory() {
  for (const category of siteMetaCategory.value) {
    selectCategory.value[category.key] = category.cross ? [] : radioDefault;
  }
}

const showPanel = ref<any[]>([]);

function checkBtnIndeterminate(category: ISearchCategories): boolean {
  const field = selectCategory.value[category.key];
  if (Array.isArray(field)) {
    return field.length !== category.options.length;
  }
  return false;
}

function clickAllBtn(field: ISearchCategories, toggle: boolean) {
  let fieldSp: any = [];
  if (toggle) {
    fieldSp = toggle ? field.options.map((sp) => sp.value) : [];
  }

  selectCategory.value[field.key] = fieldSp;
}

async function showCustomSolutionDialogFn() {
  showCustomSolutionDialog.value = true;
}

function saveGeneratedSolution(searchSolution: ISearchSolution) {
  emit("update:solution", searchSolution);

  // 重置本 expansion panel 的数据
  resetSelectCategory();
}

async function generateSolution() {
  const searchSolution = await generateSiteSearchSolution(siteId, selectCategory.value!);
  saveGeneratedSolution(searchSolution);
}

onMounted(async () => {
  isLoadingSiteMetaCategory.value = true;
  try {
    siteMetaCategory.value = await getSiteMetaCategory(siteId);
    resetSelectCategory();
  } finally {
    isLoadingSiteMetaCategory.value = false;
  }
});
</script>

<template>
  <div>
    <a-row :gutter="0" align="middle">
      <a-col class="ptd-col-category-select" :flex="1">
        <!-- 分类列表按站点定义异步加载：加载中用骨架屏，加载完成后为空才是真正的「无分类」 -->
        <PageSkeleton v-if="isLoadingSiteMetaCategory" :count="3" :rows="3" variant="list" />
        <a-collapse v-else-if="siteMetaCategory!.length > 0" v-model:active-key="showPanel">
          <a-collapse-panel v-for="category in siteMetaCategory" :key="category.key">
            <template #header>
              <a-flex align="center" :gap="4">
                <span>{{ category.name }}</span>
                <a-typography-text type="secondary">{{ category.notes ?? "" }}</a-typography-text>
                <span style="flex: 1 1 auto; min-width: 8px" />
                <a-tag :color="isDefaultCategory(selectCategory[category.key]) ? undefined : 'blue'">
                  {{ category.key }}
                </a-tag>
              </a-flex>
            </template>

            <div>
              <!-- 如果该类别支持多选，则显示全选按钮 -->
              <a-row v-if="category.cross && category.cross.mode" :gutter="0">
                <a-col :span="24">
                  <a-checkbox
                    :checked="!checkBtnIndeterminate(category)"
                    :indeterminate="
                      (selectCategory[category.key] as any[])?.length > 0 && checkBtnIndeterminate(category)
                    "
                    @change="(e: any) => clickAllBtn(category, e.target.checked)"
                  >
                    <strong>{{ t("common.checkbox.all") }}</strong>
                    <span v-if="!checkBtnIndeterminate(category)" style="color: var(--ptd-danger)">
                      &nbsp;{{ t("SetSearchSolution.spDialog.selectAllNotice") }}
                    </span>
                  </a-checkbox>
                </a-col>
              </a-row>
              <a-row :gutter="0">
                <!-- 多选类别选项 -->
                <template v-if="category.cross && category.cross.mode">
                  <a-checkbox-group v-model:value="selectCategory[category.key]" style="width: 100%">
                    <a-row :gutter="0">
                      <a-col v-for="options in category.options" :key="options.value" :lg="4" :md="8" :sm="12" :xs="24">
                        <a-checkbox :value="options.value">{{ options.name }}</a-checkbox>
                      </a-col>
                    </a-row>
                  </a-checkbox-group>
                </template>
                <!-- 单选类别选项 -->
                <template v-else>
                  <a-radio-group v-model:value="selectCategory[category.key]" style="width: 100%">
                    <a-row :gutter="0">
                      <!-- 增加一个代表默认的值，说明该类别什么都不选（尊重站点默认）。（不然的话，只能全部重置才能取消选择） -->
                      <a-col :lg="4" :md="8" :sm="12" :xs="24">
                        <a-radio :value="radioDefault">{{ t("SetSite.SiteCategoryPanel.siteDefault") }}</a-radio>
                      </a-col>
                      <a-col v-for="options in category.options" :key="options.value" :lg="4" :md="8" :sm="12" :xs="24">
                        <a-radio :value="options.value">{{ options.name }}</a-radio>
                      </a-col>
                    </a-row>
                  </a-radio-group>
                </template>
              </a-row>
            </div>
          </a-collapse-panel>
        </a-collapse>
        <NoDataPlaceholder v-else :description="t('SetSearchSolution.spDialog.noDefNotice')" />
      </a-col>
      <a-col>
        <a-flex :gap="4" justify="end" vertical>
          <a-button
            :title="t('SetSearchSolution.spDialog.action.reset')"
            danger
            type="text"
            @click="resetSelectCategory"
          >
            <template #icon><SyncOutlined /></template>
          </a-button>
          <a-button
            :title="t('SetSearchSolution.spDialog.action.create')"
            type="text"
            @click="showCustomSolutionDialogFn"
          >
            <template #icon><EditOutlined /></template>
          </a-button>
          <a-button :title="t('SetSearchSolution.spDialog.action.add')" type="text" @click="generateSolution">
            <template #icon><ArrowRightOutlined /></template>
          </a-button>
        </a-flex>
      </a-col>
    </a-row>
  </div>

  <CustomSolutionDialog
    v-model="showCustomSolutionDialog"
    :save-generated-solution="saveGeneratedSolution"
    :select-category="selectCategory"
    :site-id="siteId"
  />
</template>
