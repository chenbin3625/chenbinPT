<script setup lang="ts">
import { ref, computed, h } from "vue";
import { useI18n } from "vue-i18n";
import { cloneDeep, omit } from "es-toolkit";
import { saveAs } from "file-saver";
import { nanoid } from "nanoid";
import { Input, Modal } from "ant-design-vue";
import {
  CopyOutlined,
  DeleteOutlined,
  EditOutlined,
  ExportOutlined,
  ImportOutlined,
  MinusOutlined,
  PlusOutlined,
  QuestionCircleOutlined,
  SearchOutlined,
  SyncOutlined,
} from "@ant-design/icons-vue";

import { useMetadataStore } from "@/options/stores/metadata.ts";
import { useConfigStore } from "@/options/stores/config.ts";
import { useRuntimeStore } from "@/options/stores/runtime.ts";
import { formatDate } from "@/options/utils.ts";
import { withEllipsisCell } from "@/options/views/Overview/utils/antdTable.ts";
import { useStoreHydrating } from "@/options/composables/useStoreHydrating.ts";
import type { ISearchSolutionMetadata, TSolutionKey } from "@/shared/types.ts";

import EditDialog from "./EditDialog.vue";
import SolutionLabel from "./SolutionLabel.vue";
import DeleteDialog from "@/options/components/DeleteDialog.vue";
import NavButton from "@/options/components/NavButton.vue";

const { t } = useI18n();
const configStore = useConfigStore();
const runtimeStore = useRuntimeStore();
const metadataStore = useMetadataStore();

// 搜索方案来自 metadata store，异步水合完成前不能把空列表当成「暂无数据」
const isStoreHydrating = useStoreHydrating(metadataStore);

const showEditDialog = ref(false);
const showDeleteDialog = ref(false);
const solutionId = ref<TSolutionKey>("");

const tableSelected = ref<TSolutionKey[]>([]);
const tableFilter = ref("");

type SearchSolutionTableRow = ISearchSolutionMetadata & {
  isBuiltInDefault?: boolean;
};

function isBuiltInDefaultRow(record: SearchSolutionTableRow) {
  return record.isBuiltInDefault === true;
}

const columns = computed(() => {
  const multiple = configStore.enableTableMultiSort ? 4 : undefined;
  return [
    withEllipsisCell(
      {
        title: "№",
        dataIndex: "sort",
        key: "sort",
        align: "center" as const,
        width: 150,
        sorter: {
          compare: (a: SearchSolutionTableRow, b: SearchSolutionTableRow) => (a.sort ?? 0) - (b.sort ?? 0),
          multiple,
        },
      },
      "6rem",
    ),
    withEllipsisCell(
      {
        title: t("common.name"),
        dataIndex: "name",
        key: "name",
        width: 150,
        sorter: {
          compare: (a: SearchSolutionTableRow, b: SearchSolutionTableRow) =>
            String(a.name ?? "").localeCompare(String(b.name ?? "")),
          multiple,
        },
      },
      "14rem",
    ),
    { title: t("SetSearchSolution.solution"), key: "solution", width: 400 },
    {
      title: t("SetSearchSolution.table.enable"),
      dataIndex: "enabled",
      key: "enabled",
      align: "center" as const,
      width: 120,
      sorter: {
        compare: (a: SearchSolutionTableRow, b: SearchSolutionTableRow) => Number(a.enabled) - Number(b.enabled),
        multiple,
      },
    },
    {
      title: t("SetSearchSolution.table.default"),
      dataIndex: "isDefault",
      key: "isDefault",
      align: "center" as const,
      width: 120,
    },
    { title: t("common.action"), key: "action", width: 200 },
  ];
});

// 与迁移前的默认排序一致（启用优先、sort 降序），且不把用户的临时排序写回配置
const tableData = computed<SearchSolutionTableRow[]>(() =>
  [...metadataStore.getSearchSolutions]
    .filter((solution) => {
      if (!tableFilter.value) return true;
      return String(solution.name ?? "")
        .toLowerCase()
        .includes(tableFilter.value.toLowerCase());
    })
    .sort((a, b) => Number(b.enabled) - Number(a.enabled) || (b.sort ?? 0) - (a.sort ?? 0)),
);

const isAllSolutionDefault = computed(() => metadataStore.defaultSolutionId === "default");

const tableRows = computed<SearchSolutionTableRow[]>(() => [
  {
    id: "default",
    name: t("layout.header.searchPlan.all"),
    sort: 0,
    enabled: false,
    isDefault: isAllSolutionDefault.value,
    createdAt: 0,
    solutions: [],
    isBuiltInDefault: true,
  },
  ...tableData.value,
]);

const pagination = computed(() => {
  const pageSize = configStore.tableBehavior.SetSearchSolution.itemsPerPage;
  if (Number(pageSize) === -1) return false as const;
  return {
    pageSize: Number(pageSize) || 25,
    pageSizeOptions: ["5", "10", "25", "50", "100"],
    showSizeChanger: true,
    onChange: (_page: number, size: number) =>
      configStore.updateTableBehavior("SetSearchSolution", "itemsPerPage", size),
  };
});

function onSelectionChange(keys: (string | number)[]) {
  tableSelected.value = keys.map((key) => String(key));
}

const rowSelection = computed(() => ({
  selectedRowKeys: tableSelected.value,
  onChange: onSelectionChange,
  getCheckboxProps: (record: SearchSolutionTableRow) => ({
    disabled: isBuiltInDefaultRow(record),
  }),
}));

function addSearchSolution() {
  editSearchSolution("");
}

function editSearchSolution(toEditSolutionId: TSolutionKey) {
  solutionId.value = toEditSolutionId;
  showEditDialog.value = true;
}

type IExportedSearchSolution = Omit<ISearchSolutionMetadata, "id" | "enabled" | "createdAt" | "isDefault" | "sort">;

/** 判断一个值是否是「纯对象」（排除 null 与数组） */
function isPlainRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * V-18：校验导入的单条方案（导出格式）。
 *
 * 导入的文件可以被手工编辑或来自外部，而 `metadataStore.addSearchSolution` 会立即 `$save()`，
 * 形状错误的条目一旦被写入就只会表现为「空方案 / 搜索失败」，所以这里逐项校验并汇报。
 * 校验标准与 EditDialog 的表单一致（name 必填、至少一个站点）。
 *
 * @returns 错误原因，undefined 表示通过校验
 */
function validateImportedSolution(item: unknown): string | undefined {
  if (!isPlainRecord(item)) return "not an object";
  if (typeof item.name !== "string" || item.name.trim() === "") return "missing name";
  if (!Array.isArray(item.solutions) || item.solutions.length === 0) return "empty solutions";

  for (const [index, solutionItem] of item.solutions.entries()) {
    if (!isPlainRecord(solutionItem)) return `solutions[${index}] is not an object`;
    if (typeof solutionItem.siteId !== "string" || solutionItem.siteId === "") {
      return `solutions[${index}] missing siteId`;
    }
    if (!isPlainRecord(solutionItem.searchEntries)) return `solutions[${index}] missing searchEntries`;
    if (typeof solutionItem.selectedCategories !== "undefined" && !isPlainRecord(solutionItem.selectedCategories)) {
      return `solutions[${index}] invalid selectedCategories`;
    }
  }

  return undefined;
}

/** 提示里最多列出的失败条目数，避免超长 snackbar */
const IMPORT_FAILURE_REPORT_LIMIT = 3;

function handleImportFileText(text: string) {
  const parsed = JSON.parse(text) as unknown;
  if (!Array.isArray(parsed)) {
    runtimeStore.showSnakebar("Invalid search solution file: expected an array of solutions", { color: "error" });
    return;
  }

  let importedCount = 0;
  const failures: string[] = []; // 形状非法、被跳过的条目
  const missingSiteIds = new Set<string>(); // 引用了本机未添加站点的条目（仍会导入，但那些站点不会参与搜索）

  for (const item of parsed) {
    const itemName = isPlainRecord(item) && typeof item.name === "string" ? item.name : "(unnamed)";
    const invalidReason = validateImportedSolution(item);
    if (invalidReason) {
      failures.push(`${itemName}: ${invalidReason}`);
      continue;
    }

    const importSolution = item as ISearchSolutionMetadata;

    // 补全导出时移除的字段
    importSolution.id = nanoid();
    importSolution.enabled = false;
    importSolution.createdAt = +new Date();
    importSolution.isDefault = false;
    importSolution.sort = 1;

    for (const solutionItem of importSolution.solutions) {
      if (!metadataStore.sites[solutionItem.siteId]) missingSiteIds.add(solutionItem.siteId);
    }

    metadataStore.addSearchSolution(importSolution);
    importedCount++;
  }

  if (importedCount > 0) {
    runtimeStore.showSnakebar(`Imported ${importedCount} search solution(s)`, { color: "success" });
  }

  if (failures.length > 0) {
    const detail = failures.slice(0, IMPORT_FAILURE_REPORT_LIMIT).join("; ");
    const rest =
      failures.length > IMPORT_FAILURE_REPORT_LIMIT ? ` (+${failures.length - IMPORT_FAILURE_REPORT_LIMIT} more)` : "";
    runtimeStore.showSnakebar(`Skipped ${failures.length} invalid search solution(s): ${detail}${rest}`, {
      color: importedCount > 0 ? "warning" : "error",
    });
  }

  if (missingSiteIds.size > 0) {
    runtimeStore.showSnakebar(
      `Imported solutions reference ${missingSiteIds.size} site(s) that are not added yet; add them before searching`,
      { color: "warning" },
    );
  }
}

/** 用 a-upload 的 before-upload 接管导入；返回 false 阻止 antd 真正发起上传 */
function beforeImportUpload(file: any) {
  const r = new FileReader();
  r.onload = (e: any) => {
    try {
      handleImportFileText(e.target.result);
    } catch (error) {
      runtimeStore.showSnakebar("Invalid JSON format when import search solution", { color: "error" });
    }
  };
  r.onerror = () => {
    runtimeStore.showSnakebar("Invalid JSON format when load import file", { color: "error" });
  };
  r.readAsText(file as Blob);

  return false;
}

function exportSearchSolutions(solutionIds: TSolutionKey[]) {
  const exportedSolutions: IExportedSearchSolution[] = [];
  for (const solutionId of solutionIds) {
    exportedSolutions.push(
      omit(metadataStore.solutions[solutionId], ["id", "enabled", "createdAt", "isDefault", "sort"]),
    );
  }

  if (exportedSolutions.length > 0) {
    const exportedSolutionBlob = new Blob([JSON.stringify(exportedSolutions)], { type: "application/json" });
    saveAs(exportedSolutionBlob, `search-solutions-export-${formatDate(new Date(), "yyyyMMdd'T'HHmm")}.json`); // FIXME filename
  } else {
    runtimeStore.showSnakebar("No solutions to export", { color: "error" });
  }
}

const toDeleteIds = ref<TSolutionKey[]>([]);
function deleteSearchSolutions(solutionIds: TSolutionKey[]) {
  toDeleteIds.value = solutionIds;
  showDeleteDialog.value = true;
}

async function confirmDeleteSearchSolution(solutionId: TSolutionKey) {
  return await metadataStore.removeSearchSolution(solutionId);
}

function simplePatchSearchSolution(solutionId: TSolutionKey, value: boolean) {
  metadataStore.solutions[solutionId].enabled = value;
  metadataStore.$save();
}

function setDefaultSearchSolution(toDefault: boolean, solutionId: TSolutionKey) {
  console.log(toDefault, solutionId);
  if (toDefault) {
    metadataStore.defaultSolutionId = solutionId;
    for (const solutionKey of Object.keys(metadataStore.solutions)) {
      metadataStore.solutions[solutionKey].isDefault = solutionKey === solutionId;
    }
  } else {
    metadataStore.defaultSolutionId = "default";
    metadataStore.solutions[solutionId].isDefault = false;
  }

  metadataStore.$save();
}

/** 用 antd 的 Modal + a-input 替代原生浏览器输入框；返回 null 表示用户取消 */
function promptSolutionName(defaultName: string): Promise<string | null> {
  return new Promise((resolve) => {
    const value = ref(defaultName);
    Modal.confirm({
      title: t("SetSearchSolution.newSolutionNamePrompt"),
      content: () =>
        h(Input, {
          value: value.value,
          "onUpdate:value": (v: string) => {
            value.value = v;
          },
        }),
      onOk: () => resolve(value.value),
      onCancel: () => resolve(null),
    });
  });
}

async function copySearchSolution(solutionId: TSolutionKey) {
  const toCopy = await metadataStore.getSearchSolution(solutionId);
  if (!toCopy) return;

  const copied = cloneDeep(toCopy);
  // 重置部分字段
  copied.id = nanoid();
  copied.createdAt = Date.now();
  copied.isDefault = false;
  for (const solution1 of copied.solutions) {
    const oldId = solution1.id;
    if (oldId !== "default") {
      const newId = nanoid();
      solution1.id = newId;
      solution1.searchEntries[newId] = solution1.searchEntries[oldId];
      delete solution1.searchEntries[oldId];
    }
  }

  const newSearchSolutionName = await promptSolutionName(`Copy of ${copied.name ?? copied.id}`);
  if (newSearchSolutionName) {
    copied.name = newSearchSolutionName;
    await metadataStore.addSearchSolution(copied);
  }
}
</script>

<template>
  <a-card class="ptd-settings-card">
    <template #title>
      <a-flex class="page-toolbar" align="center" :gap="8">
        <NavButton :icon="PlusOutlined" :text="t('common.btn.add')" color="success" @click="addSearchSolution" />

        <NavButton
          :disabled="tableSelected.length === 0"
          :icon="MinusOutlined"
          :text="t('common.remove')"
          color="error"
          @click="deleteSearchSolutions(tableSelected)"
        />

        <a-divider style="margin: 0 8px" type="vertical" />

        <a-upload
          accept="application/json"
          :before-upload="beforeImportUpload"
          :file-list="[]"
          :multiple="true"
          :show-upload-list="false"
        >
          <NavButton color="info" :icon="ImportOutlined" :text="t('common.import')" />
        </a-upload>

        <NavButton
          :disabled="tableSelected.length === 0"
          color="info"
          :icon="ExportOutlined"
          :text="t('common.export')"
          @click="exportSearchSolutions(tableSelected)"
        />

        <a-divider style="margin: 0 8px" type="vertical" />

        <NavButton :icon="QuestionCircleOutlined" :text="t('common.howToUse')" color="light-blue" disabled />

        <span style="flex: 1 1 auto" />

        <a-input v-model:value="tableFilter" allow-clear :placeholder="t('common.search')" style="max-width: 500px">
          <template #suffix><SearchOutlined /></template>
        </a-input>
      </a-flex>
    </template>

    <a-table
      :columns="columns"
      :data-source="tableRows"
      :loading="isStoreHydrating"
      :pagination="pagination"
      :row-key="'id'"
      :row-selection="rowSelection"
      class="table-stripe table-header-no-wrap"
      size="small"
    >
      <template #bodyCell="{ column, record }">
        <template v-if="record.isBuiltInDefault && column.key === 'sort'">
          <span aria-hidden="true" />
        </template>

        <template v-else-if="record.isBuiltInDefault && column.key === 'solution'">
          <a-tag color="blue">
            <template #icon><SyncOutlined /></template>
            {{ t("SetSearchSolution.table.autoGenerate") }}
          </a-tag>
        </template>

        <template v-else-if="record.isBuiltInDefault && column.key === 'enabled'">
          <a-switch class="table-switch-btn" disabled />
        </template>

        <template v-else-if="record.isBuiltInDefault && column.key === 'isDefault'">
          <a-switch :checked="isAllSolutionDefault" class="table-switch-btn" disabled />
        </template>

        <template v-else-if="record.isBuiltInDefault && column.key === 'action'">
          <a-button-group class="table-action">
            <a-button
              :title="t('SetSearchSolution.copy')"
              size="small"
              type="primary"
              @click="copySearchSolution('default')"
            >
              <template #icon><CopyOutlined /></template>
            </a-button>
          </a-button-group>
        </template>

        <template v-else-if="column.key === 'solution'">
          <SolutionLabel :closable="false" :solutions="record.solutions" column />
        </template>

        <template v-else-if="column.key === 'enabled'">
          <a-switch
            v-model:checked="record.enabled"
            class="table-switch-btn"
            @change="(v: any) => simplePatchSearchSolution(record.id, v as boolean)"
          />
        </template>

        <template v-else-if="column.key === 'isDefault'">
          <a-switch
            v-model:checked="record.isDefault"
            class="table-switch-btn"
            @change="(v: any) => setDefaultSearchSolution(v as boolean, record.id)"
          />
        </template>

        <template v-else-if="column.key === 'action'">
          <a-button-group class="table-action">
            <a-button
              :title="t('SetSearchSolution.copy')"
              size="small"
              type="primary"
              @click="copySearchSolution(record.id)"
            >
              <template #icon><CopyOutlined /></template>
            </a-button>
            <a-button :title="t('common.edit')" size="small" @click="() => editSearchSolution(record.id)">
              <template #icon><EditOutlined /></template>
            </a-button>
            <a-button :title="t('common.export')" size="small" @click="exportSearchSolutions([record.id])">
              <template #icon><ExportOutlined /></template>
            </a-button>
            <a-button danger :title="t('common.remove')" size="small" @click="() => deleteSearchSolutions([record.id])">
              <template #icon><DeleteOutlined /></template>
            </a-button>
          </a-button-group>
        </template>
      </template>
    </a-table>
  </a-card>

  <EditDialog v-model="showEditDialog" :solution-id="solutionId" />
  <DeleteDialog v-model="showDeleteDialog" :to-delete-ids="toDeleteIds" :confirm-delete="confirmDeleteSearchSolution" />
</template>
