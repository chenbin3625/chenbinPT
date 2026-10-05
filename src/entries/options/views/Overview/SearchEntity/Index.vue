<script setup lang="ts">
import {
  CameraOutlined,
  CheckOutlined,
  ClockCircleOutlined,
  ExclamationCircleOutlined,
  PauseOutlined,
  PlayCircleOutlined,
  SettingOutlined,
  StopOutlined,
  SyncOutlined,
  WarningOutlined,
} from "@ant-design/icons-vue";
import { computed, ref, shallowRef, watch } from "vue";
import { useRoute } from "vue-router";
import { useI18n } from "vue-i18n";
import { useDisplay } from "@/options/composables/useDisplay.ts";
import type { DataTableHeader } from "@/options/types/dataTable.ts";
import { EResultParseStatus, ETorrentStatus } from "@ptd/site";

import { useMetadataStore } from "@/options/stores/metadata.ts";
import { useConfigStore } from "@/options/stores/config.ts";
import { useRuntimeStore } from "@/options/stores/runtime.ts";
import {
  formatDate,
  formatDateTimeForTable,
  formatSize,
  formatTimeAgo,
  stopEventPropagation,
} from "@/options/utils.ts";
import type { ISearchResultTorrent } from "@/shared/types.ts";

import SiteName from "@/options/components/SiteName.vue";
import SiteFavicon from "@/options/components/SiteFavicon/Index.vue";
import TorrentTitleTd from "@/options/components/TorrentTitleTd.vue";
import NoDataPlaceholder from "@/options/components/NoDataPlaceholder.vue";

import ColumnSelector from "../components/ColumnSelector.vue";
import {
  titleColumnMaxWidth as titleColumnMaxWidthFor,
  toAntdColumns,
  toPagination,
  toSortBy,
} from "../utils/antdTable.ts";

import ActionTd from "./ActionTd.vue";
import TorrentProcessTd from "./TorrentProcessTd.vue";
import SearchFilterBar from "./SearchFilterBar.vue";
import SelectionBar from "./SelectionBar.vue";
import SearchStatusDialog from "./SearchStatusDialog.vue";
import SaveSnapshotDialog from "./SaveSnapshotDialog.vue";

// 主要助手方法
import { tableCustomFilter } from "./utils/filter";
import {
  cancelSearchQueue,
  doSearch,
  invalidateSearchTasks,
  retrySearch,
  searchPlanStatus,
  searchQueue,
} from "./utils/search";

const { t } = useI18n();
const route = useRoute();
const configStore = useConfigStore();
const metadataStore = useMetadataStore();
const runtimeStore = useRuntimeStore();
const display = useDisplay();

const showSearchStatusDialog = ref<boolean>(false);
const showSaveSnapshotDialog = ref<boolean>(false);

/**
 * 标题单元格的宽度上限（`undefined` = 不限宽，让标题列吃满剩余宽度）。
 *
 * 规则、理由与实测数据见 `utils/antdTable.ts` 的 `titleColumnMaxWidth`。
 */
const titleColumnMaxWidth = computed(() => titleColumnMaxWidthFor(display.smAndDown.value));

const fullTableHeader = computed(
  () =>
    [
      { title: t("common.site"), key: "site", align: "center", props: { disabled: true } },
      {
        title: t("SearchEntity.index.table.title"),
        key: "title",
        align: "start",
        minWidth: "14rem",
        ...(titleColumnMaxWidth.value ? { maxWidth: titleColumnMaxWidth.value } : {}),
        props: { disabled: true },
      },
      { title: t("SearchEntity.index.table.category"), key: "category", align: "center" },
      { title: t("SearchEntity.index.table.size"), key: "size", align: "end" },
      { title: t("SearchEntity.index.table.seeders"), key: "seeders", align: "end" },
      { title: t("SearchEntity.index.table.leechers"), key: "leechers", align: "end" },
      { title: t("SearchEntity.index.table.completed"), key: "completed", align: "end" },
      { title: t("SearchEntity.index.table.comments"), key: "comments", align: "end" },
      { title: t("SearchEntity.index.table.time"), key: "time", align: "center" },
      {
        title: t("common.action"),
        key: "action",
        align: "center",
        sortable: false,
        width: "130",
        props: { disabled: true },
      },
    ] as (DataTableHeader & { props?: any })[],
);

const { tableFilterRef, tableFilterFn, buildAdvanceItemPropsFn } = tableCustomFilter;

// 使用 shallowRef 优化：种子对象数组不需要深度响应式，提升性能
const tableColumns = computed(() =>
  toAntdColumns(fullTableHeader.value, {
    sortBy: configStore.tableBehavior.SearchEntity.sortBy,
    multiSort: configStore.enableTableMultiSort,
    visibleKeys: configStore.tableBehavior.SearchEntity.columns,
  }),
);
const filteredTableData = computed(() =>
  runtimeStore.search.searchResult.filter((item) => tableFilterFn(undefined, tableFilterRef.value, { raw: item })),
);
const tablePagination = computed(() =>
  toPagination(
    configStore.tableBehavior.SearchEntity.itemsPerPage,
    (v) => configStore.updateTableBehavior("SearchEntity", "itemsPerPage", v),
    { allowUnpaginated: false },
  ),
);
function onSelectionChange(_keys: (string | number)[], rows: ISearchResultTorrent[]) {
  tableSelectedRaw.value = rows;
}
function onTableChange(_pagination: unknown, _filters: unknown, sorter: unknown) {
  configStore.updateTableBehavior("SearchEntity", "sortBy", toSortBy(sorter as never));
}

const tableSelectedRaw = shallowRef<ISearchResultTorrent[]>([]);

/**
 * V-15：快照加载的过期响应守卫。
 * 快速连续切换快照（或先开 A 再开 B）时，先发的请求可能后到；只有最后一次请求的结果才允许写入 store，
 * 否则旧响应会把新快照的数据覆盖掉。
 */
let snapshotLoadToken = 0;

watch(
  () => route.query,
  (newParams, oldParams) => {
    if (newParams.snapshot) {
      const snapshotId = newParams.snapshot as string;
      const loadToken = ++snapshotLoadToken;

      // V-15：切到快照视图前先让在途/排队的实时搜索任务失效并清空队列，
      // 否则它们会继续往被替换掉的 runtimeStore.search.* 里写入，把实时结果污染到快照视图上。
      invalidateSearchTasks();
      cancelSearchQueue();

      metadataStore.getSearchSnapshotData(snapshotId).then((data) => {
        // 过期响应 / 用户已切到别的快照 / 已离开快照视图：直接丢弃
        if (!data || loadToken !== snapshotLoadToken) return;
        if (route.query.snapshot !== snapshotId) return;

        runtimeStore.search = { ...data, snapshot: snapshotId };
        buildAdvanceItemPropsFn();
      });
    } else {
      // 离开快照视图：让在途的快照响应失效
      snapshotLoadToken++;

      if (
        newParams.flush ||
        (newParams.search && newParams.search != oldParams?.search) ||
        (newParams.plan && newParams.plan != oldParams?.plan)
      ) {
        // 清理已选择项 （ #622 ）
        tableSelectedRaw.value = [];
        // V-15：新一轮 flush 搜索同样会整体替换 search.*，先让上一轮的在途/排队任务失效
        invalidateSearchTasks();
        // doSearch 会自动处理过滤器重置
        doSearch((newParams.search as string) ?? "", (newParams.plan as string) ?? "default", true);
      }
    }
  },
  { immediate: true, deep: true },
);

const isSearchingParsed = ref<boolean>(searchQueue.isPaused);

// 清空表格已选种子（底部多选操作条的「取消选择」）
function clearTableSelection() {
  tableSelectedRaw.value = [];
}

function pauseSearchQueue() {
  console.log("pauseSearchQueue", searchQueue);
  searchQueue.pause();
  isSearchingParsed.value = true;
}

function startSearchQueue() {
  console.log("startSearchQueue", searchQueue);
  searchQueue.start();
  isSearchingParsed.value = false;
}

const tableNonBooleanControlKey = ["maxTagCountBeforeGroup", "hiddenTagNames"];

// 过滤出表格控制中非布尔类型的键
const filteredTableBooleanControlKeys = computed(() => {
  return Object.keys(configStore.searchEntifyControl).filter(
    (key) => tableNonBooleanControlKey.indexOf(key) === -1,
  ) as (keyof typeof configStore.searchEntifyControl)[];
});

const hiddenTagNamesText = computed({
  get: () => configStore.searchEntifyControl.hiddenTagNames.join("\n"),
  set: (val: string) => {
    configStore.searchEntifyControl.hiddenTagNames = val
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  },
});

// 相同大小种子分组色条（ #1411 ），len 为 8，按 size 升序循环，保证相邻分组不同色。
// 前四个是语义色（跟随主题变化），后四个没有 antd 语义 token 可对应，固定为四种易区分的色相：
// 这组颜色的职责是「区分分组」而非表达状态，因此不引入 --ptd-* 以外的额外抽象。
const sizeGroupPalette = [
  "var(--ptd-danger)",
  "var(--ptd-primary)",
  "var(--ptd-success)",
  "var(--ptd-warning)",
  "#9C27B0",
  "#00BCD4",
  "#8BC34A",
  "#795548",
];

// sizeKey 以表格中实际展示的大小文本为准：web 解析出的 1.02 GiB 与 API 给出的 bytes 只要展示一致就会同组
const getSizeKey = (size?: number) => (size ? String(formatSize(size)) : "");

const sizeGroupColors = computed(() => {
  const colors = new Map<string, string>();
  const sortBy = configStore.tableBehavior.SearchEntity.sortBy;

  // 仅在开启开关且当前按大小排序时生效
  if (!configStore.searchEntifyControl.highlightSameSizeTorrent || !sortBy?.some((item) => item.key === "size")) {
    return colors;
  }

  const groups = new Map<string, { size: number; count: number }>();
  for (const item of runtimeStore.search.searchResult) {
    if (!item.size) continue;
    const key = getSizeKey(item.size);
    const group = groups.get(key);
    if (group) {
      group.count++;
    } else {
      groups.set(key, { size: item.size, count: 1 });
    }
  }

  // 按 size 升序编号（仅在 count > 1 时才画出色条）
  [...groups.entries()]
    .sort(([, a], [, b]) => a.size - b.size)
    .forEach(([key, { count }], index) => {
      if (count > 1) colors.set(key, sizeGroupPalette[index % sizeGroupPalette.length]!);
    });

  return colors;
});

function sizeGroupRowProps({ item }: { item: ISearchResultTorrent }) {
  const color = sizeGroupColors.value.get(getSizeKey(item.size));
  return color ? { style: { "--ptd-size-group-color": color } } : {};
}

// P1-17：行内 ActionTd 需要数组入参，这里按 item 缓存 [item]，避免模板里每次渲染都新建数组
// 导致子组件 props 引用变化而重复 patch。
const singleItemArrayCache = new WeakMap<ISearchResultTorrent, ISearchResultTorrent[]>();
function singleItemArray(item: ISearchResultTorrent): ISearchResultTorrent[] {
  let cached = singleItemArrayCache.get(item);
  if (!cached) {
    cached = [item];
    singleItemArrayCache.set(item, cached);
  }
  return cached;
}
</script>

<template>
  <div class="ptd-inline-toolbar">
    <strong>
      <template v-if="runtimeStore.search.startAt === 0">
        {{ t("SearchEntity.index.alert.enterKeyword") }}
      </template>
      <template v-else-if="runtimeStore.search.isSearching">
        <template v-if="isSearchingParsed">
          {{ t("SearchEntity.index.alert.paused") }}
        </template>
        <template v-else>
          <template v-if="runtimeStore.search.searchResult.length > 0">
            {{ t("SearchEntity.index.alert.plan") }}
            [{{ metadataStore.getSearchSolutionName(runtimeStore.search.searchPlanKey) }}]，
            {{ t("SearchEntity.index.alert.keyword") }}
            [{{ runtimeStore.search.searchKey }}]，
            {{ t("SearchEntity.index.alert.searchProgress", [runtimeStore.search.searchResult.length]) }}
          </template>
          <template v-else>
            {{ t("SearchEntity.index.alert.searching") }}
          </template>
        </template>
      </template>
      <template v-else>
        <template v-if="runtimeStore.search.snapshot">
          {{ t("SearchEntity.index.alert.snapshot") }}
          [{{ metadataStore.snapshots[runtimeStore.search.snapshot].name }}]，
        </template>
        <template v-else>
          {{ t("SearchEntity.index.alert.plan") }}
          [{{ metadataStore.getSearchSolutionName(runtimeStore.search.searchPlanKey) }}]，
        </template>
        {{ t("SearchEntity.index.alert.keyword") }}
        [{{ runtimeStore.search.searchKey }}]，
        {{ t("SearchEntity.index.alert.results", [runtimeStore.search.searchResult.length]) }}
        {{ t("SearchEntity.index.alert.duration", [(runtimeStore.searchCostTime / 1000).toFixed(1)]) }}
      </template>
    </strong>
    <a-button
      :title="t('SearchEntity.index.alert.searchStatus')"
      class="status-btn"
      @click="showSearchStatusDialog = true"
      type="primary"
      size="small"
    >
      <span v-if="searchPlanStatus.success > 0" class="status-btn__item">
        {{ searchPlanStatus.success }}<CheckOutlined class="ptd-icon-sm" />
      </span>
      <span v-if="searchPlanStatus.error > 0" class="status-btn__item">
        {{ searchPlanStatus.error }}<WarningOutlined class="ptd-icon-sm" style="color: var(--ptd-warning)" />
      </span>
      <span v-if="searchPlanStatus.queued > 0" class="status-btn__item">
        {{ searchPlanStatus.queued }}<ClockCircleOutlined class="ptd-icon-sm" style="color: var(--ptd-text-tertiary)" />
      </span>
    </a-button>
  </div>
  <a-card>
    <a-typography-text strong>
      <a-flex class="page-toolbar" align="center" :gap="8">
        <!-- 搜索队列控制：文字按钮（title 保留完整说明作为悬停提示） -->
        <a-flex align="center" :gap="4">
          <!-- 启动/暂停 搜索队列 -->
          <a-button
            v-show="isSearchingParsed"
            :title="t('SearchEntity.index.action.start')"
            @click="() => startSearchQueue()"
            type="primary"
            ><template #icon><PlayCircleOutlined /></template>
            {{ t("SearchEntity.index.actionLabel.start") }}
          </a-button>
          <a-button
            v-show="!isSearchingParsed"
            :title="t('SearchEntity.index.action.pause')"
            @click="() => pauseSearchQueue()"
            type="primary"
            ><template #icon><PauseOutlined /></template>
            {{ t("SearchEntity.index.actionLabel.pause") }}
          </a-button>

          <!-- 取消/重试 搜索队列 -->
          <a-button
            v-show="runtimeStore.search.isSearching"
            :title="t('SearchEntity.index.action.cancel')"
            @click="cancelSearchQueue"
            danger
            ><template #icon><StopOutlined /></template>
            {{ t("SearchEntity.index.actionLabel.cancel") }}
          </a-button>
          <a-button
            v-show="!runtimeStore.search.isSearching"
            :disabled="isSearchingParsed"
            :title="t('SearchEntity.index.action.retry')"
            @click="() => doSearch(null as unknown as string, null as unknown as string, true)"
            danger
            ><template #icon><SyncOutlined /></template>
            {{ t("SearchEntity.index.actionLabel.retry") }}
          </a-button>

          <!-- 重试失败的搜索 -->
          <a-button
            :disabled="searchPlanStatus.error === 0"
            :title="t('SearchEntity.index.action.retryFailed')"
            @click="() => retrySearch()"
            ><template #icon><ExclamationCircleOutlined /></template>
            {{ t("SearchEntity.index.actionLabel.retryFailed") }}
          </a-button>
        </a-flex>

        <a-divider type="vertical" style="margin-left: 8px; margin-right: 8px"></a-divider>

        <!-- 创建搜索快照 -->
        <a-button
          :disabled="runtimeStore.search.isSearching || runtimeStore.search.searchResult.length === 0"
          :title="t('SearchEntity.index.action.saveSnapshot')"
          @click="showSaveSnapshotDialog = true"
          ><template #icon><CameraOutlined /></template>
          {{ t("SearchEntity.index.actionLabel.saveSnapshot") }}
        </a-button>

        <a-divider type="vertical" style="margin-left: 8px; margin-right: 8px"></a-divider>

        <a-popover placement="bottom" trigger="click">
          <a-button :title="t('SearchEntity.index.action.displayPreferences')"
            ><template #icon><SettingOutlined /></template>
            {{ t("SearchEntity.index.actionLabel.displayPreferences") }}
          </a-button>
          <template #content>
            <a-list>
              <a-list-item v-for="item in filteredTableBooleanControlKeys" :key="item">
                <div
                  style="
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    gap: 16px;
                    min-width: 180px;
                  "
                >
                  <!-- antd 的 a-switch 不渲染默认插槽，文案必须放在同级节点 -->
                  <span>{{ t("SearchEntity.index." + item) }}</span>
                  <!-- a-switch 的 click 载荷是 (newChecked, event)，不能用 `.stop` 修饰符（见 stopEventPropagation） -->
                  <a-switch
                    v-model:checked="configStore.searchEntifyControl[item]"
                    @click="stopEventPropagation"
                    @update:checked="() => configStore.$save()"
                  />
                </div>
              </a-list-item>
              <a-list-item v-if="configStore.searchEntifyControl.showTorrentTag" style="margin-top: 8px">
                <a-form-item :label="t('SetBase.searchEntity.hiddenTagNames')"
                  ><a-textarea v-model:value="hiddenTagNamesText" :rows="5" allow-clear></a-textarea
                ></a-form-item>
              </a-list-item>
            </a-list>
          </template>
        </a-popover>
      </a-flex>
    </a-typography-text>

    <div style="padding-top: 8px; padding-bottom: 0px">
      <SearchFilterBar />

      <a-table
        id="ptd-search-entity-table"
        :columns="tableColumns"
        :data-source="filteredTableData"
        :loading="runtimeStore.search.isSearching && runtimeStore.search.searchResult.length === 0"
        :pagination="tablePagination"
        :row-key="'uniqueId'"
        :row-selection="{ selectedRowKeys: tableSelectedRaw.map((item) => item.uniqueId), onChange: onSelectionChange }"
        :custom-row="(record: any) => sizeGroupRowProps({ item: record })"
        :scroll="{ x: 'max-content' }"
        class="table-stripe"
        @change="onTableChange"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'site'">
            <div style="display: flex; flex-direction: column; align-items: center">
              <SiteFavicon :site-id="record.site" :size="configStore.searchEntifyControl.showSiteName ? 18 : 24" />
              <SiteName
                v-if="configStore.searchEntifyControl.showSiteName"
                class="ptd-cell-ellipsis"
                style="max-width: 10rem"
                :site-id="record.site"
              />
            </div>
          </template>

          <!-- 主标题，副标题，优惠及标签 -->
          <template v-else-if="column.key === 'title'">
            <TorrentTitleTd :item="record" :max-width="titleColumnMaxWidth" />
          </template>

          <!-- 种子大小，下载情况 -->
          <template v-else-if="column.key === 'size'">
            <!-- 使用零间距布局，让大小与进度条保持紧凑对齐 -->
            <div style="padding: 0px">
              <a-row :gutter="0">
                <a-col flex="1 1 0" style="padding: 0px">
                  <span style="white-space: nowrap">{{ formatSize(record.size ?? 0) }}</span>
                </a-col>
              </a-row>
              <a-row v-if="record.status && (record.status as ETorrentStatus) !== ETorrentStatus.unknown" :gutter="0">
                <a-col flex="1 1 0" style="padding: 0px">
                  <TorrentProcessTd :torrent="record"></TorrentProcessTd>
                </a-col>
              </a-row>
            </div>
          </template>

          <!-- 上传人数 -->
          <template v-else-if="column.key === 'seeders'">
            <span style="white-space: nowrap">{{ record.seeders }}</span>
          </template>

          <!-- 下载人数 -->
          <template v-else-if="column.key === 'leechers'">
            <span style="white-space: nowrap">{{ record.leechers }}</span>
          </template>

          <!-- 完成人数 -->
          <template v-else-if="column.key === 'completed'">
            <span style="white-space: nowrap">{{ record.completed }}</span>
          </template>

          <!-- 评论人数 -->
          <template v-else-if="column.key === 'comments'">
            <span style="white-space: nowrap">{{ record.comments }}</span>
          </template>

          <!-- 发布日期 -->
          <template v-else-if="column.key === 'time'">
            <span class="ptd-date-time" :title="record.time ? (formatDate(record.time) as string) : '-'">
              {{
                record.time
                  ? configStore.searchEntifyControl.uploadAtFormatAsAlive
                    ? formatTimeAgo(record.time)
                    : formatDateTimeForTable(record.time)
                  : "-"
              }}
            </span>
          </template>

          <!-- 其他操作 -->
          <template v-else-if="column.key === 'action'">
            <ActionTd :torrent-items="singleItemArray(record)" compact :show-keep-upload-btn="false" />
          </template>
        </template>

        <template #emptyText>
          <NoDataPlaceholder compact :description="t('SearchEntity.index.noData')" />
        </template>
        <template #title>
          <div style="display: flex; justify-content: flex-end">
            <ColumnSelector
              :headers="fullTableHeader"
              :visible-keys="configStore.tableBehavior.SearchEntity.columns"
              :title="t('common.columnSelector')"
              @update:visible-keys="
                (keys: string[]) => configStore.updateTableBehavior('SearchEntity', 'columns', keys)
              "
            />
          </div>
        </template>
      </a-table>
    </div>
  </a-card>

  <SearchStatusDialog v-model="showSearchStatusDialog" />
  <SaveSnapshotDialog v-model="showSaveSnapshotDialog" />

  <!-- 多选操作条：仅在选中种子后出现在页面底部 -->
  <SelectionBar :selected-torrents="tableSelectedRaw" @clear="clearTableSelection" />
</template>
