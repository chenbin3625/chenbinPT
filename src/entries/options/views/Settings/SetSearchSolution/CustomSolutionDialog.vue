<script setup lang="ts">
import { nextTick, ref, watch, computed } from "vue";
import { nanoid } from "nanoid";
import { useI18n } from "vue-i18n";
import { isJSON } from "es-toolkit";
import type { TSiteID } from "@ptd/site";

import type { ISearchSolution } from "@/shared/types/storages/metadata.ts";
import { formValidateRules } from "@/options/utils.ts";

import {
  generateSiteSearchSolution,
  getCategoryName,
  getCategoryOptionName,
  getSiteMetaCategory,
  type TSelectCategory,
} from "./utils.ts";

import SiteName from "@/options/components/SiteName.vue";

const showDialog = defineModel<boolean>();

const { siteId, selectCategory, saveGeneratedSolution } = defineProps<{
  siteId: TSiteID;
  selectCategory: TSelectCategory;
  saveGeneratedSolution: (searchSolution: ISearchSolution) => void;
}>();

const { t } = useI18n();

const searchSolution = ref<ISearchSolution>({} as ISearchSolution);
const searchSolutionEntryRequestConfig = ref<string>("");

const nameRules = [formValidateRules.require()];
const requestConfigRules = [
  formValidateRules.require(),
  (v: any) => isJSON(v) || t("SetSearchSolution.CustomSolutionDialog.requestConfigJsonError"),
];

function firstError(rules: ((v: unknown) => boolean | string)[], value: unknown): string | undefined {
  for (const rule of rules) {
    const result = rule(value);
    if (result !== true) return typeof result === "string" ? result : String(result);
  }
  return undefined;
}

const nameError = computed(() => firstError(nameRules, searchSolution.value.name));
const requestConfigError = computed(() => firstError(requestConfigRules, searchSolutionEntryRequestConfig.value));
// 与迁移前 PtdForm 广播的「表单是否合法」语义一致：任一字段的 rules 未通过即为不合法
const formValid = computed(() => !nameError.value && !requestConfigError.value);

async function onEnter() {
  // 首先按照默认值生成一次基本情况
  searchSolution.value = await generateSiteSearchSolution(siteId, selectCategory);

  if (searchSolution.value.id === "default") {
    searchSolution.value.id = nanoid(); // 如果是默认id，则生成一个新的id
    searchSolution.value.name = ""; // 清空name
  } else {
    // 为这个 searchSolution 生成默认 name
    const siteMetaCategory = await getSiteMetaCategory(siteId);

    searchSolution.value.name = Object.entries(searchSolution.value.selectedCategories!)
      .map(([category, value]) => {
        return (
          getCategoryName(siteMetaCategory, category) + ": " + getCategoryOptionName(siteMetaCategory, category, value)
        );
      })
      .join(";");

    // 脱钩 selectedCategories，因为 name 已经包含了这些信息
    delete searchSolution.value.selectedCategories;
  }

  // 生成 requestConfig 的 JSON 字符串
  searchSolutionEntryRequestConfig.value = JSON.stringify(
    searchSolution.value.searchEntries?.[searchSolution.value.id]?.requestConfig ?? { params: {}, data: {} },
    null,
    2,
  );
}

function doSubmit() {
  if (!formValid.value) return;

  // 解析 requestConfig
  try {
    const requestConfig = JSON.parse(searchSolutionEntryRequestConfig.value);
    if (searchSolution.value.searchEntries && searchSolution.value.id) {
      searchSolution.value.searchEntries[searchSolution.value.id] ??= {}; // 防止 default 情况下无法赋值
      searchSolution.value.searchEntries[searchSolution.value.id].requestConfig = requestConfig;
    }
  } catch (e) {
    console.error("请求配置 JSON 解析失败", e);
    return;
  }

  // 回调父组件
  saveGeneratedSolution(searchSolution.value);

  // 关闭对话框
  showDialog.value = false;
}

// 原生 a-modal 没有 afterOpenChange（只有 afterClose），打开时的初始化自行监听 open。
watch(showDialog, (open) => {
  if (open) nextTick(onEnter);
});
</script>

<template>
  <a-modal
    v-model:open="showDialog"
    :cancel-text="t('common.dialog.cancel')"
    :ok-button-props="{ disabled: !formValid }"
    :ok-text="t('common.dialog.ok')"
    :width="800"
    @ok="doSubmit"
  >
    <template #title>
      {{ t("SetSearchSolution.CustomSolutionDialog.title") }}
      [ <SiteName :site-id="siteId" tag="span" class="" /> ]
    </template>

    <a-form layout="vertical">
      <a-form-item :help="nameError" :label="t('SetSearchSolution.CustomSolutionDialog.solutionName')" required>
        <a-input v-model:value="searchSolution.name" :status="nameError ? 'error' : undefined" />
      </a-form-item>

      <a-form-item
        :extra="t('SetSearchSolution.CustomSolutionDialog.requestConfigHint')"
        :help="requestConfigError"
        :label="t('SetSearchSolution.CustomSolutionDialog.requestConfig')"
        required
      >
        <a-textarea
          v-model:value="searchSolutionEntryRequestConfig"
          :auto-size="{ minRows: 4, maxRows: 16 }"
          :status="requestConfigError ? 'error' : undefined"
        />
      </a-form-item>
    </a-form>
  </a-modal>
</template>
