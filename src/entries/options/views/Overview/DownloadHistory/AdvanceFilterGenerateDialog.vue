<script setup lang="ts">
import { computed, nextTick, watch } from "vue";
import dayjs from "dayjs";
import { useI18n } from "vue-i18n";
import { addDays, startOfDay } from "date-fns";

import { formatDate } from "@/options/utils.ts";
import { tableCustomFilter } from "@/options/views/Overview/DownloadHistory/utils.ts";

import SiteName from "@/options/components/SiteName.vue";
import SiteFavicon from "@/options/components/SiteFavicon/Index.vue";
import DownloaderLabel from "@/options/components/DownloaderLabel.vue";
import { setDateRangeByDatePicker, getThisDateUnitRange } from "@/options/directives/useAdvanceFilter.ts";
import {
  cycleKeywordFilterState,
  keywordFilterStateOf,
  resolveFiniteRangeDays,
} from "@/options/views/Overview/DownloadHistory/advanceFilter.ts";

const showDialog = defineModel<boolean>();

const { t } = useI18n();

/** Vuetify ticks -> antd marks（只用刻度点，不显示刻度文案） */
const tickMarks = (ticks: number[] | undefined) => Object.fromEntries((ticks ?? []).map((tick) => [tick, ""]));

const {
  advanceItemPropsRef,
  advanceFilterDictRef,
  reBuildFilterCountRef,
  reBuildAdvanceFilter,
  updateTableFilterValueFn,
} = tableCustomFilter;

/**
 * I1：站点 / 下载器的「三态」复选框。
 *
 * 原先同时绑 `@click.stop="toggleKeywordStateFn"` 与 `@update:checked`，真实事件顺序（click 先于
 * update:checked）下三态被打乱：「既不在 required 也不在 exclude」的状态不可达，用户无法单独取消
 * 某个筛选项（只能整体重置）。这里用单一 handler 实现 required → exclude → none 循环，
 * 不再依赖 checkbox 自身的 checked 变更，因此也不需要 `@update:checked`。
 */
function cycleKeywordState(field: "siteId" | "downloaderId", value: string) {
  cycleKeywordFilterState(advanceFilterDictRef.value[field] as any, value);
}

function keywordStateOf(field: "siteId" | "downloaderId", value: string) {
  return keywordFilterStateOf(advanceFilterDictRef.value[field] as any, value);
}

/**
 * I2：日期滑块的可用区间。
 *
 * `generateRangeField()` 在没有任何可解析时间戳时返回 `[-Infinity, Infinity]`（下载历史为空 /
 * 尚未加载完时打开弹窗）。把 Infinity 直接交给 a-slider 的 :min/:max 会得到 NaN 位置的手柄，
 * 自定义日期挑选也不可用。这里回落到「最近 30 天 ~ 现在」作为**展示**区间，
 * 但不改写字典（`[-Infinity, Infinity]` 仍表示「不参与日期筛选」）。
 */
const downloadAtRange = computed<[number, number]>(() =>
  resolveFiniteRangeDays(advanceItemPropsRef.value.downloadAt?.range as [number, number] | undefined),
);

/** 滑块显示值：字典里缺省/无限区间时按全范围展示（拖动前不改写字典） */
const downloadAtSliderValue = computed<[number, number]>({
  get: (): [number, number] => {
    const value = advanceFilterDictRef.value.downloadAt as [number, number] | undefined;
    if (!value || !Number.isFinite(value[0]) || !Number.isFinite(value[1])) return downloadAtRange.value;
    return [value[0], value[1]];
  },
  set: (value: [number, number]) => {
    advanceFilterDictRef.value.downloadAt = value;
  },
});

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
            :checked="keywordStateOf('siteId', site) === 'required'"
            :indeterminate="keywordStateOf('siteId', site) === 'exclude'"
            @click.prevent.stop="() => cycleKeywordState('siteId', site)"
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
            :checked="keywordStateOf('downloaderId', downloader) === 'required'"
            :indeterminate="keywordStateOf('downloaderId', downloader) === 'exclude'"
            @click.prevent.stop="() => cycleKeywordState('downloaderId', downloader)"
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
              @click="() => (advanceFilterDictRef.downloadAt = getThisDateUnitRange(dateUnit, downloadAtRange))"
            >
              {{ t(`common.AdvanceFilterGenerateDialog.dateUnit.${dateUnit}`) }}
            </a-tag>
            <a-popover placement="top" trigger="click">
              <template #content>
                <a-range-picker
                  :value="[dayjs(downloadAtRange[0]), dayjs(downloadAtRange[1])]"
                  :disabled-date="
                    (date: any) =>
                      date.isBefore(dayjs(startOfDay(new Date(downloadAtRange[0]))), 'day') ||
                      date.isAfter(dayjs(addDays(new Date(downloadAtRange[1]), 1)), 'day')
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
            <!-- OPTIONSOVERVIEW-1：downloadAt 是 [min,max] 元组（useAdvanceFilter 的 ranges 分支就是这么初始化的），
                 而 antd 的 a-slider 只有传 range 才走双滑块实现。缺了它 a-slider 按单值渲染，
                 拖动一次就把元组改写成标量，「生成」时 stringifyFilterDictFn 的 `.map()` 抛 TypeError，
                 弹窗既不关闭也无提示。 -->
            <a-slider
              v-model:value="downloadAtSliderValue"
              range
              :marks="tickMarks(advanceItemPropsRef.downloadAt?.ticks)"
              :max="downloadAtRange[1]"
              :min="downloadAtRange[0]"
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
