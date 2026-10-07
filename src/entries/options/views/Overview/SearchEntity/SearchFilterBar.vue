<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import dayjs from "dayjs";
import { startOfDay, startOfMonth, startOfWeek, startOfYear, subDays } from "date-fns";
import { DownOutlined } from "@ant-design/icons-vue";
import { ETorrentStatus, sortTorrentTags } from "@ptd/site";
import { formatDate } from "@/options/utils.ts";
import SiteName from "@/options/components/SiteName.vue";
import { tableCustomFilter } from "./utils/filter.ts";

type KeywordField = "site" | "tags" | "status" | "text";
type RangeField = "time" | "size" | "seeders" | "leechers" | "completed";
type FilterField = KeywordField | RangeField | "exclude";
type DatePreset = "today" | "week" | "month" | "year" | "last7";

const { t } = useI18n();
const { advanceFilterDictRef, advanceItemPropsRef, tableWaitFilterRef, buildFilterDictFn, updateTableFilterValueFn } =
  tableCustomFilter;

const fields: FilterField[] = [
  "site",
  "tags",
  "time",
  "text",
  "exclude",
  "size",
  "seeders",
  "leechers",
  "completed",
  "status",
];
const rangeFields: RangeField[] = ["size", "seeders", "leechers", "completed"];
const datePresets: DatePreset[] = ["today", "last7", "week", "month", "year"];
const gib = 1024 ** 3;
const sizeThresholds = [gib, 5 * gib, 10 * gib, 50 * gib];
const countThresholds = [1, 10, 50, 100];
const statusOptions = [
  ETorrentStatus.unknown,
  ETorrentStatus.downloading,
  ETorrentStatus.seeding,
  ETorrentStatus.inactive,
  ETorrentStatus.completed,
];
const tags = computed(() => sortTorrentTags(advanceItemPropsRef.value.tags ?? []));

function keywordValues(field: KeywordField, kind: "required" | "exclude" = "required"): string[] {
  return advanceFilterDictRef.value[field]?.[kind] ?? [];
}

function setKeywords(field: KeywordField, kind: "required" | "exclude", values: string[]) {
  advanceFilterDictRef.value[field][kind] = values;
  advanceFilterDictRef.value[field][kind === "required" ? "exclude" : "required"] = keywordValues(
    field,
    kind === "required" ? "exclude" : "required",
  ).filter((value) => !values.includes(value));
  updateTableFilterValueFn();
}

function toggleKeyword(field: KeywordField, value: string, checked: boolean) {
  const current = keywordValues(field);
  setKeywords(field, "required", checked ? [...current, value] : current.filter((item) => item !== value));
}

function rangeValue(field: RangeField): [number, number] {
  return advanceFilterDictRef.value[field] ?? [-Infinity, Infinity];
}

function thresholds(field: RangeField) {
  return field === "size" ? sizeThresholds : countThresholds;
}

function selectedThreshold(field: RangeField): number | "all" | "custom" {
  const [min, max] = rangeValue(field);
  if (min === -Infinity && max === Infinity) return "all";
  if (field === "size") return min === 0 && thresholds(field).includes(max) ? max : "custom";
  return max === Infinity && thresholds(field).includes(min) ? min : "custom";
}

function setThreshold(field: RangeField, value: number) {
  advanceFilterDictRef.value[field] = field === "size" ? [0, value] : [value, Infinity];
  updateTableFilterValueFn();
}

function clearField(field: FilterField) {
  if (field === "exclude") {
    advanceFilterDictRef.value.text.exclude = [];
  } else if (field === "text") {
    advanceFilterDictRef.value.text.required = [];
  } else if (field === "site" || field === "tags" || field === "status") {
    advanceFilterDictRef.value[field] = { required: [], exclude: [] };
  } else {
    advanceFilterDictRef.value[field] = [-Infinity, Infinity];
    // OPTIONSOVERVIEW-8：清空后不再属于任何预设，否则记忆的 preset 会被下一次区间复用
    if (field === "time") chosenDatePreset.value = null;
  }
  updateTableFilterValueFn();
}

function dateStart(preset: DatePreset): number {
  const now = new Date();
  return {
    today: () => startOfDay(now),
    last7: () => startOfDay(subDays(now, 6)),
    week: () => startOfWeek(now),
    month: () => startOfMonth(now),
    year: () => startOfYear(now),
  }
    [preset]()
    .getTime();
}

/**
 * OPTIONSOVERVIEW-8：记住用户点过的预设，以及它当次写入的起点。
 *
 * 预设名的反查原本只靠 `dateStart(preset) === start`，而 `dateStart` 是按「当前」日期算的：
 * 只要跨过自然日/周/月边界，同一条 `[start, Infinity]` 就再也匹配不上任何预设，
 * radio 退回无选中态、chip 退化成 `yyyy-MM-dd ~ ∞`。这里把「用户选过哪个预设」显式记下来，
 * 只要筛选值仍是那次写入的结果（起点一致、上界仍是 Infinity）就继续按预设展示。
 *
 * 为什么不在这里把起点滚动到「今天」：那等于在渲染期间改筛选条件并触发重新过滤，
 * 用户没操作却看到列表变化；用户再点一次同一个预设即可重新锚定。
 */
const chosenDatePreset = ref<{ preset: DatePreset; start: number } | null>(null);

function selectedDate(): DatePreset | "all" | "custom" {
  const [start, end] = advanceFilterDictRef.value.time ?? [-Infinity, Infinity];
  if (start === -Infinity && end === Infinity) return "all";
  // OPTIONSOVERVIEW-8：预设把上界写成 Infinity（=「直到现在」），显示与筛选语义因此始终一致；
  // 早期用 `Math.abs(end - Date.now()) < 60_000` 猜测预设，点击 60 秒后就会回落到自定义区间，
  // 而真正生效的上界还停在点击那一刻，之后新建的搜索结果会被错误过滤掉。
  if (end === Infinity) {
    // 先用记忆的预设（跨日/跨周后仍然成立），再退回复查「按当前日期算」的预设起点
    const remembered = chosenDatePreset.value;
    if (remembered && remembered.start === start) return remembered.preset;
    return datePresets.find((preset) => dateStart(preset) === start) ?? "custom";
  }
  return "custom";
}

function setDate(preset: DatePreset) {
  const start = dateStart(preset);
  chosenDatePreset.value = { preset, start };
  advanceFilterDictRef.value.time = [start, Infinity];
  updateTableFilterValueFn();
}

function setCustomDate(values: [dayjs.Dayjs, dayjs.Dayjs] | null) {
  chosenDatePreset.value = null; // 自定义区间不再对应任何预设
  advanceFilterDictRef.value.time = values
    ? [values[0].startOf("day").valueOf(), values[1].endOf("day").valueOf()]
    : [-Infinity, Infinity];
  updateTableFilterValueFn();
}

const customDateValue = computed<[dayjs.Dayjs, dayjs.Dayjs | null] | null>(() => {
  const [start, end] = advanceFilterDictRef.value.time ?? [-Infinity, Infinity];
  if (Number.isFinite(start) && Number.isFinite(end)) return [dayjs(start), dayjs(end)];
  // OPTIONSOVERVIEW-8：预设的上界是 Infinity，而 a-range-picker 不接受非有限值 —— 直接给 null
  // 会让选中预设后区间选择器整个空白，用户看不出当前生效的起点。这里退化成「只有起点、终点留空」，
  // 既显示生效的起点，又保留继续挑选自定义区间的能力；两端都无效时（未筛选）仍是空的占位。
  if (Number.isFinite(start)) return [dayjs(start), null];
  return null;
});

function label(field: FilterField) {
  const prefix = "SearchEntity.index.filters.";
  return t(prefix + field);
}

function setFilterText(value: string) {
  tableWaitFilterRef.value = value;
  buildFilterDictFn(value);
}

function firstValue(field: FilterField): string {
  if (field === "exclude") return keywordValues("text", "exclude")[0] ?? "";
  if (field === "text") return keywordValues("text")[0] ?? "";
  if (field === "site" || field === "tags" || field === "status") {
    const required = keywordValues(field);
    const first = required[0] ?? keywordValues(field, "exclude")[0];
    if (!first) return "";
    const display = field === "status" ? t(`torrent.status.${first}`) : first;
    return required.length ? display : t("SearchEntity.index.filters.excludedValue", [display]);
  }
  if (field === "time") {
    const selected = selectedDate();
    if (selected === "all") return "";
    if (selected !== "custom") return t(`SearchEntity.index.filters.dates.${selected}`);
    const [start, end] = advanceFilterDictRef.value.time;
    // OPTIONSOVERVIEW-8：预设的上界是 Infinity，跨天后预设名匹配不上而落到这里；
    // 与人数/体积的自定义分支一致地显示 ∞，避免 formatDate(Infinity) 渲染出 "Invalid Date"。
    return `${formatDate(start, "yyyy-MM-dd")} ~ ${Number.isFinite(end) ? formatDate(end, "yyyy-MM-dd") : "∞"}`;
  }
  const selected = selectedThreshold(field);
  if (selected === "all") return "";
  if (selected === "custom") {
    const [min, max] = rangeValue(field);
    return `${Number.isFinite(min) ? (field === "size" ? `${Math.round(min / gib)} GB` : min) : "0"} ~ ${
      Number.isFinite(max) ? (field === "size" ? `${Math.round(max / gib)} GB` : max) : "∞"
    }`;
  }
  return t(field === "size" ? "SearchEntity.index.filters.atMost" : "SearchEntity.index.filters.atLeast", [
    field === "size" ? `${selected / gib} GB` : selected,
  ]);
}

function extraCount(field: FilterField) {
  if (field === "exclude") return Math.max(0, keywordValues("text", "exclude").length - 1);
  if (field === "text") return Math.max(0, keywordValues("text").length - 1);
  if (field === "site" || field === "tags" || field === "status") {
    const required = keywordValues(field);
    const excluded = keywordValues(field, "exclude");
    return Math.max(0, required.length + excluded.length - 1);
  }
  return 0;
}
</script>

<template>
  <div class="search-filter-bar">
    <!-- 筛选项包一层容器：换行只发生在容器内部，外层不换行，搜索框因此不会被挤到单独一行 -->
    <div class="search-filter-chips">
      <a-popover
        v-for="field in fields"
        :key="field"
        placement="bottomLeft"
        trigger="click"
        overlay-class-name="search-filter-menu"
      >
        <button
          type="button"
          class="search-filter-chip"
          :class="{ 'search-filter-chip--active': firstValue(field) }"
          :data-filter="field"
        >
          <span class="search-filter-chip__label">
            {{ label(field)
            }}<template v-if="firstValue(field)"
              >：<SiteName
                v-if="field === 'site' && keywordValues('site').length"
                :site-id="keywordValues('site')[0]"
                tag="span"
              /><span v-else>{{ firstValue(field) }}</span></template
            >
          </span>
          <span v-if="extraCount(field)" class="search-filter-count">+{{ extraCount(field) }}</span>
          <DownOutlined class="search-filter-chip__arrow" />
        </button>
        <template #content>
          <div class="search-filter-menu__content">
            <a-button
              v-if="firstValue(field)"
              class="search-filter-clear"
              type="link"
              size="small"
              @click="clearField(field)"
            >
              {{ t("SearchEntity.index.filters.clear") }}
            </a-button>
            <template v-if="field === 'site'">
              <a-checkbox
                v-for="site in advanceItemPropsRef.site ?? []"
                :key="site"
                :checked="keywordValues('site').includes(site)"
                @change="(event: any) => toggleKeyword('site', site, event.target.checked)"
              >
                <SiteName :site-id="site" tag="span" />
              </a-checkbox>
            </template>
            <template v-else-if="field === 'tags'">
              <a-checkbox
                v-for="tag in tags"
                :key="tag.name"
                :checked="keywordValues('tags').includes(tag.name)"
                @change="(event: any) => toggleKeyword('tags', tag.name, event.target.checked)"
              >
                {{ tag.name }}
              </a-checkbox>
            </template>
            <template v-else-if="field === 'status'">
              <a-checkbox
                v-for="status in statusOptions"
                :key="status"
                :checked="keywordValues('status').includes(status)"
                @change="(event: any) => toggleKeyword('status', status, event.target.checked)"
              >
                {{ t(`torrent.status.${status}`) }}
              </a-checkbox>
            </template>
            <template v-else-if="field === 'text' || field === 'exclude'">
              <a-select
                mode="tags"
                :value="keywordValues('text', field === 'exclude' ? 'exclude' : 'required')"
                :placeholder="label(field)"
                style="width: 250px"
                @change="
                  (values: string[]) => setKeywords('text', field === 'exclude' ? 'exclude' : 'required', values)
                "
              />
            </template>
            <template v-else-if="field === 'time'">
              <a-radio-group :value="selectedDate()" @change="(event: any) => setDate(event.target.value)">
                <a-radio v-for="preset in datePresets" :key="preset" :value="preset">
                  {{ t(`SearchEntity.index.filters.dates.${preset}`) }}
                </a-radio>
              </a-radio-group>
              <a-range-picker
                :value="customDateValue"
                style="width: 260px"
                @change="(values: any) => setCustomDate(values)"
              />
            </template>
            <template v-else>
              <a-radio-group
                :value="selectedThreshold(field)"
                @change="(event: any) => setThreshold(field, event.target.value)"
              >
                <a-radio v-for="threshold in thresholds(field)" :key="threshold" :value="threshold">
                  {{
                    t(field === "size" ? "SearchEntity.index.filters.atMost" : "SearchEntity.index.filters.atLeast", [
                      field === "size" ? `${threshold / gib} GB` : threshold,
                    ])
                  }}
                </a-radio>
                <a-radio v-if="selectedThreshold(field) === 'custom'" value="custom" disabled>
                  {{ firstValue(field) }}
                </a-radio>
              </a-radio-group>
            </template>
          </div>
        </template>
      </a-popover>
    </div>
    <a-input
      :value="tableWaitFilterRef"
      class="search-filter-search"
      allow-clear
      :placeholder="t('SearchEntity.index.filterLabel')"
      @update:value="setFilterText"
    />
  </div>
</template>
