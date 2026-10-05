<script setup lang="ts">
import { computed, ref } from "vue";
import { computedAsync } from "@vueuse/core";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import { countBy } from "es-toolkit";
import {
  CloudDownloadOutlined,
  DeleteOutlined,
  EditOutlined,
  ExportOutlined,
  FilterOutlined,
  FolderOutlined,
  InfoCircleOutlined,
  MinusOutlined,
  PlusOutlined,
  PushpinOutlined,
} from "@ant-design/icons-vue";

import { useMetadataStore } from "@/options/stores/metadata.ts";
import { useConfigStore } from "@/options/stores/config.ts";
import { useRuntimeStore } from "@/options/stores/runtime.ts";

import type { TDownloaderKey } from "@/shared/types.ts";
import { getDownloaderIcon, getDownloaderMetaData, type TorrentClientMetaData } from "@ptd/downloader";
import { useTableCustomFilter } from "@/options/directives/useAdvanceFilter.ts";
import { withEllipsisCell } from "@/options/views/Overview/utils/antdTable.ts";
import { useStoreHydrating } from "@/options/composables/useStoreHydrating.ts";

import AddDialog from "./AddDialog.vue";
import EditDialog from "./EditDialog.vue";
import PathAndTagSuggestDialog from "./PathAndTagSuggestDialog.vue";
import SiteFilterDialog from "./SiteFilterDialog.vue";
import DefaultDownloaderEditDialog from "./DefaultDownloaderEditDialog.vue";

import DeleteDialog from "@/options/components/DeleteDialog.vue";
import NavButton from "@/options/components/NavButton.vue";
import NoDataPlaceholder from "@/options/components/NoDataPlaceholder.vue";

const { t } = useI18n();
const router = useRouter();
const metadataStore = useMetadataStore();
const configStore = useConfigStore();
const runtimeStore = useRuntimeStore();

// 下载器列表来自 metadata store，异步水合完成前不能把空列表当成「暂无数据」
const isStoreHydrating = useStoreHydrating(metadataStore);

const showAddDialog = ref<boolean>(false);
const showEditDialog = ref<boolean>(false);
const showDefaultDownloaderEditDialog = ref<boolean>(false);
const showSiteFilterDialog = ref<boolean>(false);
const showPathAndTagSuggestDialog = ref<boolean>(false);
const showDeleteDialog = ref<boolean>(false);

const downloaderTypeCount = computed(() => countBy(metadataStore.getDownloaders, (x) => x.type));

const downloaderMetadata = computedAsync(async () => {
  const downloaderMetaData: Record<string, TorrentClientMetaData> = {};
  for (const type of new Set(metadataStore.getDownloaders.map((x) => x.type))) {
    downloaderMetaData[type] = await getDownloaderMetaData(type);
  }
  return downloaderMetaData;
}, {});

const tableSelected = ref<TDownloaderKey[]>([]);

const booleanField = {
  "feature.DefaultAutoStart": "SetDownloader.index.table.autodl",
  enabled: "SetDownloader.index.table.enabled",
} as const;

const {
  tableWaitFilterRef,
  tableFilterRef,
  tableFilterFn,
  advanceFilterDictRef,
  updateTableFilterValueFn,
  buildFilterDictFn,
  toggleKeywordStateFn,
} = useTableCustomFilter({
  parseOptions: {
    keywords: ["type", ...Object.keys(booleanField)],
  },
  titleFields: ["name", "address"],
  format: {
    enabled: "boolean",
    "feature.DefaultAutoStart": "boolean",
  },
  initialItems: metadataStore.getDownloaders,
  watchItems: true,
});

const tableData = computed(() =>
  metadataStore.getDownloaders.filter((item) => tableFilterFn(undefined, tableFilterRef.value, { raw: item })),
);

function sortOrderOf(key: string): "ascend" | "descend" | undefined {
  const item = (configStore.tableBehavior.SetDownloader.sortBy ?? []).find((s: any) => s.key === key);
  return item?.order === "asc" ? "ascend" : item?.order === "desc" ? "descend" : undefined;
}

const columns = computed(() => {
  const multiple = configStore.enableTableMultiSort ? 4 : undefined;
  return [
    {
      title: "№",
      dataIndex: "sortIndex",
      key: "sortIndex",
      align: "right" as const,
      width: 100,
      sorter: {
        compare: (a: any, b: any) => Number(a.sortIndex ?? 0) - Number(b.sortIndex ?? 0),
        multiple,
      },
      sortOrder: sortOrderOf("sortIndex"),
    },
    { title: t("common.type"), dataIndex: "type", key: "type", align: "center" as const },
    withEllipsisCell(
      {
        title: t("SetDownloader.common.name"),
        dataIndex: "name",
        key: "name",
        sorter: {
          compare: (a: any, b: any) => String(a.name ?? "").localeCompare(String(b.name ?? "")),
          multiple,
        },
        sortOrder: sortOrderOf("name"),
      },
      "14rem",
    ),
    withEllipsisCell(
      {
        title: t("SetDownloader.common.address"),
        dataIndex: "address",
        key: "address",
        sorter: {
          compare: (a: any, b: any) => String(a.address ?? "").localeCompare(String(b.address ?? "")),
          multiple,
        },
        sortOrder: sortOrderOf("address"),
      },
      "16rem",
    ),
    withEllipsisCell({ title: t("common.username"), dataIndex: "username", key: "username" }, "10rem"),
    { title: t("SetDownloader.index.table.enabled"), dataIndex: "enabled", key: "enabled", align: "center" as const },
    { title: t("SetDownloader.index.table.autodl"), key: "feature.DefaultAutoStart", align: "center" as const },
    { title: t("common.action"), key: "action" },
  ];
});

const pagination = computed(() => {
  const pageSize = configStore.tableBehavior.SetDownloader.itemsPerPage;
  if (Number(pageSize) === -1) return false as const;
  return {
    pageSize: Number(pageSize) || 25,
    pageSizeOptions: ["5", "10", "25", "50", "100"],
    showSizeChanger: true,
    onChange: (_page: number, size: number) => configStore.updateTableBehavior("SetDownloader", "itemsPerPage", size),
  };
});

function onSelectionChange(keys: (string | number)[]) {
  tableSelected.value = keys.map((key) => String(key));
}

function onTableChange(_pagination: unknown, _filters: unknown, sorter: unknown) {
  const list = Array.isArray(sorter) ? sorter : [sorter];
  configStore.updateTableBehavior(
    "SetDownloader",
    "sortBy",
    list
      .filter((s: any) => s?.order)
      .map((s: any) => ({ key: String(s.columnKey ?? s.field), order: s.order === "ascend" ? "asc" : "desc" })),
  );
}

function isKeywordRequired(field: string, value: string): boolean {
  return (advanceFilterDictRef.value[field]?.required ?? []).includes(value);
}

/** V-21：该关键字当前是否以「排除」形式参与筛选（勾选之外还需要展示的第三种状态） */
function isKeywordExcluded(field: string, value: string): boolean {
  return (advanceFilterDictRef.value[field]?.exclude ?? []).includes(value);
}

function setKeywordRequired(field: string, value: string, checked: boolean) {
  const current = (advanceFilterDictRef.value[field]?.required ?? []) as unknown[];
  advanceFilterDictRef.value[field].required = checked
    ? Array.from(new Set([...current, value]))
    : current.filter((x: any) => x !== value);
  updateTableFilterValueFn();
}

const toEditDownloaderId = ref<TDownloaderKey | null>(null);
function editDownloader(downloaderId: TDownloaderKey) {
  toEditDownloaderId.value = downloaderId;
  showEditDialog.value = true;
}

function manageDownloader(downloaderId: TDownloaderKey) {
  // 跳转到 MyClient 页面并预选该下载服务器，进行种子管理
  void router.push({ path: "/my-client", query: { downloader: downloaderId } });
}

function editDownloaderPathAndTag(downloaderId: TDownloaderKey) {
  toEditDownloaderId.value = downloaderId;
  showPathAndTagSuggestDialog.value = true;
}

function editDownloaderSiteFilter(downloaderId: TDownloaderKey) {
  toEditDownloaderId.value = downloaderId;
  showSiteFilterDialog.value = true;
}

const toDeleteIds = ref<TDownloaderKey[]>([]);
function deleteDownloader(downloaderId: TDownloaderKey[]) {
  const defaultDownloaderId = metadataStore.defaultDownloader?.id;
  toDeleteIds.value = downloaderId.filter((i) => i !== defaultDownloaderId); // 默认下载器不允许删除（防止多选时选中）

  // 多选删除时若有默认下载器被跳过，需要明确告知用户，否则会出现「选了 N 个只删掉 N-1 个」的静默行为
  if (toDeleteIds.value.length !== downloaderId.length) {
    const skippedName = metadataStore.downloaders?.[defaultDownloaderId!]?.name ?? defaultDownloaderId!;
    runtimeStore.showSnakebar(t("SetDownloader.index.remove.defaultNotDeleted", [skippedName]), { color: "warning" });
  }

  showDeleteDialog.value = true;
}

async function confirmDeleteDownloader(downloaderId: TDownloaderKey) {
  return await metadataStore.removeDownloader(downloaderId);
}
</script>

<template>
  <a-card class="ptd-settings-card">
    <template #title>
      <a-flex class="page-toolbar" align="center" :gap="8">
        <NavButton :icon="PlusOutlined" :text="t('common.btn.add')" color="success" @click="showAddDialog = true" />

        <NavButton
          :disabled="tableSelected.length === 0"
          :icon="MinusOutlined"
          :text="t('common.remove')"
          color="error"
          @click="deleteDownloader(tableSelected)"
        />

        <a-divider style="margin: 0 8px" type="vertical" />

        <NavButton
          :disabled="metadataStore.getDownloaders.length == 0"
          :icon="CloudDownloadOutlined"
          :text="t('SetDownloader.index.editDefaultDownloaderBtn')"
          color="indigo"
          @click="showDefaultDownloaderEditDialog = true"
        />

        <span style="flex: 1 1 auto" />

        <a-input
          v-model:value="tableWaitFilterRef"
          allow-clear
          :placeholder="t('common.search')"
          style="max-width: 500px"
          @change="(e: any) => !e.target.value && buildFilterDictFn('')"
        >
          <template #prefix>
            <a-popover placement="bottom" trigger="click">
              <FilterOutlined style="cursor: pointer" />
              <template #content>
                <a-list size="small" style="padding: 0">
                  <a-list-item v-for="(transKey, filterKey) in booleanField" :key="filterKey">
                    <a-checkbox
                      :checked="isKeywordRequired(filterKey, '1')"
                      :indeterminate="isKeywordExcluded(filterKey, '1')"
                      @click.stop="toggleKeywordStateFn(filterKey, '1')"
                      @update:checked="(checked: boolean) => setKeywordRequired(filterKey, '1', checked)"
                    >
                      {{ t(transKey) }}
                    </a-checkbox>
                  </a-list-item>

                  <a-divider style="margin: 4px 0" />

                  <a-list-item>
                    <a-typography-text strong style="margin: 8px">
                      {{ t("SetDownloader.index.table.downloaderCategory") }}
                    </a-typography-text>
                  </a-list-item>
                  <a-list-item v-for="(count, type) in downloaderTypeCount" :key="type">
                    <a-checkbox
                      :checked="isKeywordRequired('type', type)"
                      :indeterminate="isKeywordExcluded('type', type)"
                      @click.stop="toggleKeywordStateFn('type', type)"
                      @update:checked="(checked: boolean) => setKeywordRequired('type', type, checked)"
                    >
                      {{ `${type} (${count})` }}
                    </a-checkbox>
                  </a-list-item>
                </a-list>
              </template>
            </a-popover>
          </template>
        </a-input>
      </a-flex>
    </template>

    <a-table
      :columns="columns"
      :data-source="tableData"
      :loading="isStoreHydrating"
      :pagination="pagination"
      :row-key="'id'"
      :row-selection="{ selectedRowKeys: tableSelected, onChange: onSelectionChange }"
      class="table-stripe table-header-no-wrap"
      size="small"
      @change="onTableChange"
    >
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'type'">
          <a-avatar :alt="record.type" :src="getDownloaderIcon(record.type)" :title="record.type" />
        </template>

        <template v-else-if="column.key === 'name'">
          <span style="display: inline-flex; align-items: center; min-width: 0; max-width: 14rem">
            <PushpinOutlined
              v-if="record.id == metadataStore.defaultDownloader?.id"
              :style="{ color: 'var(--ptd-primary)', marginRight: '4px', flex: '0 0 auto' }"
            />
            <strong
              class="ptd-cell-ellipsis"
              :style="{
                color: record.id == metadataStore.defaultDownloader?.id ? 'var(--ptd-primary)' : undefined,
                maxWidth: '14rem',
              }"
              :title="String(record.name ?? '')"
            >
              {{ record.name }}
            </strong>
          </span>
        </template>

        <template v-else-if="column.key === 'address'">
          <span class="ptd-cell-ellipsis" style="max-width: 24rem" :title="String(record.address ?? '')">
            <a-typography-link :href="record.address" rel="noopener noreferrer nofollow" target="_blank">
              {{ record.address }}
              <ExportOutlined class="ptd-icon-sm" />
            </a-typography-link>
          </span>
        </template>

        <template v-else-if="column.key === 'enabled'">
          <a-switch
            v-model:checked="record.enabled"
            class="table-switch-btn"
            :disabled="record.id == metadataStore.defaultDownloader?.id /* 默认下载器不允许禁用 */"
            @change="(v: any) => metadataStore.simplePatch('downloaders', record.id, 'enabled', v as boolean)"
          />
        </template>

        <template v-else-if="column.key === 'feature.DefaultAutoStart'">
          <a-switch
            :checked="record.feature?.DefaultAutoStart"
            class="table-switch-btn"
            :disabled="
              !record.enabled || downloaderMetadata?.[record.type]?.feature?.DefaultAutoStart?.allowed === false
            "
            @change="
              (v: any) => metadataStore.simplePatch('downloaders', record.id, 'feature.DefaultAutoStart', v as boolean)
            "
          />
        </template>

        <template v-else-if="column.key === 'action'">
          <a-button-group class="table-action">
            <a-button
              :disabled="!record.enabled /* 未启用的下载服务器无法获取状态 */"
              :title="t('SetDownloader.index.table.action.status')"
              size="small"
              type="primary"
              @click="manageDownloader(record.id)"
            >
              <template #icon><InfoCircleOutlined /></template>
            </a-button>

            <a-button :title="t('common.edit')" size="small" @click="editDownloader(record.id)">
              <template #icon><EditOutlined /></template>
            </a-button>

            <!-- 该下载服务器下载路径和标签选择 -->
            <a-button
              :title="t('SetDownloader.index.table.action.setPathAndTag')"
              size="small"
              @click="editDownloaderPathAndTag(record.id)"
            >
              <template #icon><FolderOutlined /></template>
            </a-button>

            <!-- 该下载服务器站点过滤设置 -->
            <a-button
              v-if="configStore.download.allowDownloaderFilterForSite"
              :disabled="!record.enabled"
              :title="t('SetDownloader.index.table.action.setSiteFilter')"
              size="small"
              @click="editDownloaderSiteFilter(record.id)"
            >
              <template #icon><FilterOutlined /></template>
            </a-button>

            <!-- 默认下载服务器不允许删除；禁用按钮不触发鼠标事件，故用外层提示组件承载说明 -->
            <a-tooltip
              v-if="record.id == metadataStore.defaultDownloader?.id"
              :title="t('SetDownloader.index.table.action.deleteDefaultDownloader')"
            >
              <a-button
                danger
                disabled
                :title="t('SetDownloader.index.table.action.deleteDefaultDownloader')"
                size="small"
              >
                <template #icon><DeleteOutlined /></template>
              </a-button>
            </a-tooltip>
            <a-button v-else danger :title="t('common.remove')" size="small" @click="deleteDownloader([record.id])">
              <template #icon><DeleteOutlined /></template>
            </a-button>
          </a-button-group>
        </template>
      </template>

      <!-- 无任何下载服务器时的空状态占位（复用已有的引导文案） -->
      <template #emptyText>
        <NoDataPlaceholder compact :description="t('SetDownloader.index.emptyNotice')" />
      </template>
    </a-table>
  </a-card>

  <AddDialog v-model="showAddDialog" />
  <EditDialog v-model="showEditDialog" :client-id="toEditDownloaderId!" />
  <DefaultDownloaderEditDialog v-model="showDefaultDownloaderEditDialog" />
  <SiteFilterDialog v-model="showSiteFilterDialog" :client-id="toEditDownloaderId!" />
  <PathAndTagSuggestDialog v-model="showPathAndTagSuggestDialog" :client-id="toEditDownloaderId!" />
  <DeleteDialog v-model="showDeleteDialog" :to-delete-ids="toDeleteIds" :confirm-delete="confirmDeleteDownloader" />
</template>
