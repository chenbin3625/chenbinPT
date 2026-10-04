<script setup lang="ts">
import {
  AimOutlined,
  CloseCircleFilled,
  DeleteOutlined,
  EditOutlined,
  ExportOutlined,
  FilterOutlined,
  MinusOutlined,
  PlusOutlined,
  ScanOutlined,
  SearchOutlined,
  ToolOutlined,
} from "@ant-design/icons-vue";
import { get } from "es-toolkit/compat";
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { NO_IMAGE, type TSiteID } from "@ptd/site";
import type { DataTableHeader } from "@/options/types/dataTable.ts";

import { sendMessage } from "@/messages.ts";
import { useConfigStore } from "@/options/stores/config.ts";
import { useMetadataStore } from "@/options/stores/metadata.ts";
import { useRuntimeStore } from "@/options/stores/runtime.ts";
import { useTableCustomFilter } from "@/options/directives/useAdvanceFilter.ts";
import { useStoreHydrating } from "@/options/composables/useStoreHydrating.ts";

import AddDialog from "./AddDialog.vue";
import EditDialog from "./EditDialog.vue";
import EditSearchEntryList from "./EditSearchEntryList.vue";
import OneClickImportDialog from "./OneClickImportDialog.vue";
import RebuildMapDialog from "./RebuildMapDialog.vue";
import SiteFavicon from "@/options/components/SiteFavicon/Index.vue";
import DeleteDialog from "@/options/components/DeleteDialog.vue";
import NavButton from "@/options/components/NavButton.vue";
import NoDataPlaceholder from "@/options/components/NoDataPlaceholder.vue";

// 数据来源
import { allAddedSiteInfo, isLoadingAddedSiteInfo, type ISiteTableItem } from "./utils.ts";

const { t } = useI18n();

const configStore = useConfigStore();
const runtimeStore = useRuntimeStore();
const metadataStore = useMetadataStore();

// metadata store 从 chrome.storage 的异步水合期间不能把「空」当最终结果渲染
const isStoreHydrating = useStoreHydrating(metadataStore);

const showAddDialog = ref<boolean>(false);
const showEditDialog = ref<boolean>(false);
const showDeleteDialog = ref<boolean>(false);
const showOneClickImportDialog = ref<boolean>(false);
const showRebuildMapDialog = ref<boolean>(false);

/** 站点展示名：用户自定义名称优先于站点定义名称（名称列被截断时 tooltip 也用它） */
function siteDisplayName(record: ISiteTableItem) {
  return record.userConfig?.merge?.name ?? record.metadata?.name ?? record.id;
}

const tableHeader = computed(() => {
  const baseHeaders = [
    // site favicon
    { title: "№", key: "userConfig.sortIndex", align: "center" },
    { title: t("SetSite.common.name"), key: "name", align: "left", sortable: false },
    {
      title: t("SetSite.common.groups"),
      key: "groups",
      align: "left",
      sortable: false,
      minWidth: "8rem",
    },
    { title: t("SetSite.common.url"), key: "url", align: "start", sortable: false },
    { title: t("SetSite.common.isOffline"), key: "userConfig.isOffline", align: "center" },
    { title: t("SetSite.common.allowSearch"), key: "userConfig.allowSearch", align: "center" },
    {
      title: t("SetSite.common.allowQueryUserInfo"),
      key: "userConfig.allowQueryUserInfo",
      align: "center",
    },
  ];
  if (configStore.contentScript.enabled && configStore.contentScript.allowExceptionSites) {
    baseHeaders.push({
      title: t("SetSite.common.allowContentScript"),
      key: "userConfig.allowContentScript",
      align: "center",
    });
  }

  return [...baseHeaders, { title: t("common.action"), key: "action", sortable: false }] as DataTableHeader[];
});

const booleanUserConfigKeywords = ["isOffline", "allowSearch", "allowQueryUserInfo"];

const {
  tableWaitFilterRef,
  tableFilterRef,
  tableFilterFn,
  advanceFilterDictRef,
  toggleKeywordStateFn,
  buildFilterDictFn,
  updateTableFilterValueFn,
} = useTableCustomFilter<ISiteTableItem>({
  parseOptions: {
    keywords: ["id", ...booleanUserConfigKeywords.map((x) => `userConfig.${x}`), "userConfig.groups"],
  },
  titleFields: ["metadata.name", "metadata.urls", "userConfig.merge.name", "userConfig.url"],
  format: {
    ...Object.fromEntries(booleanUserConfigKeywords.map((x) => [`userConfig.${x}`, "boolean"])),
  },
});

const tableSelected = ref<TSiteID[]>([]);

const columns = computed(() => {
  const multiSort = configStore.enableTableMultiSort;
  const sortBy = configStore.tableBehavior.SetSite.sortBy ?? [];
  return tableHeader.value.map((header) => {
    const key = String(header.key);
    const sortItem = sortBy.find((item) => item.key === key);
    const compare = (a: Record<string, any>, b: Record<string, any>) => {
      const left = get(a, key);
      const right = get(b, key);
      if (typeof left === "number" && typeof right === "number") return left - right;
      return String(left ?? "").localeCompare(String(right ?? ""));
    };
    const order = String(sortItem?.order ?? "");
    return {
      align:
        header.align === "end" || header.align === "right"
          ? ("right" as const)
          : header.align === "start" || header.align === "left"
            ? ("left" as const)
            : ("center" as const),
      dataIndex: key,
      key,
      sorter: header.sortable === false ? false : multiSort ? { compare, multiple: 1 } : compare,
      sortOrder: sortItem ? (order === "desc" || order === "descend" ? "descend" : "ascend") : undefined,
      title: header.title,
    };
  });
});

const dataSource = computed(() =>
  (allAddedSiteInfo.value ?? []).filter((item) => tableFilterFn(undefined, tableFilterRef.value ?? "", { raw: item })),
);

const rowSelection = computed(() => ({
  selectedRowKeys: tableSelected.value,
  onChange: (keys: (string | number)[]) => {
    tableSelected.value = keys as TSiteID[];
  },
}));

/**
 * P2-16：`configStore.tableBehavior.SetSite.itemsPerPage` 默认是 -1（即「全部」），
 * 会让首屏一次性渲染全部已添加站点（当前 300+ 行 × 每行若干开关/菜单）。
 * stores 不在本线修改范围内，这里在视图侧做本地兜底：非正数（-1/-2/非法值）时按 25 行分页。
 * 用户在前端选择具体页大小（5/10/25/50/100）时仍然写回 store 并生效。
 */
const DEFAULT_SET_SITE_ITEMS_PER_PAGE = 25;
const siteTableItemsPerPage = computed(() => {
  const configured = Number(configStore.tableBehavior.SetSite.itemsPerPage);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_SET_SITE_ITEMS_PER_PAGE;
});

const pagination = computed(() => ({
  pageSize: siteTableItemsPerPage.value,
  pageSizeOptions: ["5", "10", "25", "50", "100"],
  showSizeChanger: true,
}));

function onTableChange(tablePagination: { pageSize?: number }, _filters: unknown, sorter: any) {
  const sorters = (Array.isArray(sorter) ? sorter : [sorter])
    .filter((item) => item?.order)
    .map((item) => ({ key: item.columnKey || item.field, order: item.order === "ascend" ? "asc" : "desc" }));
  configStore.updateTableBehavior("SetSite", "sortBy", sorters);

  const nextSize = Number(tablePagination?.pageSize);
  if (Number.isFinite(nextSize) && nextSize !== Number(configStore.tableBehavior.SetSite.itemsPerPage)) {
    configStore.updateTableBehavior("SetSite", "itemsPerPage", nextSize);
  }
}

// 工具栏筛选菜单：点击菜单内容（非复选框）时关闭，与迁移前 PtdMenu 的 close-on-content-click 一致
const filterMenuOpen = ref(false);

function closeFilterMenu() {
  filterMenuOpen.value = false;
}

/** 对齐迁移前 PtdCheckbox（数组模型）的语义：把 value 加入/移出 required 数组 */
function toggleRequiredValue(filterKey: string, value: unknown) {
  const state = advanceFilterDictRef.value[filterKey];
  const required: unknown[] = Array.isArray(state?.required) ? state.required : [];
  state.required = required.includes(value) ? required.filter((item) => item !== value) : [...required, value];
}

function onBoolFilterCheck(keyword: string) {
  const filterKey = `userConfig.${keyword}`;
  toggleKeywordStateFn(filterKey, "1");
  // 必须写入字符串 "1"：format 里的 boolean.build 是 (v) => (v ? "1" : "0")，
  // 写入 undefined 会被格式化成 "0"，查询变成「该字段为 false」，筛选结果与勾选状态相反。
  toggleRequiredValue(filterKey, "1");
  updateTableFilterValueFn();
}

function onGroupFilterCheck(groupName: string) {
  toggleKeywordStateFn("userConfig.groups", groupName);
  toggleRequiredValue("userConfig.groups", groupName);
  updateTableFilterValueFn();
}

const toEditId = ref<TSiteID | null>("");
function editSite(siteId: TSiteID) {
  toEditId.value = siteId;
  showEditDialog.value = true;
}

const toDeleteIds = ref<TSiteID[]>([]);
function deleteSite(siteId: TSiteID[]) {
  toDeleteIds.value = siteId;
  showDeleteDialog.value = true;
}

async function confirmDeleteSite(siteId: TSiteID) {
  return await metadataStore.removeSite(siteId);
}

const isFaviconFlushing = ref(false);
async function flushSiteFavicon(siteId: TSiteID | TSiteID[]) {
  const siteIds = Array.isArray(siteId) ? siteId : [siteId];
  if (siteIds.length === 0 || isFaviconFlushing.value) return;

  isFaviconFlushing.value = true;
  let successCount = 0;
  let failedCount = 0;
  try {
    // 逐个串行刷新，避免一次选中数百个站点时对站点服务器造成瞬时压力
    for (const id of siteIds) {
      try {
        // offscreen 侧取不到图标时会返回默认占位图（NO_IMAGE），据此判定单个站点是否刷新成功
        const favicon = await sendMessage("getSiteFavicon", { site: id, flush: true });
        if (favicon && favicon !== NO_IMAGE) {
          successCount++;
        } else {
          failedCount++;
        }
      } catch {
        failedCount++;
      }
    }
  } finally {
    isFaviconFlushing.value = false;
  }

  // V-20：按实际成功数提示（原实现无论是否失败都报成功，且按钮因 loading 从未置位而可反复点击）
  if (failedCount === 0) {
    runtimeStore.showSnakebar(t("SetSite.index.flushFaviconFinish"), { color: "success" });
  } else {
    runtimeStore.showSnakebar(t("SetSite.index.flushFaviconPartial", { success: successCount, failed: failedCount }), {
      color: successCount > 0 ? "warning" : "error",
    });
  }
}

/** V-21：该关键字当前是否以「排除」形式参与筛选（勾选之外还需要展示的第三种状态） */
function isKeywordExcluded(filterKey: string, value: unknown): boolean {
  const exclude: unknown[] = advanceFilterDictRef.value[filterKey]?.exclude ?? [];
  return exclude.includes(value);
}
</script>

<template>
  <a-card class="ptd-settings-card">
    <template #title>
      <a-flex class="page-toolbar" align="center" :gap="8">
        <NavButton :text="t('common.btn.add')" color="success" :icon="PlusOutlined" @click="showAddDialog = true" />

        <NavButton
          :disabled="tableSelected.length === 0"
          :text="t('common.remove')"
          color="error"
          :icon="MinusOutlined"
          @click="deleteSite(tableSelected)"
        />

        <a-divider style="margin-inline: 8px" type="vertical" />

        <NavButton
          color="info"
          :icon="AimOutlined"
          :text="t('SetSite.index.oneClickImport')"
          @click="() => (showOneClickImportDialog = true)"
        />

        <a-divider style="margin-inline: 8px" type="vertical" />

        <NavButton
          :disabled="tableSelected.length === 0"
          :loading="isFaviconFlushing"
          :text="t('SetSite.index.table.flushFavicon')"
          color="indigo"
          :icon="ScanOutlined"
          @click="() => flushSiteFavicon(tableSelected)"
        />

        <NavButton
          :text="t('SetSite.index.reBuildMap')"
          color="indigo"
          :icon="ToolOutlined"
          @click="showRebuildMapDialog = true"
        />

        <div style="flex: 1 1 auto; min-width: 8px" />
        <a-input v-model:value="tableWaitFilterRef" allow-clear placeholder="Search" style="max-width: 500px">
          <template #prefix>
            <a-popover v-model:open="filterMenuOpen" :trigger="['click']" placement="bottomLeft">
              <template #content>
                <div style="min-width: 180px" @click="closeFilterMenu">
                  <a-checkbox
                    v-for="keyword in booleanUserConfigKeywords"
                    :key="keyword"
                    :checked="advanceFilterDictRef[`userConfig.${keyword}`]?.required?.includes('1')"
                    :indeterminate="isKeywordExcluded(`userConfig.${keyword}`, '1')"
                    style="display: block"
                    @change="() => onBoolFilterCheck(keyword)"
                    @click.stop
                  >
                    {{ t(`SetSite.common.${keyword}`) }}
                  </a-checkbox>

                  <a-divider style="margin: 8px 0" />

                  <div style="margin: 8px">{{ t("SetSite.common.groups") }}</div>
                  <a-checkbox
                    v-for="(item, index) in metadataStore.getSitesGroupData"
                    :key="index"
                    :checked="advanceFilterDictRef['userConfig.groups']?.required?.includes(index)"
                    :indeterminate="isKeywordExcluded('userConfig.groups', index)"
                    style="display: block; padding-right: 24px"
                    @change="() => onGroupFilterCheck(String(index))"
                    @click.stop
                  >
                    {{ index }} ({{ item.length }})
                  </a-checkbox>
                </div>
              </template>
              <FilterOutlined style="cursor: pointer" @click="buildFilterDictFn('')" />
            </a-popover>
          </template>
          <template #suffix>
            <SearchOutlined style="opacity: 0.45" />
          </template>
          <template #clearIcon>
            <CloseCircleFilled @click="buildFilterDictFn('')" />
          </template>
        </a-input>
      </a-flex>
    </template>

    <a-table
      class="table-stripe table-header-no-wrap"
      :columns="columns"
      :data-source="dataSource"
      :loading="isStoreHydrating || isLoadingAddedSiteInfo"
      :pagination="pagination"
      :row-key="(record: ISiteTableItem) => record.id"
      :row-selection="rowSelection"
      @change="onTableChange"
    >
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'userConfig.sortIndex'">
          <div style="display: flex">
            <SiteFavicon :site-id="record.id" />
          </div>
        </template>

        <template v-else-if="column.key === 'name'">
          <a-tooltip v-if="record.metadata.description" :overlay-style="{ maxWidth: '400px' }">
            <template #title>
              <div>{{ siteDisplayName(record) }}</div>
              <span v-if="typeof record.metadata.description === 'string'">{{ record.metadata.description }}</span>
              <div v-else>
                <div v-for="text in record.metadata.description" :key="text">{{ text }}</div>
              </div>
            </template>
            <span class="ptd-cell-ellipsis" style="max-width: 12rem">{{ siteDisplayName(record) }}</span>
          </a-tooltip>
          <span v-else class="ptd-cell-ellipsis" style="max-width: 12rem" :title="siteDisplayName(record)">{{
            siteDisplayName(record)
          }}</span>
        </template>

        <template v-else-if="column.key === 'groups'">
          <span class="ptd-cell-ellipsis" style="max-width: 12rem" :title="(record.userConfig.groups ?? []).join(', ')">
            {{ (record.userConfig.groups ?? []).join(", ") }}
          </span>
        </template>

        <template v-else-if="column.key === 'url'">
          <span
            class="ptd-cell-ellipsis"
            style="max-width: 16rem"
            :title="record.userConfig?.url ?? record.metadata?.urls?.[0]"
          >
            <a-typography-link
              :href="record.userConfig?.url ?? record.metadata?.urls?.[0]"
              rel="noopener noreferrer nofollow"
              target="_blank"
            >
              {{ record.userConfig?.url ?? record.metadata?.urls?.[0] }}
              <ExportOutlined class="ptd-icon-sm" />
            </a-typography-link>
          </span>
        </template>

        <template v-else-if="column.key === 'userConfig.isOffline'">
          <a-switch
            v-model:checked="record.userConfig.isOffline"
            class="table-switch-btn"
            :disabled="record.metadata.isDead"
            @change="(v: boolean) => metadataStore.simplePatch('sites', record.id, 'isOffline', v)"
          />
        </template>

        <template v-else-if="column.key === 'userConfig.allowSearch'">
          <a-switch
            v-model:checked="record.userConfig.allowSearch"
            class="table-switch-btn"
            :disabled="
              record.metadata.isDead || record.userConfig.isOffline || !Object.hasOwn(record.metadata, 'search')
            "
            @change="(v: boolean) => metadataStore.simplePatch('sites', record.id, 'allowSearch', v)"
          />
        </template>

        <template v-else-if="column.key === 'userConfig.allowQueryUserInfo'">
          <a-switch
            v-model:checked="record.userConfig.allowQueryUserInfo"
            class="table-switch-btn"
            :disabled="
              record.metadata.isDead || record.userConfig.isOffline || !Object.hasOwn(record.metadata, 'userInfo')
            "
            @change="(v: boolean) => metadataStore.simplePatch('sites', record.id, 'allowQueryUserInfo', v)"
          />
        </template>

        <template v-else-if="column.key === 'userConfig.allowContentScript'">
          <a-switch
            v-model:checked="record.userConfig.allowContentScript"
            class="table-switch-btn"
            :disabled="record.metadata.isDead || record.userConfig.isOffline"
            @change="(v: boolean) => metadataStore.simplePatch('sites', record.id, 'allowContentScript', v)"
          />
        </template>

        <template v-else-if="column.key === 'action'">
          <a-space class="table-action">
            <!-- 站点信息编辑 -->
            <a-tooltip :title="t('common.edit')">
              <a-button :disabled="record.metadata.isDead" size="small" @click="() => editSite(record.id)">
                <template #icon>
                  <EditOutlined />
                </template>
              </a-button>
            </a-tooltip>

            <!-- 默认站点搜索入口编辑（只有配置了 siteMetadata.searchEntry 的站点才支持该设置） -->
            <a-popover :trigger="['click']" placement="bottom">
              <template #content>
                <EditSearchEntryList :item="record" />
              </template>
              <a-button
                :disabled="record.metadata.isDead || !record.metadata.searchEntry"
                :title="t('SetSite.index.table.searchEntries')"
                size="small"
              >
                <SearchOutlined />
              </a-button>
            </a-popover>

            <a-tooltip :title="t('SetSite.index.table.flushFavicon')">
              <a-button
                :disabled="record.metadata.isDead"
                :loading="isFaviconFlushing"
                size="small"
                @click="() => flushSiteFavicon(record.id)"
              >
                <template #icon>
                  <ScanOutlined />
                </template>
              </a-button>
            </a-tooltip>

            <a-tooltip :title="t('common.remove')">
              <a-button danger size="small" @click="() => deleteSite([record.id])">
                <template #icon>
                  <DeleteOutlined />
                </template>
              </a-button>
            </a-tooltip>
          </a-space>
        </template>
      </template>

      <!-- 无任何已添加站点时的空状态占位 -->
      <template #emptyText>
        <NoDataPlaceholder compact />
      </template>
    </a-table>
  </a-card>

  <AddDialog v-model="showAddDialog" />
  <DeleteDialog v-model="showDeleteDialog" :to-delete-ids="toDeleteIds" :confirm-delete="confirmDeleteSite" />
  <EditDialog v-model="showEditDialog" :site-id="toEditId!" />
  <OneClickImportDialog v-model="showOneClickImportDialog" />
  <RebuildMapDialog v-model="showRebuildMapDialog" />
</template>
