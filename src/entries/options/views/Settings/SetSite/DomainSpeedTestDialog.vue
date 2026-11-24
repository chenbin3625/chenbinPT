<script setup lang="ts">
import { CheckOutlined, ThunderboltOutlined } from "@ant-design/icons-vue";
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { TSiteID } from "@ptd/site";
import { siteMetadataIndex } from "@ptd/site/metadataIndex";

import { sendMessage } from "@/messages.ts";
import { useMetadataStore } from "@/options/stores/metadata.ts";
import { useRuntimeStore } from "@/options/stores/runtime.ts";
import SiteFavicon from "@/options/components/SiteFavicon/Index.vue";
import SiteName from "@/options/components/SiteName.vue";
import NoDataPlaceholder from "@/options/components/NoDataPlaceholder.vue";

interface IProbeResult {
  url: string;
  ok: boolean;
  status?: number;
  latencyMs: number;
  error?: string;
}

interface ISiteSpeedRow {
  siteId: TSiteID;
  currentUrl: string;
  candidateUrls: string[];
  loading: boolean;
  results: IProbeResult[];
}

const showDialog = defineModel<boolean>();
const props = defineProps<{
  siteIds: TSiteID[];
}>();

const { t } = useI18n();
const metadataStore = useMetadataStore();
const runtimeStore = useRuntimeStore();

const rows = ref<ISiteSpeedRow[]>([]);
const testingAll = ref(false);

function collectSiteUrls(siteId: TSiteID): string[] {
  const urls = new Set<string>();
  const userUrl = metadataStore.sites[siteId]?.url;
  if (userUrl) urls.add(userUrl);
  for (const u of siteMetadataIndex[siteId]?.urls ?? []) {
    if (u) urls.add(u);
  }
  for (const u of metadataStore.customSites?.[siteId]?.urls ?? []) {
    if (u) urls.add(u);
  }
  return Array.from(urls);
}

function initRows() {
  const targetIds =
    props.siteIds.length > 0
      ? props.siteIds
      : metadataStore.getAddedSiteIds.filter((id) => collectSiteUrls(id).length > 1);

  rows.value = targetIds
    .map((siteId) => {
      const candidateUrls = collectSiteUrls(siteId);
      const currentUrl = metadataStore.sites[siteId]?.url || candidateUrls[0] || "";
      return {
        siteId,
        currentUrl,
        candidateUrls,
        loading: false,
        results: [],
      };
    })
    .filter((r) => r.candidateUrls.length > 0);
}

async function testRow(row: ISiteSpeedRow) {
  row.loading = true;
  try {
    const res = await sendMessage("testSiteUrlsLatency", {
      siteId: row.siteId,
      urls: row.candidateUrls,
    });
    row.results = [...res].sort((a, b) => {
      if (a.ok !== b.ok) return a.ok ? -1 : 1;
      return a.latencyMs - b.latencyMs;
    });
  } catch {
    row.results = row.candidateUrls.map((url) => ({ url, ok: false, latencyMs: -1, error: "Failed" }));
  } finally {
    row.loading = false;
  }
}

async function testAll() {
  if (testingAll.value || rows.value.length === 0) return;
  testingAll.value = true;
  try {
    let cursor = 0;
    const concurrency = 4;
    const worker = async () => {
      while (cursor < rows.value.length) {
        const row = rows.value[cursor++];
        await testRow(row);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, rows.value.length) }, worker));
  } finally {
    testingAll.value = false;
  }
}

async function applyUrlForSite(row: ISiteSpeedRow, url: string) {
  const site = metadataStore.sites[row.siteId];
  if (!site) return;
  site.url = url as typeof site.url;
  row.currentUrl = url;
  await metadataStore.$save();
  await metadataStore.buildSiteMapCache(true);
  runtimeStore.showSnackbar(t("SetSite.speedTest.switched", { url }), { color: "success" });
}

const switchableCount = computed(
  () =>
    rows.value.filter((row) => {
      const best = row.results.find((r) => r.ok);
      return best && best.url !== row.currentUrl;
    }).length,
);

async function applyAllFastest() {
  let switched = 0;
  for (const row of rows.value) {
    const best = row.results.find((r) => r.ok);
    const targetSite = metadataStore.sites[row.siteId];
    if (best && best.url !== row.currentUrl && targetSite) {
      targetSite.url = best.url as typeof targetSite.url;
      row.currentUrl = best.url;
      switched += 1;
    }
  }
  if (switched > 0) {
    await metadataStore.$save();
    await metadataStore.buildSiteMapCache(true);
    runtimeStore.showSnackbar(t("SetSite.speedTest.switchedAll", { count: switched }), { color: "success" });
  }
}

watch(showDialog, (open) => {
  if (open) {
    initRows();
    void testAll();
  }
});
</script>

<template>
  <a-modal v-model:open="showDialog" :title="t('SetSite.speedTest.title')" :width="820" :footer="null">
    <div class="speed-test__toolbar">
      <a-typography-text type="secondary">{{ t("SetSite.speedTest.hint") }}</a-typography-text>
      <a-space :size="8">
        <a-button size="small" :loading="testingAll" @click="testAll">
          <template #icon><ThunderboltOutlined /></template>
          {{ t("SetSite.speedTest.retest") }}
        </a-button>
        <a-button size="small" type="primary" :disabled="switchableCount === 0 || testingAll" @click="applyAllFastest">
          <template #icon><CheckOutlined /></template>
          {{ t("SetSite.speedTest.switchAllFastest", { count: switchableCount }) }}
        </a-button>
      </a-space>
    </div>

    <NoDataPlaceholder v-if="rows.length === 0" compact :description="t('SetSite.speedTest.empty')" />

    <a-list v-else :data-source="rows" size="small" class="speed-test__list">
      <template #renderItem="{ item: row }">
        <a-list-item class="speed-test__item">
          <div class="speed-test__row">
            <div class="speed-test__site">
              <SiteFavicon :site-id="row.siteId" :size="18" />
              <SiteName :site-id="row.siteId" tag="strong" />
              <a-spin v-if="row.loading" size="small" />
            </div>
            <div class="speed-test__urls">
              <div v-for="probe in row.results" :key="probe.url" class="speed-test__url-line">
                <a-tag :color="probe.ok ? (probe.latencyMs < 600 ? 'green' : 'orange') : 'error'">
                  {{ probe.ok ? `${probe.latencyMs} ms` : t("SetSite.speedTest.unreachable") }}
                </a-tag>
                <span class="speed-test__url-text" :title="probe.url">{{ probe.url }}</span>
                <a-tag v-if="probe.url === row.currentUrl" color="blue">{{ t("SetSite.speedTest.current") }}</a-tag>
                <a-button v-else-if="probe.ok" size="small" type="link" @click="applyUrlForSite(row, probe.url)">
                  {{ t("SetSite.speedTest.useThis") }}
                </a-button>
              </div>
            </div>
          </div>
        </a-list-item>
      </template>
    </a-list>
  </a-modal>
</template>

<style scoped>
.speed-test__toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 12px;
}

.speed-test__list {
  max-height: 62vh;
  overflow-y: auto;
}

.speed-test__item {
  padding: 8px 4px;
}

.speed-test__row {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.speed-test__site {
  display: flex;
  align-items: center;
  gap: 6px;
}

.speed-test__urls {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-left: 24px;
}

.speed-test__url-line {
  display: flex;
  align-items: center;
  gap: 8px;
}

.speed-test__url-text {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--ptd-font-size-sm);
}
</style>
