<script setup lang="ts">
import { DeleteOutlined, EditOutlined, PlayCircleOutlined, PlusOutlined } from "@ant-design/icons-vue";
import { nanoid } from "nanoid";
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";

import { sendMessage } from "@/messages.ts";
import { useMetadataStore } from "@/options/stores/metadata.ts";
import { useRuntimeStore } from "@/options/stores/runtime.ts";
import { formatDate } from "@/options/utils.ts";
import type { IKeywordWatchRule } from "@/shared/types.ts";
import NoDataPlaceholder from "@/options/components/NoDataPlaceholder.vue";

const { t } = useI18n();
const metadataStore = useMetadataStore();
const runtimeStore = useRuntimeStore();

const showEditor = ref(false);
const runningIds = ref<Record<string, boolean>>({});
const draft = ref<IKeywordWatchRule | null>(null);

const watchList = computed(() =>
  Object.values(metadataStore.keywordWatches ?? {}).sort((a, b) => (b.lastMatchAt ?? 0) - (a.lastMatchAt ?? 0)),
);

const solutionOptions = computed(() => [
  { label: t("layout.header.searchPlan.default"), value: "default" },
  { label: t("layout.header.searchPlan.all"), value: "all" },
  ...metadataStore.getSearchSolutions.filter((s) => s.enabled).map((s) => ({ label: s.name, value: s.id })),
]);

const columns = computed(() => [
  { title: t("KeywordWatch.table.name"), key: "name", dataIndex: "name" },
  { title: t("KeywordWatch.table.keyword"), key: "keyword", dataIndex: "keyword" },
  { title: t("KeywordWatch.table.solution"), key: "solutionId" },
  { title: t("KeywordWatch.table.interval"), key: "intervalMinutes", align: "center" as const },
  { title: t("KeywordWatch.table.matches"), key: "matches", align: "center" as const },
  { title: t("KeywordWatch.table.lastRun"), key: "lastRunAt", align: "center" as const },
  { title: t("common.enable"), key: "enabled", align: "center" as const },
  { title: t("common.action"), key: "action", align: "center" as const },
]);

function openCreate() {
  draft.value = {
    id: nanoid(10),
    name: "",
    enabled: true,
    keyword: "",
    solutionId: "default",
    intervalMinutes: 60,
    freeOnly: false,
    minSizeGiB: undefined,
    maxSizeGiB: undefined,
    minSeeders: undefined,
    titleIncludeRegex: "",
    titleExcludeRegex: "",
    autoFavorite: true,
    favCategory: t("KeywordWatch.defaultFavCategory"),
    notifyBrowser: true,
    notifyWebhook: false,
    seenTorrentKeys: [],
  };
  showEditor.value = true;
}

function openEdit(rule: IKeywordWatchRule) {
  draft.value = { ...rule };
  showEditor.value = true;
}

function saveDraft() {
  if (!draft.value || !draft.value.name.trim() || !draft.value.keyword.trim()) return;
  draft.value.intervalMinutes = Math.max(30, Math.floor(Number(draft.value.intervalMinutes) || 60));
  metadataStore.saveKeywordWatch(draft.value);
  showEditor.value = false;
  runtimeStore.showSnackbar(t("KeywordWatch.saved"), { color: "success" });
}

function toggleEnabled(rule: IKeywordWatchRule, checked: boolean) {
  metadataStore.saveKeywordWatch({ ...rule, enabled: checked });
}

async function runRuleNow(rule: IKeywordWatchRule) {
  if (runningIds.value[rule.id]) return;
  runningIds.value = { ...runningIds.value, [rule.id]: true };
  try {
    const res = await sendMessage("runKeywordWatchRule", rule.id);
    if (res.error) {
      runtimeStore.showSnackbar(t("KeywordWatch.runError", { error: res.error }), { color: "warning" });
    } else if (res.newMatches.length > 0) {
      runtimeStore.showSnackbar(
        t("KeywordWatch.runMatched", { count: res.newMatches.length, total: res.matchedCount }),
        { color: "success" },
      );
    } else {
      runtimeStore.showSnackbar(t("KeywordWatch.runNoNew", { total: res.matchedCount }), { color: "info" });
    }
  } catch (e) {
    runtimeStore.showSnackbar(t("KeywordWatch.runError", { error: e instanceof Error ? e.message : String(e) }), {
      color: "error",
    });
  } finally {
    runningIds.value = { ...runningIds.value, [rule.id]: false };
  }
}

function getSolutionLabel(solutionId: string): string {
  if (solutionId === "default") return t("layout.header.searchPlan.default");
  if (solutionId === "all") return t("layout.header.searchPlan.all");
  return metadataStore.getSearchSolutionName(solutionId);
}
</script>

<template>
  <a-card>
    <div class="keyword-watch__toolbar">
      <a-alert type="info" show-icon :message="t('KeywordWatch.hint')" class="keyword-watch__alert" />
      <a-button type="primary" @click="openCreate">
        <template #icon><PlusOutlined /></template>
        {{ t("KeywordWatch.addRule") }}
      </a-button>
    </div>

    <a-table
      :columns="columns"
      :data-source="watchList"
      :pagination="false"
      row-key="id"
      class="table-stripe table-header-no-wrap"
      :scroll="{ x: 'max-content' }"
    >
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'name'">
          <div class="keyword-watch__name-cell">
            <strong>{{ record.name }}</strong>
            <a-space :size="4" wrap>
              <a-tag v-if="record.freeOnly" color="green">Free</a-tag>
              <a-tag v-if="record.autoFavorite" color="gold">{{ t("KeywordWatch.autoFavorite") }}</a-tag>
              <a-tag v-if="record.lastError" color="error" :title="record.lastError">
                {{ t("KeywordWatch.errorTag") }}
              </a-tag>
            </a-space>
          </div>
        </template>

        <template v-else-if="column.key === 'solutionId'">
          {{ getSolutionLabel(record.solutionId) }}
        </template>

        <template v-else-if="column.key === 'intervalMinutes'">
          {{ t("KeywordWatch.everyMinutes", { minutes: record.intervalMinutes }) }}
        </template>

        <template v-else-if="column.key === 'matches'">
          <span>{{ record.lastMatchCount ?? 0 }} / {{ record.totalMatchCount ?? 0 }}</span>
        </template>

        <template v-else-if="column.key === 'lastRunAt'">
          <span class="ptd-date-time">{{ record.lastRunAt ? formatDate(record.lastRunAt) : "-" }}</span>
        </template>

        <template v-else-if="column.key === 'enabled'">
          <a-switch :checked="record.enabled" @change="(checked: any) => toggleEnabled(record, Boolean(checked))" />
        </template>

        <template v-else-if="column.key === 'action'">
          <a-button-group class="table-action">
            <a-button
              size="small"
              type="primary"
              :loading="runningIds[record.id]"
              :title="t('KeywordWatch.runNow')"
              @click="runRuleNow(record)"
            >
              <template #icon><PlayCircleOutlined /></template>
            </a-button>
            <a-button size="small" :title="t('common.edit')" @click="openEdit(record)">
              <template #icon><EditOutlined /></template>
            </a-button>
            <a-button
              size="small"
              danger
              :title="t('common.remove')"
              @click="metadataStore.removeKeywordWatch(record.id)"
            >
              <template #icon><DeleteOutlined /></template>
            </a-button>
          </a-button-group>
        </template>
      </template>

      <template #emptyText>
        <NoDataPlaceholder compact :description="t('KeywordWatch.empty')" />
      </template>
    </a-table>
  </a-card>

  <a-modal
    v-model:open="showEditor"
    :title="t('KeywordWatch.editorTitle')"
    :width="680"
    :ok-button-props="{ disabled: !draft?.name?.trim() || !draft?.keyword?.trim() }"
    @ok="saveDraft"
  >
    <a-form v-if="draft" layout="vertical">
      <a-row :gutter="12">
        <a-col :span="12">
          <a-form-item :label="t('KeywordWatch.table.name')" required>
            <a-input v-model:value="draft.name" :placeholder="t('KeywordWatch.namePlaceholder')" />
          </a-form-item>
        </a-col>
        <a-col :span="12">
          <a-form-item :label="t('KeywordWatch.table.keyword')" required>
            <a-input v-model:value="draft.keyword" :placeholder="t('KeywordWatch.keywordPlaceholder')" />
          </a-form-item>
        </a-col>
      </a-row>

      <a-row :gutter="12">
        <a-col :span="12">
          <a-form-item :label="t('KeywordWatch.table.solution')">
            <a-select v-model:value="draft.solutionId" :options="solutionOptions" />
          </a-form-item>
        </a-col>
        <a-col :span="8">
          <a-form-item :label="t('KeywordWatch.intervalLabel')">
            <a-input-number v-model:value="draft.intervalMinutes" :min="30" :max="1440" class="keyword-watch__full" />
          </a-form-item>
        </a-col>
        <a-col :span="4">
          <a-form-item :label="t('SetDownloader.routing.freeOnly')">
            <a-switch v-model:checked="draft.freeOnly" />
          </a-form-item>
        </a-col>
      </a-row>

      <a-row :gutter="12">
        <a-col :span="8">
          <a-form-item :label="t('SetDownloader.routing.minSizeGiB')">
            <a-input-number v-model:value="draft.minSizeGiB" :min="0" class="keyword-watch__full" />
          </a-form-item>
        </a-col>
        <a-col :span="8">
          <a-form-item :label="t('SetDownloader.routing.maxSizeGiB')">
            <a-input-number v-model:value="draft.maxSizeGiB" :min="0" class="keyword-watch__full" />
          </a-form-item>
        </a-col>
        <a-col :span="8">
          <a-form-item :label="t('KeywordWatch.minSeeders')">
            <a-input-number v-model:value="draft.minSeeders" :min="0" class="keyword-watch__full" />
          </a-form-item>
        </a-col>
      </a-row>

      <a-row :gutter="12">
        <a-col :span="12">
          <a-form-item :label="t('KeywordWatch.titleIncludeRegex')">
            <a-input v-model:value="draft.titleIncludeRegex" placeholder="e.g. 2160p|HDR" />
          </a-form-item>
        </a-col>
        <a-col :span="12">
          <a-form-item :label="t('KeywordWatch.titleExcludeRegex')">
            <a-input v-model:value="draft.titleExcludeRegex" placeholder="e.g. CAM|TS" />
          </a-form-item>
        </a-col>
      </a-row>

      <a-row :gutter="12">
        <a-col :span="6">
          <a-form-item :label="t('KeywordWatch.autoFavorite')">
            <a-switch v-model:checked="draft.autoFavorite" />
          </a-form-item>
        </a-col>
        <a-col :span="8">
          <a-form-item :label="t('KeywordWatch.favCategory')">
            <a-input v-model:value="draft.favCategory" :disabled="!draft.autoFavorite" />
          </a-form-item>
        </a-col>
        <a-col :span="5">
          <a-form-item :label="t('KeywordWatch.notifyBrowser')">
            <a-switch v-model:checked="draft.notifyBrowser" />
          </a-form-item>
        </a-col>
        <a-col :span="5">
          <a-form-item :label="t('KeywordWatch.notifyWebhook')">
            <a-switch v-model:checked="draft.notifyWebhook" />
          </a-form-item>
        </a-col>
      </a-row>
    </a-form>
  </a-modal>
</template>

<style scoped>
.keyword-watch__toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 12px;
}

.keyword-watch__alert {
  flex: 1 1 320px;
}

.keyword-watch__name-cell {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.keyword-watch__full {
  width: 100%;
}
</style>
