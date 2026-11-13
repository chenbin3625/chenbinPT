<script setup lang="ts">
import {
  BarChartOutlined,
  CalendarOutlined,
  DollarOutlined,
  DownOutlined,
  ExclamationCircleOutlined,
  ExportOutlined,
  FilterOutlined,
  FundOutlined,
  SettingOutlined,
  StopOutlined,
  SyncOutlined,
  ThunderboltOutlined,
  UnorderedListOutlined,
  UpOutlined,
  WarningOutlined,
} from "@ant-design/icons-vue";
import { computed, onMounted, reactive, ref, watch } from "vue";
import { watchDebounced } from "@vueuse/core";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import { isUndefined } from "es-toolkit/compat";
import type { DataTableHeader } from "@/options/types/dataTable.ts";
import { EResultParseStatus, type ISiteUserConfig, type IUserInfo, type TSiteID } from "@ptd/site";

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
import NavButton from "@/options/components/NavButton.vue";
import NoDataPlaceholder from "@/options/components/NoDataPlaceholder.vue";
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
  tableData,
  initTableData,
  cancelFlushSiteLastUserInfo,
  flushSiteLastUserInfo,
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

interface IUserInfoItem extends IUserInfo {
  siteUserConfig: ISiteUserConfig;
  siteName: string;
}

const {
  tableWaitFilterRef,
  tableFilterRef,
  tableFilterFn,
  advanceFilterDictRef,
  updateTableFilterValueFn,
  buildFilterDictFn,
  toggleKeywordStateFn,
} = useTableCustomFilter<IUserInfoItem>({
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
 * 快捷筛选「最后更新状态异常」对应的状态值（字符串形式，供高级筛选匹配使用）。
 *
 * 放在 script 里而不是模板内联：模板里直接写 `EResultParseStatus.xxx` 会触发
 * vue-tsc 的误报（Property 'value' does not exist on type 'typeof EResultParseStatus'），
 * 且这类枚举拼接逻辑本来就该待在脚本层。
 */
const lastUpdateErrorStatusValues = [
  EResultParseStatus.parseError,
  EResultParseStatus.unknownError,
  EResultParseStatus.needLogin,
  EResultParseStatus.noUserInput,
].map((item) => String(item));

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
  tableData.value.filter((item) => tableFilterFn(undefined, tableFilterRef.value, { raw: item })),
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

async function multiOpen() {
  for (const siteId of tableSelected.value) {
    const siteUrl = await metadataStore.getSiteUrl(siteId);
    if (siteUrl) {
      window.open(siteUrl, "_blank", "noopener noreferrer");
    }
  }
}

async function multiFlush() {
  let flushSiteIds: TSiteID[] = tableSelected.value;
  if (flushSiteIds.length === 0) {
    flushSiteIds = tableData.value.map((item) => item.site);
    runtimeStore.showSnackbar(t("MyData.index.noSiteSelectedRefreshAll"), { color: "info" });
  }

  if (flushSiteIds.length > 0) {
    flushSiteLastUserInfo(flushSiteIds);
  } else {
    runtimeStore.showSnackbar(t("MyData.index.noSiteSelectedCancelRefresh"), { color: "warning" });
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

const showExportDialog = ref(false);

/** 空态引导：表格里一个站点都没有时，直接跳到站点设置页添加 */
function goToSiteSettings() {
  void router.push({ name: "SetSite" });
}
</script>

<template>
  <a-card>
    <a-flex class="page-toolbar" align="center" :gap="8">
      <!-- 刷新，取消刷新 -->
      <NavButton
        v-if="runtimeStore.isUserInfoFlush"
        :text="t('MyData.index.flushCancel')"
        color="red"
        :icon="StopOutlined"
        @click="cancelFlushSiteLastUserInfo"
      />

      <NavButton
        v-else
        :text="t('MyData.index.flushSelectSite')"
        color="green"
        :icon="SyncOutlined"
        @click="multiFlush"
      />

      <NavButton
        :disabled="tableSelected.length === 0"
        color="indigo"
        :icon="ExportOutlined"
        :text="t('MyData.index.multiOpen')"
        @click="multiOpen"
      />

      <a-divider type="vertical" class="my-data-toolbar-divider"></a-divider>

      <NavButton color="green" :icon="FundOutlined" :text="t('MyData.index.viewTimeline')" @click="viewTimeline" />
      <NavButton
        color="green"
        :icon="BarChartOutlined"
        :text="t('MyData.index.viewStatistic')"
        @click="viewStatistic"
      />

      <a-divider type="vertical" class="my-data-toolbar-divider"></a-divider>

      <!-- 导出按钮 -->
      <NavButton
        color="orange-darken-3"
        :icon="ExportOutlined"
        :text="t('MyData.index.exportData')"
        @click="showExportDialog = true"
      />

      <a-divider type="vertical" class="my-data-toolbar-divider"></a-divider>

      <a-popover placement="bottom" trigger="click">
        <NavButton
          color="blue"
          :icon="SettingOutlined"
          :text="t('MyData.index.setting')"
          class="my-data-settings-button"
        />
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
        :placeholder="t('common.search')"
        @update:value="onTableFilterInput"
      >
        <template #prefix>
          <a-popover placement="bottom" trigger="click">
            <FilterOutlined />
            <template #content>
              <a-list size="small" class="my-data-filter-list">
                <a-list-item>
                  <a-typography-text strong class="my-data-filter-heading">{{
                    t("MyData.index.siteStatus")
                  }}</a-typography-text>
                </a-list-item>

                <a-list-item
                  class="my-data-filter-option"
                  @click.stop="
                    () => {
                      advanceFilterDictRef.updateAt = [0, new Date().setHours(0, 0, 0, 0) - 1];
                      updateTableFilterValueFn();
                    }
                  "
                >
                  {{ t("MyData.index.filter.todayNotUpdated") }}
                </a-list-item>

                <a-list-item
                  class="my-data-filter-option"
                  @click.stop="
                    () => {
                      advanceFilterDictRef.status.required = lastUpdateErrorStatusValues;
                      updateTableFilterValueFn();
                    }
                  "
                >
                  {{ t("MyData.index.filter.lastUpdateError") }}
                </a-list-item>

                <a-list-item
                  class="my-data-filter-option"
                  @click.stop="
                    () => {
                      advanceFilterDictRef.messageCount = [1, ' '];
                      updateTableFilterValueFn();
                    }
                  "
                >
                  {{ t("MyData.index.filter.unreadMessage") }}
                </a-list-item>

                <a-list-item>
                  <a-typography-text strong class="my-data-filter-heading">{{
                    t("MyData.index.siteCategory")
                  }}</a-typography-text>
                </a-list-item>

                <a-list-item
                  v-for="(item, index) in metadataStore.getSitesGroupData"
                  :key="index"
                  class="my-data-filter-group"
                >
                  <!-- V-21：原为 `:indeterminate="true"`（硬编码）→ antd 只要该属性为真就画半选横杠，
                         用户无法判断哪些分组筛选已生效。真实三态是：
                         checked = 在 required（只保留该分组）；indeterminate = 在 exclude（排除该分组）；
                         未勾选 = 该分组不参与筛选。 -->
                  <a-checkbox
                    :checked="advanceFilterDictRef[`siteUserConfig.groups`].required.includes(index)"
                    :indeterminate="advanceFilterDictRef[`siteUserConfig.groups`].exclude.includes(index)"
                    @click.stop="toggleKeywordStateFn(`siteUserConfig.groups`, index)"
                    @update:checked="
                      (checked: boolean) => {
                        const current = advanceFilterDictRef[`siteUserConfig.groups`].required;
                        advanceFilterDictRef[`siteUserConfig.groups`].required = checked
                          ? Array.from(new Set([...current, index]))
                          : current.filter((x: any) => x !== index);
                        updateTableFilterValueFn();
                      }
                    "
                  >
                    {{ `${index} (${item.length})` }}
                  </a-checkbox>
                </a-list-item>
              </a-list>
            </template>
          </a-popover>
        </template>
      </a-input>
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
          <template v-if="record.status === EResultParseStatus.success">
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
        <!-- 只有「真的没有站点」才引导去设置；筛选无匹配时 tableData 非空，不应把用户送走 -->
        <NoDataPlaceholder compact :description="t('MyData.table.noData')">
          <a-button v-if="tableData.length === 0" type="primary" @click="goToSiteSettings">
            {{ t("common.goToSiteSettings") }}
          </a-button>
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
.my-data-toolbar-divider {
  margin-right: 8px;
  margin-left: 8px;
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

.my-data-filter-heading {
  margin: 8px;
}

.my-data-filter-option {
  cursor: pointer;
}

.my-data-filter-group {
  padding-right: 24px;
}

.my-data-table-toolbar {
  display: flex;
  justify-content: flex-end;
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
