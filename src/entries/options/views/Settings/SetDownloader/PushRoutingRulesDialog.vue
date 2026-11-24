<script setup lang="ts">
import { DeleteOutlined, EditOutlined, PlusOutlined } from "@ant-design/icons-vue";
import { nanoid } from "nanoid";
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";

import { useMetadataStore } from "@/options/stores/metadata.ts";
import { matchPushRoutingRule } from "@/shared/pushRouting.ts";
import type { IPushRoutingRule } from "@/shared/types.ts";
import NoDataPlaceholder from "@/options/components/NoDataPlaceholder.vue";

const showDialog = defineModel<boolean>();
const { t } = useI18n();
const metadataStore = useMetadataStore();

const editingRule = ref<IPushRoutingRule | null>(null);
const showEditorModal = ref(false);

// 表单草稿字段（用于 string[] 与文本框互转）
const categoriesText = ref("");
const tagsText = ref("");

// 规则测试器
const testTitle = ref("");
const testSite = ref<string | undefined>(undefined);
const testCategory = ref("");
const testSizeGiB = ref<number | undefined>(undefined);
const testFree = ref(false);

const sortedRules = computed(() =>
  [...(metadataStore.pushRoutingRules ?? [])].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0)),
);

const siteOptions = computed(() =>
  metadataStore.getSortedAddedSites.map((s) => ({
    value: s.id,
    label: metadataStore.siteNameMap[s.id] || s.id,
  })),
);

const downloaderOptions = computed(() =>
  metadataStore.getSortedEnabledDownloaders.map((d) => ({
    value: d.id,
    label: `${d.name} (${d.type})`,
  })),
);

const targetDownloader = computed(() =>
  editingRule.value?.targetDownloaderId ? metadataStore.downloaders[editingRule.value.targetDownloaderId] : undefined,
);

const testedMatch = computed(() => {
  if (
    !testTitle.value.trim() &&
    !testSite.value &&
    !testCategory.value.trim() &&
    !testSizeGiB.value &&
    !testFree.value
  ) {
    return null;
  }
  const enabledIds = new Set(metadataStore.getEnabledDownloaders.map((d) => d.id));
  return matchPushRoutingRule(
    {
      site: testSite.value ?? "",
      title: testTitle.value,
      category: testCategory.value,
      size: typeof testSizeGiB.value === "number" ? testSizeGiB.value * 1024 ** 3 : 0,
      downloadVolumeFactor: testFree.value ? 0 : 1,
      tags: testFree.value ? [{ name: "Free" }] : [],
    },
    sortedRules.value,
    enabledIds,
  );
});

function openCreate() {
  editingRule.value = {
    id: nanoid(10),
    name: "",
    enabled: true,
    priority: 100,
    sites: [],
    categories: [],
    minSizeGiB: undefined,
    maxSizeGiB: undefined,
    freeOnly: false,
    tags: [],
    titleRegex: "",
    targetDownloaderId: metadataStore.defaultDownloader?.id || metadataStore.getEnabledDownloaders[0]?.id || "",
    savePath: "",
    label: "",
    uploadSpeedLimit: undefined,
    addAtPaused: undefined,
  };
  categoriesText.value = "";
  tagsText.value = "";
  showEditorModal.value = true;
}

function openEdit(rule: IPushRoutingRule) {
  editingRule.value = {
    ...rule,
    sites: [...(rule.sites ?? [])],
    categories: [...(rule.categories ?? [])],
    tags: [...(rule.tags ?? [])],
  };
  categoriesText.value = (rule.categories ?? []).join(", ");
  tagsText.value = (rule.tags ?? []).join(", ");
  showEditorModal.value = true;
}

function saveRule() {
  const draft = editingRule.value;
  if (!draft || !draft.name.trim() || !draft.targetDownloaderId) return;
  draft.categories = categoriesText.value
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean);
  draft.tags = tagsText.value
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean);
  metadataStore.savePushRoutingRule(draft);
  showEditorModal.value = false;
}

function toggleRuleEnabled(rule: IPushRoutingRule, checked: boolean) {
  metadataStore.savePushRoutingRule({ ...rule, enabled: checked });
}

function ruleSummary(rule: IPushRoutingRule): string {
  const parts: string[] = [];
  if (rule.sites?.length) parts.push(`${t("common.site")}: ${rule.sites.length}`);
  if (rule.categories?.length) parts.push(`${t("SetDownloader.routing.categories")}: ${rule.categories.join("/")}`);
  if (rule.minSizeGiB || rule.maxSizeGiB) {
    parts.push(`${rule.minSizeGiB ?? 0}~${rule.maxSizeGiB ?? "∞"} GiB`);
  }
  if (rule.freeOnly) parts.push("Free");
  if (rule.tags?.length) parts.push(`Tags: ${rule.tags.join("/")}`);
  if (rule.titleRegex) parts.push(`/${rule.titleRegex}/`);
  return parts.length > 0 ? parts.join(" · ") : t("SetDownloader.routing.matchAll");
}
</script>

<template>
  <a-modal v-model:open="showDialog" :title="t('SetDownloader.routing.title')" :width="900" :footer="null">
    <div class="routing-dialog__header">
      <a-typography-text type="secondary">{{ t("SetDownloader.routing.description") }}</a-typography-text>
      <a-button type="primary" size="small" :disabled="downloaderOptions.length === 0" @click="openCreate">
        <template #icon><PlusOutlined /></template>
        {{ t("SetDownloader.routing.addRule") }}
      </a-button>
    </div>

    <NoDataPlaceholder v-if="sortedRules.length === 0" compact :description="t('SetDownloader.routing.empty')" />

    <a-list v-else :data-source="sortedRules" size="small" bordered class="routing-dialog__list">
      <template #renderItem="{ item }">
        <a-list-item>
          <a-list-item-meta>
            <template #title>
              <a-space :size="6" wrap>
                <a-tag color="blue">P{{ item.priority }}</a-tag>
                <strong>{{ item.name }}</strong>
                <span class="routing-dialog__arrow">→</span>
                <a-tag color="green">
                  {{ metadataStore.downloaders[item.targetDownloaderId]?.name || item.targetDownloaderId }}
                </a-tag>
                <a-tag v-if="item.savePath">{{ item.savePath }}</a-tag>
                <a-tag v-if="item.label" color="purple">{{ item.label }}</a-tag>
              </a-space>
            </template>
            <template #description>{{ ruleSummary(item) }}</template>
          </a-list-item-meta>
          <template #actions>
            <a-switch
              :checked="item.enabled"
              size="small"
              @change="(checked: any) => toggleRuleEnabled(item, Boolean(checked))"
            />
            <a-button size="small" type="text" @click="openEdit(item)">
              <template #icon><EditOutlined /></template>
            </a-button>
            <a-button size="small" type="text" danger @click="metadataStore.removePushRoutingRule(item.id)">
              <template #icon><DeleteOutlined /></template>
            </a-button>
          </template>
        </a-list-item>
      </template>
    </a-list>

    <!-- 规则在线测试器 -->
    <div v-if="sortedRules.length > 0" class="routing-tester">
      <div class="routing-tester__title">{{ t("SetDownloader.routing.testerTitle") }}</div>
      <a-row :gutter="8">
        <a-col :span="8">
          <a-input
            v-model:value="testTitle"
            size="small"
            :placeholder="t('SetDownloader.routing.testTitlePlaceholder')"
          />
        </a-col>
        <a-col :span="5">
          <a-select
            v-model:value="testSite"
            :options="siteOptions"
            size="small"
            allow-clear
            show-search
            option-filter-prop="label"
            :placeholder="t('common.site')"
            class="routing-full-width"
          />
        </a-col>
        <a-col :span="4">
          <a-input v-model:value="testCategory" size="small" :placeholder="t('SetDownloader.routing.categories')" />
        </a-col>
        <a-col :span="4">
          <a-input-number
            v-model:value="testSizeGiB"
            size="small"
            :min="0"
            placeholder="GiB"
            class="routing-full-width"
          />
        </a-col>
        <a-col :span="3">
          <a-checkbox v-model:checked="testFree">Free</a-checkbox>
        </a-col>
      </a-row>
      <div class="routing-tester__result">
        <a-tag v-if="testedMatch" color="success">
          {{
            t("SetDownloader.routing.testMatched", {
              rule: testedMatch.name,
              downloader:
                metadataStore.downloaders[testedMatch.targetDownloaderId]?.name || testedMatch.targetDownloaderId,
            })
          }}
        </a-tag>
        <a-typography-text v-else type="secondary">{{ t("SetDownloader.routing.testNoMatch") }}</a-typography-text>
      </div>
    </div>

    <!-- 新增/编辑规则弹窗 -->
    <a-modal
      v-model:open="showEditorModal"
      :title="t('SetDownloader.routing.editTitle')"
      :width="680"
      :ok-button-props="{ disabled: !editingRule?.name?.trim() || !editingRule?.targetDownloaderId }"
      @ok="saveRule"
    >
      <a-form v-if="editingRule" layout="vertical">
        <a-row :gutter="12">
          <a-col :span="14">
            <a-form-item :label="t('SetDownloader.routing.ruleName')" required>
              <a-input v-model:value="editingRule.name" />
            </a-form-item>
          </a-col>
          <a-col :span="6">
            <a-form-item :label="t('SetDownloader.routing.priority')">
              <a-input-number v-model:value="editingRule.priority" :min="0" :max="9999" class="routing-full-width" />
            </a-form-item>
          </a-col>
          <a-col :span="4">
            <a-form-item :label="t('common.enable')">
              <a-switch v-model:checked="editingRule.enabled" />
            </a-form-item>
          </a-col>
        </a-row>

        <a-divider class="routing-divider">{{ t("SetDownloader.routing.conditions") }}</a-divider>

        <a-row :gutter="12">
          <a-col :span="12">
            <a-form-item :label="t('SetDownloader.routing.sites')">
              <a-select
                v-model:value="editingRule.sites"
                mode="multiple"
                allow-clear
                show-search
                option-filter-prop="label"
                :options="siteOptions"
                :placeholder="t('SetDownloader.routing.anySite')"
              />
            </a-form-item>
          </a-col>
          <a-col :span="12">
            <a-form-item :label="t('SetDownloader.routing.categories')">
              <a-input v-model:value="categoriesText" :placeholder="t('SetDownloader.routing.commaSeparated')" />
            </a-form-item>
          </a-col>
        </a-row>

        <a-row :gutter="12">
          <a-col :span="8">
            <a-form-item :label="t('SetDownloader.routing.minSizeGiB')">
              <a-input-number v-model:value="editingRule.minSizeGiB" :min="0" class="routing-full-width" />
            </a-form-item>
          </a-col>
          <a-col :span="8">
            <a-form-item :label="t('SetDownloader.routing.maxSizeGiB')">
              <a-input-number v-model:value="editingRule.maxSizeGiB" :min="0" class="routing-full-width" />
            </a-form-item>
          </a-col>
          <a-col :span="8">
            <a-form-item :label="t('SetDownloader.routing.freeOnly')">
              <a-switch v-model:checked="editingRule.freeOnly" />
            </a-form-item>
          </a-col>
        </a-row>

        <a-row :gutter="12">
          <a-col :span="12">
            <a-form-item :label="t('SetDownloader.routing.tags')">
              <a-input v-model:value="tagsText" :placeholder="t('SetDownloader.routing.commaSeparated')" />
            </a-form-item>
          </a-col>
          <a-col :span="12">
            <a-form-item :label="t('SetDownloader.routing.titleRegex')">
              <a-input v-model:value="editingRule.titleRegex" placeholder="e.g. 2160p|REMUX" />
            </a-form-item>
          </a-col>
        </a-row>

        <a-divider class="routing-divider">{{ t("SetDownloader.routing.targetAction") }}</a-divider>

        <a-row :gutter="12">
          <a-col :span="12">
            <a-form-item :label="t('SetDownloader.routing.targetDownloader')" required>
              <a-select v-model:value="editingRule.targetDownloaderId" :options="downloaderOptions" />
            </a-form-item>
          </a-col>
          <a-col :span="12">
            <a-form-item :label="t('SentToDownloaderDialog.savePath')">
              <a-auto-complete
                v-model:value="editingRule.savePath"
                :options="(targetDownloader?.suggestFolders ?? []).map((v) => ({ value: v }))"
                allow-clear
              />
            </a-form-item>
          </a-col>
        </a-row>

        <a-row :gutter="12">
          <a-col :span="10">
            <a-form-item :label="t('SentToDownloaderDialog.label')">
              <a-auto-complete
                v-model:value="editingRule.label"
                :options="(targetDownloader?.suggestTags ?? []).map((v) => ({ value: v }))"
                allow-clear
              />
            </a-form-item>
          </a-col>
          <a-col :span="8">
            <a-form-item :label="t('SetDownloader.routing.uploadSpeedLimit')">
              <a-input-number v-model:value="editingRule.uploadSpeedLimit" :min="0" class="routing-full-width" />
            </a-form-item>
          </a-col>
          <a-col :span="6">
            <a-form-item :label="t('SentToDownloaderDialog.pauseOnAdd')">
              <a-switch v-model:checked="editingRule.addAtPaused" />
            </a-form-item>
          </a-col>
        </a-row>
      </a-form>
    </a-modal>
  </a-modal>
</template>

<style scoped>
.routing-dialog__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 12px;
}

.routing-dialog__list {
  max-height: 360px;
  overflow-y: auto;
}

.routing-dialog__arrow {
  color: var(--ptd-text-tertiary);
}

.routing-tester {
  margin-top: 14px;
  padding: 10px 12px;
  border: 1px solid var(--ptd-border);
  border-radius: var(--ptd-radius, 6px);
  background: var(--ptd-surface-soft);
}

.routing-tester__title {
  margin-bottom: 8px;
  font-weight: 500;
  font-size: var(--ptd-font-size-sm);
}

.routing-tester__result {
  margin-top: 8px;
}

.routing-full-width {
  width: 100%;
}

.routing-divider {
  margin: 8px 0 12px;
}
</style>
