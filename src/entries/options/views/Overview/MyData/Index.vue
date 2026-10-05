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
import { computed, onMounted, reactive, ref } from "vue";
import { watchDebounced } from "@vueuse/core";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import { isUndefined } from "es-toolkit/compat";
import type { DataTableHeader } from "@/options/types/dataTable.ts";
import { EResultParseStatus, type ISiteUserConfig, type IUserInfo, type TSiteID } from "@ptd/site";

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
import { toAntdColumns, toPagination, toSortBy } from "../utils/antdTable.ts";
import {
  tableData,
  initTableData,
  cancelFlushSiteLastUserInfo,
  flushSiteLastUserInfo,
  isTableDataLoading,
} from "./utils/lastUserData.ts";

const { t } = useI18n();
const router = useRouter();
const configStore = useConfigStore();
const runtimeStore = useRuntimeStore();
const metadataStore = useMetadataStore();

// metadata store 需要先从 chrome.storage 异步水合，叠加 initTableData 的异步加载：
// 两者都完成前表格显示 loading，避免先闪一下「暂无数据」再蹦出数据
const isStoreHydrating = useStoreHydrating(metadataStore);
const isTableLoading = computed<boolean>(() => isStoreHydrating.value || isTableDataLoading.value);

const currentDate = new Date();

type TExtendDataTableHeader = DataTableHeader & { props?: any };

const fullTableHeader = reactive([
  {
    title: t("common.site"),
    key: "siteUserConfig.sortIndex",
    align: "center",
    props: { disabled: true },
  },
  { title: t("common.username"), key: "name", align: "center" },
  { title: t("MyData.table.levelName"), key: "levelName", align: "start", width: "15%" },
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
  toAntdColumns(fullTableHeader, {
    sortBy: configStore.tableBehavior.MyData.sortBy,
    multiSort: configStore.enableTableMultiSort,
    visibleKeys: configStore.tableBehavior.MyData.columns,
  }),
);
const filteredTableData = computed(() =>
  tableData.value.filter((item) => tableFilterFn(undefined, tableFilterRef.value, { raw: item })),
);
const tablePagination = computed(() =>
  toPagination(configStore.tableBehavior.MyData.itemsPerPage, (v) =>
    configStore.updateTableBehavior("MyData", "itemsPerPage", v),
  ),
);
function onSelectionChange(keys: (string | number)[]) {
  tableSelected.value = keys as TSiteID[];
}
function onTableChange(_pagination: unknown, _filters: unknown, sorter: unknown) {
  configStore.updateTableBehavior("MyData", "sortBy", toSortBy(sorter as never));
}

const tableSelected = ref<TSiteID[]>([]); // 选中的站点行

// 挂载时加载表格数据
onMounted(() => initTableData());

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
    runtimeStore.showSnakebar(t("MyData.index.noSiteSelectedRefreshAll"), { color: "info" });
  }

  if (flushSiteIds.length > 0) {
    flushSiteLastUserInfo(flushSiteIds);
  } else {
    runtimeStore.showSnakebar(t("MyData.index.noSiteSelectedCancelRefresh"), { color: "warning" });
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
</script>

<template>
  <a-card>
    <a-typography-text strong>
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

        <a-divider type="vertical" style="margin-left: 8px; margin-right: 8px"></a-divider>

        <NavButton color="green" :icon="FundOutlined" :text="t('MyData.index.viewTimeline')" @click="viewTimeline" />
        <NavButton
          color="green"
          :icon="BarChartOutlined"
          :text="t('MyData.index.viewStatistic')"
          @click="viewStatistic"
        />

        <a-divider type="vertical" style="margin-left: 8px; margin-right: 8px"></a-divider>

        <!-- 导出按钮 -->
        <NavButton
          color="orange-darken-3"
          :icon="ExportOutlined"
          :text="t('MyData.index.exportData')"
          @click="showExportDialog = true"
        />

        <a-divider type="vertical" style="margin-left: 8px; margin-right: 8px"></a-divider>

        <a-popover placement="bottom" trigger="click">
          <NavButton color="blue" :icon="SettingOutlined" :text="t('MyData.index.setting')" style="margin-right: 4px" />
          <template #content>
            <a-list size="small">
              <!-- 入站时间显示 -->
              <a-list-item>
                <a-flex align="center" :gap="8">
                  <CalendarOutlined />
                  <span style="font-size: 14px">{{ t("MyData.index.joinTimeFormat") }}</span>
                </a-flex>
                <a-radio-group
                  v-model:value="configStore.myDataTableControl.joinTimeFormat"
                  button-style="solid"
                  style="margin-left: 8px"
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

              <a-divider style="margin: 4px 0" />

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

        <div style="flex: 1 1 auto"></div>

        <a-input
          v-model:value="tableWaitFilterRef"
          allow-clear
          :placeholder="t('common.search')"
          @change="(e: any) => !e.target.value && buildFilterDictFn('')"
        >
          <template #prefix>
            <a-popover placement="bottom" trigger="click">
              <FilterOutlined />
              <template #content>
                <a-list size="small" style="padding: 0">
                  <a-list-item>
                    <a-typography-text strong style="margin: 8px">{{ t("MyData.index.siteStatus") }}</a-typography-text>
                  </a-list-item>

                  <a-list-item
                    style="cursor: pointer"
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
                    style="cursor: pointer"
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
                    style="cursor: pointer"
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
                    <a-typography-text strong style="margin: 8px">{{
                      t("MyData.index.siteCategory")
                    }}</a-typography-text>
                  </a-list-item>

                  <a-list-item
                    v-for="(item, index) in metadataStore.getSitesGroupData"
                    :key="index"
                    style="padding-right: 24px"
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
    </a-typography-text>
    <a-table
      :columns="tableColumns"
      :data-source="filteredTableData"
      :loading="isTableLoading"
      :pagination="tablePagination"
      :row-key="'site'"
      :row-selection="{
        selectedRowKeys: tableSelected,
        onChange: onSelectionChange,
        getCheckboxProps: (record: any) => ({ disabled: record.selectable === false }),
      }"
      :scroll="{ x: 'max-content' }"
      class="table-stripe"
      @change="onTableChange"
    >
      <template #title>
        <div style="display: flex; justify-content: flex-end">
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
          <div style="display: flex; flex-direction: column; align-items: center">
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
              class="ptd-cell-ellipsis"
              style="max-width: 10rem"
              :site-id="record.site"
            />
          </div>
        </template>

        <!-- 用户名，用户ID -->
        <template v-else-if="column.key === 'name'">
          <span
            class="ptd-cell-ellipsis"
            style="max-width: 10rem"
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
          <UserLevelRequirementsTd :user-info="record" />
        </template>

        <!-- 上传、下载 -->
        <template v-else-if="column.key === 'uploaded'">
          <div style="padding-top: 0px; padding-bottom: 0px; padding-right: 0px">
            <a-row :gutter="0" style="justify-content: flex-end; flex-wrap: nowrap">
              <span style="white-space: nowrap">
                {{ typeof record.uploaded !== "undefined" ? formatSize(record.uploaded) : "-" }}
              </span>
              <UpOutlined style="color: var(--ptd-success)" />
            </a-row>
            <a-row :gutter="0" style="justify-content: flex-end; flex-wrap: nowrap">
              <span style="white-space: nowrap">
                {{ typeof record.downloaded !== "undefined" ? formatSize(record.downloaded) : "-" }}
              </span>
              <DownOutlined style="color: var(--ptd-danger)" />
            </a-row>
          </div>
        </template>

        <!-- 真实上传、下载 -->
        <template v-else-if="column.key === 'trueUploaded'">
          <div style="padding-top: 0px; padding-bottom: 0px; padding-right: 0px">
            <a-row :gutter="0" style="justify-content: flex-end; flex-wrap: nowrap">
              <span style="white-space: nowrap">
                {{ typeof record.trueUploaded !== "undefined" ? formatSize(record.trueUploaded) : "-" }}
              </span>
              <UpOutlined style="color: var(--ptd-success)" />
            </a-row>
            <a-row :gutter="0" style="justify-content: flex-end; flex-wrap: nowrap">
              <span style="white-space: nowrap">
                {{ typeof record.trueDownloaded !== "undefined" ? formatSize(record.trueDownloaded) : "-" }}
              </span>
              <DownOutlined style="color: var(--ptd-danger)" />
            </a-row>
          </div>
        </template>

        <!-- 分享率 -->
        <template v-else-if="column.key === 'ratio'">
          <span style="white-space: nowrap">{{ formatRatio(record) }}</span>
        </template>

        <!-- 真实分享率 -->
        <template v-else-if="column.key === 'trueRatio'">
          <span style="white-space: nowrap">{{ formatRatio(record, "trueRatio") }}</span>
        </template>

        <!-- 发布数 -->
        <template v-else-if="column.key === 'uploads'">
          <span style="white-space: nowrap">{{ record.uploads ?? "-" }}</span>
        </template>

        <!-- 做种数， H&R 情况  -->
        <template v-else-if="column.key === 'seeding'">
          <div style="padding-top: 0px; padding-bottom: 0px; padding-right: 0px">
            <a-row
              :gutter="0"
              style="
                align-items: center;
                justify-content: flex-end;
                flex-wrap: nowrap;
                margin-top: 0px;
                margin-bottom: 0px;
              "
            >
              <span style="white-space: nowrap">{{ record.seeding ?? "-" }}</span>
            </a-row>
            <a-row
              v-if="configStore.myDataTableControl.showHnR"
              :gutter="0"
              style="
                align-items: center;
                justify-content: flex-end;
                flex-wrap: nowrap;
                margin-top: 0px;
                margin-bottom: 0px;
              "
            >
              <span
                v-if="typeof record.hnrPreWarning !== 'undefined' && record.hnrPreWarning > 0"
                style="display: inline-flex; align-items: center; margin-left: 8px"
              >
                <WarningOutlined :title="t('levelRequirement.hnrPreWarning')" style="color: var(--ptd-warning)" />
                <span style="white-space: nowrap">
                  {{ record.hnrPreWarning }}
                </span>
              </span>
              <span
                v-if="typeof record.hnrUnsatisfied !== 'undefined' && record.hnrUnsatisfied > 0"
                style="display: inline-flex; align-items: center; margin-left: 4px"
              >
                <ExclamationCircleOutlined
                  :title="t('levelRequirement.hnrUnsatisfied')"
                  style="color: var(--ptd-danger)"
                />
                <span style="white-space: nowrap">
                  {{ record.hnrUnsatisfied }}
                </span>
              </span>
            </a-row>
          </div>
        </template>

        <!-- 做种量 -->
        <template v-else-if="column.key === 'seedingSize'">
          <span style="white-space: nowrap">
            {{ typeof record.seedingSize !== "undefined" ? formatSize(record.seedingSize) : "-" }}
          </span>
        </template>

        <!-- 魔力/积分 -->
        <template v-else-if="column.key === 'bonus'">
          <div style="padding-top: 0px; padding-bottom: 0px; padding-right: 0px">
            <a-row :gutter="0" style="align-items: center; justify-content: flex-end; flex-wrap: nowrap">
              <DollarOutlined :title="t('levelRequirement.bonus')" style="color: var(--ptd-success)" />
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
              style="flex-wrap: nowrap"
            >
              <ThunderboltOutlined :title="t('levelRequirement.seedingBonus')" style="color: var(--ptd-success)" />
              <BonusFormatSpan :num="record.seedingBonus" />
            </a-row>
          </div>
        </template>

        <template v-else-if="column.key === 'bonusPerHour'">
          <BonusFormatSpan :num="record.bonusPerHour" />
        </template>

        <template v-else-if="column.key === 'invites'">
          <span style="white-space: nowrap">{{ typeof record.invites !== "undefined" ? record.invites : "-" }}</span>
        </template>

        <!-- 入站时间 -->
        <template v-else-if="column.key === 'joinTime'">
          <span :title="record.joinTime ? (formatDate(record.joinTime) as string) : '-'" style="white-space: nowrap">
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
        <NoDataPlaceholder compact :description="t('MyData.table.noData')" />
      </template>
    </a-table>
  </a-card>

  <HistoryDataViewDialog v-model="showHistoryDataViewDialog" :site-id="historyDataViewDialogSiteId!" />
  <ExportUserInfoDialog v-model="showExportDialog" :selected-site-ids="tableSelected" />
</template>
