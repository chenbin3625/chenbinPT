<script setup lang="ts">
import { EyeInvisibleOutlined, EyeOutlined } from "@ant-design/icons-vue";
import { computed, nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import { resolveColor } from "@/shared/colors.ts";
import { useMetadataStore } from "@/options/stores/metadata.ts";
import type { IDownloaderMetadata, TDownloaderKey } from "@/shared/types.ts";

import SiteFavicon from "@/options/components/SiteFavicon/Index.vue";
import CheckSwitchButton from "@/options/components/CheckSwitchButton.vue";
import PageSkeleton from "@/options/components/PageSkeleton.vue";
import NoDataPlaceholder from "@/options/components/NoDataPlaceholder.vue";
import { useConfigStore } from "@/options/stores/config.ts";
import { useStoreHydrating } from "@/options/composables/useStoreHydrating.ts";

const showDialog = defineModel<boolean>();
const { clientId } = defineProps<{
  clientId: TDownloaderKey;
}>();

const { t } = useI18n();
const metadataStore = useMetadataStore();
const configStore = useConfigStore();

// 站点列表来自 metadata store，异步水合完成前不能把空列表当成「暂无已添加的站点」
const isStoreHydrating = useStoreHydrating(metadataStore);

const clientConfig = ref<IDownloaderMetadata>();
const excludedSites = ref<string[]>([]);

const addedSites = computed(() =>
  Object.entries(metadataStore.sites)
    .filter(([id, site]) => (configStore.contentScript.allowExceptionSites ? (site.allowContentScript ?? true) : true))
    .map(([id]) => ({ id, name: metadataStore.siteNameMap[id] ?? id }))
    .sort((a, b) => a.name.localeCompare(b.name)),
);

const allSiteIds = computed(() => addedSites.value.map((s) => s.id));

function onEnter() {
  if (clientId) {
    clientConfig.value = { excludedSites: [], ...metadataStore.downloaders[clientId] };
    excludedSites.value = [...(clientConfig.value.excludedSites ?? [])];
  }
}

function save() {
  metadataStore.simplePatch("downloaders", clientId, "excludedSites", excludedSites.value);
  showDialog.value = false;
}

function toggleExcluded(siteId: string, checked: boolean) {
  excludedSites.value = checked
    ? Array.from(new Set([...excludedSites.value, siteId]))
    : excludedSites.value.filter((id) => id !== siteId);
}

// 原生 a-modal 没有 afterOpenChange（只有 afterClose），打开时的初始化自行监听 open。
watch(showDialog, (open) => {
  if (open) nextTick(onEnter);
});
</script>

<template>
  <a-modal
    v-model:open="showDialog"
    :cancel-text="t('common.dialog.cancel')"
    :ok-text="t('common.dialog.ok')"
    :title="t('SetDownloader.siteFilter.title', [clientConfig?.name ?? clientId])"
    :width="1000"
    @ok="save"
  >
    <div class="ptd-inline-toolbar">
      <a-typography-text type="secondary">
        {{ t("SetDownloader.siteFilter.excludedSitesHint") }}
      </a-typography-text>
      <!-- A-27：原 color="blue-lighten-1" / variant="tonal" 都不是 antd 语义（前者未被 NavButton 映射、
           后者在 antd 4.2.6 中不存在），改用低强调的 text 按钮 -->
      <CheckSwitchButton v-model="excludedSites" :all="allSiteIds" type="text" />
    </div>

    <!-- 原实现的 PtdSkeletonLoader 语义是「无数据」而非「加载中」，这里按真实状态拆开：
         水合/加载期间用骨架屏，确实没有已添加站点时用空状态占位 -->
    <PageSkeleton v-if="isStoreHydrating" :count="6" :rows="2" variant="masonry" />
    <NoDataPlaceholder v-else-if="addedSites.length === 0" :description="t('SetDownloader.siteFilter.noSites')" />

    <a-list v-else style="overflow: hidden; padding: 12px 12px 0 12px">
      <!-- 站点卡片间距由列上的 padding 控制，行容器保持零间距 -->
      <a-row :gutter="0">
        <a-col v-for="site in addedSites" :key="site.id" :md="8" :sm="12" :xs="24" style="padding: 4px">
          <a-list-item
            class="ptd-list-item"
            style="
              border-bottom: 1px solid var(--ptd-border, rgba(5, 5, 5, 0.06));
              background: var(--ptd-hover, #f5f5f5);
            "
          >
            <a-list-item-meta>
              <template #avatar>
                <SiteFavicon :site-id="site.id" flush-on-click style="margin-right: 8px" />
              </template>

              <template #title>
                <strong>{{ site.name }}</strong>
              </template>

              <template #description>
                <a-tag style="margin-top: 4px">{{ site.id }}</a-tag>
              </template>
            </a-list-item-meta>

            <a-checkbox
              :checked="excludedSites.includes(site.id)"
              @update:checked="(checked: boolean) => toggleExcluded(site.id, checked)"
            >
              <EyeInvisibleOutlined v-if="excludedSites.includes(site.id)" :style="{ color: resolveColor('error') }" />
              <EyeOutlined v-else />
            </a-checkbox>
          </a-list-item>
        </a-col>
      </a-row>
    </a-list>
  </a-modal>
</template>
