<script setup lang="ts">
import { nextTick, watch } from "vue";
import dayjs from "dayjs";
import { useI18n } from "vue-i18n";
import { addDays, startOfDay } from "date-fns";

import { formatDate } from "@/options/utils.ts";
import { tableCustomFilter } from "@/options/views/Overview/DownloadHistory/utils.ts";

import SiteName from "@/options/components/SiteName.vue";
import SiteFavicon from "@/options/components/SiteFavicon/Index.vue";
import DownloaderLabel from "@/options/components/DownloaderLabel.vue";
import { setDateRangeByDatePicker, getThisDateUnitRange } from "@/options/directives/useAdvanceFilter.ts";

const showDialog = defineModel<boolean>();

const { t } = useI18n();

/** Vuetify ticks -> antd marks（只用刻度点，不显示刻度文案） */
const tickMarks = (ticks: number[] | undefined) => Object.fromEntries((ticks ?? []).map((tick) => [tick, ""]));

const {
  advanceItemPropsRef,
  advanceFilterDictRef,
  reBuildFilterCountRef,
  toggleKeywordStateFn,
  reBuildAdvanceFilter,
  updateTableFilterValueFn,
} = tableCustomFilter;

function updateTableFilter() {
  updateTableFilterValueFn();
  showDialog.value = false;
}

function enterDialog() {
  reBuildAdvanceFilter();
}

// 原生 a-modal 没有 afterOpenChange（只有 afterClose），打开时的初始化自行监听 open。
watch(showDialog, (open) => {
  if (open) nextTick(enterDialog);
});
</script>

<template>
  <a-modal v-model:open="showDialog" :title="t('common.AdvanceFilterGenerateDialog.title')" :width="800">
    <div style="padding: 0">
      <a-row :gutter="0"
        ><a-typography-text>{{ t("common.AdvanceFilterGenerateDialog.keywords") }}</a-typography-text>
      </a-row>
      <a-row :gutter="8" style="margin-top: 0">
        <a-col flex="1 1 0">
          <a-select
            v-model:value="advanceFilterDictRef.text.required"
            mode="tags"
            allow-clear
            :placeholder="t('common.AdvanceFilterGenerateDialog.required')"
            style="width: 100%"
          />
        </a-col>
        <a-col flex="1 1 0">
          <a-select
            v-model:value="advanceFilterDictRef.text.exclude"
            mode="tags"
            allow-clear
            :placeholder="t('common.AdvanceFilterGenerateDialog.exclude')"
            style="width: 100%"
          />
        </a-col>
      </a-row>
      <a-row :gutter="0"
        ><a-typography-text>{{ t("common.AdvanceFilterGenerateDialog.site") }}</a-typography-text></a-row
      >
      <!-- V-21：`:indeterminate` 必须是计算值。硬编码的 `true` 会让每个复选框永远显示半选横杠，
           用户无法判断哪些筛选已生效。这里的真实三态：checked = required（只保留）、
           indeterminate = exclude（排除）、未勾选 = 不参与筛选。 -->
      <a-row :gutter="0">
        <a-col v-for="site in advanceItemPropsRef.siteId" :key="`${reBuildFilterCountRef}_${site}`" :span="12" :sm="6">
          <a-checkbox
            :checked="advanceFilterDictRef.siteId.required.includes(site)"
            :indeterminate="advanceFilterDictRef.siteId.exclude.includes(site)"
            @click.stop="() => toggleKeywordStateFn('siteId', site)"
            @update:checked="
              (checked: boolean) => {
                const current = advanceFilterDictRef.siteId.required;
                advanceFilterDictRef.siteId.required = checked
                  ? Array.from(new Set([...current, site]))
                  : current.filter((x: any) => x !== site);
              }
            "
          >
            <SiteFavicon :site-id="site" :size="16" style="margin-right: 8px" />
            <SiteName :site-id="site" tag="span" style="text-decoration: none" />
          </a-checkbox>
        </a-col>
      </a-row>
      <a-row :gutter="0"
        ><a-typography-text>{{ t("DownloadHistory.AdvanceFilterGenerateDialog.downloader") }}</a-typography-text></a-row
      >
      <a-row :gutter="0">
        <a-col
          v-for="downloader in advanceItemPropsRef.downloaderId"
          :key="`${reBuildFilterCountRef}_${downloader}`"
          :span="24"
          :sm="12"
        >
          <a-checkbox
            :checked="advanceFilterDictRef.downloaderId.required.includes(downloader)"
            :indeterminate="advanceFilterDictRef.downloaderId.exclude.includes(downloader)"
            @click.stop="() => toggleKeywordStateFn('downloaderId', downloader)"
            @update:checked="
              (checked: boolean) => {
                const current = advanceFilterDictRef.downloaderId.required;
                advanceFilterDictRef.downloaderId.required = checked
                  ? Array.from(new Set([...current, downloader]))
                  : current.filter((x: any) => x !== downloader);
              }
            "
          >
            <DownloaderLabel :downloader="downloader" />
          </a-checkbox>
        </a-col>
      </a-row>
      <!-- TODO 下载状态 -->
      <a-row :gutter="0">
        <a-col :span="24">
          <a-row :gutter="0" style="padding-right: 16px">
            <a-typography-text>{{ t("common.AdvanceFilterGenerateDialog.date") }}</a-typography-text>
            <div style="flex: 1 1 auto"></div>
            <a-tag
              v-for="dateUnit in ['day', 'week', 'month', 'quarter', 'year'] as const"
              :key="dateUnit"
              style="margin-right: 4px"
              @click="
                () =>
                  (advanceFilterDictRef.downloadAt = getThisDateUnitRange(
                    dateUnit,
                    advanceItemPropsRef.downloadAt.range,
                  ))
              "
            >
              {{ t(`common.AdvanceFilterGenerateDialog.dateUnit.${dateUnit}`) }}
            </a-tag>
            <a-popover placement="top" trigger="click">
              <template #content>
                <a-range-picker
                  :value="[
                    dayjs(advanceItemPropsRef.downloadAt.range[0]),
                    dayjs(advanceItemPropsRef.downloadAt.range[1]),
                  ]"
                  :disabled-date="
                    (date: any) =>
                      date.isBefore(dayjs(startOfDay(new Date(advanceItemPropsRef.downloadAt.range[0]))), 'day') ||
                      date.isAfter(dayjs(addDays(new Date(advanceItemPropsRef.downloadAt.range[1]), 1)), 'day')
                  "
                  @change="
                    (values: any) => {
                      // 清空日期时 antd 会传 null，不判空会抛 TypeError
                      if (!values) return;
                      advanceFilterDictRef.downloadAt = setDateRangeByDatePicker(values.map((v: any) => v.toDate()));
                    }
                  "
                />
              </template>
              <a-tag>{{ t("common.AdvanceFilterGenerateDialog.dateUnit.custom") }}</a-tag>
            </a-popover>
          </a-row>
          <a-row :gutter="0">
            <a-slider
              v-model:value="advanceFilterDictRef.downloadAt"
              :marks="tickMarks(advanceItemPropsRef.downloadAt.ticks)"
              :max="advanceItemPropsRef.downloadAt.range[1]"
              :min="advanceItemPropsRef.downloadAt.range[0]"
              :step="60 * 1000"
              :tip-formatter="(value: number) => formatDate(value ?? 0, 'yyyy-MM-dd HH:mm')"
              style="padding: 0 24px"
            />
          </a-row>
        </a-col>
      </a-row>
    </div>

    <template #footer>
      <a-flex align="center" justify="space-between">
        <a-flex align="center" :gap="8">
          <a-button type="text" @click="() => reBuildAdvanceFilter(true)">
            {{ t("common.AdvanceFilterGenerateDialog.reset") }}
          </a-button>
        </a-flex>
        <a-flex align="center" :gap="8">
          <a-button @click="showDialog = false">{{ t("common.dialog.cancel") }}</a-button>
          <a-button type="primary" @click="updateTableFilter">
            {{ t("common.AdvanceFilterGenerateDialog.generate") }}
          </a-button>
        </a-flex>
      </a-flex>
    </template>
  </a-modal>
</template>
