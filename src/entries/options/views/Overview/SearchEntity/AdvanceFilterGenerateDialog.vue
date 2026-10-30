<script setup lang="ts">
import {
  ArrowDownOutlined,
  ArrowUpOutlined,
  CheckOutlined,
  DisconnectOutlined,
  PushpinOutlined,
  QuestionCircleOutlined,
} from "@ant-design/icons-vue";
import { computed, nextTick, ref, watch, type Component } from "vue";
import { useI18n } from "vue-i18n";
import dayjs from "dayjs";
import { addDays, startOfDay } from "date-fns";
import { ETorrentStatus, getTorrentVolumeFactors, preDefinedTorrentTagNameSet, sortTorrentTags } from "@ptd/site";

import { formatDate, formatSize } from "@/options/utils.ts";
import { useConfigStore } from "@/options/stores/config.ts";
import { useRuntimeStore } from "@/options/stores/runtime.ts";
import { tableCustomFilter } from "@/options/views/Overview/SearchEntity/utils/filter.ts";
import { setDateRangeByDatePicker, getThisDateUnitRange } from "@/options/directives/useAdvanceFilter.ts";

import SiteName from "@/options/components/SiteName.vue";
import SiteFavicon from "@/options/components/SiteFavicon/Index.vue";

const showDialog = defineModel<boolean>();

const { t } = useI18n();
const configStore = useConfigStore();
const runtimeStore = useRuntimeStore();

const {
  advanceItemPropsRef,
  advanceFilterDictRef,
  reBuildFilterCountRef,
  toggleKeywordStateFn,
  reBuildAdvanceFilter,
  updateTableFilterValueFn,
} = tableCustomFilter;

// 种子状态选项 - 使用 i18n 支持。
// F11：必须是 computed，setup 期常量只会求值一次，切语言后选项名停留在旧语言。
const statusOptions = computed<Array<{ value: ETorrentStatus; label: string; icon: Component; color: string }>>(() => [
  { value: ETorrentStatus.unknown, label: t("torrent.status.unknown"), icon: QuestionCircleOutlined, color: "grey" },
  {
    value: ETorrentStatus.downloading,
    label: t("torrent.status.downloading"),
    icon: ArrowDownOutlined,
    color: "info",
  },
  { value: ETorrentStatus.seeding, label: t("torrent.status.seeding"), icon: ArrowUpOutlined, color: "success" },
  { value: ETorrentStatus.inactive, label: t("torrent.status.inactive"), icon: DisconnectOutlined, color: "grey" },
  { value: ETorrentStatus.completed, label: t("torrent.status.completed"), icon: CheckOutlined, color: "grey" },
]);

const torrentTags = computed(() => sortTorrentTags(advanceItemPropsRef.value.tags));

const showHiddenTags = ref(false);

/** Vuetify ticks -> antd marks（只用刻度点，不显示刻度文案，与原 #tick-label 空插槽一致） */
const tickMarks = (ticks: number[] | undefined) => Object.fromEntries((ticks ?? []).map((tick) => [tick, ""]));

const filteredTorrentTags = computed(() => {
  const hiddenNames = configStore.searchEntifyControl.hiddenTagNames || [];
  return torrentTags.value.filter((tag) => showHiddenTags.value || !hiddenNames.includes(tag.name));
});

/**
 * 列表渲染上限：种子/标签数量很大时，一次性挂载成百上千个 a-checkbox（还有 favicon / SiteName 组件）
 * 会让弹窗打开卡住数秒。首屏只渲染一部分，其余用「显示全部」展开。
 */
const MAX_SITE_OPTIONS = 60;
const MAX_TAG_OPTIONS = 80;

const showAllSites = ref(false);
const showAllTags = ref(false);

const siteOptions = computed<string[]>(() => advanceItemPropsRef.value.site ?? []);
const displayedSites = computed(() =>
  showAllSites.value ? siteOptions.value : siteOptions.value.slice(0, MAX_SITE_OPTIONS),
);
const displayedTorrentTags = computed(() =>
  showAllTags.value ? filteredTorrentTags.value : filteredTorrentTags.value.slice(0, MAX_TAG_OPTIONS),
);

/** 结果里确实存在优惠（免费/折扣）或非正常上传倍率时，才显示对应的滑块 */
const hasPromoData = ref(false);
const hasUploadData = ref(false);

/** 「仅标签」与「不显示」模式下都不显示优惠相关的滑块 */
const showPromoFilters = computed(() => ["factor", "both"].includes(configStore.searchEntifyControl.promotionDisplay));

const promoDownloadMarks = tickMarks([0, 0.25, 0.5, 0.75, 1]);
const promoUploadMarks = tickMarks([0, 1, 2, 3]);

function updateTableFilter() {
  updateTableFilterValueFn();
  showDialog.value = false;
}

function enterDialog() {
  reBuildAdvanceFilter();
  // 每次打开都从「收合」状态开始
  showAllSites.value = false;
  showAllTags.value = false;

  // 单次线性扫描结果集判断是否需要优惠/上传倍率筛选，成本远低于直接构建 props。
  // 旧快照可能只有 tags 而没有 factor，用 getTorrentVolumeFactors 兜底反推。
  let hasDownloadPromo = false;
  let hasUploadPromo = false;
  for (const item of runtimeStore.search.searchResult) {
    const { downloadVolumeFactor: download, uploadVolumeFactor: upload } = getTorrentVolumeFactors(item);
    if (download !== undefined && download < 1) hasDownloadPromo = true;
    if (upload !== undefined && upload !== 1) hasUploadPromo = true;
    if (hasDownloadPromo && hasUploadPromo) break;
  }

  hasPromoData.value = hasDownloadPromo;
  hasUploadData.value = hasUploadPromo;
}

// 原生 a-modal 没有 afterOpenChange（只有 afterClose），打开时的初始化自行监听 open。
watch(showDialog, (open) => {
  if (open) nextTick(enterDialog);
});
</script>

<template>
  <a-modal v-model:open="showDialog" :title="t('common.AdvanceFilterGenerateDialog.title')" :width="800">
    <div style="padding: 0">
      <a-row :gutter="0">
        <a-typography-text>{{ t("common.AdvanceFilterGenerateDialog.keywords") }}</a-typography-text>
      </a-row>
      <a-row :gutter="8" style="margin-top: 0">
        <a-col :span="24" :md="12">
          <a-select
            v-model:value="advanceFilterDictRef.text.required"
            mode="tags"
            allow-clear
            :placeholder="t('common.AdvanceFilterGenerateDialog.required')"
            style="width: 100%"
          />
        </a-col>
        <a-col :span="24" :md="12">
          <a-select
            v-model:value="advanceFilterDictRef.text.exclude"
            mode="tags"
            allow-clear
            :placeholder="t('common.AdvanceFilterGenerateDialog.exclude')"
            style="width: 100%"
          />
        </a-col>
      </a-row>

      <a-row :gutter="0" style="align-items: center">
        <a-typography-text>{{ t("common.AdvanceFilterGenerateDialog.site") }}</a-typography-text>
        <div style="flex: 1 1 auto"></div>
        <a-button
          v-if="siteOptions.length > MAX_SITE_OPTIONS"
          size="small"
          type="text"
          @click="showAllSites = !showAllSites"
        >
          {{
            showAllSites
              ? t("common.AdvanceFilterGenerateDialog.collapse")
              : t("common.AdvanceFilterGenerateDialog.showAll", [siteOptions.length])
          }}
        </a-button>
      </a-row>
      <!-- V-21：`:indeterminate` 必须是计算值。硬编码的 `true` 会让每个复选框永远显示半选横杠，
           用户无法判断哪些筛选已生效。真实三态：checked = required（只保留）、
           indeterminate = exclude（排除）、未勾选 = 不参与筛选。 -->
      <a-row :gutter="0">
        <a-col v-for="site in displayedSites" :key="`${reBuildFilterCountRef}_${site}`" :span="12" :sm="8" :md="6">
          <a-checkbox
            :checked="advanceFilterDictRef.site.required.includes(site)"
            :indeterminate="advanceFilterDictRef.site.exclude.includes(site)"
            @click.stop="() => toggleKeywordStateFn('site', site)"
            @update:checked="
              (checked: boolean) => {
                const current = advanceFilterDictRef.site.required;
                advanceFilterDictRef.site.required = checked
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

      <template v-if="configStore.searchEntifyControl.showTorrentTag">
        <a-row :gutter="0">
          <a-typography-text>{{ t("SearchEntity.AdvanceFilterGenerateDialog.tags") }}</a-typography-text>
          <div style="flex: 1 1 auto"></div>
          <a-button
            v-if="filteredTorrentTags.length > MAX_TAG_OPTIONS"
            size="small"
            type="text"
            @click="showAllTags = !showAllTags"
          >
            {{
              showAllTags
                ? t("common.AdvanceFilterGenerateDialog.collapse")
                : t("common.AdvanceFilterGenerateDialog.showAll", [filteredTorrentTags.length])
            }}
          </a-button>
          <a-button
            v-if="configStore.searchEntifyControl.hiddenTagNames?.length"
            @click="showHiddenTags = !showHiddenTags"
            type="text"
            size="small"
          >
            {{
              showHiddenTags
                ? t("SearchEntity.AdvanceFilterGenerateDialog.hideHiddenTags")
                : t("SearchEntity.AdvanceFilterGenerateDialog.showHiddenTags")
            }}
          </a-button>
        </a-row>
        <a-row :gutter="0">
          <a-col
            v-for="tag in displayedTorrentTags"
            :key="`${reBuildFilterCountRef}_${tag.name}`"
            :span="8"
            :sm="6"
            :md="4"
          >
            <a-checkbox
              :checked="advanceFilterDictRef.tags.required.includes(tag.name)"
              :indeterminate="advanceFilterDictRef.tags.exclude.includes(tag.name)"
              @click.stop="() => toggleKeywordStateFn('tags', tag.name)"
              @update:checked="
                (checked: boolean) => {
                  const current = advanceFilterDictRef.tags.required;
                  advanceFilterDictRef.tags.required = checked
                    ? Array.from(new Set([...current, tag.name]))
                    : current.filter((x: any) => x !== tag.name);
                }
              "
            >
              <a-tag style="margin-right: 4px"
                ><component
                  :is="preDefinedTorrentTagNameSet.includes(tag.name) ? PushpinOutlined : undefined"
                  style="margin-right: 4px"
                />
                {{ tag.name }}
              </a-tag>
            </a-checkbox>
          </a-col>
        </a-row>
      </template>
      <a-row :gutter="0"
        ><a-typography-text>{{ t("SearchEntity.AdvanceFilterGenerateDialog.status") }}</a-typography-text></a-row
      >
      <a-row :gutter="0">
        <a-col
          v-for="status in statusOptions"
          :key="`${reBuildFilterCountRef}_${status.value}`"
          :span="12"
          :sm="8"
          :md="6"
        >
          <a-checkbox
            :checked="advanceFilterDictRef.status.required.includes(status.value)"
            :indeterminate="advanceFilterDictRef.status.exclude.includes(status.value)"
            @click.stop="() => toggleKeywordStateFn('status', status.value)"
            @update:checked="
              (checked: boolean) => {
                const current = advanceFilterDictRef.status.required;
                advanceFilterDictRef.status.required = checked
                  ? Array.from(new Set([...current, status.value]))
                  : current.filter((x: any) => x !== status.value);
              }
            "
          >
            <component :is="status.icon" style="margin-right: 8px" />
            <span>{{ status.label }}</span>
          </a-checkbox>
        </a-col>
      </a-row>
      <a-row :gutter="0">
        <a-col :xs="24" :md="12">
          <a-row :gutter="0" style="padding-right: 16px">
            <a-typography-text>{{ t("common.AdvanceFilterGenerateDialog.date") }}</a-typography-text>
            <div style="flex: 1 1 auto"></div>
            <a-tag
              v-for="dateUnit in ['day', 'week', 'month', 'quarter', 'year'] as const"
              :key="dateUnit"
              style="margin-right: 4px"
              @click="
                () => (advanceFilterDictRef.time = getThisDateUnitRange(dateUnit, advanceItemPropsRef.time.range))
              "
            >
              {{ t(`common.AdvanceFilterGenerateDialog.dateUnit.${dateUnit}`) }}
            </a-tag>
            <a-popover placement="top" trigger="click">
              <template #content>
                <a-range-picker
                  :value="[dayjs(advanceItemPropsRef.time.range[0]), dayjs(advanceItemPropsRef.time.range[1])]"
                  :disabled-date="
                    (date: any) =>
                      date.isBefore(dayjs(startOfDay(new Date(advanceItemPropsRef.time.range[0]))), 'day') ||
                      date.isAfter(dayjs(addDays(new Date(advanceItemPropsRef.time.range[1]), 1)), 'day')
                  "
                  @change="
                    (values: any) => {
                      // 清空日期时 antd 会传 null，不判空会抛 TypeError
                      if (!values) return;
                      advanceFilterDictRef.time = setDateRangeByDatePicker(values.map((v: any) => v.toDate()));
                    }
                  "
                />
              </template>
              <a-tag>{{ t("common.AdvanceFilterGenerateDialog.dateUnit.custom") }}</a-tag>
            </a-popover>
          </a-row>
          <a-row :gutter="0">
            <!-- OPTIONSOVERVIEW-1 孪生：time/size/seeders/leechers/completed 都是 [min,max] 元组
                 （useTableCustomFilter 的 ranges 分支就是这么初始化的），而 antd 的 a-slider 只有传 range
                 才走双滑块实现；缺了它 a-slider 按单值渲染，拖动一次就把元组改写成标量，
                 点「生成」时 updateTableFilterValueFn 的 `.map()` 抛 TypeError。 -->
            <a-slider
              v-model:value="advanceFilterDictRef.time"
              range
              :marks="tickMarks(advanceItemPropsRef.time.ticks)"
              :max="advanceItemPropsRef.time.range[1]"
              :min="advanceItemPropsRef.time.range[0]"
              :step="60 * 1000"
              :tip-formatter="(value: number) => formatDate(value ?? 0, 'yyyy-MM-dd HH:mm')"
              style="padding: 0 24px"
            />
          </a-row>
        </a-col>
        <a-col :xs="24" :md="12">
          <a-row :gutter="0"
            ><a-typography-text>{{ t("SearchEntity.AdvanceFilterGenerateDialog.size") }}</a-typography-text></a-row
          >
          <a-row :gutter="0">
            <a-slider
              v-model:value="advanceFilterDictRef.size"
              range
              :marks="tickMarks(advanceItemPropsRef.size.ticks)"
              :max="advanceItemPropsRef.size.range[1]"
              :min="advanceItemPropsRef.size.range[0]"
              :step="1024 ** 3"
              :tip-formatter="(value: number) => formatSize(value ?? 0)"
              style="padding: 0 24px"
            />
          </a-row>
        </a-col>
      </a-row>
      <a-row :gutter="0">
        <a-col :xs="24" :md="8">
          <a-row :gutter="8"
            ><a-typography-text>{{ t("SearchEntity.AdvanceFilterGenerateDialog.seeders") }}</a-typography-text></a-row
          >
          <a-row :gutter="0">
            <a-slider
              v-model:value="advanceFilterDictRef.seeders"
              range
              :marks="tickMarks(advanceItemPropsRef.seeders.ticks)"
              :max="advanceItemPropsRef.seeders.range[1]"
              :min="advanceItemPropsRef.seeders.range[0]"
              :step="1"
              style="padding: 0 24px"
            />
          </a-row>
        </a-col>
        <a-col :xs="24" :md="8">
          <a-row :gutter="8"
            ><a-typography-text>{{ t("SearchEntity.AdvanceFilterGenerateDialog.leechers") }}</a-typography-text></a-row
          >
          <a-row :gutter="0">
            <a-slider
              v-model:value="advanceFilterDictRef.leechers"
              range
              :marks="tickMarks(advanceItemPropsRef.leechers.ticks)"
              :max="advanceItemPropsRef.leechers.range[1]"
              :min="advanceItemPropsRef.leechers.range[0]"
              :step="1"
              style="padding: 0 24px"
            />
          </a-row>
        </a-col>
        <a-col :xs="24" :md="8">
          <a-row :gutter="8"
            ><a-typography-text>{{ t("SearchEntity.AdvanceFilterGenerateDialog.completed") }}</a-typography-text></a-row
          >
          <a-row :gutter="0">
            <a-slider
              v-model:value="advanceFilterDictRef.completed"
              range
              :marks="tickMarks(advanceItemPropsRef.completed.ticks)"
              :max="advanceItemPropsRef.completed.range[1]"
              :min="advanceItemPropsRef.completed.range[0]"
              :step="1"
              style="padding: 0 24px"
            />
          </a-row>
        </a-col>
      </a-row>

      <!-- 优惠筛选：上传计费比例（倍率） + 下载计费比例（0% = 免费，100% = 正常） -->
      <a-row v-if="showPromoFilters && (hasPromoData || hasUploadData)" :gutter="0">
        <a-col v-if="hasUploadData" :xs="24" :md="hasPromoData ? 12 : 24">
          <a-row :gutter="0"
            ><a-typography-text>{{ t("common.AdvanceFilterGenerateDialog.promoUpload") }}</a-typography-text></a-row
          >
          <a-row :gutter="0">
            <a-slider
              v-model:value="advanceFilterDictRef.uploadVolumeFactor"
              :marks="promoUploadMarks"
              :max="3"
              :min="0"
              :step="0.5"
              :tip-formatter="(value: number) => `×${value ?? 0}`"
              range
              style="padding: 0 24px"
            />
          </a-row>
        </a-col>
        <a-col v-if="hasPromoData" :xs="24" :md="hasUploadData ? 12 : 24">
          <a-row :gutter="0"
            ><a-typography-text>{{ t("common.AdvanceFilterGenerateDialog.promo") }}</a-typography-text></a-row
          >
          <a-row :gutter="0">
            <a-slider
              v-model:value="advanceFilterDictRef.downloadVolumeFactor"
              :marks="promoDownloadMarks"
              :max="1"
              :min="0"
              :step="0.05"
              :tip-formatter="(value: number) => `${Math.round((value ?? 0) * 100)}%`"
              range
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
