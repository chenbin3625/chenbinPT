<script setup lang="ts">
import { ClearOutlined, CommentOutlined, DeleteOutlined, FolderOutlined } from "@ant-design/icons-vue";
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { refDebounced } from "@vueuse/core";
import type { DataTableHeader } from "@/options/types/dataTable.ts";

import { sendMessage } from "@/messages.ts";
import { formatDateTimeForTable, formatSize } from "@/options/utils.ts";
import { useConfigStore } from "@/options/stores/config.ts";
import { useRuntimeStore } from "@/options/stores/runtime.ts";
import type { ITorrentFavoriteItem, TTorrentFavoriteKey } from "@/shared/types.ts";

import ActionTd from "@/options/views/Overview/SearchEntity/ActionTd.vue";
import DeleteDialog from "@/options/components/DeleteDialog.vue";
import NavButton from "@/options/components/NavButton.vue";
import NoDataPlaceholder from "@/options/components/NoDataPlaceholder.vue";
import SiteFavicon from "@/options/components/SiteFavicon/Index.vue";
import SiteName from "@/options/components/SiteName.vue";
import TorrentTitleTd from "@/options/components/TorrentTitleTd.vue";
import { confirmModal } from "../utils/antdConfirm.ts";
import { matchesHeaders, toAntdColumns, toPagination, toSortBy } from "../utils/antdTable.ts";

const { t } = useI18n();
const configStore = useConfigStore();
const runtimeStore = useRuntimeStore();

const favorites = ref<ITorrentFavoriteItem[]>([]);
const selectedKeys = ref<TTorrentFavoriteKey[]>([]);
const favCategoryFilter = ref<string[]>([]); // 空数组表示全部分类，"" 表示未分类，其余为分类名（可多选）
const loading = ref(false);

const tableWaitFilter = ref("");
const tableFilter = refDebounced(tableWaitFilter, 500); // 延迟搜索过滤词的生成

// 表头随语言切换重新求值；标题列与搜索结果页一致限宽（长标题截断），其余列给固定宽度
const tableHeader = computed<DataTableHeader[]>(() => [
  { title: t("common.site"), key: "site", align: "center", sortable: false, width: 80 },
  { title: t("MyCollection.table.title"), key: "title", align: "start", minWidth: "18rem" },
  { title: t("MyCollection.table.category"), key: "category", align: "center", width: 90 },
  { title: t("MyCollection.table.favCategories"), key: "favCategories", align: "center", width: 140, sortable: false },
  { title: t("MyCollection.table.size"), key: "size", align: "end", width: 100 },
  { title: t("MyCollection.table.time"), key: "time", align: "center", width: 150 },
  { title: t("MyCollection.table.createdAt"), key: "createdAt", align: "center", width: 160 },
  { title: t("common.action"), key: "action", align: "center", width: 150, sortable: false },
]);

/** 表格里的关键字过滤只看这些文本字段（站点 id、标题、副标题、备注） */
const filterHeaders: DataTableHeader[] = [{ key: "site" }, { key: "title" }, { key: "subTitle" }, { key: "comment" }];

const columns = computed(() =>
  toAntdColumns(tableHeader.value, {
    sortBy: configStore.tableBehavior.MyCollection?.sortBy,
    multiSort: configStore.enableTableMultiSort,
  }),
);

const tablePagination = computed(() =>
  toPagination(
    configStore.tableBehavior.MyCollection?.itemsPerPage ?? 25,
    (v) => configStore.updateTableBehavior("MyCollection", "itemsPerPage", v),
    { allowUnpaginated: false },
  ),
);

function onTableChange(_pagination: unknown, _filters: unknown, sorter: unknown) {
  configStore.updateTableBehavior("MyCollection", "sortBy", toSortBy(sorter as never));
}

function onSelectionChange(keys: (string | number)[]) {
  selectedKeys.value = keys as TTorrentFavoriteKey[];
}

// 已有收藏分类（不含未分类），既用于筛选也用于表格中的分类标签
const favCategories = computed(() => [...new Set(favorites.value.flatMap((x) => x.favCategories ?? []))]);

// 未分类 / 各分类的收藏数量（展示在下拉项右侧）
const favCategoryCounts = computed(() => {
  const counts = new Map<string, number>([["", 0]]);
  for (const favorite of favorites.value) {
    const categories = favorite.favCategories ?? [];
    if (categories.length === 0) {
      counts.set("", (counts.get("") ?? 0) + 1);
    }
    for (const category of categories) {
      counts.set(category, (counts.get(category) ?? 0) + 1);
    }
  }
  return counts;
});

const favCategoryFilterOptions = computed(() => [
  { label: t("MyCollection.table.unclassified"), value: "", count: favCategoryCounts.value.get("") ?? 0 },
  ...favCategories.value.map((category) => ({
    label: category,
    value: category,
    count: favCategoryCounts.value.get(category) ?? 0,
  })),
]);

// 空数组表示全部分类；"" 表示未分类；其余为分类名（可多选，命中任一即展示）
const filteredFavorites = computed(() => {
  const filters = favCategoryFilter.value;
  return favorites.value.filter((favorite) => {
    const categories = favorite.favCategories ?? [];
    const matchCategory =
      filters.length === 0 ||
      filters.some((filter) => (filter === "" ? categories.length === 0 : categories.includes(filter)));
    return matchCategory && matchesHeaders(favorite, tableFilter.value, filterHeaders);
  });
});

// 批量操作只作用于「当前可见且仍被勾选」的收藏（筛选后隐藏的行不参与）
const selectedFavorites = computed(() => {
  const selected = new Set(selectedKeys.value);
  return filteredFavorites.value.filter((x) => selected.has(x.key));
});

// 行内 ActionTd 需要稳定的单元素数组引用，避免每次渲染都让子组件拿到新数组
const singleItemArrayCache = new WeakMap<ITorrentFavoriteItem, ITorrentFavoriteItem[]>();
function singleItemArray(item: ITorrentFavoriteItem): ITorrentFavoriteItem[] {
  let cached = singleItemArrayCache.get(item);
  if (!cached) {
    cached = [item];
    singleItemArrayCache.set(item, cached);
  }
  return cached;
}

async function loadFavorites() {
  loading.value = true;
  try {
    favorites.value = await sendMessage("getTorrentFavorites", undefined);
  } catch {
    runtimeStore.showSnakebar(t("MyCollection.loadError"), { color: "error" });
    favorites.value = [];
  } finally {
    loading.value = false;
    // 重新加载后，选择集里不能残留已不存在的收藏
    const existing = new Set(favorites.value.map((x) => x.key));
    selectedKeys.value = selectedKeys.value.filter((key) => existing.has(key));
  }
}

onMounted(() => {
  void loadFavorites();
});

const showDeleteDialog = ref(false);
const toDeleteKeys = ref<TTorrentFavoriteKey[]>([]);

function tryToDelete(keys: TTorrentFavoriteKey[]) {
  toDeleteKeys.value = keys;
  showDeleteDialog.value = true;
}

async function confirmDelete(key: TTorrentFavoriteKey) {
  await sendMessage("deleteTorrentFavorites", [key]);
  favorites.value = favorites.value.filter((x) => x.key !== key);
}

function afterDelete() {
  selectedKeys.value = selectedKeys.value.filter((key) => favorites.value.some((x) => x.key === key));
  runtimeStore.showSnakebar(t("MyCollection.deleteSuccess"), { color: "success" });
}

async function clearAll() {
  if (!(await confirmModal(t("MyCollection.clearConfirm")))) {
    return;
  }

  try {
    await sendMessage(
      "deleteTorrentFavorites",
      favorites.value.map((x) => x.key),
    );
    favorites.value = [];
    selectedKeys.value = [];
    runtimeStore.showSnakebar(t("MyCollection.deleteSuccess"), { color: "success" });
  } catch {
    // 删除失败时以存储为准重新加载，避免界面显示「已清空」而实际仍在
    await loadFavorites();
  }
}
</script>

<template>
  <a-alert :message="t('MyCollection.alert')" show-icon style="margin-bottom: 12px" type="info" />

  <a-card>
    <a-typography-text strong>
      <a-flex class="page-toolbar" align="center" :gap="8">
        <NavButton
          :disabled="selectedFavorites.length === 0"
          color="error"
          :icon="DeleteOutlined"
          :text="t('common.remove')"
          @click="tryToDelete(selectedFavorites.map((x) => x.key))"
        />
        <NavButton
          :disabled="favorites.length === 0"
          color="error"
          :icon="ClearOutlined"
          :text="t('MyCollection.clearAll')"
          @click="clearAll"
        />

        <a-divider type="vertical" />

        <!-- 集中下载收藏的种子（例如等到站免时批量推送到下载器）；星标可批量为选中的收藏改分类/备注 -->
        <ActionTd :torrent-items="selectedFavorites" :show-keep-upload-btn="false" @favorite-saved="loadFavorites" />

        <div style="flex: 1 1 auto"></div>

        <a-select
          v-model:value="favCategoryFilter"
          :options="favCategoryFilterOptions"
          :placeholder="t('MyCollection.filterAll')"
          allow-clear
          class="my-collection__category-filter"
          max-tag-count="responsive"
          mode="multiple"
        >
          <template #suffixIcon><FolderOutlined /></template>
          <!-- 下拉项右侧显示该分类的收藏数量 -->
          <template #option="{ label, count }">
            <a-flex justify="space-between" :gap="8">
              <span>{{ label }}</span>
              <a-typography-text type="secondary">{{ count }}</a-typography-text>
            </a-flex>
          </template>
        </a-select>

        <a-input v-model:value="tableWaitFilter" allow-clear :placeholder="t('MyCollection.filterLabel')" />
      </a-flex>
    </a-typography-text>

    <a-table
      :columns="columns"
      :data-source="filteredFavorites"
      :loading="loading"
      :pagination="tablePagination"
      :row-key="'key'"
      :row-selection="{
        selectedRowKeys: selectedKeys,
        onChange: onSelectionChange,
        // 筛选改变 dataSource 时保留已选收藏（真正参与批量操作的是 selectedFavorites = 选中 ∩ 可见）
        preserveSelectedRowKeys: true,
      }"
      :scroll="{ x: 'max-content' }"
      class="table-stripe table-header-no-wrap"
      @change="onTableChange"
    >
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'site'">
          <div class="my-collection__site">
            <SiteFavicon :site-id="record.site" :size="18" />
            <SiteName class="ptd-cell-ellipsis" style="max-width: 6rem; font-size: 12px" :site-id="record.site" />
          </div>
        </template>

        <template v-else-if="column.key === 'title'">
          <TorrentTitleTd :item="record" max-width="30vw" />
          <!-- 备注：与正文同号展示，否则太不显眼 -->
          <div
            v-if="record.comment"
            class="ptd-cell-ellipsis"
            style="max-width: 30vw; color: var(--ptd-text-secondary)"
            :title="record.comment"
          >
            <CommentOutlined style="margin-right: 4px" />{{ record.comment }}
          </div>
        </template>

        <template v-else-if="column.key === 'favCategories'">
          <template v-if="(record.favCategories ?? []).length > 0">
            <a-tag
              v-for="category in record.favCategories"
              :key="category"
              class="my-collection__category-tag"
              color="gold"
              @click="favCategoryFilter = [category]"
            >
              {{ category }}
            </a-tag>
          </template>
          <span v-else style="color: var(--ptd-text-tertiary)">{{ t("MyCollection.table.unclassified") }}</span>
        </template>

        <template v-else-if="column.key === 'size'">
          <span style="white-space: nowrap">{{ formatSize(record.size ?? 0) }}</span>
        </template>

        <template v-else-if="column.key === 'time'">
          <span class="ptd-date-time">{{ record.time ? formatDateTimeForTable(record.time) : "-" }}</span>
        </template>

        <template v-else-if="column.key === 'createdAt'">
          <span class="ptd-date-time">{{ formatDateTimeForTable(record.createdAt) }}</span>
        </template>

        <template v-else-if="column.key === 'action'">
          <!-- 行内「操作」与「编辑收藏」是同一套动作：星标即编辑该收藏的分类与备注，删除与其同组以保证格式一致 -->
          <ActionTd
            :favorite-btn-title="t('MyCollection.table.action.edit')"
            :torrent-items="singleItemArray(record as ITorrentFavoriteItem)"
            compact
            :show-keep-upload-btn="false"
            @favorite-saved="loadFavorites"
          >
            <template #append>
              <a-button :title="t('common.remove')" danger size="small" @click="tryToDelete([record.key])"
                ><template #icon><DeleteOutlined /></template
              ></a-button>
            </template>
          </ActionTd>
        </template>
      </template>

      <template #emptyText>
        <NoDataPlaceholder compact :description="t('MyCollection.emptyNotice')" />
      </template>
    </a-table>
  </a-card>

  <DeleteDialog
    v-model="showDeleteDialog"
    :confirm-delete="confirmDelete"
    :to-delete-ids="toDeleteKeys"
    @all-delete="afterDelete"
  />
</template>

<style scoped>
.my-collection__site {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
}

.my-collection__category-filter {
  flex: 0 1 240px;
  min-width: 160px;
}

.my-collection__category-tag {
  margin: 2px;
  cursor: pointer;
}
</style>
