<script setup lang="ts">
import {
  ExportOutlined,
  HeartFilled,
  InfoCircleOutlined,
  SearchOutlined,
  StarFilled,
  VideoCameraOutlined,
} from "@ant-design/icons-vue";
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute } from "vue-router";
import { useIntersectionObserver, useThrottleFn } from "@vueuse/core";
import { isEmpty } from "es-toolkit/compat";
import { getMediaServerIcon, type IMediaServerItem } from "@ptd/mediaServer";
import { EResultParseStatus } from "@ptd/site";

import { useRuntimeStore } from "@/options/stores/runtime.ts";
import { useMetadataStore } from "@/options/stores/metadata.ts";
import { useConfigStore } from "@/options/stores/config.ts";
import { formatSize } from "@/options/utils.ts";

import PageSkeleton from "@/options/components/PageSkeleton.vue";
import NoDataPlaceholder from "@/options/components/NoDataPlaceholder.vue";
import ItemInformationDialog from "./ItemInformationDialog.vue";
import PlayedStateIcon from "./PlayedStateIcon.vue";
import ServerFilterChips from "./ServerFilterChips.vue";

import { doSearch, resetSearchingStateIfIdle, searchMediaServerIds } from "./utils.ts";
import { seriesText, videoRangeBadge, videoSummary } from "./itemDisplay.ts";

const { t } = useI18n();
const route = useRoute();
const configStore = useConfigStore();
const runtimeStore = useRuntimeStore();
const metadataStore = useMetadataStore();

const search = ref<string>((route.query.search as string) ?? runtimeStore.mediaServerSearch.searchKey);
const isComposing = ref(false);
const failedPosters = ref(new Set<string>());
const hoverItemUrl = ref<string | null>(null);

const enabledMediaServerIds = computed(() => metadataStore.getEnabledMediaServers.map((mediaServer) => mediaServer.id));

/** 工具条上的服务器筛选 chip：只列已启用的服务器（禁用项已由 utils.ts 的 watcher 从选择中剪掉） */
const filterMediaServers = computed(() =>
  metadataStore.getEnabledMediaServers.map(({ id, name, type }) => ({ id, name, type })),
);

/**
 * 上游 #1599：已加载的结果保留在 store 中不丢弃，仅按当前筛选出的服务器决定显示哪些卡片
 * （取消勾选一台服务器后它的卡片即时隐藏，重新勾选即时恢复，不必重新搜索）。
 */
const filteredSearchResult = computed(() =>
  runtimeStore.mediaServerSearch.searchResult.filter((item) => searchMediaServerIds.value.includes(item.server)),
);

const showItem = ref<IMediaServerItem | null>(null);
const showItemInformationDialog = ref<boolean>(false);

// P2-5：瀑布流原来把 searchResult 全量 v-for 渲染（DOM 无上限，反复「加载更多」会一直累加卡片）。
// 这里保留「只渲染前 N 条 + 触底自动追加」的窗口化策略：DOM 数量由用户滚动进度决定，
// 而不是由累计搜索结果总数决定；服务端的「加载更多」按钮行为保持不变。
const mediaServerVisiblePageSize = 40;
const visibleResultCount = ref(mediaServerVisiblePageSize);
const gridSentinel = ref<HTMLElement | null>(null);

const visibleSearchResults = computed(() => filteredSearchResult.value.slice(0, visibleResultCount.value));

const hasHiddenResults = computed(() => visibleResultCount.value < filteredSearchResult.value.length);

const failedServerNames = computed(() =>
  filterMediaServers.value
    .filter(({ id }) => {
      const status = runtimeStore.mediaServerSearch.searchStatus[id];
      return (
        searchMediaServerIds.value.includes(id) &&
        status?.status != null &&
        status.status !== EResultParseStatus.success
      );
    })
    .map(({ name }) => name),
);

useIntersectionObserver(gridSentinel, ([entry]) => {
  if (!entry?.isIntersecting || !hasHiddenResults.value) return;
  visibleResultCount.value += mediaServerVisiblePageSize;
});

// 新的搜索（searchKey 变化，doSearch 会重置结果）时回到第一页
watch(
  () => runtimeStore.mediaServerSearch.searchResult,
  () => {
    visibleResultCount.value = mediaServerVisiblePageSize;
    failedPosters.value.clear();
  },
);

watch(
  () => route.query.search,
  (value) => {
    if (typeof value !== "string") return;
    search.value = value;
    submitSearch();
  },
);

/**
 * N16：只统计「当前勾选且启用」的服务器状态。
 *
 * 原实现统计 `searchStatus` 里的全部条目：取消勾选某台服务器后，它的旧状态仍让
 * `hasMore` 为 true →「加载更多」可点，但只会搜当前勾选项，点完没有新增。
 */
const hasMore = computed<boolean>(() => {
  const searchableIds = searchMediaServerIds.value.filter((id) => enabledMediaServerIds.value.includes(id));
  if (searchableIds.length === 0) return false;
  const status = runtimeStore.mediaServerSearch.searchStatus;
  if (isEmpty(status)) return true;
  return searchableIds.some((id) => status[id]?.canLoadMore ?? true);
});

function showItemInformation(item: IMediaServerItem) {
  hoverItemUrl.value = null;
  showItem.value = item;
  showItemInformationDialog.value = true;
}

function submitSearch() {
  if (isComposing.value) return;
  void doSearch({ searchKey: search.value.trim(), userInitiated: true });
}

function loadMore() {
  if (hasHiddenResults.value) {
    visibleResultCount.value += mediaServerVisiblePageSize;
    return;
  }
  void doSearch({ searchKey: runtimeStore.mediaServerSearch.searchKey, loadMore: true, userInitiated: true });
}

const onScroll = useThrottleFn((event: Event) => {
  const target = event.currentTarget;
  const isElementScroll = target instanceof HTMLElement;
  const atBottom = isElementScroll
    ? target.scrollTop + target.clientHeight >= target.scrollHeight - 50
    : window.innerHeight + window.scrollY >= document.body.offsetHeight - 50;

  if (
    configStore.mediaServerEntity.autoSearchMoreWhenScroll &&
    atBottom &&
    !runtimeStore.mediaServerSearch.isSearching &&
    failedServerNames.value.length === 0 &&
    (hasHiddenResults.value || hasMore.value)
  ) {
    // N15：「加载更多」必须沿用当前结果对应的搜索词（store 里的 searchKey），
    // 否则用户改了输入框但没回车时，滚动会带着新词重新搜第一页（清空已看的结果、位置丢失）。
    loadMore();
  }
}, 200);

let mounted = false;
onMounted(async () => {
  mounted = true;
  await metadataStore.$onReady();
  if (!mounted) return;
  // N1：恢复出来的 isSearching 可能没有对应的在途队列（PQueue 是内存对象），先做一次收尾
  resetSearchingStateIfIdle();
  if (configStore.mediaServerEntity.autoSearchWhenMount && runtimeStore.mediaServerSearch.searchResult.length === 0) {
    // noinspection ES6MissingAwait
    doSearch({ searchKey: search.value });
  }
});
onUnmounted(() => {
  mounted = false;
});
</script>

<template>
  <section v-scroll="onScroll" class="media-library" :aria-busy="runtimeStore.mediaServerSearch.isSearching">
    <div class="page-toolbar media-library-toolbar">
      <ServerFilterChips v-model="searchMediaServerIds" :items="filterMediaServers" />
      <form class="media-library-search" role="search" @submit.prevent="submitSearch">
        <a-input
          v-model:value="search"
          :placeholder="t('MediaServerEntity.searchPlaceholder')"
          :aria-label="t('MediaServerEntity.searchPlaceholder')"
          allow-clear
          @compositionstart="isComposing = true"
          @compositionend="isComposing = false"
          @keydown.enter="(isComposing || $event.isComposing) && $event.preventDefault()"
        >
          <template #prefix><SearchOutlined /></template>
        </a-input>
        <a-button
          html-type="submit"
          type="primary"
          :disabled="searchMediaServerIds.length === 0"
          :loading="
            runtimeStore.mediaServerSearch.isSearching && search.trim() === runtimeStore.mediaServerSearch.searchKey
          "
        >
          <template #icon><SearchOutlined /></template>
          {{ t("common.search") }}
        </a-button>
      </form>
    </div>

    <div class="media-library-status" role="status" aria-live="polite">
      <span>{{ t("MediaServerEntity.loadedItems", { count: filteredSearchResult.length }) }}</span>
      <a-typography-text v-if="runtimeStore.mediaServerSearch.isSearching" type="secondary">
        <a-spin size="small" /> {{ t("common.loading") }}
      </a-typography-text>
    </div>
    <a-alert
      v-if="failedServerNames.length"
      class="media-library-error"
      type="error"
      show-icon
      :message="t('MediaServerEntity.failedServers', { servers: failedServerNames.join(', ') })"
    />

    <div v-if="filteredSearchResult.length > 0" class="media-library-grid">
      <article v-for="item in visibleSearchResults" :key="item.url" class="masonry-item media-card">
        <a-popover
          :trigger="['hover', 'focus']"
          placement="rightTop"
          :mouse-enter-delay="0.3"
          :destroy-tooltip-on-hide="true"
          :open="hoverItemUrl === item.url && !showItemInformationDialog"
          @open-change="
            (open: boolean) => (hoverItemUrl = open ? item.url : hoverItemUrl === item.url ? null : hoverItemUrl)
          "
        >
          <template #content>
            <div class="media-hover-preview">
              <strong>{{ item.name }}</strong>
              <div class="media-hover-summary">{{ item.description || t("MediaServerEntity.noDescription") }}</div>
              <div class="media-hover-links">
                <a-button
                  v-for="externalUrl in item.externalUrls ?? []"
                  :key="externalUrl.url"
                  :href="externalUrl.url"
                  size="small"
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                >
                  {{ externalUrl.name }}
                  <ExportOutlined />
                </a-button>
              </div>
              <a-flex :gap="8">
                <a-button type="primary" @click="showItemInformation(item)">
                  <template #icon><InfoCircleOutlined /></template>
                  {{ t("MediaServerEntity.detail") }}
                </a-button>
                <a-button :href="item.url" target="_blank" rel="noopener noreferrer nofollow">
                  <template #icon><ExportOutlined /></template>
                  {{ t("common.visit") }}
                </a-button>
              </a-flex>
            </div>
          </template>
          <button
            type="button"
            class="media-poster-button"
            :aria-label="`${t('MediaServerEntity.detail')}: ${item.name}`"
            @click="showItemInformation(item)"
          >
            <img
              v-if="item.poster && !failedPosters.has(item.url)"
              :src="item.poster"
              alt=""
              loading="lazy"
              decoding="async"
              @error="failedPosters.add(item.url)"
            />
            <span v-else class="media-poster-fallback">
              <VideoCameraOutlined />
              <span>{{ t("MediaServerEntity.noPoster") }}</span>
            </span>
            <span
              v-if="item.user?.IsPlayed || item.user?.playedPercentage || item.user?.IsFavorite"
              class="media-card-user"
            >
              <PlayedStateIcon
                v-if="item.user?.IsPlayed || item.user?.playedPercentage"
                :is-played="item.user?.IsPlayed"
                :percent="item.user?.playedPercentage"
              />
              <HeartFilled v-if="item.user?.IsFavorite" style="color: var(--ptd-danger)" />
            </span>
            <span v-if="typeof item.rating === 'number'" class="media-card-rating">
              <StarFilled /> {{ item.rating.toFixed(1) }}
            </span>
          </button>
        </a-popover>
        <div class="media-card-body">
          <button type="button" class="media-card-title" :title="item.name" @click="showItemInformation(item)">
            {{ item.name }}
          </button>
          <div class="media-card-meta">
            <span v-if="item.productionYear">{{ item.productionYear }}</span>
            <span v-if="seriesText(item)">{{ seriesText(item) }}</span>
            <span v-if="(item.mediaSourceCount ?? 0) > 1">{{
              t("MediaServerEntity.versions", { count: item.mediaSourceCount })
            }}</span>
          </div>
          <div
            class="media-card-technical"
            :title="
              [
                item.format?.toUpperCase(),
                videoSummary(item),
                videoRangeBadge(item),
                item.size ? formatSize(item.size) : undefined,
              ]
                .filter(Boolean)
                .join(' · ')
            "
          >
            {{
              [
                item.format?.toUpperCase(),
                videoSummary(item),
                videoRangeBadge(item),
                item.size ? formatSize(item.size) : undefined,
              ]
                .filter(Boolean)
                .join(" · ")
            }}
          </div>
          <div class="media-card-footer">
            <span
              v-if="metadataStore.mediaServers[item.server]"
              class="media-card-server"
              :title="metadataStore.mediaServers[item.server].name"
            >
              <a-avatar :src="getMediaServerIcon(metadataStore.mediaServers[item.server].type)" :size="16" />
              <span>{{ metadataStore.mediaServers[item.server].name }}</span>
            </span>
            <a-tooltip :title="t('MediaServerEntity.detail')">
              <a-button
                type="text"
                :aria-label="`${t('MediaServerEntity.detail')}: ${item.name}`"
                @click="showItemInformation(item)"
              >
                <template #icon><InfoCircleOutlined /></template>
              </a-button>
            </a-tooltip>
            <a-tooltip :title="t('common.visit')">
              <a-button
                type="text"
                :href="item.url"
                :aria-label="`${t('common.visit')}: ${item.name}`"
                rel="noopener noreferrer nofollow"
                target="_blank"
              >
                <template #icon><ExportOutlined /></template>
              </a-button>
            </a-tooltip>
          </div>
        </div>
      </article>
    </div>
    <PageSkeleton v-else-if="runtimeStore.mediaServerSearch.isSearching" :count="8" :rows="3" variant="masonry" />
    <NoDataPlaceholder
      v-else
      :description="
        enabledMediaServerIds.length === 0
          ? t('MediaServerEntity.noServers')
          : runtimeStore.mediaServerSearch.searchResult.length > 0
            ? t('MediaServerEntity.serverFilter.allHidden')
            : searchMediaServerIds.length === 0
              ? t('MediaServerEntity.noServerSelected')
              : failedServerNames.length > 0
                ? t('MediaServerEntity.loadFailed')
                : t('MediaServerEntity.noItems')
      "
    />
    <div v-if="hasHiddenResults" ref="gridSentinel" style="height: 1px; width: 100%"></div>
    <div
      v-if="
        hasHiddenResults || (!isEmpty(runtimeStore.mediaServerSearch.searchStatus) && searchMediaServerIds.length > 0)
      "
      class="media-library-pagination"
    >
      <a-button
        v-if="hasHiddenResults || hasMore"
        :loading="runtimeStore.mediaServerSearch.isSearching"
        @click="loadMore"
      >
        {{
          failedServerNames.length && !hasHiddenResults ? t("MediaServerEntity.retry") : t("MediaServerEntity.loadMore")
        }}
      </a-button>
      <a-typography-text v-else type="secondary">{{ t("MediaServerEntity.allLoaded") }}</a-typography-text>
    </div>
  </section>

  <ItemInformationDialog v-if="showItem" v-model="showItemInformationDialog" :item="showItem" />
</template>

<style scoped>
.media-library {
  min-width: 0;
}

.media-library-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.media-library-search {
  display: flex;
  gap: 8px;
  flex: 0 1 400px;
  min-width: 0;
  margin-left: auto;
}

.media-library-search > .ant-input-affix-wrapper {
  min-width: 0;
}

.media-library-search > .ant-btn {
  flex: 0 0 auto;
}

.media-library-status {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 36px;
  color: var(--ptd-text-secondary);
  font-size: 12px;
}

.media-library-error {
  margin-bottom: 12px;
}

.media-library-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 160px), 1fr));
  gap: 16px;
}

.media-card {
  min-width: 0;
  margin: 0;
  overflow: hidden;
  border: 1px solid var(--ptd-border);
  border-radius: 6px;
  background: var(--ptd-surface);
}

.media-poster-button {
  position: relative;
  display: block;
  width: 100%;
  aspect-ratio: 2 / 3;
  padding: 0;
  border: 0;
  background: var(--ptd-bg);
  color: var(--ptd-text-secondary);
  cursor: pointer;
}

.media-poster-button > img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.media-poster-button:focus-visible,
.media-card-title:focus-visible {
  outline: 2px solid var(--ptd-primary);
  outline-offset: -2px;
}

.media-poster-fallback {
  display: flex;
  height: 100%;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  font-size: 12px;
}

.media-poster-fallback > .anticon {
  font-size: 32px;
}

.media-card-user,
.media-card-rating {
  position: absolute;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.76);
  color: #fff;
  font-size: 12px;
}

.media-card-user {
  top: 8px;
  right: 8px;
}

.media-card-rating {
  bottom: 8px;
  left: 8px;
}

.media-card-rating > .anticon {
  color: #ffc53d;
}

.media-card-body {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px;
}

.media-card-title {
  display: -webkit-box;
  height: 40px;
  padding: 0;
  overflow: hidden;
  border: 0;
  background: transparent;
  color: var(--ptd-text);
  font: inherit;
  font-size: 14px;
  font-weight: 600;
  line-height: 20px;
  text-align: left;
  overflow-wrap: anywhere;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  cursor: pointer;
}

.media-card-title:hover {
  color: var(--ptd-primary);
}

.media-card-meta,
.media-card-technical {
  overflow: hidden;
  color: var(--ptd-text-secondary);
  font-size: 12px;
  line-height: 18px;
}

.media-card-meta {
  display: flex;
  gap: 8px;
  height: 18px;
  white-space: nowrap;
}

.media-card-technical {
  display: -webkit-box;
  height: 36px;
  overflow-wrap: anywhere;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.media-card-footer {
  display: flex;
  align-items: center;
  min-width: 0;
}

.media-card-server {
  display: flex;
  flex: 1;
  align-items: center;
  gap: 6px;
  min-width: 0;
  color: var(--ptd-text-secondary);
  font-size: 12px;
}

.media-card-server > span:last-child {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.media-card-footer > .ant-btn {
  flex: 0 0 28px;
  width: 28px;
  height: 28px;
  padding: 0;
}

.media-library-pagination {
  display: flex;
  justify-content: center;
  padding: 20px 0;
}

.media-hover-preview {
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: min(300px, calc(100vw - 64px));
  overflow-wrap: anywhere;
}

.media-hover-preview > strong {
  font-size: 14px;
}

.media-hover-summary {
  display: -webkit-box;
  overflow: hidden;
  color: var(--ptd-text-secondary);
  line-height: 1.6;
  white-space: pre-line;
  -webkit-line-clamp: 4;
  -webkit-box-orient: vertical;
}

.media-hover-links {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.media-hover-links > .ant-btn {
  max-width: 100%;
  height: auto;
  min-height: 24px;
  white-space: normal;
  overflow-wrap: anywhere;
}

@media (max-width: 640px) {
  .media-library-search {
    flex: 1 1 100%;
  }

  .media-library-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
  }
}
</style>
