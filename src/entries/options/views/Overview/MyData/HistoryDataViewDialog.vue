<script setup lang="ts">
import { DeleteOutlined, DownOutlined, ExportOutlined, EyeOutlined, UpOutlined } from "@ant-design/icons-vue";
import {
  applyTableActionColumn,
  toAntdColumns,
  toPagination,
  toSortBy,
  useTableActionColumnLayout,
} from "../utils/antdTable.ts";
import { computed, nextTick, ref, shallowRef, watch } from "vue";
import { useI18n } from "vue-i18n";
import { saveAs } from "@/options/utils/saveAs.ts";
import { type IUserInfo, type TSiteID } from "@ptd/site";
import type { DataTableHeader, DataTableSortItem } from "@/options/types/dataTable.ts";

import { sendMessage } from "@/messages.ts";
import { formatSize, formatDate } from "@/options/utils.ts";
import { useRuntimeStore } from "@/options/stores/runtime.ts";
import { formatRatio } from "./utils/format.ts";
import BonusFormatSpan from "./BonusFormatSpan.vue";
import { loadSiteHistoryData } from "./utils/lastUserData.ts";

import SiteName from "@/options/components/SiteName.vue";
import { confirmModal } from "../utils/antdConfirm.ts";
import NavButton from "@/options/components/NavButton.vue";
import NoDataPlaceholder from "@/options/components/NoDataPlaceholder.vue";

const showDialog = defineModel<boolean>();
const { siteId } = defineProps<{
  siteId: TSiteID | null;
}>();
const { t } = useI18n();
const runtimeStore = useRuntimeStore();

/**
 * A-25：不能在 setup 时取一次「今天」——选项页长时间打开会跨天，那样既会继续保护昨天，
 * 又会允许用户删掉今天的数据。这里改为每次调用时取当前日期（与存储 key 的格式一致，
 * 见 offscreen/utils/userInfo.ts）。
 */
function currentDate() {
  return formatDate(+new Date(), "yyyy-MM-dd");
}

const jsonData = ref<any>({});

interface IShowUserInfo extends IUserInfo {
  date: string;
}

const siteHistoryData = shallowRef<IShowUserInfo[]>([]);
// 历史数据由 loadSiteHistoryData 异步读取；打开对话框时先绑定 loading，
// 避免在数据返回前闪现「暂无数据」
const isLoading = ref<boolean>(false);
// F11：表头是 `t()` 求值的，若写成 setup 期常量，切语言后不会重新求值（列头停在旧语言）
const tableHeader = computed<DataTableHeader[]>(() => [
  { title: t("common.date"), key: "date", align: "center" },
  { title: t("common.username"), key: "name", align: "center", sortable: false },
  { title: t("MyData.table.levelName"), key: "levelName", align: "start", sortable: false },
  { title: t("MyData.table.userData"), key: "uploaded", align: "end", sortable: false },
  { title: t("levelRequirement.ratio"), key: "ratio", align: "end", sortable: false },
  { title: t("levelRequirement.seeding"), key: "seeding", align: "end", sortable: false },
  { title: t("levelRequirement.seedingSize"), key: "seedingSize", align: "end", sortable: false },
  { title: t("levelRequirement.bonus"), key: "bonus", align: "end", sortable: false },
  { title: t("common.action"), key: "action", align: "center", width: 90, sortable: false },
]);
// 排序与每页条数都需要本地状态：antd 的 sortOrder / pagination 受控后，
// 固定值会让表头点击和「每页条数」选择器看起来可点、实际不生效。
const sortBy = ref<DataTableSortItem[]>([{ key: "date", order: "desc" }]);
const pageSize = ref(10);

const tableColumns = computed(() =>
  // 操作列位置 / 固定（#1598）：历史数据弹窗与主表共用同一套全局配置
  applyTableActionColumn(toAntdColumns(tableHeader.value, { sortBy: sortBy.value })),
);
// 操作列固定在行首时，行首的选择列要一起固定
const { rowSelectionFixed } = useTableActionColumnLayout();
const tablePagination = computed(() => toPagination(pageSize.value, (size) => (pageSize.value = size)));

function onTableChange(_pagination: unknown, _filters: unknown, sorter: unknown) {
  sortBy.value = toSortBy(sorter as never);
}
function onSelectionChange(keys: (string | number)[]) {
  tableSelected.value = keys as string[];
}

const tableSelected = ref<string[]>([]);
let loadRequestToken = 0;

function resetDialogData() {
  loadRequestToken += 1;
  siteHistoryData.value = [];
  tableSelected.value = [];
  isLoading.value = false;
}

/** 读取当前站点的历史用户数据；删除记录后也复用同一条路径重新加载 */
async function loadHistoryData() {
  if (!siteId) return;

  // B-27 / F0147：弹窗实例是复用的（见 MyData/Index.vue 的 HistoryDataViewDialog），快速切换站点时
  // A 站的响应可能晚于 B 站的请求落地，加载失败时也可能残留旧站点的 tableSelected。
  // 这里同步清空选择集并捕获请求时的 siteId 与令牌，写入/报错前校验，避免跨站点误删。
  const requested = siteId;
  const requestToken = ++loadRequestToken;
  tableSelected.value = [];
  isLoading.value = true;
  try {
    const data = await loadSiteHistoryData(requested);
    if (requestToken !== loadRequestToken || requested !== siteId) return;

    siteHistoryData.value = data;
    tableSelected.value = [];
  } catch {
    if (requestToken !== loadRequestToken || requested !== siteId) return;

    siteHistoryData.value = [];
    tableSelected.value = [];
    runtimeStore.showSnackbar(t("MyClient.detail.operatorFailed"), { color: "error" });
  } finally {
    // 过期响应不能收起新请求的 loading
    if (requestToken === loadRequestToken) isLoading.value = false;
  }
}

async function deleteSiteUserInfo(date: string[]) {
  const targetSiteId = siteId;
  if (!targetSiteId) return;

  // OPTIONSOVERVIEW-4：当天数据不允许删除（与行内删除按钮、复选框的判据一致），
  // 原实现只是静默地把当天日期过滤掉：只勾选当天记录时会以空数组调用后台，
  // 界面既不提示也没有任何变化。这里显式中止并给出可见反馈。
  // 先过滤再二次确认：没有可删记录时不弹一个「确认删除 0 条」的空对话框。
  const removable = date.filter((d) => d != currentDate());
  if (removable.length === 0) {
    runtimeStore.showSnackbar(t("MyClient.detail.operatorFailed"), { color: "warning" });
    return;
  }

  if (!(await confirmModal(t("common.dialog.deleteText", [String(removable.length)])))) return;

  try {
    // OPTIONSOVERVIEW-4 / F0147：sendMessage 原先没有 catch/反馈，删除失败时列表不刷新、也没有任何提示；
    // 同时使用确认前捕获的 targetSiteId，避免确认期间站点切换后误删其他站点的数据。
    await sendMessage("removeSiteUserInfo", { siteId: targetSiteId, date: removable });
    if (siteId === targetSiteId) {
      await loadHistoryData();
    }
    runtimeStore.showSnackbar(t("KeepUploadTask.deleteSuccess"), { color: "success" });
  } catch {
    runtimeStore.showSnackbar(t("KeepUploadTask.deleteError"), { color: "error" });
  }
}

const showStoreDataDialog = ref<boolean>(false);
function viewStoreData(data: IShowUserInfo) {
  jsonData.value = data;
  showStoreDataDialog.value = true;
}

function exportSiteHistoryData() {
  let exportData = siteHistoryData.value;
  if (tableSelected.value.length > 0) {
    exportData = siteHistoryData.value.filter((item) => tableSelected.value.includes(item.date));
  }

  const exportedSolutionBlob = new Blob([JSON.stringify(exportData, null, 2)], { type: "application/json" });
  // 文件名带上站点与导出日期，避免多次导出后只能靠浏览器追加 (1)(2) 区分
  saveAs(exportedSolutionBlob, `site-history-data-${siteId}-${formatDate(+new Date(), "yyyy-MM-dd")}.json`);
}

function afterEnter() {
  if (!showDialog.value) return;
  void loadHistoryData();
}

// 原生 a-modal 没有 afterOpenChange（只有 afterClose），打开或切换站点时同步清空旧数据与选择集，
// 再在下一帧发起加载，避免在 :after-close 之前重新打开或切换站点时暴露旧站点数据与勾选状态。
watch([showDialog, () => siteId], ([open, currentSiteId], [wasOpen, prevSiteId]) => {
  if (open) {
    if (!wasOpen || currentSiteId !== prevSiteId) {
      resetDialogData();
      if (currentSiteId) {
        isLoading.value = true;
        nextTick(afterEnter);
      }
    }
  } else if (wasOpen) {
    tableSelected.value = [];
  }
});
</script>

<template>
  <a-modal v-model:open="showDialog" :footer="null" :width="1200" :after-close="resetDialogData">
    <template #title>
      {{ t("MyData.HistoryDataView.title") }} @ <SiteName :site-id="siteId!" class="" tag="span" />
    </template>

    <a-table
      :columns="tableColumns"
      :data-source="siteHistoryData"
      :loading="isLoading"
      :pagination="tablePagination"
      :row-key="'date'"
      :row-selection="{
        selectedRowKeys: tableSelected,
        onChange: onSelectionChange,
        // OPTIONSOVERVIEW-4：原先引用从不存在的 `_selectable` 字段 → 判据恒为 false，
        // 当天行照样可勾选；而 deleteSiteUserInfo 会把当天日期静默过滤掉，
        // 于是「勾选当天 → 删除」等于什么都没发生且无提示。当天数据本就不允许删除，
        // 这里按与行内删除按钮一致的判据禁用复选框。
        getCheckboxProps: (record: any) => ({ disabled: record.date == currentDate() }),
        // 操作列固定在行首时选择列也必须固定，保持固定列连续
        fixed: rowSelectionFixed,
      }"
      :scroll="{ x: 'max-content' }"
      class="table-stripe table-header-no-wrap"
      @change="onTableChange"
    >
      <!-- -->
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'date'">
          <span style="white-space: nowrap">{{ record.date }}</span>
        </template>

        <!-- 用户名，用户ID -->
        <template v-else-if="column.key === 'name'">
          <span
            class="ptd-cell-ellipsis"
            style="max-width: 10rem"
            :title="[record.name, record.id].filter(Boolean).join(' · ')"
            >{{ record.name ?? "-" }}</span
          >
        </template>

        <!-- 等级 -->
        <template v-else-if="column.key === 'levelName'">
          <span class="ptd-cell-ellipsis" style="max-width: 10rem" :title="String(record.levelName ?? '-')">{{
            record.levelName ?? "-"
          }}</span>
        </template>

        <!-- 上传、下载 -->
        <template v-else-if="column.key === 'uploaded'">
          <div>
            <a-row :gutter="8" style="justify-content: flex-end; flex-wrap: nowrap">
              <span style="white-space: nowrap">
                {{ typeof record.uploaded !== "undefined" ? formatSize(record.uploaded) : "-" }}
              </span>
              <UpOutlined style="color: var(--ptd-success)" />
            </a-row>
            <a-row :gutter="8" style="justify-content: flex-end; flex-wrap: nowrap">
              <span style="white-space: nowrap">
                {{ typeof record.downloaded !== "undefined" ? formatSize(record.downloaded) : "-" }}
              </span>
              <DownOutlined style="color: var(--ptd-danger)" />
            </a-row>
          </div>
        </template>

        <!-- 分享率 -->
        <template v-else-if="column.key === 'ratio'">
          <span style="white-space: nowrap">{{ formatRatio(record) }}</span>
        </template>

        <!-- 发布数 -->
        <template v-else-if="column.key === 'uploads'">
          <span style="white-space: nowrap">{{ record.uploads ?? "-" }}</span>
        </template>

        <!-- 做种数 -->
        <template v-else-if="column.key === 'seeding'">
          <span style="white-space: nowrap">{{ record.seeding ?? "-" }}</span>
        </template>

        <!-- 做种量 -->
        <template v-else-if="column.key === 'seedingSize'">
          <span style="white-space: nowrap">
            {{ typeof record.seedingSize !== "undefined" ? formatSize(record.seedingSize) : "-" }}
          </span>
        </template>

        <!-- 魔力/积分 -->
        <template v-else-if="column.key === 'bonus'">
          <div>
            <a-row :gutter="8" style="align-items: center; justify-content: flex-end">
              <BonusFormatSpan
                v-if="record.bonus !== undefined && record.bonus !== null && record.bonus !== ''"
                :num="record.bonus"
              />
              <span v-else style="white-space: nowrap">-</span>
            </a-row>
            <a-row :gutter="8" style="align-items: center; justify-content: flex-end">
              <BonusFormatSpan
                v-if="record.seedingBonus !== undefined && record.seedingBonus !== null && record.seedingBonus !== ''"
                :num="record.seedingBonus"
              />
              <span v-else style="white-space: nowrap">-</span>
            </a-row>
          </div>
        </template>

        <!-- 操作 -->
        <template v-else-if="column.key === 'action'">
          <a-button-group>
            <!-- 查看原始记录 -->
            <a-button
              :title="t('MyData.HistoryDataView.action.viewRaw')"
              @click="() => viewStoreData(record)"
              size="small"
              ><template #icon><EyeOutlined /></template
            ></a-button>

            <!-- 删除 -->
            <a-button
              :disabled="isLoading || record.date == currentDate()"
              :title="t('common.remove')"
              @click="() => deleteSiteUserInfo([record.date])"
              danger
              size="small"
              ><template #icon><DeleteOutlined /></template
            ></a-button>
          </a-button-group>
        </template>
      </template>

      <template #emptyText>
        <NoDataPlaceholder compact />
      </template>
      <!-- A-24：antd 的 vc-table 只消费 slots.footer，原先这里的 #footer.prepend（Vuetify v-data-table 的插槽名）
           永不渲染，其内容与下方 #footer 完全重复，故删除。 -->
      <template #footer>
        <a-flex align="center" :gap="8">
          <NavButton
            :disabled="isLoading || tableSelected.length <= 0"
            color="error"
            :icon="DeleteOutlined"
            :text="t('common.remove')"
            @click="deleteSiteUserInfo(tableSelected)"
          />
          <NavButton color="info" :icon="ExportOutlined" :text="t('common.export')" @click="exportSiteHistoryData" />
        </a-flex>
      </template>
    </a-table>

    <a-modal v-model:open="showStoreDataDialog" :footer="null" :width="800">
      <pre> {{ JSON.stringify(jsonData, null, 2) }}</pre>
    </a-modal>
  </a-modal>
</template>
