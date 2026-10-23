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
  sanitizeSearchEntryRequestConfig,
  type TSelectCategory,
} from "./utils.ts";

import SiteName from "@/options/components/SiteName.vue";

const showDialog = defineModel<boolean>();

const { siteId, selectCategory, saveGeneratedSolution } = defineProps<{
  siteId: TSiteID;
  selectCategory: TSelectCategory;
  saveGeneratedSolution: (searchSolution: ISearchSolution) => void;
}>();

const { t, te } = useI18n();

/** 新增文案尚未进入语言包时回退英文（keys 见 fix report 的「需 G/F1 跟进」） */
function tWithFallback(key: string, fallback: string, args?: Record<string, unknown>): string {
  return te(key) ? t(key, args as any) : fallback;
}

const searchSolution = ref<ISearchSolution>({} as ISearchSolution);
const searchSolutionEntryRequestConfig = ref<string>("");

const nameRules = [formValidateRules.require()];
const requestConfigRules = [
  formValidateRules.require(),
  (v: any) => isJSON(v) || t("SetSearchSolution.CustomSolutionDialog.requestConfigJsonError"),
  // F2-High-14 / N5：自定义请求配置同样只允许 params / data。
  // 站点层会把 requestConfig `toMerged` 进 axios 配置，`url` / `baseURL` / `headers` 等于把
  // 带凭据的请求改写到任意地址（手工输入也应被拦下，而不是等到导入时才处理）。
  (v: any) => {
    try {
      const { removedKeys } = sanitizeSearchEntryRequestConfig(JSON.parse(v));
      if (removedKeys.length === 0) return true;
      return tWithFallback(
        "SetSearchSolution.CustomSolutionDialog.requestConfigUnsafeFields",
        'Request config may only contain "params" / "data". Remove: {fields}',
        { fields: removedKeys.join(", ") },
      );
    } catch {
      return true; // JSON 语法错误由上面的规则提示，避免同一输入框报两种错
    }
  },
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

  // 解析 requestConfig（纵深防御：即使绕过表单校验，也绝不会把 url / baseURL / headers 写入方案）
  try {
    const { requestConfig, removedKeys } = sanitizeSearchEntryRequestConfig(
      JSON.parse(searchSolutionEntryRequestConfig.value),
    );
    if (removedKeys.length > 0) return;

    if (searchSolution.value.searchEntries && searchSolution.value.id) {
      searchSolution.value.searchEntries[searchSolution.value.id] ??= {}; // 防止 default 情况下无法赋值
      searchSolution.value.searchEntries[searchSolution.value.id].requestConfig = requestConfig ?? {};
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
