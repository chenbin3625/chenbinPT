<script setup lang="ts">
import { DeleteOutlined, DownOutlined, ExportOutlined, EyeOutlined, UpOutlined } from "@ant-design/icons-vue";
import { toAntdColumns, toPagination } from "../utils/antdTable.ts";
import { computed, nextTick, ref, shallowRef, watch } from "vue";
import { useI18n } from "vue-i18n";
import { saveAs } from "file-saver";
import { EResultParseStatus, type IUserInfo, type TSiteID } from "@ptd/site";
import type { DataTableHeader } from "@/options/types/dataTable.ts";

import { sendMessage } from "@/messages.ts";
import { formatNumber, formatSize, formatDate } from "@/options/utils.ts";
import { formatRatio } from "./utils/format.ts";
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
const tableHeader = [
  { title: t("common.date"), key: "date", align: "center" },
  { title: t("common.username"), key: "name", align: "center", sortable: false },
  { title: t("MyData.table.levelName"), key: "levelName", align: "start", sortable: false },
  { title: t("MyData.table.userData"), key: "uploaded", align: "end", sortable: false },
  { title: t("levelRequirement.ratio"), key: "ratio", align: "end", sortable: false },
  { title: t("levelRequirement.seeding"), key: "seeding", align: "end", sortable: false },
  { title: t("levelRequirement.seedingSize"), key: "seedingSize", align: "end", sortable: false },
  { title: t("levelRequirement.bonus"), key: "bonus", align: "end", sortable: false },
  { title: t("common.action"), key: "action", align: "center", width: 90, sortable: false },
] as DataTableHeader[];
const tableColumns = computed(() => toAntdColumns(tableHeader, { sortBy: [{ key: "date", order: "desc" }] }));
const tablePagination = computed(() =>
  toPagination(10, () => {
    /* 固定每页 10 条 */
  }),
);
function onSelectionChange(keys: (string | number)[]) {
  tableSelected.value = keys as string[];
}

const tableSelected = ref<string[]>([]);

/** 读取当前站点的历史用户数据；删除记录后也复用同一条路径重新加载 */
async function loadHistoryData() {
  if (!siteId) return;

  // B-27：弹窗实例是复用的（见 MyData/Index.vue 的 HistoryDataViewDialog），快速切换站点时
  // A 站的响应可能晚于 B 站的请求落地。这里捕获发起请求时的 siteId，写入前校验：
  // 否则表格里显示的是 A 站的数据、标题与 siteId 却已是 B，随后的删除会以「B 的 siteId + A 的日期」
  // 调用 removeSiteUserInfo，销毁 B 站这些日期的记录。
  const requested = siteId;
  isLoading.value = true;
  try {
    const data = await loadSiteHistoryData(requested);
    if (requested !== siteId) return;

    siteHistoryData.value = data;
    tableSelected.value = [];
  } finally {
    // 过期响应不能收起新请求的 loading
    if (requested === siteId) isLoading.value = false;
  }
}

async function deleteSiteUserInfo(date: string[]) {
  if (await confirmModal(t("MyData.HistoryDataView.deleteConfirm"))) {
    sendMessage("removeSiteUserInfo", {
      siteId: siteId!,
      date: date.filter((d) => d != currentDate()), // 不允许移除当天的数据
    }).then(() => loadHistoryData());
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
  saveAs(exportedSolutionBlob, `site-history-data-${siteId}.json`); // FIXME filename
}

function afterEnter() {
  void loadHistoryData();
}

// 原生 a-modal 没有 afterOpenChange（只有 afterClose），打开时的初始化自行监听 open。
watch(showDialog, (open) => {
  if (open) nextTick(afterEnter);
});
</script>

<template>
  <a-modal v-model:open="showDialog" :footer="null" :width="1200" :after-close="() => (siteHistoryData = [])">
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
        getCheckboxProps: (record: any) => ({ disabled: record._selectable === false }),
      }"
      :scroll="{ x: 'max-content' }"
      class="table-stripe"
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
              <span style="white-space: nowrap">{{ record.bonus ? formatNumber(record.bonus) : "-" }}</span>
            </a-row>
            <a-row :gutter="8" style="align-items: center; justify-content: flex-end">
              <span style="white-space: nowrap">{{
                record.seedingBonus ? formatNumber(record.seedingBonus) : "-"
              }}</span>
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
              :disabled="record.status == EResultParseStatus.success && record.date == currentDate()"
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
            :disabled="tableSelected.length <= 0"
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
