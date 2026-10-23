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
import { useRoute, useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { useDisplay } from "@/options/composables/useDisplay.ts";
import type { DataTableHeader } from "@/options/types/dataTable.ts";
import { EResultParseStatus, ETorrentStatus } from "@ptd/site";

import { useMetadataStore } from "@/options/stores/metadata.ts";
import { useConfigStore } from "@/options/stores/config.ts";
import {
  useRuntimeStore,
  consumeRuntimeRestoreInterruption,
  reconcileRuntimeInFlightState,
} from "@/options/stores/runtime.ts";
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
import { getActiveTagFilterNames, tableCustomFilter, toggleTagFilter } from "./utils/filter";
import {
  cancelSearchQueue,
  doSearch,
  invalidateSearchTasks,
  isFlushQuery,
  normalizeRouteQueryValue,
  pauseSearchQueue as pauseSearchQueueState,
  reconcileRestoredSearchState,
  resolveRouteSearchDecision,
  retrySearch,
  searchPlanStatus,
  searchQueue,
  searchQueuePaused,
  startSearchQueue as startSearchQueueState,
  stripFlushFromQuery,
  waitForSearchQueueIdle,
} from "./utils/search";
import { getSearchSolutionDisplayName } from "./utils/planName";

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
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

// 标题列标签点击筛选后，已激活的标签名（读的是与筛选条共用的 advanceFilterDictRef，故两边同步）
const activeTagFilterNames = computed(() => getActiveTagFilterNames());

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

/** 是否处于搜索快照视图：快照数据不允许与实时搜索结果混用 */
const inSnapshotView = computed(() => Boolean(runtimeStore.search.snapshot));

/**
 * D2-03：处理完 flush 后把它从 URL 上摘掉。
 *
 * 修复前 flush 一直留在地址里（全仓没有 replace），于是刷新/后退到同一个 URL 都会再次走
 * 「清空结果 + 无条件重搜」的分支；用户只是刷新页面，搜索结果就被清空重来。
 */
function removeFlushFromRoute() {
  if (!isFlushQuery(route.query.flush)) return;

  void router
    .replace({
      path: route.path,
      query: stripFlushFromQuery(route.query as Record<string, unknown>) as Record<string, any>,
      hash: route.hash,
    })
    .catch(() => {
      // 导航被取消（用户已离开 / 又触发了新导航）：本次搜索不受影响，忽略即可
    });
}

function showSearchError(error: unknown) {
  // F13：doSearch 的失败（方案展开抛错等）原先无人观察，只剩一条 unhandled rejection。
  runtimeStore.showSnakebar(error instanceof Error ? error.message : String(error), { color: "error" });
}

/**
 * OUI-2：`doSearch()` resolve 只代表「任务已全部入队」，不代表搜索完成。
 * 旧实现 `finally(removeFlushFromRoute)` 在入队完成的毫秒级内就把 flush 摘掉；此时刷新页面，
 * 恢复出来的部分结果会被 `resolveRouteSearchDecision` 判定为「与 URL 匹配」而不再重搜，
 * 用户以为看到的是完整结果。这里等队列真正 idle（所有任务结束、`idle` 收尾已执行）再摘 flush。
 */
async function runSearch(search: string, plan: string) {
  try {
    await doSearch(search, plan, true);
  } catch (error) {
    showSearchError(error);
  } finally {
    await waitForSearchQueueIdle();
    removeFlushFromRoute();
  }
}

/**
 * D2-01：先对账从 sessionStorage 恢复的「在途」搜索状态。
 *
 * 恢复出来的 `isSearching` / waiting 计划没有对应的队列任务，不收敛的话页面会永远停在
 * 「搜索中…」、顶栏搜索按钮被禁用。详见 `reconcileRestoredSearchState()`。
 */
reconcileRestoredSearchState();

/**
 * OUI-2：把「上次搜索被中断」的收尾事件提示给用户（此前 `getRuntimeRestoreInterruptions()`
 * 在生产代码里零调用者）。
 *
 * 恢复阶段会把 isSearching 置 false、waiting/working 计划改写为 `passParse + i18n.userCancel`；
 * 不提示的话用户看到的是「部分结果 + 共找到 N 条」，且这些计划不在「重试失败」集合里。
 * 同一会话内只提示一次（consume 之后标记清除），避免每次进出搜索页重复弹窗。
 * `reconcileRuntimeInFlightState` 覆盖恢复阶段之外的同类僵尸状态。
 */
{
  const restoredInterrupted = consumeRuntimeRestoreInterruption("search");
  const reconciledInterrupted = reconcileRuntimeInFlightState(runtimeStore).search;
  if (restoredInterrupted || reconciledInterrupted) {
    runtimeStore.showSnakebar(t("SearchEntity.index.alert.searchInterrupted"), { color: "warning" });
  }
}

watch(
  () => route.query,
  (newParams, oldParams) => {
    const snapshotId = normalizeRouteQueryValue(newParams.snapshot);

    if (snapshotId) {
      const loadToken = ++snapshotLoadToken;
      const flush = isFlushQuery(newParams.flush);

      // V-15：切到快照视图前先让在途/排队的实时搜索任务失效并清空队列，
      // 否则它们会继续往被替换掉的 runtimeStore.search.* 里写入，把实时结果污染到快照视图上。
      invalidateSearchTasks();
      cancelSearchQueue();

      void metadataStore
        .getSearchSnapshotData(snapshotId)
        .then((data) => {
          // 过期响应 / 用户已切到别的快照 / 已离开快照视图：直接丢弃
          if (loadToken !== snapshotLoadToken) return;
          if (normalizeRouteQueryValue(route.query.snapshot) !== snapshotId) return;

          if (!data) {
            // F3：快照已被删除（从 sessionStorage 还原的 search.snapshot 或回退到 ?snapshot=）。
            // 只清残留标记会把上一份数据留在 store 里，界面改走「实时结果」分支继续展示旧数据
            // （还能被「保存快照」另存为新快照）。这里整份清空并离开这个已失效的快照地址。
            runtimeStore.resetSearchData();
            clearSnapshotRoute();
            return;
          }

          runtimeStore.search = { ...data, snapshot: snapshotId };
          buildAdvanceItemPropsFn();
        })
        .catch((error) => {
          // F13：快照读取失败（offscreen 不可用 / IndexedDB 数据缺失）原先没有任何 catch，
          // 页面停在旧数据上一声不响。这里清空并明确提示。
          if (loadToken !== snapshotLoadToken) return;
          runtimeStore.resetSearchData();
          runtimeStore.showSnakebar(t("SearchResultSnapshot.notFound"), { color: "error" });
          clearSnapshotRoute();
        })
        .finally(() => {
          if (flush && loadToken === snapshotLoadToken) removeFlushFromRoute();
        });
      return;
    }

    // 离开快照视图：让在途的快照响应失效
    snapshotLoadToken++;

    const decision = resolveRouteSearchDecision({
      query: newParams as Record<string, unknown>,
      previousQuery: oldParams as Record<string, unknown> | undefined,
      state: {
        snapshot: runtimeStore.search.snapshot,
        searchKey: runtimeStore.search.searchKey,
        searchPlanKey: runtimeStore.search.searchPlanKey,
        startAt: runtimeStore.search.startAt,
        resultCount: runtimeStore.search.searchResult.length,
      },
    });

    // 快照数据不能当作实时结果展示（F3 的逆操作：URL 已无 snapshot 时 store 里仍是快照数据）
    if (decision.resetData) runtimeStore.resetSearchData();

    if (decision.search !== undefined) {
      // 清理已选择项 （ #622 ）
      tableSelectedRaw.value = [];
      // V-15：新一轮 flush 搜索同样会整体替换 search.*，先让上一轮的在途/排队任务失效
      invalidateSearchTasks();
      void runSearch(decision.search, decision.plan ?? "default");
    }
  },
  { immediate: true, deep: true },
);

/** 已失效的快照不能继续留在地址里，否则每次刷新都会重复一次「加载失败」 */
function clearSnapshotRoute() {
  const { snapshot: _snapshot, ...rest } = route.query as Record<string, unknown>;
  void router
    .replace({ path: route.path, query: stripFlushFromQuery(rest) as Record<string, any>, hash: route.hash })
    .catch(() => undefined);
}

// 队列暂停状态是「响应式唯一事实来源」（PQueue.isPaused 本身不是响应式的）
const isSearchingParsed = searchQueuePaused;

// 保留原有的暂停/开始调试日志（排查队列问题时能直接看到队列实例与状态）
function pauseSearchQueue() {
  console.log("pauseSearchQueue", searchQueue);
  pauseSearchQueueState();
}

function startSearchQueue() {
  console.log("startSearchQueue", searchQueue);
  startSearchQueueState();
}

/** 清空表格已选种子（底部多选操作条的「取消选择」） */
function clearTableSelection() {
  tableSelectedRaw.value = [];
}

/**
 * D2-05：搜索结果被整体替换（新一轮搜索 / 单方案重搜）后，已选种子可能已不在结果里，
 * 底部操作条会继续对已消失的行生效。这里按 uniqueId 裁剪选择集。
 * 只裁剪「结果集里已经没有的项」，表格筛选隐藏的行仍然保留（配合 preserveSelectedRowKeys）。
 */
watch(
  () => runtimeStore.search.searchResult,
  (searchResult) => {
    if (tableSelectedRaw.value.length === 0) return;
    const existing = new Set(searchResult.map((item) => item.uniqueId));
    const nextSelected = tableSelectedRaw.value.filter((item) => existing.has(item.uniqueId));
    if (nextSelected.length !== tableSelectedRaw.value.length) tableSelectedRaw.value = nextSelected;
  },
);

/**
 * F6：隐藏标签文本域只改内存，config store 没有自动保存（插件未配 autoSaveType）——
 * 失焦时显式落盘，与同弹层里的开关一致。
 */
function saveSearchControl() {
  void configStore.$save();
}

/** F12：`getSearchSolutionName("all")` 在 store 里硬编码中文「全站」，英文界面会中英混排 */
function getSearchSolutionName(planKey: string) {
  return getSearchSolutionDisplayName(planKey, (key) => metadataStore.getSearchSolutionName(key));
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
            [{{ getSearchSolutionName(runtimeStore.search.searchPlanKey) }}]，
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
          [{{ metadataStore.snapshots[runtimeStore.search.snapshot]?.name ?? runtimeStore.search.snapshot }}]，
        </template>
        <template v-else>
          {{ t("SearchEntity.index.alert.plan") }}
          [{{ getSearchSolutionName(runtimeStore.search.searchPlanKey) }}]，
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
            :disabled="isSearchingParsed || inSnapshotView"
            :title="t('SearchEntity.index.action.retry')"
            @click="() => doSearch()"
            danger
            ><template #icon><SyncOutlined /></template>
            {{ t("SearchEntity.index.actionLabel.retry") }}
          </a-button>

          <!-- 重试失败的搜索 -->
          <a-button
            :disabled="searchPlanStatus.error === 0 || inSnapshotView"
            :title="t('SearchEntity.index.action.retryFailed')"
            @click="() => retrySearch()"
            ><template #icon><ExclamationCircleOutlined /></template>
            {{ t("SearchEntity.index.actionLabel.retryFailed") }}
          </a-button>
        </a-flex>

        <a-divider type="vertical" style="margin-left: 8px; margin-right: 8px"></a-divider>

        <!-- 创建搜索快照 -->
        <a-button
          :disabled="runtimeStore.search.isSearching || runtimeStore.search.searchResult.length === 0 || inSnapshotView"
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
                  ><a-textarea
                    v-model:value="hiddenTagNamesText"
                    :rows="5"
                    allow-clear
                    @blur="saveSearchControl"
                  ></a-textarea
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
        :row-selection="{
          selectedRowKeys: tableSelectedRaw.map((item) => item.uniqueId),
          onChange: onSelectionChange,
          // D2-05：表格筛选/分页改变 dataSource 时，antd 默认会把「不在当前 dataSource 里」的
          // 已选 key 丢弃（甚至在下一次勾选时静默取消之前的选中项）。这里保留选择集，
          // 由上面的 watch 在「结果集真正被替换」时裁剪。
          preserveSelectedRowKeys: true,
        }"
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
            <TorrentTitleTd
              :active-tag-names="activeTagFilterNames"
              :item="record"
              :max-width="titleColumnMaxWidth"
              :tag-filterable="configStore.searchEntifyControl.tagClickToFilter"
              @filter-tag="toggleTagFilter"
            />
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
