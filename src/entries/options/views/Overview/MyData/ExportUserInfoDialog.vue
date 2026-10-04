<script setup lang="ts">
import { CodeOutlined, FileExcelOutlined } from "@ant-design/icons-vue";
import { ref, computed } from "vue";
import { useI18n } from "vue-i18n";
import { saveAs } from "file-saver";

import type { IUserInfo, TSiteID } from "@ptd/site";

import { formatDate } from "@/options/utils.ts";
import { useRuntimeStore } from "@/options/stores/runtime.ts";
import { useMetadataStore } from "@/options/stores/metadata.ts";
import { sendMessage } from "@/messages.ts";

import { fixUserInfo } from "./utils/format.ts";

interface IHistoryUserInfo extends IUserInfo {
  date: string;
  site: TSiteID;
  siteName: string;
}

interface IExportField {
  key: string;
  label: string;
  required?: boolean;
}

const props = defineProps<{
  selectedSiteIds: TSiteID[];
}>();

const showDialog = defineModel<boolean>();
const { t } = useI18n();
const runtimeStore = useRuntimeStore();
const metadataStore = useMetadataStore();

const isLoading = ref(false);

const allExportFields: IExportField[] = [
  { key: "site", label: "common.site", required: true },
  { key: "siteName", label: "MyData.exportDialog.fields.siteName", required: false },
  { key: "date", label: "common.date", required: true },
  { key: "name", label: "common.username", required: false },
  { key: "id", label: "MyData.exportDialog.fields.id", required: false },
  { key: "levelName", label: "MyData.exportDialog.fields.levelName", required: false },
  { key: "uploaded", label: "levelRequirement.uploaded", required: false },
  { key: "downloaded", label: "levelRequirement.downloaded", required: false },
  { key: "ratio", label: "levelRequirement.ratio", required: false },
  { key: "trueUploaded", label: "levelRequirement.trueUploaded", required: false },
  { key: "trueDownloaded", label: "levelRequirement.trueDownloaded", required: false },
  { key: "trueRatio", label: "levelRequirement.trueRatio", required: false },
  { key: "seeding", label: "levelRequirement.seeding", required: false },
  { key: "seedingSize", label: "levelRequirement.seedingSize", required: false },
  { key: "bonus", label: "levelRequirement.bonus", required: false },
  { key: "seedingBonus", label: "levelRequirement.seedingBonus", required: false },
  { key: "bonusPerHour", label: "levelRequirement.bonusPerHour", required: false },
  { key: "seedingBonusPerHour", label: "levelRequirement.seedingBonusPerHour", required: false },
  { key: "uploads", label: "levelRequirement.uploads", required: false },
  { key: "leeching", label: "levelRequirement.leeching", required: false },
  { key: "snatches", label: "levelRequirement.snatches", required: false },
  { key: "messageCount", label: "MyData.exportDialog.fields.messageCount", required: false },
  { key: "hnrUnsatisfied", label: "levelRequirement.hnrUnsatisfied", required: false },
  { key: "hnrPreWarning", label: "levelRequirement.hnrPreWarning", required: false },
  { key: "joinTime", label: "MyData.exportDialog.fields.joinTime", required: false },
  { key: "lastAccessAt", label: "MyData.exportDialog.fields.lastAccessAt", required: false },
  { key: "updateAt", label: "MyData.exportDialog.fields.updateAt", required: false },
];

const defaultKeys = allExportFields.map((f) => f.key);
const selectedKeys = ref<string[]>([...defaultKeys]);

const exportFormat = ref<"csv" | "json">("csv");

const querySiteIds = computed<TSiteID[]>(() => {
  if (props.selectedSiteIds.length > 0) {
    return props.selectedSiteIds;
  }
  return Object.keys(metadataStore.sites) as TSiteID[];
});

const isExportSelected = computed(() => props.selectedSiteIds.length > 0);

async function doExport() {
  isLoading.value = true;

  try {
    const tasks = querySiteIds.value.map(async (siteId) => {
      try {
        const history = (await sendMessage("getSiteUserInfo", siteId)) as Record<string, IUserInfo> | undefined;
        if (!history) return [];

        const siteName = metadataStore.siteNameMap[siteId] ?? siteId;
        const items: IHistoryUserInfo[] = [];
        for (const [date, item] of Object.entries(history)) {
          items.push({
            ...fixUserInfo(item),
            site: siteId,
            siteName,
            date,
          });
        }
        return items;
      } catch (e) {
        console.error(`加载站点 ${siteId} 历史数据失败`, e);
        return [];
      }
    });

    const results = await Promise.allSettled(tasks);
    const merged: IHistoryUserInfo[] = [];
    for (const result of results) {
      if (result.status === "fulfilled") {
        merged.push(...result.value);
      }
    }

    merged.sort((a, b) => b.date.localeCompare(a.date));

    if (merged.length === 0) {
      runtimeStore.showSnakebar(t("common.noData"), { color: "warning" });
      return;
    }

    const timestamp = formatDate(new Date(), "yyyyMMdd_HHmmss");
    const ext = exportFormat.value;
    const mime = exportFormat.value === "csv" ? "text/csv;charset=utf-8" : "application/json;charset=utf-8";
    const content = exportFormat.value === "csv" ? convertToCSV(merged) : convertToJSON(merged);
    const blob = new Blob(exportFormat.value === "csv" ? ["\ufeff", content] : [content], { type: mime });
    saveAs(blob, `userinfo-${timestamp}.${ext}`);
    showDialog.value = false;
  } finally {
    isLoading.value = false;
  }
}

function getSortedExportFields(): IExportField[] {
  const site = allExportFields.find((f) => f.key === "site")!;
  const date = allExportFields.find((f) => f.key === "date")!;
  const others = allExportFields.filter((f) => f.key !== "site" && f.key !== "date");
  return [site, date, ...others];
}

function getActiveFields(): IExportField[] {
  return getSortedExportFields().filter((f) => selectedKeys.value.includes(f.key));
}

function convertToCSV(items: IHistoryUserInfo[]): string {
  const activeFields = getActiveFields();
  const headers = activeFields.map((f) => f.key);
  const rows = items.map((item) =>
    headers
      .map((key) => {
        const raw = (item as any)[key];
        const val =
          raw === Infinity || raw === -Infinity || (typeof raw === "number" && isNaN(raw)) ? "" : String(raw ?? "");

        // A-26：CSV 公式注入防护。站点可控的字段（用户名、等级名、站点名…）会原样进入 CSV，
        // 以 = + - @ 或制表符/回车开头的单元格会被 Excel / Google Sheets 当作公式求值
        // （例如 `=HYPERLINK("http://x","click")`）。这里前置一个单引号，让表格软件按文本处理。
        const escaped = /^[=+\-@\t\r]/.test(val) ? `'${val}` : val;

        if (/[",\n\r]/.test(escaped)) {
          return `"${escaped.replace(/"/g, '""')}"`;
        }
        return escaped;
      })
      .join(","),
  );
  return [headers.join(","), ...rows].join("\n");
}

function convertToJSON(items: IHistoryUserInfo[]): string {
  const activeFields = getActiveFields();
  return JSON.stringify(
    items.map((item) => {
      const obj: Record<string, any> = {};
      for (const f of activeFields) {
        const raw = (item as any)[f.key];
        obj[f.key] =
          raw === Infinity || raw === -Infinity || (typeof raw === "number" && isNaN(raw)) ? null : (raw ?? null);
      }
      return obj;
    }),
    null,
    2,
  );
}
</script>

<template>
  <a-modal
    v-model:open="showDialog"
    :cancel-text="t('common.dialog.cancel')"
    :confirm-loading="isLoading"
    :ok-button-props="{ disabled: isLoading }"
    :ok-text="t('common.export')"
    :width="700"
    @ok="doExport"
  >
    <template #title>
      <template v-if="isExportSelected">
        {{ t("MyData.exportDialog.exportSelected", { count: querySiteIds.length }) }}
      </template>
      <template v-else>
        {{ t("MyData.exportDialog.exportAll", { count: querySiteIds.length }) }}
      </template>
    </template>

    <a-row :gutter="8">
      <a-col :span="24">
        <a-typography-text strong style="display: block; margin-bottom: 8px; font-size: 14px">
          {{ t("MyData.exportDialog.formatLabel") }}
        </a-typography-text>
        <a-radio-group v-model:value="exportFormat" button-style="solid">
          <a-radio-button value="csv">
            <FileExcelOutlined />
            {{ t("MyData.exportDialog.formatCSV") }}
          </a-radio-button>
          <a-radio-button value="json">
            <CodeOutlined />
            {{ t("MyData.exportDialog.formatJSON") }}
          </a-radio-button>
        </a-radio-group>
      </a-col>
    </a-row>

    <a-row :gutter="8">
      <a-col :span="24">
        <a-typography-text strong style="display: block; margin-bottom: 8px; font-size: 14px">
          {{ t("MyData.exportDialog.fieldsLabel") }}
        </a-typography-text>
        <a-card style="padding: 8px">
          <a-row :gutter="8">
            <a-col v-for="field in allExportFields" :key="field.key" :span="12" :md="8">
              <a-checkbox
                :checked="selectedKeys.includes(field.key)"
                :disabled="field.required"
                @update:checked="
                  (v: any) => {
                    if (v) {
                      selectedKeys.push(field.key);
                    } else {
                      selectedKeys = selectedKeys.filter((k) => k !== field.key);
                    }
                  }
                "
                >{{ t(field.label) }}</a-checkbox
              >
            </a-col>
          </a-row>
        </a-card>
      </a-col>
    </a-row>
  </a-modal>
</template>
