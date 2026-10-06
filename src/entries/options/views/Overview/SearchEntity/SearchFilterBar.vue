<script setup lang="ts">
import { computed } from "vue";
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

function selectedDate(): DatePreset | "all" | "custom" {
  const [start, end] = advanceFilterDictRef.value.time ?? [-Infinity, Infinity];
  if (start === -Infinity && end === Infinity) return "all";
  // A date chosen through the picker has a fixed end; a preset follows the current time.
  if (Math.abs(end - Date.now()) < 60_000) {
    return datePresets.find((preset) => dateStart(preset) === start) ?? "custom";
  }
  return "custom";
}

function setDate(preset: DatePreset) {
  advanceFilterDictRef.value.time = [dateStart(preset), Date.now()];
  updateTableFilterValueFn();
}

function setCustomDate(values: [dayjs.Dayjs, dayjs.Dayjs] | null) {
  advanceFilterDictRef.value.time = values
    ? [values[0].startOf("day").valueOf(), values[1].endOf("day").valueOf()]
    : [-Infinity, Infinity];
  updateTableFilterValueFn();
}

const customDateValue = computed(() => {
  const [start, end] = advanceFilterDictRef.value.time ?? [-Infinity, Infinity];
  return Number.isFinite(start) && Number.isFinite(end) ? [dayjs(start), dayjs(end)] : null;
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
    return `${formatDate(start, "yyyy-MM-dd")} ~ ${formatDate(end, "yyyy-MM-dd")}`;
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
