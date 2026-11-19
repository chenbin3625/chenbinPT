<script setup lang="ts">
import {
  BarChartOutlined,
  CalendarOutlined,
  DollarOutlined,
  DownOutlined,
  ExclamationCircleOutlined,
  ExportOutlined,
  FundOutlined,
  GlobalOutlined,
  SettingOutlined,
  StopOutlined,
  SyncOutlined,
  ThunderboltOutlined,
  UnorderedListOutlined,
  UpOutlined,
  WarningOutlined,
} from "@ant-design/icons-vue";
import { computed, onMounted, reactive, ref, watch } from "vue";
import { useIntervalFn, watchDebounced } from "@vueuse/core";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import { isUndefined } from "es-toolkit/compat";
import type { DataTableHeader } from "@/options/types/dataTable.ts";
import { EResultParseStatus, type TSiteID } from "@ptd/site";
// 轻量索引单独 import：批量打开时同步取站点 URL，避免逐个 await 丢失用户手势
import { siteMetadataIndex } from "@ptd/site/metadataIndex";

import { useDisplay } from "@/options/composables/useDisplay.ts";
import { useConfigStore } from "@/options/stores/config.ts";
import { useRuntimeStore } from "@/options/stores/runtime.ts";
import { useMetadataStore } from "@/options/stores/metadata.ts";
import { useStoreHydrating } from "@/options/composables/useStoreHydrating.ts";
import { useTableCustomFilter } from "@/options/directives/useAdvanceFilter.ts";
import {
  formatDate,
  formatDateTimeForTable,
  formatSize,
  formatTimeAgo,
  stopEventPropagation,
} from "@/options/utils.ts";

import SiteName from "@/options/components/SiteName.vue";
import SiteFavicon from "@/options/components/SiteFavicon/Index.vue";
import ResultParseStatus from "@/options/components/ResultParseStatus.vue";
import NoDataPlaceholder from "@/options/components/NoDataPlaceholder.vue";
import ToolbarActions, { type ToolbarAction } from "@/options/components/ToolbarActions.vue";
import UserLevelRequirementsTd from "./UserLevelRequirementsTd.vue";
import HistoryDataViewDialog from "./HistoryDataViewDialog.vue";
import BonusFormatSpan from "./BonusFormatSpan.vue";
import ExportUserInfoDialog from "./ExportUserInfoDialog.vue";

import { formatRatio } from "./utils/format.ts";
import ColumnSelector from "../components/ColumnSelector.vue";
import {
  applyTableActionColumn,
  toAntdColumns,
  toPagination,
  toSortBy,
  useTableActionColumnLayout,
  useMainTableSticky,
} from "../utils/antdTable.ts";
import {
  type IUserInfoItem,
  tableData,
  initTableData,
  cancelFlushSiteLastUserInfo,
  flushProgress,
  flushSiteLastUserInfo,
  formatFlushStatusMsg,
  isFlushFailed,
  isTableDataLoading,
  reconcileFlushPlan,
} from "./utils/lastUserData.ts";

// 页面级表格表头吸顶（滚动容器是 #ptd-main，见 useMainTableSticky 的说明）
const mainTableSticky = useMainTableSticky();

const { t } = useI18n();
const router = useRouter();
const configStore = useConfigStore();
const runtimeStore = useRuntimeStore();
const metadataStore = useMetadataStore();

// metadata store 需要先从 chrome.storage 异步水合，叠加 initTableData 的异步加载：
// 两者都完成前表格显示 loading，避免先闪一下「暂无数据」再蹦出数据
const isStoreHydrating = useStoreHydrating(metadataStore);
const isTableLoading = computed<boolean>(() => isStoreHydrating.value || isTableDataLoading.value);

type TExtendDataTableHeader = DataTableHeader & { props?: any };

const display = useDisplay();

/**
 * 等级列的最大宽度：用户开启「限制等级栏宽度」，或处于小屏时生效（与搜索结果页标题列的移动端策略一致）。
 * 等级列由 #bodyCell 插槽渲染，表头的 maxWidth 不会作用到单元格，所以限宽统一交给单元格自身截断。
 */
const levelNameMaxWidth = computed(() =>
  configStore.myDataTableControl.limitLevelNameTdWidth || display.smAndDown.value ? "32vw" : undefined,
);

const fullTableHeader = reactive([
  {
    title: t("common.site"),
    key: "siteUserConfig.sortIndex",
    align: "center",
    props: { disabled: true },
  },
  { title: t("common.username"), key: "name", align: "center" },
  // 基准宽度 10%；限宽（用户开启「限制等级栏宽度」或小屏）时由单元格自身截断，见 levelNameMaxWidth
  { title: t("MyData.table.levelName"), key: "levelName", align: "start", width: "10%" },
  // NOTE: 这里将 key 设为 uploaded, trueUploaded 而不是虚拟的 userData，可以让数据表格使用 uploaded 进行排序
  { title: t("MyData.table.userData"), key: "uploaded", align: "end" },
  { title: t("MyData.table.trueUserData"), key: "trueUploaded", align: "end" }, // 默认不显示
  { title: t("levelRequirement.ratio"), key: "ratio", align: "end" },
  { title: t("levelRequirement.trueRatio"), key: "trueRatio", align: "end" }, // 默认不显示
  { title: t("levelRequirement.uploads"), key: "uploads", align: "end" },
  { title: t("levelRequirement.seeding"), key: "seeding", align: "end" },
  { title: t("levelRequirement.seedingSize"), key: "seedingSize", align: "end" },
  { title: t("levelRequirement.bonus"), key: "bonus", align: "end" },
  { title: t("levelRequirement.bonusPerHour"), key: "bonusPerHour", align: "end" },
  { title: t("MyData.table.invites"), key: "invites", align: "end" }, // 默认不显示
  { title: t("MyData.table.joinTime"), key: "joinTime", align: "center" },
  { title: t("MyData.table.lastAccessAt"), key: "lastAccessAt", align: "center" }, // 默认不显示
  { title: t("MyData.table.updateAt"), key: "updateAt", align: "center" },
  {
    title: t("common.action"),
    key: "action",
    align: "center",
    sortable: false,
    width: "90",
    props: { disabled: true },
  },
] as TExtendDataTableHeader[]);

const tableNonBooleanControlKey = [
  "joinTimeFormat",
  // Deprecated
  "joinTimeWeekOnly",
];

// 过滤出表格控制中非布尔类型的键
const filteredTableBooleanControlKeys = computed(() => {
  return Object.keys(configStore.myDataTableControl).filter(
    (key) => tableNonBooleanControlKey.indexOf(key) === -1,
  ) as (keyof typeof configStore.myDataTableControl)[];
});

const { tableWaitFilterRef, tableFilterRef, tableFilterFn, buildFilterDictFn } = useTableCustomFilter<IUserInfoItem>({
  parseOptions: {
    keywords: ["site", "status", "siteUserConfig.groups"],
    ranges: ["updateAt", "messageCount"],
  },
  titleFields: ["site", "siteName", "name"],
  format: {
    status: "number",
    updateAt: { parse: Number, build: String },
  },
});

/**
 * 快捷筛选（今日未更新 / 刷新异常 / 未读消息）。
 *
 * 这些快捷筛选不再把原始查询串塞进搜索框：
 * - 搜索框只承载用户主动输入的关键词与高级语法，快捷条件在表头以 chip 呈现，状态一眼可见；
 * - 点 chip 只切换本地条件，不会清掉用户已经输入的文字。
 */
type TQuickFilter = "failed" | "stale" | "unread";
const quickFilter = ref<TQuickFilter | null>(null);

function toggleQuickFilter(filter: TQuickFilter) {
  quickFilter.value = quickFilter.value === filter ? null : filter;
}

// 每分钟刷新一次「今天」的起点，跨天后「今日未更新」的统计会自动跟上
const now = ref(Date.now());
useIntervalFn(() => {
  now.value = Date.now();
}, 60_000);
const todayStart = computed(() => {
  const today = new Date(now.value);
  today.setHours(0, 0, 0, 0);
  return today.getTime();
});

function isUpdatedToday(record: IUserInfoItem): boolean {
  return typeof record.updateAt === "number" && record.updateAt >= todayStart.value;
}

/** 站点分组筛选：required = 只保留（勾选），excluded = 排除（半选），未勾选 = 不参与筛选 */
const groupRequired = ref<string[]>([]);
const groupExcluded = ref<string[]>([]);

/** 三态循环：未勾选 → 只保留 → 排除 → 未勾选（旧实现点击三次只能来回两态） */
function cycleSiteGroupFilter(group: string) {
  if (groupRequired.value.includes(group)) {
    groupRequired.value = groupRequired.value.filter((value) => value !== group);
    groupExcluded.value = [...groupExcluded.value, group];
  } else if (groupExcluded.value.includes(group)) {
    groupExcluded.value = groupExcluded.value.filter((value) => value !== group);
  } else {
    groupRequired.value = [...groupRequired.value, group];
  }
}

const groupOptions = computed(() => metadataStore.getSitesGroupData);

const groupFilterActive = computed(() => groupRequired.value.length + groupExcluded.value.length > 0);

function clearFilters() {
  quickFilter.value = null;
  groupRequired.value = [];
  groupExcluded.value = [];
  tableWaitFilterRef.value = "";
  buildFilterDictFn("");
}

const activeFilterCount = computed(
  () =>
    (quickFilter.value ? 1 : 0) +
    (tableWaitFilterRef.value.trim() ? 1 : 0) +
    groupRequired.value.length +
    groupExcluded.value.length,
);

const myDataSummary = computed(() => {
  let uploaded = 0;
  let downloaded = 0;
  let seedingSize = 0;
  let errorSites = 0;

  for (const record of tableData.value) {
    // 刷新失败时行内保留的是上一次成功的数据，汇总仍应按这份数据累计，避免某个站点失败后总量突然变小
    if (record.status === EResultParseStatus.success) {
      if (Number.isFinite(record.uploaded)) uploaded += Number(record.uploaded);
      if (Number.isFinite(record.downloaded)) downloaded += Number(record.downloaded);
      if (Number.isFinite(record.seedingSize)) seedingSize += Number(record.seedingSize);
    }
    if (isFlushFailed(record)) errorSites++;
  }

  return { uploaded, downloaded, seedingSize, errorSites };
});

const staleCount = computed(() => tableData.value.filter((record) => !isUpdatedToday(record)).length);
const unreadCount = computed(() => tableData.value.filter((record) => (record.messageCount ?? 0) > 0).length);

const tableColumns = computed(() =>
  // 操作列位置 / 固定（#1598）：先按可见列过滤（props.disabled 的列常显）→ toAntdColumns，
  // 最后再调整操作列位置，避免操作列被可见列过滤逻辑影响
  applyTableActionColumn(
    toAntdColumns(fullTableHeader, {
      sortBy: configStore.tableBehavior.MyData.sortBy,
      multiSort: configStore.enableTableMultiSort,
      visibleKeys: configStore.tableBehavior.MyData.columns,
    }),
  ),
);
// 操作列固定在行首时，行首的选择列要一起固定
const { rowSelectionFixed } = useTableActionColumnLayout();
const filteredTableData = computed(() =>
  tableData.value.filter((item) => {
    // 1) 搜索框（关键词 / 高级筛选语法）
    if (!tableFilterFn(undefined, tableFilterRef.value, { raw: item })) return false;

    // 2) 快捷筛选 chip
    if (quickFilter.value === "failed" && !isFlushFailed(item)) return false;
    if (quickFilter.value === "stale" && isUpdatedToday(item)) return false;
    if (quickFilter.value === "unread" && (item.messageCount ?? 0) <= 0) return false;

    // 3) 站点分组（多选为「任一命中」，排除优先）
    const groups = item.siteUserConfig?.groups ?? [];
    if (groupRequired.value.length > 0 && !groupRequired.value.some((group) => groups.includes(group))) {
      return false;
    }
    if (groupExcluded.value.some((group) => groups.includes(group))) return false;

    return true;
  }),
);
const tablePagination = computed(() =>
  // F16：历史配置里的 itemsPerPage = -1 会让表格完全不渲染分页器（连「每页条数」都改不回来），
  // 与 SearchEntity 保持一致：不允许「不分页」这个历史取值。
  toPagination(
    configStore.tableBehavior.MyData.itemsPerPage,
    (v) => configStore.updateTableBehavior("MyData", "itemsPerPage", v),
    { allowUnpaginated: false },
  ),
);

/**
 * F7：输入框的筛选串必须同步回高级筛选字典（`advanceFilterDictRef`）。
 *
 * 表格过滤实际用的是输入串（`tableParsedFilterRef`），而快捷筛选/分组勾选用的是字典；
 * 修复前手输条件只写进输入框、从未写进字典，于是点任一快捷筛选时 `stringifyFilterDictFn()`
 * 会用旧字典重建整串并覆盖输入框，用户手输的 `name:alice` 静默消失。
 */
function onTableFilterInput(value: string) {
  tableWaitFilterRef.value = value;
  buildFilterDictFn(value);
}
function onSelectionChange(keys: (string | number)[]) {
  tableSelected.value = keys as TSiteID[];
}
function onTableChange(_pagination: unknown, _filters: unknown, sorter: unknown) {
  configStore.updateTableBehavior("MyData", "sortBy", toSortBy(sorter as never));
}

const tableSelected = ref<TSiteID[]>([]); // 选中的站点行

// 表格数据重建（站点被删除/过滤配置变化）后，选择集里不能残留已不存在的站点 id，
// 否则「批量刷新 / 打开站点 / 时间线」会继续对已删除的站点发消息。
watch(
  () => tableData.value.map((item) => item.site),
  (siteIds) => {
    if (tableSelected.value.length === 0) return;
    const existing = new Set(siteIds);
    const nextSelected = tableSelected.value.filter((site) => existing.has(site));
    if (nextSelected.length !== tableSelected.value.length) tableSelected.value = nextSelected;
  },
);

// 挂载时先对账「刷新中」的残留标记（F17：恢复出来的 flushPlan 没有在途请求，会把页面卡在“取消刷新”），
// 再加载表格数据
onMounted(() => {
  reconcileFlushPlan();
  void initTableData();
});

// 监听用户信息变化（ offscreen 直接定时刷新的情况 ）
watchDebounced(
  () => metadataStore.lastUserInfo,
  () => {
    // 此时前端并没有进行刷新，强制更新
    if (!Object.values(runtimeStore.userInfo.flushPlan).some((isFlushing) => isFlushing)) {
      initTableData();
    }
  },
  { debounce: 5e3, deep: true },
);

const showHistoryDataViewDialog = ref<boolean>(false);
const historyDataViewDialogSiteId = ref<TSiteID | null>(null);
function viewHistoryData(siteId: TSiteID) {
  showHistoryDataViewDialog.value = true;
  historyDataViewDialogSiteId.value = siteId;
}

function multiOpen() {
  let openSiteIds: TSiteID[] = tableSelected.value;

  // #1663：未勾选站点时，按「是否处于筛选状态」决定打开范围，避免筛选后仍然打开全部站点
  if (openSiteIds.length === 0) {
    if (tableFilterRef.value.trim().length > 0) {
      openSiteIds = filteredTableData.value.map((item) => item.site);
      if (openSiteIds.length === 0) {
        runtimeStore.showSnackbar(t("MyData.index.noSiteSelectedCancelOpen"), { color: "warning" });
        return;
      }
      runtimeStore.showSnackbar(t("MyData.index.noSiteSelectedOpenFiltered", [openSiteIds.length]), {
        color: "info",
      });
    } else {
      openSiteIds = tableData.value.map((item) => item.site);
      runtimeStore.showSnackbar(t("MyData.index.noSiteSelectedOpenAll"), { color: "info" });
    }
  }

  // NOTE: 这里必须同步取 URL，若在循环内 `await`，则第一个 `window.open` 之后用户手势即失效，
  //       后续标签页会被浏览器拦截（表格数据均已挂载 `siteUserConfig`，无需再走异步查询）
  for (const siteId of openSiteIds) {
    const siteUrl = metadataStore.sites[siteId]?.url || siteMetadataIndex[siteId]?.urls?.[0];
    if (siteUrl) {
      window.open(siteUrl, "_blank", "noopener noreferrer");
    }
  }
}

const showExportDialog = ref(false);

/**
 * 刷新的作用域：优先「已勾选的站点」；否则跟随当前筛选结果；没有筛选时就是全部。
 * 用户在「异常站点」筛选下点刷新，期望的是刷新眼前这些站点，而不是全量。
 */
const refreshTargets = computed<TSiteID[]>(() => {
  if (tableSelected.value.length > 0) return tableSelected.value;
  const scope = activeFilterCount.value > 0 ? filteredTableData.value : tableData.value;
  return scope.filter((record) => record.selectable !== false).map((record) => record.site);
});

const refreshLabel = computed(() => {
  if (runtimeStore.isUserInfoFlush) {
    const progress = flushProgress.total > 0 ? ` ${flushProgress.done}/${flushProgress.total}` : "";
    return `${t("MyData.index.flushCancel")}${progress}`;
  }
  if (tableSelected.value.length > 0) {
    return t("MyData.index.flushSelected", [String(tableSelected.value.length)]);
  }
  if (activeFilterCount.value > 0) {
    return t("MyData.index.flushFiltered", [String(refreshTargets.value.length)]);
  }
  return t("MyData.index.flushAll");
});

function clearSelection() {
  tableSelected.value = [];
}

async function multiFlush() {
  const flushSiteIds = refreshTargets.value;
  if (flushSiteIds.length === 0) {
    runtimeStore.showSnackbar(t("MyData.index.noRefreshTarget"), { color: "warning" });
    return;
  }

  flushSiteLastUserInfo(flushSiteIds);
}

/** 刷新失败时优先展示失败原因，退回状态名（成功数据仍保留在行内） */
function flushFailureLabel(record: IUserInfoItem): string {
  const status = record.lastFlushFailure?.status ?? record.status;
  return t(`resultParseStatus.${EResultParseStatus[status]}`);
}

function flushFailureTitle(record: IUserInfoItem): string {
  const reason = formatFlushStatusMsg(record.lastFlushFailure?.statusMsg) ?? flushFailureLabel(record);
  return t("MyData.table.flushFailedTip", {
    reason,
    time: record.updateAt ? formatDateTimeForTable(record.updateAt) : "-",
  });
}

const toolbarActions = computed<ToolbarAction[]>(() => [
  {
    key: "open",
    label: t("MyData.index.multiOpen"),
    icon: GlobalOutlined,
    // 未勾选时按筛选结果/全部站点打开（#1663），只要表格有数据就允许点击
    disabled: tableData.value.length === 0,
  },
  { key: "timeline", label: t("MyData.index.viewTimeline"), icon: FundOutlined },
  { key: "statistic", label: t("MyData.index.viewStatistic"), icon: BarChartOutlined },
  { key: "export", label: t("MyData.index.exportData"), icon: ExportOutlined },
]);

function onToolbarAction(key: string) {
  switch (key) {
    case "open":
      void multiOpen();
      break;
    case "timeline":
      viewTimeline();
      break;
    case "statistic":
      viewStatistic();
      break;
    case "export":
      showExportDialog.value = true;
      break;
  }
}

function viewTimeline() {
  router.push({
    name: "UserDataTimeline",
    query: {
      sites: tableSelected.value,
    },
  });
}

function viewStatistic() {
  router.push({
    name: "UserDataStatistic",
    query: {
      sites: tableSelected.value,
    },
  });
}

/** 空态引导：表格里一个站点都没有时，直接跳到站点设置页添加 */
function goToSiteSettings() {
  void router.push({ name: "SetSite" });
}
</script>

<template>
  <a-card>
    <section
      v-if="!isTableLoading && tableData.length > 0"
      class="my-data-summary"
      :aria-label="t('MyData.summary.label')"
    >
      <div class="my-data-summary__item">
        <span class="my-data-summary__label">
          <UpOutlined class="my-data-icon-success" />
          {{ t("MyData.summary.uploaded") }}
        </span>
        <strong>{{ formatSize(myDataSummary.uploaded) }}</strong>
      </div>
      <div class="my-data-summary__item">
        <span class="my-data-summary__label">
          <DownOutlined class="my-data-icon-danger" />
          {{ t("MyData.summary.downloaded") }}
        </span>
        <strong>{{ formatSize(myDataSummary.downloaded) }}</strong>
      </div>
      <div class="my-data-summary__item">
        <span class="my-data-summary__label">
          <FundOutlined />
          {{ t("MyData.summary.seedingSize") }}
        </span>
        <strong>{{ formatSize(myDataSummary.seedingSize) }}</strong>
      </div>
      <button
        type="button"
        class="my-data-summary__item my-data-summary__item--action"
        :class="{ 'my-data-summary__item--warning': myDataSummary.errorSites > 0 }"
        :disabled="myDataSummary.errorSites === 0"
        :title="t('MyData.index.filter.failed')"
        @click="toggleQuickFilter('failed')"
      >
        <span class="my-data-summary__label">
          <WarningOutlined />
          {{ t("MyData.summary.errorSites") }}
        </span>
        <strong>{{ myDataSummary.errorSites }}</strong>
      </button>
    </section>

    <a-flex class="page-toolbar" align="center" :gap="8">
      <ToolbarActions :items="toolbarActions" @select="onToolbarAction">
        <template #primary>
          <a-button
            :danger="runtimeStore.isUserInfoFlush"
            :type="runtimeStore.isUserInfoFlush ? 'default' : 'primary'"
            :title="refreshLabel"
            @click="runtimeStore.isUserInfoFlush ? cancelFlushSiteLastUserInfo() : multiFlush()"
          >
            <template #icon>
              <StopOutlined v-if="runtimeStore.isUserInfoFlush" />
              <SyncOutlined v-else />
            </template>
            {{ refreshLabel }}
          </a-button>
        </template>
      </ToolbarActions>

      <span v-if="tableSelected.length > 0" class="my-data-selection">
        <span class="ptd-meta-text">{{ t("MyData.index.selectedCount", [String(tableSelected.length)]) }}</span>
        <a-button type="link" size="small" @click="clearSelection">
          {{ t("MyData.index.clearSelection") }}
        </a-button>
      </span>

      <a-popover placement="bottom" trigger="click">
        <a-button class="my-data-settings-button" :title="t('MyData.index.setting')">
          <template #icon><SettingOutlined /></template>
          {{ t("MyData.index.setting") }}
        </a-button>
        <template #content>
          <a-list size="small">
            <!-- 入站时间显示 -->
            <a-list-item>
              <a-flex align="center" :gap="8">
                <CalendarOutlined />
                <span class="my-data-setting-title">{{ t("MyData.index.joinTimeFormat") }}</span>
              </a-flex>
              <a-radio-group
                v-model:value="configStore.myDataTableControl.joinTimeFormat"
                button-style="solid"
                class="my-data-radio-group"
                @click.stop
                @change="() => configStore.$save()"
              >
                <a-radio-button
                  v-for="type in ['alive', 'aliveWeek', 'added']"
                  :key="type"
                  :value="type"
                  :title="t(`MyData.index.joinTimeFormatOptions.${type}`)"
                >
                  {{ t(`MyData.index.joinTimeFormatOptions.${type}`) }}
                </a-radio-button>
              </a-radio-group>
            </a-list-item>

            <a-divider class="my-data-settings-divider" />

            <!-- 其他开关控制 -->
            <a-list-item v-for="index in filteredTableBooleanControlKeys" :key="index" class="my-data-setting-item">
              <!-- antd 的 a-switch 不渲染默认插槽，文案必须放在同级节点 -->
              <span class="my-data-setting-label">{{ t("MyData.index." + index) }}</span>
              <!-- a-switch 的 click 载荷是 (newChecked, event)，不能用 `.stop` 修饰符（见 stopEventPropagation） -->
              <a-switch
                v-model:checked="configStore.myDataTableControl[index]"
                @click="stopEventPropagation"
                @change="() => configStore.$save()"
              />
            </a-list-item>
          </a-list>
        </template>
      </a-popover>

      <div class="my-data-spacer"></div>

      <a-input
        :value="tableWaitFilterRef"
        allow-clear
        :placeholder="t('MyData.index.searchPlaceholder')"
        @update:value="onTableFilterInput"
      />
    </a-flex>
    <a-table
      :sticky="mainTableSticky"
      :columns="tableColumns"
      :data-source="filteredTableData"
      :loading="isTableLoading"
      :pagination="tablePagination"
      :row-key="'site'"
      :row-selection="{
        selectedRowKeys: tableSelected,
        onChange: onSelectionChange,
        getCheckboxProps: (record: any) => ({ disabled: record.selectable === false }),
        // 表格筛选/分页改变 dataSource 时保留已选站点，避免下一次勾选时静默丢掉先前的选择
        preserveSelectedRowKeys: true,
        // 操作列固定在行首时选择列也必须固定，保持固定列连续
        fixed: rowSelectionFixed,
      }"
      :scroll="{ x: 'max-content' }"
      class="table-stripe"
      @change="onTableChange"
    >
      <template #title>
        <div class="my-data-table-toolbar">
          <div class="search-filter-chips">
            <button
              type="button"
              class="search-filter-chip"
              :class="{ 'search-filter-chip--active': quickFilter === 'failed' }"
              :disabled="myDataSummary.errorSites === 0 && quickFilter !== 'failed'"
              @click="toggleQuickFilter('failed')"
            >
              <span class="search-filter-chip__label">{{ t("MyData.index.filter.failed") }}</span>
              <span v-if="myDataSummary.errorSites > 0" class="search-filter-count">{{
                myDataSummary.errorSites
              }}</span>
            </button>

            <button
              type="button"
              class="search-filter-chip"
              :class="{ 'search-filter-chip--active': quickFilter === 'stale' }"
              :disabled="staleCount === 0 && quickFilter !== 'stale'"
              @click="toggleQuickFilter('stale')"
            >
              <span class="search-filter-chip__label">{{ t("MyData.index.filter.stale") }}</span>
              <span v-if="staleCount > 0" class="search-filter-count">{{ staleCount }}</span>
            </button>

            <button
              type="button"
              class="search-filter-chip"
              :class="{ 'search-filter-chip--active': quickFilter === 'unread' }"
              :disabled="
                (unreadCount === 0 || !configStore.myDataTableControl.showUnreadMessage) && quickFilter !== 'unread'
              "
              @click="toggleQuickFilter('unread')"
            >
              <span class="search-filter-chip__label">{{ t("MyData.index.filter.unread") }}</span>
              <span v-if="unreadCount > 0" class="search-filter-count">{{ unreadCount }}</span>
            </button>

            <a-popover v-if="Object.keys(groupOptions).length > 0" placement="bottomLeft" trigger="click">
              <button
                type="button"
                class="search-filter-chip"
                :class="{ 'search-filter-chip--active': groupFilterActive }"
              >
                <span class="search-filter-chip__label">
                  {{ t("MyData.index.siteCategory") }}
                </span>
                <span v-if="groupFilterActive" class="search-filter-count">{{
                  groupRequired.length + groupExcluded.length
                }}</span>
                <DownOutlined class="search-filter-chip__arrow" />
              </button>
              <template #content>
                <a-list size="small" class="my-data-filter-list">
                  <a-list-item v-for="(sites, group) in groupOptions" :key="group">
                    <!-- 三态：checked = 只保留该分组；indeterminate = 排除该分组；未勾选 = 不参与筛选 -->
                    <a-checkbox
                      :checked="groupRequired.includes(group)"
                      :indeterminate="groupExcluded.includes(group)"
                      @click.stop.prevent="cycleSiteGroupFilter(group)"
                    >
                      {{ `${group} (${sites.length})` }}
                    </a-checkbox>
                  </a-list-item>
                </a-list>
              </template>
            </a-popover>

            <button v-if="activeFilterCount > 0" type="button" class="my-data-filter-clear" @click="clearFilters">
              {{ t("MyData.index.filter.clear") }}
            </button>
          </div>

          <span class="ptd-meta-text my-data-table-count">
            {{
              t("MyData.table.countLabel", {
                shown: filteredTableData.length,
                total: tableData.length,
              })
            }}
          </span>

          <ColumnSelector
            :headers="fullTableHeader"
            :visible-keys="configStore.tableBehavior.MyData.columns"
            :title="t('common.columnSelector')"
            @update:visible-keys="(keys: string[]) => configStore.updateTableBehavior('MyData', 'columns', keys)"
          />
        </div>
      </template>
      <!-- 站点信息 -->
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'siteUserConfig.sortIndex'">
          <div class="my-data-site-cell">
            <a-badge
              color="error"
              :count="
                configStore.myDataTableControl.showUnreadMessage && (record.messageCount ?? 0) <= 10
                  ? (record.messageCount ?? 0)
                  : 0
              "
              :dot="configStore.myDataTableControl.showUnreadMessage && (record.messageCount ?? 0) > 10"
            >
              <div>
                <SiteFavicon
                  :site-id="record.site"
                  :size="configStore.myDataTableControl.showSiteName ? 18 : 24"
                  :title="t('MyData.table.action.flushData')"
                  @click="() => flushSiteLastUserInfo([record.site])"
                />
              </div>
            </a-badge>

            <SiteName
              v-if="configStore.myDataTableControl.showSiteName"
              class="ptd-cell-ellipsis my-data-name-cell"
              :site-id="record.site"
            />
          </div>
        </template>

        <!-- 用户名，用户ID -->
        <template v-else-if="column.key === 'name'">
          <span
            class="ptd-cell-ellipsis my-data-name-cell"
            :title="
              [configStore.myDataTableControl.showUserName ? (record.name ?? '-') : '******', record.id as string]
                .filter(Boolean)
                .join(' · ')
            "
          >
            {{ configStore.myDataTableControl.showUserName ? (record.name ?? "-") : "******" }}
          </span>
        </template>

        <!-- 等级信息，升级信息 -->
        <template v-else-if="column.key === 'levelName'">
          <UserLevelRequirementsTd :user-info="record" :level-name-max-width="levelNameMaxWidth" />
        </template>

        <!-- 上传、下载 -->
        <template v-else-if="column.key === 'uploaded'">
          <div class="my-data-totals">
            <a-row :gutter="0" class="my-data-num-row">
              <span class="my-data-nowrap">
                {{ typeof record.uploaded !== "undefined" ? formatSize(record.uploaded) : "-" }}
              </span>
              <UpOutlined class="my-data-icon-success" />
            </a-row>
            <a-row :gutter="0" class="my-data-num-row">
              <span class="my-data-nowrap">
                {{ typeof record.downloaded !== "undefined" ? formatSize(record.downloaded) : "-" }}
              </span>
              <DownOutlined class="my-data-icon-danger" />
            </a-row>
          </div>
        </template>

        <!-- 真实上传、下载 -->
        <template v-else-if="column.key === 'trueUploaded'">
          <div class="my-data-totals">
            <a-row :gutter="0" class="my-data-num-row">
              <span class="my-data-nowrap">
                {{ typeof record.trueUploaded !== "undefined" ? formatSize(record.trueUploaded) : "-" }}
              </span>
              <UpOutlined class="my-data-icon-success" />
            </a-row>
            <a-row :gutter="0" class="my-data-num-row">
              <span class="my-data-nowrap">
                {{ typeof record.trueDownloaded !== "undefined" ? formatSize(record.trueDownloaded) : "-" }}
              </span>
              <DownOutlined class="my-data-icon-danger" />
            </a-row>
          </div>
        </template>

        <!-- 分享率 -->
        <template v-else-if="column.key === 'ratio'">
          <span class="my-data-nowrap">{{ formatRatio(record) }}</span>
        </template>

        <!-- 真实分享率 -->
        <template v-else-if="column.key === 'trueRatio'">
          <span class="my-data-nowrap">{{ formatRatio(record, "trueRatio") }}</span>
        </template>

        <!-- 发布数 -->
        <template v-else-if="column.key === 'uploads'">
          <span class="my-data-nowrap">{{ record.uploads ?? "-" }}</span>
        </template>

        <!-- 做种数， H&R 情况  -->
        <template v-else-if="column.key === 'seeding'">
          <div class="my-data-totals">
            <a-row :gutter="0" class="my-data-num-row my-data-num-row--middle">
              <span class="my-data-nowrap">{{ record.seeding ?? "-" }}</span>
            </a-row>
            <a-row
              v-if="configStore.myDataTableControl.showHnR"
              :gutter="0"
              class="my-data-num-row my-data-num-row--middle"
            >
              <span
                v-if="typeof record.hnrPreWarning !== 'undefined' && record.hnrPreWarning > 0"
                class="my-data-inline-icon my-data-inline-icon--warning"
              >
                <WarningOutlined :title="t('levelRequirement.hnrPreWarning')" class="my-data-icon-warning" />
                <span class="my-data-nowrap">
                  {{ record.hnrPreWarning }}
                </span>
              </span>
              <span
                v-if="typeof record.hnrUnsatisfied !== 'undefined' && record.hnrUnsatisfied > 0"
                class="my-data-inline-icon my-data-inline-icon--danger"
              >
                <ExclamationCircleOutlined :title="t('levelRequirement.hnrUnsatisfied')" class="my-data-icon-danger" />
                <span class="my-data-nowrap">
                  {{ record.hnrUnsatisfied }}
                </span>
              </span>
            </a-row>
          </div>
        </template>

        <!-- 做种量 -->
        <template v-else-if="column.key === 'seedingSize'">
          <span class="my-data-nowrap">
            {{ typeof record.seedingSize !== "undefined" ? formatSize(record.seedingSize) : "-" }}
          </span>
        </template>

        <!-- 魔力/积分 -->
        <template v-else-if="column.key === 'bonus'">
          <div class="my-data-totals">
            <a-row :gutter="0" class="my-data-num-row my-data-num-row--middle">
              <DollarOutlined :title="t('levelRequirement.bonus')" class="my-data-icon-success" />
              <BonusFormatSpan :num="record.bonus" />
            </a-row>
            <a-row
              v-if="
                configStore.myDataTableControl.showSeedingBonus &&
                record.seedingBonus !== '' &&
                !isUndefined(record.seedingBonus)
              "
              align="middle"
              justify="end"
              :gutter="0"
              class="my-data-nowrap-row"
            >
              <ThunderboltOutlined :title="t('levelRequirement.seedingBonus')" class="my-data-icon-success" />
              <BonusFormatSpan :num="record.seedingBonus" />
            </a-row>
          </div>
        </template>

        <template v-else-if="column.key === 'bonusPerHour'">
          <BonusFormatSpan :num="record.bonusPerHour" />
        </template>

        <template v-else-if="column.key === 'invites'">
          <span class="my-data-nowrap">{{ typeof record.invites !== "undefined" ? record.invites : "-" }}</span>
        </template>

        <!-- 入站时间 -->
        <template v-else-if="column.key === 'joinTime'">
          <span :title="record.joinTime ? (formatDate(record.joinTime) as string) : '-'" class="my-data-nowrap">
            {{
              typeof record.joinTime !== "undefined"
                ? configStore.myDataTableControl.joinTimeFormat === "aliveWeek"
                  ? formatTimeAgo(record.joinTime, { weekOnly: true })
                  : configStore.myDataTableControl.joinTimeFormat === "alive"
                    ? formatTimeAgo(record.joinTime)
                    : formatDate(record.joinTime, "yyyy-MM-dd")
                : "-"
            }}
          </span>
        </template>

        <!-- 最近访问时间 -->
        <template v-else-if="column.key === 'lastAccessAt'">
          <span :title="record.lastAccessAt ? (formatDate(record.lastAccessAt) as string) : '-'">
            <template v-if="typeof record.lastAccessAt !== 'undefined'">
              <span class="ptd-date-time">{{ formatDateTimeForTable(record.lastAccessAt) }}</span>
              <WarningOutlined
                v-if="record.lastAccessDuration >= 5"
                :title="t('MyData.table.lastAccessDurationNote', [record.lastAccessDuration])"
              />
            </template>
            <template v-else>-</template>
          </span>
        </template>

        <!-- 更新时间 -->
        <template v-else-if="column.key === 'updateAt'">
          <!-- 刷新失败但保留了上次成功的数据：失败原因进 tooltip，同时显示这份数据的最后成功时间 -->
          <div v-if="record.lastFlushFailure" class="my-data-update-failed">
            <a-tooltip :title="flushFailureTitle(record)">
              <a-tag color="error" class="my-data-update-failed__tag">{{ flushFailureLabel(record) }}</a-tag>
            </a-tooltip>
            <span
              v-if="record.updateAt"
              class="ptd-date-time my-data-update-failed__time"
              :title="formatDate(record.updateAt) as string"
            >
              {{ formatDateTimeForTable(record.updateAt) }}
            </span>
          </div>
          <template v-else-if="record.status === EResultParseStatus.success">
            <span class="ptd-date-time" :title="record.updateAt ? (formatDate(record.updateAt) as string) : '-'">
              {{
                record.updateAt
                  ? configStore.myDataTableControl.updateAtFormatAsAlive
                    ? formatTimeAgo(record.updateAt)
                    : formatDateTimeForTable(record.updateAt)
                  : "-"
              }}
            </span>
          </template>
          <span v-else-if="typeof record.status === 'undefined'" class="ptd-meta-text">
            {{ t("MyData.table.notFetched") }}
          </span>
          <template v-else>
            <ResultParseStatus :status="record.status" />
          </template>
        </template>

        <!-- 操作 -->
        <template v-else-if="column.key === 'action'">
          <a-button-group class="table-action">
            <a-button
              :title="t('MyData.table.action.viewHistoryData')"
              @click="() => viewHistoryData(record.site)"
              size="small"
              ><template #icon><UnorderedListOutlined /></template>
            </a-button>
            <a-button
              :disabled="runtimeStore.userInfo.flushPlan[record.site]"
              :loading="runtimeStore.userInfo.flushPlan[record.site]"
              :title="t('MyData.table.action.flushData')"
              @click="() => flushSiteLastUserInfo([record.site])"
              type="primary"
              size="small"
              ><template #icon><SyncOutlined /></template
            ></a-button>
          </a-button-group>
        </template>
      </template>

      <template #emptyText>
        <!-- 只有「真的没有站点」才引导去设置；筛选无匹配时给出清除筛选的出口 -->
        <NoDataPlaceholder
          compact
          :description="tableData.length === 0 ? t('MyData.table.noData') : t('MyData.table.noFilteredData')"
        >
          <a-button v-if="tableData.length === 0" type="primary" @click="goToSiteSettings">
            {{ t("common.goToSiteSettings") }}
          </a-button>
          <a-button v-else @click="clearFilters">{{ t("MyData.index.filter.clear") }}</a-button>
        </NoDataPlaceholder>
      </template>
    </a-table>
  </a-card>

  <HistoryDataViewDialog v-model="showHistoryDataViewDialog" :site-id="historyDataViewDialogSiteId!" />
  <ExportUserInfoDialog v-model="showExportDialog" :selected-site-ids="tableSelected" />
</template>

<style scoped>
/* 以下类由模板里原本重复的静态行内样式抽出；值与原来的内联样式一一对应，
   动态绑定（列宽、海报尺寸等）仍留在模板的 :style 上。 */
.my-data-selection {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  white-space: nowrap;
}

@media (max-width: 640px) {
  .my-data-selection {
    width: 100%;
  }
}

.my-data-summary {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
  margin-bottom: 12px;
}

.my-data-summary__item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-width: 0;
  min-height: 48px;
  padding: 8px 12px;
  border: 1px solid var(--ptd-border, rgba(5, 5, 5, 0.08));
  border-radius: var(--ptd-radius-lg, 8px);
  background: var(--ptd-surface-soft, rgba(0, 0, 0, 0.02));
  color: var(--ptd-text, rgba(0, 0, 0, 0.88));
  text-align: left;
}

.my-data-summary__item strong {
  flex: none;
  font-size: 16px;
  font-variant-numeric: tabular-nums;
  line-height: 24px;
}

.my-data-summary__label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  color: var(--ptd-text-secondary, rgba(0, 0, 0, 0.65));
  font-size: var(--ptd-font-size-sm, 12px);
  white-space: nowrap;
}

.my-data-summary__item--action {
  font: inherit;
  cursor: pointer;
}

.my-data-summary__item--action:disabled {
  cursor: default;
}

.my-data-summary__item--action:not(:disabled):hover {
  border-color: var(--ptd-warning, #faad14);
}

.my-data-summary__item--warning .my-data-summary__label,
.my-data-summary__item--warning strong {
  color: var(--ptd-warning, #faad14);
}

@media (max-width: 960px) {
  .my-data-summary {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 480px) {
  .my-data-summary {
    grid-template-columns: minmax(0, 1fr);
  }
}

.my-data-settings-button {
  margin-right: 4px;
}

.my-data-setting-title {
  font-size: 14px;
}

.my-data-radio-group {
  margin-left: 8px;
}

.my-data-settings-divider {
  margin: 4px 0;
}

.my-data-spacer {
  flex: 1 1 auto;
}

.my-data-filter-list {
  padding: 0;
}

.my-data-table-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.my-data-table-count {
  flex: none;
  white-space: nowrap;
}

.my-data-filter-clear {
  padding: 0 4px;
  border: 0;
  background: none;
  color: var(--ptd-primary, #1677ff);
  cursor: pointer;
  font: inherit;
  font-size: var(--ptd-font-size-sm, 12px);
}

.my-data-filter-clear:hover {
  text-decoration: underline;
}

.my-data-table-toolbar .search-filter-chip:disabled {
  opacity: 0.55;
  cursor: default;
}

/* 刷新失败但保留了上次成功数据：状态标签 + 最后成功时间上下排列 */
.my-data-update-failed {
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
}

.my-data-update-failed__tag {
  margin-inline-end: 0;
}

.my-data-update-failed__time {
  color: var(--ptd-text-secondary, rgba(0, 0, 0, 0.65));
  font-size: var(--ptd-font-size-sm, 12px);
}

.my-data-site-cell {
  display: flex;
  flex-direction: column;
  align-items: center;
}

/* 站点名 / 用户名的截断宽度（原先写死在元素上） */
.my-data-name-cell {
  max-width: 10rem;
}

/* 上传/下载、做种等单元格的两行数字容器 */
.my-data-totals {
  padding: 0;
}

/* 数字行统一右对齐、不换行；--middle 用于带图标的行 */
.my-data-num-row {
  flex-wrap: nowrap;
  justify-content: flex-end;
  margin-top: 0;
  margin-bottom: 0;
}

.my-data-num-row--middle {
  align-items: center;
}

.my-data-nowrap {
  white-space: nowrap;
}

/* 仅禁止换行的 a-row（做种积分行），对齐由 antd 的 align / justify 属性负责 */
.my-data-nowrap-row {
  flex-wrap: nowrap;
}

.my-data-inline-icon {
  display: inline-flex;
  align-items: center;
}

.my-data-inline-icon--warning {
  margin-left: 8px;
}

.my-data-inline-icon--danger {
  margin-left: 4px;
}

/* 语义色统一走主题变量，深色模式自动切换 */
.my-data-icon-success {
  color: var(--ptd-success);
}

.my-data-icon-danger {
  color: var(--ptd-danger);
}

.my-data-icon-warning {
  color: var(--ptd-warning);
}
</style>
